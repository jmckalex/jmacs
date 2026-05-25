/**
 * @file Audio metadata writers. Symmetric to `audio-metadata.js`: every
 * write parses the existing file, mutates the in-memory model, then
 * re-serialises a fresh file. No in-place patching, no padding
 * arithmetic, no "did the tag grow?" branches — see
 * `plans/AUDIO-METADATA-EDIT.md` for the rationale.
 *
 * The contract:
 *
 *   writeMetadataSync(path, fields)
 *     → { ok: true } | { ok: false, error: string }
 *
 * `fields` carries the complete new metadata: keys present (with
 * non-null values) become tags, keys absent are removed. Derived
 * fields (`duration`, `file`, `format`, `path`) on input are
 * ignored. The writer preserves embedded cover art (`APIC` /
 * `covr`) by re-reading it from the existing file unless `fields`
 * explicitly carries a `cover` entry.
 *
 * Fidelity loss is deliberate: non-standard frames (COMM, USLT,
 * PRIV, RVA2 …) are not preserved across a write. The writer's
 * output is a clean ID3v2.4 tag with UTF-8 text and a 2KB padding
 * trailer — the format most tools read without complaint.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { extname } from 'node:path';

import { extractID3v2APIC, extractMP4Covr } from './audio-art.js';

/** The 2KB padding ID3v2 tags conventionally carry after the last
 *  frame — iTunes does it, so third-party tools that grow tags
 *  in-place have room to work. We don't grow in place, but emitting
 *  the same padding keeps our files indistinguishable from theirs. */
const ID3V2_PADDING = 2048;

/** Map the renderer's user-facing keys to ID3v2.4 frame IDs. Any
 *  key not in this table is written as a TXXX user-defined frame
 *  with the key as its description. */
export const ID3_FRAME_FOR_KEY = {
  title: 'TIT2',
  artist: 'TPE1',
  album: 'TALB',
  track: 'TRCK',
  year: 'TDRC', // v2.4's recording-time frame
  genre: 'TCON',
};

/** Encode `n` as a 4-byte syncsafe big-endian integer (7 bits per
 *  byte). The high bit of each byte stays zero, so a tag size byte
 *  can never collide with an MPEG sync word inside the audio frames
 *  that follow. */
export function encodeSyncsafeInt32(n) {
  return Buffer.from([
    (n >> 21) & 0x7f,
    (n >> 14) & 0x7f,
    (n >> 7) & 0x7f,
    n & 0x7f,
  ]);
}

/** Decode the 4-byte syncsafe big-endian integer at `offset` in
 *  `buf`. The inverse of `encodeSyncsafeInt32`. */
export function decodeSyncsafeInt32(buf, offset) {
  return (
    ((buf[offset] & 0x7f) << 21) |
    ((buf[offset + 1] & 0x7f) << 14) |
    ((buf[offset + 2] & 0x7f) << 7) |
    (buf[offset + 3] & 0x7f)
  );
}

/** Build one ID3v2.4 text frame: 4-byte ID + 4-byte syncsafe size +
 *  2-byte flags + 1-byte UTF-8 encoding sentinel + UTF-8 payload.
 *  v2.4 omits a trailing NUL — readers stop at the frame boundary. */
export function buildTextFrame(id, value) {
  const text = Buffer.from(String(value), 'utf8');
  const payload = Buffer.concat([Buffer.from([0x03]), text]);
  return Buffer.concat([
    Buffer.from(id, 'ascii'),
    encodeSyncsafeInt32(payload.length),
    Buffer.from([0, 0]),
    payload,
  ]);
}

/** Build a TXXX (user-defined text) frame: encoding + description +
 *  NUL + value (NUL-less for v2.4). The description is what the
 *  third-party tool sees as the "key"; readers identify the frame
 *  by it. */
export function buildTxxxFrame(description, value) {
  const desc = Buffer.from(String(description), 'utf8');
  const val = Buffer.from(String(value), 'utf8');
  const payload = Buffer.concat([
    Buffer.from([0x03]),
    desc,
    Buffer.from([0x00]),
    val,
  ]);
  return Buffer.concat([
    Buffer.from('TXXX', 'ascii'),
    encodeSyncsafeInt32(payload.length),
    Buffer.from([0, 0]),
    payload,
  ]);
}

/** Build an APIC (attached picture) frame. Picture type 3 (cover,
 *  front) — the universal default; the description is empty (one
 *  NUL byte). The MIME is ASCII inside the frame, the image bytes
 *  are appended verbatim. */
export function buildApicFrame(mime, data) {
  const payload = Buffer.concat([
    Buffer.from([0x03]), // encoding for the description, UTF-8
    Buffer.from(String(mime), 'ascii'),
    Buffer.from([0x00]), // MIME terminator
    Buffer.from([0x03]), // picture type 3: cover (front)
    Buffer.from([0x00]), // empty description + terminator
    data,
  ]);
  return Buffer.concat([
    Buffer.from('APIC', 'ascii'),
    encodeSyncsafeInt32(payload.length),
    Buffer.from([0, 0]),
    payload,
  ]);
}

