import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '../src/index.js';

// --- construction -------------------------------------------------------

test('a new buffer starts empty with the cursor at 0', () => {
  const buf = createBuffer();
  assert.equal(buf.text, '');
  assert.equal(buf.point, 0);
  assert.equal(buf.mark, null);
});

test('a buffer can be seeded with text and named', () => {
  const buf = createBuffer('hello', { name: 'greeting' });
  assert.equal(buf.text, 'hello');
  assert.equal(buf.name, 'greeting');
  assert.equal(buf.lineCount, 1);
});

test('name defaults to untitled', () => {
  assert.equal(createBuffer('x').name, 'untitled');
});

// --- insert -------------------------------------------------------------

test('insert places text at the cursor and advances it', () => {
  const buf = createBuffer();
  buf.insert('hello');
  assert.equal(buf.text, 'hello');
  assert.equal(buf.point, 5);
});

test('insert happens at the cursor, not the end', () => {
  const buf = createBuffer('ad');
  buf.moveTo(1);
  buf.insert('bc');
  assert.equal(buf.text, 'abcd');
  assert.equal(buf.point, 3);
});

test('typing characters one at a time composes', () => {
  const buf = createBuffer();
  for (const ch of 'word') buf.insert(ch);
  assert.equal(buf.text, 'word');
  assert.equal(buf.point, 4);
});

// --- delete -------------------------------------------------------------

test('deleteBackward removes the character before the cursor', () => {
  const buf = createBuffer('hello');
  buf.moveTo(5);
  assert.equal(buf.deleteBackward(), true);
  assert.equal(buf.text, 'hell');
  assert.equal(buf.point, 4);
});

test('deleteBackward at the start of the buffer is a no-op', () => {
  const buf = createBuffer('hello');
  buf.moveTo(0);
  assert.equal(buf.deleteBackward(), false);
  assert.equal(buf.text, 'hello');
});

test('deleteForward removes the character after the cursor', () => {
  const buf = createBuffer('hello');
  buf.moveTo(0);
  assert.equal(buf.deleteForward(), true);
  assert.equal(buf.text, 'ello');
  assert.equal(buf.point, 0);
});

test('deleteForward at the end of the buffer is a no-op', () => {
  const buf = createBuffer('hello');
  buf.moveTo(5);
  assert.equal(buf.deleteForward(), false);
});

test('deleteBackward can remove several characters', () => {
  const buf = createBuffer('hello');
  buf.moveTo(5);
  buf.deleteBackward(3);
  assert.equal(buf.text, 'he');
  assert.equal(buf.point, 2);
});

// --- setText ------------------------------------------------------------

test('setText replaces the whole buffer and resets the cursor', () => {
  const buf = createBuffer('old contents');
  buf.moveTo(8);
  buf.setText('brand new text');
  assert.equal(buf.text, 'brand new text');
  assert.equal(buf.point, 0);
  assert.equal(buf.mark, null);
});

test('setText fires a change event', () => {
  const buf = createBuffer('before');
  let fired = false;
  buf.onChange((event) => {
    if (event.change) fired = true;
  });
  buf.setText('after');
  assert.equal(fired, true);
});

// --- selection ----------------------------------------------------------

test('selection is null until the mark is set away from point', () => {
  const buf = createBuffer('hello');
  assert.equal(buf.selection, null);
  buf.moveTo(3);
  buf.setMark(1);
  assert.deepEqual(buf.selection, { start: 1, end: 3 });
});

test('selection normalises regardless of mark/point order', () => {
  const buf = createBuffer('hello');
  buf.moveTo(1);
  buf.setMark(4);
  assert.deepEqual(buf.selection, { start: 1, end: 4 });
});

test('insert replaces the active selection', () => {
  const buf = createBuffer('hello world');
  buf.moveTo(0);
  buf.setMark(5);
  buf.insert('HI');
  assert.equal(buf.text, 'HI world');
  assert.equal(buf.point, 2);
  assert.equal(buf.selection, null);
});

