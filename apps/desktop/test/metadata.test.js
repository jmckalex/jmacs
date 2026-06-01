/**
 * @file Tests for the per-file companion-metadata helpers — the hidden
 * path scheme, the legacy path, and the generic emptiness rule (which
 * also guards the data-loss regression where emptying one section would
 * delete another section's data).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { metadataPath, legacyMetadataPath, isEmptyMetadata } from '../src/metadata.js';

test('metadataPath is a hidden sibling .NAME.godot-metadata', () => {
  assert.equal(metadataPath('/foo/bar.txt'), '/foo/.bar.txt.godot-metadata');
  assert.equal(metadataPath('/a/b/c.md'), '/a/b/.c.md.godot-metadata');
});

test('legacyMetadataPath is the pre-rename visible sidecar', () => {
  assert.equal(legacyMetadataPath('/foo/bar.txt'), '/foo/bar.txt.jmacs-metadata');
});

test('isEmptyMetadata: empty / version-only / all-empty-sections count as empty', () => {
  assert.equal(isEmptyMetadata(null), true);
  assert.equal(isEmptyMetadata({}), true);
  assert.equal(isEmptyMetadata({ version: 1 }), true);
  assert.equal(isEmptyMetadata({ version: 1, notes: [], bookmarks: [] }), true);
});

test('isEmptyMetadata: any non-empty section is content', () => {
  assert.equal(isEmptyMetadata({ notes: [{ id: 'x' }] }), false);
  assert.equal(isEmptyMetadata({ version: 1, notes: [], bookmarks: [{ id: 'b' }] }), false);
});

test('deleting the last note keeps a file that still has bookmarks (no data loss)', () => {
  assert.equal(
    isEmptyMetadata({ version: 1, notes: [], bookmarks: [{ name: 'top', anchor: 0 }] }),
    false
  );
});