/** Coerce `fields` into a sorted, deterministic list of frame
 *  buffers. Standard keys come first in their declared order; extras
 *  follow alphabetically as TXXX frames. Cover art is always last. */
export function buildID3v24Frames(fields) {
  const frames = [];
  const consumed = new Set(['duration', 'file', 'format', 'path', 'cover']);

  // Standard keys in declared order.
  for (const key of Object.keys(ID3_FRAME_FOR_KEY)) {
    const value = fields[key];
    consumed.add(key);
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === '') continue;
    frames.push(buildTextFrame(ID3_FRAME_FOR_KEY[key], text));
  }

  // Custom keys → TXXX frames, alphabetised so the output is stable.
  const extras = Object.keys(fields)
    .filter((key) => !consumed.has(key))
    .sort();
  for (const key of extras) {
    const value = fields[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === '') continue;
    frames.push(buildTxxxFrame(key.toUpperCase(), text));
  }

  // Cover, if present. Accepts either { mime, data: Buffer } or null.
  if (
    fields.cover &&
    typeof fields.cover === 'object' &&
    fields.cover.data &&
    fields.cover.mime
  ) {
    frames.push(buildApicFrame(fields.cover.mime, Buffer.from(fields.cover.data)));
  }

  return frames;
}

/** Build a complete ID3v2.4 tag: "ID3" header + version + flags +
 *  syncsafe size + frames + padding. The size field counts every byte
 *  after the 10-byte header, padding included. */
export function serialiseID3v24Tag(fields) {
  const frames = buildID3v24Frames(fields);
  const framesBuf = frames.length > 0 ? Buffer.concat(frames) : Buffer.alloc(0);
  const totalSize = framesBuf.length + ID3V2_PADDING;
  return Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([0x04, 0x00, 0x00]), // v2.4.0, no flags
    encodeSyncsafeInt32(totalSize),
    framesBuf,
    Buffer.alloc(ID3V2_PADDING),
  ]);
}

/** Locate the start of the audio stream in an MP3 file: byte after
 *  the ID3v2 tag if one is present, byte 0 otherwise. The tag size
 *  is in bytes 6–9 (syncsafe), the header is 10 bytes total. */
export function findMP3AudioStart(buf) {
  if (buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0; // not "ID3"
  const tagSize = decodeSyncsafeInt32(buf, 6);
  return Math.min(buf.length, 10 + tagSize);
}

/** Drop a trailing ID3v1 tag (128 bytes, "TAG" magic at the start)
 *  if one is present. ID3v2 is canonical; legacy v1 tags get rebuilt
 *  by tools that still write them, so silently dropping is fine. */
export function stripID3v1(buf) {
  if (buf.length < 128) return buf;
  const start = buf.length - 128;
  if (buf[start] === 0x54 && buf[start + 1] === 0x41 && buf[start + 2] === 0x47) {
    return buf.subarray(0, start);
  }
  return buf;
}

/** Serialise a complete MP3 file: fresh ID3v2.4 tag + the existing
 *  audio stream verbatim. Trailing ID3v1 (if any) is dropped. */
export function serialiseMP3(buf, fields) {
  const audioStart = findMP3AudioStart(buf);
  const audioData = stripID3v1(buf.subarray(audioStart));
  return Buffer.concat([serialiseID3v24Tag(fields), audioData]);
}

/** Read the file at `path` and atomically replace it with one
 *  carrying the new metadata. Cover art that exists on the original
 *  is preserved unless `fields` explicitly carries a `cover` entry.
 *
 *  @param {string} path - Absolute path to the MP3 file.
 *  @param {object} fields - The new metadata.
 *  @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeMP3Sync(path, fields) {
  try {
    const buf = readFileSync(path);
    let mergedFields = fields;
    if (!('cover' in fields) || fields.cover === undefined) {
      const existingCover = extractID3v2APIC(buf);
      if (existingCover) {
        mergedFields = { ...fields, cover: existingCover };
      }
    }
    const newBuf = serialiseMP3(buf, mergedFields);
    writeAtomic(path, newBuf);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Dispatch a metadata write by file extension. Currently supports
 *  `.mp3` and `.m4a` / `.mp4`. Ogg Vorbis arrives in its own branch.
 *
 *  @param {string} path - Absolute path to the audio file.
 *  @param {object} fields - The new metadata.
 *  @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeMetadataSync(path, fields) {
  if (typeof path !== 'string' || path === '') {
    return { ok: false, error: 'no path' };
  }
  const ext = extname(path).toLowerCase();
  if (ext === '.mp3') {
    return writeMP3Sync(path, fields);
  }
  if (ext === '.m4a' || ext === '.mp4' || ext === '.m4b') {
    return writeMP4Sync(path, fields);
  }
  if (ext === '.ogg' || ext === '.oga') {
    return writeOGGSync(path, fields);
  }
  return { ok: false, error: `unsupported format: ${ext || '(no extension)'}` };
}

// ---------------------------------------------------------------------------
// MP4 / M4A
// ---------------------------------------------------------------------------

/**
 * MP4 atom-tree primitives. An MP4 file is a sequence of boxes; each
 * has an 8-byte header (4-byte big-endian size + 4-byte ASCII type),
 * optionally followed by an 8-byte extended size when `size === 1`.
 * Some boxes are containers (children of the same shape); some are
 * leaves with a structured payload. Our writer touches the
 * `moov/udta/meta/ilst` subtree to rewrite the tag list, and patches
 * every `stco`/`co64` entry under `moov/trak/.../stbl` so chunk
 * offsets stay valid after `moov` resizes.
 *
 * Boxes we don't understand (codec configs, sample tables, anything
 * we didn't expect) get copied verbatim. The parser's job is to find
 * the byte ranges of the things we care about; everything else is
 * just bytes.
 */

/** Walk the boxes at the top level of `[start, end)` and yield each
 *  one as `{ type, start, end, headerSize }`. The header size is the
 *  payload offset (8 for normal, 16 for extended-size). */
export function listBoxes(buf, start, end) {
  const boxes = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = readUInt32BE(buf, cursor);
    const type = readType(buf, cursor + 4);
    let headerSize = 8;
    if (size === 1) {
      if (cursor + 16 > end) break;
      // 64-bit extended size — read low 32 bits as the integer part.
      // Files ≥ 4 GiB are rare in music; flagged in Risks of the plan.
      const hi = readUInt32BE(buf, cursor + 8);
      const lo = readUInt32BE(buf, cursor + 12);
      size = hi * 0x100000000 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - cursor;
    }
    if (size < headerSize || cursor + size > end) break;
    boxes.push({
      type,
      start: cursor,
      end: cursor + size,
      headerSize,
    });
    cursor += size;
  }
  return boxes;
}

