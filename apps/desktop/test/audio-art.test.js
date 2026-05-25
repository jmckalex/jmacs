/**
 * @file Tests for the embedded album-art parsers. We hand-build minimal
 * valid container fragments rather than checking in binary fixtures —
 * the parsers are tested against bytes whose layout the test itself
 * commits to, which makes the spec quirks (ID3 syncsafe sizes,
 * v2.3-vs-v2.4 frame size encoding, the MP4 `meta`-has-version-bytes
 * pitfall) part of the readable test surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractAlbumArt,
  extractID3v2APIC,
  extractMP4Covr,
  findBox,
} from '../src/audio-art.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A tiny JPEG header used as stand-in picture bytes for the tests. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
/** A tiny PNG header (signature only). */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode INT into 4 syncsafe bytes (7 bits per byte, MSB zero). */
function syncsafe(int) {
  return Buffer.from([
    (int >> 21) & 0x7f,
    (int >> 14) & 0x7f,
    (int >> 7) & 0x7f,
    int & 0x7f,
  ]);
}

/** Plain big-endian uint32. */
function uint32be(int) {
  return Buffer.from([
    (int >> 24) & 0xff,
    (int >> 16) & 0xff,
    (int >> 8) & 0xff,
    int & 0xff,
  ]);
}

/**
 * Build an APIC frame payload around PICTURE bytes:
 *   1 byte encoding + MIME + NUL + 1 byte picture type
 *   + description + NUL + picture.
 */
function apicPayload(mime, description, picture, encoding = 0) {
  return Buffer.concat([
    Buffer.from([encoding]),
    Buffer.from(mime, 'ascii'),
    Buffer.from([0]),
    Buffer.from([3]), // picture type: cover (front)
    Buffer.from(description, 'ascii'),
    Buffer.from([0]),
    picture,
  ]);
}

/** Build a single v2.3 APIC frame: 10-byte header + payload. */
function id3v23Frame(id, payload) {
  return Buffer.concat([
    Buffer.from(id, 'ascii'),
    uint32be(payload.length),
    Buffer.from([0, 0]),
    payload,
  ]);
}

/** Build a single v2.4 APIC frame: header uses a syncsafe size. */
function id3v24Frame(id, payload) {
  return Buffer.concat([
    Buffer.from(id, 'ascii'),
    syncsafe(payload.length),
    Buffer.from([0, 0]),
    payload,
  ]);
}

/** Wrap FRAMES in an ID3v2 tag header (size is syncsafe). */
function id3Tag(majorVersion, frames, flags = 0) {
  return Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([majorVersion, 0, flags]),
    syncsafe(frames.length),
    frames,
  ]);
}

/** Build an MP4 box: 4-byte size + 4-byte type + body. */
function box(type, body) {
  const size = 8 + body.length;
  return Buffer.concat([uint32be(size), Buffer.from(type, 'ascii'), body]);
}

// ---------------------------------------------------------------------------
// ID3v2 (MP3)
// ---------------------------------------------------------------------------

test('extractID3v2APIC pulls the picture from a minimal v2.3 tag', () => {
  const payload = apicPayload('image/jpeg', 'cover', JPEG_BYTES);
  const tag = id3Tag(3, id3v23Frame('APIC', payload));
  const result = extractID3v2APIC(tag);
  assert.ok(result, 'expected to find a picture');
  assert.equal(result.mime, 'image/jpeg');
  assert.deepEqual(Buffer.from(result.data), JPEG_BYTES);
});

test('extractID3v2APIC honours v2.4 syncsafe frame sizes', () => {
  // Use a payload long enough that a syncsafe vs plain int 32 would
  // disagree: 200 bytes is fine (any value with bit 7 set in the low
  // byte after encoding would). 200 = 0xC8, syncsafe(200) = 00 00 01 48.
  const big = Buffer.concat([JPEG_BYTES, Buffer.alloc(200, 0x42)]);
  const payload = apicPayload('image/jpeg', '', big);
  const tag = id3Tag(4, id3v24Frame('APIC', payload));
  const result = extractID3v2APIC(tag);
  assert.ok(result);
  assert.equal(result.mime, 'image/jpeg');
  assert.equal(result.data.length, big.length);
});

