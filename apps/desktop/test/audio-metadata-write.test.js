/**
 * @file Tests for the audio-metadata writers. The contract is
 * round-trip with the existing extractors: a tag built by the
 * serialiser must come back through `extractMP3Metadata` with the
 * same field values. Cover art (APIC) survives a no-op rewrite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractMP3Metadata,
  extractID3v2,
} from '../src/audio-metadata.js';
import { extractID3v2APIC } from '../src/audio-art.js';
import {
  buildApicFrame,
  buildTextFrame,
  buildTxxxFrame,
  decodeSyncsafeInt32,
  encodeSyncsafeInt32,
  findMP3AudioStart,
  ID3_FRAME_FOR_KEY,
  serialiseID3v24Tag,
  serialiseMP3,
  stripID3v1,
  writeMetadataSync,
} from '../src/audio-metadata-write.js';

/** A 6-byte JPEG sniffable as image/jpeg by the album-art extractor;
 *  short enough to keep test files tiny. */
const SAMPLE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** A handful of MPEG sync bytes — not a real audio frame, but enough
 *  to stand in for "the audio stream after the tag" in round-trip
 *  tests that only care about the tag boundary. */
const FAKE_MPEG_DATA = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);

// ---------------------------------------------------------------------------
// Syncsafe integer round-trip
// ---------------------------------------------------------------------------

test('encodeSyncsafeInt32 / decodeSyncsafeInt32 are inverses', () => {
  for (const n of [0, 1, 127, 128, 16383, 16384, 2097151, 268435455]) {
    const buf = encodeSyncsafeInt32(n);
    assert.equal(buf.length, 4);
    assert.equal(decodeSyncsafeInt32(buf, 0), n);
  }
});

test('encodeSyncsafeInt32 emits 7-bit-clean bytes', () => {
  // The whole point of syncsafe: every byte's high bit is zero so
  // the size field can never look like an MPEG sync word.
  for (const n of [0, 100000, 200000, 268435455]) {
    const buf = encodeSyncsafeInt32(n);
    for (const byte of buf) assert.equal(byte & 0x80, 0);
  }
});

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

test('buildTextFrame produces a v2.4 frame the extractor reads back', () => {
  // Wrap a single TIT2 frame inside a minimal v2.4 tag so the
  // extractor has the header context it needs.
  const frame = buildTextFrame('TIT2', 'Title text');
  const tagPayload = Buffer.concat([frame, Buffer.alloc(64)]); // light padding
  const tag = Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([0x04, 0x00, 0x00]),
    encodeSyncsafeInt32(tagPayload.length),
    tagPayload,
  ]);
  const meta = extractID3v2(tag);
  assert.equal(meta.title, 'Title text');
});

test('buildTextFrame round-trips UTF-8 with non-ASCII characters', () => {
  const frame = buildTextFrame('TPE1', 'Sigur Rós — Ágætis byrjun');
  const tag = wrapInTag(frame);
  const meta = extractID3v2(tag);
  assert.equal(meta.artist, 'Sigur Rós — Ágætis byrjun');
});

test('buildTxxxFrame survives a round-trip — extractor returns null for it but the frame is structurally valid', () => {
  // The existing extractor's API doesn't surface TXXX (it skips
  // non-standard frames). The structural check is enough: the frame
  // sits inside a tag without breaking the next frame's parse.
  const tag = wrapInTag(
    Buffer.concat([
      buildTxxxFrame('COMPOSER', 'A. Composer'),
      buildTextFrame('TIT2', 'Track name'),
    ]),
  );
  const meta = extractID3v2(tag);
  assert.equal(meta.title, 'Track name');
});

test('buildApicFrame round-trips through extractID3v2APIC', () => {
  const tag = wrapInTag(buildApicFrame('image/jpeg', SAMPLE_JPEG));
  const art = extractID3v2APIC(tag);
  assert.equal(art.mime, 'image/jpeg');
  assert.ok(Buffer.from(art.data).equals(SAMPLE_JPEG));
});

// ---------------------------------------------------------------------------
// Tag serialisation
// ---------------------------------------------------------------------------

