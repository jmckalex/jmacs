import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldDrawFocusBorder } from '../src/pane-focus.js';

test("'off never draws the border", () => {
  assert.equal(shouldDrawFocusBorder('off', 1), false);
  assert.equal(shouldDrawFocusBorder('off', 5), false);
});

test("'on always draws the border", () => {
  assert.equal(shouldDrawFocusBorder('on', 1), true);
  assert.equal(shouldDrawFocusBorder('on', 0), true);
});

test("'auto draws the border only with more than one focusable pane", () => {
  assert.equal(shouldDrawFocusBorder('auto', 0), false);
  assert.equal(shouldDrawFocusBorder('auto', 1), false);
  assert.equal(shouldDrawFocusBorder('auto', 2), true);
  assert.equal(shouldDrawFocusBorder('auto', 4), true);
});

test('an unknown mode is treated as auto', () => {
  assert.equal(shouldDrawFocusBorder('wat', 1), false);
  assert.equal(shouldDrawFocusBorder('wat', 2), true);
  assert.equal(shouldDrawFocusBorder(undefined, 2), true);
});