test('extractID3v2APIC skips non-APIC frames before finding the picture', () => {
  // A title frame ("TIT2") sits before APIC; the iterator must skip
  // it by its declared size and land on APIC next.
  const tit2 = id3v23Frame(
    'TIT2',
    Buffer.concat([Buffer.from([0]), Buffer.from('My Song', 'ascii')])
  );
  const apic = id3v23Frame('APIC', apicPayload('image/png', '', PNG_BYTES));
  const tag = id3Tag(3, Buffer.concat([tit2, apic]));
  const result = extractID3v2APIC(tag);
  assert.ok(result);
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(Buffer.from(result.data), PNG_BYTES);
});

test('extractID3v2APIC returns null when no APIC frame is present', () => {
  const tit2 = id3v23Frame(
    'TIT2',
    Buffer.concat([Buffer.from([0]), Buffer.from('Only a title', 'ascii')])
  );
  const tag = id3Tag(3, tit2);
  assert.equal(extractID3v2APIC(tag), null);
});

test('extractID3v2APIC bails on v2.2 (3-char IDs, 6-byte headers)', () => {
  // We claim v2.2 is unsupported and degrade to null.
  const fake = id3Tag(2, Buffer.alloc(0));
  assert.equal(extractID3v2APIC(fake), null);
});

test('extractID3v2APIC returns null when the input is not an ID3 tag', () => {
  assert.equal(extractID3v2APIC(Buffer.from('not a tag at all 1234567890')), null);
  assert.equal(extractID3v2APIC(Buffer.alloc(0)), null);
  assert.equal(extractID3v2APIC(null), null);
  assert.equal(extractID3v2APIC(undefined), null);
});

test('extractID3v2APIC handles UTF-16 description terminator correctly', () => {
  // Encoding 1 = UTF-16; description ends with 0x00 0x00 on a 2-byte
  // boundary. Build a description as little-endian UTF-16 ("a" = 61
  // 00) terminated with 00 00, then the picture bytes.
  const description = Buffer.from([0x61, 0x00, 0x00, 0x00]); // "a" + NULNUL
  const payload = Buffer.concat([
    Buffer.from([1]),                          // encoding: UTF-16
    Buffer.from('image/jpeg', 'ascii'),
    Buffer.from([0]),                          // MIME NUL (always 1 byte)
    Buffer.from([3]),                          // picture type
    description,
    JPEG_BYTES,
  ]);
  const tag = id3Tag(3, id3v23Frame('APIC', payload));
  const result = extractID3v2APIC(tag);
  assert.ok(result);
  assert.equal(result.mime, 'image/jpeg');
  assert.deepEqual(Buffer.from(result.data), JPEG_BYTES);
});

test('extractID3v2APIC sniffs the MIME when the frame leaves it blank', () => {
  // Some taggers omit MIME entirely; we sniff JPEG/PNG from the bytes.
  const payload = apicPayload('', '', JPEG_BYTES);
  const tag = id3Tag(3, id3v23Frame('APIC', payload));
  const result = extractID3v2APIC(tag);
  assert.ok(result);
  assert.equal(result.mime, 'image/jpeg');
});

test('extractID3v2APIC stops at padding (all-zero frame ID)', () => {
  // After a real frame, the rest of the tag is zero padding —
  // historically a common encoder choice. The iterator must not try
  // to parse the padding as another frame.
  const apic = id3v23Frame('APIC', apicPayload('image/jpeg', '', JPEG_BYTES));
  const padding = Buffer.alloc(100, 0);
  const tag = id3Tag(3, Buffer.concat([apic, padding]));
  const result = extractID3v2APIC(tag);
  assert.ok(result);
  assert.equal(result.mime, 'image/jpeg');
});

// ---------------------------------------------------------------------------
// MP4 / M4A (covr)
// ---------------------------------------------------------------------------

test('extractMP4Covr pulls the first cover from a nested box tree', () => {
  // data atom payload: 4 bytes type (13=JPEG) + 4 bytes reserved + image
  const dataPayload = Buffer.concat([
    uint32be(13),         // type indicator: JPEG
    uint32be(0),          // reserved
    JPEG_BYTES,
  ]);
  const covr = box('covr', box('data', dataPayload));
  const ilst = box('ilst', covr);
  // meta: 4 bytes version+flags THEN children. This is the gotcha.
  const meta = box('meta', Buffer.concat([Buffer.alloc(4, 0), ilst]));
  const udta = box('udta', meta);
  const moov = box('moov', udta);

  const result = extractMP4Covr(moov);
  assert.ok(result, 'expected to find a cover');
  assert.equal(result.mime, 'image/jpeg');
  assert.deepEqual(Buffer.from(result.data), JPEG_BYTES);
});

