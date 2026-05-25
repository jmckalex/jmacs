import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatDuration } from '../src/audio-view.js';

test('formatDuration formats seconds under a minute as M:SS', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(5), '0:05');
  assert.equal(formatDuration(59), '0:59');
});

test('formatDuration formats minutes as M:SS, rolling at 60s', () => {
  assert.equal(formatDuration(60), '1:00');
  assert.equal(formatDuration(125), '2:05');
  assert.equal(formatDuration(3599), '59:59');
});

test('formatDuration uses H:MM:SS once the duration crosses an hour', () => {
  assert.equal(formatDuration(3600), '1:00:00');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(7322), '2:02:02');
});

test('formatDuration rounds fractional seconds to the nearest integer', () => {
  assert.equal(formatDuration(59.4), '0:59');
  assert.equal(formatDuration(59.6), '1:00');
});

test('formatDuration treats negatives as zero', () => {
  assert.equal(formatDuration(-1), '0:00');
});

test('formatDuration returns the empty string for non-finite inputs', () => {
  assert.equal(formatDuration(NaN), '');
  assert.equal(formatDuration(Infinity), '');
  assert.equal(formatDuration(-Infinity), '');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration('30'), '');
});
