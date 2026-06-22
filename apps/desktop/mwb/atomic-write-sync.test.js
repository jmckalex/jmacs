/**
 * @file Tests for the synchronous atomic writer (atomic-write-sync.js) — the
 * crash-safe save the Model-B server uses for save-buffer / write-file.
 *
 * Asserts the bytes land on disk, an overwrite replaces the old content, and
 * a failed write leaves the original untouched (the whole point of atomic
 * temp-then-rename). Uses a real temp dir, cleaned up. No Electron.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { atomicWriteSync } from './atomic-write-sync.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mwb-atomic-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('atomicWriteSync writes the bytes to disk', () => {
  withTempDir((dir) => {
    const target = join(dir, 'out.txt');
    atomicWriteSync(target, 'hello world\n');
    assert.equal(readFileSync(target, 'utf8'), 'hello world\n');
  });
});

test('atomicWriteSync overwrites existing content and leaves no temp file', () => {
  withTempDir((dir) => {
    const target = join(dir, 'doc.txt');
    atomicWriteSync(target, 'first');
    atomicWriteSync(target, 'second');
    assert.equal(readFileSync(target, 'utf8'), 'second');
    // No leftover temp file — only the target remains.
    assert.deepEqual(readdirSync(dir), ['doc.txt']);
  });
});

test('a failed write leaves the original file untouched and no temp behind', () => {
  withTempDir((dir) => {
    const target = join(dir, 'safe.txt');
    atomicWriteSync(target, 'original');
    // Force a failure: the destination DIRECTORY does not exist, so the
    // rename target is invalid. The original file must survive.
    const bad = join(dir, 'no-such-subdir', 'x.txt');
    assert.throws(() => atomicWriteSync(bad, 'junk'));
    assert.equal(readFileSync(target, 'utf8'), 'original');
    // The temp file (a sibling of the bad target) never lands in `dir`.
    assert.deepEqual(readdirSync(dir), ['safe.txt']);
  });
});
