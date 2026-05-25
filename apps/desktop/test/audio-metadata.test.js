/**
 * @file Tests for the audio-metadata parsers. Hand-built byte buffers
 * for each format so the test itself commits to the layout the parser
 * is supposed to read (syncsafe sizes in ID3v2.4, the `trkn` special
 * format in MP4, the Ogg segment-table → packet-boundary
 * reconstruction).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractID3v1,
  extractID3v2,
  extractMetadata,
  extractMP3Metadata,
  extractMP4Metadata,
  extractOGGCommentPacket,
  extractOGGMetadata,
  findBox,
} from '../src/audio-metadata.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode `n` into 4 syncsafe bytes (7 bits per byte). */
function syncsafe(n) {
  return Buffer.from([
    (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f,
  ]);
}

/** Plain big-endian uint32. */
function uint32be(n) {
  return Buffer.from([
    (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff,
  ]);
}

/** Little-endian uint32 (Vorbis comments). */
function uint32le(n) {
  return Buffer.from([
    n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff,
  ]);
}

/** Big-endian uint16. */
function uint16be(n) {
  return Buffer.from([(n >> 8) & 0xff, n & 0xff]);
}

/** A plain ISO-8859-1 ID3v2 text frame: 1 byte encoding (0) + ASCII. */
function textPayload(s) {
  return Buffer.concat([Buffer.from([0]), Buffer.from(s, 'latin1')]);
}

/** Build an ID3v2.3 text frame: header (plain big-endian size) + payload. */
function id3v23TextFrame(id, value) {
  const payload = textPayload(value);
  return Buffer.concat([
    Buffer.from(id, 'ascii'),
    uint32be(payload.length),
    Buffer.from([0, 0]),
    payload,
  ]);
}

/** Build an ID3v2.4 text frame: header (syncsafe size). */
function id3v24TextFrame(id, value) {
  const payload = textPayload(value);
  return Buffer.concat([
    Buffer.from(id, 'ascii'),
    syncsafe(payload.length),
    Buffer.from([0, 0]),
    payload,
  ]);
}

/** Wrap FRAMES in a v3.0 or v4.0 ID3v2 tag header. */
function id3Tag(majorVersion, frames) {
  return Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([majorVersion, 0, 0]),
    syncsafe(frames.length),
    frames,
  ]);
}

/** Build an MP4 box: 4-byte size + 4-byte type + body. */
function box(type, body) {
  return Buffer.concat([
    uint32be(8 + body.length),
    Buffer.from(type, 'ascii'),
    body,
  ]);
}

/** Build a `data` atom for an ilst item: typeIndicator + locale + bytes. */
function ilstData(typeIndicator, bytes) {
  return box('data', Buffer.concat([
    uint32be(typeIndicator),
    uint32be(0), // locale
    bytes,
  ]));
}

// ---------------------------------------------------------------------------
// ID3v2 (MP3)
// ---------------------------------------------------------------------------

test('extractID3v2 reads TIT2 / TPE1 / TALB / TRCK / TYER / TCON (v2.3)', () => {
  const frames = Buffer.concat([
    id3v23TextFrame('TIT2', 'My Song'),
    id3v23TextFrame('TPE1', 'The Band'),
    id3v23TextFrame('TALB', 'Greatest Hits'),
    id3v23TextFrame('TRCK', '3/12'),
    id3v23TextFrame('TYER', '1999'),
    id3v23TextFrame('TCON', 'Rock'),
  ]);
  const tag = id3Tag(3, frames);
  const meta = extractID3v2(tag);
  assert.equal(meta.title, 'My Song');
  assert.equal(meta.artist, 'The Band');
  assert.equal(meta.album, 'Greatest Hits');
  assert.equal(meta.track, 3); // split on '/'
  assert.equal(meta.year, 1999);
  assert.equal(meta.genre, 'Rock');
});

