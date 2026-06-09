/**
 * @file completions-panel.test.js — unit tests for the pure
 * `completionsHeaderLabel` helper (the count label shown above the list).
 * The DOM panel itself is exercised live, mirroring the output-panel and
 * utility-dock test convention.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { completionsHeaderLabel } from '../src/completions-panel.js';

test('completionsHeaderLabel pluralises by count', () => {
  assert.equal(completionsHeaderLabel(1), '1 completion');
  assert.equal(completionsHeaderLabel(2), '2 completions');
  assert.equal(completionsHeaderLabel(47), '47 completions');
});

test('completionsHeaderLabel handles an empty / invalid count', () => {
  assert.equal(completionsHeaderLabel(0), 'No completions');
  assert.equal(completionsHeaderLabel(-3), 'No completions');
  assert.equal(completionsHeaderLabel(NaN), 'No completions');
  assert.equal(completionsHeaderLabel(undefined), 'No completions');
});