/** Find the first child box of `type` within `[start, end)`. Returns
 *  `{ type, start, end, headerSize }` or `null`. Same shape as
 *  `listBoxes` entries. */
export function findChild(buf, start, end, type) {
  const boxes = listBoxes(buf, start, end);
  return boxes.find((b) => b.type === type) ?? null;
}

/** Read 4 ASCII bytes as the box type string. */
function readType(buf, offset) {
  return String.fromCharCode(
    buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]
  );
}

/** Read a 32-bit big-endian unsigned int from `buf` at `offset`. */
function readUInt32BE(buf, offset) {
  return (
    (buf[offset] << 24 >>> 0) +
    (buf[offset + 1] << 16) +
    (buf[offset + 2] << 8) +
    buf[offset + 3]
  );
}

/** Write a 32-bit big-endian unsigned int to `buf` at `offset`. */
function writeUInt32BE(buf, offset, value) {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/** Map the renderer's user-facing keys to MP4 iTunes-style atom
 *  types. Custom keys go through the `----` long-form atom instead. */
const MP4_ATOM_FOR_KEY = {
  title: '©nam',
  artist: '©ART',
  album: '©alb',
  year: '©day',
  genre: '©gen',
  // track and cover have their own dedicated builders.
};

/** Build a box header — 4-byte size (including this header) + 4-byte
 *  ASCII type. The size is the total size of the box. */
function buildBoxHeader(type, totalSize) {
  const head = Buffer.alloc(8);
  writeUInt32BE(head, 0, totalSize);
  // Type code is 4 chars; the ©-prefixed ones use byte 0xA9.
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i) & 0xff;
  return head;
}

/** Wrap `body` inside a box of `type`: header + body. */
function buildBox(type, body) {
  const totalSize = 8 + body.length;
  return Buffer.concat([buildBoxHeader(type, totalSize), body]);
}

/** Build a `data` atom: type-indicator(4) + locale(4) + payload. */
function buildDataAtom(typeIndicator, payload) {
  const body = Buffer.concat([
    Buffer.alloc(8),
    payload,
  ]);
  writeUInt32BE(body, 0, typeIndicator);
  // locale stays 0.
  return buildBox('data', body);
}

/** Build a string-valued ilst child: ©nam, ©ART, etc. Type indicator
 *  1 = UTF-8 text. */
function buildStringTag(atomType, value) {
  const payload = Buffer.from(String(value), 'utf8');
  return buildBox(atomType, buildDataAtom(1, payload));
}

/** Build a `trkn` ilst child. Payload: 2 reserved + 2 track + 2 total
 *  + 2 reserved (the iTunes-default 8 bytes). Total is 0 when only
 *  the track number is known. */
function buildTracknumberTag(track, total = 0) {
  const trackNumber = Number(track) | 0;
  const trackTotal = Number(total) | 0;
  const payload = Buffer.alloc(8);
  payload.writeUInt16BE(0, 0);
  payload.writeUInt16BE(Math.max(0, trackNumber), 2);
  payload.writeUInt16BE(Math.max(0, trackTotal), 4);
  payload.writeUInt16BE(0, 6);
  return buildBox('trkn', buildDataAtom(0, payload));
}

