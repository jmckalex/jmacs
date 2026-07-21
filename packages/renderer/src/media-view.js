/**
 * @file Shared helpers for the audio and video views — the suffix sets
 * a file-open path uses to decide whether to route to the audio/video
 * view rather than reading the file as text.
 *
 * These are small lookup tables; the views themselves live in
 * `audio-view.js` and `video-view.js`. Keeping the suffix tables here
 * lets `app.js` (the file-open router) import them without pulling in
 * the DOM-touching view modules.
 *
 * The renderer's main process keeps its own copy of these tables in
 * `apps/desktop/src/files.js` because the main process cannot import
 * the renderer package. The pair is exercised end-to-end by the smoke
 * test.
 */

/** File-name suffix → audio MIME type, for the suffixes Godot opens
 *  as audio. The keys are lower-case, with the leading dot. The MIME
 *  type is informational — the renderer's `<audio>` element does its
 *  own sniffing — but we keep the table parallel to the video one for
 *  symmetry. */
const AUDIO_MIME_TYPES = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
};

/** File-name suffix → video MIME type, for the suffixes Godot opens
 *  as video. Note that not every browser plays every container — most
 *  notably Chromium does not natively play `.mkv`. The view still
 *  mounts; the `<video>` element shows its native error UI. */
const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

/** Lower-case suffix of NAME including the leading dot, or `null`. */
function suffixOf(name) {
  if (typeof name !== 'string') return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return name.slice(dot).toLowerCase();
}

/**
 * The audio MIME type for a file name, by its suffix, or `null` when
 * the name has no recognised audio suffix.
 *
 * @param {string} name - A file name or path.
 * @returns {string | null}
 */
export function mimeTypeForAudio(name) {
  const suffix = suffixOf(name);
  if (suffix === null) return null;
  return AUDIO_MIME_TYPES[suffix] ?? null;
}

/**
 * Whether a file name names an audio file Godot should open through
 * the audio view rather than as text.
 *
 * @param {string} name - A file name or path.
 * @returns {boolean}
 */
export function isAudioFileName(name) {
  return mimeTypeForAudio(name) !== null;
}

/**
 * The video MIME type for a file name, by its suffix, or `null` when
 * the name has no recognised video suffix.
 *
 * @param {string} name - A file name or path.
 * @returns {string | null}
 */
export function mimeTypeForVideo(name) {
  const suffix = suffixOf(name);
  if (suffix === null) return null;
  return VIDEO_MIME_TYPES[suffix] ?? null;
}

/**
 * Whether a file name names a video file Godot should open through
 * the video view rather than as text.
 *
 * @param {string} name - A file name or path.
 * @returns {boolean}
 */
export function isVideoFileName(name) {
  return mimeTypeForVideo(name) !== null;
}

/**
 * The same path-encoder the audio controller uses to turn an absolute
 * filesystem path into a `media://` URL the renderer can fetch. The
 * renderer page is served from a privileged origin (`app://editor/`);
 * a bare `file://` URL gets blocked cross-origin, so audio and video
 * elements route through the main process's `media` scheme handler
 * (see `apps/desktop/src/serve.js`).
 *
 * @param {string} filePath - An absolute filesystem path.
 * @returns {string} The `media://localhost/...` URL.
 */
export function mediaUrlForPath(filePath) {
  if (typeof filePath !== 'string') return '';
  if (/^(media|file|https?|blob|data):/.test(filePath)) return filePath;
  return (
    'media://localhost' +
    filePath.split('/').map(encodeURIComponent).join('/')
  );
}

/**
 * @typedef {object} MediaErrorAdvice
 * @property {string} headline - One-line summary the view shows
 *   prominently in place of the broken element.
 * @property {string} detail - A sentence of context — what likely went
 *   wrong, in plain language.
 * @property {string | null} suggestion - One-line lead-in for the
 *   command (e.g. "Remux to MP4:"), or `null` when no command applies.
 * @property {string | null} command - A copy-pasteable shell command
 *   (typically `ffmpeg …`) that fixes the file, or `null`.
 */

