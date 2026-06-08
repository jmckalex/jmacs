import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '@editor/buffer';
import {
  toLines, selectionRects, decorationRects, cursorPositions,
  visualColumn, charIndexAtVisualColumn,
} from '../src/projection.js';

test('toLines projects the empty string to one empty line', () => {
  assert.deepEqual(toLines(''), [{ number: 0, content: '' }]);
});

test('toLines splits on newlines and numbers the lines', () => {
  assert.deepEqual(toLines('first\nsecond\nthird'), [
    { number: 0, content: 'first' },
    { number: 1, content: 'second' },
    { number: 2, content: 'third' },
  ]);
});

test('toLines keeps a trailing empty line', () => {
  assert.deepEqual(toLines('text\n'), [
    { number: 0, content: 'text' },
    { number: 1, content: '' },
  ]);
});

test('selectionRects is empty when nothing is selected', () => {
  assert.deepEqual(selectionRects(createBuffer('hello')), []);
});

test('selectionRects describes a single-line selection', () => {
  const buf = createBuffer('hello world');
  buf.moveTo(0);
  buf.setMark(5);
  assert.deepEqual(selectionRects(buf), [
    { line: 0, fromColumn: 0, toColumn: 5, toLineEnd: false },
  ]);
});

test('selectionRects spans multiple lines', () => {
  const buf = createBuffer('abcd\nefgh\nijkl');
  buf.moveTo(2); // line 0, column 2
  buf.setMark(12); // line 2, column 2
  const rects = selectionRects(buf);
  assert.deepEqual(rects, [
    { line: 0, fromColumn: 2, toColumn: 4, toLineEnd: true },
    { line: 1, fromColumn: 0, toColumn: 4, toLineEnd: true },
    { line: 2, fromColumn: 0, toColumn: 2, toLineEnd: false },
  ]);
});

test('selectionRects covers every selection in a multi-cursor buffer', () => {
  const buf = createBuffer('hello world');
  buf.moveTo(0);
  buf.setMark(5); // primary selects "hello"
  buf.addSelection(10, 6); // secondary selects "world"
  const rects = selectionRects(buf);
  assert.deepEqual(rects, [
    { line: 0, fromColumn: 0, toColumn: 5, toLineEnd: false },
    { line: 0, fromColumn: 6, toColumn: 10, toLineEnd: false },
  ]);
});

test('selectionRects skips caret-only cursors', () => {
  const buf = createBuffer('hello world');
  buf.moveTo(0);
  buf.setMark(5); // primary selects "hello"
  buf.addSelection(8); // secondary is a bare caret
  const rects = selectionRects(buf);
  assert.equal(rects.length, 1);
  assert.deepEqual(rects[0], {
    line: 0, fromColumn: 0, toColumn: 5, toLineEnd: false,
  });
});

test('cursorPositions reports one position per cursor in order', () => {
  const buf = createBuffer('foo bar\nbaz');
  buf.moveTo(0);
  buf.addSelection(4); // start of "bar"
  buf.addSelection(8); // start of "baz" on line 1
  assert.deepEqual(cursorPositions(buf), [
    { line: 0, column: 0 },
    { line: 0, column: 4 },
    { line: 1, column: 0 },
  ]);
});

test('cursorPositions on a single-cursor buffer returns one entry', () => {
  const buf = createBuffer('hi');
  buf.moveTo(1);
  assert.deepEqual(cursorPositions(buf), [{ line: 0, column: 1 }]);
});

// --- visual columns (tab-aware positioning) ----------------------------

test('visualColumn: no tabs in the line → column == char index', () => {
  assert.equal(visualColumn('hello', 0, 4), 0);
  assert.equal(visualColumn('hello', 3, 4), 3);
  assert.equal(visualColumn('hello', 5, 4), 5);
});

test('visualColumn: a tab advances to the next tab-stop', () => {
  // tabWidth = 4; column-after-tab is 4. Char at index 1 is the tab
  // itself, visually starting at column 0, so charIndex 1 (just after
  // the tab) sits at column 4.
  assert.equal(visualColumn('\ta', 0, 4), 0);
  assert.equal(visualColumn('\ta', 1, 4), 4);
  assert.equal(visualColumn('\ta', 2, 4), 5);
});

test('visualColumn: a tab rounds up to its stop, not by full width', () => {
  // "ab\t" — chars `a`, `b` consume columns 0, 1; the tab brings us
  // to the NEXT multiple of 4, which is 4 — not 1 + 4.
  assert.equal(visualColumn('ab\tc', 2, 4), 2);
  assert.equal(visualColumn('ab\tc', 3, 4), 4);
  assert.equal(visualColumn('ab\tc', 4, 4), 5);
});

test('charIndexAtVisualColumn: inverse of visualColumn', () => {
  // "\ta" — clicking at column 0 → index 0; column 4 → index 1 (just
  // past the tab); column 5 → index 2 (past 'a').
  assert.equal(charIndexAtVisualColumn('\ta', 0, 4), 0);
  assert.equal(charIndexAtVisualColumn('\ta', 4, 4), 1);
  assert.equal(charIndexAtVisualColumn('\ta', 5, 4), 2);
});

test('charIndexAtVisualColumn: click inside a tab snaps to nearest edge', () => {
  // Click at column 1 in `"\ta"`: tab spans columns 0-4. Closer to 0
  // than 4 → before the tab.
  assert.equal(charIndexAtVisualColumn('\ta', 1, 4), 0);
  // Click at column 3: still closer to 4. After the tab.
  assert.equal(charIndexAtVisualColumn('\ta', 3, 4), 1);
});

