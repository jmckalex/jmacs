/**
 * @file Embedded album-art extraction. Reads the first picture frame
 * from common audio container formats and returns it as raw bytes plus
 * a MIME type so the renderer can show it as a `data:` URL.
 *
 * No third-party libraries — every byte-level helper here uses
 * `DataView` directly. The container formats we touch (ID3v2 in MP3,
 * MP4 box trees in M4A/MP4/AAC) have just enough quirks that any
 * "general" library would be overkill; the inline parsers stay
 * auditable in a screenful of code each.
 *
 * Failure mode is uniform: malformed input or no embedded art returns
 * `null`. Callers fall back to sidecar art / no art.
 */

import { readFile } from 'node:fs/promises';

/** Recognised audio suffixes → which parser handles them. */
const FORMAT_BY_SUFFIX = {
  '.mp3': 'id3',
  '.m4a': 'mp4',
  '.mp4': 'mp4',
  '.aac': 'mp4',
};

/**
 * Read PATH from disk and return its first embedded picture, or
 * `null` if the format is unsupported or no picture is present.
 *
 * @param {string} path
 * @returns {Promise<{ mime: string, data: Buffer } | null>}
 */
export async function extractAlbumArt(path) {
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
  try {
    if (format === 'id3') return extractID3v2APIC(buffer);
    if (format === 'mp4') return extractMP4Covr(buffer);
  } catch {
    // Any parser blow-up degrades gracefully to "no art" — the jukebox
    // never wants to error out over a malformed tag.
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ID3v2 (MP3)
// ---------------------------------------------------------------------------

/**
 * Decode a 4-byte syncsafe integer at OFFSET. ID3 uses syncsafe ints
 * (7 bits per byte, top bit always zero) for the tag size and, in
 * v2.4, for frame sizes — so the encoded value never collides with the
 * MPEG sync word `0xFFE…` inside the audio payload. v2.3 uses plain
 * big-endian 32-bit ints for frame sizes; only the outer tag size is
 * always syncsafe.
 *
 * @param {Buffer | Uint8Array} buf
 * @param {number} offset
 * @returns {number}
 */
function readSyncsafeInt32(buf, offset) {
  return (
    (buf[offset] & 0x7f) << 21 |
    (buf[offset + 1] & 0x7f) << 14 |
    (buf[offset + 2] & 0x7f) << 7 |
    (buf[offset + 3] & 0x7f)
  );
}

/** Plain big-endian 32-bit unsigned int (used for v2.3 frame sizes). */
function readUInt32BE(buf, offset) {
  return (
    (buf[offset] << 24 >>> 0) +
    (buf[offset + 1] << 16) +
    (buf[offset + 2] << 8) +
    buf[offset + 3]
  );
}

/**
 * Extract the first APIC (Attached PICture) frame from an ID3v2 tag
 * sitting at the start of BUF. Returns `null` if no APIC frame is
 * present, the tag is unsupported (v2.2), or the input is malformed.
 *
 * Tag layout:
 *   3 bytes  "ID3"
 *   1 byte   major version
 *   1 byte   revision
 *   1 byte   flags
 *   4 bytes  size (syncsafe, NOT including the 10-byte header)
 *   <frames>
 *
 * Each v2.3/v2.4 frame:
 *   4 bytes  frame id (ASCII)
 *   4 bytes  size (v2.3: plain big-endian; v2.4: syncsafe)
 *   2 bytes  flags
 *   <payload>
 *
 * APIC payload:
 *   1 byte                 text encoding (0=ISO-8859-1, 1=UTF-16,
 *                                          2=UTF-16BE, 3=UTF-8)
 *   N bytes (NUL-term)     MIME type (ASCII, always 1-byte NUL)
 *   1 byte                 picture type
 *   M bytes (NUL-term)     description (encoded as above; UTF-16's
 *                                       terminator is two NUL bytes)
 *   rest of frame          picture data
 *
 * @param {Buffer | Uint8Array} buf
 * @returns {{ mime: string, data: Buffer } | null}
 */
export function extractID3v2APIC(buf) {
  if (!buf || buf.length < 10) return null;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null; // "ID3"
  const majorVersion = buf[3];
  const flags = buf[5];
  const tagSize = readSyncsafeInt32(buf, 6);

  // v2.2 uses 3-char frame IDs (`PIC`) and 6-byte headers. We don't
  // currently support it — files that old are rare and the format
  // differences are non-trivial. Caller gets `null` and falls back to
  // sidecar art.
  if (majorVersion < 3) return null;

  // The "unsynchronisation" flag (top bit of flags byte) would mean
  // 0xFF 0x00 sequences in the tag need collapsing to 0xFF. Modern
  // taggers (mp3tag, picard, kid3) emit ID3v2.3/2.4 without it on
  // APIC, so we treat its presence as a "skip, fall back" signal
  // rather than implementing the inverse transform.
  if ((flags & 0x80) !== 0) return null;

  // Optional extended header sits between the main header and the
  // first frame, occupying its own length. Its size is syncsafe in
  // both v2.3 and v2.4. The extended-header flag is bit 6 (0x40).
  let cursor = 10;
  const tagEnd = Math.min(buf.length, 10 + tagSize);
  if ((flags & 0x40) !== 0) {
    if (cursor + 4 > tagEnd) return null;
    const extSize =
      majorVersion >= 4
        ? readSyncsafeInt32(buf, cursor)
        : readUInt32BE(buf, cursor);
    // v2.3's extended-header size DOES NOT include the size field
    // itself; v2.4's DOES. Treat the field as the bytes-to-skip after
    // its own 4 bytes for v2.3, and as the entire ext-header size for
    // v2.4. Either way, advance past it.
    cursor += majorVersion >= 4 ? extSize : 4 + extSize;
  }

  while (cursor + 10 <= tagEnd) {
    // A frame ID of all-zero bytes marks the start of padding — the
    // rest of the tag is filler. Stop.
    if (
      buf[cursor] === 0 && buf[cursor + 1] === 0 &&
      buf[cursor + 2] === 0 && buf[cursor + 3] === 0
    ) break;
    const id = String.fromCharCode(
      buf[cursor], buf[cursor + 1], buf[cursor + 2], buf[cursor + 3]
    );
    const size =
      majorVersion >= 4
        ? readSyncsafeInt32(buf, cursor + 4)
        : readUInt32BE(buf, cursor + 4);
    const frameStart = cursor + 10;
    const frameEnd = frameStart + size;
    if (frameEnd > tagEnd) break;
    if (id === 'APIC') {
      return parseAPICPayload(buf.subarray(frameStart, frameEnd));
    }
    cursor = frameEnd;
  }
  return null;
}

/**
 * Parse the body of an APIC frame. Returns `null` if the MIME is
 * missing or the picture data appears empty.
 *
 * @param {Buffer | Uint8Array} payload
 * @returns {{ mime: string, data: Buffer } | null}
 */
function parseAPICPayload(payload) {
  if (!payload || payload.length < 4) return null;
  const encoding = payload[0];
  // The MIME string is always ISO-8859-1, NUL-terminated, regardless
  // of the frame's text-encoding byte (that byte governs the
  // description only). So one-byte NUL scan suffices.
  let mimeEnd = 1;
  while (mimeEnd < payload.length && payload[mimeEnd] !== 0) mimeEnd += 1;
  if (mimeEnd >= payload.length) return null;
  const mime = decodeAscii(payload.subarray(1, mimeEnd));
  // After the MIME NUL: 1 picture-type byte, then the description.
  let cursor = mimeEnd + 1 + 1;
  // Description terminator: UTF-16 (encodings 1, 2) uses a 2-byte
  // NUL on a 2-byte boundary. ISO-8859-1 and UTF-8 use a 1-byte NUL.
  if (encoding === 1 || encoding === 2) {
    // Walk pairs looking for 0x00 0x00. Anything else is ignored.
    while (
      cursor + 1 < payload.length &&
      !(payload[cursor] === 0 && payload[cursor + 1] === 0)
    ) cursor += 2;
    cursor += 2; // skip the terminator itself
  } else {
    while (cursor < payload.length && payload[cursor] !== 0) cursor += 1;
    cursor += 1; // skip the terminator
  }
  if (cursor >= payload.length) return null;
  const data = payload.subarray(cursor);
  if (data.length === 0) return null;
  // Some taggers leave the MIME blank but the picture bytes are still
  // good. Sniff from the first few bytes when that happens so the
  // renderer still has a usable type. JPEG: FF D8 FF. PNG: 89 50 4E 47.
  const resolvedMime = mime || sniffImageMime(data);
  if (!resolvedMime) return null;
  return { mime: resolvedMime, data: toBuffer(data) };
}

function decodeAscii(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function sniffImageMime(bytes) {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  return null;
}

/** Promote a Uint8Array subarray to a Buffer view without copying. */
function toBuffer(view) {
  if (Buffer.isBuffer(view)) return view;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

// ---------------------------------------------------------------------------
// MP4 / M4A (covr atom)
// ---------------------------------------------------------------------------

/**
 * Extract the first cover image from an MP4 container. Returns `null`
 * when the file is not MP4-shaped or no `covr` atom is present.
 *
 * MP4 is a tree of "boxes" (also called atoms). Each box header is:
 *   4 bytes  size (big-endian; 1 means "use the 8-byte ext size after
 *                   the type field"; 0 means "to end of file")
 *   4 bytes  type (4-char ASCII code)
 *   [8 bytes ext size, when size == 1]
 *   payload
 *
 * Path to the cover: `moov` → `udta` → `meta` → `ilst` → `covr`.
 * The `meta` box is the gotcha: it has a 4-byte version+flags header
 * BEFORE its children (every other container box here does not). Miss
 * that and `ilst` lookup walks off into garbage.
 *
 * The `covr` atom contains one or more `data` atoms whose payloads are
 * the picture bytes; we return the first one.
 *
 * @param {Buffer | Uint8Array} buf
 * @returns {{ mime: string, data: Buffer } | null}
 */
export function extractMP4Covr(buf) {
  if (!buf || buf.length < 8) return null;
  const moov = findBox(buf, 0, buf.length, 'moov');
  if (!moov) return null;
  const udta = findBox(buf, moov.start, moov.end, 'udta');
  if (!udta) return null;
  const meta = findBox(buf, udta.start, udta.end, 'meta');
  if (!meta) return null;
  // `meta` has 4 bytes of version+flags before its children. Skip
  // them or `ilst` lookup will fail.
  const metaChildrenStart = meta.start + 4;
  if (metaChildrenStart >= meta.end) return null;
  const ilst = findBox(buf, metaChildrenStart, meta.end, 'ilst');
  if (!ilst) return null;
  const covr = findBox(buf, ilst.start, ilst.end, 'covr');
  if (!covr) return null;
  // Inside `covr`, find the first `data` atom.
  const data = findBox(buf, covr.start, covr.end, 'data');
  if (!data) return null;
  // Data atom payload:
  //   4 bytes  type indicator (0x0D=JPEG, 0x0E=PNG, others=binary)
  //   4 bytes  reserved (locale)
  //   <image bytes to end of data atom>
  if (data.end - data.start < 8) return null;
  const typeIndicator = readUInt32BE(buf, data.start);
  const imageStart = data.start + 8;
  if (imageStart >= data.end) return null;
  const imageBytes = buf.subarray(imageStart, data.end);
  let mime;
  if (typeIndicator === 13) mime = 'image/jpeg';
  else if (typeIndicator === 14) mime = 'image/png';
  else mime = sniffImageMime(imageBytes) ?? 'application/octet-stream';
  if (imageBytes.length === 0) return null;
  return { mime, data: toBuffer(imageBytes) };
}

/**
 * Locate the first child box of type TYPE within [START, END). Returns
 * `{ start, end }` pointing to the box's payload (excluding the
 * header), or `null` when no such child exists or the bytes are
 * malformed.
 *
 * @param {Buffer | Uint8Array} buf
 * @param {number} start
 * @param {number} end
 * @param {string} type - 4-character box type, e.g. `'moov'`.
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
      // 64-bit extended size. We only read the low 32 bits — anything
      // beyond 4 GiB is well outside album-art territory.
      if (cursor + 16 > end) return null;
      // 8-byte big-endian; high 4 bytes ignored.
      size = readUInt32BE(buf, cursor + 12);
      headerSize = 16;
    } else if (size === 0) {
      // "To end of enclosing container."
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
