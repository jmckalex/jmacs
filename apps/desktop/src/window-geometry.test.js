/**
 * @file Tests for reconcileBounds (window-geometry.js) — the session-restore
 * window-frame reconciliation. Pure; part of the `node --test` suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileBounds } from './window-geometry.js';

const LAPTOP = { id: 1, workArea: { x: 0, y: 25, width: 1512, height: 887 }, scaleFactor: 2 };
const EXTERNAL = { id: 2, workArea: { x: 1512, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };

test('unchanged config: same display, frame fits → exact frame back', () => {
  const saved = {
    bounds: { x: 100, y: 80, width: 1040, height: 800 },
    display: LAPTOP,
  };
  const out = reconcileBounds(saved, [LAPTOP]);
  assert.deepEqual(out, { x: 100, y: 80, width: 1040, height: 800 });
});

test('same display but smaller now → rescale, proportions preserved, on-screen', () => {
  // Saved when display 1 was a 2560×1440 surface; it is now 1512×887.
  const savedDisplay = { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1440 } };
  const saved = {
    bounds: { x: 1200, y: 200, width: 1200, height: 1000 },
    display: savedDisplay,
  };
  const out = reconcileBounds(saved, [LAPTOP]);
  // Relative size preserved (within rounding).
  assert.ok(Math.abs(out.width / LAPTOP.workArea.width - 1200 / 2560) < 0.01, 'relative width kept');
  assert.ok(Math.abs(out.height / LAPTOP.workArea.height - 1000 / 1440) < 0.01, 'relative height kept');
  // Fully on the laptop work-area.
  assert.ok(out.x >= LAPTOP.workArea.x);
  assert.ok(out.y >= LAPTOP.workArea.y);
  assert.ok(out.x + out.width <= LAPTOP.workArea.x + LAPTOP.workArea.width);
  assert.ok(out.y + out.height <= LAPTOP.workArea.y + LAPTOP.workArea.height);
});

test('saved display gone (external unplugged) → lands proportionally on a present display', () => {
  const saved = {
    bounds: { x: 1600, y: 300, width: 1400, height: 1100 }, // on the external's coords
    display: EXTERNAL,
  };
  const out = reconcileBounds(saved, [LAPTOP]); // only the laptop remains
  // On-screen on the laptop (the whole point of the fallback).
  assert.ok(out.x >= LAPTOP.workArea.x && out.y >= LAPTOP.workArea.y, 'origin on-screen');
  assert.ok(out.x + out.width <= LAPTOP.workArea.x + LAPTOP.workArea.width, 'right edge on-screen');
  assert.ok(out.y + out.height <= LAPTOP.workArea.y + LAPTOP.workArea.height, 'bottom edge on-screen');
  // Relative size carried over from the external's work-area.
  assert.ok(Math.abs(out.width / LAPTOP.workArea.width - 1400 / 2560) < 0.01, 'relative width kept');
});

test('a tiny saved window is clamped up to the minimum size', () => {
  const saved = { bounds: { x: 0, y: 25, width: 100, height: 100 }, display: LAPTOP };
  const out = reconcileBounds(saved, [LAPTOP], { minWidth: 480, minHeight: 520 });
  assert.equal(out.width, 480, 'min width enforced');
  assert.equal(out.height, 520, 'min height enforced');
});

test('cascade offsets a window so stacked restores do not overlap perfectly', () => {
  const saved = { bounds: { x: 100, y: 80, width: 1040, height: 800 }, display: LAPTOP };
  const a = reconcileBounds(saved, [LAPTOP], { cascade: 0 });
  const b = reconcileBounds(saved, [LAPTOP], { cascade: 1 });
  assert.equal(b.x - a.x, 24, 'second window nudged right by one cascade step');
  assert.equal(b.y - a.y, 24, 'and down by one step');
});

test('prefers the same-id display even when another overlaps the saved frame', () => {
  const saved = { bounds: { x: 1520, y: 40, width: 1000, height: 800 }, display: EXTERNAL };
  // Both present; the external (id 2) is the saved one and contains the frame.
  const out = reconcileBounds(saved, [LAPTOP, EXTERNAL]);
  assert.deepEqual(out, { x: 1520, y: 40, width: 1000, height: 800 }, 'exact on the saved display');
});

test('garbage input → null (caller falls back to a default-placed window)', () => {
  assert.equal(reconcileBounds(null, [LAPTOP]), null);
  assert.equal(reconcileBounds({ bounds: { x: 0, y: 0, width: 1, height: 1 } }, []), null);
  assert.equal(
    reconcileBounds({ bounds: { x: NaN, y: 0, width: 1, height: 1 }, display: LAPTOP }, [LAPTOP]),
    null
  );
});
