/**
 * @file View utilities — derivation helpers that live on top of the
 * View shape but don't belong inside `createView` itself.
 *
 * Pulled out of `apps/desktop/src/app.js` in phase 2 of plans/PANES.md
 * so `tabline.js` and `session.js` can consume views directly,
 * without going through the legacy buffer-record adapter shims that
 * phase 1 left in `app.js`.
 */

/**
 * Return the file path associated with VIEW, or `null` when none.
 *
 * For a text view the path lives on the buffer (`view.buffer.filePath`).
 * For non-text views (image, audio, video) the path was set as a
 * top-level field at view creation (image-kind, audio-kind, video-kind
 * are all opened from a file). Other non-text kinds (shell, jukebox,
 * directory-*) carry no single "file" — they read `null`.
 *
 * Centralised here so callers (the tabline tooltip, the session
 * serializer, the view-list dedupe, the *Buffer List* file column)
 * don't have to know which slot holds the path.
 *
 * @param {import('./view.js').View | null | undefined} view
 * @returns {string | null}
 */
export function viewFilePath(view) {
  if (!view) return null;
  if (view.buffer && typeof view.buffer.filePath === 'string') {
    return view.buffer.filePath;
  }
  if (typeof view.filePath === 'string') return view.filePath;
  return null;
}
