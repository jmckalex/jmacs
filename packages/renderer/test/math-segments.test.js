/**
 * @file Unit tests for the pure math-segment scanner and the reveal
 * predicate. No DOM, no tree-sitter — the delimiter scanner is the
 * production fallback and the testable heart of Phase 1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scanMathSegments,
  segmentsFromNodeRanges,
  pointInsideSegment,
  segmentContainingPoint,
  isEmptyBody,
} from '../src/math-segments.js';

test('scans a single inline $…$ segment', () => {
  const text = 'a $x+1$ b';
  assert.deepEqual(scanMathSegments(text), [
    { start: 2, end: 7, kind: 'inline', body: 'x+1' },
  ]);
});

test('scans \\(…\\) inline math', () => {
  const text = 'see \\(a^2\\) here';
  assert.deepEqual(scanMathSegments(text), [
    { start: 4, end: 11, kind: 'inline', body: 'a^2' },
  ]);
});

test('scans $$…$$ display math as block', () => {
  const text = 'x $$E=mc^2$$ y';
  assert.deepEqual(scanMathSegments(text), [
    { start: 2, end: 12, kind: 'block', body: 'E=mc^2' },
  ]);
});

test('scans \\[…\\] display math as block', () => {
  const text = 'before \\[\\int_0^1 f\\] after';
  assert.deepEqual(scanMathSegments(text), [
    { start: 7, end: 21, kind: 'block', body: '\\int_0^1 f' },
  ]);
});

test('$$ takes precedence over $ at the same position', () => {
  // The opener is `$$`, so this is one display segment, not two empty
  // inline ones.
  const text = '$$a$$';
  assert.deepEqual(scanMathSegments(text), [
    { start: 0, end: 5, kind: 'block', body: 'a' },
  ]);
});

test('multiple segments in one line, in document order', () => {
  const text = '$a$ and $$b$$ and \\(c\\)';
  assert.deepEqual(scanMathSegments(text), [
    { start: 0, end: 3, kind: 'inline', body: 'a' },
    { start: 8, end: 13, kind: 'block', body: 'b' },
    { start: 18, end: 23, kind: 'inline', body: 'c' },
  ]);
});

test('multi-line display math: $$ spanning newlines', () => {
  const text = '$$\n\\sum_{i=0}^n i\n= \\frac{n(n+1)}{2}\n$$';
  const segs = scanMathSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'block');
  assert.equal(segs[0].start, 0);
  assert.equal(segs[0].end, text.length);
  assert.equal(segs[0].body, '\n\\sum_{i=0}^n i\n= \\frac{n(n+1)}{2}\n');
});

test('multi-line display math: \\[ … \\] spanning newlines', () => {
  const text = 'text\n\\[\n  a + b\n\\]\nmore';
  const segs = scanMathSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'block');
  assert.equal(segs[0].body, '\n  a + b\n');
});

test('escaped \\$ is not a math delimiter', () => {
  const text = 'price is \\$5 and \\$6';
  assert.deepEqual(scanMathSegments(text), []);
});

test('escaped \\$ before a real $…$ segment', () => {
  const text = '\\$10 then $y=2$';
  assert.deepEqual(scanMathSegments(text), [
    { start: 10, end: 15, kind: 'inline', body: 'y=2' },
  ]);
});

test('double backslash does not escape the following $', () => {
  // `\\` is a literal backslash pair; the `$` after it is live.
  const text = 'a\\\\$z$';
  assert.deepEqual(scanMathSegments(text), [
    { start: 3, end: 6, kind: 'inline', body: 'z' },
  ]);
});

test('empty inline body $$ … wait, empty $ $', () => {
  const text = '$$';
  // `$$` with nothing between is an *empty display* opener with no
  // close → no complete segment. (It is a half-typed `$$|$$`.)
  assert.deepEqual(scanMathSegments(text), []);
});

test('empty inline body $ $ produces an empty-body segment', () => {
  const text = 'a $ $ b';
  assert.deepEqual(scanMathSegments(text), [
    { start: 2, end: 5, kind: 'inline', body: ' ' },
  ]);
});

test('empty display body $$$$ is one empty block segment', () => {
  const text = '$$$$';
  assert.deepEqual(scanMathSegments(text), [
    { start: 0, end: 4, kind: 'block', body: '' },
  ]);
});

test('unterminated $ opener is not reported (half-typed math)', () => {
  const text = 'a $x+1 and more text';
  assert.deepEqual(scanMathSegments(text), []);
});

test('unterminated \\[ opener is not reported', () => {
  const text = 'a \\[ x + y with no close';
  assert.deepEqual(scanMathSegments(text), []);
});

test('% line comments are skipped — $ inside a comment is not math', () => {
  const text = '% this $is not$ math\nreal $z$ here';
  assert.deepEqual(scanMathSegments(text), [
    { start: 26, end: 29, kind: 'inline', body: 'z' },
  ]);
});

test('escaped \\% is not a comment start', () => {
  const text = '50\\% off $q$';
  assert.deepEqual(scanMathSegments(text), [
    { start: 9, end: 12, kind: 'inline', body: 'q' },
  ]);
});

test('empty input returns no segments', () => {
  assert.deepEqual(scanMathSegments(''), []);
  assert.deepEqual(scanMathSegments(undefined), []);
});

test('a backslash-escaped close inside \\[…\\] is honoured', () => {
  // `\]` closes; a literal `]` does not.
  const text = '\\[ a[1] = b \\]';
  const segs = scanMathSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].body, ' a[1] = b ');
});

// --- segmentsFromNodeRanges (tree-sitter adapter) ----------------------

test('segmentsFromNodeRanges strips delimiters by inferred width', () => {
  const text = 'a $x$ b $$y$$ c \\(z\\) \\[w\\]';
  const nodes = [
    { start: 2, end: 5, type: 'inline_formula' },
    { start: 8, end: 13, type: 'displayed_equation' },
    { start: 16, end: 21, type: 'inline_formula' },
    { start: 22, end: 27, type: 'displayed_equation' },
  ];
  assert.deepEqual(segmentsFromNodeRanges(text, nodes), [
    { start: 2, end: 5, kind: 'inline', body: 'x' },
    { start: 8, end: 13, kind: 'block', body: 'y' },
    { start: 16, end: 21, kind: 'inline', body: 'z' },
    { start: 22, end: 27, kind: 'block', body: 'w' },
  ]);
});

test('segmentsFromNodeRanges sorts by start', () => {
  const text = '$$y$$ $x$';
  const nodes = [
    { start: 6, end: 9, type: 'inline_formula' },
    { start: 0, end: 5, type: 'displayed_equation' },
  ];
  const segs = segmentsFromNodeRanges(text, nodes);
  assert.deepEqual(segs.map((s) => s.start), [0, 6]);
});

test('segmentsFromNodeRanges skips nodes with no recognised delimiter', () => {
  const text = 'plain text here';
  const nodes = [{ start: 0, end: 5, type: 'inline_formula' }];
  assert.deepEqual(segmentsFromNodeRanges(text, nodes), []);
});

test('segmentsFromNodeRanges on empty / non-array input', () => {
  assert.deepEqual(segmentsFromNodeRanges('x', []), []);
  assert.deepEqual(segmentsFromNodeRanges('x', null), []);
});

// --- reveal predicate (exclusive at both ends) -------------------------

test('pointInsideSegment is exclusive at both ends', () => {
  const seg = { start: 2, end: 7, kind: 'inline', body: 'x+1' };
  // At the opening delimiter (start) → NOT inside → widget shown.
  assert.equal(pointInsideSegment(seg, 2), false);
  // One step inward → inside → source revealed.
  assert.equal(pointInsideSegment(seg, 3), true);
  // Last interior offset → inside.
  assert.equal(pointInsideSegment(seg, 6), true);
  // At the closing edge (end) → NOT inside → widget shown.
  assert.equal(pointInsideSegment(seg, 7), false);
  // Well outside.
  assert.equal(pointInsideSegment(seg, 0), false);
  assert.equal(pointInsideSegment(seg, 100), false);
});

test('segmentContainingPoint finds the one segment point is inside', () => {
  const segs = [
    { start: 0, end: 3, kind: 'inline', body: 'a' },
    { start: 8, end: 13, kind: 'block', body: 'b' },
  ];
  assert.equal(segmentContainingPoint(segs, 1), segs[0]);
  assert.equal(segmentContainingPoint(segs, 10), segs[1]);
  // Between segments → null.
  assert.equal(segmentContainingPoint(segs, 5), null);
  // On a boundary → null (exclusive).
  assert.equal(segmentContainingPoint(segs, 0), null);
  assert.equal(segmentContainingPoint(segs, 3), null);
});

// --- empty-body predicate ----------------------------------------------

test('isEmptyBody treats empty and whitespace-only as invalid', () => {
  assert.equal(isEmptyBody(''), true);
  assert.equal(isEmptyBody('   '), true);
  assert.equal(isEmptyBody('\n\t '), true);
  assert.equal(isEmptyBody('x'), false);
  assert.equal(isEmptyBody(' x '), false);
  assert.equal(isEmptyBody(undefined), true);
});
