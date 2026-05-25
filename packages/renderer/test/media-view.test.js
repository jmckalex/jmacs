import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAudioFileName,
  isVideoFileName,
  mediaUrlForPath,
  mimeTypeForAudio,
  mimeTypeForVideo,
} from '../src/media-view.js';

test('mimeTypeForAudio maps each supported suffix to its MIME type', () => {
  assert.equal(mimeTypeForAudio('track.mp3'), 'audio/mpeg');
  assert.equal(mimeTypeForAudio('track.flac'), 'audio/flac');
  assert.equal(mimeTypeForAudio('track.wav'), 'audio/wav');
  assert.equal(mimeTypeForAudio('track.ogg'), 'audio/ogg');
  assert.equal(mimeTypeForAudio('track.m4a'), 'audio/mp4');
  assert.equal(mimeTypeForAudio('track.aac'), 'audio/aac');
  assert.equal(mimeTypeForAudio('track.opus'), 'audio/ogg');
});

test('mimeTypeForAudio is case-insensitive on the suffix', () => {
  assert.equal(mimeTypeForAudio('TRACK.MP3'), 'audio/mpeg');
  assert.equal(mimeTypeForAudio('Track.FlAc'), 'audio/flac');
});

test('mimeTypeForAudio uses the last suffix of a dotted name', () => {
  assert.equal(mimeTypeForAudio('archive.tar.mp3'), 'audio/mpeg');
});

test('mimeTypeForAudio returns null for non-audio and non-string names', () => {
  assert.equal(mimeTypeForAudio('notes.txt'), null);
  assert.equal(mimeTypeForAudio('photo.png'), null);
  assert.equal(mimeTypeForAudio('README'), null);
  assert.equal(mimeTypeForAudio(null), null);
  assert.equal(mimeTypeForAudio(undefined), null);
  assert.equal(mimeTypeForAudio(42), null);
});

test('isAudioFileName matches mimeTypeForAudio', () => {
  assert.equal(isAudioFileName('song.mp3'), true);
  assert.equal(isAudioFileName('song.FLAC'), true);
  assert.equal(isAudioFileName('song.txt'), false);
  assert.equal(isAudioFileName(null), false);
});

test('mimeTypeForVideo maps each supported suffix to its MIME type', () => {
  assert.equal(mimeTypeForVideo('clip.mp4'), 'video/mp4');
  assert.equal(mimeTypeForVideo('clip.m4v'), 'video/mp4');
  assert.equal(mimeTypeForVideo('clip.webm'), 'video/webm');
  assert.equal(mimeTypeForVideo('clip.mov'), 'video/quicktime');
  assert.equal(mimeTypeForVideo('clip.mkv'), 'video/x-matroska');
});

test('mimeTypeForVideo is case-insensitive on the suffix', () => {
  assert.equal(mimeTypeForVideo('CLIP.MP4'), 'video/mp4');
  assert.equal(mimeTypeForVideo('Clip.WeBm'), 'video/webm');
});

test('mimeTypeForVideo returns null for non-video names', () => {
  assert.equal(mimeTypeForVideo('notes.txt'), null);
  assert.equal(mimeTypeForVideo('track.mp3'), null);
  assert.equal(mimeTypeForVideo(''), null);
  assert.equal(mimeTypeForVideo(null), null);
});

test('isVideoFileName matches mimeTypeForVideo', () => {
  assert.equal(isVideoFileName('foo.mp4'), true);
  assert.equal(isVideoFileName('foo.MKV'), true);
  assert.equal(isVideoFileName('foo.mp3'), false);
  assert.equal(isVideoFileName(42), false);
});

test('mediaUrlForPath encodes per-segment and prefixes media://localhost', () => {
  assert.equal(
    mediaUrlForPath('/Users/me/Music/foo bar.mp3'),
    'media://localhost/Users/me/Music/foo%20bar.mp3'
  );
});

test('mediaUrlForPath leaves a URL with a recognised scheme untouched', () => {
  assert.equal(
    mediaUrlForPath('media://localhost/already/encoded.mp3'),
    'media://localhost/already/encoded.mp3'
  );
  assert.equal(
    mediaUrlForPath('https://example.com/track.mp3'),
    'https://example.com/track.mp3'
  );
  assert.equal(
    mediaUrlForPath('data:audio/mpeg;base64,AAA'),
    'data:audio/mpeg;base64,AAA'
  );
});

test('mediaUrlForPath tolerates non-string input', () => {
  assert.equal(mediaUrlForPath(null), '');
  assert.equal(mediaUrlForPath(undefined), '');
});
