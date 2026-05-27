import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '@editor/buffer';
import { toLines, selectionRects, cursorPositions } from '../src/projection.js';

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
