#!/usr/bin/env node

/* -------------------------------------------------------------
 * Podcast-Transkription + Sprechererkennung + Zusammenfassung
 * -------------------------------------------------------------
 * 1. Whisper-1 → JSON → SRT
 * 2. GPT-4o → Sprecher­Namen (inkl. Korrekturen aus name-fixes.json)
 * 3. JSON-Export mit Speaker-Tags
 * 4. GPT-4o → Kurz­zusammenfassung (Markdown Bullet-Points)
 * 5. Markdown-Datei mit Transkript und Zusammenfassung
 * -------------------------------------------------------------
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import OpenAI, { APIConnectionError, APIError } from 'openai';
import SRTParser from 'srt-parser-2';
import ffmpegPath from 'ffmpeg-static';
import dotenv from 'dotenv';
import { fetch as undiciFetch, ProxyAgent, Agent, setGlobalDispatcher } from 'undici';
import { getAudioDurationInSeconds } from 'get-audio-duration';
import { logNetworkError } from './logger.mjs';
import { Deepgram } from '@deepgram/sdk';
import { createProfiles } from './rssUtils.mjs';
import { applySpeakerMapping } from './diarizationMapping.mjs';
import { assignSpeakersWithoutDiarization, assignSpeakersFromDiarization } from './speakerAssignment.mjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const ALLOW_SPEAKER_NAMES = process.env.ALLOW_SPEAKER_NAMES !== 'false';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌  Kein API-Key gefunden! Bitte .env mit OPENAI_API_KEY=... erstellen.');
  process.exit(1);
}

/* === Einheitlicher HTTP-Stack via undici (mit Proxy-Unterstützung) === */
function buildDispatcher() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl) return new ProxyAgent(proxyUrl);
  return new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 60_000 });
}
const dispatcher = buildDispatcher();
setGlobalDispatcher(dispatcher);

/* OpenAI-Client (Timeout großzügig für lange Audios) */
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  timeout: 600_000,
});

/* Parser nur fürs spätere Einlesen der erzeugten SRT */
const parser = new SRTParser();

// Globale Wartezeit für 429-Responses (wird bei Erfolg zurückgesetzt)
let rateLimitDelay = 1000;

/* ---------- Utilities ---------- */

function formatTime(secFloat) {
  const sec = Math.max(0, Number(secFloat) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);

  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const msec = String(ms).padStart(3, '0');

  return `${hh}:${mm}:${ss},${msec}`;
}

/** Wandelt einen SRT-Zeitstempel (HH:MM:SS,mmm) in Sekunden um. */
function srtTimeToSeconds(ts) {
  const [hms, ms] = String(ts).split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + Number(s) + Number(ms) / 1000;
}

/** Baut aus Transkript-Segmenten eine SRT-Zeichenkette (mit optionalem Offset in Sekunden
    und optionalem Startindex für die Nummerierung). */
function segmentsToSrt(segments, offsetSec = 0, startIndex = 0) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('Transkript-JSON enthält keine segments – SRT kann nicht erzeugt werden.');
  }
  return segments.map((seg, i) => {
    const start = formatTime((seg.start ?? 0) + offsetSec);
    const end   = formatTime((seg.end   ?? 0) + offsetSec);
    const text  = String(seg.text ?? '').trim();
    return `${i + 1 + startIndex}\n${start} --> ${end}\n${text}\n`;
  }).join('\n');
}

/** Sichert, dass wir nutzbare Segmente haben; baut notfalls einen Ein-Segment-Fallback. */
function ensureSegments(resp, fallbackDurationSec) {
  let segments = resp?.segments || resp?.output?.segments || resp?.results?.segments;
  if (Array.isArray(segments) && segments.length > 0) return segments;

  const text = String(resp?.text ?? '').trim();
  if (!text) throw new Error('Transkript-JSON enthält weder segments noch text.');

  const dur = Math.max(0, Number(fallbackDurationSec) || 0);
  const end = dur > 0 ? dur : Math.max(Number(resp?.duration) || 0, 0);

  return [{ id: 0, start: 0, end, text }];
}