test('deleteBackward removes the active selection', () => {
  const buf = createBuffer('hello world');
  buf.moveTo(11);
  buf.setMark(5);
  buf.deleteBackward();
  assert.equal(buf.text, 'hello');
  assert.equal(buf.point, 5);
});

test('extending a move builds a selection', () => {
  const buf = createBuffer('hello');
  buf.moveTo(1);
  buf.moveRight({ extend: true });
  buf.moveRight({ extend: true });
  assert.deepEqual(buf.selection, { start: 1, end: 3 });
});

// --- movement -----------------------------------------------------------

test('moveTo clamps out-of-range offsets', () => {
  const buf = createBuffer('hello');
  buf.moveTo(99);
  assert.equal(buf.point, 5);
  buf.moveTo(-5);
  assert.equal(buf.point, 0);
});

test('moveLeft and moveRight step by one', () => {
  const buf = createBuffer('hello');
  buf.moveTo(2);
  buf.moveRight();
  assert.equal(buf.point, 3);
  buf.moveLeft();
  assert.equal(buf.point, 2);
});

test('moveDown keeps the column across lines', () => {
  const buf = createBuffer('abcd\nefgh\nijkl');
  buf.moveTo(2); // line 0, column 2
  buf.moveDown();
  assert.deepEqual(buf.positionAt(buf.point), { line: 1, column: 2 });
  buf.moveUp();
  assert.deepEqual(buf.positionAt(buf.point), { line: 0, column: 2 });
});

test('moveLineStart and moveLineEnd reach the line edges', () => {
  const buf = createBuffer('first\nsecond line\nthird');
  buf.moveTo(9); // somewhere in 'second line'
  buf.moveLineStart();
  assert.equal(buf.point, 6);
  buf.moveLineEnd();
  assert.equal(buf.point, 17);
});

test('moveBufferStart and moveBufferEnd reach the buffer edges', () => {
  const buf = createBuffer('a\nb\nc');
  buf.moveBufferEnd();
  assert.equal(buf.point, 5);
  buf.moveBufferStart();
  assert.equal(buf.point, 0);
});

// --- history ------------------------------------------------------------

test('undo reverses an insert and restores the cursor', () => {
  const buf = createBuffer('hello');
  buf.moveTo(5);
  buf.insert(' world');
  assert.equal(buf.text, 'hello world');
  assert.equal(buf.undo(), true);
  assert.equal(buf.text, 'hello');
  assert.equal(buf.point, 5);
});

test('redo reapplies an undone edit', () => {
  const buf = createBuffer('hello');
  buf.moveTo(5);
  buf.insert('!');
  buf.undo();
  assert.equal(buf.redo(), true);
  assert.equal(buf.text, 'hello!');
});

test('undo on an empty history returns false', () => {
  assert.equal(createBuffer('x').undo(), false);
});

test('canUndo and canRedo track history', () => {
  const buf = createBuffer();
  assert.equal(buf.canUndo, false);
  buf.insert('a');
  assert.equal(buf.canUndo, true);
  buf.undo();
  assert.equal(buf.canRedo, true);
});

// --- events -------------------------------------------------------------

test('onChange fires on an edit with the change and cursor state', () => {
  const buf = createBuffer('hi');
  const events = [];
  buf.onChange((e) => events.push(e));
  buf.moveTo(2);
  buf.insert('!');
  assert.equal(events.length, 2); // the move, then the insert
  assert.equal(events[0].change, null);
  assert.deepEqual(events[1].change, { start: 2, removed: '', inserted: '!' });
  assert.equal(events[1].point, 3);
});

test('onChange fires on a pure cursor move with a null change', () => {
  const buf = createBuffer('hello');
  const events = [];
  buf.onChange((e) => events.push(e));
  buf.moveRight();
  assert.deepEqual(events, [{ change: null, point: 1, mark: null }]);
});

