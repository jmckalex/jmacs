/**
 * @file Tests for the Model-B multi-buffer registry (buffer-registry.js).
 *
 * Pure (DOM-free, Electron-free) coverage of the buffer/view bookkeeping:
 * adding buffers, lazy per-client views, name uniquification, kill-buffer
 * (incl. the never-empty guard), client detach, and per-entry overlays with
 * edit-tracked markers. Uses tiny fake buffer/view factories so the
 * bookkeeping is asserted without the real view stack.
 *
 * Runs under the existing `node --test` suite and must stay green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBufferRegistry } from './buffer-registry.js';

// --- fakes ------------------------------------------------------------
//
// A fake L2 buffer just enough for the registry: a mutable text, a name, a
// lineCount, and live markers that ride a single splice (so overlay
// edit-tracking can be asserted). Markers shift like real L2 markers: an
// insert at or before the marker pushes it right; a delete before it pulls
// it left.

function makeFakeBuffer(text, opts = {}) {
  let value = String(text ?? '');
  const markers = new Set();
  const buffer = {
    name: opts.name ?? 'scratch',
    get text() { return value; },
    get lineCount() { return value.split('\n').length; },
    createMarker(offset) {
      const m = {
        offset: Math.max(0, Math.min(offset, value.length)),
        remove() { markers.delete(m); },
      };
      markers.add(m);
      return m;
    },
    /** Test helper: splice text and shift live markers (not in the API). */
    _splice(start, removeLen, insert) {
      const before = value.slice(0, start);
      const after = value.slice(start + removeLen);
      value = before + insert + after;
      const delta = insert.length - removeLen;
      for (const m of markers) {
        if (m.offset >= start + removeLen) m.offset += delta;
        else if (m.offset > start) m.offset = start;
      }
    },
  };
  return buffer;
}

function makeRegistry() {
  return createBufferRegistry({
    createBuffer: (text, o) => makeFakeBuffer(text, o),
    createView: ({ buffer }) => ({ point: 0, mark: null, _buffer: buffer }),
  });
}

// --- adding / listing -------------------------------------------------

test('add registers a buffer with a fresh id, in list order', () => {
  const r = makeRegistry();
  const a = r.add('alpha', 'a.js');
  const b = r.add('beta', 'b.js');
  assert.notEqual(a.id, b.id);
  assert.equal(r.count(), 2);
  assert.deepEqual(r.list().map((e) => e.id), [a.id, b.id]);
  assert.equal(r.first().id, a.id);
});

test('get / has resolve by id; first is the default', () => {
  const r = makeRegistry();
  const a = r.add('x', 'x.js');
  assert.equal(r.get(a.id), a);
  assert.equal(r.has(a.id), true);
  assert.equal(r.has('nope'), false);
  assert.equal(r.get('nope'), null);
});

test('findByName resolves the C-x b switch path', () => {
  const r = makeRegistry();
  r.add('1', 'one.js');
  const two = r.add('2', 'two.js');
  assert.equal(r.findByName('two.js'), two);
  assert.equal(r.findByName('absent.js'), null);
});

test('name collisions get an Emacs-style <n> suffix; ids stay unique', () => {
  const r = makeRegistry();
  const a = r.add('', 'util.js');
  const b = r.add('', 'util.js');
  const c = r.add('', 'util.js');
  assert.equal(a.buffer.name, 'util.js');
  assert.equal(b.buffer.name, 'util.js<2>');
  assert.equal(c.buffer.name, 'util.js<3>');
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
});

// --- per-client views (the per-window vs per-buffer split) ------------

test('viewFor mints a fresh per-client view lazily and reuses it', () => {
  const r = makeRegistry();
  const a = r.add('hello', 'a.js');
  const v0 = r.viewFor(a.id, 0);
  assert.ok(v0);
  assert.equal(v0.point, 0);
  // Same client, same buffer → same view (cursor preserved on re-switch).
  assert.equal(r.viewFor(a.id, 0), v0);
  // Different client → its own view.
  const v1 = r.viewFor(a.id, 1);
  assert.notEqual(v1, v0);
  // Mutating one client's point doesn't touch the other's.
  v0.point = 5;
  assert.equal(r.viewFor(a.id, 1).point, 0);
});

test('two clients on different buffers keep independent views', () => {
  const r = makeRegistry();
  const a = r.add('aaa', 'a.js');
  const b = r.add('bbb', 'b.js');
  const va = r.viewFor(a.id, 0);
  const vb = r.viewFor(b.id, 1);
  va.point = 2;
  vb.point = 1;
  assert.equal(r.viewFor(a.id, 0).point, 2);
  assert.equal(r.viewFor(b.id, 1).point, 1);
});

test('viewFor on a missing buffer is null', () => {
  const r = makeRegistry();
  assert.equal(r.viewFor('ghost', 0), null);
});

// --- kill-buffer ------------------------------------------------------

