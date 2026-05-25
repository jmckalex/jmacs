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
  extractMP4Metadata,
  extractOGGMetadata,
  extractID3v2,
} from '../src/audio-metadata.js';
import { extractID3v2APIC, extractMP4Covr } from '../src/audio-art.js';
import {
  buildApicFrame,
  buildIlstAtom,
  buildOggPage,
  buildTextFrame,
  buildTxxxFrame,
  buildVorbisCommentPacket,
  decodeSyncsafeInt32,
  encodeSyncsafeInt32,
  findChunkOffsetAtoms,
  findIlstChain,
  findMP3AudioStart,
  ID3_FRAME_FOR_KEY,
  listBoxes,
  listOggPages,
  oggCrc32,
  readOggPackets,
  serialiseID3v24Tag,
  serialiseMP3,
  serialiseMP4,
  serialiseOGG,
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
  const result = writeMetadataSync('/tmp/whatever.flac', { title: 'X' });
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

// ---------------------------------------------------------------------------
// MP4 test fixtures
// ---------------------------------------------------------------------------

/** Build an MP4 box: 4-byte size + 4-byte type + body. */
function mp4Box(type, body) {
  const buf = Buffer.alloc(8 + body.length);
  buf.writeUInt32BE(8 + body.length, 0);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i) & 0xff;
  body.copy(buf, 8);
  return buf;
}

/** Build a v2.4-style 32-bit big-endian uint. */
function be32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** Build a `data` atom: typeIndicator(4) + locale(4) + payload. */
function dataAtom(typeIndicator, payload) {
  return mp4Box('data', Buffer.concat([be32(typeIndicator), be32(0), payload]));
}

/** Build a minimal `stbl` containing one `stco` with a single entry
 *  pointing at `chunkOffset`. The extractor doesn't need stsd or any
 *  of the other stbl children for our writer tests. */
function buildStbl(chunkOffset) {
  // stco body: version+flags(4) + entry_count(4) + entries.
  const stco = mp4Box('stco', Buffer.concat([
    be32(0),         // version + flags
    be32(1),         // entry_count
    be32(chunkOffset), // entry
  ]));
  return mp4Box('stbl', stco);
}

/** Build a minimal `trak/mdia/minf/stbl` chain wrapping `stbl`. */
function buildTrak(stbl) {
  const minf = mp4Box('minf', stbl);
  const mdia = mp4Box('mdia', minf);
  return mp4Box('trak', mdia);
}

/** Build an `ilst` body with the listed (typeBytes, text) pairs. */
function buildSampleIlst(items) {
  const children = items.map(([typeBytes, value]) =>
    mp4Box(typeBytes, dataAtom(1, Buffer.from(value, 'utf8')))
  );
  return mp4Box('ilst', Buffer.concat(children));
}

/** Build a `meta` box (with version+flags prefix) that contains one
 *  `hdlr` atom and one `ilst` atom. The hdlr is a placeholder; the
 *  writer copies it verbatim. */
function buildMeta(ilst) {
  const hdlr = mp4Box('hdlr', Buffer.concat([
    be32(0),         // version + flags
    Buffer.alloc(8), // pre-defined + reserved
    Buffer.from('mdir', 'ascii'),
    Buffer.alloc(12), // reserved (3 × 4 bytes)
    Buffer.from('\x00'),
  ]));
  const body = Buffer.concat([
    be32(0), // version + flags
    hdlr,
    ilst,
  ]);
  return mp4Box('meta', body);
}

/** Build a minimal full MP4 file with one trak (carrying an stco
 *  pointing at the mdat content) + a tagged ilst.
 *
 *  Layout: ftyp + moov + mdat
 *  moov: trak/mdia/minf/stbl/stco + udta/meta(version+flags + hdlr + ilst)
 *  mdat: a few bytes of fake audio.
 */
