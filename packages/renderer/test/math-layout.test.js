/**
 * @file Unit tests for the pure replaced-range widget layout math.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeMathLayout,
  rangeRevealedByAnyCursor,
  spliceInlineWidgets,
} from '../src/math-layout.js';

/** Build lineStarts / lineLengths from a text, the way the view does. */
function lineModel(text) {
  const lines = text.split('\n');
  const lineStarts = [];
  const lineLengths = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    lineLengths.push(line.length);
    offset += line.length + 1; // + newline
  }
  return { lineStarts, lineLengths };
}

test('rangeRevealedByAnyCursor: exclusive, any cursor reveals', () => {
  const r = { start: 2, end: 7, kind: 'inline' };
  assert.equal(rangeRevealedByAnyCursor(r, [0]), false);
  assert.equal(rangeRevealedByAnyCursor(r, [2]), false); // boundary
  assert.equal(rangeRevealedByAnyCursor(r, [7]), false); // boundary
  assert.equal(rangeRevealedByAnyCursor(r, [4]), true);
  assert.equal(rangeRevealedByAnyCursor(r, [0, 100, 5]), true); // any inside
  assert.equal(rangeRevealedByAnyCursor(r, []), false);
});

test('inline range produces a single inline placement on its line', () => {
  const text = 'a $x+1$ b';
  const { lineStarts, lineLengths } = lineModel(text);
  const range = { start: 2, end: 7, kind: 'inline', el: 'WIDGET' };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts,
    lineLengths,
    points: [0],
  });
  assert.equal(layout.hiddenByBlock.size, 0);
  assert.equal(layout.blockByStartLine.size, 0);
  const placements = layout.inlineByLine.get(0);
  assert.equal(placements.length, 1);
  assert.equal(placements[0].fromColumn, 2);
  assert.equal(placements[0].toColumn, 7);
  assert.equal(placements[0].range, range);
});

test('a cursor inside an inline range suppresses it (reveal)', () => {
  const text = 'a $x+1$ b';
  const { lineStarts, lineLengths } = lineModel(text);
  const range = { start: 2, end: 7, kind: 'inline' };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts,
    lineLengths,
    points: [4], // strictly inside
  });
  assert.equal(layout.inlineByLine.size, 0);
  assert.deepEqual(layout.revealed, [range]);
});

test('a cursor at the boundary keeps the widget (exclusive reveal)', () => {
  const text = 'a $x+1$ b';
  const { lineStarts, lineLengths } = lineModel(text);
  const range = { start: 2, end: 7, kind: 'inline' };
  for (const point of [2, 7]) {
    const layout = computeMathLayout({
      ranges: [range],
      lineStarts,
      lineLengths,
      points: [point],
    });
    assert.equal(layout.inlineByLine.get(0).length, 1, `point ${point}`);
    assert.equal(layout.revealed.length, 0, `point ${point}`);
  }
});

test('two inline ranges on one line come out in ascending column order', () => {
  const text = '$a$ x $b$';
  const { lineStarts, lineLengths } = lineModel(text);
  const r1 = { start: 0, end: 3, kind: 'inline' };
  const r2 = { start: 6, end: 9, kind: 'inline' };
  const layout = computeMathLayout({
    ranges: [r2, r1], // out of order on input
    lineStarts,
    lineLengths,
    points: [],
  });
  const placements = layout.inlineByLine.get(0);
  assert.deepEqual(placements.map((p) => p.fromColumn), [0, 6]);
});

test('block range hides the spanned lines except the start line', () => {
  // Lines: 0:"text"  1:"$$"  2:"a+b"  3:"$$"  4:"more"
  const text = 'text\n$$\na+b\n$$\nmore';
  const { lineStarts, lineLengths } = lineModel(text);
  // $$ block from line 1 col 0 through line 3 col 2 (after the closing $$).
  const start = lineStarts[1];
  const end = lineStarts[3] + 2;
  const range = { start, end, kind: 'block', el: 'BLOCK' };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts,
    lineLengths,
    points: [0],
  });
  // Lines 2 and 3 hidden; line 1 (start) stays visible with the widget.
  assert.deepEqual([...layout.hiddenByBlock].sort((a, b) => a - b), [2, 3]);
  const block = layout.blockByStartLine.get(1);
  assert.equal(block.range, range);
  assert.equal(block.startColumn, 0); // $$ at column 0 of line 1
  assert.equal(block.rowSpan, 3); // spans source lines 1..3 → reserve 3 rows
});