/** Build a `covr` ilst child. Type indicator: 13 = JPEG, 14 = PNG.
 *  Unknown MIME falls back to 0 (binary) — readers usually sniff. */
function buildCoverTag(mime, data) {
  let typeIndicator = 0;
  if (mime === 'image/jpeg' || mime === 'image/jpg') typeIndicator = 13;
  else if (mime === 'image/png') typeIndicator = 14;
  return buildBox('covr', buildDataAtom(typeIndicator, Buffer.from(data)));
}

/** Build a `----` (custom user metadata) ilst child. Spec:
 *
 *    ---- {
 *      mean { flags(4), "com.apple.iTunes" }
 *      name { flags(4), KEY }
 *      data { type=1, locale=0, VALUE-utf8 }
 *    }
 */
function buildCustomTag(key, value) {
  const mean = buildBox('mean', Buffer.concat([
    Buffer.alloc(4), // flags
    Buffer.from('com.apple.iTunes', 'utf8'),
  ]));
  const name = buildBox('name', Buffer.concat([
    Buffer.alloc(4), // flags
    Buffer.from(String(key).toUpperCase(), 'utf8'),
  ]));
  const data = buildDataAtom(1, Buffer.from(String(value), 'utf8'));
  return buildBox('----', Buffer.concat([mean, name, data]));
}

/** Build a complete `ilst` atom from `fields`. Standard keys take
 *  their iTunes atom types; extras become `----` custom atoms. The
 *  cover entry (if present) is always last. */
export function buildIlstAtom(fields) {
  const children = [];
  const consumed = new Set(['duration', 'file', 'format', 'path', 'cover', 'track']);

  for (const [key, atomType] of Object.entries(MP4_ATOM_FOR_KEY)) {
    consumed.add(key);
    const value = fields[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === '') continue;
    children.push(buildStringTag(atomType, text));
  }

  if (fields.track !== null && fields.track !== undefined && fields.track !== '') {
    children.push(buildTracknumberTag(fields.track));
  }

  const extras = Object.keys(fields)
    .filter((key) => !consumed.has(key))
    .sort();
  for (const key of extras) {
    const value = fields[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === '') continue;
    children.push(buildCustomTag(key, text));
  }

  if (
    fields.cover &&
    typeof fields.cover === 'object' &&
    fields.cover.data &&
    fields.cover.mime
  ) {
    children.push(buildCoverTag(fields.cover.mime, fields.cover.data));
  }

  return buildBox('ilst', children.length > 0 ? Buffer.concat(children) : Buffer.alloc(0));
}

/** Find `moov/udta/meta/ilst` in `buf`, returning the chain of
 *  parents and the ilst byte range. The `meta` box has a 4-byte
 *  version+flags prefix before its children — accounted for in
 *  the `childrenStart` of the meta entry. */
export function findIlstChain(buf) {
  const top = listBoxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return null;
  const udta = findChild(buf, moov.start + moov.headerSize, moov.end, 'udta');
  if (!udta) return null;
  const meta = findChild(buf, udta.start + udta.headerSize, udta.end, 'meta');
  if (!meta) return null;
  // Skip meta's 4-byte version+flags.
  const metaChildrenStart = meta.start + meta.headerSize + 4;
  if (metaChildrenStart >= meta.end) return null;
  const ilst = findChild(buf, metaChildrenStart, meta.end, 'ilst');
  if (!ilst) return null;
  return { moov, udta, meta, ilst };
}

/** Find every `stco` and `co64` atom inside `moov`. Returns
 *  `[{ kind: 'stco' | 'co64', start, end, entriesStart, entryCount, entrySize }]`.
 *  Walks `moov/trak/mdia/minf/stbl/` and collects whichever chunk-offset
 *  table the file uses (only one per stbl, but multiple traks each
 *  carry one). */
export function findChunkOffsetAtoms(buf, moov) {
  const out = [];
  const moovChildren = listBoxes(buf, moov.start + moov.headerSize, moov.end);
  for (const trak of moovChildren) {
    if (trak.type !== 'trak') continue;
    const mdia = findChild(buf, trak.start + trak.headerSize, trak.end, 'mdia');
    if (!mdia) continue;
    const minf = findChild(buf, mdia.start + mdia.headerSize, mdia.end, 'minf');
    if (!minf) continue;
    const stbl = findChild(buf, minf.start + minf.headerSize, minf.end, 'stbl');
    if (!stbl) continue;
    // Within stbl, look for either stco (32-bit) or co64 (64-bit).
    for (const atom of listBoxes(buf, stbl.start + stbl.headerSize, stbl.end)) {
      if (atom.type !== 'stco' && atom.type !== 'co64') continue;
      // Body layout: version+flags(4) + count(4) + entries[count * size].
      const bodyStart = atom.start + atom.headerSize;
      if (atom.end - bodyStart < 8) continue;
      const entryCount = readUInt32BE(buf, bodyStart + 4);
      out.push({
        kind: atom.type,
        start: atom.start,
        end: atom.end,
        entriesStart: bodyStart + 8,
        entryCount,
        entrySize: atom.type === 'co64' ? 8 : 4,
      });
    }
  }
  return out;
}

