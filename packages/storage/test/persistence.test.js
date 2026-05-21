import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuffer, loadBuffer, saveBuffer } from '../src/index.js';

/**
 * Run `fn` with a fresh temp directory that is removed afterwards.
 * @param {(dir: string) => Promise<void>} fn
 */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'storage-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('saveBuffer writes the buffer contents to disk', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'note.txt');
    const buf = createBuffer('persisted text');
    await saveBuffer(buf, path);
    assert.equal(await readFile(path, 'utf8'), 'persisted text');
  });
});

test('loadBuffer reads a file into a buffer', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'note.txt');
    await saveBuffer(createBuffer('round trip\nsecond line'), path);
    const loaded = await loadBuffer(path);
    assert.equal(loaded.toString(), 'round trip\nsecond line');
    assert.equal(loaded.lineCount, 2);
  });
});

test('a loaded buffer is fully editable', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'note.txt');
    await saveBuffer(createBuffer('hello'), path);
    const loaded = await loadBuffer(path);
    loaded.insert(5, ' world');
    assert.equal(loaded.toString(), 'hello world');
  });
});

test('saveBuffer reflects edits made after loading', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'note.txt');
    const buf = createBuffer('draft');
    await saveBuffer(buf, path);
    buf.replace(0, 5, 'final');
    await saveBuffer(buf, path);
    assert.equal(await readFile(path, 'utf8'), 'final');
  });
});

test('loadBuffer rejects on a missing file', async () => {
  await assert.rejects(() => loadBuffer('/no/such/file/anywhere.txt'));
});
