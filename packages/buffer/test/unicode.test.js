/**
 * @file Unicode-safe editing — astral characters must never be split.
 *
 * Positions in the buffer are UTF-16 code-unit offsets, but "delete a
 * character" and "move by a character" must operate on whole code points.
 * Before the fix, backspacing after an emoji deleted one code unit and
 * left a lone surrogate (`'a🎨b'` → `'a\uD83Cb'`, not well-formed) — silent
 * corruption in the core edit path. These tests pin that down. They are
 * the buffer's first Unicode tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '../src/index.js';

// 'a🎨b': a(0), emoji high-surrogate(1), low-surrogate(2), b(3); length 4.
const EMOJI = 'a🎨b';

test('deleteBackward removes a whole emoji, not half of it', () => {
  const buf = createBuffer(EMOJI);
  buf.moveTo(3); // just after the emoji, before 'b'
  assert.equal(buf.deleteBackward(), true);
  assert.equal(buf.text, 'ab');
  assert.equal(buf.point, 1, 'cursor lands at the start of the deleted emoji');
  assert.ok(buf.text.isWellFormed(), 'no lone surrogate left behind');
});

test('deleteForward removes a whole emoji, not half of it', () => {
  const buf = createBuffer(EMOJI);
  buf.moveTo(1); // just before the emoji
  assert.equal(buf.deleteForward(), true);
  assert.equal(buf.text, 'ab');
  assert.equal(buf.point, 1);
  assert.ok(buf.text.isWellFormed());
});

test('moveLeft / moveRight step over an emoji as one character', () => {
  const buf = createBuffer(EMOJI);
  buf.moveTo(3); // after the emoji
  buf.moveLeft();
  assert.equal(buf.point, 1, 'one move clears the whole 2-unit emoji');
  buf.moveRight();
  assert.equal(buf.point, 3, 'and back over it');
});

test('repeated backspace through mixed text never corrupts', () => {
  const buf = createBuffer('x🎨🚀y');
  buf.moveTo(buf.text.length);
  while (buf.deleteBackward()) {
    assert.ok(buf.text.isWellFormed(), `well-formed after each delete: ${JSON.stringify(buf.text)}`);
  }
  assert.equal(buf.text, '');
});

test('a marker adjacent to an emoji ends at a valid boundary after deletion', () => {
  const buf = createBuffer(EMOJI);
  const after = buf.createMarker(3); // between the emoji and 'b'
  const before = buf.createMarker(1); // between 'a' and the emoji
  buf.moveTo(3);
  buf.deleteBackward(); // delete the emoji
  assert.equal(buf.text, 'ab');
  // Both markers collapse to the edit boundary at offset 1, which sits
  // cleanly between 'a' and 'b' — not inside any (now-gone) pair.
  assert.equal(after.offset, 1);
  assert.equal(before.offset, 1);
  // The marker offset is a real character boundary in the new text.
  assert.ok(buf.text.slice(0, after.offset).isWellFormed());
});

test('multiple cursors each delete their own emoji wholly', () => {
  // 🎨a🚀b: 🎨(0,1) a(2) 🚀(3,4) b(5); length 6. One cursor sits just
  // after each emoji (offsets 2 and 5).
  const buf = createBuffer('🎨a🚀b');
  const source = { cursors: [{ point: 2, mark: null }, { point: 5, mark: null }] };
  Object.defineProperty(source, 'point', {
    get() { return this.cursors[0].point; },
    set(v) { this.cursors[0].point = v; },
  });
  Object.defineProperty(source, 'mark', {
    get() { return this.cursors[0].mark; },
    set(v) { this.cursors[0].mark = v; },
  });
  buf.bindCursor(source);
  buf.deleteBackward(); // cursor at 2 deletes 🎨, cursor at 6 deletes 🚀
  assert.equal(buf.text, 'ab');
  assert.ok(buf.text.isWellFormed());
});

// Combining marks are multiple code points, not a surrogate pair, so the
// fix's guarantee here is "no corruption", not "delete the grapheme as a
// unit". Per-grapheme deletion is a documented future enhancement.
test('deleting after a combining mark stays well-formed', () => {
  const buf = createBuffer('é'); // 'e' + combining acute accent
  buf.moveTo(2);
  buf.deleteBackward(); // removes the combining mark (code-point granularity)
  assert.equal(buf.text, 'e');
  assert.ok(buf.text.isWellFormed());
});

// CRLF is two code points (CR, LF); deleting across it must not corrupt.
test('deleting across a CRLF stays well-formed', () => {
  const buf = createBuffer('a\r\nb');
  buf.moveTo(3); // after the LF
  buf.deleteBackward(); // removes LF, leaving CR
  assert.equal(buf.text, 'a\rb');
  assert.ok(buf.text.isWellFormed());
});
