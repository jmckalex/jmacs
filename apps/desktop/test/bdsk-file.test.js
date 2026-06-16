/**
 * @file Tests for bdsk-file.js — turning a BibDesk `Bdsk-File-N` value into
 * the real path of its attachment. The native bookmark resolution needs
 * macOS + osascript + a real file, so it isn't unit-tested here; what IS
 * tested is the pure path-decision logic (`resolveAttachmentPath`): bookmark
 * preferred, `relativePath` fallback anchored to the bib's real directory,
 * symlink handling, and rejection of non-files. Real temp dirs, no Electron.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { resolveAttachmentPath, resolveBdskFile } from '../src/bdsk-file.js';

/** Run `fn` against a fresh temp dir, cleaned up afterwards. */
async function withTempDir(fn) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'jmacs-bdsk-')));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('resolveAttachmentPath: a resolved bookmark path wins', async () => {
  await withTempDir(async (dir) => {
    const pdf = join(dir, 'paper.pdf');
    await writeFile(pdf, '%PDF');
    const bib = join(dir, 'refs.bib');
    await writeFile(bib, '@book{a}');
    // Even with a relativePath present, the bookmark path is preferred.
    assert.equal(
      resolveAttachmentPath({ path: pdf, rel: '../elsewhere.pdf' }, bib),
      pdf
    );
  });
});

test('resolveAttachmentPath: falls back to relativePath against the bib dir', async () => {
  await withTempDir(async (dir) => {
    // Layout: <dir>/bibs/refs.bib  and  <dir>/pdfs/paper.pdf
    // relativePath "../pdfs/paper.pdf" is relative to the .bib's directory.
    await mkdir(join(dir, 'bibs'));
    await mkdir(join(dir, 'pdfs'));
    const pdf = join(dir, 'pdfs', 'paper.pdf');
    await writeFile(pdf, '%PDF');
    const bib = join(dir, 'bibs', 'refs.bib');
    await writeFile(bib, '@book{a}');
    // Bookmark unresolved (null) — only the relativePath remains.
    assert.equal(
      resolveAttachmentPath({ path: null, rel: '../pdfs/paper.pdf' }, bib),
      pdf
    );
  });
});

test('resolveAttachmentPath: relativePath anchors to the bib\'s REAL dir (symlink)', async () => {
  await withTempDir(async (dir) => {
    // The real bib lives in <dir>/master, with the PDF beside it; the doc
    // folder reaches it through a symlink. The relativePath must resolve
    // against the symlink's *target* directory, not the link's location.
    await mkdir(join(dir, 'master'));
    await mkdir(join(dir, 'doc'));
    const pdf = join(dir, 'master', 'paper.pdf');
    await writeFile(pdf, '%PDF');
    const realBib = join(dir, 'master', 'refs.bib');
    await writeFile(realBib, '@book{a}');
    const link = join(dir, 'doc', 'bibliography.bib');
    try {
      await symlink(realBib, link);
    } catch {
      return; // symlink unsupported here — skip
    }
    assert.equal(
      resolveAttachmentPath({ path: null, rel: 'paper.pdf' }, link),
      pdf
    );
  });
});

test('resolveAttachmentPath: an absolute relativePath is honoured as-is', async () => {
  await withTempDir(async (dir) => {
    const pdf = join(dir, 'paper.pdf');
    await writeFile(pdf, '%PDF');
    const bib = join(dir, 'refs.bib');
    await writeFile(bib, '@book{a}');
    assert.equal(resolveAttachmentPath({ path: null, rel: pdf }, bib), pdf);
  });
});

test('resolveAttachmentPath: a directory (e.g. an .app bundle) is rejected', async () => {
  await withTempDir(async (dir) => {
    const bundle = join(dir, 'Evil.app');
    await mkdir(bundle);
    const bib = join(dir, 'refs.bib');
    await writeFile(bib, '@book{a}');
    // The "bookmark" resolved to a directory — not openable as a document.
    assert.equal(resolveAttachmentPath({ path: bundle, rel: null }, bib), null);
  });
});

test('resolveAttachmentPath: nothing existing → null', async () => {
  await withTempDir(async (dir) => {
    const bib = join(dir, 'refs.bib');
    await writeFile(bib, '@book{a}');
    assert.equal(
      resolveAttachmentPath({ path: join(dir, 'gone.pdf'), rel: '../also-gone.pdf' }, bib),
      null
    );
  });
});

test('resolveAttachmentPath: no relativePath and no bookmark → null', () => {
  assert.equal(resolveAttachmentPath({ path: null, rel: null }), null);
  assert.equal(resolveAttachmentPath({ path: null, rel: 'x.pdf' }, undefined), null);
});

test('resolveBdskFile: empty input resolves to null (no spawn)', async () => {
  assert.equal(await resolveBdskFile(''), null);
  assert.equal(await resolveBdskFile(null), null);
});