/** Apply `delta` to every chunk-offset entry across `atoms`. Operates
 *  in place on `buf`. */
function patchChunkOffsets(buf, atoms, delta) {
  if (delta === 0) return;
  for (const atom of atoms) {
    let cursor = atom.entriesStart;
    for (let i = 0; i < atom.entryCount; i++) {
      if (atom.entrySize === 4) {
        const oldValue = readUInt32BE(buf, cursor);
        writeUInt32BE(buf, cursor, oldValue + delta);
      } else {
        // 64-bit: read high+low 32, add delta, write back. JS numbers
        // are accurate up to 2^53, well past anything we'll see.
        const hi = readUInt32BE(buf, cursor);
        const lo = readUInt32BE(buf, cursor + 4);
        const total = hi * 0x100000000 + lo + delta;
        writeUInt32BE(buf, cursor, Math.floor(total / 0x100000000));
        writeUInt32BE(buf, cursor + 4, total & 0xffffffff);
      }
      cursor += atom.entrySize;
    }
  }
}

/** Serialise a complete MP4 file: parse the atom tree, rebuild
 *  `moov` with a fresh `ilst` and patched chunk-offset tables,
 *  emit the result with everything else verbatim.
 *
 *  Throws when the file's structure doesn't match expectations
 *  (no moov, no mdat, missing ilst path, multi-mdat, etc.) — caller
 *  wraps and surfaces as `{ ok: false, error }`.
 */
export function serialiseMP4(buf, fields) {
  const top = listBoxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('moov box not found');
  const mdats = top.filter((b) => b.type === 'mdat');
  if (mdats.length === 0) throw new Error('mdat box not found');
  if (mdats.length > 1) throw new Error('multiple mdat boxes are unsupported');
  const mdat = mdats[0];

  const chain = findIlstChain(buf);
  if (!chain) throw new Error('moov/udta/meta/ilst path is incomplete');

  // Build the new ilst atom. If the caller hasn't supplied a cover
  // explicitly, preserve the existing one by re-reading it from buf.
  let mergedFields = fields;
  if (!('cover' in fields) || fields.cover === undefined) {
    const existing = extractMP4Covr(buf);
    if (existing) mergedFields = { ...fields, cover: existing };
  }
  const newIlst = buildIlstAtom(mergedFields);
  const oldIlstSize = chain.ilst.end - chain.ilst.start;
  const delta = newIlst.length - oldIlstSize;

  // Copy moov into a working buffer so we can apply patches in place.
  const newMoov = Buffer.from(buf.subarray(moov.start, moov.end));

  // Patch the container-size fields on the moov→udta→meta chain. The
  // size field is the first 4 bytes of each box's header.
  for (const parent of [chain.moov, chain.udta, chain.meta]) {
    const offsetInMoov = parent.start - moov.start;
    const oldSize = readUInt32BE(newMoov, offsetInMoov);
    writeUInt32BE(newMoov, offsetInMoov, oldSize + delta);
  }

  // Patch every stco/co64 entry by the chunk-offset delta. Only
  // entries pointing into mdat shift — but in practice all chunks
  // do point into mdat. If moov sits after mdat in the file,
  // growing moov doesn't move mdat at all, so chunkDelta is 0.
  const chunkDelta = moov.start < mdat.start ? delta : 0;
  const stcos = findChunkOffsetAtoms(buf, moov);
  // Translate the absolute file offsets into moov-relative ones for
  // the in-place patch on `newMoov`.
  const relativeStcos = stcos.map((atom) => ({
    ...atom,
    entriesStart: atom.entriesStart - moov.start,
  }));
  patchChunkOffsets(newMoov, relativeStcos, chunkDelta);

  // Splice the new ilst into the moov buffer.
  const ilstStartInMoov = chain.ilst.start - moov.start;
  const ilstEndInMoov = chain.ilst.end - moov.start;
  const newMoovSpliced = Buffer.concat([
    newMoov.subarray(0, ilstStartInMoov),
    newIlst,
    newMoov.subarray(ilstEndInMoov),
  ]);

  // Emit: file bytes before moov + new moov + file bytes after moov.
  return Buffer.concat([
    buf.subarray(0, moov.start),
    newMoovSpliced,
    buf.subarray(moov.end),
  ]);
}