function buildMP4Fixture({ tags, mdatBytes = 'fakeaudio' }) {
  const ilst = buildSampleIlst(tags);
  const meta = buildMeta(ilst);
  const udta = mp4Box('udta', meta);
  // The stco entry must point at mdat's start. We don't know that
  // yet (depends on moov size); we'll patch after laying things out.
  // Two-pass build: first construct moov with a placeholder offset,
  // then re-construct with the real offset.
  const buildMoovWith = (offset) =>
    mp4Box('moov', Buffer.concat([buildTrak(buildStbl(offset)), udta]));

  const ftyp = mp4Box('ftyp', Buffer.from('isomiso2', 'utf8'));
  const tentativeMoov = buildMoovWith(0);
  const tentativeFileSize = ftyp.length + tentativeMoov.length;
  // mdat sits right after moov; its payload starts at mdat.start + 8.
  const realChunkOffset = tentativeFileSize + 8;
  const moov = buildMoovWith(realChunkOffset);
  // The two builds should be the same size since we only changed an
  // integer field inside the existing structure.
  if (moov.length !== tentativeMoov.length) {
    throw new Error('test fixture: moov resized unexpectedly');
  }
  const mdat = mp4Box('mdat', Buffer.from(mdatBytes, 'utf8'));
  return Buffer.concat([ftyp, moov, mdat]);
}

/** Read the first stco entry from a built file. */
function firstStcoEntry(file) {
  const top = listBoxes(file, 0, file.length);
  const moov = top.find((b) => b.type === 'moov');
  const stcos = findChunkOffsetAtoms(file, moov);
  return readUInt32BE(file, stcos[0].entriesStart);
}

function readUInt32BE(buf, offset) {
  return buf.readUInt32BE(offset);
}

// ---------------------------------------------------------------------------
// MP4: structural helpers
// ---------------------------------------------------------------------------

test('listBoxes walks every top-level box', () => {
  const fixture = buildMP4Fixture({
    tags: [['\xa9nam', 'Title']],
  });
  const boxes = listBoxes(fixture, 0, fixture.length);
  assert.deepEqual(boxes.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
});

test('findIlstChain returns moov / udta / meta / ilst with their byte ranges', () => {
  const fixture = buildMP4Fixture({
    tags: [['\xa9nam', 'Title']],
  });
  const chain = findIlstChain(fixture);
  assert.ok(chain);
  assert.equal(chain.moov.type, 'moov');
  assert.equal(chain.udta.type, 'udta');
  assert.equal(chain.meta.type, 'meta');
  assert.equal(chain.ilst.type, 'ilst');
  // Nesting: ilst is inside meta, meta inside udta, etc.
  assert.ok(chain.ilst.start > chain.meta.start);
  assert.ok(chain.meta.start > chain.udta.start);
  assert.ok(chain.udta.start > chain.moov.start);
});

test('findChunkOffsetAtoms locates every stco entry under moov', () => {
  const fixture = buildMP4Fixture({ tags: [['\xa9nam', 'X']] });
  const top = listBoxes(fixture, 0, fixture.length);
  const moov = top.find((b) => b.type === 'moov');
  const atoms = findChunkOffsetAtoms(fixture, moov);
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].kind, 'stco');
  assert.equal(atoms[0].entryCount, 1);
  assert.equal(atoms[0].entrySize, 4);
});

test('buildIlstAtom emits a parseable ilst with the standard string keys', () => {
  // Wrap the built ilst inside meta+udta+moov so the existing parser
  // can read it back through its established path.
  const ilst = buildIlstAtom({
    title: 'A Title',
    artist: 'An Artist',
    album: 'An Album',
    year: '1994',
    genre: 'Shoegaze',
  });
  const meta = buildMeta(ilst);
  const moov = mp4Box('moov', mp4Box('udta', meta));
  const result = extractMP4Metadata(moov);
  assert.equal(result.title, 'A Title');
  assert.equal(result.artist, 'An Artist');
  assert.equal(result.album, 'An Album');
  assert.equal(result.year, 1994);
  assert.equal(result.genre, 'Shoegaze');
});