test('extractID3v2 honours v2.4 syncsafe sizes and TDRC', () => {
  // 200+ byte frame so v2.3 vs v2.4 size encodings would disagree.
  const big = 'x'.repeat(200);
  const frames = Buffer.concat([
    id3v24TextFrame('TIT2', big),
    id3v24TextFrame('TDRC', '2024-07-15T12:00:00'),
  ]);
  const tag = id3Tag(4, frames);
  const meta = extractID3v2(tag);
  assert.equal(meta.title, big);
  assert.equal(meta.year, 2024);
});

test('extractID3v2 resolves a TCON "(17)" reference to "Rock"', () => {
  const frames = id3v23TextFrame('TCON', '(17)');
  const meta = extractID3v2(id3Tag(3, frames));
  assert.equal(meta.genre, 'Rock');
});

test('extractID3v2 prefers free-form text after a "(N)" prefix', () => {
  const frames = id3v23TextFrame('TCON', '(17)Punk Rock');
  const meta = extractID3v2(id3Tag(3, frames));
  assert.equal(meta.genre, 'Punk Rock');
});

test('extractID3v2 returns null for a non-ID3 buffer', () => {
  assert.equal(extractID3v2(Buffer.from('no tag here')), null);
  assert.equal(extractID3v2(Buffer.alloc(0)), null);
});

test('extractID3v2 returns null for v2.2 (we do not support it)', () => {
  const tag = id3Tag(2, Buffer.alloc(0));
  assert.equal(extractID3v2(tag), null);
});

test('extractMP3Metadata falls back to ID3v1 when v2 is missing', () => {
  // 128 bytes: "TAG" + 30 title + 30 artist + 30 album + 4 year +
  //            30 comment + 1 genre. We pre-fill with NUL.
  const v1 = Buffer.alloc(128, 0);
  v1.write('TAG', 0, 'ascii');
  v1.write('Old Title', 3, 'ascii');
  v1.write('Old Artist', 33, 'ascii');
  v1.write('Old Album', 63, 'ascii');
  v1.write('1995', 93, 'ascii');
  // ID3v1.1 track-number hack: the 29th byte of comment is 0, the
  // 30th is the track number. Comment starts at offset 97.
  v1[97 + 28] = 0;  // 29th byte (0-indexed: 28)
  v1[97 + 29] = 7;  // 30th byte: track 7
  v1[127] = 17;     // genre index 17 → "Rock"
  // Plus some leading audio bytes so the parser doesn't think the
  // file starts with the v1 tag.
  const leadingBytes = Buffer.alloc(500, 0xff);
  const meta = extractMP3Metadata(Buffer.concat([leadingBytes, v1]));
  assert.equal(meta.title, 'Old Title');
  assert.equal(meta.artist, 'Old Artist');
  assert.equal(meta.album, 'Old Album');
  assert.equal(meta.year, 1995);
  assert.equal(meta.track, 7);
  assert.equal(meta.genre, 'Rock');
});

test('extractID3v1 returns null without the "TAG" sentinel', () => {
  assert.equal(extractID3v1(Buffer.alloc(128, 0)), null);
  assert.equal(extractID3v1(Buffer.alloc(50, 0)), null);
});

test('extractMP3Metadata returns an all-null object for an empty buffer', () => {
  const meta = extractMP3Metadata(Buffer.alloc(0));
  assert.equal(meta.title, null);
  assert.equal(meta.artist, null);
  assert.equal(meta.album, null);
});

test('extractID3v2 ignores TXXX frames (we only want named text frames)', () => {
  const frames = Buffer.concat([
    id3v23TextFrame('TIT2', 'The Title'),
    // TXXX has a different payload format — we must not crash trying
    // to read it as a plain text frame.
    id3v23TextFrame('TXXX', 'description\x00value'),
  ]);
  const meta = extractID3v2(id3Tag(3, frames));
  assert.equal(meta.title, 'The Title');
});

test('extractID3v2 stops at zero-byte padding', () => {
  const frames = Buffer.concat([
    id3v23TextFrame('TIT2', 'Real Title'),
    Buffer.alloc(100, 0), // padding
  ]);
  const meta = extractID3v2(id3Tag(3, frames));
  assert.equal(meta.title, 'Real Title');
});

