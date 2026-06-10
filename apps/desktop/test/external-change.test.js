/**
 * @file Tests for the external-change tracker — the guard that stops a
 * save from silently clobbering a file another program rewrote.
 *
 * Uses an injectable `statFn` so the (mtime, size) decision logic is
 * exercised directly, with no real filesystem or Electron.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChangeTracker } from '../src/external-change.js';

/** A fake filesystem: a Map of path -> {mtimeMs, size}; missing = throws. */
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const statFn = async (path) => {
    if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
    return files.get(path);
  };
  return { files, statFn };
}

test('no baseline → not a conflict (first save / save-as is explicit)', async () => {
  const { statFn } = fakeFs({ '/a.txt': { mtimeMs: 100, size: 10 } });
  const tracker = createChangeTracker({ statFn });
  // Never noted /a.txt.
  assert.equal(await tracker.changedSinceNoted('/a.txt'), false);
});

test('unchanged file → not a conflict', async () => {
  const { statFn } = fakeFs({ '/a.txt': { mtimeMs: 100, size: 10 } });
  const tracker = createChangeTracker({ statFn });
  await tracker.note('/a.txt');
  assert.equal(await tracker.changedSinceNoted('/a.txt'), false);
});

test('a changed mtime is a conflict', async () => {
  const { files, statFn } = fakeFs({ '/a.txt': { mtimeMs: 100, size: 10 } });
  const tracker = createChangeTracker({ statFn });
  await tracker.note('/a.txt');
  files.set('/a.txt', { mtimeMs: 200, size: 10 }); // touched, same size
  assert.equal(await tracker.changedSinceNoted('/a.txt'), true);
});

test('a changed size is a conflict', async () => {
  const { files, statFn } = fakeFs({ '/a.txt': { mtimeMs: 100, size: 10 } });
  const tracker = createChangeTracker({ statFn });
  await tracker.note('/a.txt');
  files.set('/a.txt', { mtimeMs: 100, size: 99 }); // same mtime, grew
  assert.equal(await tracker.changedSinceNoted('/a.txt'), true);
});

test('re-noting after a write clears the conflict', async () => {
  const { files, statFn } = fakeFs({ '/a.txt': { mtimeMs: 100, size: 10 } });
  const tracker = createChangeTracker({ statFn });
  await tracker.note('/a.txt');
  files.set('/a.txt', { mtimeMs: 200, size: 20 });
  assert.equal(await tracker.changedSinceNoted('/a.txt'), true);
  // Simulate our own save re-baselining the on-disk state.
  await tracker.note('/a.txt');
  assert.equal(await tracker.changedSinceNoted('/a.txt'), false);
});

test('a file deleted on disk is not a conflict (save recreates it)', async () => {
  const { files, statFn } = fakeFs({ '/a.txt': { mtimeMs: 100, size: 10 } });
  const tracker = createChangeTracker({ statFn });
  await tracker.note('/a.txt');
  files.delete('/a.txt');
  assert.equal(await tracker.changedSinceNoted('/a.txt'), false);
});

test('noting a missing file drops any stale baseline', async () => {
  const { files, statFn } = fakeFs({ '/a.txt': { mtimeMs: 100, size: 10 } });
  const tracker = createChangeTracker({ statFn });
  await tracker.note('/a.txt');
  // File vanishes, then a different file reappears at the same path; the
  // failed note must not leave the old baseline in place.
  files.delete('/a.txt');
  await tracker.note('/a.txt'); // stat throws → baseline forgotten
  files.set('/a.txt', { mtimeMs: 500, size: 50 });
  assert.equal(
    await tracker.changedSinceNoted('/a.txt'),
    false,
    'no baseline after a failed note, so no false conflict'
  );
});

test('forget() drops the baseline', async () => {
  const { statFn } = fakeFs({ '/a.txt': { mtimeMs: 100, size: 10 } });
  const tracker = createChangeTracker({ statFn });
  await tracker.note('/a.txt');
  tracker.forget('/a.txt');
  assert.equal(await tracker.changedSinceNoted('/a.txt'), false);
});

test('tracks paths independently', async () => {
  const { files, statFn } = fakeFs({
    '/a.txt': { mtimeMs: 1, size: 1 },
    '/b.txt': { mtimeMs: 2, size: 2 },
  });
  const tracker = createChangeTracker({ statFn });
  await tracker.note('/a.txt');
  await tracker.note('/b.txt');
  files.set('/b.txt', { mtimeMs: 9, size: 2 });
  assert.equal(await tracker.changedSinceNoted('/a.txt'), false);
  assert.equal(await tracker.changedSinceNoted('/b.txt'), true);
});
