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

import { extractID3v2APIC } from './audio-art.js';

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
 *  `.mp3`; MP4 and Ogg arrive in their own branches.
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
  return { ok: false, error: `unsupported format: ${ext || '(no extension)'}` };
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