// ---------------------------------------------------------------------------
// MP4 / M4A
// ---------------------------------------------------------------------------

// The MP4 `©nam`/`©ART`/`©alb`/`©day`/`©gen` tag codes start with a
// single 0xa9 byte — not the two-byte UTF-8 sequence the © glyph
// becomes when JS writes it as 'ascii'/'utf8'. The container stores
// 4 raw bytes per tag code, so the test builder hands the parser the
// exact bytes the real format uses.
function rawBox(typeBytes, body) {
  return Buffer.concat([
    uint32be(8 + body.length),
    Buffer.from(typeBytes),
    body,
  ]);
}
function rawIlstTextItem(typeBytes, value) {
  return rawBox(typeBytes, ilstData(1, Buffer.from(value, 'utf8')));
}

test('extractMP4Metadata reads single-byte ©-prefix tag codes', () => {
  const items = Buffer.concat([
    rawIlstTextItem([0xa9, 0x6e, 0x61, 0x6d], 'The Song'),    // ©nam
    rawIlstTextItem([0xa9, 0x41, 0x52, 0x54], 'Some Artist'), // ©ART
    rawIlstTextItem([0xa9, 0x61, 0x6c, 0x62], 'Some Album'),  // ©alb
    rawIlstTextItem([0xa9, 0x64, 0x61, 0x79], '2021'),        // ©day
    rawIlstTextItem([0xa9, 0x67, 0x65, 0x6e], 'Indie'),       // ©gen
  ]);
  const metaBox = box('meta', Buffer.concat([
    Buffer.alloc(4, 0),
    box('ilst', items),
  ]));
  const moov = box('moov', box('udta', metaBox));
  const result = extractMP4Metadata(moov);
  assert.equal(result.title, 'The Song');
  assert.equal(result.artist, 'Some Artist');
  assert.equal(result.album, 'Some Album');
  assert.equal(result.year, 2021);
  assert.equal(result.genre, 'Indie');
});

test('extractMP4Metadata reads the trkn special format', () => {
  // trkn data is binary (typeIndicator 0): 16-bit zero + 16-bit track
  // + 16-bit total. We pack track=5, total=11.
  const trknData = Buffer.concat([
    uint16be(0), uint16be(5), uint16be(11), uint16be(0),
  ]);
  const item = box('trkn', ilstData(0, trknData));
  const metaBox = box('meta', Buffer.concat([
    Buffer.alloc(4, 0),
    box('ilst', item),
  ]));
  const moov = box('moov', box('udta', metaBox));
  const result = extractMP4Metadata(moov);
  assert.equal(result.track, 5);
});

test('extractMP4Metadata reads gnre numeric genre', () => {
  // gnre stores (index+1) as a 16-bit big-endian. 18 here = ID3v1
  // genre index 17 → "Rock".
  const gnreData = Buffer.concat([uint16be(18)]);
  const item = box('gnre', ilstData(0, gnreData));
  const metaBox = box('meta', Buffer.concat([
    Buffer.alloc(4, 0),
    box('ilst', item),
  ]));
  const moov = box('moov', box('udta', metaBox));
  const result = extractMP4Metadata(moov);
  assert.equal(result.genre, 'Rock');
});

test('extractMP4Metadata reads mvhd duration', () => {
  // mvhd version 0:
  //   1 byte version + 3 bytes flags
  //   4 bytes created + 4 bytes modified
  //   4 bytes timescale + 4 bytes duration
  //   ...rate, volume, reserved, matrix (we don't need them)
  const mvhdBody = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),  // version + flags
    uint32be(0),                 // created
    uint32be(0),                 // modified
    uint32be(1000),              // timescale: 1000 ticks/second
    uint32be(180000),            // duration: 180000 ticks = 180s
  ]);
  const moov = box('moov', box('mvhd', mvhdBody));
  const result = extractMP4Metadata(moov);
  assert.equal(result.duration, 180);
});

test('extractMP4Metadata returns an all-null object with no moov atom', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const meta = extractMP4Metadata(ftyp);
  assert.equal(meta.title, null);
  assert.equal(meta.artist, null);
});