test('serialiseID3v24Tag emits a tag with the 10-byte header + the requested size', () => {
  const tag = serialiseID3v24Tag({ title: 'Hello' });
  assert.equal(tag.slice(0, 3).toString('ascii'), 'ID3');
  assert.equal(tag[3], 4); // major version
  // Body size is total length minus the 10-byte header.
  const bodySize = decodeSyncsafeInt32(tag, 6);
  assert.equal(bodySize, tag.length - 10);
});

test('serialiseID3v24Tag includes 2KB of trailing padding', () => {
  const tag = serialiseID3v24Tag({ title: 'Short' });
  // The tag body is the title frame + 2048 bytes of NUL padding.
  // Find the start of the padding (last frame + 1) — the suffix
  // should be 2048 zero bytes.
  const trailingZeros = countTrailingZeros(tag);
  assert.ok(trailingZeros >= 2048, `expected ≥2048 NUL bytes, got ${trailingZeros}`);
});

test('serialiseID3v24Tag omits missing keys without writing empty frames', () => {
  const tag = serialiseID3v24Tag({ title: 'Only title' });
  const meta = extractID3v2(tag);
  assert.equal(meta.title, 'Only title');
  assert.equal(meta.artist, null);
  assert.equal(meta.album, null);
  assert.equal(meta.year, null);
});

test('serialiseID3v24Tag round-trips all six standard fields', () => {
  const tag = serialiseID3v24Tag({
    title: 'A Title',
    artist: 'An Artist',
    album: 'An Album',
    track: 7,
    year: '1991',
    genre: 'Alternative',
  });
  const meta = extractID3v2(tag);
  assert.equal(meta.title, 'A Title');
  assert.equal(meta.artist, 'An Artist');
  assert.equal(meta.album, 'An Album');
  assert.equal(meta.track, 7);
  assert.equal(meta.year, 1991);
  assert.equal(meta.genre, 'Alternative');
});

test('serialiseID3v24Tag preserves cover art through APIC', () => {
  const tag = serialiseID3v24Tag({
    title: 'With Cover',
    cover: { mime: 'image/jpeg', data: SAMPLE_JPEG },
  });
  const art = extractID3v2APIC(tag);
  assert.equal(art.mime, 'image/jpeg');
  assert.ok(Buffer.from(art.data).equals(SAMPLE_JPEG));
});

test('serialiseID3v24Tag drops derived fields silently', () => {
  // duration / file / format / path are read-only — passing them in
  // doesn't break the build; they just don't make it into frames.
  const tag = serialiseID3v24Tag({
    title: 'Real',
    duration: 232,
    file: 'whatever.mp3',
    format: 'audio/mpeg',
    path: '/tmp/whatever.mp3',
  });
  const meta = extractMP3Metadata(tag);
  assert.equal(meta.title, 'Real');
  // The extractor reports duration via codec-stream introspection
  // (the buffer has none), so it stays null.
  assert.equal(meta.duration, null);
});

// ---------------------------------------------------------------------------
// Full-file serialisation
// ---------------------------------------------------------------------------

test('findMP3AudioStart returns 0 for a tag-less buffer', () => {
  assert.equal(findMP3AudioStart(Buffer.from([0xff, 0xfb, 0x90, 0x64])), 0);
});

test('findMP3AudioStart returns the byte after the ID3v2 tag', () => {
  const tag = serialiseID3v24Tag({ title: 'A' });
  const file = Buffer.concat([tag, FAKE_MPEG_DATA]);
  assert.equal(findMP3AudioStart(file), tag.length);
});

test('stripID3v1 drops a trailing v1 tag and leaves a v1-less buffer alone', () => {
  const v1 = Buffer.alloc(128);
  v1.write('TAG', 0, 'ascii');
  const audio = FAKE_MPEG_DATA;
  assert.ok(stripID3v1(Buffer.concat([audio, v1])).equals(audio));
  assert.ok(stripID3v1(audio).equals(audio));
});

test('serialiseMP3 preserves the audio stream byte-for-byte', () => {
  const originalTag = serialiseID3v24Tag({ title: 'Old' });
  const original = Buffer.concat([originalTag, FAKE_MPEG_DATA]);
  const rewritten = serialiseMP3(original, { title: 'New' });
  // Audio data is unchanged after a metadata-only rewrite.
  const newAudioStart = findMP3AudioStart(rewritten);
  const newAudio = rewritten.subarray(newAudioStart);
  assert.ok(newAudio.equals(FAKE_MPEG_DATA));
});