test('remove deletes a buffer but refuses the last one', () => {
  const r = makeRegistry();
  const a = r.add('a', 'a.js');
  const b = r.add('b', 'b.js');
  assert.equal(r.remove(b.id), true);
  assert.equal(r.count(), 1);
  // The registry is never empty: removing the last is refused.
  assert.equal(r.remove(a.id), false);
  assert.equal(r.count(), 1);
});

test('remove of an unknown id is a no-op', () => {
  const r = makeRegistry();
  r.add('a', 'a.js');
  r.add('b', 'b.js');
  assert.equal(r.remove('nope'), false);
  assert.equal(r.count(), 2);
});

test('remove releases the killed buffer overlays markers', () => {
  const r = makeRegistry();
  const a = r.add('a', 'a.js');
  const b = r.add('hello world', 'b.js');
  r.addOverlay(b, 0, 5, 'search-match', 'search');
  let removed = false;
  // Spy: replace the overlay marker.remove to observe the release.
  const o = b.overlays[0];
  const origRemove = o.startM.remove.bind(o.startM);
  o.startM.remove = () => { removed = true; origRemove(); };
  assert.equal(r.remove(b.id), true);
  assert.equal(removed, true);
  void a;
});

// --- client detach ----------------------------------------------------

test('dropClient removes a client view from every buffer', () => {
  const r = makeRegistry();
  const a = r.add('a', 'a.js');
  const b = r.add('b', 'b.js');
  r.viewFor(a.id, 0);
  r.viewFor(a.id, 1);
  r.viewFor(b.id, 1);
  r.dropClient(1);
  // Client 1 dropped: a fresh viewFor re-mints (a NEW view, point 0).
  assert.equal(a.views.has(1), false);
  assert.equal(b.views.has(1), false);
  // Client 0 untouched.
  assert.equal(a.views.has(0), true);
  // Idempotent.
  r.dropClient(1);
  assert.equal(a.views.has(1), false);
});

// --- overlays (per-entry, edit-tracked) -------------------------------

test('addOverlay + overlaySnapshot report current offsets', () => {
  const r = makeRegistry();
  const a = r.add('alpha alpha alpha', 'a.txt');
  r.addOverlay(a, 0, 5, 'search-match', 'search');
  r.addOverlay(a, 6, 11, 'search-match', 'search');
  const snap = r.overlaySnapshot(a);
  assert.equal(snap.length, 2);
  assert.deepEqual(snap[0], { start: 0, end: 5, face: 'search-match', kind: 'search', id: snap[0].id });
});

test('overlays ride edits via markers; a collapsed overlay is dropped', () => {
  const r = makeRegistry();
  const a = r.add('0123456789', 'a.txt');
  r.addOverlay(a, 4, 7, 'hl'); // covers "456"
  // Insert "XX" at offset 0 → overlay shifts right to 6..9.
  a.buffer._splice(0, 0, 'XX');
  assert.deepEqual(r.overlaySnapshot(a)[0], {
    start: 6, end: 9, face: 'hl', kind: 'overlay', id: r.overlaySnapshot(a)[0].id,
  });
  // Delete the whole overlay region → it collapses and is dropped.
  a.buffer._splice(6, 3, '');
  assert.equal(r.overlaySnapshot(a).length, 0);
});

test('clearOverlays clears all or only a kind', () => {
  const r = makeRegistry();
  const a = r.add('aaaa bbbb cccc', 'a.txt');
  r.addOverlay(a, 0, 4, 'search-match', 'search');
  r.addOverlay(a, 5, 9, 'snippet-field', 'snippet');
  assert.equal(r.clearOverlays(a, 'search'), 1);
  assert.equal(r.overlaySnapshot(a).length, 1);
  assert.equal(r.overlaySnapshot(a)[0].kind, 'snippet');
  assert.equal(r.clearOverlays(a), 1); // clear the rest
  assert.equal(r.overlaySnapshot(a).length, 0);
});

test('overlays are per-buffer: one buffer overlay is not on another', () => {
  const r = makeRegistry();
  const a = r.add('aaaa', 'a.txt');
  const b = r.add('bbbb', 'b.txt');
  r.addOverlay(a, 0, 4, 'hl', 'search');
  assert.equal(r.overlaySnapshot(a).length, 1);
  assert.equal(r.overlaySnapshot(b).length, 0);
});

// --- buffer-list records ----------------------------------------------

test('listRecords reports name/lineCount/modified per buffer', () => {
  const r = makeRegistry();
  const a = r.add('one\ntwo', 'a.js');
  r.add('x', 'b.js');
  const recs = r.listRecords();
  assert.equal(recs.length, 2);
  assert.equal(recs[0].name, 'a.js');
  assert.equal(recs[0].lineCount, 2);
  assert.equal(recs[0].modified, false);
  // A mutation makes it modified.
  a.buffer._splice(0, 0, 'z');
  assert.equal(r.listRecords()[0].modified, true);
});
