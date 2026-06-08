import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRecovery } from '../src/recovery-controller.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A recording recovery-IPC stand-in. */
function fakeHost() {
  const writes = [];
  const deletes = [];
  let cleared = 0;
  return {
    writeRecovery: async (record) => {
      writes.push(record);
    },
    deleteRecovery: async (key) => {
      deletes.push(key);
    },
    clearRecovery: async () => {
      cleared += 1;
    },
    writes,
    deletes,
    cleared: () => cleared,
  };
}

const buf = (fields) => ({ text: '', name: 'untitled', filePath: null, ...fields });

test('save() debounces, then snapshots every dirty buffer', async () => {
  const host = fakeHost();
  const dirty = new Set([buf({ name: 'a', text: 'A' }), buf({ name: 'b', text: 'B' })]);
  const rec = createRecovery({
    getDirtyBuffers: () => dirty,
    host,
    now: () => 1000,
    debounceMs: 20,
  });
  rec.save();
  rec.save();
  rec.save();
  assert.equal(host.writes.length, 0, 'nothing written before the debounce elapses');
  await wait(50);
  assert.equal(host.writes.length, 2, 'one snapshot per dirty buffer, collapsed to one tick');
  assert.deepEqual(host.writes.map((w) => w.name).sort(), ['a', 'b']);
});

test('a record carries key, path, name, text, savedAt and a content hash', async () => {
  const host = fakeHost();
  const dirty = new Set([buf({ name: 'notes.txt', filePath: '/x/notes.txt', text: 'hello' })]);
  const rec = createRecovery({ getDirtyBuffers: () => dirty, host, now: () => 42 });
  await rec.flush();
  const r = host.writes[0];
  assert.equal(r.key, 'file:/x/notes.txt');
  assert.equal(r.path, '/x/notes.txt');
  assert.equal(r.name, 'notes.txt');
  assert.equal(r.text, 'hello');
  assert.equal(r.savedAt, 42);
  assert.equal(typeof r.hash, 'string');
  assert.ok(r.hash.length > 0);
});

test('a path-less buffer keys by an in-session buf:<n>, path is null', async () => {
  const host = fakeHost();
  const dirty = new Set([buf({ name: '*scratch*', filePath: null, text: 'draft' })]);
  const rec = createRecovery({ getDirtyBuffers: () => dirty, host, now: () => 1 });
  await rec.flush();
  assert.match(host.writes[0].key, /^buf:\d+$/);
  assert.equal(host.writes[0].path, null);
});

test('the per-buffer key is stable even after the buffer gains a path', async () => {
  const host = fakeHost();
  const b = buf({ name: '*scratch*', filePath: null, text: 'draft' });
  const dirty = new Set([b]);
  const rec = createRecovery({ getDirtyBuffers: () => dirty, host, now: () => 1 });
  await rec.flush();
  const firstKey = host.writes[0].key; // buf:1
  // The buffer is saved-as: it now has a path. The cached key must not change.
  b.filePath = '/x/draft.txt';
  await rec.flush();
  assert.equal(host.writes[1].key, firstKey, 'key stays buf:1, so forget() can find it');
});

test('forget() deletes the snapshot under the buffer\'s cached key', async () => {
  const host = fakeHost();
  const b = buf({ name: '*scratch*', filePath: null, text: 'x' });
  const rec = createRecovery({ getDirtyBuffers: () => new Set([b]), host, now: () => 1 });
  await rec.flush();
  const key = host.writes[0].key;
  await rec.forget(b);
  assert.deepEqual(host.deletes, [key]);
});

test('clear() wipes all snapshots and cancels a pending debounced write', async () => {
  const host = fakeHost();
  const dirty = new Set([buf({ text: 'x' })]);
  const rec = createRecovery({
    getDirtyBuffers: () => dirty,
    host,
    now: () => 1,
    debounceMs: 20,
  });
  rec.save();
  await rec.clear();
  await wait(50);
  assert.equal(host.cleared(), 1);
  assert.equal(host.writes.length, 0, 'the pending debounced write was cancelled');
});

test('isEnabled() false → no snapshots written (save or flush)', async () => {
  const host = fakeHost();
  let on = false;
  const rec = createRecovery({
    getDirtyBuffers: () => new Set([buf({ text: 'x' })]),
    host,
    now: () => 1,
    debounceMs: 10,
    isEnabled: () => on,
  });
  rec.save();
  await rec.flush();
  await wait(30);
  assert.equal(host.writes.length, 0, 'disabled autosave writes nothing');
  // Re-enable: flush now writes.
  on = true;
  await rec.flush();
  assert.equal(host.writes.length, 1);
});

test('getDebounceMs() is read live on each save()', async () => {
  const host = fakeHost();
  let ms = 15;
  const rec = createRecovery({
    getDirtyBuffers: () => new Set([buf({ text: 'x' })]),
    host,
    now: () => 1,
    getDebounceMs: () => ms,
  });
  ms = 10;
  rec.save();
  await wait(40);
  assert.equal(host.writes.length, 1);
});

test('a write failure is swallowed — editing is never broken', async () => {
  const host = fakeHost();
  host.writeRecovery = async () => {
    throw new Error('disk full');
  };
  const rec = createRecovery({
    getDirtyBuffers: () => new Set([buf({ text: 'x' })]),
    host,
    now: () => 1,
  });
  await assert.doesNotReject(rec.flush());
});
