/**
 * @file Unit tests for the pure fold-range extractor.
 *
 * Like the injection tests in `treesitter-injection.test.js`, these
 * exercise the algorithm with hand-built capture lists — no grammars
 * loaded. The end-to-end ("real grammar produces a real fold") path
 * lives in the desktop smoke test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  foldRanges,
  indexFoldRanges,
  hiddenLines,
  isStructuralCloseLine,
} from '../src/folding.js';

test('foldRanges returns line spans for multi-line captures', () => {
  // Lines:        0:abc 1:def 2:ghi 3:jkl
  const text = 'abc\ndef\nghi\njkl';
  // A capture from line 1, col 0 through line 3, col 3 (end inclusive
  // of "l"). startLine=1, endLine=3.
  const captures = [{ start: 4, end: 15 }];
  assert.deepEqual(foldRanges(text, captures), [
    { startLine: 1, endLine: 3 },
  ]);
});

test('single-line captures are dropped — nothing to fold there', () => {
  const text = 'one\ntwo\nthree';
  const captures = [
    { start: 0, end: 3 }, // 'one' — all on line 0
    { start: 4, end: 7 }, // 'two' — all on line 1
  ];
  assert.deepEqual(foldRanges(text, captures), []);
});

test('foldRanges sorts the ranges by startLine', () => {
  const text = 'a\nb\nc\nd\ne\nf\n';
  // Two captures out of order.
  const captures = [
    { start: 4, end: 11 }, // lines 2..5
    { start: 0, end: 7 },  // lines 0..3
  ];
  assert.deepEqual(foldRanges(text, captures), [
    { startLine: 0, endLine: 3 },
    { startLine: 2, endLine: 5 },
  ]);
});

test('captures with the same startLine keep the longest one', () => {
  const text = 'a\nb\nc\nd\ne\n';
  const captures = [
    { start: 0, end: 3 }, // lines 0..1
    { start: 0, end: 7 }, // lines 0..3 (longer)
    { start: 0, end: 5 }, // lines 0..2
  ];
  assert.deepEqual(foldRanges(text, captures), [
    { startLine: 0, endLine: 3 },
  ]);
});

test('captures extending past the buffer end are clamped to the last line', () => {
  const text = 'a\nb\nc';
  const captures = [{ start: 0, end: 1000 }];
  assert.deepEqual(foldRanges(text, captures), [
    { startLine: 0, endLine: 2 },
  ]);
});

test('foldRanges on no captures returns an empty list', () => {
  assert.deepEqual(foldRanges('abc\ndef', []), []);
});

test('indexFoldRanges separates headers from end lookups', () => {
  const ranges = [
    { startLine: 0, endLine: 5 },
    { startLine: 2, endLine: 3 },
  ];
  const { headers, endByStart } = indexFoldRanges(ranges);
  assert.deepEqual([...headers].sort((a, b) => a - b), [0, 2]);
  assert.equal(endByStart.get(0), 5);
  assert.equal(endByStart.get(2), 3);
});

test('foldRanges turns inner delimiter offsets into header/close cut columns', () => {
  // `<p>This is text\nmore</p>` — an inner (`@fold.inner`) fold. The
  // opening `<p>` ends at offset 3 (col 3 on line 0); the closing `</p>`
  // begins at offset 20 (col 4 on line 1, `more</p>`).
  const text = '<p>This is text\nmore</p>';
  const captures = [{ start: 0, end: 24, innerStart: 3, innerEnd: 20 }];
  assert.deepEqual(foldRanges(text, captures), [
    { startLine: 0, endLine: 1, headerCol: 3, closeCol: 4 },
  ]);
});

test('foldRanges leaves a plain (line-based) capture without cut columns', () => {
  const text = '<p>This is text\nmore</p>';
  const captures = [{ start: 0, end: 24 }]; // no innerStart/innerEnd
  assert.deepEqual(foldRanges(text, captures), [
    { startLine: 0, endLine: 1 },
  ]);
});

test('indexFoldRanges exposes cut columns only for inner folds', () => {
  const ranges = [
    { startLine: 0, endLine: 5, headerCol: 3, closeCol: 4 }, // inner
    { startLine: 2, endLine: 3 }, // line-based
  ];
  const { cutByStart } = indexFoldRanges(ranges);
  assert.deepEqual(cutByStart.get(0), { headerCol: 3, closeCol: 4 });
  assert.equal(cutByStart.has(2), false);
});

test('indexFoldRanges computes nesting depth per range start', () => {
  // 0..20 outer; 2..8 and 10..18 are siblings inside it; 12..15 nests
  // inside the second sibling; 30..32 is disjoint (back to depth 0).
  // (Pre-sorted by startLine, as foldRanges guarantees.)
  const ranges = [
    { startLine: 0, endLine: 20 },
    { startLine: 2, endLine: 8 },
    { startLine: 10, endLine: 18 },
    { startLine: 12, endLine: 15 },
    { startLine: 30, endLine: 32 },
  ];
  const { depthByStart } = indexFoldRanges(ranges);
  assert.equal(depthByStart.get(0), 0); // outermost
  assert.equal(depthByStart.get(2), 1); // inside 0
  assert.equal(depthByStart.get(10), 1); // sibling of 2, still inside 0
  assert.equal(depthByStart.get(12), 2); // inside 0 and 10
  assert.equal(depthByStart.get(30), 0); // disjoint — 0's range closed at 20
});

test('hiddenLines includes every line strictly between a folded header and its end', () => {
  const endByStart = new Map([
    [1, 5],
  ]);
  const hidden = hiddenLines([1], endByStart);
  // Lines 2, 3, 4, 5 — header (1) stays visible.
  assert.deepEqual([...hidden].sort((a, b) => a - b), [2, 3, 4, 5]);
});

test('hiddenLines ignores folded entries that are not known headers', () => {
  // The user folded line 1, then the buffer edited and line 1 no
  // longer names a fold. The view drops stale entries; the pure
  // function only looks up the ones it has.
  const endByStart = new Map([[3, 7]]);
  const hidden = hiddenLines([1, 3], endByStart);
  assert.deepEqual([...hidden].sort((a, b) => a - b), [4, 5, 6, 7]);
});

test('nested folds: the inner range is already in the outer fold', () => {
  const endByStart = new Map([
    [0, 10], // outer
    [3, 6],  // inner
  ]);
  const hidden = hiddenLines([0, 3], endByStart);
  // Lines 1..10 are hidden. 3 is part of the inner fold's header but
  // it is also hidden by the outer fold; that's fine.
  assert.deepEqual(
    [...hidden].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
});

test('hiddenLines with no folded entries returns an empty set', () => {
  const endByStart = new Map([[0, 5]]);
  assert.deepEqual([...hiddenLines([], endByStart)], []);
});

test('isStructuralCloseLine: bare closing delimiters preview, content lines do not', () => {
  // Structural closes — previewable after the `…`.
  assert.equal(isStructuralCloseLine('</head>'), true);
  assert.equal(isStructuralCloseLine('  </script>'), true); // leading indent
  assert.equal(isStructuralCloseLine('</p>'), true);
  assert.equal(isStructuralCloseLine('}'), true);
  assert.equal(isStructuralCloseLine('});'), true);
  assert.equal(isStructuralCloseLine(')'), true);
  assert.equal(isStructuralCloseLine('end'), true); // short keyword close
  // The bug case: a content line that merely ends with `</p>` must NOT
  // preview — that re-shows the whole line and hides nothing.
  assert.equal(
    isStructuralCloseLine('And some <span class="math">x</span> as well.</p>'),
    false
  );
  assert.equal(isStructuralCloseLine('   <p>opening, not a close'), false);
  assert.equal(isStructuralCloseLine(''), false);
  assert.equal(isStructuralCloseLine('   '), false);
});

test('foldRanges handles a CRLF-free buffer with trailing newline', () => {
  const text = 'a\n{\nb\nc\n}\n';
  // Capture {…} on lines 1..4 (the brace block).
  const captures = [{ start: 2, end: 9 }];
  assert.deepEqual(foldRanges(text, captures), [
    { startLine: 1, endLine: 4 },
  ]);
});

// --- smoke: a 3-line function folds to one visible line ----------------
// "A .js buffer with a 3-line function, press C-c TAB, assert one
// fewer line visible." The renderer's pure pipeline shrinks the
// visible count by exactly (endLine - startLine) when the fold's
// header is added to the folded set — here, 2 lines for a 3-line
// function (header + body + closing brace folds away into the header).

test('smoke: folding a 3-line function hides 2 lines (header stays)', () => {
  // The JS source: 4 lines (0..3). The function `f()` declaration
  // and body. The `statement_block` node covers `{\n  return 1;\n}`
  // — start on line 0 col 11 (just after `f() `), end on line 2 col 1.
  // (Approximate; the exact offsets are what a real tree-sitter would
  // produce — we use what the algorithm requires.)
  const text = 'function f() {\n  return 1;\n}\n';
  // Lines: 0: `function f() {`  1: `  return 1;`  2: `}`  3: ``
  // The statement_block capture would be [13, 28) — from `{` on
  // line 0 through `}` on line 2.
  const blockCapture = { start: 13, end: 28 };
  const ranges = foldRanges(text, [blockCapture]);
  assert.deepEqual(ranges, [{ startLine: 0, endLine: 2 }]);

  const { headers, endByStart } = indexFoldRanges(ranges);
  assert.ok(headers.has(0));

  // Before folding: 4 buffer lines, 4 visible. After folding line 0:
  // lines 1 and 2 hide; the header (0) and the trailing blank (3)
  // remain — 2 visible. That's "one fewer line visible" per fold step
  // by two (the brief's phrasing is the user-visible effect: hitting
  // the key collapses something).
  const hiddenBefore = hiddenLines([], endByStart);
  assert.equal(hiddenBefore.size, 0);

  const hiddenAfter = hiddenLines([0], endByStart);
  assert.equal(hiddenAfter.size, 2); // lines 1 and 2 collapsed
  assert.ok(hiddenAfter.has(1));
  assert.ok(hiddenAfter.has(2));
  assert.ok(!hiddenAfter.has(0)); // header stays
});
