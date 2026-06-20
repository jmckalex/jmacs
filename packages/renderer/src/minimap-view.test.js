/**
 * @file Unit tests for the minimap's pure geometry/render helpers.
 *
 * The `MinimapView` element itself touches the DOM/canvas and is only
 * exercised live in Electron (see `view-elements.js` on why the class
 * isn't Node-testable). These tests cover the pure math that decides where
 * the thumb sits, how a click maps to a scroll position, and how a token
 * run becomes a rect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp01,
  scrollTopToContentFraction,
  contentFractionToScrollTop,
  thumbRect,
  clickToScrollFraction,
  parseRgb,
  runToRect,
  enclosingScope,
} from './minimap-view.js';

test('clamp01 clamps into [0,1]', () => {
  assert.equal(clamp01(-0.5), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(1.5), 1);
});

test('scrollTop ↔ content fraction round-trips', () => {
  const contentHeight = 1000;
  const viewportHeight = 100;
  for (const st of [0, 225, 450, 900]) {
    const f = scrollTopToContentFraction(st, contentHeight, viewportHeight);
    const back = contentFractionToScrollTop(f, contentHeight, viewportHeight);
    assert.ok(Math.abs(back - st) < 1e-9, `${st} → ${f} → ${back}`);
  }
});

test('scroll fraction is 0 when the document fits the viewport', () => {
  assert.equal(scrollTopToContentFraction(0, 200, 500), 0);
  assert.equal(contentFractionToScrollTop(0.7, 200, 500), 0); // no range to scroll
});

test('thumbRect: at the top the thumb sits at y=0', () => {
  const metrics = { scrollTop: 0, viewportHeight: 100, contentHeight: 1000 };
  const r = thumbRect(metrics, 300, 150); // 100 lines * 3px, 150px canvas
  assert.equal(r.mmScrollTop, 0);
  assert.equal(r.thumbTop, 0);
  assert.equal(r.thumbHeight, 30); // (100/1000) * 300
});

test('thumbRect: at the bottom the thumb bottom meets the canvas bottom', () => {
  const mmViewportH = 150;
  const metrics = { scrollTop: 900, viewportHeight: 100, contentHeight: 1000 };
  const r = thumbRect(metrics, 300, mmViewportH);
  assert.equal(r.mmScrollTop, 150); // 1 * (300 - 150)
  assert.equal(r.thumbHeight, 30);
  assert.equal(r.thumbTop + r.thumbHeight, mmViewportH); // flush to the bottom
});

test('thumbRect: a document shorter than the viewport → full-height thumb, no scroll', () => {
  const metrics = { scrollTop: 0, viewportHeight: 500, contentHeight: 200 };
  const r = thumbRect(metrics, 60, 150); // 20 lines * 3px
  assert.equal(r.mmScrollTop, 0);
  assert.equal(r.thumbTop, 0);
  assert.equal(r.thumbHeight, 60); // spans the whole (short) document
});

test('thumbRect: enforces a minimum thumb height on huge files', () => {
  const metrics = { scrollTop: 0, viewportHeight: 50, contentHeight: 1_000_000 };
  const r = thumbRect(metrics, 300, 150);
  assert.ok(r.thumbHeight >= 8, `thumb too small: ${r.thumbHeight}`);
});

test('clickToScrollFraction centers the clicked document position', () => {
  const metrics = { contentHeight: 1000, viewportHeight: 100 };
  // Click the middle of a 300px minimap (no minimap scroll) → doc fraction 0.5.
  const f = clickToScrollFraction(150, 0, 300, metrics);
  // Centering: targetTop = 0.5*1000 - 50 = 450; range = 900 → 0.5.
  assert.ok(Math.abs(f - 0.5) < 1e-9, `got ${f}`);
});

test('clickToScrollFraction clamps at the ends and when unscrollable', () => {
  const metrics = { contentHeight: 1000, viewportHeight: 100 };
  assert.equal(clickToScrollFraction(0, 0, 300, metrics), 0); // top
  assert.equal(clickToScrollFraction(300, 0, 300, metrics), 1); // bottom
  // Unscrollable (content fits): always 0.
  assert.equal(clickToScrollFraction(50, 0, 300, { contentHeight: 80, viewportHeight: 500 }), 0);
});

test('parseRgb parses rgb()/rgba(), rejects non-rgb', () => {
  assert.deepEqual(parseRgb('rgb(12, 34, 56)'), [12, 34, 56]);
  assert.deepEqual(parseRgb('rgba(1, 2, 3, 0.5)'), [1, 2, 3]);
  assert.deepEqual(parseRgb('rgb(255 128 0)'), [255, 128, 0]); // space-separated
  assert.equal(parseRgb('red'), null);
  assert.equal(parseRgb(''), null);
  assert.equal(parseRgb(null), null);
});

test('runToRect: leading whitespace becomes an x offset, trailing is ignored', () => {
  const r = runToRect({ text: '  foo  ', face: 'kw' }, 0, 1, 140, 4);
  assert.equal(r.x, 2); // 2 leading spaces
  assert.equal(r.w, 3); // "foo"
  assert.equal(r.nextCol, 7); // full text length advances the column
  assert.equal(r.draw, true);
});

test('runToRect: a tab counts as the tab width in columns', () => {
  const r = runToRect({ text: '\tx', face: null }, 0, 1, 140, 4);
  assert.equal(r.x, 4); // one tab = 4 columns
  assert.equal(r.w, 1); // "x"
  assert.equal(r.nextCol, 5);
});

test('runToRect: an all-whitespace run draws nothing but advances', () => {
  const r = runToRect({ text: '   ', face: null }, 5, 1, 140, 4);
  assert.equal(r.draw, false);
  assert.equal(r.w, 0);
  assert.equal(r.nextCol, 8);
});

test('runToRect: a long run is clamped at maxCols', () => {
  const r = runToRect({ text: 'x'.repeat(200), face: 's' }, 0, 1, 140, 4);
  assert.equal(r.x, 0);
  assert.equal(r.w, 140); // clamped to maxCols * charW
});

test('runToRect: chained runs preserve column alignment', () => {
  const a = runToRect({ text: 'const ', face: 'kw' }, 0, 1, 140, 4);
  const b = runToRect({ text: 'x', face: 'var' }, a.nextCol, 1, 140, 4);
  assert.equal(a.nextCol, 6);
  assert.equal(b.x, 6); // 'x' sits right after 'const '
  assert.equal(b.w, 1);
});

test('enclosingScope picks the innermost scope containing the line', () => {
  const scopes = [
    { startLine: 0, endLine: 100 }, // outer
    { startLine: 10, endLine: 40 }, // middle
    { startLine: 20, endLine: 30 }, // inner
  ];
  assert.deepEqual(enclosingScope(25, scopes), { startLine: 20, endLine: 30 });
  assert.deepEqual(enclosingScope(35, scopes), { startLine: 10, endLine: 40 });
  assert.deepEqual(enclosingScope(5, scopes), { startLine: 0, endLine: 100 });
});

test('enclosingScope is inclusive of the scope boundary lines', () => {
  const scopes = [{ startLine: 10, endLine: 20 }];
  assert.deepEqual(enclosingScope(10, scopes), { startLine: 10, endLine: 20 });
  assert.deepEqual(enclosingScope(20, scopes), { startLine: 10, endLine: 20 });
});

test('enclosingScope returns null when nothing contains the line', () => {
  const scopes = [{ startLine: 10, endLine: 20 }];
  assert.equal(enclosingScope(5, scopes), null);
  assert.equal(enclosingScope(25, scopes), null);
  assert.equal(enclosingScope(3, []), null);
  assert.equal(enclosingScope(3, null), null);
});
