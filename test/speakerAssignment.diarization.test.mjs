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
  { start: 6.15, end: 6.25, speaker: 3 }
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

const guardEntries = [
  { startTime: '00:00:00,000', endTime: '00:00:02,000', text: 'Guard A' },
  { startTime: '00:00:02,000', endTime: '00:00:04,000', text: 'Guard B' }
];

const guardSegments = [
  { start: 0, end: 2, speaker: 1 },
  { start: 2, end: 4, speaker: 2 }
];

const diarSpeakerCount = new Set(guardSegments.map(seg => seg.speaker)).size;
let expectedFromGuard = Math.max(0, 0, diarSpeakerCount);
if (diarSpeakerCount > 1 && expectedFromGuard < 2) {
  expectedFromGuard = 2;
}

assert.strictEqual(expectedFromGuard, 2);
const entries4 = JSON.parse(JSON.stringify(guardEntries));
const map4 = assignSpeakersFromDiarization(entries4, guardSegments, expectedFromGuard);
assert.strictEqual(map4.size, 2);

const uncoveredEntries = [
  { startTime: '00:00:00,000', endTime: '00:00:01,000', text: 'Left' },
  { startTime: '00:00:02,000', endTime: '00:00:03,000', text: 'Right' }
];

const uncoveredSegments = [
  { start: 0, end: 1, speaker: 1 },
  { start: 2, end: 3, speaker: 2 }
];

const entries5 = JSON.parse(JSON.stringify(uncoveredEntries));
const map5 = assignSpeakersFromDiarization(entries5, uncoveredSegments, 1);
assert.strictEqual(map5.size, 2);
assert.deepStrictEqual(entries5.map(e => e.speakerId), [1, 2]);

const overlappingEntries = [
  { startTime: '00:00:00,000', endTime: '00:00:01,000', text: 'Intro' },
  { startTime: '00:00:03,000', endTime: '00:00:07,000', text: 'Interview' }
];

const overlappingSegments = [
  { start: 0, end: 10, speaker: 2 },
  { start: 2, end: 8, speaker: 1 }
];

const entries6 = JSON.parse(JSON.stringify(overlappingEntries));
const map6 = assignSpeakersFromDiarization(entries6, overlappingSegments, 1);
assert.strictEqual(map6.size, 2);
assert.deepStrictEqual(entries6.map(e => e.speakerId), [1, 2]);

const numericEntries = [
  { startTime: 0, endTime: 4, text: 'Numeric intro' },
  { startTime: 4, endTime: 8, text: 'Numeric guest' },
];

const numericSegments = [
  { start: 0, end: 4.01, speaker: 1 },
  { start: 4.01, end: 8, speaker: 2 },
];

const entries7 = JSON.parse(JSON.stringify(numericEntries));
const map7 = assignSpeakersFromDiarization(entries7, numericSegments, 2);
assert.strictEqual(map7.size, 2);
assert.deepStrictEqual(entries7.map(e => e.speakerId), [1, 2]);

const boundaryEntries = [
  { startTime: '00:00:01,950', endTime: '00:00:02,050', text: 'Edge host' },
  { startTime: '00:00:02,150', endTime: '00:00:02,250', text: 'Edge guest' },
];

const boundarySegments = [
  { start: 0, end: 2, speaker: 1 },
  { start: 2.3, end: 4, speaker: 2 },
];

const entries8 = JSON.parse(JSON.stringify(boundaryEntries));
const map8 = assignSpeakersFromDiarization(entries8, boundarySegments, 2);
assert.strictEqual(map8.size, 2);
assert.strictEqual(new Set(entries8.map(e => e.speakerId)).size, 2);

console.log('speakerAssignment diarization tests passed');
