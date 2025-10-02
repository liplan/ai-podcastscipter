#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import Parser from 'rss-parser';
import fetch from 'node-fetch';
import { getAudioDurationInSeconds } from 'get-audio-duration';
import { spawn } from 'child_process';
import { handleNetworkError, describeNetworkError, logError } from './logger.mjs';
import { extractSpeakers, createProfiles } from './rssUtils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI-Argumente
const allArgs     = process.argv.slice(2);
const optionArgs  = allArgs.filter(a => a.startsWith('--'));
const positional  = allArgs.filter(a => !a.startsWith('--'));
const KEEP_AUDIO  = optionArgs.includes('--keep-audio');
let DELETE_TEMP   = optionArgs.includes('--delete-temp') || optionArgs.includes('--delete-intermediate');
const FORCE       = optionArgs.includes('--force');
const LATEST_MODE = positional.length > 0;
if (LATEST_MODE) DELETE_TEMP = true; // Zwischenformate im Batch-Modus immer löschen

const feedsPath = path.join(__dirname, 'feeds.json');
let feeds = [];
if (fs.existsSync(feedsPath)) {
  try { feeds = JSON.parse(fs.readFileSync(feedsPath, 'utf-8')); } catch {}
}
// keep compatibility with older string-only format
let saveNeeded = false;
feeds = Array.isArray(feeds) ? feeds.map(f => {
  if (typeof f === 'string') { saveNeeded = true; return { url: f, title: f }; }
  return f;
}).filter(Boolean) : [];
if (saveNeeded) saveFeeds();

const processedPath = path.join(__dirname, 'processed.json');
let processed = {};
if (fs.existsSync(processedPath)) {
  try { processed = JSON.parse(fs.readFileSync(processedPath, 'utf-8')); }
  catch (e) { logError(e, 'load processed.json'); }
}
function saveProcessed() {
  try { fs.writeFileSync(processedPath, JSON.stringify(processed, null, 2)); }
  catch (e) { logError(e, 'save processed.json'); }
}

function saveFeeds() {
  fs.writeFileSync(feedsPath, JSON.stringify(feeds, null, 2));
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, ans => { rl.close(); res(ans); }));
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let b = bytes;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${units[i]}`;
}

async function warnIfInsufficientSpace(episodes, dir) {
  let total = 0;
  for (const ep of episodes) {
    if (ep.size) {
      total += ep.size;
      continue;
    }
    try {
      const head = await fetch(ep.url, { method: 'HEAD' });
      const len  = head.headers.get('content-length');
      if (len) { ep.size = parseInt(len, 10); total += ep.size; }
    } catch (e) {
      handleNetworkError(e, `HEAD ${ep.url}`);
    }
  }
  try {
    const { bavail, bsize } = fs.statfsSync(dir);
    const free = bavail * bsize;
    if (total > free) {
      console.warn(`⚠️  Benötigt ~${formatBytes(total)}, verfügbar ~${formatBytes(free)}.`);
    }
  } catch {}
}

async function selectFeed() {
  console.log('\nVerfügbare Feeds:');
  feeds.forEach((f, i) => console.log(` ${i + 1}. ${f.title || f.url}`));

  const input = await prompt('RSS-Feed URL eingeben (oder Nummer wählen): ');
  if (!input.trim()) {
    console.log('ℹ️  Kein Feed eingegeben, Vorgang beendet.');
    process.exit(0);
  }
  const num = parseInt(input, 10);
  if (num && feeds[num - 1]) return feeds[num - 1].url;

  const url = input.trim();
  if (!feeds.some(f => f.url === url)) {
    try {
      const parser = new Parser();
      const feed = await parser.parseURL(url);
      let title = feed.title;
      if (!title) {
        title = (await prompt('Titel des Feeds: ')).trim() || url;
      }
      feeds.push({ url, title });
      saveFeeds();
    } catch (e) {
      handleNetworkError(e, `Feed laden (${url})`);
      console.error('❌ Feed konnte nicht geladen werden.');
    }
  }
  return url;
}

async function fetchEpisodes(feedUrl) {
  const parser = new Parser();
  let feed;
  try {
    feed = await parser.parseURL(feedUrl);
  } catch (err) {
    handleNetworkError(err, `fetchEpisodes ${feedUrl}`);
    if (fs.existsSync(feedUrl)) {
      try {
        const xml = fs.readFileSync(feedUrl, 'utf-8');
        feed = await parser.parseString(xml);
      } catch (inner) {
        handleNetworkError(inner, `fetchEpisodes parseString ${feedUrl}`);
        throw new Error(`Feed konnte nicht geladen werden: ${describeNetworkError(inner)}`);
      }
    } else {
      throw new Error(`Feed konnte nicht geladen werden: ${describeNetworkError(err)}`);
    }
  }
  const episodes = feed.items.map(item => {
    const speakers = extractSpeakers(item);
    if (speakers.length) {
      item.speakers = speakers;
      item.speakerProfiles = createProfiles(speakers, item.speakerProfiles);
    }
    return {
      title: item.title,
      url: item.enclosure?.url,
      size: item.enclosure?.length ? parseInt(item.enclosure.length, 10) : null,
      pubDate: item.pubDate,
      episodeNumber: item.itunes?.episode || item['itunes:episode'] || item.episode,
      metadata: item
    };
  }).filter(e => e.url);
  episodes.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return { episodes, title: feed.title };
}

async function downloadFile(url, dest, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const fileStream = fs.createWriteStream(dest);
      await new Promise((resolve, reject) => {
        res.body.pipe(fileStream);
        res.body.on('error', reject);
        fileStream.on('finish', resolve);
      });
      return;
    } catch (err) {
      handleNetworkError(err, `downloadFile ${url}`);
      if (attempt < retries) {
        console.warn(`⚠️  Download fehlgeschlagen (Versuch ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      } else {
        throw new Error(`Download von ${url} fehlgeschlagen: ${describeNetworkError(err)}`);
      }
    }
  }
}

