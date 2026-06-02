/**
 * @file Tests for giving an exported gnuplot SVG an intrinsic size, so
 * standalone viewers (Gapplin etc.) can zoom/fit it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { svgWithIntrinsicSize } from '../src/gnuplot-svg.js';

test('adds width/height from the viewBox when absent (the gnuplot dynamic case)', () => {
  const svg = '<svg \n viewBox="0 0 720 480"\n xmlns="http://www.w3.org/2000/svg">x</svg>';
  const out = svgWithIntrinsicSize(svg);
  assert.match(out, /<svg width="720" height="480"/);
  assert.match(out, /viewBox="0 0 720 480"/); // viewBox preserved
  assert.ok(out.includes('</svg>'));
});

test('is a no-op when width/height already present', () => {
  const svg = '<svg width="100" height="50" viewBox="0 0 100 50">x</svg>';
  assert.equal(svgWithIntrinsicSize(svg), svg);
});

test('is a no-op when there is no viewBox', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg">y</svg>';
  assert.equal(svgWithIntrinsicSize(svg), svg);
});

test('handles fractional viewBox dimensions', () => {
  const svg = '<svg viewBox="0 0 100.5 50.25">z</svg>';
  assert.match(svgWithIntrinsicSize(svg), /width="100.5" height="50.25"/);
});

test('tolerates non-string input', () => {
  assert.equal(svgWithIntrinsicSize(null), null);
});