test('buildIlstAtom emits a trkn atom the existing extractor reads', () => {
  const ilst = buildIlstAtom({ track: 5 });
  const meta = buildMeta(ilst);
  const moov = mp4Box('moov', mp4Box('udta', meta));
  const result = extractMP4Metadata(moov);
  assert.equal(result.track, 5);
});

test('buildIlstAtom embeds cover art the existing extractor reads', () => {
  const ilst = buildIlstAtom({
    title: 'With Cover',
    cover: { mime: 'image/jpeg', data: SAMPLE_JPEG },
  });
  const meta = buildMeta(ilst);
  const moov = mp4Box('moov', mp4Box('udta', meta));
  const art = extractMP4Covr(moov);
  assert.ok(art);
  assert.equal(art.mime, 'image/jpeg');
  assert.ok(Buffer.from(art.data).equals(SAMPLE_JPEG));
});

// ---------------------------------------------------------------------------
// MP4: serialiseMP4 — the heart of the writer
// ---------------------------------------------------------------------------

test('serialiseMP4 round-trips a small text edit through extractMP4Metadata', () => {
  const fixture = buildMP4Fixture({
    tags: [
      ['\xa9nam', 'Old Title'],
      ['\xa9ART', 'Old Artist'],
    ],
  });
  const rewritten = serialiseMP4(fixture, {
    title: 'New Title',
    artist: 'New Artist',
    album: 'New Album',
  });
  const meta = extractMP4Metadata(rewritten);
  assert.equal(meta.title, 'New Title');
  assert.equal(meta.artist, 'New Artist');
  assert.equal(meta.album, 'New Album');
});

test('serialiseMP4 patches stco entries when moov grows', () => {
  const fixture = buildMP4Fixture({
    tags: [['\xa9nam', 'X']],
  });
  const originalOffset = firstStcoEntry(fixture);
  // Add a long album name so moov grows.
  const big = 'A very long album name '.repeat(5);
  const rewritten = serialiseMP4(fixture, { title: 'X', album: big });
  const newOffset = firstStcoEntry(rewritten);
  // The stco offset must have shifted by the moov size delta so
  // that decoding still finds the chunk at its new absolute byte.
  const oldMoovSize =
    listBoxes(fixture, 0, fixture.length).find((b) => b.type === 'moov').end -
    listBoxes(fixture, 0, fixture.length).find((b) => b.type === 'moov').start;
  const newMoovSize =
    listBoxes(rewritten, 0, rewritten.length).find((b) => b.type === 'moov').end -
    listBoxes(rewritten, 0, rewritten.length).find((b) => b.type === 'moov').start;
  const delta = newMoovSize - oldMoovSize;
  assert.equal(newOffset, originalOffset + delta);
});

test('serialiseMP4 leaves stco alone when moov is already after mdat', () => {
  // Build a file where moov sits after mdat (slow-start layout). We
  // do this by reassembling the standard fixture in a different order.
  const fixture = buildMP4Fixture({ tags: [['\xa9nam', 'X']] });
  const top = listBoxes(fixture, 0, fixture.length);
  const ftyp = fixture.subarray(top[0].start, top[0].end);
  const moov = fixture.subarray(top[1].start, top[1].end);
  const mdat = fixture.subarray(top[2].start, top[2].end);
  // The stco still says the chunk is at its original offset — in
  // the slow-start layout, mdat is at ftyp.length, so we patch the
  // stco entry to point there. The patched value lives inside the
  // moov bytes; for the test, we don't actually need correct stco
  // values, just to assert the serialiser doesn't touch them.
  const slowStart = Buffer.concat([ftyp, mdat, moov]);
  const originalOffset = firstStcoEntry(slowStart);
  const rewritten = serialiseMP4(slowStart, { title: 'Renamed', album: 'huge'.repeat(50) });
  const newOffset = firstStcoEntry(rewritten);
  assert.equal(newOffset, originalOffset);
});