async function processEpisode(ep, baseDir, { noPrompt = false, force = false } = {}) {
  const baseName = episodeBaseName(ep);
  const epDir    = path.join(baseDir, baseName);
  fs.mkdirSync(epDir, { recursive: true });
  const metaPath = path.join(epDir, 'metadata.json');
  if (ep.metadata) {
    fs.writeFileSync(metaPath, JSON.stringify(ep.metadata, null, 2));
  }
  const audioPath = path.join(epDir, `${baseName}.mp3`);

  if (!fs.existsSync(audioPath) || force) {
    const action = fs.existsSync(audioPath) ? '⬇️  Überschreibe:' : '⬇️  Lade herunter:';
    console.log(action, ep.title);
    await downloadFile(ep.url, audioPath);
  } else if (!noPrompt) {
    const overwrite = await prompt(`Datei für "${ep.title}" existiert. Überschreiben? (j/N) `);
    if (/^j/i.test(overwrite)) {
      await downloadFile(ep.url, audioPath);
    }
  }

  const durationSec = await getAudioDurationInSeconds(audioPath);
  const cost = durationSec / 60 * 0.006;
  console.log(`⏱️  Dauer: ${(durationSec/60).toFixed(1)} min → Kosten ca. $${cost.toFixed(2)}`);

  const transcriptPath = path.join(epDir, `${path.basename(audioPath, '.mp3')}.md`);
  if (fs.existsSync(transcriptPath)) {
    if (force) {
      // continue and overwrite existing transcript
    } else if (noPrompt) {
      return 0; // skip silently
    } else {
      const reuse = await prompt('Transkript bereits vorhanden. Überspringen? (J/n) ');
      if (!/^n/i.test(reuse)) return 0; // skip
    }
  }

  await new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, 'podcastScripter.mjs'), audioPath], { stdio: 'inherit' });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Transkription fehlgeschlagen')));
  });

  if (!KEEP_AUDIO) {
    if (noPrompt) {
      try { fs.unlinkSync(audioPath); } catch {}
    } else {
      const del = await prompt('Original-MP3 löschen? (j/N) ');
      if (/^j/i.test(del)) {
        try { fs.unlinkSync(audioPath); } catch {}
      }
    }
  }

  if (DELETE_TEMP) {
    const base = path.basename(audioPath, '.mp3');
    const srt = path.join(epDir, `${base}.transcript.srt`);
    const json = path.join(epDir, `${base}.transcript.json`);
    for (const p of [srt, json]) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  }
  return cost;
}

function episodeBaseName(ep) {
  const epPrefix = ep.episodeNumber ? String(ep.episodeNumber).padStart(4, '0') + '_' : '';
  const rawSlug  = ep.title.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return (epPrefix + rawSlug).slice(0, 32);
}

