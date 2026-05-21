import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchingBracket } from '../src/brackets.js';

test('an open bracket at the cursor matches forward', () => {
  assert.deepEqual(matchingBracket('(a b)', 0), { a: 0, b: 4 });
});

test('a close bracket before the cursor matches backward', () => {
  assert.deepEqual(matchingBracket('(a b)', 5), { a: 4, b: 0 });
});

test('no bracket at the cursor yields null', () => {
  assert.equal(matchingBracket('(a b)', 2), null);
});

test('nested brackets match at the right depth', () => {
  assert.deepEqual(matchingBracket('((x))', 0), { a: 0, b: 4 });
  assert.deepEqual(matchingBracket('((x))', 1), { a: 1, b: 3 });
});

test('square and curly brackets match', () => {
  assert.deepEqual(matchingBracket('[1 2]', 0), { a: 0, b: 4 });
  assert.deepEqual(matchingBracket('{a}', 0), { a: 0, b: 2 });
});

test('an unbalanced bracket yields null', () => {
  assert.equal(matchingBracket('(a b', 0), null);
  assert.equal(matchingBracket('a b)', 4), null);
});