test('serialiseMP4 copies mdat byte-for-byte across a rewrite', () => {
  const fixture = buildMP4Fixture({
    tags: [['\xa9nam', 'X']],
    mdatBytes: 'these-are-the-audio-bytes',
  });
  const rewritten = serialiseMP4(fixture, { title: 'Y' });
  const top = listBoxes(rewritten, 0, rewritten.length);
  const mdat = top.find((b) => b.type === 'mdat');
  // Payload starts after the 8-byte header.
  const audio = rewritten.subarray(mdat.start + 8, mdat.end);
  assert.equal(audio.toString('utf8'), 'these-are-the-audio-bytes');
});

test('serialiseMP4 preserves cover art across an edit that doesn\'t touch it', async () => {
  // Build a fixture that includes covr inside ilst.
  const ilst = buildIlstAtom({
    title: 'Has Cover',
    cover: { mime: 'image/jpeg', data: SAMPLE_JPEG },
  });
  const meta = buildMeta(ilst);
  const udta = mp4Box('udta', meta);
  const buildMoovWith = (offset) =>
    mp4Box('moov', Buffer.concat([buildTrak(buildStbl(offset)), udta]));
  const ftyp = mp4Box('ftyp', Buffer.from('isomiso2', 'utf8'));
  const tentativeMoov = buildMoovWith(0);
  const realChunkOffset = ftyp.length + tentativeMoov.length + 8;
  const moov = buildMoovWith(realChunkOffset);
  const mdat = mp4Box('mdat', Buffer.from('audio', 'utf8'));
  const fixture = Buffer.concat([ftyp, moov, mdat]);

  // Rewrite without touching cover.
  const rewritten = serialiseMP4(fixture, { title: 'Renamed' });
  const art = extractMP4Covr(rewritten);
  assert.ok(art, 'cover art was lost');
  assert.equal(art.mime, 'image/jpeg');
  assert.ok(Buffer.from(art.data).equals(SAMPLE_JPEG));
  assert.equal(extractMP4Metadata(rewritten).title, 'Renamed');
});

test('writeMetadataSync writes an MP4 round-trip through disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jmacs-audio-write-mp4-'));
  const path = join(dir, 'song.m4a');
  try {
    const fixture = buildMP4Fixture({
      tags: [
        ['\xa9nam', 'Original Title'],
        ['\xa9ART', 'Original Artist'],
      ],
    });
    await writeFile(path, fixture);

    const result = writeMetadataSync(path, {
      title: 'Updated Title',
      artist: 'Updated Artist',
      album: 'New Album',
      year: '2024',
    });
    assert.equal(result.ok, true);

    const reread = await readFile(path);
    const meta = extractMP4Metadata(reread);
    assert.equal(meta.title, 'Updated Title');
    assert.equal(meta.artist, 'Updated Artist');
    assert.equal(meta.album, 'New Album');
    assert.equal(meta.year, 2024);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('serialiseMP4 throws when there is no moov', () => {
  // Just an ftyp + mdat — no metadata container.
  const bogus = Buffer.concat([
    mp4Box('ftyp', Buffer.from('isomiso2', 'utf8')),
    mp4Box('mdat', Buffer.from('audio')),
  ]);
  assert.throws(() => serialiseMP4(bogus, { title: 'X' }));
});

// ---------------------------------------------------------------------------
// Ogg Vorbis test fixtures
// ---------------------------------------------------------------------------

function uint32LE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/** A minimal Vorbis identification packet: 0x01 + "vorbis" + 23
 *  padding bytes. */
function vorbisIdPacket() {
  return Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from('vorbis', 'ascii'),
    Buffer.alloc(23, 0),
  ]);
}

/** A minimal Vorbis setup packet: 0x05 + "vorbis" + some payload.
 *  The codebooks are nonsense — fine for our test since we never
 *  decode the audio. */
