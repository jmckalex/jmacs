/**
 * @file Unit tests for the connector geometry: compass anchors and
 * auto (ray-toward) border points on rect / circle / ellipse / diamond
 * specs, spec translation, and the nearest-anchor picker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPASS_ANCHORS,
  parsePolyPoints,
  specCenter,
  translateSpec,
  borderAnchorPoint,
  borderPointToward,
  connectorEndpoint,
  nearestCompassAnchor,
} from './svg-connect.js';
import { fitNodeBorder } from './svg-node.js';

function assertPt(actual, expected, eps = 1e-6) {
  assert.ok(
    Math.abs(actual.x - expected.x) < eps && Math.abs(actual.y - expected.y) < eps,
    `expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`
  );
}

const RECT = { tag: 'rect', attrs: { x: 100, y: 50, width: 80, height: 40 } };
const CIRCLE = { tag: 'circle', attrs: { cx: 10, cy: 20, r: 5 } };
const ELLIPSE = { tag: 'ellipse', attrs: { cx: 0, cy: 0, rx: 40, ry: 20 } };

test('specCenter for each spec kind', () => {
  assertPt(specCenter(RECT), { x: 140, y: 70 });
  assertPt(specCenter(CIRCLE), { x: 10, y: 20 });
  assertPt(specCenter({ tag: 'polygon', attrs: { points: '0,-10 20,0 0,10 -20,0' } }), { x: 0, y: 0 });
});

test('translateSpec shifts every spec kind into place', () => {
  assertPt(specCenter(translateSpec(RECT, 10, -5)), { x: 150, y: 65 });
  assertPt(specCenter(translateSpec(CIRCLE, 1, 2)), { x: 11, y: 22 });
  const poly = translateSpec({ tag: 'polygon', attrs: { points: '0,-10 20,0 0,10 -20,0' } }, 100, 200);
  assert.equal(poly.attrs.points, '100,190 120,200 100,210 80,200');
});

test('rect compass anchors are edge midpoints and true corners', () => {
  assertPt(borderAnchorPoint(RECT, 'n'), { x: 140, y: 50 });
  assertPt(borderAnchorPoint(RECT, 'se'), { x: 180, y: 90 });
  assertPt(borderAnchorPoint(RECT, 'w'), { x: 100, y: 70 });
});

test('circle and ellipse diagonal anchors are the 45° points', () => {
  assertPt(borderAnchorPoint(CIRCLE, 'e'), { x: 15, y: 20 });
  const ne = borderAnchorPoint(ELLIPSE, 'ne');
  assertPt(ne, { x: 40 * Math.SQRT1_2, y: -20 * Math.SQRT1_2 });
  // The point lies ON the ellipse.
  assert.ok(Math.abs((ne.x / 40) ** 2 + (ne.y / 20) ** 2 - 1) < 1e-9);
});

test('diamond anchors: vertices at cardinals, edge midpoints at diagonals', () => {
  const d = fitNodeBorder({ width: 40, height: 20 }, { shape: 'diamond', padding: 5 });
  assertPt(borderAnchorPoint(d, 'n'), { x: 0, y: -30 });
  assertPt(borderAnchorPoint(d, 'e'), { x: 50, y: 0 });
  assertPt(borderAnchorPoint(d, 'ne'), { x: 25, y: -15 });
});

test('borderPointToward: rect edge and corner-ward rays', () => {
  // Straight east: hits the right edge midpoint.
  assertPt(borderPointToward(RECT, { x: 300, y: 70 }), { x: 180, y: 70 });
  // Steeper than the aspect: hits the bottom edge.
  assertPt(borderPointToward(RECT, { x: 150, y: 200 }), { x: 140 + (20 / 130) * 10, y: 90 }, 0.01);
});

test('borderPointToward: circle and ellipse lie on the curve', () => {
  const p = borderPointToward(CIRCLE, { x: 22, y: 36 });
  assert.ok(Math.abs(Math.hypot(p.x - 10, p.y - 20) - 5) < 1e-9);
  const q = borderPointToward(ELLIPSE, { x: 100, y: 60 });
  assert.ok(Math.abs((q.x / 40) ** 2 + (q.y / 20) ** 2 - 1) < 1e-9);
  // And it points the right way.
  assert.ok(q.x > 0 && q.y > 0);
});

test('borderPointToward: diamond ray hits the facing edge', () => {
  const d = { tag: 'polygon', attrs: { points: '0,-30 50,0 0,30 -50,0' } };
  const p = borderPointToward(d, { x: 50, y: -30 });
  // Ray at 45°-ish toward NE hits the n→e edge: x/50 + y/-30... the edge
  // from (0,-30) to (50,0) satisfies x/50 - y/30 = 1.
  assert.ok(Math.abs(p.x / 50 - p.y / 30 - 1) < 1e-9, JSON.stringify(p));
});

test('borderPointToward: degenerate zero direction returns the centre', () => {
  assertPt(borderPointToward(RECT, { x: 140, y: 70 }), { x: 140, y: 70 });
});

test('connectorEndpoint: named anchor wins, auto falls back to the ray', () => {
  assertPt(connectorEndpoint(RECT, 's', { x: 0, y: 0 }), { x: 140, y: 90 });
  assertPt(connectorEndpoint(RECT, 'auto', { x: 300, y: 70 }), { x: 180, y: 70 });
  // Unknown anchor name degrades to auto.
  assertPt(connectorEndpoint(RECT, 'bogus', { x: 300, y: 70 }), { x: 180, y: 70 });
});

test('nearestCompassAnchor picks the closest and reports distance', () => {
  const near = nearestCompassAnchor(RECT, { x: 178, y: 88 });
  assert.equal(near.name, 'se');
  assert.ok(near.dist < 4);
  assert.equal(COMPASS_ANCHORS.length, 8);
});

test('parsePolyPoints tolerates comma and space separators', () => {
  assert.deepEqual(parsePolyPoints('0,-30 50,0'), [{ x: 0, y: -30 }, { x: 50, y: 0 }]);
  assert.deepEqual(parsePolyPoints('1 2, 3 4'), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
});