/** Führt Sprecher-Diarisierung via Deepgram durch und liefert Segmente zurück. */
async function diarizeWithDeepgram(mp3Pfad) {
  const DG_API_KEY = process.env.DEEPGRAM_API_KEY;
  if (!DG_API_KEY) {
    console.warn('⚠️  Kein DEEPGRAM_API_KEY gesetzt – überspringe Diarisierung.');
    return [];
  }
  const dg = new Deepgram(DG_API_KEY);
  try {
    const source = {
      buffer: fs.readFileSync(mp3Pfad),
      mimetype: 'audio/mpeg'
    };
    const dgRes = await dg.transcription.preRecorded(source, { diarize: true, punctuate: false });
    const words = dgRes?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    if (!words.length) return [];
    const parseSpeakerIdentifier = (value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
      }

      const text = String(value).trim();
      if (!text) return null;

      const directNumeric = text.match(/^[+-]?\d+$/);
      if (directNumeric) {
        const parsed = Number.parseInt(text, 10);
        return Number.isFinite(parsed) ? parsed : null;
      }

      const labeledMatch = text.match(/speaker[_\s-]*(\d+)/i);
      if (labeledMatch) {
        const parsed = Number.parseInt(labeledMatch[1], 10);
        return Number.isFinite(parsed) ? parsed : null;
      }

      const alphaMatch = text.match(/^[A-Za-z]+$/);
      if (alphaMatch) {
        let valueAccumulator = 0;
        for (const ch of text.toUpperCase()) {
          const code = ch.charCodeAt(0);
          if (code < 65 || code > 90) {
            return null;
          }
          valueAccumulator = valueAccumulator * 26 + (code - 64);
        }
        return valueAccumulator;
      }

      const fallback = Number(text);
      return Number.isFinite(fallback) ? fallback : null;
    };

    const toZeroBasedSpeaker = (value) => {
      if (!Number.isFinite(value)) return 0;
      if (value > 0) {
        return Math.max(0, Math.floor(value - 1));
      }
      return Math.max(0, Math.floor(value));
    };

    const segments = [];
    let current = null;
    for (const w of words) {
      const label = w.speaker ?? w.speaker_id ?? w.speaker_label ?? w.speakerId;
      const rawSpeaker = parseSpeakerIdentifier(label);
      const fallback = Number(label ?? 0);
      const speaker = toZeroBasedSpeaker(rawSpeaker ?? fallback);
      const start = Number(w.start);
      const end = Number(w.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (!current || current.speaker !== speaker) {
        if (current) segments.push(current);
        current = { start, end, speaker };
      } else {
        current.end = Math.max(current.end, end);
      }
    }
    if (current) segments.push(current);
    segments.sort((a, b) => a.start - b.start || a.speaker - b.speaker);
    const merged = [];
    const mergeGap = 0.35;
    for (const seg of segments) {
      const last = merged[merged.length - 1];
      if (last && last.speaker === seg.speaker && seg.start <= last.end + mergeGap) {
        last.end = Math.max(last.end, seg.end);
      } else {
        merged.push({ ...seg });
      }
    }
    return merged.map(seg => ({
      start: seg.start,
      end: seg.end,
      speaker: seg.speaker + 1,
    }));
  } catch (err) {
    console.warn('⚠️  Deepgram-Diarisierung fehlgeschlagen:', err.message);
    return [];
  }
}

/**
 * Erzeugt aus einem Text eine MP3-Sprachausgabe.
 * @param {string} text   - Inhalt der gesprochen werden soll.
 * @param {string} voice  - Gewünschte Stimme.
 * @param {string} outPfad - Dateipfad für die MP3-Ausgabe.
 */
async function generateSpeech(text, voice, outPfad) {
  console.log(`🔊  Erstelle Sprachausgabe (${voice}) …`);
  const speechRes = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice,
    input: text,
  });
  const buffer = Buffer.from(await speechRes.arrayBuffer());
  fs.writeFileSync(outPfad, buffer);
  console.log('✅  Sprachausgabe gespeichert →', outPfad);
}

