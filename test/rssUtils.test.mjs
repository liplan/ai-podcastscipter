import assert from 'assert';
import { extractSpeakers, createProfiles } from '../rssUtils.mjs';

const item = {
  author: 'Alice, Bob',
  content: 'Ein Gespräch mit Alice & Carol'
};

const names = extractSpeakers(item);
assert.deepStrictEqual(names.sort(), ['Alice','Bob','Carol'].sort());

const profiles = createProfiles(names);
assert.deepStrictEqual(profiles, [
  { name: 'Alice', trained: false },
  { name: 'Bob', trained: false },
  { name: 'Carol', trained: false }
]);

console.log('rssUtils tests passed');