test('serialiseMP3 reflects the new metadata in the new tag', () => {
  const originalTag = serialiseID3v24Tag({ title: 'Old' });
  const original = Buffer.concat([originalTag, FAKE_MPEG_DATA]);
  const rewritten = serialiseMP3(original, { title: 'New', artist: 'Added' });
  const meta = extractMP3Metadata(rewritten);
  assert.equal(meta.title, 'New');
  assert.equal(meta.artist, 'Added');
});

test('serialiseMP3 drops a trailing ID3v1 tag (canonicalising on v2)', () => {
  const v1 = Buffer.alloc(128);
  v1.write('TAG', 0, 'ascii');
  const original = Buffer.concat([
    serialiseID3v24Tag({ title: 'X' }),
    FAKE_MPEG_DATA,
    v1,
  ]);
  const rewritten = serialiseMP3(original, { title: 'Y' });
  // Last 128 bytes of the rewritten file are padding zeros, not "TAG".
  assert.notEqual(
    rewritten.subarray(rewritten.length - 128, rewritten.length - 125).toString('ascii'),
    'TAG',
  );
});

// ---------------------------------------------------------------------------
// writeMetadataSync — round-trip through a real file
// ---------------------------------------------------------------------------

test('writeMetadataSync writes an MP3 round-trip through disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jmacs-audio-write-'));
  const path = join(dir, 'song.mp3');
  try {
    const seed = Buffer.concat([
      serialiseID3v24Tag({ title: 'Original', artist: 'Original Artist' }),
      FAKE_MPEG_DATA,
    ]);
    await writeFile(path, seed);

    const result = writeMetadataSync(path, {
      title: 'Updated',
      artist: 'Updated Artist',
      album: 'New Album',
    });
    assert.equal(result.ok, true);

    const reread = await readFile(path);
    const meta = extractMP3Metadata(reread);
    assert.equal(meta.title, 'Updated');
    assert.equal(meta.artist, 'Updated Artist');
    assert.equal(meta.album, 'New Album');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeMetadataSync preserves cover art across an edit that doesn\'t touch it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jmacs-audio-write-'));
  const path = join(dir, 'song.mp3');
  try {
    const seed = Buffer.concat([
      serialiseID3v24Tag({
        title: 'Original',
        cover: { mime: 'image/jpeg', data: SAMPLE_JPEG },
      }),
      FAKE_MPEG_DATA,
    ]);
    await writeFile(path, seed);

    // The renderer-side metadata doesn't carry `cover`; the writer
    // re-reads it from the existing file and preserves.
    writeMetadataSync(path, { title: 'Renamed' });

    const reread = await readFile(path);
    const art = extractID3v2APIC(reread);
    assert.ok(art);
    assert.equal(art.mime, 'image/jpeg');
    assert.ok(Buffer.from(art.data).equals(SAMPLE_JPEG));
    assert.equal(extractMP3Metadata(reread).title, 'Renamed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeMetadataSync rejects an unsupported extension', () => {
  const result = writeMetadataSync('/tmp/whatever.ogg', { title: 'X' });
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported format/);
});

test('writeMetadataSync reports ENOENT for a missing file', () => {
  const result = writeMetadataSync('/tmp/definitely-does-not-exist.mp3', {});
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});

test('ID3_FRAME_FOR_KEY covers every standard editable field', () => {
  // A small guard: if the renderer adds a new standard editable key,
  // the writer needs a mapping for it.
  for (const key of ['title', 'artist', 'album', 'track', 'year', 'genre']) {
    assert.ok(ID3_FRAME_FOR_KEY[key], `missing mapping for ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap one or more frame buffers inside a minimal v2.4 tag so the
 *  extractor has the 10-byte header to bootstrap from. */
function wrapInTag(framesBuf) {
  const body = Buffer.concat([framesBuf, Buffer.alloc(32)]);
  return Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([0x04, 0x00, 0x00]),
    encodeSyncsafeInt32(body.length),
    body,
  ]);
}

/** Count NUL bytes at the tail of `buf` — used to assert padding. */
function countTrailingZeros(buf) {
  let n = 0;
  for (let i = buf.length - 1; i >= 0 && buf[i] === 0; i--) n += 1;
  return n;
}
