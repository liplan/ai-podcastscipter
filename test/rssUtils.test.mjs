import assert from 'assert';
import { extractSpeakers, createProfiles } from '../rssUtils.mjs';

const item = {
  author: 'Alice, Bob',
  content: 'Ein Gespräch mit Alice & Carol',
  speakers: ['Gavin Karlmeier', 'Alice'],
  speakerProfiles: [
    { name: 'Gavin Karlmeier', trained: true },
    { name: 'Eve Example', trained: false }
  ],
};

const names = extractSpeakers(item);
assert.deepStrictEqual(
  names.sort(),
  ['Alice', 'Bob', 'Carol', 'Eve Example', 'Gavin Karlmeier'].sort()
);

const profiles = createProfiles(names, item.speakerProfiles);
assert.deepStrictEqual(profiles, [
  { name: 'Gavin Karlmeier', trained: true },
  { name: 'Eve Example', trained: false }
]);

const fallbackProfiles = createProfiles(names);
assert.deepStrictEqual(fallbackProfiles, names.map(name => ({ name, trained: false })));

console.log('rssUtils tests passed');
