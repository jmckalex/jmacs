import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatAge, recoverFileLabel } from '../src/recover-view.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatAge reads sub-minute as "just now"', () => {
  assert.equal(formatAge(1_000_000, 1_000_000), 'just now');
  assert.equal(formatAge(1_000_000, 1_000_000 + 59 * SEC), 'just now');
});

test('formatAge reports the largest whole unit', () => {
  const base = 10 * DAY; // comfortably above every unit boundary
  assert.equal(formatAge(base, base + 3 * MIN), '3m ago');
  assert.equal(formatAge(base, base + 2 * HOUR), '2h ago');
  assert.equal(formatAge(base, base + 5 * DAY), '5d ago');
});

test('formatAge clamps a future timestamp to "just now"', () => {
  assert.equal(formatAge(2_000_000, 1_000_000), 'just now');
});

test('formatAge returns empty for a missing/invalid timestamp', () => {
  assert.equal(formatAge(undefined, 1_000_000), '');
  assert.equal(formatAge(null, 1_000_000), '');
  assert.equal(formatAge(NaN, 1_000_000), '');
});

test('recoverFileLabel shows the path, or a path-less note', () => {
  assert.equal(recoverFileLabel('/Users/me/notes.txt'), '/Users/me/notes.txt');
  assert.equal(recoverFileLabel(''), '(unsaved buffer)');
  assert.equal(recoverFileLabel(null), '(unsaved buffer)');
  assert.equal(recoverFileLabel(undefined), '(unsaved buffer)');
});
