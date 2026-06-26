/**
 * @file Tests for mwb/media-kinds.js — suffix → non-text view kind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mediaKindForName } from './media-kinds.js';

test('maps image / audio / video / pdf suffixes to their view kind', () => {
  assert.equal(mediaKindForName('a.png'), 'image');
  assert.equal(mediaKindForName('a.jpg'), 'image');
  assert.equal(mediaKindForName('a.svg'), 'image');
  assert.equal(mediaKindForName('song.mp3'), 'audio');
  assert.equal(mediaKindForName('song.flac'), 'audio');
  assert.equal(mediaKindForName('clip.mp4'), 'video');
  assert.equal(mediaKindForName('clip.mkv'), 'video');
  assert.equal(mediaKindForName('doc.pdf'), 'pdf');
});

test('is case-insensitive and works on full paths', () => {
  assert.equal(mediaKindForName('/Users/x/Movie.MP4'), 'video');
  assert.equal(mediaKindForName('/a/b/PHOTO.JPEG'), 'image');
});

test('returns null for text files and the unknown / extension-less', () => {
  assert.equal(mediaKindForName('notes.md'), null);
  assert.equal(mediaKindForName('main.js'), null);
  assert.equal(mediaKindForName('Makefile'), null);
  assert.equal(mediaKindForName(''), null);
  assert.equal(mediaKindForName(null), null);
  assert.equal(mediaKindForName('archive.zip'), null);
});
