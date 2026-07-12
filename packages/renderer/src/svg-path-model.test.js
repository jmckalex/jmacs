/**
 * @file Unit tests for the SVG editor's pure Bezier path model.
 *
 * Parsing (the M/L/H/V/C/S/Q/T/Z subset, absolute + relative, opaque
 * fallbacks), serialisation round-trips, the immutable edit ops (move
 * anchor, set handle with/without symmetry, translate, resize), sampling
 * (flatten, nearest-point, hit-test), and anchor insertion / removal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeAnchor,
  clonePath,
  parsePathData,
  pathDataFromModel,
  segmentCount,
  segmentPoints,
  pointOnSegment,
  movePathAnchor,
  setPathHandle,
  translatePath,
  transformPath,
  resizePath,
  flattenPath,
  nearestPointOnPath,
  hitTestPath,
  insertAnchor,
  removeAnchor,
  pathOutlineBbox,
} from './svg-path-model.js';

/** Convenience: assert two points are (nearly) equal. */
function assertPt(actual, expected, eps = 1e-6) {
  assert.ok(
    Math.abs(actual.x - expected.x) < eps && Math.abs(actual.y - expected.y) < eps,
    `expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`
  );
}

// --- parsing ---------------------------------------------------------------

test('parses M/L into line anchors', () => {
  const m = parsePathData('M 10 20 L 30 40 L 50 60');
  assert.equal(m.closed, false);
  assert.equal(m.anchors.length, 3);
  assertPt(m.anchors[0], { x: 10, y: 20 });
  assertPt(m.anchors[2], { x: 50, y: 60 });
  assert.equal(m.anchors[0].hOut, null);
  assert.equal(m.anchors[1].hIn, null);
});

test('parses C into handles on both ends', () => {
  const m = parsePathData('M 0 0 C 10 0 20 10 30 10');
  assert.equal(m.anchors.length, 2);
  assertPt(m.anchors[0].hOut, { x: 10, y: 0 });
  assertPt(m.anchors[1].hIn, { x: 20, y: 10 });
  assert.equal(m.anchors[1].hOut, null);
});

test('parses relative commands (m/l/c) against the running point', () => {
  const m = parsePathData('m 10 10 l 20 0 c 5 5 15 5 20 0');
  assert.equal(m.anchors.length, 3);
  assertPt(m.anchors[1], { x: 30, y: 10 });
  assertPt(m.anchors[1].hOut, { x: 35, y: 15 });
  assertPt(m.anchors[2].hIn, { x: 45, y: 15 });
  assertPt(m.anchors[2], { x: 50, y: 10 });
});

test('parses H and V as axis-locked lines', () => {
  const m = parsePathData('M 5 5 H 25 V 30 h 10 v -5');
  assert.equal(m.anchors.length, 5);
  assertPt(m.anchors[1], { x: 25, y: 5 });
  assertPt(m.anchors[2], { x: 25, y: 30 });
  assertPt(m.anchors[3], { x: 35, y: 30 });
  assertPt(m.anchors[4], { x: 35, y: 25 });
});

test('S reflects the previous cubic control point', () => {
  const m = parsePathData('M 0 0 C 10 0 20 0 30 0 S 50 10 60 10');
  // c1 of the S segment = reflection of (20,0) about (30,0) = (40,0)
  assertPt(m.anchors[1].hOut, { x: 40, y: 0 });
  assertPt(m.anchors[2].hIn, { x: 50, y: 10 });
});

test('Q promotes exactly to a cubic (outline preserved at t=0.5)', () => {
  const m = parsePathData('M 0 0 Q 15 30 30 0');
  // Quadratic at t=.5: (0.25*0 + 0.5*15 + 0.25*30, 0.25*0 + 0.5*30 + 0.25*0) = (15, 15)
  assertPt(pointOnSegment(m, 0, 0.5), { x: 15, y: 15 });
});

test('T reflects the previous quadratic control point', () => {
  const m = parsePathData('M 0 0 Q 10 20 20 0 T 40 0');
  // Reflected quad control = (2*20-10, 2*0-20) = (30, -20); at t=.5 the
  // second segment passes through (30, -10).
  assertPt(pointOnSegment(m, 1, 0.5), { x: 30, y: -10 });
});

test('Z marks the model closed and folds a duplicated last anchor', () => {
  const m = parsePathData('M 0 0 L 10 0 L 10 10 Z');
  assert.equal(m.closed, true);
  assert.equal(m.anchors.length, 3);
  const dup = parsePathData('M 0 0 L 10 0 L 10 10 L 0 0 Z');
  assert.equal(dup.anchors.length, 3);
});

test('implicit repetition: M followed by extra pairs continues as lineto', () => {
  const m = parsePathData('M 0 0 10 0 10 10');
  assert.equal(m.anchors.length, 3);
  assertPt(m.anchors[2], { x: 10, y: 10 });
});

