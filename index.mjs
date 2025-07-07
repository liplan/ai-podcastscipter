#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import Parser from 'rss-parser';
import fetch from 'node-fetch';
import { getAudioDurationInSeconds } from 'get-audio-duration';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function saveFeeds() {
  fs.writeFileSync(feedsPath, JSON.stringify(feeds, null, 2));
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, ans => { rl.close(); res(ans); }));
}

async function selectFeed() {
  console.log('\nVerfügbare Feeds:');
  feeds.forEach((f, i) => console.log(` ${i + 1}. ${f.title || f.url}`));

  const input = await prompt('RSS-Feed URL eingeben (oder Nummer wählen): ');
  const num = parseInt(input, 10);
  if (num && feeds[num - 1]) return feeds[num - 1].url;

  const url = input.trim();
  if (!feeds.some(f => f.url === url)) {
    try {
      const parser = new Parser();
      const feed = await parser.parseURL(url);
      feeds.push({ url, title: feed.title || url });
      saveFeeds();
    } catch (e) {
      console.error('❌ Feed konnte nicht geladen werden:', e.message);
    }
  }
  return url;
}

async function fetchEpisodes(feedUrl) {
  const parser = new Parser();
  const feed = await parser.parseURL(feedUrl);
  const episodes = feed.items.map(item => ({
    title: item.title,
    url: item.enclosure?.url,
    pubDate: item.pubDate
  })).filter(e => e.url);
  episodes.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return episodes;
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download fehlgeschlagen: ${res.status}`);
  const fileStream = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
  });
}

async function processEpisode(ep, baseDir) {
  const epDir = path.join(baseDir, ep.title.replace(/[^a-z0-9]+/gi, '_'));
  fs.mkdirSync(epDir, { recursive: true });
  const audioPath = path.join(epDir, 'audio.mp3');

  if (!fs.existsSync(audioPath)) {
    console.log('⬇️  Lade herunter:', ep.title);
    await downloadFile(ep.url, audioPath);
  } else {
    const overwrite = await prompt(`Datei für "${ep.title}" existiert. Überschreiben? (j/N) `);
    if (/^j/i.test(overwrite)) {
      await downloadFile(ep.url, audioPath);
    }
  }

  const durationSec = await getAudioDurationInSeconds(audioPath);
  const cost = (durationSec / 60 * 0.006).toFixed(2);
  console.log(`⏱️  Dauer: ${(durationSec/60).toFixed(1)} min → Kosten ca. $${cost}`);

  const transcriptPath = path.join(epDir, `${path.basename(audioPath, '.mp3')}.md`);
  if (fs.existsSync(transcriptPath)) {
    const reuse = await prompt('Transkript bereits vorhanden. Überspringen? (J/n) ');
    if (!/^n/i.test(reuse)) return; // skip
  }

  await new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, 'podcastScripter.mjs'), audioPath], { stdio: 'inherit' });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Transkription fehlgeschlagen')));
  });
}

(async () => {
  const feedUrl = await selectFeed();
  const episodes = await fetchEpisodes(feedUrl); // already sorted by pubDate
  const numStr = await prompt('Wieviele Episoden ab heute transkribieren? ');
  const num = parseInt(numStr, 10) || 1;
  const baseDir = path.join(__dirname, 'podcasts');
  fs.mkdirSync(baseDir, { recursive: true });
  const toProcess = episodes.slice(0, num);
  for (const ep of toProcess) {
    try { await processEpisode(ep, baseDir); }
    catch (e) { console.error('❌', e.message); }
  }
})();