/** Read the file at `path`, rewrite it with the new metadata, and
 *  atomically rename the temp file into place. Embedded cover art
 *  is preserved by `serialiseMP4`.
 *
 *  @param {string} path - Absolute path to the .m4a / .mp4 file.
 *  @param {object} fields - The new metadata.
 *  @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeMP4Sync(path, fields) {
  try {
    const buf = readFileSync(path);
    const newBuf = serialiseMP4(buf, fields);
    writeAtomic(path, newBuf);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Ogg Vorbis
// ---------------------------------------------------------------------------

/**
 * Ogg Vorbis structure: a stream of pages, each carrying segments,
 * each segment between 0 and 255 bytes. A logical packet is the
 * concatenation of segments terminated by a segment < 255 (or one of
 * exactly 0 bytes when a packet ends on a 255-byte boundary). Vorbis
 * uses three header packets: identification, comment, setup. The
 * audio packets follow.
 *
 * Our writer rebuilds the comment packet from the new metadata and
 * re-emits the header pages. Audio pages are copied verbatim from
 * the original — same sequence numbers, same CRCs — as long as the
 * new header layout uses the same page count as the original. When
 * it doesn't (rare: comment packet grew or shrank into a different
 * number of pages), the audio pages get their sequence numbers
 * patched and CRCs recomputed.
 *
 * Cover art preservation: Vorbis encodes cover art inside the
 * comment block as a base64-encoded METADATA_BLOCK_PICTURE field.
 * It survives a write naturally — the writer treats it as just
 * another comment field.
 */

/** Pre-computed Ogg CRC32 table. Polynomial 0x04C11DB7, unreflected,
 *  no init/final XOR. */
const OGG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) !== 0
        ? ((crc << 1) ^ 0x04c11db7) >>> 0
        : (crc << 1) >>> 0;
    }
    t[i] = crc;
  }
  return t;
})();

/** Compute the Ogg CRC32 over `buf`. The page's CRC field at bytes
 *  22–25 must be zeroed before calling, then the result written
 *  back as a little-endian uint32. */
export function oggCrc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (((crc << 8) >>> 0) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc;
}

/** Walk the Ogg pages in `buf` and return one descriptor per page:
 *  `{ start, end, headerType, granule, serial, sequence, segments }`.
 *  `segments` is the per-segment byte-length array. */
export function listOggPages(buf) {
  const pages = [];
  let cursor = 0;
  while (cursor + 27 <= buf.length) {
    if (
      buf[cursor] !== 0x4f || buf[cursor + 1] !== 0x67 ||
      buf[cursor + 2] !== 0x67 || buf[cursor + 3] !== 0x53
    ) {
      break;
    }
    const headerType = buf[cursor + 5];
    // Granule: 8-byte little-endian signed; we only need the bytes,
    // not the value, so just keep them.
    const granule = buf.subarray(cursor + 6, cursor + 14);
    const serial = buf.readUInt32LE(cursor + 14);
    const sequence = buf.readUInt32LE(cursor + 18);
    const segCount = buf[cursor + 26];
    const segTableStart = cursor + 27;
    const dataStart = segTableStart + segCount;
    if (dataStart > buf.length) break;
    const segments = new Array(segCount);
    let payloadLen = 0;
    for (let i = 0; i < segCount; i++) {
      segments[i] = buf[segTableStart + i];
      payloadLen += segments[i];
    }
    const end = dataStart + payloadLen;
    if (end > buf.length) break;
    pages.push({
      start: cursor,
      end,
      headerType,
      granule,
      serial,
      sequence,
      segments,
      dataStart,
    });
    cursor = end;
  }
  return pages;
}

/** Read packets from the Ogg page list until `count` packets have
 *  been assembled (or the stream ends). Returns an array of
 *  `{ bytes, endPageIndex }`. A packet ends on the first segment of
 *  length < 255 (including a 0-length terminator). */
export function readOggPackets(buf, pages, count) {
  const packets = [];
  let current = [];
  for (let p = 0; p < pages.length && packets.length < count; p++) {
    const page = pages[p];
    let dataCursor = page.dataStart;
    for (let s = 0; s < page.segments.length; s++) {
      const segLen = page.segments[s];
      current.push(buf.subarray(dataCursor, dataCursor + segLen));
      dataCursor += segLen;
      if (segLen < 255) {
        const total = current.reduce((sum, seg) => sum + seg.length, 0);
        const bytes = Buffer.alloc(total);
        let off = 0;
        for (const seg of current) {
          seg.copy(bytes, off);
          off += seg.length;
        }
        packets.push({ bytes, endPageIndex: p });
        current = [];
        if (packets.length >= count) break;
      }
    }
  }
  return packets;
}

/** Build a Vorbis comment packet from `fields`. Structure:
 *
 *    0x03 + "vorbis" + vendor-length-LE + vendor + comment-count-LE +
 *      [ length-LE + "KEY=VALUE" ]* + 0x01 (framing bit)
 *
 *  Renderer-side keys map to the Vorbis-comment names in capitals.
 *  Cover passes through as METADATA_BLOCK_PICTURE (base64-encoded
 *  FLAC picture block) — out of scope for our writer; we preserve
 *  it via the vendor string + comments roundtrip only.
 */