test('returns null for arcs, multi-subpath, malformed and empty data', () => {
  assert.equal(parsePathData('M 0 0 A 5 5 0 0 1 10 10'), null);
  assert.equal(parsePathData('M 0 0 L 10 10 M 20 20 L 30 30'), null);
  assert.equal(parsePathData('L 10 10'), null);
  assert.equal(parsePathData('M 0 0 L 10'), null);
  assert.equal(parsePathData('M 5 5'), null); // a single point
  assert.equal(parsePathData(''), null);
  assert.equal(parsePathData('Z'), null);
});

// --- serialisation -----------------------------------------------------------

test('round-trips lines and cubics through parse -> serialize -> parse', () => {
  const d = 'M 10 20 L 30 40 C 35 45 45 45 50 40';
  const m = parsePathData(d);
  const out = pathDataFromModel(m);
  const m2 = parsePathData(out);
  assert.equal(m2.anchors.length, m.anchors.length);
  for (let i = 0; i < m.anchors.length; i += 1) {
    assertPt(m2.anchors[i], m.anchors[i], 0.01);
  }
});

test('closed straight-sided path serialises with a bare Z (no duplicate L)', () => {
  const m = parsePathData('M 0 0 L 10 0 L 10 10 Z');
  const d = pathDataFromModel(m);
  assert.equal(d, 'M 0 0 L 10 0 L 10 10 Z');
});

test('closed path with a curved closing segment keeps the C before Z', () => {
  const m = parsePathData('M 0 0 L 10 0 C 12 5 2 5 0 0 Z');
  const d = pathDataFromModel(m);
  assert.ok(/C [\d. -]+Z$/.test(d), d);
  const m2 = parsePathData(d);
  assert.equal(m2.closed, true);
  assert.equal(m2.anchors.length, 2);
});

// --- structure ---------------------------------------------------------------

test('segmentCount: open n-1, closed n', () => {
  assert.equal(segmentCount(parsePathData('M 0 0 L 1 1 L 2 2')), 2);
  assert.equal(segmentCount(parsePathData('M 0 0 L 1 1 L 2 0 Z')), 3);
});

test('segmentPoints flags straight vs curved segments', () => {
  const m = parsePathData('M 0 0 L 10 0 C 12 5 15 5 20 0');
  assert.equal(segmentPoints(m, 0).isLine, true);
  assert.equal(segmentPoints(m, 1).isLine, false);
});

// --- edit ops ----------------------------------------------------------------

test('movePathAnchor shifts the anchor and both handles, immutably', () => {
  const m = parsePathData('M 0 0 C 10 0 20 10 30 10 C 40 10 50 0 60 0');
  const before = clonePath(m);
  const next = movePathAnchor(m, 1, 5, -5);
  assertPt(next.anchors[1], { x: 35, y: 5 });
  assertPt(next.anchors[1].hIn, { x: 25, y: 5 });
  assertPt(next.anchors[1].hOut, { x: 45, y: 5 });
  assert.deepEqual(m, before); // untouched input
});

test('setPathHandle symmetric mirrors the opposite handle', () => {
  const m = parsePathData('M 0 0 C 10 0 20 10 30 10 C 40 10 50 0 60 0');
  const next = setPathHandle(m, 1, 'out', { x: 45, y: 20 }, 'symmetric');
  assertPt(next.anchors[1].hOut, { x: 45, y: 20 });
  assertPt(next.anchors[1].hIn, { x: 15, y: 0 }); // 2*(30,10) - (45,20)
});

test('setPathHandle free moves only the named handle', () => {
  const m = parsePathData('M 0 0 C 10 0 20 10 30 10 C 40 10 50 0 60 0');
  const next = setPathHandle(m, 1, 'out', { x: 45, y: 20 }, 'free');
  assertPt(next.anchors[1].hOut, { x: 45, y: 20 });
  assertPt(next.anchors[1].hIn, { x: 20, y: 10 }); // unchanged
});

test('symmetric set on an anchor without an opposite handle leaves it null', () => {
  const m = parsePathData('M 0 0 L 30 0');
  const next = setPathHandle(m, 0, 'out', { x: 10, y: 10 }, 'symmetric');
  assertPt(next.anchors[0].hOut, { x: 10, y: 10 });
  assert.equal(next.anchors[0].hIn, null);
});

test('translatePath moves everything', () => {
  const m = parsePathData('M 0 0 C 10 0 20 10 30 10');
  const next = translatePath(m, 100, 200);
  assertPt(next.anchors[0], { x: 100, y: 200 });
  assertPt(next.anchors[1].hIn, { x: 120, y: 210 });
});

