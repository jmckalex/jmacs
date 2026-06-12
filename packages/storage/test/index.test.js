import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '../src/index.js';

test('createBuffer with no argument is empty', () => {
  assert.equal(createBuffer().toString(), '');
});

test('createBuffer seeds with initial text', () => {
  assert.equal(createBuffer('hello world').toString(), 'hello world');
});

test('createBuffer rejects a non-string seed', () => {
  assert.throws(() => createBuffer(42), TypeError);
});

test('length reflects contents', () => {
  const buf = createBuffer('hello');
  assert.equal(buf.length, 5);
  buf.insert(5, '!');
  assert.equal(buf.length, 6);
});

// --- insert -------------------------------------------------------------

test('insert in the middle', () => {
  const buf = createBuffer('hello world');
  buf.insert(5, ',');
  assert.equal(buf.toString(), 'hello, world');
});

test('insert at the start', () => {
  const buf = createBuffer('world');
  buf.insert(0, 'hello ');
  assert.equal(buf.toString(), 'hello world');
});

test('insert at the end appends', () => {
  const buf = createBuffer('hello');
  buf.insert(5, ' world');
  assert.equal(buf.toString(), 'hello world');
});

test('inserting an empty string is a no-op on contents', () => {
  const buf = createBuffer('unchanged');
  buf.insert(3, '');
  assert.equal(buf.toString(), 'unchanged');
});

test('successive inserts compose', () => {
  const buf = createBuffer('ac');
  buf.insert(1, 'b');
  buf.insert(3, 'd');
  assert.equal(buf.toString(), 'abcd');
});

test('insert rejects an out-of-range position', () => {
  const buf = createBuffer('short');
  assert.throws(() => buf.insert(6, 'x'), RangeError);
  assert.throws(() => buf.insert(-1, 'x'), RangeError);
});

test('insert rejects a non-integer position', () => {
  assert.throws(() => createBuffer('text').insert(1.5, 'x'), TypeError);
});

test('insert rejects non-string text', () => {
  assert.throws(() => createBuffer('text').insert(0, 99), TypeError);
});

// --- delete -------------------------------------------------------------

test('delete removes a middle range and returns it', () => {
  const buf = createBuffer('hello, world');
  const removed = buf.delete(5, 7);
  assert.equal(buf.toString(), 'helloworld');
  assert.equal(removed, ', ');
});

test('delete at the start', () => {
  const buf = createBuffer('hello world');
  buf.delete(0, 6);
  assert.equal(buf.toString(), 'world');
});

test('delete to the end', () => {
  const buf = createBuffer('hello world');
  buf.delete(5, 11);
  assert.equal(buf.toString(), 'hello');
});

test('delete of an empty range is a no-op', () => {
  const buf = createBuffer('hello');
  assert.equal(buf.delete(2, 2), '');
  assert.equal(buf.toString(), 'hello');
});

test('delete rejects a reversed range', () => {
  assert.throws(() => createBuffer('hello').delete(4, 1), RangeError);
});

test('delete rejects an out-of-range end', () => {
  assert.throws(() => createBuffer('hello').delete(0, 99), RangeError);
});

// --- replace ------------------------------------------------------------

test('replace swaps a range for new text and returns the old', () => {
  const buf = createBuffer('hello world');
  const removed = buf.replace(6, 11, 'there');
  assert.equal(buf.toString(), 'hello there');
  assert.equal(removed, 'world');
});

test('replace can grow and shrink the buffer', () => {
  const buf = createBuffer('aXc');
  buf.replace(1, 2, 'BBBB');
  assert.equal(buf.toString(), 'aBBBBc');
  buf.replace(1, 5, '');
  assert.equal(buf.toString(), 'ac');
});

// --- slice --------------------------------------------------------------

test('slice returns a sub-range', () => {
  const buf = createBuffer('hello world');
  assert.equal(buf.slice(0, 5), 'hello');
  assert.equal(buf.slice(6), 'world');
  assert.equal(buf.slice(), 'hello world');
});

// --- lines and positions ------------------------------------------------

test('lineCount counts newline-separated lines', () => {
  assert.equal(createBuffer('').lineCount, 1);
  assert.equal(createBuffer('one line').lineCount, 1);
  assert.equal(createBuffer('a\nb\nc').lineCount, 3);
  assert.equal(createBuffer('trailing\n').lineCount, 2);
});

