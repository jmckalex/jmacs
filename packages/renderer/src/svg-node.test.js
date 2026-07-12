/**
 * @file Unit tests for the TikZ-style node helpers: content
 * classification (text / math / mixed), the `\text{…}` wrap with prose
 * escaping, border fitting for every shape, and MathJax ex-length
 * placement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NODE_BORDER_SHAPES,
  nodeContentKind,
  escapeProseSpecials,
  texForNodeContent,
  fitNodeBorder,
  parseExLength,
  mathSvgPlacement,
} from './svg-node.js';

// --- classification ---------------------------------------------------------

test('plain prose classifies as text', () => {
  assert.equal(nodeContentKind('Start'), 'text');
  assert.equal(nodeContentKind('Read input, then decide'), 'text');
  assert.equal(nodeContentKind(''), 'text');
  assert.equal(nodeContentKind(null), 'text');
});

test('fully-wrapped math classifies as math', () => {
  assert.equal(nodeContentKind('$q_0$'), 'math');
  assert.equal(nodeContentKind('$\\frac{a}{b}$'), 'math');
  assert.equal(nodeContentKind('\\(x+1\\)'), 'math');
});

test('bare TeX commands classify as math', () => {
  assert.equal(nodeContentKind('\\alpha \\to \\beta'), 'math');
});

test('prose with inline $…$ classifies as mixed', () => {
  assert.equal(nodeContentKind('accept $q_0$'), 'mixed');
  assert.equal(nodeContentKind('$a$ or $b$'), 'mixed');
});

test('an escaped \\$ does not force math or mixed — stays prose', () => {
  assert.equal(nodeContentKind('costs \\$5 today'), 'text');
});

// --- TeX wrapping -------------------------------------------------------------

test('texForNodeContent strips full $…$ / \\(…\\) wrappers', () => {
  assert.equal(texForNodeContent('$q_0$'), 'q_0');
  assert.equal(texForNodeContent('\\(x+1\\)'), 'x+1');
});

test('texForNodeContent passes bare TeX through', () => {
  assert.equal(texForNodeContent('\\alpha \\to \\beta'), '\\alpha \\to \\beta');
});

test('texForNodeContent wraps mixed prose in \\text{…}', () => {
  assert.equal(texForNodeContent('accept $q_0$'), '\\text{accept $q_0$}');
});

test('texForNodeContent returns null for plain prose', () => {
  assert.equal(texForNodeContent('Start'), null);
});

test('escapeProseSpecials escapes unescaped % & # only', () => {
  assert.equal(escapeProseSpecials('50% off & #1'), '50\\% off \\& \\#1');
  assert.equal(escapeProseSpecials('already \\% fine'), 'already \\% fine');
  assert.equal(escapeProseSpecials('$q_0$ stays'), '$q_0$ stays');
});

test('mixed wrap escapes prose specials outside the math run', () => {
  assert.equal(
    texForNodeContent('50% of $x$'),
    '\\text{50\\% of $x$}'
  );
});

// --- border fitting -------------------------------------------------------------

test('rect border is the padded box, centred', () => {
  const b = fitNodeBorder({ width: 40, height: 20 }, { shape: 'rect', padding: 5 });
  assert.equal(b.tag, 'rect');
  assert.deepEqual(b.attrs, { x: -25, y: -15, width: 50, height: 30 });
});

test('rounded border adds rx', () => {
  const b = fitNodeBorder({ width: 40, height: 20 }, { shape: 'rounded', padding: 5, cornerRadius: 8 });
  assert.equal(b.attrs.rx, 8);
});

test('circle border passes through the padded box corner (TikZ circle)', () => {
  const b = fitNodeBorder({ width: 40, height: 20 }, { shape: 'circle', padding: 5 });
  assert.equal(b.tag, 'circle');
  assert.ok(Math.abs(b.attrs.r - Math.hypot(25, 15)) < 1e-9);
});

test('ellipse border is √2 × the padded half-extents (TikZ ellipse)', () => {
  const b = fitNodeBorder({ width: 40, height: 20 }, { shape: 'ellipse', padding: 5 });
  assert.ok(Math.abs(b.attrs.rx - Math.SQRT2 * 25) < 1e-9);
  assert.ok(Math.abs(b.attrs.ry - Math.SQRT2 * 15) < 1e-9);
  // The padded corner (25,15) lies ON the ellipse: (x/rx)² + (y/ry)² = 1.
  const v = (25 / b.attrs.rx) ** 2 + (15 / b.attrs.ry) ** 2;
  assert.ok(Math.abs(v - 1) < 1e-9);
});

test('diamond border vertices clear the padded box corners', () => {
  const b = fitNodeBorder({ width: 40, height: 20 }, { shape: 'diamond', padding: 5 });
  assert.equal(b.tag, 'polygon');
  assert.equal(b.attrs.points, '0,-30 50,0 0,30 -50,0');
  // The edge from (50,0) to (0,-30) passes through the corner (25,15)?
  // x/50 + y/30 = 1 → 25/50 + 15/30 = 1 exactly: the corner is on the edge.
  assert.ok(Math.abs(25 / 50 + 15 / 30 - 1) < 1e-9);
});

test('none / unknown shapes return null', () => {
  assert.equal(fitNodeBorder({ width: 10, height: 10 }, { shape: 'none' }), null);
  assert.equal(fitNodeBorder({ width: 10, height: 10 }, { shape: 'blob' }), null);
});

test('NODE_BORDER_SHAPES lists every supported shape', () => {
  assert.deepEqual(NODE_BORDER_SHAPES, ['none', 'rect', 'rounded', 'circle', 'ellipse', 'diamond']);
  for (const s of NODE_BORDER_SHAPES.filter((x) => x !== 'none')) {
    assert.ok(fitNodeBorder({ width: 10, height: 4 }, { shape: s }) !== null, s);
  }
});

// --- ex-length placement -----------------------------------------------------------

test('parseExLength parses MathJax ex attributes', () => {
  assert.equal(parseExLength('2.34ex'), 2.34);
  assert.equal(parseExLength(' 10ex '), 10);
  assert.equal(parseExLength('-0.566ex'), -0.566);
  assert.equal(parseExLength('12px'), null);
  assert.equal(parseExLength(undefined), null);
});

test('mathSvgPlacement converts ex → user units at fontSize/2 and centres', () => {
  const p = mathSvgPlacement('4ex', '2ex', 20);
  assert.deepEqual(p, { width: 40, height: 20, x: -20, y: -10 });
});

test('mathSvgPlacement rejects non-ex attributes', () => {
  assert.equal(mathSvgPlacement('40', '20', 16), null);
});