test('resizePath maps anchors and handles through the bbox change', () => {
  const m = parsePathData('M 0 0 L 10 0 L 10 10');
  const next = resizePath(
    m,
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 100, y: 100, width: 20, height: 5 }
  );
  assertPt(next.anchors[0], { x: 100, y: 100 });
  assertPt(next.anchors[1], { x: 120, y: 100 });
  assertPt(next.anchors[2], { x: 120, y: 105 });
});

test('resizePath with a zero-size source axis translates instead of scaling', () => {
  const m = parsePathData('M 0 5 L 10 5'); // zero height
  const next = resizePath(
    m,
    { x: 0, y: 5, width: 10, height: 0 },
    { x: 0, y: 50, width: 10, height: 0 }
  );
  assertPt(next.anchors[0], { x: 0, y: 50 });
  assertPt(next.anchors[1], { x: 10, y: 50 });
});

test('transformPath applies an arbitrary point map', () => {
  const m = parsePathData('M 1 2 L 3 4');
  const next = transformPath(m, (p) => ({ x: p.y, y: p.x }));
  assertPt(next.anchors[0], { x: 2, y: 1 });
  assertPt(next.anchors[1], { x: 4, y: 3 });
});

// --- sampling / hit-testing ----------------------------------------------------

test('flattenPath: straight segments contribute two points, curves many', () => {
  const line = flattenPath(parsePathData('M 0 0 L 10 0'));
  assert.equal(line.length, 2);
  const curve = flattenPath(parsePathData('M 0 0 C 0 10 10 10 10 0'), 8);
  assert.equal(curve.length, 9);
});

test('hitTestPath hits near the outline, misses the interior of a curve bow', () => {
  const m = parsePathData('M 0 0 C 0 40 60 40 60 0');
  assert.equal(hitTestPath(m, { x: 30, y: 30 }, 3), true); // apex of the bow
  assert.equal(hitTestPath(m, { x: 30, y: 5 }, 3), false); // inside the bow
  assert.equal(hitTestPath(m, { x: 0, y: 0 }, 3), true); // an endpoint
});

test('nearestPointOnPath projects onto a straight segment accurately', () => {
  const m = parsePathData('M 0 0 L 100 0');
  const near = nearestPointOnPath(m, { x: 25, y: 10 });
  assert.equal(near.seg, 0);
  assert.ok(Math.abs(near.t - 0.25) < 0.02, `t=${near.t}`);
  assertPt(near.point, { x: 25, y: 0 }, 0.5);
});

test('closed path: the wrapping segment is hit-testable', () => {
  const m = parsePathData('M 0 0 L 20 0 L 20 20 L 0 20 Z');
  // The closing edge runs from (0,20) back to (0,0).
  assert.equal(hitTestPath(m, { x: 0, y: 10 }, 2), true);
});

// --- insert / remove ------------------------------------------------------------

test('insertAnchor on a line splits it at t without moving the outline', () => {
  const m = parsePathData('M 0 0 L 100 0');
  const next = insertAnchor(m, 0, 0.3);
  assert.equal(next.anchors.length, 3);
  assertPt(next.anchors[1], { x: 30, y: 0 });
  assert.equal(next.anchors[1].hIn, null);
});

test('insertAnchor on a curve preserves the outline (de Casteljau)', () => {
  const m = parsePathData('M 0 0 C 0 40 60 40 60 0');
  const probe = [0.1, 0.35, 0.6, 0.9].map((t) => pointOnSegment(m, 0, t));
  const next = insertAnchor(m, 0, 0.4);
  assert.equal(next.anchors.length, 3);
  // The split point lies on the original curve.
  assertPt(next.anchors[1], pointOnSegment(m, 0, 0.4), 1e-6);
  // And the new two-segment outline still passes (nearly) through the probes.
  for (const p of probe) {
    const near = nearestPointOnPath(next, p, 64);
    assert.ok(near.dist < 0.05, `drifted by ${near.dist}`);
  }
});

test('removeAnchor drops one anchor; refuses to leave a degenerate path', () => {
  const m = parsePathData('M 0 0 L 10 0 L 20 0');
  const next = removeAnchor(m, 1);
  assert.equal(next.anchors.length, 2);
  assert.equal(removeAnchor(next, 0), null); // would leave 1 anchor
  const tri = parsePathData('M 0 0 L 10 0 L 10 10 Z');
  assert.equal(removeAnchor(tri, 0), null); // closed needs 3
});

// --- bbox ------------------------------------------------------------------------

test('pathOutlineBbox covers the sampled outline, not just anchors', () => {
  const m = parsePathData('M 0 0 C 0 40 60 40 60 0');
  const box = pathOutlineBbox(m, 32);
  assert.ok(box.height > 25, `bow height ${box.height}`); // curve rises to y=30
  assert.equal(box.width, 60);
});

test('makeAnchor copies handle points defensively', () => {
  const h = { x: 1, y: 2 };
  const a = makeAnchor(0, 0, h, null);
  h.x = 99;
  assert.equal(a.hIn.x, 1);
});