test('block range with a cursor inside is revealed — nothing hidden', () => {
  const text = 'text\n$$\na+b\n$$\nmore';
  const { lineStarts, lineLengths } = lineModel(text);
  const start = lineStarts[1];
  const end = lineStarts[3] + 2;
  const range = { start, end, kind: 'block' };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts,
    lineLengths,
    points: [lineStarts[2] + 1], // inside the body, on line 2
  });
  assert.equal(layout.hiddenByBlock.size, 0);
  assert.equal(layout.blockByStartLine.size, 0);
  assert.deepEqual(layout.revealed, [range]);
});

test('block revealed when a cursor is on its closing line (not strictly inside)', () => {
  // Arrowing onto the closing $$ line lands point at the segment's
  // exclusive `end` — offset-wise *not* inside, but still on a line the
  // block spans. It must reveal (show source) so the cursor isn't
  // stranded on a line the widget would hide.
  const text = 'text\n$$\na+b\n$$\nmore';
  const { lineStarts, lineLengths } = lineModel(text);
  const start = lineStarts[1];
  const end = lineStarts[3] + 2; // just past the closing $$, on line 3
  const range = { start, end, kind: 'block' };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts,
    lineLengths,
    points: [end],
  });
  assert.equal(layout.hiddenByBlock.size, 0);
  assert.equal(layout.blockByStartLine.size, 0);
  assert.deepEqual(layout.revealed, [range]);
});

test('block collapses when the cursor is on the line after it', () => {
  const text = 'text\n$$\na+b\n$$\nmore';
  const { lineStarts, lineLengths } = lineModel(text);
  const range = { start: lineStarts[1], end: lineStarts[3] + 2, kind: 'block' };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts,
    lineLengths,
    points: [lineStarts[4]], // line 4 ('more'), past the block
  });
  assert.deepEqual([...layout.hiddenByBlock].sort((a, b) => a - b), [2, 3]);
  assert.ok(layout.blockByStartLine.has(1));
  assert.equal(layout.revealed.length, 0);
});

test('single-line block range hides nothing extra but still emits a block widget', () => {
  const text = 'x $$y$$ z';
  const { lineStarts, lineLengths } = lineModel(text);
  const range = { start: 2, end: 7, kind: 'block' };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts,
    lineLengths,
    points: [],
  });
  assert.equal(layout.hiddenByBlock.size, 0);
  const block = layout.blockByStartLine.get(0);
  assert.equal(block.range, range);
  assert.equal(block.startColumn, 2); // $$ at column 2 of "x $$y$$ z"
  assert.equal(block.rowSpan, 1); // single source line → reserve 1 row
});

test('block range clamps a past-the-end span to the last line', () => {
  const text = 'a\n$$\nb';
  const { lineStarts, lineLengths } = lineModel(text);
  const range = { start: lineStarts[1], end: 9999, kind: 'block' };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts,
    lineLengths,
    points: [],
  });
  // Lines 2 (the last) hidden; line 1 keeps the widget.
  assert.deepEqual([...layout.hiddenByBlock].sort((a, b) => a - b), [2]);
});

test('empty input is a no-op layout', () => {
  const { lineStarts, lineLengths } = lineModel('abc');
  const layout = computeMathLayout({ ranges: [], lineStarts, lineLengths, points: [] });
  assert.equal(layout.hiddenByBlock.size, 0);
  assert.equal(layout.inlineByLine.size, 0);
  assert.equal(layout.blockByStartLine.size, 0);
});

// --- spliceInlineWidgets ------------------------------------------------

test('spliceInlineWidgets replaces the covered span with a widget marker', () => {
  // Line "a $x+1$ b" — a single faceless run.
  const runs = [{ text: 'a $x+1$ b', face: null }];
  const range = { fromColumn: 2, toColumn: 7, el: 'W' };
  const placements = [
    { fromColumn: 2, toColumn: 7, range },
  ];
  const out = spliceInlineWidgets(runs, placements);
  assert.deepEqual(out, [
    { text: 'a ', face: null },
    { widget: range },
    { text: ' b', face: null },
  ]);
});

