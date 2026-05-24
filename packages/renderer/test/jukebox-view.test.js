/**
 * @file Tests for the pure helpers in the jukebox view module. The view
 * factory itself is a DOM component; there is no jsdom in this repo, so
 * the live `createJukeboxView` is exercised by the desktop smoke test.
 * Everything pure — audio filename recognition, art selection, shuffle,
 * path joining — is unit-tested here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_SUFFIXES,
  ART_FILENAMES,
  findArt,
  isAudioFile,
  joinPath,
  shufflePermutation,
} from '../src/jukebox-view.js';

test('AUDIO_SUFFIXES exposes the recognised list, lower-case', () => {
  assert.ok(AUDIO_SUFFIXES.includes('.mp3'));
  assert.ok(AUDIO_SUFFIXES.includes('.flac'));
  for (const s of AUDIO_SUFFIXES) {
    assert.equal(s, s.toLowerCase(), `${s} should be lower-case`);
    assert.ok(s.startsWith('.'), `${s} should start with a dot`);
  }
});

test('ART_FILENAMES includes the common cases', () => {
  assert.ok(ART_FILENAMES.includes('cover.jpg'));
  assert.ok(ART_FILENAMES.includes('folder.png'));
});

test('isAudioFile recognises common audio extensions', () => {
  assert.equal(isAudioFile('song.mp3'), true);
  assert.equal(isAudioFile('song.FLAC'), true);  // case-insensitive
  assert.equal(isAudioFile('song.ogg'), true);
  assert.equal(isAudioFile('song.m4a'), true);
  assert.equal(isAudioFile('cover.jpg'), false);
  assert.equal(isAudioFile('README.txt'), false);
  assert.equal(isAudioFile(''), false);
  assert.equal(isAudioFile(null), false);
  assert.equal(isAudioFile(undefined), false);
  assert.equal(isAudioFile(42), false);
});

test('findArt returns the first matching art filename, original case', () => {
  assert.equal(findArt(['song.mp3', 'cover.jpg', 'x.txt']), 'cover.jpg');
  assert.equal(findArt(['song.mp3', 'FOLDER.PNG']), 'FOLDER.PNG');
  assert.equal(findArt(['song.mp3', 'notes.txt']), null);
  assert.equal(findArt([]), null);
  assert.equal(findArt(null), null);
  assert.equal(findArt(undefined), null);
});

test('joinPath joins with a single slash and trims a trailing slash on dir', () => {
  assert.equal(joinPath('/music', 'song.mp3'), '/music/song.mp3');
  assert.equal(joinPath('/music/', 'song.mp3'), '/music/song.mp3');
  assert.equal(joinPath('', 'song.mp3'), '/song.mp3');
});

test('shufflePermutation returns a permutation of the input', () => {
  const input = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const out = shufflePermutation(input);
  assert.equal(out.length, input.length);
  assert.deepEqual([...out].sort(), [...input].sort());
});

test('shufflePermutation does not mutate its input', () => {
  const input = ['a', 'b', 'c', 'd'];
  const copy = input.slice();
  shufflePermutation(input);
  assert.deepEqual(input, copy);
});

test('shufflePermutation on empty / single is identity-equivalent', () => {
  assert.deepEqual(shufflePermutation([]), []);
  assert.deepEqual(shufflePermutation(['only']), ['only']);
});

test('shufflePermutation is deterministic when given a deterministic RNG', () => {
  // Inject a counter-based "RNG" so the test can pin the output.
  let i = 0;
  const sequence = [0.1, 0.5, 0.7, 0.2, 0.9, 0.3];
  const rng = () => sequence[i++ % sequence.length];
  const a = shufflePermutation(['1', '2', '3', '4', '5'], rng);
  i = 0;
  const b = shufflePermutation(['1', '2', '3', '4', '5'], rng);
  assert.deepEqual(a, b);
});

test('shufflePermutation tolerates non-array input', () => {
  assert.deepEqual(shufflePermutation(null), []);
  assert.deepEqual(shufflePermutation(undefined), []);
  assert.deepEqual(shufflePermutation('not-an-array'), []);
});
