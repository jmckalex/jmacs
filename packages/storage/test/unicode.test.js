/**
 * @file Unicode-aware stepping — `stepBackward` / `stepForward`.
 *
 * These step by whole characters (code points): a surrogate pair counts
 * as one and the returned offset never falls between a high and low
 * surrogate. They are what the buffer layer uses to move and delete "by
 * one character" without splitting an astral character (e.g. an emoji).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '../src/index.js';

// 'a🎨b' is four UTF-16 code units: a(0), high-surrogate(1),
// low-surrogate(2), b(3). The emoji occupies the half-open range [1, 3).
const EMOJI = 'a🎨b';

test('stepBackward skips over a whole surrogate pair', () => {
  const buf = createBuffer(EMOJI);
  assert.equal(buf.stepBackward(4, 1), 3, 'before b');
  assert.equal(buf.stepBackward(3, 1), 1, 'skips the 2-unit emoji');
  assert.equal(buf.stepBackward(1, 1), 0, 'before a');
});

test('stepForward skips over a whole surrogate pair', () => {
  const buf = createBuffer(EMOJI);
  assert.equal(buf.stepForward(0, 1), 1, 'after a');
  assert.equal(buf.stepForward(1, 1), 3, 'skips the 2-unit emoji');
  assert.equal(buf.stepForward(3, 1), 4, 'after b');
});

test('stepBackward / stepForward count whole characters', () => {
  const buf = createBuffer(EMOJI);
  assert.equal(buf.stepBackward(4, 2), 1, 'b + emoji = 2 chars back');
  assert.equal(buf.stepBackward(4, 3), 0, 'b + emoji + a = 3 chars back');
  assert.equal(buf.stepForward(0, 2), 3, 'a + emoji = 2 chars forward');
  assert.equal(buf.stepForward(0, 3), 4, 'a + emoji + b = 3 chars forward');
});

test('stepping clamps at the buffer ends', () => {
  const buf = createBuffer(EMOJI);
  assert.equal(buf.stepBackward(0, 1), 0);
  assert.equal(buf.stepForward(4, 1), 4);
  assert.equal(buf.stepBackward(4, 99), 0, 'count past the start clamps');
  assert.equal(buf.stepForward(0, 99), 4, 'count past the end clamps');
});

test('count defaults to one character', () => {
  const buf = createBuffer(EMOJI);
  assert.equal(buf.stepBackward(3), 1);
  assert.equal(buf.stepForward(1), 3);
});

test('plain BMP text steps one code unit at a time', () => {
  const buf = createBuffer('abc');
  assert.equal(buf.stepBackward(2, 1), 1);
  assert.equal(buf.stepForward(1, 1), 2);
});

test('a lone (unpaired) surrogate is treated as a single unit', () => {
  // High surrogate not followed by a low surrogate, then a plain 'b'.
  const buf = createBuffer('\uD83Cb');
  assert.equal(buf.stepForward(0, 1), 1, 'does not consume the following b');
  assert.equal(buf.stepBackward(1, 1), 0, 'does not under-run before 0');
});

test('stepping rejects an out-of-range offset', () => {
  const buf = createBuffer(EMOJI);
  assert.throws(() => buf.stepBackward(5, 1), RangeError);
  assert.throws(() => buf.stepForward(-1, 1), RangeError);
});