/* ---------- Netzwerk-Reachability ---------- */
async function checkOpenAIConnection() {
  console.log('🔌  Prüfe Verbindung zu api.openai.com …');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await undiciFetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      dispatcher,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.error(`⚠️  OpenAI API erreichbar, aber Antwort ${res.status}.`);
      if (res.status === 401) {
        console.error('    Dein API-Key ist ungültig oder besitzt keine Berechtigung.');
      }
      console.error('    Test: curl https://api.openai.com/v1/models');
      process.exit(1);
    }
    console.log('✅  Verbindung zu api.openai.com OK.');
  } catch (err) {
    logNetworkError(err, 'checkOpenAIConnection');
    console.error('❌  Keine Verbindung zu api.openai.com.');
    console.error('    Prüfe Internet/Firewall/Proxy (HTTPS_PROXY/HTTP_PROXY, NODE_EXTRA_CA_CERTS).');
    console.error('    Test: curl https://api.openai.com/v1/models');
    process.exit(1);
  }
}

/* ---------- Retry-Wrapper ---------- */
async function retryRequest(fn, retries = 3, baseDelay = 1000) {
  let attempt = 0;
  while (true) {
    try {
      const res = await fn();
      rateLimitDelay = 1000; // Reset bei Erfolg
      return res;
    } catch (err) {
      if (err instanceof APIError) {
        console.error(`🔎 APIError status=${err.status} type=${err.type} message=${err.message}`);
        if (err.response) {
          try { console.error('↪ body:', await err.response.text()); } catch {}
        }
      }

      logNetworkError(err, 'OpenAI request');
      const isConn = err instanceof APIConnectionError;
      const is429 = err instanceof APIError && err.status === 429;
      const isAPI  = err instanceof APIError && err.status >= 500;

      if (is429) {
        let wait = rateLimitDelay;
        if (err.response) {
          const ra = err.response.headers.get('retry-after');
          if (ra) {
            const ms = Number(ra) * 1000;
            if (!Number.isNaN(ms) && ms > 0) wait = ms;
          }
        }
        wait += Math.floor(Math.random() * 250); // Jitter
        console.warn(`⏳  429 Too Many Requests – Retry in ${Math.round(wait/1000)}s …`);
        await new Promise(r => setTimeout(r, wait));
        rateLimitDelay = Math.min(rateLimitDelay * 2, 60_000); // Delay dynamisch erhöhen
        continue;
      }

      if ((isConn || isAPI) && attempt < retries) {
        let wait = baseDelay * Math.pow(2, attempt);
        if (err instanceof APIError && err.response) {
          const ra = err.response.headers.get('retry-after');
          if (ra) {
            const ms = Number(ra) * 1000;
            if (!Number.isNaN(ms) && ms > 0) wait = ms;
          }
        }
        wait += Math.floor(Math.random() * 250); // Jitter
        console.warn(`⚠️  ${isConn ? 'Netzwerkfehler' : `HTTP ${err.status}`} – Retry in ${Math.round(wait/1000)}s …`);
        await new Promise(r => setTimeout(r, wait));
        attempt++;
        continue;
      }

      if (isConn) {
        console.error('❌  Verbindung zur OpenAI API fehlgeschlagen.');
        console.error('    Prüfe Proxy/CA: HTTPS_PROXY/HTTP_PROXY, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE.');
      }
      throw err;
    }
  }
}

/* ---------- Hauptlogik ---------- */

