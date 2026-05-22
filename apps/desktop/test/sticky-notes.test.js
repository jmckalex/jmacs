import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adjustAnchor } from '../src/sticky-notes.js';

/** A BufferChange — `removed`/`inserted` are strings. */
const change = (start, removed, inserted) => ({ start, removed, inserted });

test('an anchor before the edit is unchanged', () => {
  assert.equal(adjustAnchor(5, change(10, '', 'abc')), 5);
});

test('an anchor exactly at the edit start stays (insertion gravity)', () => {
  assert.equal(adjustAnchor(10, change(10, '', 'abc')), 10);
});

test('an anchor after an insertion shifts right by the inserted length', () => {
  assert.equal(adjustAnchor(20, change(10, '', 'abc')), 23);
});

test('an anchor after a deletion shifts left by the removed length', () => {
  assert.equal(adjustAnchor(20, change(10, 'abcde', '')), 15);
});

test('an anchor inside the removed span collapses to the edit start', () => {
  assert.equal(adjustAnchor(12, change(10, 'abcde', '')), 10);
});

test('an anchor after a replacement shifts by the net length change', () => {
  assert.equal(adjustAnchor(20, change(10, 'ab', 'wxyz')), 22);
});

test('a whole-buffer setText collapses an interior anchor to the start', () => {
  // setText reports one change spanning the whole document.
  const old = 'x'.repeat(100);
  assert.equal(adjustAnchor(50, change(0, old, 'y'.repeat(40))), 0);
});
