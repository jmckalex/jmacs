/**
 * @file Embedded audio-metadata extraction. Reads the title, artist,
 * album, track number, year and genre from common audio container
 * formats and returns them as a plain JS object. Companion to
 * `audio-art.js`: same byte-level approach, same "any unsupported
 * quirk degrades to null" failure mode.
 *
 * No third-party libraries — every byte-level helper uses `DataView`
 * or direct buffer indexing. The container formats here have just
 * enough quirks that a "general" tag library would be overkill;
 * the inline parsers stay auditable in a screenful each.
 *
 * Failure mode is uniform: malformed input or no usable tags returns
 * `null` (or an object whose fields are mostly null). The jukebox
 * caller then falls back to the bare filename.
 */

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

/** Recognised audio suffixes → which parser handles them. */
const FORMAT_BY_SUFFIX = {
  '.mp3': 'id3',
  '.m4a': 'mp4',
  '.mp4': 'mp4',
  '.aac': 'mp4',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'ogg',
};

/**
 * @typedef {{
 *   title:    string | null,
 *   artist:   string | null,
 *   album:    string | null,
 *   track:    number | null,
 *   year:     number | null,
 *   genre:    string | null,
 *   duration: number | null,
 * }} AudioMetadata
 */

/** A fresh, all-null metadata object. */
function emptyMetadata() {
  return {
    title: null,
    artist: null,
    album: null,
    track: null,
    year: null,
    genre: null,
    duration: null,
  };
}

/**
 * Read PATH from disk and return its embedded metadata, or `null`
 * if the format is unsupported or the file cannot be read.
 *
 * Missing individual fields come back as `null` on the returned
 * object — the dispatcher always returns a fully-shaped object
 * once a known format is recognised.
 *
 * @param {string} path
 * @returns {Promise<AudioMetadata | null>}
 */
export async function extractMetadata(path) {
  if (typeof path !== 'string' || path === '') return null;
  const suffix = path.slice(path.lastIndexOf('.')).toLowerCase();
  const format = FORMAT_BY_SUFFIX[suffix];
  if (!format) return null;
  let buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return null;
  }
  return extractFromBytes(buffer, format);
}

/**
 * The synchronous twin of `extractMetadata` — same dispatch, same
 * failure-to-null contract, with `readFileSync` instead of the async
 * `readFile`. Used by the IPC `audio:metadata-sync` handler the Lisp
 * primitive reaches: the interpreter is synchronous, so the host has
 * to read the bytes before yielding back to JS.
 *
 * @param {string} path
 * @returns {AudioMetadata | null}
 */
export function extractMetadataSync(path) {
  if (typeof path !== 'string' || path === '') return null;
  const suffix = path.slice(path.lastIndexOf('.')).toLowerCase();
  const format = FORMAT_BY_SUFFIX[suffix];
  if (!format) return null;
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return null;
  }
  return extractFromBytes(buffer, format);
}

/**
 * Dispatch parsing to the right per-format reader. Any parser
 * blow-up degrades to `null`.
 *
 * @param {Buffer} buffer
 * @param {'id3' | 'mp4' | 'ogg'} format
 * @returns {AudioMetadata | null}
 */
