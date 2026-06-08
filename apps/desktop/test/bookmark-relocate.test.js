/**
 * @file Tests for bookmark context relocation — the cross-session /
 * external-edit safety net. Each case captures context around a known
 * position in a baseline string, mutates the string the way an outside
 * edit would, and checks the bookmark is recovered to the right offset.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { captureContext, relocate, CONTEXT_SIZE } from '../src/bookmark-relocate.js';

const TEXT = 'alpha beta gamma delta epsilon';
// bookmark between "beta" and " gamma", at offset 10.
const AT = 10;
const fakeBuffer = (s) => ({ slice: (a, b) => s.slice(a, b), length: s.length });

const ctx = captureContext(fakeBuffer(TEXT), AT, 8);
// rearContext = "pha beta", frontContext = " gamma d"

test('captureContext grabs N chars each side', () => {
  assert.equal(ctx.rearContext, 'pha beta');
  assert.equal(ctx.frontContext, ' gamma d');
});

test('captureContext defaults to CONTEXT_SIZE and clips at the edges', () => {
  const c = captureContext(fakeBuffer('hi'), 1);
  assert.equal(c.rearContext, 'h');
  assert.equal(c.frontContext, 'i');
  assert.equal(CONTEXT_SIZE, 32);
});

test('unchanged surroundings keep the offset exactly (no drift)', () => {
  assert.equal(relocate(TEXT, { anchor: AT, ...ctx }), AT);
});

test('Tier 1: a pure shift relocates by the surviving straddle', () => {
  const shifted = `PADDING${TEXT}`; // 7 chars inserted before
  assert.equal(relocate(shifted, { anchor: AT, ...ctx }), AT + 7);
});

test('Tier 2: with one side edited, the other anchors the boundary', () => {
  const edited = TEXT.replace('gamma', 'GAMMA'); // front changed, rear intact
  assert.equal(relocate(edited, { anchor: AT, ...ctx }), AT);
});

test('Tier 3: both sides lightly edited, fuzzy match finds the boundary', () => {
  const edited = TEXT.replace('beta', 'beto').replace('gamma', 'gammo');
  assert.equal(relocate(edited, { anchor: AT, ...ctx }), AT);
});

test('destroyed context falls back to the clamped saved offset', () => {
  assert.equal(relocate('z'.repeat(40), { anchor: AT, ...ctx }), AT);
});

test('a stale offset past end-of-file clamps', () => {
  assert.equal(relocate('short', { anchor: 100, frontContext: '', rearContext: '' }), 5);
});
