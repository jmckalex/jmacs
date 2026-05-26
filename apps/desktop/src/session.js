/**
 * @file Persistent session — serialise the open view list and restore
 * it on next startup, so a quit-and-relaunch lands the user back where
 * they left off.
 *
 * What is persisted: each file-backed text view's path, point and
 * mark, plus the index (and path) of the view that was current.
 * Ephemeral views (scratch, doc, image, customize, jukebox, eval
 * log, the *Buffer List* view itself, the audio/video media views,
 * shell, directory-*, customize, tabline) are skipped — they belong
 * to a session and do not survive one.
 *
 * Persisted shape (the JSON shipped to the host):
 *
 *   {
 *     "buffers": [
 *       { "path": "/abs/path/foo.txt", "point": 12, "mark": null },
 *       ...
 *     ],
 *     "currentPath": "/abs/path/foo.txt"
 *   }
 *
 * The current view is identified by path, not by index, so a file
 * that fails to re-open (it was deleted between runs) doesn't shift
 * the cursor onto the wrong view.
 *
 * Phase 2 of plans/PANES.md: consumes views directly. The old
 * `getBuffers: () => Array<{kind, name, filePath, point, mark}>`
 * adapter in `app.js` (`viewAsSessionRecord`) is gone; this module
 * reads view.kind / view.name / view.buffer.point / view.buffer.mark
 * straight off the View, and resolves the file path through
 * `viewFilePath` from `@editor/view`.
 *
 * The persisted JSON's outer key is still `buffers` for backwards
 * compatibility with on-disk session.json files from before the
 * view/buffer split — renaming it would break first-relaunch
 * restoration for users upgrading across the split.
 */

import { viewFilePath } from '@editor/view';

/**
 * @typedef {Object} SerialisedBuffer
 * @property {string} path - The view's absolute file path.
 * @property {number} point - The cursor offset.
 * @property {number | null} mark - The selection anchor, or null.
 */

/**
 * @typedef {Object} SerialisedSession
 * @property {SerialisedBuffer[]} buffers
 * @property {string | null} currentPath
 */

/**
 * Is VIEW ephemeral — something the session should not save?
 * Ephemerals are: any non-text view (image, audio, video, shell,
 * jukebox, customize, doc, directory-tree, directory-columns,
 * tabline), and text views whose name marks them out as transient
 * (`*scratch*`, `*Buffer List*`, `*Jukebox: …*`, `*Eval log*`,
 * `*Doc: …*`, `*Customize: …*`, `*Occur: …*`).
 *
 * @param {{kind?: string, name?: string, buffer?: {filePath?: string}} | null | undefined} view
 * @returns {boolean}
 */
export function isEphemeral(view) {
  if (!view) return true;
  // Non-text views are always ephemeral — they hold their own state
  // (a directory path, a track list, a shell session id, ...) and
  // don't survive a relaunch.
  if (view.kind && view.kind !== 'text') return true;
  // A text view with no file path can't be reopened; nothing to save.
  const filePath = viewFilePath(view);
  if (typeof filePath !== 'string' || filePath === '') return true;
  // Names like *…* are by convention transient utility buffers.
  const name = view.name ?? '';
  if (name.startsWith('*') && name.endsWith('*')) return true;
  return false;
}

/**
 * Build the serialised session payload from a live view list.
 *
 * @param {import('@editor/view').View[]} views
 * @param {number} currentIndex - The index of the current view.
 * @returns {SerialisedSession}
 */
export function serialise(views, currentIndex) {
  const keep = views.filter((view) => !isEphemeral(view));
  const serialised = keep.map((view) => {
    const buffer = view.buffer;
    return {
      path: viewFilePath(view),
      point: buffer && typeof buffer.point === 'number' ? buffer.point : 0,
      mark: buffer && typeof buffer.mark === 'number' ? buffer.mark : null,
    };
  });
  const current = views[currentIndex];
  const currentPath =
    current && !isEphemeral(current) ? viewFilePath(current) : null;
  return { buffers: serialised, currentPath };
}

/**
 * Parse a session payload read from disk. Returns the well-shaped
 * value, or an empty session when the input is missing/invalid — the
 * editor should never refuse to start because of a stray session file.
 *
 * @param {unknown} raw
 * @returns {SerialisedSession}
 */
export function deserialise(raw) {
  const empty = { buffers: [], currentPath: null };
  if (raw === null || typeof raw !== 'object') return empty;
  const list = Array.isArray(raw.buffers) ? raw.buffers : [];
  const buffers = list
    .filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.path === 'string' &&
        entry.path !== ''
    )
    .map((entry) => ({
      path: entry.path,
      point: Number.isFinite(entry.point) ? Number(entry.point) : 0,
      mark: Number.isFinite(entry.mark) ? Number(entry.mark) : null,
    }));
  const currentPath =
    typeof raw.currentPath === 'string' && raw.currentPath !== ''
      ? raw.currentPath
      : null;
  return { buffers, currentPath };
}

/**
 * Build the editor-side session controller.
 *
 * The controller wraps the IPC boundary and the debounce timer, so
 * the rest of the app can just call `save()` (debounced) or `flush()`
 * (immediate), and `restore()` on startup.
 *
 * @param {Object} options
 * @param {() => import('@editor/view').View[]} options.getViews -
 *   Current view list.
 * @param {() => number} options.getCurrentIndex - Current view index.
 * @param {(path: string, entry: SerialisedBuffer) =>
 *     Promise<SerialisedBuffer | null>}
 *   options.openByPath - Open a file by absolute path; called once per
 *   serialised entry during restore. Returns the {point, mark} to
 *   restore onto the buffer it just opened, or null when the open
 *   failed (the file is missing) — the entry is skipped.
 * @param {(index: number) => void} options.switchToView - Switch to a
 *   view by index; called once after the restore to land on the
 *   previously-current view.
 * @param {Object} options.host - Bridge with `readSession`/
 *   `writeSession` methods. Usually `window.host`.
 * @param {number} [options.debounceMs=500] - Save debounce delay.
 * @returns {{save: () => void, flush: () => Promise<void>,
 *   restore: () => Promise<void>, snapshot: () => SerialisedSession}}
 */
export function createSession({
  getViews,
  getCurrentIndex,
  openByPath,
  switchToView,
  host,
  debounceMs = 500,
}) {
  let timer = null;

  function snapshot() {
    return serialise(getViews(), getCurrentIndex());
  }

  async function writeNow() {
    timer = null;
    try {
      await host.writeSession(snapshot());
    } catch {
      // A session-write failure is non-fatal: the editor keeps running,
      // the next save will try again.
    }
  }

  function save() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(writeNow, debounceMs);
  }

  async function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await writeNow();
  }

  async function restore() {
    let raw;
    try {
      raw = await host.readSession();
    } catch {
      return;
    }
    const data = deserialise(raw);
    if (data.buffers.length === 0) return;
    for (const entry of data.buffers) {
      try {
        await openByPath(entry.path, entry);
      } catch {
        // Skip a file that fails to open — it may have been deleted.
      }
    }
    // Re-point onto the previously-current view, if it survived.
    if (data.currentPath !== null) {
      const views = getViews();
      const index = views.findIndex(
        (view) => viewFilePath(view) === data.currentPath
      );
      if (index >= 0) switchToView(index);
    }
  }

  return { save, flush, restore, snapshot };
}
