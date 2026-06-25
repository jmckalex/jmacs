/**
 * @file Tests for the Model-B server-side autosave + crash recovery
 * (autosave.js).
 *
 * Two layers:
 *   - PURE helpers (no I/O): the recovery key, the snapshot record shape, and
 *     the which-to-recover predicate (the crux of crash recovery — mirroring
 *     app.js scanForRecovery).
 *   - The controller against a REAL temp dir (mkdtemp under os.tmpdir, cleaned
 *     up): snapshotOnce writes a recovery file per dirty buffer; scanRecoverable
 *     reads them back and selects the ones worth recovering. Never touches the
 *     repo or the user's data.
 *
 * Part of the `node --test` suite, so it stays green and verifies the
 * data-safety helpers without a screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  recoveryKey,
  recoveryRecord,
  selectRecoverable,
  createAutosave,
} from './autosave.js';

// --- pure helpers -----------------------------------------------------

test('recoveryKey is file:<path> for a path-backed buffer, buf:<id> otherwise', () => {
  assert.equal(recoveryKey({ id: 'b1', filePath: '/a/note.txt' }), 'file:/a/note.txt');
  assert.equal(recoveryKey({ id: 'b3', filePath: null }), 'buf:b3');
  assert.equal(recoveryKey({ id: 'b3', filePath: '' }), 'buf:b3'); // empty == path-less
});

test('recoveryRecord builds the production snapshot shape', () => {
  const rec = recoveryRecord(
    { id: 'b1', name: 'note.txt', filePath: '/a/note.txt', text: 'hello' },
    1000
  );
  assert.equal(rec.key, 'file:/a/note.txt');
  assert.equal(rec.path, '/a/note.txt');
  assert.equal(rec.name, 'note.txt');
  assert.equal(rec.text, 'hello');
  assert.equal(rec.savedAt, 1000);
  assert.equal(typeof rec.hash, 'string');
  assert.ok(rec.hash.length > 0);
});

test('selectRecoverable keeps a snapshot newer than its on-disk file', () => {
  const records = [
    // Newer than disk → unsaved edits were lost → RECOVER.
    { key: 'a', text: 'x', diskExists: true, diskModified: 100, savedAt: 200 },
    // Older than disk → the user already saved over it → SKIP.
    { key: 'b', text: 'y', diskExists: true, diskModified: 300, savedAt: 200 },
    // No on-disk file at all (path-less or deleted) → RECOVER.
    { key: 'c', text: 'z', diskExists: false, diskModified: null, savedAt: 50 },
  ];
  const kept = selectRecoverable(records).map((r) => r.key);
  assert.deepEqual(kept, ['a', 'c']);
});

test('selectRecoverable drops records with no text and tolerates junk', () => {
  assert.deepEqual(selectRecoverable(null), []);
  assert.deepEqual(
    selectRecoverable([null, { diskExists: false }, { text: 5, diskExists: false }]),
    []
  );
});

test('selectRecoverable drops an empty path-less scratch (the duplicate-scratch bug)', () => {
  const records = [
    // A pristine *scratch*: empty text + no file → nothing to recover → SKIP
    // (recovering it spawns a dirty-by-construction duplicate that reappears
    // every launch — the "two *scratch* on Start fresh" bug).
    { key: 's', name: '*scratch*', path: null, text: '', diskExists: false, diskModified: null, savedAt: 50 },
    // A file-BOUND buffer emptied + unsaved → deleting all the text is a real
    // lost edit → RECOVER.
    { key: 'f', name: 'notes.txt', path: '/n.txt', text: '', diskExists: false, diskModified: null, savedAt: 60 },
    // A path-less scratch WITH content the user jotted → RECOVER.
    { key: 'n', name: '*scratch*', path: null, text: 'jot', diskExists: false, diskModified: null, savedAt: 70 },
    // Whitespace-only path-less scratch is still "empty" → SKIP.
    { key: 'w', name: '*scratch*', path: null, text: '  \n ', diskExists: false, diskModified: null, savedAt: 80 },
  ];
  assert.deepEqual(selectRecoverable(records).map((r) => r.key), ['f', 'n']);
});

// --- the controller against a real temp dir ---------------------------

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mwb-autosave-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('snapshotOnce writes one recovery file per dirty buffer', () => {
  withTempDir((dir) => {
    let dirty = [
      { id: 'b1', name: 'a.txt', filePath: '/nope/a.txt', text: 'unsaved A' },
      { id: 'b2', name: 'b.txt', filePath: null, text: 'unsaved B' },
    ];
    const autosave = createAutosave({ dir, getDirty: () => dirty, now: () => 1234 });
    const n = autosave.snapshotOnce();
    assert.equal(n, 2);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 2);

    // No dirty buffers → nothing written.
    dirty = [];
    assert.equal(autosave.snapshotOnce(), 0);
  });
});

test('scanRecoverable reads snapshots back and offers the path-less ones', () => {
  withTempDir((dir) => {
    const dirty = [{ id: 'b2', name: 'b.txt', filePath: null, text: 'recover me' }];
    const autosave = createAutosave({ dir, getDirty: () => dirty, now: () => 9999 });
    autosave.snapshotOnce();
    const recoverable = autosave.scanRecoverable();
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].text, 'recover me');
    assert.equal(recoverable[0].name, 'b.txt');
    assert.equal(recoverable[0].diskExists, false); // path-less → always offered
  });
});

test('scanRecoverable skips a snapshot the user already saved over', () => {
  withTempDir((dir) => {
    // Write a real on-disk file, then a snapshot OLDER than it (saved over).
    const onDisk = join(dir, 'saved.txt');
    writeFileSync(onDisk, 'the saved content');
    const dirty = [{ id: 'b1', name: 'saved.txt', filePath: onDisk, text: 'stale' }];
    // savedAt far in the past → older than the file we just wrote → SKIP.
    const autosave = createAutosave({ dir, getDirty: () => dirty, now: () => 1 });
    autosave.snapshotOnce();
    const recoverable = autosave.scanRecoverable();
    assert.equal(recoverable.length, 0);
  });
});

test('scanRecoverable offers a snapshot newer than its on-disk file', () => {
  withTempDir((dir) => {
    const onDisk = join(dir, 'doc.txt');
    writeFileSync(onDisk, 'old content');
    const dirty = [{ id: 'b1', name: 'doc.txt', filePath: onDisk, text: 'newer edits' }];
    // savedAt far in the FUTURE → newer than the file → RECOVER.
    const autosave = createAutosave({ dir, getDirty: () => dirty, now: () => Date.now() + 1e7 });
    autosave.snapshotOnce();
    const recoverable = autosave.scanRecoverable();
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].text, 'newer edits');
  });
});

test('scanRecoverable returns [] for a missing dir and ignores junk files', () => {
  // A dir that was never created.
  const missing = join(tmpdir(), 'mwb-autosave-does-not-exist-xyz');
  const a = createAutosave({ dir: missing, getDirty: () => [] });
  assert.deepEqual(a.scanRecoverable(), []);
  // A real dir with a corrupt + a non-json file → both skipped, never throws.
  withTempDir((dir) => {
    writeFileSync(join(dir, 'corrupt.json'), '{ not valid json');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const autosave = createAutosave({ dir, getDirty: () => [] });
    assert.deepEqual(autosave.scanRecoverable(), []);
  });
});

test('clear removes the recovery dir', () => {
  withTempDir((dir) => {
    const dirty = [{ id: 'b1', name: 'a.txt', filePath: null, text: 'x' }];
    const autosave = createAutosave({ dir, getDirty: () => dirty });
    autosave.snapshotOnce();
    assert.ok(readdirSync(dir).length > 0);
    autosave.clear();
    assert.throws(() => readdirSync(dir)); // dir gone
  });
});
