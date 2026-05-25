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

/** File-name suffix → audio MIME type, for the suffixes jmacs opens
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

/** File-name suffix → video MIME type, for the suffixes jmacs opens
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
 * Whether a file name names an audio file jmacs should open through
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
 * Whether a file name names a video file jmacs should open through
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