export function buildVorbisCommentPacket(fields, { vendor = 'jmacs' } = {}) {
  const vendorBuf = Buffer.from(String(vendor), 'utf8');
  const entries = [];
  const map = {
    title: 'TITLE',
    artist: 'ARTIST',
    album: 'ALBUM',
    year: 'DATE',
    genre: 'GENRE',
  };
  const consumed = new Set(['duration', 'file', 'format', 'path', 'cover', 'track']);
  for (const [key, name] of Object.entries(map)) {
    consumed.add(key);
    const value = fields[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === '') continue;
    entries.push(`${name}=${text}`);
  }
  if (fields.track !== null && fields.track !== undefined && fields.track !== '') {
    entries.push(`TRACKNUMBER=${String(fields.track).trim()}`);
  }
  const extras = Object.keys(fields)
    .filter((key) => !consumed.has(key))
    .sort();
  for (const key of extras) {
    const value = fields[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === '') continue;
    entries.push(`${key.toUpperCase()}=${text}`);
  }

  const entryBufs = entries.map((entry) => {
    const data = Buffer.from(entry, 'utf8');
    const out = Buffer.alloc(4 + data.length);
    out.writeUInt32LE(data.length, 0);
    data.copy(out, 4);
    return out;
  });
  const totalEntries = entryBufs.reduce((sum, b) => sum + b.length, 0);
  const packet = Buffer.alloc(
    1 + 6 + 4 + vendorBuf.length + 4 + totalEntries + 1
  );
  let cursor = 0;
  packet[cursor++] = 0x03;
  packet.write('vorbis', cursor, 'ascii');
  cursor += 6;
  packet.writeUInt32LE(vendorBuf.length, cursor);
  cursor += 4;
  vendorBuf.copy(packet, cursor);
  cursor += vendorBuf.length;
  packet.writeUInt32LE(entryBufs.length, cursor);
  cursor += 4;
  for (const entry of entryBufs) {
    entry.copy(packet, cursor);
    cursor += entry.length;
  }
  packet[cursor++] = 0x01; // framing bit
  return packet;
}

/** Build one Ogg page carrying `packets`. The segment table records
 *  packet boundaries. `headerType` bits: 0x02 for BOS, 0x04 for EOS.
 *  Throws when the packets together require more than 255 segments
 *  (the per-page limit). */
