#!/usr/bin/env node

/* -------------------------------------------------------------
 * Podcast-Transkription + Sprechererkennung + Zusammenfassung
 * -------------------------------------------------------------
 * 1. Whisper → SRT
 * 2. GPT-4 → Sprecher­Namen (inkl. Korrekturen aus name-fixes.json)
 * 3. JSON-Export mit Speaker-Tags
 * 4. GPT-4 → Kurz­zusammenfassung (Markdown Bullet-Points)
 * 5. Markdown-Datei mit Transkript und Zusammenfassung
 * -------------------------------------------------------------
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { OpenAI, APIConnectionError } from 'openai';
import SRTParser from 'srt-parser-2';
import ffmpegPath from 'ffmpeg-static';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌  Kein API-Key gefunden! Bitte .env mit OPENAI_API_KEY=... erstellen.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 60_000 });
const parser = new SRTParser();

async function checkOpenAIConnection() {
  console.log('🔌  Prüfe Verbindung zu api.openai.com …');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      signal: controller.signal
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
    console.error('❌  Keine Verbindung zu api.openai.com.');
    console.error('    Prüfe Internetzugang, Firewall oder Proxy.');
    console.error('    Test: curl https://api.openai.com/v1/models');
    process.exit(1);
  }
}

async function retryRequest(fn, retries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof APIConnectionError) {
        if (attempt < retries) {
          const wait = baseDelay * Math.pow(2, attempt);
          console.warn(`⚠️  Netzwerkfehler, neuer Versuch in ${wait / 1000}s …`);
          await new Promise(res => setTimeout(res, wait));
          continue;
        } else {
          console.error('❌  Verbindung zur OpenAI API fehlgeschlagen.');
          console.error('    Prüfe Netzwerk/Firewall/Proxy oder teste: curl https://api.openai.com/v1/models');
        }
      }
      throw err;
    }
  }
}

function parseTime(t) {
  const [h, m, sMs] = t.split(':');
  const [s, ms] = sMs.split(',');
  return (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;
}

function formatTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

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

  const maxSize = 25 * 1024 * 1024;
  const fileSize = fs.statSync(mp3Pfad).size;
  console.log('📤  Transkribiere via Whisper …');
  let srtText = '';

  if (fileSize > maxSize) {
    console.log('🔀  Datei größer 25MB → splitte in 10‑Minuten‑Teile');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podsplit-'));
    const pattern = path.join(tmpDir, `${basename}-%03d.mp3`);
    await new Promise((res, rej) => {
      const ffArgs = [
        '-hide_banner',
        '-nostdin',
        '-loglevel', 'error',
        '-i', mp3Pfad,
        '-f', 'segment',
        '-segment_time', '600',
        '-c', 'copy',
        pattern
      ];
      const child = spawn(ffmpegPath, ffArgs, { stdio: 'ignore' });
      child.on('exit', c => c === 0 ? res() : rej(new Error('ffmpeg split failed')));
    });
    const parts = fs.readdirSync(tmpDir).filter(f => f.endsWith('.mp3')).sort();
    const allLines = [];
    let offset = 0;
    for (const p of parts) {
      const resp = await retryRequest(() => openai.audio.transcriptions.create({
        file: fs.createReadStream(path.join(tmpDir, p)),
        model: 'whisper-1',
        response_format: 'srt',
        timestamp_granularities: ['segment'],
      }));
      const segLines = parser.fromSrt(resp);
      for (const line of segLines) {
        line.startTime = formatTime(parseTime(line.startTime) + offset);
        line.endTime   = formatTime(parseTime(line.endTime) + offset);
      }
      if (segLines.length) offset = parseTime(segLines[segLines.length - 1].endTime);
      allLines.push(...segLines);
    }
    srtText = parser.toSrt(allLines);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } else {
    const whisperResp = await retryRequest(() => openai.audio.transcriptions.create({
      file: fs.createReadStream(mp3Pfad),
      model: 'whisper-1',
      response_format: 'srt',
      timestamp_granularities: ['segment'],
    }));
    srtText = whisperResp;
  }

  fs.writeFileSync(srtPfad, srtText, 'utf-8');
  console.log('✅  SRT gespeichert →', srtPfad);

  const srtJson = parser.fromSrt(srtText);

  const sampleLines = srtJson.slice(0, 6).map(e => e.text).join('\n');
  const gptSpeakerPrompt =
`Hier sind die ersten Zeilen eines Podcast-Transkripts:

${sampleLines}

Welche Namen kommen vor? Wer begrüßt wen? Gib eine Liste wie:

Speaker 1: Dennis
Speaker 2: Gavin

Nur die Namen und Reihenfolge. Falls „Kevin“ vorkommt, ist eigentlich „Gavin“ gemeint.`;

  console.log('🤖  Frage GPT-4 nach Sprechern …');
  const speakerRes = await retryRequest(() => openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'Du bist ein Assistent zur Sprechererkennung in Podcasts.' },
      { role: 'user',   content: gptSpeakerPrompt }
    ]
  }));

  const gptSpeakerText = speakerRes.choices[0].message.content.trim();
  fs.writeFileSync(speakerTxtPfad, gptSpeakerText, 'utf-8');
  console.log('📄  GPT-Antwort gespeichert →', speakerTxtPfad);

  const matchNames = [...gptSpeakerText.matchAll(/Speaker\s*(\d):\s*(\w+)/gi)];
  let nameMap = new Map(matchNames.map(([ , id, name ]) => [`Speaker ${id}`, name]));

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

  console.log('\n🎙️  Finale Sprecherliste:');
  for (const [key, val] of nameMap.entries()) console.log(`  ${key} → ${val}`);

  let speakerCounter = 1;
  const speakerTotal = nameMap.size || 2;

  for (const entry of srtJson) {
    const spKey = `Speaker ${((speakerCounter - 1) % speakerTotal) + 1}`;
    entry.speaker = nameMap.get(spKey) || spKey;
    speakerCounter++;
  }

  const jsonOut = srtJson.map(e => ({
    start:   e.startTime,
    end:     e.endTime,
    speaker: e.speaker,
    text:    e.text.trim()
  }));

  fs.writeFileSync(jsonPfad, JSON.stringify(jsonOut, null, 2), 'utf-8');
  console.log('✅  JSON gespeichert →', jsonPfad);

  const maxChars      = 12000;
  const plainText     = jsonOut.map(j => `${j.speaker}: ${j.text}`).join('\n');
  const summaryInput  = plainText.slice(0, maxChars);

  const gptSummaryPrompt =
`Fasse den folgenden Podcast prägnant in **7 Bullet-Points** (klar, informativ, deutsch):
-----
${summaryInput}
-----
Bullet-Points:`;

  console.log('\n📝  Erstelle GPT-4-Zusammenfassung …');
  const summaryRes = await retryRequest(() => openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'Du bist ein hilfreicher Redakteur.' },
      { role: 'user',   content: gptSummaryPrompt }
    ]
  }));

  const summary = summaryRes.choices[0].message.content.trim();
  fs.writeFileSync(summaryPfad, summary, 'utf-8');

  console.log('✅  Zusammenfassung gespeichert →', summaryPfad);
  console.log('\n🔎  Kurz­zusammenfassung:\n\n' + summary + '\n');

  const header = `# Transkript: ${basename}\n\n**Datum:** ${new Date().toISOString().split('T')[0]}\n**Sprecher:** ${[...new Set(jsonOut.map(j => j.speaker))].join(', ')}\n\n---\n\n## 🎙️ Transkript\n`;

  const transcript = jsonOut.map(j =>
    `**[${j.start}] ${j.speaker}:** ${j.text}`).join('\n');

  const summaryMd = `\n\n---\n\n## 🧠 Zusammenfassung (GPT-4)\n\n${summary}\n`;

  fs.writeFileSync(markdownPfad, header + transcript + summaryMd, 'utf-8');
  console.log('✅  Markdown-Datei gespeichert →', markdownPfad);
}

const mp3File = process.argv[2];
if (!mp3File) {
  console.error('⚠️  Nutzung: node podcastScripter.mjs <audiofile.mp3>');
  process.exit(1);
}

try {
  await checkOpenAIConnection();
  await transkribiere(mp3File);
} catch (err) {
  console.error('❌  Fehler:', err);
}