function backfillSpeakers(baseDir, episodes) {
  for (const ep of episodes) {
    const baseName = episodeBaseName(ep);
    const metaPath = path.join(baseDir, baseName, 'metadata.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (!meta.speakers && ep.metadata?.speakers?.length) {
        meta.speakers = ep.metadata.speakers;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }
    } catch (e) { logError(e, `backfill ${metaPath}`); }
  }
}

(async () => {
  const resume = process.argv.includes('--resume');
  let feedUrl, count;
  if (LATEST_MODE) {
    const feedArg = positional[0];
    const idx = parseInt(feedArg, 10);
    if (!isNaN(idx) && feeds[idx - 1]) {
      feedUrl = feeds[idx - 1].url;
    } else {
      feedUrl = feedArg;
    }
    count = parseInt(positional[1], 10) || 1;
  } else {
    feedUrl = await selectFeed();
  }

  let episodes, parsedTitle;
  try {
    ({ episodes, title: parsedTitle } = await fetchEpisodes(feedUrl));
  } catch (e) {
    console.error('❌ Episoden konnten nicht geladen werden:', describeNetworkError(e));
    process.exit(1);
  }
  const feedObj = feeds.find(f => f.url === feedUrl);
  let feedTitle = feedObj?.title || parsedTitle || feedUrl;
  if (!feedObj && LATEST_MODE) {
    feeds.push({ url: feedUrl, title: feedTitle });
    saveFeeds();
  }
  if (feedObj && !feedObj.title && feedTitle) {
    feedObj.title = feedTitle;
    saveFeeds();
  }
  const feedSlug = feedTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32);
  const baseDir = path.join(__dirname, 'podcasts', feedSlug);
  fs.mkdirSync(baseDir, { recursive: true });
  backfillSpeakers(baseDir, episodes);

  let toProcess;
  if (LATEST_MODE) {
    toProcess = episodes.slice(0, count);
  } else {
    const listCount = Math.min(15, episodes.length);
    if (listCount > 0) {
      console.log('\nLetzte Episoden:');
      episodes.slice(0, listCount).forEach((ep, i) => {
        const d = new Date(ep.pubDate);
        const dateStr = isNaN(d) ? '' : d.toISOString().split('T')[0];
        console.log(` ${i + 1}. [${dateStr}] ${ep.title}`);
      });
    }

    const pickStr = await prompt('Nummern der zu transkribierenden Episoden (Komma getrennt, Enter für Anzahl ab heute): ');
    if (pickStr.trim()) {
      const picks = Array.from(new Set(pickStr.split(/[\s,]+/)
        .map(n => parseInt(n, 10))
        .filter(n => n >= 1 && n <= listCount)));
      toProcess = picks.map(i => episodes[i - 1]);
    } else {
      const numStr = await prompt('Wieviele Episoden ab heute transkribieren? ');
      const num = parseInt(numStr, 10) || 1;
      toProcess = episodes.slice(0, num);
    }
  }

  await warnIfInsufficientSpace(toProcess, baseDir);

  let totalCost = 0;
  for (const ep of toProcess) {
    const baseName = episodeBaseName(ep);
    const processedList = processed[feedSlug] || [];
    if (processedList.includes(baseName) && !FORCE) {
      if (resume) {
        console.log(`⏭️  Überspringe bereits verarbeitete Episode: ${ep.title}`);
        continue;
      }
      if (!LATEST_MODE) {
        const again = await prompt(`Episode "${ep.title}" bereits verarbeitet. Erneut bearbeiten? (j/N) `);
        if (!/^j/i.test(again)) {
          console.log('⏭️  Übersprungen.');
          continue;
        }
      } else {
        console.log(`⏭️  Überspringe bereits verarbeitete Episode: ${ep.title}`);
        continue;
      }
    }
    try {
      const cost = await processEpisode(ep, baseDir, { noPrompt: LATEST_MODE || FORCE, force: FORCE });
      totalCost += cost;
      processed[feedSlug] = processedList;
      if (!processedList.includes(baseName)) processedList.push(baseName);
      saveProcessed();
    } catch (e) {
      logError(e, `processEpisode ${ep.title}`);
      console.error('❌', e.message);
    }
  }
  if (LATEST_MODE) {
    console.log(`\n💰  Gesamtkosten: $${totalCost.toFixed(2)}`);
  }
})();
