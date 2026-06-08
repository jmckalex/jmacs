/**
 * @file Tests for atomicWrite — the crash-safe temp+rename file writer.
 * Uses a real temp directory (the function is pure filesystem, no
 * Electron), so the no-truncation guarantee is exercised end to end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWrite } from '../src/atomic-write.js';

/** Run `fn` against a fresh temp directory, cleaned up afterwards. */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'jmacs-atomic-'));
  try {
    await fn(dir);
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

test('atomicWrite creates a file with the given content', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'note.txt');
    await atomicWrite(target, 'hello world');
    assert.equal(await readFile(target, 'utf8'), 'hello world');
  });
});

test('atomicWrite overwrites an existing file', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'note.txt');
    await writeFile(target, 'old contents', 'utf8');
    await atomicWrite(target, 'new contents');
    assert.equal(await readFile(target, 'utf8'), 'new contents');
  });
});

test('atomicWrite leaves no temp files behind on success', async () => {
  await withTempDir(async (dir) => {
    await atomicWrite(join(dir, 'note.txt'), 'x');
    assert.deepEqual(await readdir(dir), ['note.txt']);
  });
});

test('atomicWrite writes binary (Uint8Array) content verbatim', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'bytes.bin');
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    await atomicWrite(target, bytes);
    assert.deepEqual(new Uint8Array(await readFile(target)), bytes);
  });
});

test('a failed write leaves the existing target intact (no truncation)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('read-only-directory simulation is POSIX-only');
    return;
  }
  await withTempDir(async (dir) => {
    const target = join(dir, 'precious.txt');
    const original = 'original — must survive a failed save';
    await writeFile(target, original, 'utf8');
    // Make the directory read-only so the sibling temp file can't be
    // created: the write must fail *without* having touched the target.
    await chmod(dir, 0o500);
    await assert.rejects(() => atomicWrite(target, 'DATA THAT MUST NOT LAND'));
    await chmod(dir, 0o700);
    // The original is byte-for-byte intact, and no temp litter remains.
    assert.equal(await readFile(target, 'utf8'), original);
    assert.deepEqual(await readdir(dir), ['precious.txt']);
  });
});
