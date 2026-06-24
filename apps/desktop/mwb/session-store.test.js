/**
 * @file Tests for the named-session store (session-store.js). IO is an in-memory
 * buffer; the clock + id source are injected for determinism. Part of `node
 * --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionStore, flatToWindowSession } from './session-store.js';

/** An in-memory IO pair (shared by two stores to prove persistence). */
function memIO(initial = null) {
  let buf = initial;
  return { read: () => buf, write: (s) => { buf = s; }, peek: () => buf };
}

/** Deterministic clock + id source. */
function deterministic() {
  let n = 0;
  return { now: () => 1000, mintId: () => `id${++n}` };
}

const WIN = (path) => ({
  rootPane: { kind: 'leaf', focused: true, view: { kind: 'text', path, point: 0, mark: null } },
  bounds: { x: 0, y: 0, width: 1040, height: 880 },
  display: { id: 1, workArea: { x: 0, y: 0, width: 1512, height: 887 } },
});

test('a fresh store is empty', () => {
  const io = memIO();
  const store = createSessionStore({ ...io, ...deterministic() });
  assert.deepEqual(store.list(), { sessions: [], hasLast: false });
  assert.equal(store.get('__last__'), null);
});

test('save → list → get, and it persists across a fresh store over the same file', () => {
  const io = memIO();
  const det = deterministic();
  const s1 = createSessionStore({ read: io.read, write: io.write, ...det });
  const id = s1.save({ label: 'Chapter 7', windows: [WIN('/a.md'), WIN('/b.md')], activeWindow: 1 });
  const listed = s1.list();
  assert.equal(listed.sessions.length, 1);
  assert.deepEqual(listed.sessions[0], { id, label: 'Chapter 7', savedAt: 1000, windowCount: 2 });

  // A SECOND store reading the same buffer sees the saved session (persistence).
  const s2 = createSessionStore({ read: io.read, write: io.write, ...deterministic() });
  const got = s2.get(id);
  assert.equal(got.label, 'Chapter 7');
  assert.equal(got.windows.length, 2);
  assert.equal(got.activeWindow, 1);
});

test('writeLast populates the reserved snapshot; list reports hasLast', () => {
  const io = memIO();
  const store = createSessionStore({ ...io, ...deterministic() });
  store.writeLast({ windows: [WIN('/x.md')], activeWindow: 0 });
  assert.equal(store.list().hasLast, true);
  const last = store.get('__last__');
  assert.equal(last.id, '__last__');
  assert.equal(last.windows.length, 1);
});

test('remove deletes a saved session and clears the last snapshot', () => {
  const io = memIO();
  const store = createSessionStore({ ...io, ...deterministic() });
  const id = store.save({ label: 'A', windows: [WIN('/a')], activeWindow: 0 });
  store.writeLast({ windows: [WIN('/x')], activeWindow: 0 });
  assert.equal(store.remove(id), true);
  assert.equal(store.list().sessions.length, 0);
  assert.equal(store.remove(id), false, 'removing a gone session is a no-op');
  assert.equal(store.remove('__last__'), true);
  assert.equal(store.list().hasLast, false);
});

test('an old flat { files, active } session migrates into the last-session slot', () => {
  const flat = JSON.stringify({ files: ['/a.md', '/b.md', '/c.md'], active: '/b.md' });
  const io = memIO(flat);
  const store = createSessionStore({ ...io, ...deterministic() });
  assert.equal(store.list().sessions.length, 0, 'no named sessions yet');
  const last = store.get('__last__');
  assert.ok(last, 'flat content became the last-session snapshot');
  const view = last.windows[0].rootPane.view;
  assert.equal(view.kind, 'tabline');
  assert.deepEqual(view.tabs.map((t) => t.path), ['/a.md', '/b.md', '/c.md']);
  assert.equal(view.active, 1, 'active index points at /b.md');
});

test('flatToWindowSession returns null for an empty file list', () => {
  assert.equal(flatToWindowSession({ files: [], active: null }), null);
  assert.equal(flatToWindowSession({}), null);
});

test('garbage store contents → empty store, never throws', () => {
  for (const bad of ['not json', '42', 'null', '{"unexpected":true}']) {
    const store = createSessionStore({ read: () => bad, write: () => {}, ...deterministic() });
    assert.deepEqual(store.list(), { sessions: [], hasLast: false });
  }
});