test('selectionRects: tabWidth shifts column edges to the next tab-stop', () => {
  // "\thello" — select chars 0..5 ('\thell'). Without tabWidth the
  // rect is fromCol=0, toCol=5 (the legacy character-indexed result).
  // With tabWidth=4 the tab takes the start to column 0 and the end
  // to column 8 (4 for the tab + 4 for "hell").
  const buf = createBuffer('\thello');
  buf.moveTo(0); buf.setMark(5);
  assert.deepEqual(selectionRects(buf), [
    { line: 0, fromColumn: 0, toColumn: 5, toLineEnd: false },
  ]);
  assert.deepEqual(selectionRects(buf, undefined, undefined, 4), [
    { line: 0, fromColumn: 0, toColumn: 8, toLineEnd: false },
  ]);
});

test('cursorPositions: tabWidth shifts the column to the visual position', () => {
  const buf = createBuffer('\thello');
  buf.moveTo(3); // past tab + "he"
  // Without tabWidth: column = char index = 3.
  assert.deepEqual(cursorPositions(buf), [{ line: 0, column: 3 }]);
  // With tabWidth=4: tab → column 4, then +2 chars → column 6.
  assert.deepEqual(cursorPositions(buf, undefined, 4), [{ line: 0, column: 6 }]);
});

// --- decorationRects (snippet field / mirror boxes) --------------------

test('decorationRects: empty when given no ranges', () => {
  const buf = createBuffer('hello world');
  assert.deepEqual(decorationRects(buf, []), []);
  assert.deepEqual(decorationRects(buf, null), []);
});

test('decorationRects: a single-line range carries its face', () => {
  const buf = createBuffer('for (let i = 0; ...');
  // The field on "i" spans offsets 9..10.
  assert.deepEqual(
    decorationRects(buf, [{ start: 9, end: 10, face: 'snippet-active-face' }]),
    [{ line: 0, fromColumn: 9, toColumn: 10, toLineEnd: false, face: 'snippet-active-face' }]
  );
});

test('decorationRects: paints active + mirror ranges independently', () => {
  const buf = createBuffer('aXbbXc');
  const rects = decorationRects(buf, [
    { start: 1, end: 2, face: 'snippet-active-face' }, // first "X"
    { start: 4, end: 5, face: 'snippet-mirror-face' }, // second "X"
  ]);
  assert.deepEqual(rects, [
    { line: 0, fromColumn: 1, toColumn: 2, toLineEnd: false, face: 'snippet-active-face' },
    { line: 0, fromColumn: 4, toColumn: 5, toLineEnd: false, face: 'snippet-mirror-face' },
  ]);
});

test('decorationRects: a multi-line range emits one rect per touched line', () => {
  const buf = createBuffer('abcd\nefgh\nijkl');
  const rects = decorationRects(buf, [
    { start: 2, end: 12, face: 'snippet-active-face' },
  ]);
  assert.deepEqual(rects, [
    { line: 0, fromColumn: 2, toColumn: 4, toLineEnd: true, face: 'snippet-active-face' },
    { line: 1, fromColumn: 0, toColumn: 4, toLineEnd: true, face: 'snippet-active-face' },
    { line: 2, fromColumn: 0, toColumn: 2, toLineEnd: false, face: 'snippet-active-face' },
  ]);
});

test('decorationRects: a zero-width (empty-field) range still emits a marker', () => {
  const buf = createBuffer('ab');
  const rects = decorationRects(buf, [
    { start: 1, end: 1, face: 'snippet-active-face' },
  ]);
  assert.deepEqual(rects, [
    { line: 0, fromColumn: 1, toColumn: 1, toLineEnd: false, face: 'snippet-active-face' },
  ]);
});

test('decorationRects: out-of-range offsets are clamped to the buffer', () => {
  const buf = createBuffer('abc');
  // end past the buffer length is clamped to 3.
  assert.deepEqual(
    decorationRects(buf, [{ start: 1, end: 99, face: 'snippet-active-face' }]),
    [{ line: 0, fromColumn: 1, toColumn: 3, toLineEnd: false, face: 'snippet-active-face' }]
  );
});

test('decorationRects: skips inverted, faceless or malformed ranges', () => {
  const buf = createBuffer('abcde');
  assert.deepEqual(
    decorationRects(buf, [
      { start: 4, end: 2, face: 'snippet-active-face' }, // inverted
      { start: 0, end: 2, face: '' },                    // no face
      { start: 0, end: 2 },                              // no face key
      null,                                              // junk
      { face: 'snippet-active-face' },                   // no offsets
    ]),
    []
  );
});

test('decorationRects: tabWidth shifts the columns to the visual position', () => {
  const buf = createBuffer('\thello');
  // Field over "hell" (offsets 1..5). Without tabWidth the rect uses
  // character columns (1..5); with tabWidth=4 the leading tab pushes
  // the start to column 4 and the end to column 8.
  assert.deepEqual(
    decorationRects(buf, [{ start: 1, end: 5, face: 'snippet-active-face' }]),
    [{ line: 0, fromColumn: 1, toColumn: 5, toLineEnd: false, face: 'snippet-active-face' }]
  );
  assert.deepEqual(
    decorationRects(buf, [{ start: 1, end: 5, face: 'snippet-active-face' }], 4),
    [{ line: 0, fromColumn: 4, toColumn: 8, toLineEnd: false, face: 'snippet-active-face' }]
  );
});