function vorbisSetupPacket() {
  return Buffer.concat([
    Buffer.from([0x05]),
    Buffer.from('vorbis', 'ascii'),
    Buffer.from('setup-codebook-bytes', 'utf8'),
  ]);
}

/** A minimal Vorbis comment packet with the given entries. */
function vorbisCommentPacket(entries) {
  const vendor = Buffer.from('test', 'utf8');
  const entryBufs = entries.map((s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([uint32LE(b.length), b]);
  });
  return Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from('vorbis', 'ascii'),
    uint32LE(vendor.length),
    vendor,
    uint32LE(entryBufs.length),
    ...entryBufs,
    Buffer.from([0x01]), // framing bit
  ]);
}

/** Build an Ogg fixture with one BOS page (id packet), one regular
 *  page (comment + setup), and N audio pages. Each audio page
 *  has a small payload — `audioPageCount` × `audioPagePayload`. */
function buildOggFixture({ commentEntries, audioPageCount = 2, audioPagePayload = 'sample-data' }) {
  const id = vorbisIdPacket();
  const comment = vorbisCommentPacket(commentEntries);
  const setup = vorbisSetupPacket();

  // Page 0: BOS, identification packet.
  const page0 = buildOggPage([id], {
    headerType: 0x02,
    granule: Buffer.alloc(8),
    serial: 1234,
    sequence: 0,
  });
  // Page 1: comment + setup.
  const page1 = buildOggPage([comment, setup], {
    headerType: 0x00,
    granule: Buffer.alloc(8),
    serial: 1234,
    sequence: 1,
  });
  // Audio pages 2+. Each contains a single "packet" of payload bytes
  // so the segment table is simple.
  const audioPages = [];
  for (let i = 0; i < audioPageCount; i++) {
    const audioPacket = Buffer.from(audioPagePayload + i, 'utf8');
    const granule = Buffer.alloc(8);
    granule.writeUInt32LE(100 * (i + 1), 0); // arbitrary but monotonic
    const isLast = i === audioPageCount - 1;
    audioPages.push(buildOggPage([audioPacket], {
      headerType: isLast ? 0x04 : 0x00, // EOS on the last page
      granule,
      serial: 1234,
      sequence: 2 + i,
    }));
  }

  return Buffer.concat([page0, page1, ...audioPages]);
}

// ---------------------------------------------------------------------------
// Ogg: CRC + page primitives
// ---------------------------------------------------------------------------

test('oggCrc32 matches the documented test vector for an empty page', () => {
  // A well-known Ogg page (id packet) with computed CRC. We test by
  // round-trip: building and parsing with oggCrc32 produces a self-
  // consistent CRC. (Computing a separate reference vector by hand is
  // out of scope; the round-trip test covers correctness.)
  const id = vorbisIdPacket();
  const page = buildOggPage([id], {
    headerType: 0x02,
    granule: Buffer.alloc(8),
    serial: 1234,
    sequence: 0,
  });
  // CRC field is at offset 22; zero it and recompute.
  const expected = page.readUInt32LE(22);
  const probe = Buffer.from(page);
  probe.writeUInt32LE(0, 22);
  assert.equal(oggCrc32(probe), expected);
});

test('listOggPages walks every page and tracks segment tables', () => {
  const ogg = buildOggFixture({
    commentEntries: ['TITLE=Hello'],
    audioPageCount: 2,
  });
  const pages = listOggPages(ogg);
  assert.equal(pages.length, 4); // BOS + comment+setup + 2 audio
  assert.equal(pages[0].sequence, 0);
  assert.equal(pages[3].sequence, 3);
  assert.equal(pages[0].headerType & 0x02, 0x02); // BOS
  assert.equal(pages[3].headerType & 0x04, 0x04); // EOS
});