/**
 * Turn a `MediaError` (the value an `<audio>`/`<video>` element exposes
 * on its `.error` property after the `error` event fires) into the
 * shape the audio/video views render in their error block. Pure — kept
 * here so the test suite can exercise it without a DOM.
 *
 * Maps the four `MediaError.code` cases:
 *
 *   - `1` ABORTED: user-initiated, return `null` (don't show anything).
 *   - `2` NETWORK: file couldn't be fetched from disk.
 *   - `3` DECODE: the file is recognised but data is truncated/corrupt.
 *   - `4` SRC_NOT_SUPPORTED: the codec or container is one Chromium
 *      doesn't decode. The most common path on Godot — and the one
 *      that takes the most tailored advice (the `.mkv` case in
 *      particular has a one-line remux that almost always works).
 *
 * Any other shape (no error, unknown code) returns a generic block.
 *
 * @param {{code?: number, message?: string} | null | undefined} error
 * @param {string | null | undefined} name - The buffer's display name
 *   (used to detect the file extension and to interpolate into the
 *   suggested ffmpeg command).
 * @returns {MediaErrorAdvice | null}
 */
export function mediaErrorAdvice(error, name) {
  if (!error) return null;
  const code = typeof error.code === 'number' ? error.code : 0;
  // ABORTED is user-initiated (a pause-and-seek mid-load); not an
  // error worth surfacing.
  if (code === 1) return null;
  const safeName = typeof name === 'string' ? name : '';
  const suffix = (() => {
    const dot = safeName.lastIndexOf('.');
    return dot >= 0 ? safeName.slice(dot).toLowerCase() : '';
  })();
  if (code === 2) {
    return {
      headline: "Couldn't read the file",
      detail:
        "The media stream couldn't be fetched from disk. The file may " +
        'have been moved or deleted since the buffer was opened.',
      suggestion: null,
      command: null,
    };
  }
  if (code === 3) {
    return {
      headline: "Couldn't decode the file",
      detail:
        'The container is recognised but the data appears truncated or ' +
        'corrupted. A re-download or re-encode usually fixes this.',
      suggestion: 'Re-encode (uses ffmpeg):',
      command: ffmpegReencode(safeName),
    };
  }
  if (code === 4) {
    if (suffix === '.mkv') {
      return {
        headline: "Chromium can't play Matroska (.mkv) natively",
        detail:
          "Chromium's bundled media decoder doesn't support the Matroska " +
          'container. Remuxing to MP4 is usually instant — no re-encode, ' +
          'just a container swap.',
        suggestion: 'Remux to MP4:',
        command: ffmpegRemuxToMp4(safeName),
      };
    }
    return {
      headline: "This file uses a codec Chromium can't play",
      detail:
        "Common culprits: HEVC / H.265 video, AC-3 / E-AC-3 audio, or a " +
        "non-standard container. Chromium ships a fixed set of decoders; " +
        "converting to H.264 + AAC in an MP4 works everywhere.",
      suggestion: 'Convert to H.264 + AAC in MP4:',
      command: ffmpegReencode(safeName),
    };
  }
  return {
    headline: 'Playback error',
    detail:
      typeof error.message === 'string' && error.message !== ''
        ? error.message
        : `The browser reported error code ${code || 'unknown'}.`,
    suggestion: null,
    command: null,
  };
}

/** Build a remux-to-MP4 command for `name`. The `-c copy` flag means
 *  no re-encode — ffmpeg just rewrites the container, which is fast
 *  and lossless when the streams are already MP4-compatible. */
function ffmpegRemuxToMp4(name) {
  const input = name || 'input.mkv';
  const output = input.replace(/\.[^./]+$/, '') + '.mp4';
  return `ffmpeg -i "${input}" -c copy "${output}"`;
}

/** Build a re-encode command for `name`. H.264 video + AAC audio in
 *  an MP4 container — the lowest-common-denominator combination every
 *  Chromium build plays. Slower than a remux but works when the source
 *  codecs aren't supported. */
function ffmpegReencode(name) {
  const input = name || 'input';
  const output = (input.replace(/\.[^./]+$/, '') || 'output') + '-converted.mp4';
  return `ffmpeg -i "${input}" -c:v libx264 -c:a aac "${output}"`;
}
