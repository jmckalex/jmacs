/**
 * @file Markers — invisible, edit-tracking positions in the buffer.
 *
 * A marker rides the text: it shifts as edits land before it, holds its
 * place when text is inserted exactly at it (left gravity), and — the
 * defining property — is never destroyed by editing. A deletion that
 * spans a marker collapses it to the edit point rather than removing it;
 * only `remove()` drops a marker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '../src/buffer.js';

/** Delete the half-open range [from, to) through the cursor API. */
function deleteRange(buffer, from, to) {
  buffer.moveTo(to);
  buffer.deleteBackward(to - from);
}

test('a marker rides text inserted before it', () => {
  const b = createBuffer('hello world');
  const m = b.createMarker(6); // the 'w'
  b.moveTo(0);
  b.insert('XYZ');
  assert.equal(m.offset, 9);
});

test('left gravity: text inserted exactly at a marker stays after it', () => {
  const b = createBuffer('hello world');
  const m = b.createMarker(6);
  b.moveTo(6);
  b.insert('Q');
  assert.equal(m.offset, 6);
});

test('a marker is untouched by edits after it', () => {
  const b = createBuffer('hello world');
  const m = b.createMarker(6);
  b.moveTo(9);
  b.insert('!!!');
  assert.equal(m.offset, 6);
});

test('a deletion spanning the marker collapses it to the edit point (xxxxa|bzzzz, delete "xxabz" -> xx|zzz)', () => {
  // x0 x1 x2 x3 a4 b5 z6 z7 z8 z9 ; marker between a and b (offset 5).
  const b = createBuffer('xxxxabzzzz');
  const m = b.createMarker(5);
  deleteRange(b, 2, 7); // delete "xxabz"
  assert.equal(b.text, 'xxzzz');
  assert.equal(m.offset, 2); // xx|zzz
});

test('a marker survives clearing the whole buffer, collapsing to 0', () => {
  const b = createBuffer('hello world');
  const m = b.createMarker(6);
  deleteRange(b, 0, b.length);
  assert.equal(b.text, '');
  assert.equal(m.offset, 0);
});

test('remove() detaches a marker so later edits no longer move it', () => {
  const b = createBuffer('hello world');
  const m = b.createMarker(6);
  m.remove();
  b.moveTo(0);
  b.insert('XYZ');
  assert.equal(m.offset, 6); // frozen at its last position
});

test('independent markers track independently', () => {
  const b = createBuffer('hello world');
  const a = b.createMarker(0);
  const m = b.createMarker(6);
  b.moveTo(5); // before m, after a
  b.insert('!');
  assert.equal(a.offset, 0);
  assert.equal(m.offset, 7);
});
