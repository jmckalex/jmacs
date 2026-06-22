/**
 * @file END-TO-END save + data-safety integration test, headless.
 *
 * The spine and autosave unit tests use recording fakes; this test wires the
 * spine's `saveFile` effect to the REAL synchronous atomic writer and the
 * autosave to a REAL temp recovery dir, then drives the actual save-buffer /
 * write-file path and READS THE BYTES BACK OFF DISK — the same end-to-end
 * proof the Electron `MWB_SAVE_SELFTEST` self-test performs, but under
 * `node --test` (the guardrail's preferred verification: assert + clean exit,
 * no Electron, never crashes the main process). All I/O is in a temp dir that
 * is cleaned up; the repo and user data are never touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSpine } from './spine.js';
import { atomicWriteSync } from './atomic-write-sync.js';
import { createAutosave } from './autosave.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mwb-save-e2e-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A spine whose saveFile does a REAL atomic disk write. */
function makeRealSpine() {
  return createSpine(
    { initialText: 'seed\n', name: 'scratch.txt' },
    {
      // The real openFile: read the file off disk (find-file).
      openFile: (path) => {
        try {
          return { text: readFileSync(path, 'utf8'), name: 'scratch.txt', path };
        } catch {
          return null;
        }
      },
      // The real saveFile: an atomic temp-file + rename, like server.js.
      saveFile: ({ path, text }) => {
        try {
          atomicWriteSync(path, text);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      },
    }
  );
}

test('save-buffer writes the edited bytes to disk (atomic) and clears dirty', () => {
  withTempDir((dir) => {
    const target = join(dir, 'note.txt');
    writeFileSync(target, 'original line\n', 'utf8');

    const spine = makeRealSpine();
    // find-file the scratch file → active buffer with a path.
    const id = spine.visitFile(target);
    assert.ok(id);
    assert.equal(spine.activeFilePath, target);
    assert.equal(spine.activeModified, false);

    // Edit it → dirty + ● modeline.
    spine.handleKey('M-greater');
    for (const ch of 'EDIT') spine.handleKey(ch);
    assert.equal(spine.activeModified, true);
    assert.ok(spine.viewState().modeline.startsWith('●'), 'dirty shows ●');
    const expected = spine.buffer.text;

    // Save through the REAL command (C-x C-s).
    spine.handleKey('C-x');
    spine.handleKey('C-s');

    // READ THE FILE BACK: the edited bytes hit disk.
    const onDisk = readFileSync(target, 'utf8');
    assert.equal(onDisk, expected);
    assert.ok(onDisk.includes('EDIT'), 'the edit reached disk');

    // The buffer is clean again; ● gone.
    assert.equal(spine.activeModified, false);
    assert.ok(spine.viewState().modeline.startsWith('–'), 'clean drops ●');
  });
});

test('write-file (save-as) writes to a brand-new path and binds it', () => {
  withTempDir((dir) => {
    const spine = makeRealSpine();
    for (const ch of 'hello') spine.handleKey(ch);
    const target = join(dir, 'out.txt');
    assert.equal(spine.writeActiveBufferTo(target), 'ok');
    assert.ok(existsSync(target));
    assert.equal(readFileSync(target, 'utf8'), spine.buffer.text);
    assert.equal(spine.activeFilePath, target); // path now bound
    assert.equal(spine.activeModified, false);
  });
});

test('autosave snapshots a dirty buffer to disk; scan recovers it', () => {
  withTempDir((dir) => {
    const recoveryDir = join(dir, 'recovery');
    const target = join(dir, 'doc.txt');
    writeFileSync(target, 'saved content\n', 'utf8');

    const spine = makeRealSpine();
    spine.visitFile(target);
    // Edit but do NOT save → unsaved work in the server's memory.
    spine.handleKey('M-greater');
    for (const ch of 'UNSAVED') spine.handleKey(ch);
    assert.equal(spine.activeModified, true);

    const autosave = createAutosave({
      dir: recoveryDir,
      getDirty: () => spine.dirtyBufferSnapshots(),
      now: () => Date.now() + 1e7, // newer than the on-disk file → recoverable
    });

    // Force an autosave pass → a recovery snapshot lands on disk.
    const written = autosave.snapshotOnce();
    assert.ok(written >= 1, 'a snapshot was written');

    // The recover-on-startup scan offers it (the unsaved edit is in its text).
    const recoverable = autosave.scanRecoverable();
    const mine = recoverable.find((r) => r.path === target);
    assert.ok(mine, 'the snapshot is recoverable');
    assert.ok(mine.text.includes('UNSAVED'), 'the unsaved edit is in the snapshot');

    // After a real save, the buffer is clean — a fresh snapshot of nothing.
    spine.handleKey('C-x');
    spine.handleKey('C-s');
    assert.equal(spine.activeModified, false);
    assert.equal(autosave.snapshotOnce(), 0, 'a clean buffer is not snapshotted');
  });
});