test('findBox locates a nested child by 4-char type', () => {
  const inner = Buffer.concat([
    box('foo!', Buffer.from('one')),
    box('bar!', Buffer.from('two')),
  ]);
  const m = findBox(inner, 0, inner.length, 'bar!');
  assert.ok(m);
  assert.equal(Buffer.from(inner.subarray(m.start, m.end)).toString(), 'two');
});

// ---------------------------------------------------------------------------
// OGG (Vorbis / Opus)
// ---------------------------------------------------------------------------

/**
 * Build a minimal Ogg page wrapping a single packet of `data`. The
 * page header is 27 bytes plus a segment table. We compute the
 * segment table from the data length: 255-byte segments for as many
 * full segments as fit, plus a final shorter segment that ends the
 * packet (length < 255).
 */
function oggPage(data, pageSeq = 0, headerType = 0) {
  const segments = [];
  let remaining = data.length;
  while (remaining > 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining); // <255 ends the packet (0 is fine too)
  const header = Buffer.concat([
    Buffer.from('OggS', 'ascii'),
    Buffer.from([0]),                  // version
    Buffer.from([headerType]),          // header_type_flag
    Buffer.alloc(8, 0),                 // granule position
    uint32le(1),                        // bitstream serial
    uint32le(pageSeq),                  // page sequence
    uint32le(0),                        // checksum (parser doesn't check)
    Buffer.from([segments.length]),     // number of page segments
    Buffer.from(segments),              // segment table
  ]);
  return Buffer.concat([header, data]);
}

/** A Vorbis identification packet: 0x01 + "vorbis" + 23 padding bytes. */
function vorbisIdPacket() {
  return Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from('vorbis', 'ascii'),
    Buffer.alloc(23, 0),
  ]);
}

/** A Vorbis comment packet: 0x03 + "vorbis" + vendor + comments. */
function vorbisCommentPacket(comments) {
  const vendor = Buffer.from('test vendor', 'utf8');
  const entries = comments.map((s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([uint32le(b.length), b]);
  });
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from('vorbis', 'ascii'),
    uint32le(vendor.length),
    vendor,
    uint32le(entries.length),
    ...entries,
    Buffer.from([0x01]), // framing bit
  ]);
}

/** An Opus head packet (minimal). */
function opusHeadPacket() {
  return Buffer.concat([
    Buffer.from('OpusHead', 'ascii'),
    Buffer.from([1]),       // version
    Buffer.from([2]),       // channel count
    Buffer.alloc(2, 0),     // preskip
    uint32le(48000),        // input sample rate
    Buffer.alloc(2, 0),     // output gain
    Buffer.from([0]),       // channel mapping family
  ]);
}

/** An Opus tags packet: "OpusTags" + vendor + comments. */
function opusTagsPacket(comments) {
  const vendor = Buffer.from('test vendor', 'utf8');
  const entries = comments.map((s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([uint32le(b.length), b]);
  });
  return Buffer.concat([
    Buffer.from('OpusTags', 'ascii'),
    uint32le(vendor.length),
    vendor,
    uint32le(entries.length),
    ...entries,
  ]);
}

test('extractOGGMetadata reads Vorbis comments (TITLE/ARTIST/...)', () => {
  const id = vorbisIdPacket();
  const comm = vorbisCommentPacket([
    'TITLE=Test Track',
    'ARTIST=Test Band',
    'ALBUM=Test Album',
    'TRACKNUMBER=2',
    'DATE=2018',
    'GENRE=Electronic',
  ]);
  const ogg = Buffer.concat([oggPage(id, 0), oggPage(comm, 1)]);
  const meta = extractOGGMetadata(ogg);
  assert.equal(meta.title, 'Test Track');
  assert.equal(meta.artist, 'Test Band');
  assert.equal(meta.album, 'Test Album');
  assert.equal(meta.track, 2);
  assert.equal(meta.year, 2018);
  assert.equal(meta.genre, 'Electronic');
});

