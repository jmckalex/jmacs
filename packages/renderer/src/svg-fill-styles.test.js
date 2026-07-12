/**
 * @file Unit tests for fill-style defs (gradients / patterns) and the
 * align / distribute deltas.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FILL_STYLES, FILL_ANGLES, fillStyleId, fillStyleDef } from './svg-fill-styles.js';
import { alignDeltas, distributeDeltas, ALIGN_MODES } from './svg-geometry.js';

test('every non-solid style builds a def with its stable id', () => {
  for (const style of FILL_STYLES.filter((s) => s !== 'solid')) {
    const def = fillStyleDef(style, '#ff0000', '#0000ff', 45);
    assert.ok(def, style);
    assert.equal(def.id, fillStyleId(style, '#ff0000', '#0000ff', 45));
    assert.ok(def.markup.includes(`id="${def.id}"`), style);
  }
  assert.equal(fillStyleDef('solid', '#fff', '#000'), null);
  assert.equal(fillStyleDef('nope', '#fff', '#000'), null);
});

test('ids are parameter-stable and colour-distinct', () => {
  assert.equal(fillStyleId('linear', '#FF0000', 'blue', 90), 'godot-fill-l-ff0000-blue-90');
  assert.notEqual(fillStyleId('dots', '#111', '#fff'), fillStyleId('dots', '#222', '#fff'));
  // Patterns (except checker) ignore the secondary colour in the id.
  assert.equal(fillStyleId('hatch', '#111', '#fff'), fillStyleId('hatch', '#111', '#000'));
});

test('linear gradient angles map to the four preset vectors', () => {
  assert.deepEqual(FILL_ANGLES, [0, 45, 90, 135]);
  const h = fillStyleDef('linear', '#000', '#fff', 0).markup;
  assert.ok(h.includes('x2="100%"') && h.includes('y2="0%"'));
  const v = fillStyleDef('linear', '#000', '#fff', 90).markup;
  assert.ok(v.includes('x2="0%"') && v.includes('y2="100%"'));
});

test('patterns are userSpaceOnUse and colour the primary', () => {
  const d = fillStyleDef('dots', '#123456', '#fff').markup;
  assert.ok(d.includes('patternUnits="userSpaceOnUse"'));
  assert.ok(d.includes('fill="#123456"'));
  const c = fillStyleDef('checker', '#111111', '#eeeeee').markup;
  assert.ok(c.includes('fill="#eeeeee"') && c.includes('fill="#111111"'));
});

// --- align / distribute -------------------------------------------------------

const RECTS = [
  { x: 0, y: 0, width: 10, height: 10 },
  { x: 40, y: 20, width: 20, height: 10 },
  { x: 100, y: 5, width: 10, height: 30 },
];

test('alignDeltas left/right/top move edges to the extremes', () => {
  const left = alignDeltas(RECTS, 'left');
  assert.deepEqual(left.map((d) => d.dx), [0, -40, -100]);
  const right = alignDeltas(RECTS, 'right');
  assert.deepEqual(right.map((d) => d.dx), [100, 50, 0]);
  const top = alignDeltas(RECTS, 'top');
  assert.deepEqual(top.map((d) => d.dy), [0, -20, -5]);
});

test('alignDeltas centers move bbox centres to the set centre', () => {
  const cx = alignDeltas(RECTS, 'centerX');
  // Set spans x 0..110 → centre 55.
  assert.deepEqual(cx.map((d) => d.dx), [50, 5, -50]);
  for (const d of cx) assert.equal(d.dy, 0);
  assert.equal(ALIGN_MODES.length, 6);
});

test('distributeDeltas spaces centres evenly, input order preserved', () => {
  // Centres at x = 5, 50, 105 → step (105-5)/2 = 50 → targets 5, 55, 105.
  const d = distributeDeltas(RECTS, 'x');
  assert.deepEqual(d.map((v) => Math.round(v.dx)), [0, 5, 0]);
  // Fewer than three: no-op.
  assert.deepEqual(distributeDeltas(RECTS.slice(0, 2), 'x'), [
    { dx: 0, dy: 0 },
    { dx: 0, dy: 0 },
  ]);
});

test('distributeDeltas y-axis works on unsorted input', () => {
  const rects = [
    { x: 0, y: 100, width: 10, height: 10 }, // centre 105
    { x: 0, y: 0, width: 10, height: 10 }, // centre 5
    { x: 0, y: 30, width: 10, height: 10 }, // centre 35
  ];
  const d = distributeDeltas(rects, 'y');
  // Sorted centres 5, 35, 105 → targets 5, 55, 105 → the middle moves +20.
  assert.deepEqual(d.map((v) => Math.round(v.dy)), [0, 0, 20]);
});
