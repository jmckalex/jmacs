import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuzzyFilter } from '../src/fuzzy.js';

const COMMANDS = [
  'forward-char',
  'backward-char',
  'next-line',
  'previous-line',
  'beginning-of-buffer',
  'end-of-buffer',
  'find-file',
  'save-buffer',
];

test('an empty query returns every item, sorted', () => {
  assert.deepEqual(fuzzyFilter('', ['c', 'a', 'b']), ['a', 'b', 'c']);
});

test('a substring query matches', () => {
  assert.ok(fuzzyFilter('line', COMMANDS).includes('next-line'));
  assert.ok(fuzzyFilter('line', COMMANDS).includes('previous-line'));
});

test('a subsequence query matches non-contiguously', () => {
  // f, c in order — "forward-char" and "find-file" both contain them.
  const matches = fuzzyFilter('fc', COMMANDS);
  assert.ok(matches.includes('forward-char'));
});

test('a non-matching query returns nothing', () => {
  assert.deepEqual(fuzzyFilter('zzz', COMMANDS), []);
});

test('exact and tighter matches rank first', () => {
  // "end-of-buffer" should rank above "beginning-of-buffer" for "endof".
  const matches = fuzzyFilter('endof', COMMANDS);
  assert.equal(matches[0], 'end-of-buffer');
});

test('an earlier, tighter match ranks first', () => {
  const matches = fuzzyFilter('buffer', ['save-buffer', 'buffer']);
  assert.equal(matches[0], 'buffer');
});
