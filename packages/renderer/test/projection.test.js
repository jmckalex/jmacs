import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '@editor/buffer';
import { toLines, selectionRects } from '../src/projection.js';

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
