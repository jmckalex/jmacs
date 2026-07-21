/**
 * @file Unit tests for the SVG editor's pure geometry helpers.
 *
 * These cover bbox math, hit-testing (rect / segment / handles), resize
 * math, grid snapping, and the screen<->user coordinate transforms — all
 * the side-effect-free core the live `<svg-editor-view>` builds on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  normalizeRect,
  rectFromPoints,
  pointInRect,
  rectsIntersect,
  rectContains,
  handlePositions,
  handleAtPoint,
  resizeRect,
  screenToUser,
  userToScreen,
  bboxOfPoints,
  unionBbox,
  snapToGrid,
  distToSegment,
  anchorPoint,
  HANDLE_NAMES,
} from './svg-geometry.js';

test('clamp bounds a value', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

test('normalizeRect flips negative dimensions to top-left origin', () => {
  assert.deepEqual(normalizeRect({ x: 10, y: 10, width: -4, height: -6 }), {
    x: 6,
    y: 4,
    width: 4,
    height: 6,
  });
  assert.deepEqual(normalizeRect({ x: 1, y: 2, width: 3, height: 4 }), {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
});

test('rectFromPoints builds a normalised rect from any two corners', () => {
  assert.deepEqual(rectFromPoints({ x: 10, y: 10 }, { x: 4, y: 2 }), {
    x: 4,
    y: 2,
    width: 6,
    height: 8,
  });
});

test('pointInRect includes the border', () => {
  const r = { x: 0, y: 0, width: 10, height: 10 };
  assert.ok(pointInRect({ x: 5, y: 5 }, r));
  assert.ok(pointInRect({ x: 0, y: 0 }, r));
  assert.ok(pointInRect({ x: 10, y: 10 }, r));
  assert.ok(!pointInRect({ x: 11, y: 5 }, r));
  assert.ok(!pointInRect({ x: -1, y: 5 }, r));
});

test('pointInRect works with un-normalised rects', () => {
  const r = { x: 10, y: 10, width: -10, height: -10 };
  assert.ok(pointInRect({ x: 5, y: 5 }, r));
});

test('rectsIntersect detects overlap, touch, and separation', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  assert.ok(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 }));
  assert.ok(rectsIntersect(a, { x: 10, y: 0, width: 5, height: 5 })); // edge touch
  assert.ok(!rectsIntersect(a, { x: 11, y: 0, width: 5, height: 5 }));
});

test('rectContains checks full containment', () => {
  const outer = { x: 0, y: 0, width: 100, height: 100 };
  assert.ok(rectContains(outer, { x: 10, y: 10, width: 20, height: 20 }));
  assert.ok(!rectContains(outer, { x: 90, y: 90, width: 20, height: 20 }));
});

test('handlePositions returns all eight handles at the right spots', () => {
  const r = { x: 0, y: 0, width: 20, height: 10 };
  const h = handlePositions(r);
  assert.equal(Object.keys(h).length, 8);
  assert.deepEqual(h.nw, { x: 0, y: 0 });
  assert.deepEqual(h.se, { x: 20, y: 10 });
  assert.deepEqual(h.n, { x: 10, y: 0 });
  assert.deepEqual(h.e, { x: 20, y: 5 });
  for (const name of HANDLE_NAMES) assert.ok(h[name], `has ${name}`);
});

test('handleAtPoint picks the nearest handle within tolerance', () => {
  const r = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(handleAtPoint({ x: 2, y: 2 }, r, 6), 'nw');
  assert.equal(handleAtPoint({ x: 100, y: 100 }, r, 6), 'se');
  assert.equal(handleAtPoint({ x: 50, y: 50 }, r, 6), null); // centre, no handle
});

test('resizeRect drags the SE handle, NW corner fixed', () => {
  const r = { x: 0, y: 0, width: 10, height: 10 };
  assert.deepEqual(resizeRect(r, 'se', { x: 20, y: 30 }), {
    x: 0,
    y: 0,
    width: 20,
    height: 30,
  });
});

test('resizeRect drags the NW handle, SE corner fixed', () => {
  const r = { x: 0, y: 0, width: 10, height: 10 };
  assert.deepEqual(resizeRect(r, 'nw', { x: -5, y: -5 }), {
    x: -5,
    y: -5,
    width: 15,
    height: 15,
  });
});

test('resizeRect on an edge handle only moves one axis', () => {
  const r = { x: 0, y: 0, width: 10, height: 10 };
  assert.deepEqual(resizeRect(r, 'e', { x: 25, y: 999 }), {
    x: 0,
    y: 0,
    width: 25,
    height: 10,
  });
});

test('userToScreen / screenToUser round-trip through a scale+translate CTM', () => {
  // user→screen: scale by 2, translate by (100, 50)
  const ctm = { a: 2, b: 0, c: 0, d: 2, e: 100, f: 50 };
  const user = { x: 10, y: 20 };
  const screen = userToScreen(user, ctm);
  assert.deepEqual(screen, { x: 120, y: 90 });
  const back = screenToUser(screen, ctm);
  assert.ok(Math.abs(back.x - 10) < 1e-9);
  assert.ok(Math.abs(back.y - 20) < 1e-9);
});

test('screenToUser returns null for a non-invertible matrix', () => {
  assert.equal(screenToUser({ x: 1, y: 1 }, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }), null);
});

test('bboxOfPoints computes the enclosing rect', () => {
  assert.deepEqual(
    bboxOfPoints([
      { x: 1, y: 2 },
      { x: 5, y: 1 },
      { x: 3, y: 9 },
    ]),
    { x: 1, y: 1, width: 4, height: 8 }
  );
  assert.equal(bboxOfPoints([]), null);
});

test('unionBbox merges rects', () => {
  assert.deepEqual(
    unionBbox([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 20, y: 5, width: 10, height: 10 },
    ]),
    { x: 0, y: 0, width: 30, height: 15 }
  );
  assert.equal(unionBbox([]), null);
});

test('snapToGrid rounds to the nearest step, no-op for step<=0', () => {
  assert.equal(snapToGrid(13, 10), 10);
  assert.equal(snapToGrid(16, 10), 20);
  assert.equal(snapToGrid(16, 0), 16);
  assert.equal(snapToGrid(16, -1), 16);
});

test('distToSegment measures perpendicular and endpoint distance', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  assert.equal(distToSegment({ x: 5, y: 4 }, a, b), 4); // perpendicular
  assert.equal(distToSegment({ x: -3, y: 0 }, a, b), 3); // past start
  assert.equal(distToSegment({ x: 0, y: 0 }, a, a), 0); // degenerate segment
});

test('anchorPoint returns edge midpoints, corners and centre', () => {
  const r = { x: 0, y: 0, width: 20, height: 10 };
  assert.deepEqual(anchorPoint(r, 'n'), { x: 10, y: 0 });
  assert.deepEqual(anchorPoint(r, 'e'), { x: 20, y: 5 });
  assert.deepEqual(anchorPoint(r, 'se'), { x: 20, y: 10 });
  assert.deepEqual(anchorPoint(r, 'center'), { x: 10, y: 5 });
  assert.deepEqual(anchorPoint(r, 'bogus'), { x: 10, y: 5 });
});
