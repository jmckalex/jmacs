/**
 * @file Model-B media-kind detection — which non-text VIEW a file routes to.
 *
 * The server decides, by a file's suffix, whether find-file should create a TEXT
 * buffer (read the bytes as UTF-8) or a non-text DATA-SOURCE rendered by one of
 * the existing element-views (image / audio / video / pdf). The actual bytes are
 * loaded CLIENT-side via `window.host.openFilePath` (the main process serves the
 * `data:` / `media://` URL); this module only maps a suffix → a view kind, so it
 * is pure + unit-testable with no I/O.
 *
 * The suffix sets MIRROR the main process's `apps/desktop/src/files.js`
 * (IMAGE_MIME_TYPES / AUDIO_SUFFIXES / VIDEO_SUFFIXES / PDF_SUFFIXES) so the
 * server's "this is media" decision matches what `openFilePath` can actually
 * render. Keep the two in sync.
 */

/** Suffix → view kind. Lower-cased keys; mirrors files.js. */
const MEDIA_SUFFIXES = new Map([
  // image (IMAGE_MIME_TYPES)
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'],
  ['.gif', 'image'], ['.svg', 'image'], ['.webp', 'image'],
  // audio (AUDIO_SUFFIXES)
  ['.mp3', 'audio'], ['.flac', 'audio'], ['.wav', 'audio'], ['.ogg', 'audio'],
  ['.oga', 'audio'], ['.m4a', 'audio'], ['.aac', 'audio'], ['.opus', 'audio'],
  // video (VIDEO_SUFFIXES)
  ['.mp4', 'video'], ['.m4v', 'video'], ['.webm', 'video'],
  ['.mov', 'video'], ['.mkv', 'video'],
  // pdf (PDF_SUFFIXES)
  ['.pdf', 'pdf'],
]);

/**
 * The non-text view kind a file NAME/path routes to, or null when it is a plain
 * text file (find-file reads it as UTF-8 as usual).
 *
 * @param {string} name - A file name or path.
 * @returns {'image'|'audio'|'video'|'pdf'|null}
 */
export function mediaKindForName(name) {
  if (typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return MEDIA_SUFFIXES.get(lower.slice(dot)) ?? null;
}
