/**
 * @file Tests for the Model-B render-from-mirror client buffer.
 *
 * Pure (DOM-free) coverage of the mirror's read surface, delta/snapshot
 * application, and intent emission. Runs under the existing `node --test`
 * suite and must stay green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClientBuffer } from './client-buffer.js';

// --- read surface (the surface view.js consumes) ----------------------

test('exposes the full read surface view.js reads', () => {
  const b = createClientBuffer({ initialText: 'hello\nworld', name: 'a.js' });
  assert.equal(b.name, 'a.js');
  assert.equal(b.text, 'hello\nworld');
  assert.equal(b.length, 11);
  assert.equal(b.lineCount, 2);
  assert.equal(b.slice(0, 5), 'hello');
  assert.deepEqual(b.positionAt(7), { line: 1, column: 1 });
  assert.equal(b.offsetAt(1, 0), 6);
  const line = b.lineAt(7);
  assert.equal(line.text, 'world');
  assert.equal(line.from, 6);
});

test('read surface is delegated to real L1 storage (subtle math is correct)', () => {
  // Surrogate pairs + multi-line: the methods that are easy to get wrong.
  const b = createClientBuffer({ initialText: 'a\n\u{1F600}b\nc' });
  assert.equal(b.lineCount, 3);
  // The emoji is 2 UTF-16 units; column math comes straight from L1.
  assert.deepEqual(b.positionAt(2), { line: 1, column: 0 });
  assert.deepEqual(b.positionAt(4), { line: 1, column: 2 });
  assert.equal(b.lineAt(4).text, '\u{1F600}b');
});

// --- cursor as window-state -------------------------------------------

test('point/mark are owned window-state, seeded from options', () => {
  const b = createClientBuffer({ initialText: 'hello', point: 3 });
  assert.equal(b.point, 3);
  assert.equal(b.mark, null);
  assert.equal(b.cursorCount, 1);
  assert.deepEqual(b.cursors, [{ point: 3, mark: null }]);
});

// --- onChange contract -------------------------------------------------

test('onChange fires on a delta and returns an unsubscribe', () => {
  const b = createClientBuffer({ initialText: 'hi' });
  let calls = 0;
  const off = b.onChange(() => { calls += 1; });
  b.applyDelta({ start: 2, removed: '', inserted: '!', point: 3, seq: 1 });
  assert.equal(calls, 1);
  off();
  b.applyDelta({ start: 3, removed: '', inserted: '?', point: 4, seq: 2 });
  assert.equal(calls, 1);
});

test('onChange rejects a non-function', () => {
  const b = createClientBuffer();
  assert.throws(() => b.onChange(null), TypeError);
});

// --- applying server deltas (the DOWN path) ---------------------------

test('applyDelta inserts into the mirror and advances seq', () => {
  const b = createClientBuffer({ initialText: 'ac' });
  b.applyDelta({ start: 1, removed: '', inserted: 'b', point: 2, seq: 1 });
  assert.equal(b.text, 'abc');
  assert.equal(b.point, 2);
  assert.equal(b.lastSeq, 1);
});

test('applyDelta deletes a range', () => {
  const b = createClientBuffer({ initialText: 'abcd' });
  b.applyDelta({ start: 1, removed: 'bc', inserted: '', point: 1, seq: 1 });
  assert.equal(b.text, 'ad');
  assert.equal(b.point, 1);
});

test('applyDelta replaces a range', () => {
  const b = createClientBuffer({ initialText: 'abcd' });
  b.applyDelta({ start: 1, removed: 'bc', inserted: 'XYZ', point: 4, seq: 1 });
  assert.equal(b.text, 'aXYZd');
  assert.equal(b.point, 4);
});

test('an echoed delta does not re-edit (text already predicted)', () => {
  const b = createClientBuffer({ initialText: 'a', point: 1 });
  // Predict locally: insert 'b' at point 1 → text 'ab', point 2.
  b.insert('b');
  assert.equal(b.text, 'ab');
  assert.equal(b.point, 2);
  // The server confirms the same edit (echoed): text must NOT double-apply.
  b.applyDelta(
    { start: 1, removed: '', inserted: 'b', point: 2, seq: 1, echoId: 1 },
    { echoed: true }
  );
  assert.equal(b.text, 'ab'); // not 'abb'
  assert.equal(b.point, 2);
  assert.equal(b.lastSeq, 1);
});

// --- snapshots --------------------------------------------------------

test('applySnapshot replaces the whole mirror and resets the cursor', () => {
  const b = createClientBuffer({ initialText: 'old text here', point: 5 });
  b.applySnapshot({ text: 'fresh', point: 2, seq: 7, name: 'b.lisp' });
  assert.equal(b.text, 'fresh');
  assert.equal(b.point, 2);
  assert.equal(b.lastSeq, 7);
  assert.equal(b.name, 'b.lisp');
});

// --- mutators emit intents + locally echo -----------------------------

test('insert predicts locally and emits a self-insert intent', () => {
  const intents = [];
  const b = createClientBuffer({
    initialText: 'a',
    point: 1,
    sendIntent: (i) => intents.push(i),
  });
  b.insert('XY');
  assert.equal(b.text, 'aXY'); // local echo
  assert.equal(b.point, 3);
  assert.deepEqual(intents, [{ kind: 'self-insert', text: 'XY' }]);
});

test('deleteBackward predicts locally and emits an intent', () => {
  const intents = [];
  const b = createClientBuffer({
    initialText: 'abc',
    point: 3,
    sendIntent: (i) => intents.push(i),
  });
  b.deleteBackward(1);
  assert.equal(b.text, 'ab');
  assert.equal(b.point, 2);
  assert.deepEqual(intents, [{ kind: 'delete-backward', count: 1 }]);
});

test('deleteBackward at buffer start is a no-op with no intent change', () => {
  const intents = [];
  const b = createClientBuffer({
    initialText: 'abc',
    point: 0,
    sendIntent: (i) => intents.push(i),
  });
  b.deleteBackward(1);
  assert.equal(b.text, 'abc');
  assert.equal(b.point, 0);
  // The intent is still sent (server is canonical); the prediction no-ops.
  assert.deepEqual(intents, [{ kind: 'delete-backward', count: 1 }]);
});

test('deleteBackward steps a whole surrogate pair, not a code unit', () => {
  const b = createClientBuffer({ initialText: 'x\u{1F600}', point: 3 });
  b.deleteBackward(1);
  assert.equal(b.text, 'x'); // the emoji (2 units) removed as one char
  assert.equal(b.point, 1);
});

test('moveTo sets point as window-state and emits a point intent', () => {
  const intents = [];
  const b = createClientBuffer({
    initialText: 'hello',
    point: 0,
    sendIntent: (i) => intents.push(i),
  });
  b.moveTo(3);
  assert.equal(b.point, 3);
  assert.equal(b.mark, null);
  assert.deepEqual(intents, [{ kind: 'point', point: 3, mark: null }]);
});

test('moveTo with extend starts/keeps a selection anchor', () => {
  const b = createClientBuffer({ initialText: 'hello', point: 1 });
  b.moveTo(4, { extend: true });
  assert.equal(b.point, 4);
  assert.equal(b.mark, 1);
});

test('localEcho:false leaves the mirror untouched until a delta lands', () => {
  const intents = [];
  const b = createClientBuffer({
    initialText: 'a',
    point: 1,
    localEcho: false,
    sendIntent: (i) => intents.push(i),
  });
  b.insert('b');
  assert.equal(b.text, 'a'); // no prediction
  assert.deepEqual(intents, [{ kind: 'self-insert', text: 'b' }]);
  // Only the server's delta moves it.
  b.applyDelta({ start: 1, removed: '', inserted: 'b', point: 2, seq: 1 });
  assert.equal(b.text, 'ab');
  assert.equal(b.point, 2);
});

// --- point clamping ---------------------------------------------------

test('points are clamped into [0, length]', () => {
  const b = createClientBuffer({ initialText: 'abc', point: 999 });
  assert.equal(b.point, 3);
  b.moveTo(-5);
  assert.equal(b.point, 0);
});