test('lineAt returns the enclosing line', () => {
  const buf = createBuffer('first\nsecond\nthird');
  const second = buf.lineAt(8);
  assert.deepEqual(second, { number: 1, from: 6, to: 12, text: 'second' });
});

test('lineAt handles the first and last lines', () => {
  const buf = createBuffer('first\nsecond\nthird');
  assert.equal(buf.lineAt(0).text, 'first');
  assert.equal(buf.lineAt(buf.length).text, 'third');
});

test('positionAt converts offsets to line/column', () => {
  const buf = createBuffer('abc\ndef');
  assert.deepEqual(buf.positionAt(0), { line: 0, column: 0 });
  assert.deepEqual(buf.positionAt(2), { line: 0, column: 2 });
  assert.deepEqual(buf.positionAt(4), { line: 1, column: 0 });
  assert.deepEqual(buf.positionAt(7), { line: 1, column: 3 });
});

test('offsetAt is the inverse of positionAt', () => {
  const buf = createBuffer('abc\ndef\nghi');
  for (let offset = 0; offset <= buf.length; offset += 1) {
    const { line, column } = buf.positionAt(offset);
    assert.equal(buf.offsetAt(line, column), offset);
  }
});

test('offsetAt clamps an over-long column to the end of the line', () => {
  const buf = createBuffer('abc\ndef');
  assert.equal(buf.offsetAt(0, 99), 3);
});

// --- change events ------------------------------------------------------

test('onChange fires with an insert payload', () => {
  const buf = createBuffer('helloworld');
  const changes = [];
  buf.onChange((c) => changes.push(c));
  buf.insert(5, ', ');
  assert.deepEqual(changes, [{ start: 5, removed: '', inserted: ', ' }]);
});

test('onChange fires with a delete payload', () => {
  const buf = createBuffer('hello world');
  const changes = [];
  buf.onChange((c) => changes.push(c));
  buf.delete(5, 11);
  assert.deepEqual(changes, [{ start: 5, removed: ' world', inserted: '' }]);
});

test('onChange fires with a replace payload', () => {
  const buf = createBuffer('hello world');
  const changes = [];
  buf.onChange((c) => changes.push(c));
  buf.replace(6, 11, 'there');
  assert.deepEqual(changes, [
    { start: 6, removed: 'world', inserted: 'there' },
  ]);
});