export function buildOggPage(packets, { headerType, granule, serial, sequence }) {
  const segments = [];
  const payloadChunks = [];
  for (const packet of packets) {
    let remaining = packet.length;
    let offset = 0;
    while (remaining >= 255) {
      segments.push(255);
      payloadChunks.push(packet.subarray(offset, offset + 255));
      remaining -= 255;
      offset += 255;
    }
    segments.push(remaining);
    payloadChunks.push(packet.subarray(offset, offset + remaining));
  }
  if (segments.length > 255) {
    throw new Error(
      `ogg: ${segments.length} segments would exceed the 255-segment ` +
      'per-page limit'
    );
  }
  const payload = Buffer.concat(payloadChunks);
  const page = Buffer.alloc(27 + segments.length + payload.length);
  page.write('OggS', 0, 'ascii');
  page[4] = 0; // version
  page[5] = headerType & 0xff;
  // 8-byte granule. Header pages use 0; we accept either a Buffer
  // (copy verbatim) or a number/bigint (write as LE 64-bit).
  if (Buffer.isBuffer(granule)) {
    granule.copy(page, 6, 0, Math.min(8, granule.length));
  }
  // else stays zero.
  page.writeUInt32LE(serial >>> 0, 14);
  page.writeUInt32LE(sequence >>> 0, 18);
  // CRC stays zero in the buffer; we compute and overwrite next.
  page[26] = segments.length;
  for (let i = 0; i < segments.length; i++) page[27 + i] = segments[i];
  payload.copy(page, 27 + segments.length);
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

/** Patch the sequence number of an Ogg page in place and recompute
 *  its CRC. Used when our re-emitted header pages don't match the
 *  original header page count and the audio pages need to be
 *  renumbered. */
function patchOggPageSequence(buf, pageStart, pageEnd, newSequence) {
  // The page header is 27 bytes + segment table. Sequence at +18,
  // CRC at +22. The whole page (with CRC zeroed) is the CRC input.
  buf.writeUInt32LE(newSequence >>> 0, pageStart + 18);
  // Zero CRC for re-computation.
  buf.writeUInt32LE(0, pageStart + 22);
  const crc = oggCrc32(buf.subarray(pageStart, pageEnd));
  buf.writeUInt32LE(crc, pageStart + 22);
}

/** Serialise a complete Ogg Vorbis file with new metadata. Throws
 *  when the file isn't a valid Vorbis stream (missing pages, missing
 *  identification/comment/setup packets, multi-stream Ogg, …). */
export function serialiseOGG(buf, fields) {
  const pages = listOggPages(buf);
  if (pages.length === 0) throw new Error('ogg: no pages found');
  if ((pages[0].headerType & 0x02) === 0) {
    throw new Error('ogg: first page is not BOS');
  }
  // Multi-stream Ogg (chained or grouped streams) — we only handle
  // single-bitstream Vorbis files. Detect by serial number changes.
  const serial = pages[0].serial;
  for (const page of pages) {
    if (page.serial !== serial) {
      throw new Error('ogg: multi-bitstream files are unsupported');
    }
  }

  const headerPackets = readOggPackets(buf, pages, 3);
  if (headerPackets.length < 3) {
    throw new Error('ogg: stream has fewer than 3 logical packets');
  }
  const [idPacket, , setupPacket] = headerPackets;
  if (idPacket.bytes.length < 7 || idPacket.bytes[0] !== 0x01) {
    throw new Error('ogg: first packet is not a Vorbis identification packet');
  }

  // Preserve the original vendor string when present so round-trips
  // through a third-party tool don't churn the bytes unnecessarily.
  const originalComment = headerPackets[1].bytes;
  let vendor = 'jmacs';
  if (originalComment.length > 11 && originalComment[0] === 0x03) {
    const vendorLen = originalComment.readUInt32LE(7);
    if (7 + 4 + vendorLen <= originalComment.length) {
      vendor = originalComment.subarray(11, 11 + vendorLen).toString('utf8');
    }
  }
  const newComment = buildVorbisCommentPacket(fields, { vendor });

  // Page 0: identification packet (BOS). Re-emit so its sequence
  // (always 0) is canonical. The identification packet's bytes are
  // copied verbatim from the original.
  const newPage0 = buildOggPage([idPacket.bytes], {
    headerType: 0x02,
    granule: Buffer.alloc(8),
    serial,
    sequence: 0,
  });

  // Pages 1..: new comment + setup packet. Try to fit in one page;
  // expand to multiple if necessary.
  const newHeaderPages = [];
  newHeaderPages.push(newPage0);
  // Compute segment count for both packets combined.
  const combinedSegmentCount =
    Math.floor(newComment.length / 255) + 1 +
    Math.floor(setupPacket.bytes.length / 255) + 1;
  if (combinedSegmentCount <= 255) {
    newHeaderPages.push(buildOggPage([newComment, setupPacket.bytes], {
      headerType: 0x00,
      granule: Buffer.alloc(8),
      serial,
      sequence: 1,
    }));
  } else {
    newHeaderPages.push(buildOggPage([newComment], {
      headerType: 0x00,
      granule: Buffer.alloc(8),
      serial,
      sequence: 1,
    }));
    newHeaderPages.push(buildOggPage([setupPacket.bytes], {
      headerType: 0x00,
      granule: Buffer.alloc(8),
      serial,
      sequence: 2,
    }));
  }

  const audioFirstPageIndex = headerPackets[2].endPageIndex + 1;
  const audioStartByte =
    audioFirstPageIndex < pages.length
      ? pages[audioFirstPageIndex].start
      : buf.length;
  const audioBytes = Buffer.from(buf.subarray(audioStartByte));
  // Patch audio page sequence numbers when our new header count
  // doesn't match the original. The first audio page sequence
  // we want is `newHeaderPages.length`; the original was
  // `audioFirstPageIndex` (which is also the count of original
  // header pages).
  const desiredFirstAudioSeq = newHeaderPages.length;
  const originalFirstAudioSeq = audioFirstPageIndex;
  if (desiredFirstAudioSeq !== originalFirstAudioSeq) {
    // Walk audio pages in `audioBytes` and re-sequence + re-CRC each.
    const audioPages = listOggPages(audioBytes);
    let seq = desiredFirstAudioSeq;
    for (const page of audioPages) {
      patchOggPageSequence(audioBytes, page.start, page.end, seq);
      seq += 1;
    }
  }

  return Buffer.concat([...newHeaderPages, audioBytes]);
}

/** Read the file at `path`, rewrite it with new metadata, atomically
 *  rename into place. */
export function writeOGGSync(path, fields) {
  try {
    const buf = readFileSync(path);
    const newBuf = serialiseOGG(buf, fields);
    writeAtomic(path, newBuf);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Write `data` to `path` via a temp file + rename, so a crash mid-
 *  write doesn't leave the original truncated. The temp file is in
 *  the same directory as the target so the rename stays on one
 *  filesystem (cross-fs rename copies + deletes — not atomic). */
function writeAtomic(path, data) {
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, data);
  try {
    renameSync(tmpPath, path);
  } catch (error) {
    // Clean up the temp file if the rename failed.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

/** Turn an error into a single-line message suitable for the
 *  minibuffer. Falls back to the error's code (ENOENT, EACCES, …)
 *  when it has no message of its own. */
function errorMessage(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  if (typeof error.code === 'string') return error.code;
  return String(error);
}