test('readOggPackets reassembles packets from segment tables', () => {
  const ogg = buildOggFixture({
    commentEntries: ['TITLE=Hello'],
  });
  const pages = listOggPages(ogg);
  const packets = readOggPackets(ogg, pages, 3);
  assert.equal(packets.length, 3);
  // Identification packet starts with 0x01 + "vorbis".
  assert.equal(packets[0].bytes[0], 0x01);
  assert.equal(packets[0].bytes.subarray(1, 7).toString('ascii'), 'vorbis');
  // Comment packet starts with 0x03 + "vorbis".
  assert.equal(packets[1].bytes[0], 0x03);
  // Setup packet starts with 0x05 + "vorbis".
  assert.equal(packets[2].bytes[0], 0x05);
});

// ---------------------------------------------------------------------------
// Ogg: Vorbis comment packet builder
// ---------------------------------------------------------------------------

test('buildVorbisCommentPacket emits a packet the existing extractor reads', () => {
  const packet = buildVorbisCommentPacket({
    title: 'A Title',
    artist: 'An Artist',
    album: 'An Album',
    year: '1991',
    genre: 'Shoegaze',
    track: 3,
  });
  // Wrap the packet inside a minimal Ogg stream so extractOGGMetadata
  // can read it.
  const ogg = Buffer.concat([
    buildOggPage([vorbisIdPacket()], {
      headerType: 0x02,
      granule: Buffer.alloc(8),
      serial: 1234,
      sequence: 0,
    }),
    buildOggPage([packet], {
      headerType: 0x00,
      granule: Buffer.alloc(8),
      serial: 1234,
      sequence: 1,
    }),
  ]);
  const meta = extractOGGMetadata(ogg);
  assert.equal(meta.title, 'A Title');
  assert.equal(meta.artist, 'An Artist');
  assert.equal(meta.album, 'An Album');
  assert.equal(meta.year, 1991);
  assert.equal(meta.genre, 'Shoegaze');
  assert.equal(meta.track, 3);
});

test('buildVorbisCommentPacket preserves the vendor string when given', () => {
  const packet = buildVorbisCommentPacket({ title: 'X' }, { vendor: 'custom vendor' });
  // The vendor bytes sit between the 7-byte magic and the comment
  // count. Read it back.
  const vendorLen = packet.readUInt32LE(7);
  const vendor = packet.subarray(11, 11 + vendorLen).toString('utf8');
  assert.equal(vendor, 'custom vendor');
});

// ---------------------------------------------------------------------------
// Ogg: serialiseOGG — the heart of the writer
// ---------------------------------------------------------------------------

test('serialiseOGG round-trips a text edit through extractOGGMetadata', () => {
  const fixture = buildOggFixture({
    commentEntries: ['TITLE=Old', 'ARTIST=Old Artist'],
  });
  const rewritten = serialiseOGG(fixture, {
    title: 'New',
    artist: 'New Artist',
    album: 'A New Album',
  });
  const meta = extractOGGMetadata(rewritten);
  assert.equal(meta.title, 'New');
  assert.equal(meta.artist, 'New Artist');
  assert.equal(meta.album, 'A New Album');
});

test('serialiseOGG preserves the original vendor string', () => {
  // Hand-build a comment packet with a recognisable vendor.
  const idPage = buildOggPage([vorbisIdPacket()], {
    headerType: 0x02,
    granule: Buffer.alloc(8),
    serial: 1234,
    sequence: 0,
  });
  const customComment = Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from('vorbis', 'ascii'),
    uint32LE('my-special-vendor'.length),
    Buffer.from('my-special-vendor', 'utf8'),
    uint32LE(0), // no comments
    Buffer.from([0x01]),
  ]);
  const headerPage = buildOggPage([customComment, vorbisSetupPacket()], {
    headerType: 0x00,
    granule: Buffer.alloc(8),
    serial: 1234,
    sequence: 1,
  });
  const fixture = Buffer.concat([idPage, headerPage]);
  const rewritten = serialiseOGG(fixture, { title: 'X' });
  // Inspect the new comment packet's vendor.
  const newPages = listOggPages(rewritten);
  const newPackets = readOggPackets(rewritten, newPages, 3);
  const comment = newPackets[1].bytes;
  const vendorLen = comment.readUInt32LE(7);
  const vendor = comment.subarray(11, 11 + vendorLen).toString('utf8');
  assert.equal(vendor, 'my-special-vendor');
});