function extractFromBytes(buffer, format) {
  try {
    if (format === 'id3') return extractMP3Metadata(buffer);
    if (format === 'mp4') return extractMP4Metadata(buffer);
    if (format === 'ogg') return extractOGGMetadata(buffer);
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared byte-level helpers
// ---------------------------------------------------------------------------

/** Decode a 4-byte syncsafe integer (7 bits per byte). */
function readSyncsafeInt32(buf, offset) {
  return (
    (buf[offset] & 0x7f) << 21 |
    (buf[offset + 1] & 0x7f) << 14 |
    (buf[offset + 2] & 0x7f) << 7 |
    (buf[offset + 3] & 0x7f)
  );
}

/** Plain big-endian 32-bit unsigned int. */
function readUInt32BE(buf, offset) {
  return (
    (buf[offset] << 24 >>> 0) +
    (buf[offset + 1] << 16) +
    (buf[offset + 2] << 8) +
    buf[offset + 3]
  );
}

/** Plain little-endian 32-bit unsigned int (used by Vorbis comments). */
function readUInt32LE(buf, offset) {
  return (
    (buf[offset]) +
    (buf[offset + 1] << 8) +
    (buf[offset + 2] << 16) +
    (buf[offset + 3] * 0x1000000)
  );
}

/** Big-endian 16-bit unsigned int (used by MP4 `trkn`). */
function readUInt16BE(buf, offset) {
  return (buf[offset] << 8) | buf[offset + 1];
}

/** Decode ISO-8859-1. */
function decodeLatin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Decode UTF-8. */
function decodeUTF8(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Decode UTF-16 with a BOM (LE or BE); without a BOM, default to LE. */
function decodeUTF16(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-16le').decode(bytes);
}

/** Decode UTF-16BE (no BOM expected — that's encoding type 2). */
function decodeUTF16BE(bytes) {
  return new TextDecoder('utf-16be').decode(bytes);
}

/** Strip trailing NULs that some taggers leave on text frame payloads. */
function stripNulls(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0) end -= 1;
  return s.slice(0, end);
}

// ---------------------------------------------------------------------------
// MP3 / ID3v2 + ID3v1
// ---------------------------------------------------------------------------

/**
 * Parse ID3 metadata from an MP3 file's bytes. ID3v2 wins if present
 * at the start; otherwise, ID3v1 from the last 128 bytes is the
 * fallback. Returns a shaped metadata object even when most fields
 * are missing.
 *
 * @param {Buffer | Uint8Array} buf
 * @returns {AudioMetadata}
 */
export function extractMP3Metadata(buf) {
  const v2 = extractID3v2(buf);
  if (v2 !== null) {
    // Fill any v2-missing field from v1, when v1 is present and the
    // field is there. (Common with files dual-tagged for compat.)
    const v1 = extractID3v1(buf);
    if (v1) {
      for (const key of Object.keys(v2)) {
        if (v2[key] === null && v1[key] !== null) v2[key] = v1[key];
      }
    }
    return v2;
  }
  return extractID3v1(buf) ?? emptyMetadata();
}

/**
 * The standard ID3v1 genre table. Index `(N)` references inside a
 * v2 `TCON` payload resolve through here. The list is the classic
 * 79-entry original plus Winamp's extensions up to 191; we ship
 * the first chunk that covers ~all real-world cases and leaves
 * unknown numbers as the literal `(N)` string.
 */
const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge',
  'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B',
  'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
  'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient',
  'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical',
  'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel',
  'Noise', 'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative',
  'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave',
  'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream',
  'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap',
  'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave',
  'Psychadelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal',
  'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll',
  'Hard Rock',
];

/**
 * Look up an ID3v1 numeric genre code. Returns the literal `(N)`
 * fallback when the index is out of range so the caller can still
 * present the raw value.
 *
 * @param {number} index
 * @returns {string}
 */
function id3v1Genre(index) {
  if (index >= 0 && index < ID3V1_GENRES.length) return ID3V1_GENRES[index];
  return `(${index})`;
}

/**
 * Resolve a `TCON` payload's `(N)` prefix references to genre names.
 * Modern files often store the plain string; legacy ones still use
 * `(17)` or `(17)Rock` — both come out as a clean name here.
 *
 * @param {string} raw
 * @returns {string}
 */
function resolveTCON(raw) {
  if (raw === '' || raw === null) return raw;
  // A pure `(N)` (or several) gets translated; if there's trailing
  // free text after the parens, prefer it (it's the encoder's own
  // genre name, more informative than the lookup).
  const trailing = raw.replace(/^(?:\((\d+|RX|CR)\))+/, '').trim();
  if (trailing) return trailing;
  const match = raw.match(/^\((\d+)\)/);
  if (match) return id3v1Genre(Number(match[1]));
  return raw;
}

/**
 * Extract ID3v2 metadata from BUF. Returns `null` when no v2 tag is
 * present at the start (v2.2 — 3-char IDs — also returns null; rare
 * enough not to be worth the divergent code path).
 *
 * @param {Buffer | Uint8Array} buf
 * @returns {AudioMetadata | null}
 */
export function extractID3v2(buf) {
  if (!buf || buf.length < 10) return null;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null; // "ID3"
  const majorVersion = buf[3];
  const flags = buf[5];
  const tagSize = readSyncsafeInt32(buf, 6);
  if (majorVersion < 3) return null;
  // Unsynchronisation: skip rather than implement the inverse
  // transform. Most modern v2.3/v2.4 files don't use it.
  if ((flags & 0x80) !== 0) return null;

  let cursor = 10;
  const tagEnd = Math.min(buf.length, 10 + tagSize);
  if ((flags & 0x40) !== 0) {
    if (cursor + 4 > tagEnd) return null;
    const extSize = majorVersion >= 4
      ? readSyncsafeInt32(buf, cursor)
      : readUInt32BE(buf, cursor);
    cursor += majorVersion >= 4 ? extSize : 4 + extSize;
  }

  const meta = emptyMetadata();

  while (cursor + 10 <= tagEnd) {
    if (
      buf[cursor] === 0 && buf[cursor + 1] === 0 &&
      buf[cursor + 2] === 0 && buf[cursor + 3] === 0
    ) break;
    const id = String.fromCharCode(
      buf[cursor], buf[cursor + 1], buf[cursor + 2], buf[cursor + 3]
    );
    const size = majorVersion >= 4
      ? readSyncsafeInt32(buf, cursor + 4)
      : readUInt32BE(buf, cursor + 4);
    const frameStart = cursor + 10;
    const frameEnd = frameStart + size;
    if (frameEnd > tagEnd) break;
    const payload = buf.subarray(frameStart, frameEnd);
    // Only text-information frames here; the leading byte is an
    // encoding sentinel, the rest is the value.
    if (id[0] === 'T' && id !== 'TXXX') {
      const text = decodeTextFrame(payload);
      if (text !== null) {
        switch (id) {
          case 'TIT2':
            if (meta.title === null) meta.title = text;
            break;
          case 'TPE1':
            if (meta.artist === null) meta.artist = text;
            break;
          case 'TALB':
            if (meta.album === null) meta.album = text;
            break;
          case 'TRCK': {
            if (meta.track === null) {
              // Form is either "N" or "N/M". Take the leading number.
              const num = parseInt(text.split('/')[0], 10);
              if (Number.isFinite(num)) meta.track = num;
            }
            break;
          }
          case 'TYER':
          case 'TDRC': {
            // v2.3 uses TYER (just a 4-digit year); v2.4 prefers
            // TDRC which is an ISO timestamp — first 4 chars are
            // the year either way.
            if (meta.year === null) {
              const num = parseInt(text.slice(0, 4), 10);
              if (Number.isFinite(num)) meta.year = num;
            }
            break;
          }
          case 'TCON':
            if (meta.genre === null) meta.genre = resolveTCON(text);
            break;
          case 'TLEN': {
            // Length in milliseconds. Optional, often missing.
            if (meta.duration === null) {
              const ms = parseInt(text, 10);
              if (Number.isFinite(ms) && ms > 0) {
                meta.duration = ms / 1000;
              }
            }
            break;
          }
          default:
            break;
        }
      }
    }
    cursor = frameEnd;
  }

  return meta;
}

/**
 * Decode the body of an ID3v2 text-information frame. The first byte
 * is an encoding sentinel; the rest is the (often NUL-terminated)
 * text.
 *
 * @param {Buffer | Uint8Array} payload
 * @returns {string | null}
 */
function decodeTextFrame(payload) {
  if (!payload || payload.length < 1) return null;
  const encoding = payload[0];
  const body = payload.subarray(1);
  let text;
  switch (encoding) {
    case 0: text = decodeLatin1(body); break;
    case 1: text = decodeUTF16(body); break;
    case 2: text = decodeUTF16BE(body); break;
    case 3: text = decodeUTF8(body); break;
    default: return null;
  }
  return stripNulls(text);
}

/**
 * Extract ID3v1 metadata from the last 128 bytes of BUF. Returns
 * `null` when no `TAG` sentinel is present at that offset.
 *
 * Layout (128 bytes total):
 *   3 bytes  "TAG"
 *   30 bytes title    (NUL- or space-padded)
 *   30 bytes artist
 *   30 bytes album
 *   4 bytes  year     (4-digit ASCII)
 *   30 bytes comment  (in v1.1, last two bytes are 0x00 + track num)
 *   1 byte   genre    (index into ID3V1_GENRES)
 *
 * @param {Buffer | Uint8Array} buf
 * @returns {AudioMetadata | null}
 */
export function extractID3v1(buf) {
  if (!buf || buf.length < 128) return null;
  const start = buf.length - 128;
  if (buf[start] !== 0x54 || buf[start + 1] !== 0x41 || buf[start + 2] !== 0x47) {
    return null; // not "TAG"
  }
  const field = (offset, length) => {
    const slice = buf.subarray(start + offset, start + offset + length);
    // Strip both trailing NUL and trailing spaces — both are seen
    // in the wild as padding.
    const s = decodeLatin1(slice);
    let end = s.length;
    while (end > 0) {
      const code = s.charCodeAt(end - 1);
      if (code !== 0 && code !== 0x20) break;
      end -= 1;
    }
    return s.slice(0, end);
  };
  const title = field(3, 30);
  const artist = field(33, 30);
  const album = field(63, 30);
  const year = field(93, 4);
  // v1.1 hack: if the 29th byte of the comment field is NUL, the
  // 30th byte is a track number.
  let track = null;
  if (buf[start + 125] === 0 && buf[start + 126] !== 0) {
    track = buf[start + 126];
  }
  const genreIdx = buf[start + 127];
  const meta = emptyMetadata();
  if (title) meta.title = title;
  if (artist) meta.artist = artist;
  if (album) meta.album = album;
  const yearNum = parseInt(year, 10);
  if (Number.isFinite(yearNum)) meta.year = yearNum;
  if (track !== null) meta.track = track;
  // ID3v1 uses 0xFF (255) as "no genre"; anything in range gets a
  // name lookup.
  if (genreIdx !== 0xff) meta.genre = id3v1Genre(genreIdx);
  return meta;
}

// ---------------------------------------------------------------------------
// MP4 / M4A (moov/udta/meta/ilst)
// ---------------------------------------------------------------------------

/**
 * Locate the first child box of type TYPE within [START, END).
 * Returns `{ start, end }` pointing to the box's payload (excluding
 * the header), or `null` when no such child exists.
 *
 * @param {Buffer | Uint8Array} buf
 * @param {number} start
 * @param {number} end
 * @param {string} type
 * @returns {{ start: number, end: number } | null}
 */
export function findBox(buf, start, end, type) {
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = readUInt32BE(buf, cursor);
    const boxType = String.fromCharCode(
      buf[cursor + 4], buf[cursor + 5],
      buf[cursor + 6], buf[cursor + 7]
    );
    let headerSize = 8;
    if (size === 1) {
      if (cursor + 16 > end) return null;
      size = readUInt32BE(buf, cursor + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - cursor;
    }
    if (size < headerSize || cursor + size > end) return null;
    if (boxType === type) {
      return { start: cursor + headerSize, end: cursor + size };
    }
    cursor += size;
  }
  return null;
}

/**
 * Extract metadata from an MP4 container. Walks the box tree to
 * `moov → udta → meta → ilst` and reads each iTunes-style tag
 * code. The `meta` box has a 4-byte version+flags prefix before
 * its children — same gotcha as the album-art extractor.
 *
 * @param {Buffer | Uint8Array} buf
 * @returns {AudioMetadata}
 */
export function extractMP4Metadata(buf) {
  const meta = emptyMetadata();
  if (!buf || buf.length < 8) return meta;
  const moov = findBox(buf, 0, buf.length, 'moov');
  if (!moov) return meta;
  // Duration comes from the `mvhd` (movie header), if we want it.
  const mvhd = findBox(buf, moov.start, moov.end, 'mvhd');
  if (mvhd && mvhd.end - mvhd.start >= 20) {
    const version = buf[mvhd.start];
    // version 0: 32-bit times; version 1: 64-bit times. We read the
    // low 32 bits of timescale + duration either way.
    if (version === 0 && mvhd.end - mvhd.start >= 20) {
      const timescale = readUInt32BE(buf, mvhd.start + 12);
      const duration = readUInt32BE(buf, mvhd.start + 16);
      if (timescale > 0) meta.duration = duration / timescale;
    } else if (version === 1 && mvhd.end - mvhd.start >= 32) {
      // version+flags(4) + 8 created + 8 modified + 4 timescale + 8 duration
      const timescale = readUInt32BE(buf, mvhd.start + 20);
      const duration = readUInt32BE(buf, mvhd.start + 28); // low 32 bits
      if (timescale > 0) meta.duration = duration / timescale;
    }
  }
  const udta = findBox(buf, moov.start, moov.end, 'udta');
  if (!udta) return meta;
  const metaBox = findBox(buf, udta.start, udta.end, 'meta');
  if (!metaBox) return meta;
  const metaChildrenStart = metaBox.start + 4; // skip version+flags
  if (metaChildrenStart >= metaBox.end) return meta;
  const ilst = findBox(buf, metaChildrenStart, metaBox.end, 'ilst');
  if (!ilst) return meta;

  let cursor = ilst.start;
  while (cursor + 8 <= ilst.end) {
    const size = readUInt32BE(buf, cursor);
    if (size < 8 || cursor + size > ilst.end) break;
    const tagCode = String.fromCharCode(
      buf[cursor + 4], buf[cursor + 5],
      buf[cursor + 6], buf[cursor + 7]
    );
    const itemStart = cursor + 8;
    const itemEnd = cursor + size;
    const dataBox = findBox(buf, itemStart, itemEnd, 'data');
    if (dataBox && dataBox.end - dataBox.start >= 8) {
      const typeIndicator = readUInt32BE(buf, dataBox.start);
      // skip type (4) + locale (4)
      const valStart = dataBox.start + 8;
      const valBytes = buf.subarray(valStart, dataBox.end);
      applyMP4Tag(meta, tagCode, typeIndicator, valBytes);
    }
    cursor += size;
  }
  return meta;
}

/**
 * Apply one ilst item to META. The tag-code → field mapping mirrors
 * iTunes. Unknown codes are ignored.
 *
 * @param {AudioMetadata} meta
 * @param {string} code - 4-char tag code (the `©` ones too).
 * @param {number} typeIndicator - 0 = binary; 1 = UTF-8; 21 = signed BE int.
 * @param {Buffer | Uint8Array} bytes
 */
function applyMP4Tag(meta, code, typeIndicator, bytes) {
  const asText = () => {
    if (typeIndicator === 1) return stripNulls(decodeUTF8(bytes));
    if (typeIndicator === 2) return stripNulls(decodeUTF16(bytes));
    // Type 0 (binary) sometimes still holds UTF-8 text in real files.
    return stripNulls(decodeUTF8(bytes));
  };
  switch (code) {
    case '©nam': // ©nam
      if (meta.title === null) meta.title = asText();
      break;
    case '©ART': // ©ART
      if (meta.artist === null) meta.artist = asText();
      break;
    case '©alb': // ©alb
      if (meta.album === null) meta.album = asText();
      break;
    case '©day': // ©day
      if (meta.year === null) {
        const text = asText();
        const num = parseInt(text.slice(0, 4), 10);
        if (Number.isFinite(num)) meta.year = num;
      }
      break;
    case '©gen': // ©gen — free-form genre string
      if (meta.genre === null) meta.genre = asText();
      break;
    case 'gnre': {
      // Standard genre — a single-byte (or short) ID3v1-style index,
      // offset by 1 (iTunes stores `index+1`).
      if (meta.genre === null && bytes.length >= 1) {
        const idx = bytes[bytes.length - 1] - 1;
        meta.genre = id3v1Genre(idx);
      }
      break;
    }
    case 'trkn': {
      // Track number — 8 bytes: 16-bit zero, 16-bit track, 16-bit total
      // (a 6th 16-bit field is sometimes present; the first three are
      // what we want).
      if (meta.track === null && bytes.length >= 4) {
        const track = readUInt16BE(bytes, 2);
        if (track > 0) meta.track = track;
      }
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// OGG (Vorbis comments inside Vorbis or Opus stream)
// ---------------------------------------------------------------------------

/**
 * Walk the Ogg pages in BUF and reconstruct logical packets by
 * concatenating segments per the segment table — until we have the
 * comment packet, then stop.
 *
 * Ogg's page-then-segment layout means a single logical packet can
 * span multiple pages (a segment of length 255 marks "continued in
 * the next segment"; any segment < 255 ends the packet). For tag
 * extraction we need only the second packet of the first logical
 * stream, which is almost always small enough to fit in one page —
 * but we still walk the segment table properly so larger comment
 * blocks don't get truncated.
 *
 * Returns the bytes of the second logical packet (the one carrying
 * the Vorbis comments / OpusTags block), or `null` when the stream
 * is malformed.
 *
 * @param {Buffer | Uint8Array} buf
 * @returns {Uint8Array | null}
 */
export function extractOGGCommentPacket(buf) {
  if (!buf || buf.length < 27) return null;
  // First page must start with "OggS".
  if (
    buf[0] !== 0x4f || buf[1] !== 0x67 ||
    buf[2] !== 0x67 || buf[3] !== 0x53
  ) {
    return null;
  }
  // Accumulate segment bytes into a flat packet stream, then split
  // by "packet end" boundaries (the markers come from the segment
  // table — any segment of length < 255 ends a packet).
  // We collect at most the first three packets (Vorbis: id, comment,
  // setup; Opus: head, tags) — enough for both formats.
  const packets = [];
  let pending = []; // per-packet running byte arrays
  let current = []; // bytes of the in-progress packet
  let cursor = 0;
  while (cursor + 27 <= buf.length && packets.length < 3) {
    if (
      buf[cursor] !== 0x4f || buf[cursor + 1] !== 0x67 ||
      buf[cursor + 2] !== 0x67 || buf[cursor + 3] !== 0x53
    ) {
      return null;
    }
    const numSegments = buf[cursor + 26];
    const segTableStart = cursor + 27;
    const dataStart = segTableStart + numSegments;
    if (dataStart > buf.length) return null;
    let dataCursor = dataStart;
    for (let i = 0; i < numSegments; i += 1) {
      const segLen = buf[segTableStart + i];
      if (dataCursor + segLen > buf.length) return null;
      current.push(buf.subarray(dataCursor, dataCursor + segLen));
      dataCursor += segLen;
      // A segment of length < 255 ends the current packet.
      if (segLen < 255) {
        const total = current.reduce((sum, seg) => sum + seg.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const seg of current) {
          out.set(seg, o);
          o += seg.length;
        }
        packets.push(out);
        current = [];
        if (packets.length >= 3) break;
      }
    }
    cursor = dataCursor;
    if (packets.length >= 3) break;
  }
  // The comment block is the second logical packet in both Vorbis
  // and Opus.
  return packets[1] ?? null;
}

/**
 * Parse a Vorbis-comments-style block (used by both Vorbis and
 * Opus). Returns the comments as a plain `{ KEY: value }` map with
 * keys uppercased so case-insensitive lookups work.
 *
 * The block layout, after the format-specific magic header:
 *   4 bytes  vendor-length (LE)
 *   N bytes  vendor string
 *   4 bytes  comment-count (LE)
 *   then, for each comment:
 *     4 bytes  comment-length (LE)
 *     N bytes  UTF-8 "KEY=value"
 *
 * @param {Uint8Array} packet
 * @returns {Record<string, string> | null}
 */
function parseVorbisComments(packet) {
  if (!packet || packet.length < 7) return null;
  // Detect the magic. Vorbis: 0x03 + "vorbis". Opus: "OpusTags".
  let cursor = 0;
  if (
    packet[0] === 0x03 &&
    packet[1] === 0x76 && packet[2] === 0x6f && packet[3] === 0x72 &&
    packet[4] === 0x62 && packet[5] === 0x69 && packet[6] === 0x73
  ) {
    cursor = 7;
  } else if (
    packet.length >= 8 &&
    packet[0] === 0x4f && packet[1] === 0x70 && packet[2] === 0x75 &&
    packet[3] === 0x73 && packet[4] === 0x54 && packet[5] === 0x61 &&
    packet[6] === 0x67 && packet[7] === 0x73
  ) {
    cursor = 8;
  } else {
    return null;
  }
  if (cursor + 4 > packet.length) return null;
  const vendorLength = readUInt32LE(packet, cursor);
  cursor += 4;
  if (cursor + vendorLength + 4 > packet.length) return null;
  cursor += vendorLength;
  const commentCount = readUInt32LE(packet, cursor);
  cursor += 4;
  // Vorbis: the header has a trailing "framing bit" of 0x01; Opus
  // does not. We don't check it.
  const out = {};
  for (let i = 0; i < commentCount; i += 1) {
    if (cursor + 4 > packet.length) return null;
    const len = readUInt32LE(packet, cursor);
    cursor += 4;
    if (cursor + len > packet.length) return null;
    const entry = decodeUTF8(packet.subarray(cursor, cursor + len));
    cursor += len;
    const eq = entry.indexOf('=');
    if (eq > 0) {
      const key = entry.slice(0, eq).toUpperCase();
      const value = entry.slice(eq + 1);
      // Multiple comments with the same key keep the first.
      if (!(key in out)) out[key] = value;
    }
  }
  return out;
}

/**
 * Extract metadata from an OGG (Vorbis or Opus) container.
 *
 * @param {Buffer | Uint8Array} buf
 * @returns {AudioMetadata}
 */
export function extractOGGMetadata(buf) {
  const meta = emptyMetadata();
  const packet = extractOGGCommentPacket(buf);
  if (!packet) return meta;
  const comments = parseVorbisComments(packet);
  if (!comments) return meta;
  if (comments.TITLE) meta.title = comments.TITLE;
  if (comments.ARTIST) meta.artist = comments.ARTIST;
  if (comments.ALBUM) meta.album = comments.ALBUM;
  if (comments.TRACKNUMBER) {
    const num = parseInt(comments.TRACKNUMBER.split('/')[0], 10);
    if (Number.isFinite(num)) meta.track = num;
  }
  if (comments.DATE) {
    const num = parseInt(comments.DATE.slice(0, 4), 10);
    if (Number.isFinite(num)) meta.year = num;
  }
  if (comments.GENRE) meta.genre = comments.GENRE;
  return meta;
}
