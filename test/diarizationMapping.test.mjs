import assert from 'assert';
import { applySpeakerMapping } from '../diarizationMapping.mjs';

const entries = [
  { speakerId: 1, startTime: '0', endTime: '1', text: 'hi' },
  { speakerId: 2, startTime: '1', endTime: '2', text: 'hey' }
];
const nameMap = new Map([
  ['Speaker 1', 'Alice'],
  ['Speaker 2', 'Bob']
]);
const mapped = applySpeakerMapping(entries, nameMap, ['Alice','Bob'], true);
assert.deepStrictEqual(mapped.map(m => m.speaker), ['Alice','Bob']);
assert(mapped.every(m => m.confidence === 0.9));
const mappedPrivacy = applySpeakerMapping(entries, nameMap, ['Alice','Bob'], false);
assert.deepStrictEqual(mappedPrivacy.map(m => m.speaker), ['Speaker 1','Speaker 2']);
console.log('diarizationMapping tests passed');
