/**
 * @file Tests for the bookmark engine — named markers on a buffer, with
 * persistence on buffer.metadata and context relocation on (re)attach.
 *
 * The engine talks to the buffer only through a small surface
 * (createMarker / onChange / slice / point / moveTo / text). We exercise
 * it against a faithful mock buffer rather than the workspace L2 package
 * (which a plain `node --test` here can't resolve); the *real* marker
 * behaviour is proven in packages/buffer/test/marker.test.js. The mock's
 * markers use the same collapse-on-spanning-delete arithmetic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBookmarks } from '../src/bookmarks.js';

/** A minimal buffer that tracks markers and fires change events. */
function mockBuffer(initial, metadata) {
  let text = initial;
  let point = 0;
  const listeners = new Set();
  const markers = new Set(); // each { pos }

  function shift(start, removedLen, insertedLen) {
    for (const m of markers) {
      if (m.pos <= start) continue;
      if (m.pos >= start + removedLen) m.pos += insertedLen - removedLen;
      else m.pos = start;
    }
  }

  const buffer = {
    metadata,
    get text() { return text; },
    get length() { return text.length; },
    get point() { return point; },
    slice: (a, b) => text.slice(a, b),
    positionAt: (off) => ({ line: 0, column: off }),
    moveTo(off) { point = Math.max(0, Math.min(off, text.length)); },
    createMarker(off) {
      const m = { pos: Math.max(0, Math.min(off, text.length)) };
      markers.add(m);
      return { get offset() { return m.pos; }, remove() { markers.delete(m); } };
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Apply an edit at [start, start+removedLen) -> inserted, notifying. */
    edit(start, removedLen, inserted) {
      const removed = text.slice(start, start + removedLen);
      text = text.slice(0, start) + inserted + text.slice(start + removedLen);
      shift(start, removedLen, inserted.length);
      for (const fn of listeners) fn({ change: { start, removed, inserted }, point, mark: null });
    },
    insert(str) { this.edit(point, 0, str); point += str.length; },
    deleteBackward(count) { const s = Math.max(0, point - count); this.edit(s, point - s, ''); point = s; },
  };
  return buffer;
}

function setup(text = 'alpha beta gamma') {
  const buffer = mockBuffer(text);
  let writes = 0;
  const bm = createBookmarks({ onChange: () => { writes += 1; } });
  bm.setBuffer(buffer);
  return { buffer, bm, writes: () => writes };
}

test('set records a bookmark; jump moves point to it', () => {
  const { buffer, bm } = setup(); // "alpha beta gamma", 'beta' at 6
  buffer.moveTo(6);
  bm.set('b');
  assert.deepEqual(bm.names(), ['b']);
  assert.equal(bm.count(), 1);
  buffer.moveTo(0);
  assert.equal(bm.jump('b'), true);
  assert.equal(buffer.point, 6);
});

test('re-setting an existing name moves it (upsert, no duplicate)', () => {
  const { buffer, bm } = setup();
  buffer.moveTo(6);
  bm.set('b');
  buffer.moveTo(11);
  bm.set('b');
  assert.equal(bm.count(), 1);
  buffer.moveTo(0);
  bm.jump('b');
  assert.equal(buffer.point, 11);
});

test('a bookmark rides text inserted before it (the marker tracks live)', () => {
  const { buffer, bm } = setup();
  buffer.moveTo(6);
  bm.set('b');
  buffer.moveTo(0);
  buffer.insert('XYZ'); // 3 chars before
  buffer.moveTo(0);
  bm.jump('b');
  assert.equal(buffer.point, 9);
});

test('deleting across a bookmark collapses it, never removes it', () => {
  const { buffer, bm } = setup(); // b6 e7 t8
  buffer.moveTo(8);
  bm.set('b');
  buffer.moveTo(10);
  buffer.deleteBackward(6); // delete [4, 10), spanning 8
  assert.equal(bm.count(), 1); // survived
  buffer.moveTo(0);
  bm.jump('b');
  assert.equal(buffer.point, 4); // collapsed to the edit point
});

test('remove deletes a bookmark and reports existence', () => {
  const { buffer, bm } = setup();
  buffer.moveTo(6);
  bm.set('b');
  assert.equal(bm.remove('b'), true);
  assert.equal(bm.count(), 0);
  assert.equal(bm.remove('nope'), false);
});

test('records persist on buffer.metadata with anchor + context', () => {
  const { buffer, bm } = setup();
  buffer.moveTo(6);
  bm.set('b');
  const rec = buffer.metadata.bookmarks[0];
  assert.equal(rec.name, 'b');
  assert.equal(rec.anchor, 6);
  assert.equal(typeof rec.frontContext, 'string');
  assert.equal(typeof rec.rearContext, 'string');
});

test('edits persist (onChange fires) when a bookmark moves', () => {
  const { buffer, bm, writes } = setup();
  buffer.moveTo(6);
  bm.set('b');
  const before = writes();
  buffer.moveTo(0);
  buffer.insert('Z'); // shifts the bookmark → a sync + persist
  assert.ok(writes() > before);
});

test('setBuffer relocates a stale offset via context (reopen after external edit)', () => {
  // Save a bookmark at 'beta' (offset 6) with its context.
  const original = mockBuffer('alpha beta gamma');
  const bm = createBookmarks({});
  bm.setBuffer(original);
  original.moveTo(6);
  bm.set('b');
  const saved = original.metadata.bookmarks.map((r) => ({ ...r }));

  // Reopen a buffer whose text gained 5 chars at the front while closed.
  const reopened = mockBuffer('HELLOalpha beta gamma', { bookmarks: saved });
  bm.setBuffer(reopened);
  reopened.moveTo(0);
  bm.jump('b');
  assert.equal(reopened.point, 11); // 6 + 5, recovered from context
});
