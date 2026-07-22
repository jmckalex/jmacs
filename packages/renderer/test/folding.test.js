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
  foldsHidingLine,
  isStructuralCloseLine,
  enclosingFolds,
  stickyHeaderRows,
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

test('foldRanges drops a fold whose header line is blank (post-metadata section)', () => {
  // A `.jmd` top: a metadata block, a BLANK line, then a heading.
  // Lines: 0:'---' 1:'Title: x' 2:'---' 3:'' (blank) 4:'## H' 5:'body'
  const text = '---\nTitle: x\n---\n\n## H\nbody';
  const captures = [
    { start: 17, end: 26 }, // a section tree-sitter starts on the blank line 3 → dropped
    { start: 18, end: 26 }, // the real heading section on line 4 ('## H')   → kept
  ];
  assert.deepEqual(foldRanges(text, captures), [
    { startLine: 4, endLine: 5 },
  ]);
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

test('foldRanges carries the block flag through to the range', () => {
  const text = 'a\nb\nc\nd';
  const [range] = foldRanges(text, [{ start: 0, end: 6, block: true }]);
  assert.equal(range.startLine, 0);
  assert.equal(range.block, true);
});

test('indexFoldRanges records block folds in blockByStart', () => {
  const { blockByStart } = indexFoldRanges([
    { startLine: 0, endLine: 5, block: true },
    { startLine: 8, endLine: 9 }, // plain
  ]);
  assert.equal(blockByStart.has(0), true);
  assert.equal(blockByStart.has(8), false);
});

test('hiddenLines keeps a block fold\'s closing line visible (interior only)', () => {
  const endByStart = new Map([[1, 5]]);
  // Plain: 2,3,4,5 hidden. Block: only 2,3,4 — the @end line (5) stays shown.
  const block = hiddenLines([1], endByStart, new Set([1]));
  assert.deepEqual([...block].sort((a, b) => a - b), [2, 3, 4]);
});

test('foldsHidingLine: interior reveals the fold; header / past it do not', () => {
  const endByStart = new Map([[1, 5]]);
  assert.deepEqual(foldsHidingLine(3, [1], endByStart), [1]); // interior
  assert.deepEqual(foldsHidingLine(1, [1], endByStart), []); // on the header
  assert.deepEqual(foldsHidingLine(6, [1], endByStart), []); // past the fold
});

test('foldsHidingLine: a block fold\'s visible end line does not reveal it', () => {
  const endByStart = new Map([[1, 5]]);
  const block = new Set([1]);
  assert.deepEqual(foldsHidingLine(4, [1], endByStart, block), [1]); // interior
  assert.deepEqual(foldsHidingLine(5, [1], endByStart, block), []); // the @end line
});

test('foldsHidingLine: returns every nested fold whose interior holds the line', () => {
  // 0..20 outer, 2..8 inner; line 5 sits inside both.
  const endByStart = new Map([[0, 20], [2, 8]]);
  assert.deepEqual(
    foldsHidingLine(5, [0, 2], endByStart).sort((a, b) => a - b),
    [0, 2]
  );
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

test('enclosingFolds returns the nesting chain, outermost first', () => {
  // 0..20 outer, 2..18 middle, 5..9 inner. Line 7 sits inside all three.
  const endByStart = new Map([[0, 20], [2, 18], [5, 9]]);
  assert.deepEqual(enclosingFolds(7, endByStart), [
    { startLine: 0, endLine: 20 },
    { startLine: 2, endLine: 18 },
    { startLine: 5, endLine: 9 },
  ]);
});

test('enclosingFolds excludes a header from its own chain (strict start)', () => {
  const endByStart = new Map([[0, 20], [5, 9]]);
  // On the inner header line (5): only the outer scope encloses it; the
  // inner one starts here, so it is not yet pinned.
  assert.deepEqual(enclosingFolds(5, endByStart), [
    { startLine: 0, endLine: 20 },
  ]);
});

test('enclosingFolds includes a scope through its end line, not past it', () => {
  const endByStart = new Map([[2, 8]]);
  assert.deepEqual(enclosingFolds(8, endByStart), [{ startLine: 2, endLine: 8 }]);
  assert.deepEqual(enclosingFolds(9, endByStart), []);
});

test('enclosingFolds drops scopes that ended above the line', () => {
  // Two disjoint siblings; line 12 is inside the second only.
  const endByStart = new Map([[0, 5], [10, 15]]);
  assert.deepEqual(enclosingFolds(12, endByStart), [
    { startLine: 10, endLine: 15 },
  ]);
});

test('enclosingFolds at the top of the document has no ancestors', () => {
  const endByStart = new Map([[3, 9]]);
  assert.deepEqual(enclosingFolds(0, endByStart), []);
});

// --- stickyHeaderRows: slot-aware appearance + smooth slide -------------

test('stickyHeaderRows pins every scope while their content is on screen', () => {
  // lh=20. Scrolled to row 15. Three nested scopes, all ending well below.
  const scopes = [
    { startLine: 5, startRow: 5, endRow: 100 },
    { startLine: 8, startRow: 8, endRow: 30 },
    { startLine: 12, startRow: 12, endRow: 18 },
  ];
  assert.deepEqual(stickyHeaderRows(scopes, 15 * 20, 20), [
    { startLine: 5, y: 0 },
    { startLine: 8, y: 20 },
    { startLine: 12, y: 40 },
  ]);
});

test('stickyHeaderRows: a scope sticks the instant its header reaches the top', () => {
  // The bug this fixes: the header must not vanish behind the panel for a row
  // before re-appearing pinned. The outermost scope (slot 0) pins exactly when
  // its header reaches the very top — not a row later.
  const scopes = [{ startLine: 5, startRow: 5, endRow: 100 }];
  // A hair before: still a normal scrolling line, nothing pinned.
  assert.deepEqual(stickyHeaderRows(scopes, 4.99 * 20, 20), []);
  // The instant the header reaches the top: pinned at y=0, no gap.
  assert.deepEqual(stickyHeaderRows(scopes, 5 * 20, 20), [{ startLine: 5, y: 0 }]);
});

test('stickyHeaderRows: a nested scope sticks when its top meets the bottom of the stack', () => {
  // Ancestor pinned at slot 0; the child (slot 1) must stick the moment its
  // header reaches the bottom of the one header above it — i.e. one row before
  // its header would reach the geometric top.
  const scopes = [
    { startLine: 2, startRow: 2, endRow: 200 },
    { startLine: 10, startRow: 10, endRow: 50 },
  ];
  // A hair before slot 1: child not yet stuck, only the ancestor shows.
  assert.deepEqual(stickyHeaderRows(scopes, 8.99 * 20, 20), [{ startLine: 2, y: 0 }]);
  // At row 9 the child's header sits at slot 1 (one row below the top): stuck.
  assert.deepEqual(stickyHeaderRows(scopes, 9 * 20, 20), [
    { startLine: 2, y: 0 },
    { startLine: 10, y: 20 },
  ]);
});

test('stickyHeaderRows DROPS a scope whose content is fully behind the panel', () => {
  // At row 16 the innermost scope (ends row 18) has slid a full row behind its
  // ancestor, so it is dropped — the user is already looking past it.
  const scopes = [
    { startLine: 5, startRow: 5, endRow: 100 },
    { startLine: 8, startRow: 8, endRow: 30 },
    { startLine: 12, startRow: 12, endRow: 18 },
  ];
  assert.deepEqual(stickyHeaderRows(scopes, 16 * 20, 20), [
    { startLine: 5, y: 0 },
    { startLine: 8, y: 20 },
  ]);
});

test('stickyHeaderRows slides the deepest header up as its scope ends', () => {
  const scopes = [
    { startLine: 5, startRow: 5, endRow: 100 },
    { startLine: 8, startRow: 8, endRow: 30 },
    { startLine: 12, startRow: 12, endRow: 18 },
  ];
  // Half a row past row 15: the innermost (slot 2, y=40) slides up by 0.5lh.
  const rows = stickyHeaderRows(scopes, 15.5 * 20, 20);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].startLine, 12);
  assert.equal(rows[2].y, 30); // 40 - 0.5*20
});

test('stickyHeaderRows slide reaches the slot above just before the drop', () => {
  const scopes = [
    { startLine: 5, startRow: 5, endRow: 100 },
    { startLine: 8, startRow: 8, endRow: 30 },
    { startLine: 12, startRow: 12, endRow: 18 },
  ];
  // Almost a full row past 15: innermost has slid nearly to slot 1's y (20),
  // so when row 16 drops it the header above (line 8) takes its place with
  // no visible jump.
  const rows = stickyHeaderRows(scopes, 15.99 * 20, 20);
  assert.ok(rows[2].y > 20 && rows[2].y < 20.5, `expected ~20.2, got ${rows[2].y}`);
});

test('stickyHeaderRows: a vacated slot is reused by the next scope (sibling swap)', () => {
  // Under a common ancestor A (slot 0), inner sibling B ends and its successor
  // C opens. Once B has slid out of slot 1, C takes that slot — not slot 2.
  const scopes = [
    { startLine: 0, startRow: 0, endRow: 100 }, // ancestor, slot 0
    { startLine: 5, startRow: 5, endRow: 12 }, // inner sibling, ending
    { startLine: 13, startRow: 13, endRow: 40 }, // its successor
  ];
  // Row 12: B (ends row 12) is fully behind the panel and dropped; C's header
  // has descended to slot 1's row, so it pins there.
  assert.deepEqual(stickyHeaderRows(scopes, 12 * 20, 20), [
    { startLine: 0, y: 0 },
    { startLine: 13, y: 20 },
  ]);
});

test('stickyHeaderRows returns nothing with no scopes or a zero line height', () => {
  assert.deepEqual(stickyHeaderRows([], 100, 20), []);
  assert.deepEqual(
    stickyHeaderRows([{ startLine: 1, startRow: 1, endRow: 9 }], 40, 0),
    []
  );
});

test('an exclusive end at a line start does not fold that line (section tiling)', () => {
  // The tree-sitter markdown `section` node for `# one` ends exactly where
  // the next section begins — at column 0 of the `# two` line. Folding
  // section one must NOT swallow the `# two` heading line.
  // Lines: 0:'# one' 1:'text' 2:'' 3:'# two' 4:'more'
  const text = '# one\ntext\n\n# two\nmore';
  const sectionOne = { start: 0, end: text.indexOf('# two') };
  const sectionTwo = { start: text.indexOf('# two'), end: text.length };
  assert.deepEqual(foldRanges(text, [sectionOne, sectionTwo]), [
    { startLine: 0, endLine: 2 }, // through the blank line, not the heading
    { startLine: 3, endLine: 4 },
  ]);
});

test('back-to-back headings produce no fold for the empty section', () => {
  // `# one\n# two` — section one is just its own heading line; there is
  // nothing under it to fold.
  const text = '# one\n# two\nbody';
  const captures = [
    { start: 0, end: 6 },            // section one: exactly the first line
    { start: 6, end: text.length },  // section two: heading + body
  ];
  assert.deepEqual(foldRanges(text, captures), [
    { startLine: 1, endLine: 2 },
  ]);
});

test('an end past a line start (even by one char) still folds that line', () => {
  // A capture whose end is mid-line keeps the old behaviour — the end line
  // is included.
  const text = 'a {\nb\n}\nafter';
  const captures = [{ start: 2, end: 7 }]; // '{' through '}' (mid line 2)
  assert.deepEqual(foldRanges(text, captures), [
    { startLine: 0, endLine: 2 },
  ]);
});
