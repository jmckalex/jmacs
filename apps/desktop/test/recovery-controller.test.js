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

test('save() writes immediately (leading edge), then once more after the burst', async () => {
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
  // Leading edge: a snapshot per dirty buffer right away (writeAll is
  // async, so let its writes settle), so a crash a fraction of a second
  // later still has work to recover.
  await wait(0);
  assert.equal(host.writes.length, 2, 'leading-edge snapshot per dirty buffer');
  assert.deepEqual(host.writes.map((w) => w.name).sort(), ['a', 'b']);
  await wait(50);
  // Plus one trailing write of the burst's final state.
  assert.equal(host.writes.length, 4, 'a trailing write after the burst settles');
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

test('clear() wipes all snapshots and cancels the pending trailing write', async () => {
  const host = fakeHost();
  const dirty = new Set([buf({ text: 'x' })]);
  const rec = createRecovery({
    getDirtyBuffers: () => dirty,
    host,
    now: () => 1,
    debounceMs: 20,
  });
  rec.save(); // leading-edge writes once immediately, schedules a trailing one
  const afterLeading = host.writes.length;
  await rec.clear();
  await wait(50);
  assert.equal(host.cleared(), 1);
  assert.equal(
    host.writes.length,
    afterLeading,
    'no further (trailing) write after clear cancelled it'
  );
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

test('getDebounceMs() is read live for the trailing write', async () => {
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
  assert.equal(host.writes.length, 1, 'leading write fires immediately');
  await wait(40);
  assert.equal(host.writes.length, 2, 'trailing write fires after the live debounce');
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

test('clear() waits for an in-flight write before wiping (no clear-vs-write race)', async () => {
  // Reproduces the quit-time ENOENT: a snapshot write is mid-flight (as an
  // atomic write is between its tmp-write and rename) when a clean quit
  // fires clear(). clear() must NOT remove the recovery dir until that
  // write has finished — otherwise the rename lands on a deleted dir.
  const order = [];
  let releaseWrite;
  const host = {
    writeRecovery: () => {
      order.push('write:start');
      return new Promise((resolve) => {
        releaseWrite = () => {
          order.push('write:end');
          resolve();
        };
      });
    },
    deleteRecovery: async () => {},
    clearRecovery: async () => {
      order.push('clear');
    },
  };
  const rec = createRecovery({
    getDirtyBuffers: () => new Set([buf({ text: 'x', filePath: '/x/a', name: 'a' })]),
    host,
    now: () => 1,
  });
  rec.flush(); // starts a write that hangs mid-flight
  await wait(0);
  assert.deepEqual(order, ['write:start'], 'a snapshot write is in flight');
  const cleared = rec.clear(); // clean quit clears while the write is live
  await wait(0);
  assert.deepEqual(
    order,
    ['write:start'],
    'clear() waits — no clearRecovery while the write is mid-flight'
  );
  releaseWrite(); // the write finishes its rename
  await cleared;
  assert.deepEqual(
    order,
    ['write:start', 'write:end', 'clear'],
    'the in-flight write completes, then clear wipes'
  );
});

test('no snapshot is written after a clean-quit clear() (nothing resurfaces)', async () => {
  const host = fakeHost();
  const rec = createRecovery({
    getDirtyBuffers: () => new Set([buf({ text: 'x' })]),
    host,
    now: () => 1,
    debounceMs: 5,
  });
  await rec.clear();
  assert.equal(host.cleared(), 1);
  // A late save/flush (e.g. a blur racing teardown) must be a no-op, so a
  // discarded snapshot can't reappear and trigger a spurious *Recover*.
  rec.save();
  await rec.flush();
  await wait(20);
  assert.equal(host.writes.length, 0, 'a closed controller writes nothing further');
});
