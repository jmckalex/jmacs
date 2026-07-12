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
import {
  mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { atomicWriteSync, sweepStaleTemps } from './atomic-write-sync.js';

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

/** Create a temp-shaped file with a controlled mtime (ms in the past). */
function makeTemp(dir, name, ageMs) {
  const p = join(dir, name);
  writeFileSync(p, 'x');
  const when = new Date(Date.now() - ageMs);
  utimesSync(p, when, when);
  return p;
}

test('sweepStaleTemps removes orphaned temps but keeps real files', () => {
  withTempDir((dir) => {
    makeTemp(dir, '.session.json.tmp-111-1700000000000', 5 * 60_000); // 5 min old
    makeTemp(dir, '.custom.lisp.tmp-222-1700000000001', 5 * 60_000);
    writeFileSync(join(dir, 'session.json'), 'real'); // a real file — must survive
    const removed = sweepStaleTemps(dir);
    assert.equal(removed, 2);
    assert.deepEqual(readdirSync(dir).sort(), ['session.json']);
  });
});

test('sweepStaleTemps spares a recent temp (a concurrent in-flight write)', () => {
  withTempDir((dir) => {
    makeTemp(dir, '.session.json.tmp-333-1700000000002', 1000); // 1s old
    assert.equal(sweepStaleTemps(dir), 0); // default 60s threshold
    assert.deepEqual(readdirSync(dir), ['.session.json.tmp-333-1700000000002']);
  });
});

test('sweepStaleTemps ignores non-temp files and a missing dir (no throw)', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'session.json'), 'real');
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    assert.equal(sweepStaleTemps(dir), 0);
    assert.deepEqual(readdirSync(dir).sort(), ['notes.txt', 'session.json']);
  });
  assert.equal(sweepStaleTemps('/no/such/dir/anywhere-xyz'), 0);
});