test('extractMP4Covr recognises a PNG cover (type indicator 14)', () => {
  const dataPayload = Buffer.concat([
    uint32be(14), uint32be(0), PNG_BYTES,
  ]);
  const moov = box('moov', box('udta', box('meta', Buffer.concat([
    Buffer.alloc(4, 0),
    box('ilst', box('covr', box('data', dataPayload))),
  ]))));
  const result = extractMP4Covr(moov);
  assert.ok(result);
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(Buffer.from(result.data), PNG_BYTES);
});

test('extractMP4Covr returns null when meta lacks its version-flags bytes', () => {
  // Build a meta box WITHOUT the 4-byte version+flags prefix to
  // confirm the parser doesn't accidentally accept malformed input.
  // findBox into the bad meta will land on garbage and return null.
  const dataPayload = Buffer.concat([
    uint32be(13), uint32be(0), JPEG_BYTES,
  ]);
  const meta = box('meta',
    box('ilst', box('covr', box('data', dataPayload)))
  );
  const moov = box('moov', box('udta', meta));
  // Without the version-flags skip, the parser interprets the first
  // ilst's size bytes as a fake box header — that doesn't match the
  // file structure, so the lookup misses.
  assert.equal(extractMP4Covr(moov), null);
});

test('extractMP4Covr returns null with no moov atom', () => {
  // A file made of just an ftyp box and nothing useful.
  const ftyp = box('ftyp', Buffer.alloc(8));
  assert.equal(extractMP4Covr(ftyp), null);
  assert.equal(extractMP4Covr(Buffer.alloc(0)), null);
});

test('extractMP4Covr returns null when meta is present but covr is missing', () => {
  // meta with empty ilst — i.e. no covr.
  const moov = box('moov', box('udta', box('meta', Buffer.concat([
    Buffer.alloc(4, 0),
    box('ilst', Buffer.alloc(0)),
  ]))));
  assert.equal(extractMP4Covr(moov), null);
});

test('findBox returns the first match and ignores siblings of a different type', () => {
  // Box types are 4 chars — pad with `!` to keep that invariant.
  const inner = Buffer.concat([
    box('foo!', Buffer.from('first')),
    box('bar!', Buffer.from('second')),
    box('foo!', Buffer.from('third')),
  ]);
  const m = findBox(inner, 0, inner.length, 'bar!');
  assert.ok(m);
  const slice = inner.subarray(m.start, m.end);
  assert.equal(Buffer.from(slice).toString(), 'second');
});

test('findBox returns null when no matching child exists', () => {
  const inner = box('foo!', Buffer.from('only'));
  assert.equal(findBox(inner, 0, inner.length, 'bar!'), null);
});

test('findBox tolerates a zero-size sentinel (size 0 = to end)', () => {
  // Box with size=0 means "to end of enclosing container".
  const inner = Buffer.concat([
    uint32be(0),
    Buffer.from('foo!', 'ascii'),
    Buffer.from('payload-to-end'),
  ]);
  const m = findBox(inner, 0, inner.length, 'foo!');
  assert.ok(m);
  assert.equal(m.end, inner.length);
});

// ---------------------------------------------------------------------------
// extractAlbumArt (dispatch + IO)
// ---------------------------------------------------------------------------

test('extractAlbumArt dispatches by suffix and reads from disk', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'jmacs-art-'));
  try {
    const payload = apicPayload('image/jpeg', '', JPEG_BYTES);
    const tag = id3Tag(3, id3v23Frame('APIC', payload));
    const mp3 = join(tmp, 'sample.mp3');
    await writeFile(mp3, tag);
    const result = await extractAlbumArt(mp3);
    assert.ok(result);
    assert.equal(result.mime, 'image/jpeg');
    assert.deepEqual(Buffer.from(result.data), JPEG_BYTES);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('extractAlbumArt returns null for an unsupported suffix', async () => {
  assert.equal(await extractAlbumArt('/no/such/file.flac'), null);
  assert.equal(await extractAlbumArt('/no/such/file.ogg'), null);
});

test('extractAlbumArt returns null for a missing or unreadable file', async () => {
  assert.equal(await extractAlbumArt('/no/such/path.mp3'), null);
});

test('extractAlbumArt returns null for non-string input', async () => {
  assert.equal(await extractAlbumArt(null), null);
  assert.equal(await extractAlbumArt(undefined), null);
  assert.equal(await extractAlbumArt(''), null);
});