test('onChange supports multiple listeners', () => {
  const buf = createBuffer('');
  let a = 0;
  let b = 0;
  buf.onChange(() => (a += 1));
  buf.onChange(() => (b += 1));
  buf.insert(0, 'x');
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('onChange returns a working unsubscribe', () => {
  const buf = createBuffer('');
  let count = 0;
  const off = buf.onChange(() => (count += 1));
  buf.insert(0, 'a');
  off();
  buf.insert(1, 'b');
  assert.equal(count, 1);
});

test('onChange rejects a non-function listener', () => {
  assert.throws(() => createBuffer('').onChange(42), TypeError);
});

// --- undo / redo --------------------------------------------------------

test('undo reverses an insert', () => {
  const buf = createBuffer('hello');
  buf.insert(5, ' world');
  assert.equal(buf.undo(), true);
  assert.equal(buf.toString(), 'hello');
});

test('undo reverses a delete', () => {
  const buf = createBuffer('hello world');
  buf.delete(5, 11);
  buf.undo();
  assert.equal(buf.toString(), 'hello world');
});

test('undo reverses a replace', () => {
  const buf = createBuffer('hello world');
  buf.replace(6, 11, 'there');
  buf.undo();
  assert.equal(buf.toString(), 'hello world');
});

test('redo reapplies an undone edit', () => {
  const buf = createBuffer('hello');
  buf.insert(5, ' world');
  buf.undo();
  assert.equal(buf.redo(), true);
  assert.equal(buf.toString(), 'hello world');
});

test('undo and redo walk a multi-edit history', () => {
  const buf = createBuffer('');
  buf.insert(0, 'a');
  buf.insert(1, 'b');
  buf.insert(2, 'c');
  assert.equal(buf.toString(), 'abc');
  buf.undo();
  buf.undo();
  assert.equal(buf.toString(), 'a');
  buf.redo();
  assert.equal(buf.toString(), 'ab');
});

test('a new edit clears the redo stack', () => {
  const buf = createBuffer('');
  buf.insert(0, 'a');
  buf.undo();
  buf.insert(0, 'z');
  assert.equal(buf.canRedo, false);
  assert.equal(buf.redo(), false);
  assert.equal(buf.toString(), 'z');
});

test('undo and redo on an empty history return false', () => {
  const buf = createBuffer('x');
  assert.equal(buf.undo(), false);
  assert.equal(buf.redo(), false);
});

test('canUndo and canRedo track history state', () => {
  const buf = createBuffer('');
  assert.equal(buf.canUndo, false);
  buf.insert(0, 'a');
  assert.equal(buf.canUndo, true);
  assert.equal(buf.canRedo, false);
  buf.undo();
  assert.equal(buf.canUndo, false);
  assert.equal(buf.canRedo, true);
});

test('undo emits a change event so observers stay in sync', () => {
  const buf = createBuffer('hello');
  const changes = [];
  buf.insert(5, '!');
  buf.onChange((c) => changes.push(c));
  buf.undo();
  assert.deepEqual(changes, [{ start: 5, removed: '!', inserted: '' }]);
});

// --- change groups ------------------------------------------------------

test('a change group undoes as one step', () => {
  const buffer = createBuffer('alpha beta gamma');
  buffer.beginChangeGroup();
  buffer.delete(0, 5);
  buffer.insert(0, 'ALPHA');
  buffer.replace(6, 10, 'BETA');
  buffer.endChangeGroup();
  assert.equal(buffer.toString(), 'ALPHA BETA gamma');
  assert.equal(buffer.undo(), true);
  assert.equal(buffer.toString(), 'alpha beta gamma');
  assert.equal(buffer.canUndo, false);
});

test('a change group redoes as one step', () => {
  const buffer = createBuffer('one two');
  buffer.beginChangeGroup();
  buffer.delete(0, 3);
  buffer.insert(0, 'ONE');
  buffer.endChangeGroup();
  buffer.undo();
  assert.equal(buffer.toString(), 'one two');
  assert.equal(buffer.redo(), true);
  assert.equal(buffer.toString(), 'ONE two');
  assert.equal(buffer.canRedo, false);
});

test('change groups nest: only the outermost pair closes the group', () => {
  const buffer = createBuffer('xy');
  buffer.beginChangeGroup();
  buffer.insert(0, 'a');
  buffer.beginChangeGroup();
  buffer.insert(1, 'b');
  buffer.endChangeGroup();
  buffer.insert(2, 'c');
  buffer.endChangeGroup();
  assert.equal(buffer.toString(), 'abcxy');
  buffer.undo();
  assert.equal(buffer.toString(), 'xy');
});

test('an empty change group records nothing', () => {
  const buffer = createBuffer('text');
  buffer.beginChangeGroup();
  buffer.endChangeGroup();
  assert.equal(buffer.canUndo, false);
});

test('a single-change group undoes like a plain edit', () => {
  const buffer = createBuffer('text');
  buffer.beginChangeGroup();
  buffer.insert(0, 'x');
  buffer.endChangeGroup();
  buffer.undo();
  assert.equal(buffer.toString(), 'text');
});

test('undo and redo are refused while a group is open', () => {
  const buffer = createBuffer('text');
  buffer.insert(0, 'a');
  buffer.beginChangeGroup();
  buffer.insert(0, 'b');
  assert.equal(buffer.undo(), false);
  assert.equal(buffer.redo(), false);
  buffer.endChangeGroup();
  assert.equal(buffer.undo(), true);
  assert.equal(buffer.toString(), 'atext');
});

test('an unbalanced endChangeGroup is ignored', () => {
  const buffer = createBuffer('text');
  buffer.endChangeGroup();
  buffer.insert(0, 'x');
  assert.equal(buffer.undo(), true);
  assert.equal(buffer.toString(), 'text');
});

test('edits after a closed group undo separately from it', () => {
  const buffer = createBuffer('');
  buffer.beginChangeGroup();
  buffer.insert(0, 'one ');
  buffer.insert(4, 'two');
  buffer.endChangeGroup();
  buffer.insert(7, '!');
  assert.equal(buffer.toString(), 'one two!');
  buffer.undo();
  assert.equal(buffer.toString(), 'one two');
  buffer.undo();
  assert.equal(buffer.toString(), '');
});
