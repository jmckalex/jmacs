/**
 * @file Tests for the `__host__` route allowlist — the guard that stops
 * an opened document from reading arbitrary files off disk. Pure boundary
 * logic plus real-temp-dir checks (no Electron).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  allowHostDir,
  hostPathAllowed,
  pathUnderAnyRoot,
  resetHostRootsForTest,
} from '../src/host-allowlist.js';

// --- pure boundary logic -----------------------------------------------

test('pathUnderAnyRoot: a path inside a root is allowed', () => {
  assert.equal(pathUnderAnyRoot('/a/b/c.png', ['/a/b']), true);
  assert.equal(pathUnderAnyRoot('/a/b', ['/a/b']), true); // the root itself
});

test('pathUnderAnyRoot: a path outside every root is refused', () => {
  assert.equal(pathUnderAnyRoot('/etc/passwd', ['/a/b']), false);
  assert.equal(pathUnderAnyRoot('/a/c/x', ['/a/b']), false);
});

test('pathUnderAnyRoot: respects the directory boundary (no prefix leak)', () => {
  // `/a/bee` must NOT count as inside `/a/b` just because the string
  // starts with it.
  assert.equal(pathUnderAnyRoot('/a/bee/x', ['/a/b']), false);
});

test('pathUnderAnyRoot: any matching root allows it', () => {
  assert.equal(pathUnderAnyRoot('/two/x', ['/one', '/two']), true);
});

// --- against a real filesystem -----------------------------------------

/** Run `fn` against a fresh temp dir with the allowlist reset. */
async function withTempDir(fn) {
  resetHostRootsForTest();
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'jmacs-host-')));
  try {
    await fn(dir);
  } finally {
    resetHostRootsForTest();
    await rm(dir, { recursive: true, force: true });
  }
}

test('an allowed directory serves its files (incl. subdirs); outside is refused', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'doc.md'), '# hi');
    await mkdir(join(dir, 'img'));
    await writeFile(join(dir, 'img', 'a.png'), 'png');
    allowHostDir(dir);

    assert.equal(hostPathAllowed(join(dir, 'doc.md')), true);
    assert.equal(hostPathAllowed(join(dir, 'img', 'a.png')), true, 'subdir allowed');
    assert.equal(hostPathAllowed('/etc/passwd'), false, 'outside refused');
  });
});

test('an un-allowed directory serves nothing', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'secret.txt'), 'x');
    // Never call allowHostDir(dir).
    assert.equal(hostPathAllowed(join(dir, 'secret.txt')), false);
  });
});

test('a symlink inside an allowed dir cannot escape it', async () => {
  await withTempDir(async (dir) => {
    // dir/link -> /etc/passwd. The folder is allowed, but the link's real
    // path is outside it, so serving it is refused.
    const link = join(dir, 'link');
    try {
      await symlink('/etc/passwd', link);
    } catch {
      return; // symlink unsupported here — skip
    }
    allowHostDir(dir);
    assert.equal(hostPathAllowed(link), false, 'symlink escape blocked');
  });
});

test('a missing path is refused', async () => {
  await withTempDir(async (dir) => {
    allowHostDir(dir);
    assert.equal(hostPathAllowed(join(dir, 'nope.txt')), false);
  });
});
