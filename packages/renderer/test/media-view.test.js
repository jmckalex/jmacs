import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAudioFileName,
  isVideoFileName,
  mediaErrorAdvice,
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

test('mediaErrorAdvice returns null for ABORTED (user-initiated)', () => {
  // ABORTED fires when the user pauses-and-seeks mid-load. Not an
  // error the view should plaster a message over.
  assert.equal(mediaErrorAdvice({ code: 1 }, 'clip.mp4'), null);
  assert.equal(mediaErrorAdvice(null, 'clip.mp4'), null);
  assert.equal(mediaErrorAdvice(undefined, 'clip.mp4'), null);
});

test('mediaErrorAdvice tailors SRC_NOT_SUPPORTED for .mkv to a remux command', () => {
  // The .mkv case is the most common SRC_NOT_SUPPORTED Godot sees;
  // a stream-copy remux is nearly always instant and lossless.
  const advice = mediaErrorAdvice({ code: 4 }, 'movie.mkv');
  assert.ok(advice);
  assert.match(advice.headline, /Matroska|\.mkv/i);
  assert.match(advice.command, /^ffmpeg .* -c copy /);
  assert.match(advice.command, /movie\.mkv/);
  assert.match(advice.command, /movie\.mp4/);
});

test('mediaErrorAdvice gives a generic re-encode command for other unsupported sources', () => {
  // A SRC_NOT_SUPPORTED on an .mp4 means the codec inside (e.g. HEVC,
  // AC-3) is the problem, not the container. Need a re-encode rather
  // than a stream copy.
  const advice = mediaErrorAdvice({ code: 4 }, 'hevc.mp4');
  assert.ok(advice);
  assert.match(advice.headline, /codec/i);
  assert.match(advice.command, /libx264/);
  assert.match(advice.command, /-c:a aac/);
});

test('mediaErrorAdvice surfaces a DECODE error with re-encode advice', () => {
  const advice = mediaErrorAdvice({ code: 3 }, 'broken.mp4');
  assert.ok(advice);
  assert.match(advice.headline, /decode/i);
  assert.match(advice.command, /libx264/);
});

test('mediaErrorAdvice surfaces a NETWORK error without a command', () => {
  const advice = mediaErrorAdvice({ code: 2 }, 'missing.mp4');
  assert.ok(advice);
  assert.match(advice.headline, /read|fetch/i);
  assert.equal(advice.command, null);
  assert.equal(advice.suggestion, null);
});

test('mediaErrorAdvice falls back to a generic block for an unknown code', () => {
  const advice = mediaErrorAdvice({ code: 99, message: 'something odd' }, 'x');
  assert.ok(advice);
  assert.match(advice.headline, /playback/i);
  assert.equal(advice.detail, 'something odd');
});

test('mediaErrorAdvice tolerates a missing name', () => {
  const advice = mediaErrorAdvice({ code: 4 }, '');
  assert.ok(advice);
  // Command falls back to a default placeholder so the example is
  // still copy-pasteable.
  assert.match(advice.command, /^ffmpeg /);
});