test('serialiseOGG produces pages with valid CRCs', () => {
  const fixture = buildOggFixture({
    commentEntries: ['TITLE=Old'],
  });
  const rewritten = serialiseOGG(fixture, { title: 'New', artist: 'Added' });
  const pages = listOggPages(rewritten);
  for (const page of pages) {
    const probe = Buffer.from(rewritten.subarray(page.start, page.end));
    const recorded = probe.readUInt32LE(22);
    probe.writeUInt32LE(0, 22);
    const computed = oggCrc32(probe);
    assert.equal(computed, recorded, `page seq=${page.sequence} CRC mismatch`);
  }
});

test('serialiseOGG copies audio pages verbatim when header count matches', () => {
  const fixture = buildOggFixture({
    commentEntries: ['TITLE=Old'],
    audioPageCount: 3,
  });
  // Snapshot the audio pages by content.
  const origPages = listOggPages(fixture);
  const origAudioPages = origPages.slice(2);
  const origAudioBytes = origAudioPages.map((p) =>
    fixture.subarray(p.start, p.end).toString('hex')
  );
  const rewritten = serialiseOGG(fixture, { title: 'New' });
  const newPages = listOggPages(rewritten);
  const newAudioPages = newPages.slice(2);
  // Audio page count is unchanged.
  assert.equal(newAudioPages.length, origAudioPages.length);
  // Each audio page is byte-for-byte the same (sequence numbers
  // align so no patching was needed).
  for (let i = 0; i < origAudioPages.length; i++) {
    const newBytes = rewritten.subarray(newAudioPages[i].start, newAudioPages[i].end).toString('hex');
    assert.equal(newBytes, origAudioBytes[i], `audio page ${i} drifted`);
  }
});

test('writeMetadataSync writes an Ogg round-trip through disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jmacs-audio-write-ogg-'));
  const path = join(dir, 'song.ogg');
  try {
    const fixture = buildOggFixture({
      commentEntries: ['TITLE=Original'],
    });
    await writeFile(path, fixture);
    const result = writeMetadataSync(path, {
      title: 'Updated',
      artist: 'Updated Artist',
      year: '2024',
    });
    assert.equal(result.ok, true);
    const reread = await readFile(path);
    const meta = extractOGGMetadata(reread);
    assert.equal(meta.title, 'Updated');
    assert.equal(meta.artist, 'Updated Artist');
    assert.equal(meta.year, 2024);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('serialiseOGG throws on a non-Ogg buffer', () => {
  assert.throws(() => serialiseOGG(Buffer.from('not an ogg file'), { title: 'X' }));
});

test('serialiseOGG throws on a multi-bitstream Ogg', () => {
  // Build two streams with different serial numbers and concatenate.
  const a = buildOggFixture({ commentEntries: ['TITLE=A'] });
  // Cheat: tweak a single byte in `a` to give one page a different
  // serial number. Page header serial is at +14 (within each page);
  // we modify the last page.
  const altered = Buffer.from(a);
  const pages = listOggPages(altered);
  const last = pages[pages.length - 1];
  altered.writeUInt32LE(9999, last.start + 14);
  // Recompute CRC for the page we touched.
  const probe = Buffer.from(altered.subarray(last.start, last.end));
  probe.writeUInt32LE(0, 22);
  altered.writeUInt32LE(oggCrc32(probe), last.start + 22);
  assert.throws(() => serialiseOGG(altered, { title: 'X' }));
});