async function transkribiere(mp3Pfad) {
  if (!fs.existsSync(mp3Pfad)) {
    console.error('❌  Datei nicht gefunden:', mp3Pfad);
    process.exit(1);
  }

  const basename        = path.basename(mp3Pfad, path.extname(mp3Pfad));
  const targetDir       = path.dirname(mp3Pfad);
  const srtPfad         = path.join(targetDir, `${basename}.transcript.srt`);
  const jsonPfad        = path.join(targetDir, `${basename}.transcript.json`);
  const speakerTxtPfad  = path.join(targetDir, `${basename}.speakers.txt`);
  const summaryPfad     = path.join(targetDir, `${basename}.summary.md`);
  const markdownPfad    = path.join(targetDir, `${basename}.md`);
  const metaPfad        = path.join(targetDir, 'metadata.json');
  let epMeta = {};
  if (fs.existsSync(metaPfad)) {
    try { epMeta = JSON.parse(fs.readFileSync(metaPfad, 'utf-8')); } catch {}
  }
  const metaSpeakers = Array.isArray(epMeta.speakers) ? epMeta.speakers : [];
  const speakerProfiles = createProfiles(metaSpeakers, epMeta.speakerProfiles);
  const metaInfo = [];
  if (epMeta.title) metaInfo.push(`Titel: ${epMeta.title}`);
  const author = epMeta.itunes?.author || epMeta['itunes:author'] || epMeta.author || epMeta['dc:creator'];
  if (author) metaInfo.push(`Autor: ${author}`);
  const descr = (epMeta.content || epMeta.description || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (descr) metaInfo.push(`Beschreibung: ${descr.slice(0, 500)}`);
  if (metaSpeakers.length) metaInfo.push(`Mögliche Sprecher: ${metaSpeakers.join(', ')}`);
  const rssMetaText = metaInfo.join('\n');

  const maxSize  = 10 * 1024 * 1024;
  const fileSize = fs.statSync(mp3Pfad).size;
  console.log('📤  Transkribiere via Whisper (JSON → SRT) …');

  let srtText = '';

  if (fileSize > maxSize) {
    const durationSec = await getAudioDurationInSeconds(mp3Pfad);
    const bytesPerSecond = fileSize / durationSec;
    const segmentTime = Math.max(60, Math.floor(maxSize / bytesPerSecond)); // mind. 60s
    console.log(`🔀  Datei größer 10MB → splitte in ~${Math.ceil(segmentTime / 60)}-Minuten-Teile`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podsplit-'));
    const pattern = path.join(tmpDir, `${basename}-%03d.mp3`);

    // ffmpeg: Segmentieren (ohne Neucodierung)
    await new Promise((res, rej) => {
      const ffArgs = [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-i', mp3Pfad,
        '-f', 'segment',
        '-segment_time', String(segmentTime),
        '-c', 'copy',
        pattern
      ];
      const child = spawn(ffmpegPath, ffArgs, { stdio: 'ignore' });
      child.on('exit', c => c === 0 ? res() : rej(new Error('ffmpeg split failed')));
    });

    const parts = fs.readdirSync(tmpDir).filter(f => f.endsWith('.mp3')).sort();
    const srtChunks = [];
    let offset = 0;
    let idOffset = 0;

    for (const p of parts) {
      const fullPath = path.join(tmpDir, p);
      const resp = await retryRequest(() => openai.audio.transcriptions.create({
        file: fs.createReadStream(fullPath),
        model: 'whisper-1',
        response_format: 'verbose_json'
      }));

      // Segmente sicherstellen (Fallback: Ein-Segment mit Länge segmentTime)
      const partSegments = ensureSegments(resp, segmentTime);
      const srtPart = segmentsToSrt(partSegments, offset, idOffset);
      srtChunks.push(srtPart);
      idOffset += partSegments.length;

      // Offset mit letztem Segment-Ende erhöhen
      const last = partSegments[partSegments.length - 1];
      offset += (last?.end ?? 0);
    }

    srtText = srtChunks.join('\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });

  } else {
    const transcribeResp = await retryRequest(() => openai.audio.transcriptions.create({
      file: fs.createReadStream(mp3Pfad),
      model: 'whisper-1',
      response_format: 'verbose_json'
    }));

    // Gesamtdauer als Fallback (für Einzelblock)
    const totalDurationSec = await getAudioDurationInSeconds(mp3Pfad);
    const segments = ensureSegments(transcribeResp, totalDurationSec);
    srtText = segmentsToSrt(segments, 0);
  }

  fs.writeFileSync(srtPfad, srtText, 'utf-8');
  console.log('✅  SRT gespeichert →', srtPfad);

  // Für Folge-Logik weiterhin SRT → JSON (einfaches Objekt pro Zeile)
  const srtJson = parser.fromSrt(srtText);

  const totalLines = srtJson.length;
  const sampleChunks = [];
  const positions = [0, 0.25, 0.5, 0.75, 1];
  const linesPerSample = Math.min(5, Math.max(1, Math.floor(totalLines / 20) || 1));
  const taken = new Set();
  for (const p of positions) {
    let idx = Math.floor(totalLines * p);
    idx = Math.min(Math.max(idx - Math.floor(linesPerSample / 2), 0), Math.max(0, totalLines - linesPerSample));
    if (!taken.has(idx)) {
      sampleChunks.push(srtJson.slice(idx, idx + linesPerSample));
      taken.add(idx);
    }
  }
  const sampleLines = sampleChunks
    .map(chunk => chunk.map(e => e.text).join('\n'))
    .join('\n...\n');
  const gptSpeakerPrompt = `Nutze die folgenden RSS-Metadaten und Transkript-Auszüge, um die Sprecher dieses Podcasts zu erkennen.
RSS:
${rssMetaText}

Transkript:
${sampleLines}

Gib eine Liste wie:
Speaker 1: Name
Speaker 2: Name
Nur die Namen, keine Kommentare.`;

  console.log('🤖  Frage GPT-4o nach Sprechern …');
  const speakerRes = await retryRequest(() => openai.responses.create({
    model: 'gpt-4o',
    instructions: 'Du bist ein Assistent zur Sprechererkennung in Podcasts.',
    input: gptSpeakerPrompt
  }));

  const gptSpeakerText = speakerRes.output_text.trim();
  console.log('📄  GPT-Antwort erhalten.');

  const matchNames = [...gptSpeakerText.matchAll(/Speaker\s*(\d):\s*([^\n]+)/giu)];
  const transcriptNames = matchNames
    .map(([ , , n ]) => n)
    .map(n => n.replace(/https?:\S+/gi, '').replace(/[^\p{L}\s'-]/gu, '').trim())
    .filter(n => n && n.split(/\s+/).length <= 3);
  const knownNames = speakerProfiles.length ? speakerProfiles.map(p => p.name) : transcriptNames;

  const diarSegments = await diarizeWithDeepgram(mp3Pfad);
  const diarSpeakerCount = new Set(
    diarSegments
      .map(seg => Number(seg?.speaker))
      .filter(id => Number.isFinite(id) && id > 0)
  ).size;

  let expectedSpeakers = Math.max(
    metaSpeakers.length,
    knownNames.length,
    diarSpeakerCount
  );

  if (diarSpeakerCount > 1 && expectedSpeakers < 2) {
    expectedSpeakers = 2;
  }
  let speakerEntries = new Map();
  if (diarSegments.length) {
    console.log(`🔍  Diarisierung erfolgreich: ${diarSegments.length} Segmente.`);
    speakerEntries = assignSpeakersFromDiarization(srtJson, diarSegments, expectedSpeakers);
  }
  if (!speakerEntries.size) {
    if (diarSegments.length) {
      console.warn('⚠️  Diarisierung lieferte keine verwertbare Zuordnung – verwende Rotationslogik.');
    } else {
      console.warn('⚠️  Keine Diarisierungsergebnisse – verwende Rotationslogik.');
    }
    speakerEntries = assignSpeakersWithoutDiarization(srtJson, knownNames);
  }

  const speakerSamples = new Map();
  for (const [id, entries] of speakerEntries.entries()) {
    const texts = [];
    if (entries.length > 0) texts.push(entries[0].text.trim());
    if (entries.length > 2) texts.push(entries[Math.floor(entries.length / 2)].text.trim());
    if (entries.length > 1) texts.push(entries[entries.length - 1].text.trim());
    speakerSamples.set(id, texts);
  }

  const snippetPrompt = [...speakerSamples.entries()]
    .map(([id, lines]) => `Speaker ${id}: ${lines.join(' ')}`)
    .join('\n');
  const speakerPrompt2 = `Nutze die folgenden RSS-Metadaten und Redeausschnitte, um den Sprecher-IDs Namen zuzuordnen.
RSS:
${rssMetaText || 'Keine Metadaten'}

Bekannte Sprecher: ${knownNames.join(', ') || 'keine'}

${snippetPrompt}

Antwortformat:
Speaker 1: Name
Speaker 2: Name`;

  console.log('🤖  Ordne Sprecher-IDs Namen zu …');
  const assignRes = await retryRequest(() => openai.responses.create({
    model: 'gpt-4o',
    instructions: 'Du bist ein Assistent zur Sprechererkennung in Podcasts.',
    input: speakerPrompt2
  }));
  const assignText = assignRes.output_text.trim();

  const matchIdNames = [...assignText.matchAll(/Speaker\s*(\d+):\s*([\p{L}\-']+)/giu)];
  let nameMap = new Map();
  if (matchIdNames.length) {
    for (const [ , id, name ] of matchIdNames) {
      let finalName = name;
      if (metaSpeakers.length) {
        const full = metaSpeakers.find(s => s.toLowerCase().includes(name.toLowerCase()));
        if (full) finalName = full;
      }
      nameMap.set(`Speaker ${id}`, finalName);
    }
  }
  for (const sp of metaSpeakers) {
    if (![...nameMap.values()].some(n => n === sp)) {
      const nextId = [...speakerSamples.keys()].find(id => !nameMap.has(`Speaker ${id}`));
      if (nextId !== undefined) nameMap.set(`Speaker ${nextId}`, sp);
    }
  }
  let idx = 0;
  for (const id of speakerSamples.keys()) {
    const key = `Speaker ${id}`;
    if (!nameMap.has(key) && transcriptNames[idx]) {
      nameMap.set(key, transcriptNames[idx++]);
    }
  }

  if (!ALLOW_SPEAKER_NAMES) {
    nameMap = new Map([...speakerSamples.keys()].map(id => {
      const key = `Speaker ${id}`;
      return [key, key];
    }));
  }

  const fixPfad = path.join(__dirname, 'name-fixes.json');
  let fixes = {};
  if (fs.existsSync(fixPfad)) {
    try { fixes = JSON.parse(fs.readFileSync(fixPfad, 'utf-8')); }
    catch (e) { console.warn('⚠️  Fehler beim Laden von name-fixes.json:', e.message); }
  }
  for (const [key, name] of nameMap.entries()) {
    const fix = fixes[name];
    if (fix && fix !== name) {
      console.log(`🔁  GPT-Name korrigiert: ${name} → ${fix} (${key})`);
      nameMap.set(key, fix);
    }
  }

  const finalSpeakerListText = [...speakerSamples.keys()].sort((a,b)=>a-b)
    .map(id => {
      const key = `Speaker ${id}`;
      return `${key}: ${nameMap.get(key) || key}`;
    })
    .join('\n');
  const finalTxt = `Detected names:\n${gptSpeakerText}\n\nSpeaker mapping:\n${finalSpeakerListText}\n\nSamples:\n${snippetPrompt}`;
  fs.writeFileSync(speakerTxtPfad, finalTxt, 'utf-8');
  console.log('📄  Finale Sprecherliste gespeichert →', speakerTxtPfad);

  console.log('\n🎙️  Finale Sprecherliste:');
  for (const [key, val] of nameMap.entries()) console.log(`  ${key} → ${val}`);

  const mappedEntries = applySpeakerMapping(srtJson, nameMap, metaSpeakers, ALLOW_SPEAKER_NAMES);

  const jsonOut = mappedEntries.map(e => ({
    start: e.startTime,
    end: e.endTime,
    speaker: e.speaker,
    confidence: e.confidence,
    text: e.text.trim()
  }));

  fs.writeFileSync(jsonPfad, JSON.stringify(jsonOut, null, 2), 'utf-8');
  console.log('✅  JSON gespeichert →', jsonPfad);

  const maxChars      = 12000;
  const plainText     = jsonOut.map(j => `${j.speaker}: ${j.text}`).join('\n');
  const summaryInput  = plainText.slice(0, maxChars);
  const speakerList   = [...new Set(jsonOut.map(j => j.speaker))];

  const gptSummaryPrompt =
`Fasse den folgenden Podcast mit ${speakerList.join(', ')} prägnant in **7 Bullet-Points** (klar, informativ, deutsch):
-----
${summaryInput}
-----
Bullet-Points:`;

  console.log('\n📝  Erstelle GPT-4o-Zusammenfassung …');
  const summaryRes = await retryRequest(() => openai.responses.create({
    model: 'gpt-4o',
    instructions: 'Du bist ein hilfreicher Redakteur.',
    input: gptSummaryPrompt
  }));

  const summary = summaryRes.output_text.trim();
  fs.writeFileSync(summaryPfad, summary, 'utf-8');
  console.log('✅  Zusammenfassung gespeichert →', summaryPfad);

  const summaryAudioPfad = path.join(targetDir, `${basename}.summary.mp3`);
  try {
    await generateSpeech(summary, 'alloy', summaryAudioPfad);
  } catch (e) {
    console.warn('⚠️  Konnte Sprachausgabe nicht erzeugen:', e.message);
  }

  console.log('\n🔎  Kurz­zusammenfassung:\n\n' + summary + '\n');

  const header = `# Transkript: ${basename}\n\n**Datum:** ${new Date().toISOString().split('T')[0]}\n**Sprecher:** ${speakerList.join(', ')}\n\n---\n\n## 🎙️ Transkript\n`;

  const transcript = jsonOut.map(j =>
    `**[${j.start}] ${j.speaker}:** ${j.text}`).join('\n');

  const summaryMd = `\n\n---\n\n## 🧠 Zusammenfassung (GPT-4o)\n\n${summary}\n`;

  fs.writeFileSync(markdownPfad, header + transcript + summaryMd, 'utf-8');
  console.log('✅  Markdown-Datei gespeichert →', markdownPfad);
}

/* ---------- CLI ---------- */

const cliArgs = process.argv.slice(2);
const resumeIdx = cliArgs.indexOf('--resume');
const resume = resumeIdx !== -1;
if (resume) cliArgs.splice(resumeIdx, 1);

if (cliArgs.length === 0) {
  console.error('⚠️  Nutzung: node podcastScripter.mjs <audio1.mp3> [audio2.mp3 …] [--resume]');
  process.exit(1);
}

const PRICE_PER_MINUTE = Number(process.env.PRICE_PER_MINUTE || 0.006);
const progressPfad = path.join(process.cwd(), '.podcastScripter.progress.json');
let startIndex = 0;
if (resume && fs.existsSync(progressPfad)) {
  try {
    const saved = JSON.parse(fs.readFileSync(progressPfad, 'utf-8'));
    if (Array.isArray(saved.files) && typeof saved.index === 'number' && saved.files.join('|') === cliArgs.join('|')) {
      startIndex = saved.index;
    }
  } catch {}
}

let totalMin = 0;
for (const file of cliArgs) {
  if (!fs.existsSync(file)) {
    console.error('❌  Datei nicht gefunden:', file);
    process.exit(1);
  }
  const dur = await getAudioDurationInSeconds(file);
  totalMin += dur / 60;
}

const estCost = totalMin * PRICE_PER_MINUTE;
console.log(`💰  Geschätzte Kosten: ~$${estCost.toFixed(2)} (bei ${PRICE_PER_MINUTE}$/Min)`);

try {
  await checkOpenAIConnection();
  for (let i = startIndex; i < cliArgs.length; i++) {
    const mp3File = cliArgs[i];
    await transkribiere(mp3File);
    fs.writeFileSync(progressPfad, JSON.stringify({ index: i + 1, files: cliArgs }, null, 2));
  }
  if (fs.existsSync(progressPfad)) fs.unlinkSync(progressPfad);
} catch (err) {
  console.error('❌  Fehler:', err);
}
