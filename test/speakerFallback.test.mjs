import assert from 'assert';
import { assignSpeakersWithoutDiarization } from '../speakerAssignment.mjs';

const srtJson = [
  { startTime: '00:00:00,000', endTime: '00:00:04,000', text: 'Herzlich willkommen zum Podcast.' },
  { startTime: '00:00:04,000', endTime: '00:00:08,000', text: 'Ich bin Anna Müller und heute begleitet mich Ben Schulz.' },
  { startTime: '00:00:08,000', endTime: '00:00:12,000', text: 'Ben Schulz: Danke, Anna. Schön hier zu sein.' },
  { startTime: '00:00:12,000', endTime: '00:00:16,000', text: 'Lass uns starten.' }
];

const knownNames = ['Anna Müller', 'Ben Schulz'];

const result = assignSpeakersWithoutDiarization(srtJson, knownNames);

assert.strictEqual(srtJson[0].speakerId, 1, 'Das Intro sollte auf den ersten gefundenen Sprecher zurückfallen.');
assert.strictEqual(srtJson[1].speakerId, 1, 'Segment mit Anna bleibt bei Sprecher 1.');
assert.strictEqual(srtJson[2].speakerId, 2, 'Segment mit Ben sollte Sprecher 2 erhalten.');
assert.strictEqual(srtJson[3].speakerId, 2, 'Nachfolgende Segmente behalten die letzte Sprecher-ID.');

assert(result.get(1).length === 2, 'Sprecher 1 sollte zwei Segmente besitzen.');
assert(result.get(2).length === 2, 'Sprecher 2 sollte zwei Segmente besitzen.');

console.log('speakerFallback tests passed');