test('onChange returns a working unsubscribe', () => {
  const buf = createBuffer();
  let count = 0;
  const off = buf.onChange(() => (count += 1));
  buf.insert('a');
  off();
  buf.insert('b');
  assert.equal(count, 1);
});

test('onChange rejects a non-function listener', () => {
  assert.throws(() => createBuffer().onChange(42), TypeError);
});

// --- modes --------------------------------------------------------------

test('a buffer has no major mode and no minor modes by default', () => {
  const buf = createBuffer();
  assert.equal(buf.majorMode, null);
  assert.equal(buf.minorModes, null);
});

test('the major mode stores an opaque value', () => {
  const buf = createBuffer();
  const mode = { name: 'Lisp' };
  buf.majorMode = mode;
  assert.equal(buf.majorMode, mode);
});

test('setting a mode emits a change event so consumers refresh', () => {
  const buf = createBuffer('hello');
  const events = [];
  buf.onChange((e) => events.push(e));
  buf.majorMode = { name: 'Lisp' };
  buf.minorModes = [{ name: 'auto-fill' }];
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { change: null, point: 0, mark: null });
});

test('minorModes stores an opaque value', () => {
  const buf = createBuffer();
  const modes = { lisp: true }; // the stdlib decides the representation
  buf.minorModes = modes;
  assert.equal(buf.minorModes, modes);
});

// --- bindCursor (per-view-point) ---------------------------------------

test('bindCursor: the bound source becomes the canonical cursor storage', () => {
  const buf = createBuffer('hello');
  const view = { point: 0, mark: null };
  buf.bindCursor(view);
  buf.moveTo(3);
  assert.equal(view.point, 3, 'moveTo writes into the bound source');
  assert.equal(buf.point, 3, 'the buffer reads through the bound source');
  buf.setMark(1);
  assert.equal(view.mark, 1);
});

test('bindCursor: two views over one buffer keep independent cursors', () => {
  const buf = createBuffer('abcdefgh');
  const viewA = { point: 0, mark: null };
  const viewB = { point: 0, mark: null };
  buf.bindCursor(viewA);
  buf.moveTo(3);
  // Switch to view B; its cursor is fresh.
  buf.bindCursor(viewB);
  assert.equal(buf.point, 0, 'B starts fresh');
  buf.moveTo(5);
  assert.equal(viewB.point, 5);
  // Switch back to A; its 3 is still there.
  buf.bindCursor(viewA);
  assert.equal(buf.point, 3, 'A kept its 3');
  assert.equal(viewA.point, 3);
});

test('bindCursor(null): reverts to the local backing', () => {
  const buf = createBuffer('hello');
  const view = { point: 2, mark: null };
  buf.bindCursor(view);
  assert.equal(buf.point, 2);
  buf.bindCursor(null);
  assert.equal(buf.point, 0, 'local backing was never moved');
});

test('insert and delete through a bound view land in the view', () => {
  const buf = createBuffer('hello');
  const view = { point: 0, mark: null };
  buf.bindCursor(view);
  buf.moveTo(5);
  buf.insert('!');
  assert.equal(buf.text, 'hello!');
  assert.equal(view.point, 6);
  buf.deleteBackward();
  assert.equal(buf.text, 'hello');
  assert.equal(view.point, 5);
});

test('undo through a bound view writes the restored cursor into the view', () => {
  const buf = createBuffer('hello');
  const view = { point: 0, mark: null };
  buf.bindCursor(view);
  buf.moveTo(5);
  buf.insert(' world');
  assert.equal(view.point, 11);
  buf.undo();
  // The buffer keeps its own offset on each history record (storage's
  // `lastChange`); on undo the consumer writes it back into the bound
  // view.
  assert.equal(view.point, 5);
  assert.equal(view.mark, null);
});