test('spliceInlineWidgets preserves surrounding face runs', () => {
  // "kw $m$ id" with faces on the words.
  const runs = [
    { text: 'kw', face: 'keyword' },
    { text: ' $m$ ', face: null },
    { text: 'id', face: 'ident' },
  ];
  // $m$ spans columns 3..6.
  const range = { el: 'M' };
  const placements = [{ fromColumn: 3, toColumn: 6, range }];
  const out = spliceInlineWidgets(runs, placements);
  assert.deepEqual(out, [
    { text: 'kw', face: 'keyword' },
    { text: ' ', face: null },
    { widget: range },
    { text: ' ', face: null },
    { text: 'id', face: 'ident' },
  ]);
});

test('spliceInlineWidgets handles two widgets on one line', () => {
  const runs = [{ text: '$a$ x $b$', face: null }];
  const rangeA = { el: 'A' };
  const rangeB = { el: 'B' };
  const placements = [
    { fromColumn: 0, toColumn: 3, range: rangeA },
    { fromColumn: 6, toColumn: 9, range: rangeB },
  ];
  const out = spliceInlineWidgets(runs, placements);
  assert.deepEqual(out, [
    { widget: rangeA },
    { text: ' x ', face: null },
    { widget: rangeB },
  ]);
});

test('spliceInlineWidgets with no placements returns the runs unchanged', () => {
  const runs = [{ text: 'abc', face: null }];
  const out = spliceInlineWidgets(runs, []);
  assert.deepEqual(out, runs);
  assert.notEqual(out, runs); // a copy
});

test('spliceInlineWidgets clamps a placement past the line end', () => {
  const runs = [{ text: 'a $x$', face: null }];
  const range = { el: 'X' };
  const placements = [{ fromColumn: 2, toColumn: 99, range }];
  const out = spliceInlineWidgets(runs, placements);
  assert.deepEqual(out, [
    { text: 'a ', face: null },
    { widget: range },
  ]);
});

// --- line-wrapped inline math (a $…$ spanning a line break) --------------

test('a multi-line inline range places the widget on its start line', () => {
  // Text: 'pre $a +\nb$ post' — lines: 'pre $a +' (8), 'b$ post' (7).
  const range = { start: 4, end: 11, kind: 'inline', el: () => null };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts: [0, 9],
    lineLengths: [8, 7],
    points: [],
  });
  const first = layout.inlineByLine.get(0);
  assert.equal(first.length, 1);
  assert.equal(first[0].fromColumn, 4);
  assert.equal(first[0].toColumn, 8, 'start-line placement runs to end of line');
  assert.ok(!first[0].continuation, 'the start line mounts the widget');
  const second = layout.inlineByLine.get(1);
  assert.equal(second.length, 1);
  assert.equal(second[0].fromColumn, 0);
  assert.equal(second[0].toColumn, 2, 'end-line placement stops at the closing $');
  assert.equal(second[0].continuation, true);
  // Nothing hidden, nothing block.
  assert.equal(layout.hiddenByBlock.size, 0);
  assert.equal(layout.blockByStartLine.size, 0);
});

test('middle lines of a wrapped inline formula are continuation placements', () => {
  // Lines: '$a' (2), 'b' (1), 'c$ tail' (7); range covers offsets 0..6.
  const range = { start: 0, end: 7, kind: 'inline', el: () => null };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts: [0, 3, 5],
    lineLengths: [2, 1, 7],
    points: [],
  });
  assert.ok(!layout.inlineByLine.get(0)[0].continuation);
  assert.equal(layout.inlineByLine.get(1)[0].continuation, true);
  assert.equal(layout.inlineByLine.get(1)[0].toColumn, 1);
  assert.equal(layout.inlineByLine.get(2)[0].continuation, true);
  assert.equal(layout.inlineByLine.get(2)[0].toColumn, 2);
});

test('a cursor inside a wrapped inline formula reveals it whole', () => {
  const range = { start: 4, end: 11, kind: 'inline', el: () => null };
  const layout = computeMathLayout({
    ranges: [range],
    lineStarts: [0, 9],
    lineLengths: [8, 7],
    points: [6],
  });
  assert.equal(layout.inlineByLine.size, 0);
  assert.deepEqual(layout.revealed, [range]);
});

test('spliceInlineWidgets: a continuation placement removes text, mounts nothing', () => {
  const runs = [{ text: 'b$ post', face: null }];
  const out = spliceInlineWidgets(runs, [
    { fromColumn: 0, toColumn: 2, range: { el: () => null }, continuation: true },
  ]);
  assert.deepEqual(out, [{ text: ' post', face: null }]);
});
