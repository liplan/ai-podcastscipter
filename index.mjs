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
    pubDate: item.pubDate,
    episodeNumber: item.itunes?.episode || item['itunes:episode'] || item.episode,
    metadata: item
  })).filter(e => e.url);
  episodes.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return { episodes, title: feed.title };
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
  const epNum = String(ep.episodeNumber ?? 0).padStart(4, '0');
  const slug  = ep.title.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');

  const dirName = `${epNum}_${slug}`.slice(0, 32);
  const epDir   = path.join(baseDir, dirName);
  fs.mkdirSync(epDir, { recursive: true });

  const metaPath = path.join(epDir, 'metadata.json');
  if (ep.metadata) {
    fs.writeFileSync(metaPath, JSON.stringify(ep.metadata, null, 2));
  }

  const fileBase  = `${epNum}_${slug}`.slice(0, 17); // ensure total filename <= 32
  const audioPath = path.join(epDir, `${fileBase}.mp3`);

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
  const { episodes, title: parsedTitle } = await fetchEpisodes(feedUrl); // already sorted by pubDate
  const feedObj = feeds.find(f => f.url === feedUrl);
  let feedTitle = feedObj?.title || parsedTitle;
  if (!feedTitle) {
    feedTitle = (await prompt('Titel des Feeds: ')).trim() || feedUrl;
  }
  if (feedObj && !feedObj.title && feedTitle) {
    feedObj.title = feedTitle;
    saveFeeds();
  }
  const feedSlug = feedTitle.replace(/[^a-z0-9]+/gi, '_');
  const baseDir = path.join(__dirname, 'podcasts', feedSlug);
  fs.mkdirSync(baseDir, { recursive: true });

  const numStr = await prompt('Wieviele Episoden ab heute transkribieren? ');
  const num = parseInt(numStr, 10) || 1;
  const toProcess = episodes.slice(0, num);
  for (const ep of toProcess) {
    try { await processEpisode(ep, baseDir); }
    catch (e) { console.error('❌', e.message); }
  }
})();
