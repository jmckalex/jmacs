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
  leadingIndentCols,
  compressIndent,
  charCoverage,
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

test('leadingIndentCols: counts leading whitespace, tabs as tab width', () => {
  assert.equal(leadingIndentCols([{ text: '  foo', face: null }], 4), 2);
  assert.equal(leadingIndentCols([{ text: '\tx', face: null }], 4), 4);
  assert.equal(leadingIndentCols([{ text: '\t  x', face: null }], 4), 6); // tab + 2 spaces
  assert.equal(leadingIndentCols([{ text: 'x', face: null }], 4), 0); // no indent
});

test('leadingIndentCols: spans runs and handles an all-whitespace line', () => {
  // Indent split across runs: a whitespace run then a content run.
  assert.equal(
    leadingIndentCols([{ text: '   ', face: null }, { text: 'foo', face: 'kw' }], 4),
    3
  );
  assert.equal(leadingIndentCols([{ text: '    ', face: null }], 4), 4); // all blank
});

test('compressIndent: monotonic, capped, and zero stays zero', () => {
  assert.equal(compressIndent(0, 0.4, 14), 0);
  assert.equal(compressIndent(10, 0.4, 14), 4); // 10 * 0.4
  assert.equal(compressIndent(20, 0.4, 14), 8);
  assert.equal(compressIndent(40, 0.4, 14), 14); // capped
  // Monotonic: deeper indent never compresses to less.
  assert.ok(compressIndent(8, 0.4, 14) < compressIndent(16, 0.4, 14));
});

test('charCoverage: whitespace 0, sparse low, dense high', () => {
  assert.equal(charCoverage(' '), 0);
  assert.equal(charCoverage('\t'), 0);
  assert.equal(charCoverage(''), 0);
  assert.equal(charCoverage('M'), 1); // dense
  assert.equal(charCoverage('@'), 1);
  assert.equal(charCoverage('A'), 0.85); // uppercase / digit
  assert.equal(charCoverage('7'), 0.85);
  assert.equal(charCoverage('.'), 0.3); // sparse punctuation
  assert.equal(charCoverage('i'), 0.45); // thin glyph
  assert.equal(charCoverage('a'), 0.65); // ordinary lowercase
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