test('extractOGGMetadata reads Opus tags', () => {
  const head = opusHeadPacket();
  const tags = opusTagsPacket([
    'TITLE=Opus Song',
    'ARTIST=Opus Artist',
  ]);
  const ogg = Buffer.concat([oggPage(head, 0), oggPage(tags, 1)]);
  const meta = extractOGGMetadata(ogg);
  assert.equal(meta.title, 'Opus Song');
  assert.equal(meta.artist, 'Opus Artist');
});

test('extractOGGMetadata is case-insensitive on comment keys', () => {
  const id = vorbisIdPacket();
  const comm = vorbisCommentPacket([
    'title=lowercase title',
    'Artist=mixed case artist',
  ]);
  const ogg = Buffer.concat([oggPage(id, 0), oggPage(comm, 1)]);
  const meta = extractOGGMetadata(ogg);
  assert.equal(meta.title, 'lowercase title');
  assert.equal(meta.artist, 'mixed case artist');
});

test('extractOGGMetadata returns all-null on a non-Ogg buffer', () => {
  const meta = extractOGGMetadata(Buffer.from('not an ogg stream at all'));
  assert.equal(meta.title, null);
});

test('extractOGGCommentPacket reconstructs a packet that spans pages', () => {
  // Build a comment packet exactly 300 bytes long (one segment of
  // 255 + one of 45 — but we put 255 on its own page so the second
  // page continues with the remaining 45). The parser must
  // concatenate across the page boundary.
  const id = vorbisIdPacket();
  const big = Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from('vorbis', 'ascii'),
    uint32le(0),    // empty vendor
    uint32le(0),    // zero comments
    Buffer.alloc(286, 0x42), // padding to reach 300 bytes total
    Buffer.from([0x01]), // framing bit
  ]);
  // 300 bytes — first page carries 255, second page carries 45.
  const firstSegment = big.subarray(0, 255);
  const secondSegment = big.subarray(255);
  // Page 1: one segment of 255 (continued).
  const page1 = Buffer.concat([
    Buffer.from('OggS', 'ascii'),
    Buffer.from([0, 0]),
    Buffer.alloc(8, 0),
    uint32le(1),
    uint32le(1),
    uint32le(0),
    Buffer.from([1, 255]),
    firstSegment,
  ]);
  // Page 2: one segment of `secondSegment.length` (ends packet).
  const page2 = Buffer.concat([
    Buffer.from('OggS', 'ascii'),
    Buffer.from([0, 0]),
    Buffer.alloc(8, 0),
    uint32le(1),
    uint32le(2),
    uint32le(0),
    Buffer.from([1, secondSegment.length]),
    secondSegment,
  ]);
  const ogg = Buffer.concat([oggPage(id, 0), page1, page2]);
  const packet = extractOGGCommentPacket(ogg);
  assert.ok(packet);
  assert.equal(packet.length, big.length);
});

// ---------------------------------------------------------------------------
// Dispatch + IO
// ---------------------------------------------------------------------------

test('extractMetadata dispatches by suffix and reads a file', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'jmacs-metadata-'));
  try {
    const frames = Buffer.concat([
      id3v23TextFrame('TIT2', 'Disk Title'),
      id3v23TextFrame('TPE1', 'Disk Artist'),
    ]);
    const tag = id3Tag(3, frames);
    const path = join(tmp, 'sample.mp3');
    await writeFile(path, tag);
    const meta = await extractMetadata(path);
    assert.ok(meta);
    assert.equal(meta.title, 'Disk Title');
    assert.equal(meta.artist, 'Disk Artist');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('extractMetadata returns null for an unsupported suffix', async () => {
  assert.equal(await extractMetadata('/no/such/file.flac'), null);
  assert.equal(await extractMetadata('/no/such/file.wav'), null);
});

test('extractMetadata returns null for unreadable / invalid input', async () => {
  assert.equal(await extractMetadata('/no/such/path.mp3'), null);
  assert.equal(await extractMetadata(null), null);
  assert.equal(await extractMetadata(undefined), null);
  assert.equal(await extractMetadata(''), null);
});
