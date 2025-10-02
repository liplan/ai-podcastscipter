import assert from 'assert';
import { assignSpeakersFromDiarization } from '../speakerAssignment.mjs';

const baseEntries = [
  { startTime: '00:00:00,000', endTime: '00:00:04,000', text: 'Intro' },
  { startTime: '00:00:04,000', endTime: '00:00:08,000', text: 'Antwort' },
  { startTime: '00:00:08,000', endTime: '00:00:12,000', text: 'Nachfrage' },
];

const diarSegments = [
  { start: 0, end: 5, speaker: 1 },
  { start: 5, end: 12, speaker: 2 }
];

const entries1 = JSON.parse(JSON.stringify(baseEntries));
const map1 = assignSpeakersFromDiarization(entries1, diarSegments, 2);
assert.strictEqual(map1.size, 2);
assert.deepStrictEqual(entries1.map(e => e.speakerId), [1, 2, 2]);

const multiSpeakerEntries = [
  { startTime: '00:00:00,000', endTime: '00:00:03,000', text: 'A' },
  { startTime: '00:00:03,000', endTime: '00:00:06,000', text: 'B' },
  { startTime: '00:00:06,000', endTime: '00:00:09,000', text: 'C' }
];

const noisySegments = [
  { start: 0, end: 3.1, speaker: 1 },
  { start: 3.1, end: 6.2, speaker: 2 },
  { start: 6.2, end: 9.3, speaker: 3 }
];

const entries2 = JSON.parse(JSON.stringify(multiSpeakerEntries));
const map2 = assignSpeakersFromDiarization(entries2, noisySegments, 2);
const uniqueSpeakers = new Set(entries2.map(e => e.speakerId));
assert.strictEqual(uniqueSpeakers.size, 2);
assert.strictEqual(map2.size, 2);

const gapEntries = [
  { startTime: '00:00:01,000', endTime: '00:00:02,000', text: 'Host' },
  { startTime: '00:00:08,500', endTime: '00:00:09,500', text: 'Lücke' }
];

const gapSegments = [
  { start: 0, end: 4, speaker: 1 },
  { start: 5, end: 8, speaker: 2 }
];

const entries3 = JSON.parse(JSON.stringify(gapEntries));
assignSpeakersFromDiarization(entries3, gapSegments, 2);
assert.deepStrictEqual(entries3.map(e => e.speakerId), [1, 2]);

console.log('speakerAssignment diarization tests passed');
