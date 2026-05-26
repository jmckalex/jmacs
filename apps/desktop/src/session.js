/**
 * @file Persistent session — serialise the open buffer list and
 * restore it on next startup, so a quit-and-relaunch lands the user
 * back where they left off.
 *
 * What is persisted: each file-backed text buffer's path, point and
 * mark, plus the index (and path) of the buffer that was current.
 * Ephemeral buffers (scratch, doc, image, customize, jukebox, eval
 * log, the buffer-list buffer itself) are skipped — they belong to a
 * session and do not survive one.
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
 * The current buffer is identified by path, not by index, so a file
 * that fails to re-open (it was deleted between runs) doesn't shift
 * the cursor onto the wrong buffer.
 */

/**
 * @typedef {Object} SerialisedBuffer
 * @property {string} path - The buffer's absolute file path.
 * @property {number} point - The cursor offset.
 * @property {number | null} mark - The selection anchor, or null.
 */

/**
 * @typedef {Object} SerialisedSession
 * @property {SerialisedBuffer[]} buffers
 * @property {string | null} currentPath
 */

/**
 * Is BUFFER ephemeral — something the session should not save?
 * Ephemerals are: anything with a `kind` (doc/image/customize), and
 * text buffers whose name marks them out as transient (`*scratch*`,
 * `*Buffer List*`, `*Jukebox: …*`, `*Eval log*`, `*Doc: …*`,
 * `*Customize: …*`, `*Occur: …*`).
 *
 * @param {{kind?: string, name?: string, filePath?: string}} buffer
 * @returns {boolean}
 */
export function isEphemeral(buffer) {
  if (!buffer) return true;
  // Non-text kinds (doc, image, customize) are always ephemeral.
  if (buffer.kind) return true;
  // A text buffer with no file path can't be reopened; nothing to save.
  if (typeof buffer.filePath !== 'string' || buffer.filePath === '') {
    return true;
  }
  // Names like *…* are by convention transient utility buffers.
  const name = buffer.name ?? '';
  if (name.startsWith('*') && name.endsWith('*')) return true;
  return false;
}

/**
 * Build the serialised session payload from a live buffer list.
 *
 * @param {Array<{kind?: string, name?: string, filePath?: string,
 *   point?: number, mark?: number | null}>} buffers
 * @param {number} currentIndex - The index of the current buffer.
 * @returns {SerialisedSession}
 */
export function serialise(buffers, currentIndex) {
  const keep = buffers.filter((buffer) => !isEphemeral(buffer));
  const serialised = keep.map((buffer) => ({
    path: buffer.filePath,
    point: typeof buffer.point === 'number' ? buffer.point : 0,
    mark: typeof buffer.mark === 'number' ? buffer.mark : null,
  }));
  const current = buffers[currentIndex];
  const currentPath =
    current && !isEphemeral(current) ? current.filePath : null;
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
 * @param {() => Array<object>} options.getBuffers - Current buffer list.
 * @param {() => number} options.getCurrentIndex - Current buffer index.
 * @param {(path: string) => Promise<{point: number, mark: number|null}|null>}
 *   options.openByPath - Open a file by absolute path; called once per
 *   serialised entry during restore. Returns the {point, mark} to
 *   restore onto the buffer it just opened, or null when the open
 *   failed (the file is missing) — the entry is skipped.
 * @param {(index: number) => void} options.switchToBuffer - Switch
 *   to a buffer by index; called once after the restore to land on
 *   the previously-current buffer.
 * @param {() => Array<object>} options.getBuffersAfterRestore -
 *   Read the buffers array after `openByPath` calls. The controller
 *   uses this to find the index of the previously-current path.
 * @param {Object} options.host - Bridge with `readSession`/
 *   `writeSession` methods. Usually `window.host`.
 * @param {number} [options.debounceMs=500] - Save debounce delay.
 * @returns {{save: () => void, flush: () => Promise<void>,
 *   restore: () => Promise<void>, snapshot: () => SerialisedSession}}
 */
export function createSession({
  getBuffers,
  getCurrentIndex,
  openByPath,
  switchToBuffer,
  host,
  debounceMs = 500,
}) {
  let timer = null;

  function snapshot() {
    return serialise(getBuffers(), getCurrentIndex());
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
    // Re-point onto the previously-current buffer, if it survived.
    if (data.currentPath !== null) {
      const buffers = getBuffers();
      const index = buffers.findIndex(
        (buffer) => buffer.filePath === data.currentPath
      );
      if (index >= 0) switchToBuffer(index);
    }
  }

  return { save, flush, restore, snapshot };
}
