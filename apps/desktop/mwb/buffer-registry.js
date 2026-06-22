/**
 * @file Model-B multi-buffer slice — the server-side BUFFER REGISTRY.
 *
 * The command spine (spine.js) started with ONE canonical buffer that
 * find-file *replaced*. To be a real multi-buffer workspace the server must
 * hold MANY buffers at once — a buffer list, keyed by id — and clients
 * switch between them. This module is that registry.
 *
 * Each registry entry is a self-contained buffer world:
 *   - `buffer`   — a real L2 buffer (@editor/buffer): the shared TEXT.
 *   - `views`    — a Map<clientIndex, View>: each client viewing this buffer
 *                  keeps its OWN point/mark over the shared text (the
 *                  per-window vs per-buffer split, plan §4). A client that
 *                  has never visited this buffer has no entry until it
 *                  switches to it (lazily minted on switch).
 *   - `overlays` — the buffer's overlay list (search highlights, …). Overlays
 *                  are SHARED buffer state: every client viewing this buffer
 *                  sees the same set, so they live ON THE ENTRY, not per
 *                  client. Each overlay's endpoints are L2 markers so the
 *                  range rides edits.
 *   - `savedText`— the text last loaded/saved, for the modeline modified flag.
 *   - `filePath` — the absolute disk path this buffer writes back to (set by
 *                  find-file / write-file), or null for a path-less buffer
 *                  (the seed *scratch* or a buffer never visited from a file).
 *
 * The registry is deliberately split out from spine.js so it is small,
 * DOM-free, Electron-free, and unit-testable under `node --test`
 * (buffer-registry.test.js). spine.js owns the interpreter + command
 * dispatch; this owns the buffer/view bookkeeping. The two collaborate: the
 * spine asks the registry which buffer + view a client is on, binds the
 * interpreter's session to it, and runs commands; the registry never runs
 * Lisp.
 *
 * The view factory is injected (the registry does not import @editor/view
 * directly) so the unit test can pass a tiny fake view and assert the
 * bookkeeping without standing up the whole view stack — and so the spine
 * supplies the real one.
 */

/**
 * @typedef {object} View
 * @property {number} point
 * @property {number | null} mark
 * @property {Array<{point:number, mark:number|null}>} [cursors]
 */

/**
 * @typedef {object} BufferEntry
 * @property {string} id - The stable registry id (e.g. "b1").
 * @property {object} buffer - The L2 buffer (the shared text).
 * @property {Map<number, View>} views - clientIndex → that client's view.
 * @property {{ id: string, startM: object, endM: object, face: string, kind: string }[]} overlays
 * @property {string} savedText - Text last loaded/saved (modified flag).
 * @property {string | null} filePath - Absolute disk path, or null (path-less).
 */

/**
 * Create a buffer registry.
 *
 * @param {object} deps
 * @param {(text: string, opts: { name: string }) => object} deps.createBuffer
 *   - Mint an L2 buffer (the spine passes @editor/buffer's createBuffer).
 * @param {(spec: { kind: string, buffer: object, name: string }) => View} deps.createView
 *   - Mint a view over a buffer (the spine passes @editor/view's createView).
 * @param {(bufferId: string, change: object, buffer: object) => void} [deps.onBufferChange]
 *   - Called for every text change on ANY registry buffer, tagged with the
 *   buffer's id. The server uses this to fan a delta only to the clients
 *   viewing THAT buffer (multi-buffer: different windows hold different
 *   buffers, so a delta is no longer a broadcast). Cursor-only changes
 *   (change === null) are skipped — the server reconciles those per client.
 * @returns {BufferRegistry}
 */
export function createBufferRegistry(deps) {
  const { createBuffer, createView } = deps;
  const onBufferChange = typeof deps.onBufferChange === 'function'
    ? deps.onBufferChange
    : null;

  /** @type {Map<string, BufferEntry>} insertion-ordered (Map preserves it). */
  const entries = new Map();
  let nextId = 0;
  let overlayId = 0;

  /** Mint a fresh, unique buffer id. */
  function freshId() {
    nextId += 1;
    return `b${nextId}`;
  }

  /**
   * If NAME collides with an existing buffer's name, return a uniquified
   * name with an Emacs-style `<n>` suffix. Two files of the same basename
   * (a/util.js and b/util.js) get `util.js` and `util.js<2>`. The id is
   * always unique regardless; this only keeps the *display name* legible.
   */
  function uniqueName(name) {
    const taken = new Set([...entries.values()].map((e) => e.buffer.name));
    if (!taken.has(name)) return name;
    let n = 2;
    while (taken.has(`${name}<${n}>`)) n += 1;
    return `${name}<${n}>`;
  }

  /**
   * Add a new buffer to the registry. Returns its entry. Does NOT mint any
   * client views — those are created lazily when a client switches to it
   * (viewFor). The buffer's name is uniquified against the existing set.
   *
   * @param {string} text - The buffer's seed text.
   * @param {string} name - The desired buffer/view name.
   * @param {string | null} [filePath=null] - The absolute disk path this
   *   buffer writes back to, or null for a path-less buffer.
   * @returns {BufferEntry}
   */
  function add(text, name, filePath = null) {
    const id = freshId();
    const buffer = createBuffer(text ?? '', { name: uniqueName(name ?? 'scratch') });
    /** @type {BufferEntry} */
    const entry = {
      id,
      buffer,
      views: new Map(),
      overlays: [],
      savedText: text ?? '',
      filePath: typeof filePath === 'string' && filePath !== '' ? filePath : null,
    };
    entries.set(id, entry);
    // Tag this buffer's text changes with its id so the server can fan the
    // delta only to the clients viewing it (multi-buffer: deltas are no
    // longer broadcast). Each buffer keeps its own subscription for life.
    if (onBufferChange && typeof buffer.onChange === 'function') {
      buffer.onChange((event) => {
        if (event && event.change !== null) onBufferChange(id, event, buffer);
      });
    }
    return entry;
  }

  /** The entry for ID, or null. */
  function get(id) {
    return entries.get(id) ?? null;
  }

  /** Whether ID names a live buffer. */
  function has(id) {
    return entries.has(id);
  }

  /** Every entry, in insertion (buffer-list) order. */
  function list() {
    return [...entries.values()];
  }

  /** The number of buffers held. */
  function count() {
    return entries.size;
  }

  /** The first entry (the default / fallback buffer), or null when empty. */
  function first() {
    for (const e of entries.values()) return e;
    return null;
  }

  /** Find an entry by buffer NAME (the C-x b switch path resolves names). */
  function findByName(name) {
    for (const e of entries.values()) {
      if (e.buffer.name === name) return e;
    }
    return null;
  }

  // --- dirty tracking + the disk path (the save story) ------------------

  /**
   * Whether ENTRY has unsaved edits: its live text diverges from the text it
   * was last loaded/saved at (the saved-baseline approach the real app uses).
   * Pure (no I/O), so the dirty flag is cheap to read on every keystroke.
   *
   * @param {BufferEntry} entry
   * @returns {boolean}
   */
  function isModified(entry) {
    return !!entry && entry.buffer.text !== entry.savedText;
  }

  /**
   * Re-baseline ENTRY to its current text (call after a successful save): the
   * saved text now equals the on-disk text, so the buffer is clean again and
   * the modeline drops its ● dirty indicator.
   *
   * @param {BufferEntry} entry
   */
  function markSaved(entry) {
    if (entry) entry.savedText = entry.buffer.text;
  }

  /**
   * Set (or clear) the absolute disk path ENTRY writes back to. write-file /
   * save-as binds a new path here; null makes the buffer path-less again.
   *
   * @param {BufferEntry} entry
   * @param {string | null} filePath
   */
  function setFilePath(entry, filePath) {
    if (!entry) return;
    entry.filePath = typeof filePath === 'string' && filePath !== '' ? filePath : null;
  }

  /** Every entry that currently has unsaved edits (for autosave snapshots). */
  function dirtyEntries() {
    return [...entries.values()].filter(isModified);
  }

  /**
   * The view a client has on a buffer, minting it on first access. A client
   * gets a FRESH view (its own point/mark at 0) the first time it visits a
   * buffer; thereafter it reuses the same view, so switching away and back
   * preserves that window's cursor in that buffer.
   *
   * @param {string} id - The buffer id.
   * @param {number} clientIndex - The client's handle.
   * @returns {View | null} The view, or null if the buffer is gone.
   */
  function viewFor(id, clientIndex) {
    const entry = entries.get(id);
    if (!entry) return null;
    let view = entry.views.get(clientIndex);
    if (!view) {
      view = createView({ kind: 'text', buffer: entry.buffer, name: entry.buffer.name });
      view.point = 0;
      entry.views.set(clientIndex, view);
    }
    return view;
  }

  /**
   * Remove a buffer from the registry (kill-buffer). Releases its overlays'
   * markers. Returns true if it was present. Refuses to remove the LAST
   * buffer (the registry is never empty — the caller should ensure another
   * exists first, mirroring Emacs's "killing the last buffer makes a fresh
   * *scratch*").
   *
   * @param {string} id
   * @returns {boolean} Whether the buffer was removed.
   */
  function remove(id) {
    if (entries.size <= 1) return false;
    const entry = entries.get(id);
    if (!entry) return false;
    for (const o of entry.overlays) {
      o.startM.remove();
      o.endM.remove();
    }
    entry.overlays = [];
    return entries.delete(id);
  }

  /**
   * Drop a client's views across EVERY buffer (the client window detached).
   * Idempotent. Does not remove any buffer — buffers outlive clients.
   *
   * @param {number} clientIndex
   */
  function dropClient(clientIndex) {
    for (const e of entries.values()) e.views.delete(clientIndex);
  }

  // --- overlays (per-entry, edit-tracked via L2 markers) ----------------

  /**
   * Add a face-tagged overlay to a buffer entry. Its endpoints are L2
   * markers on that entry's buffer, so the range rides edits. Returns the
   * overlay id.
   *
   * @param {BufferEntry} entry
   * @param {number} start
   * @param {number} end
   * @param {string} face
   * @param {string} [kind='overlay']
   * @returns {string}
   */
  function addOverlay(entry, start, end, face, kind = 'overlay') {
    const lo = Math.max(0, Math.floor(Math.min(start, end)));
    const hi = Math.max(0, Math.floor(Math.max(start, end)));
    overlayId += 1;
    const id = `ov${overlayId}`;
    entry.overlays.push({
      id,
      startM: entry.buffer.createMarker(lo),
      endM: entry.buffer.createMarker(hi),
      face: String(face ?? 'overlay'),
      kind: String(kind ?? 'overlay'),
    });
    return id;
  }

  /**
   * Drop overlays from an entry: all of them, or only those of KIND.
   *
   * @param {BufferEntry} entry
   * @param {string} [kind] - Undefined clears all.
   * @returns {number} How many overlays were removed.
   */
  function clearOverlays(entry, kind) {
    const keep = [];
    let removed = 0;
    for (const o of entry.overlays) {
      if (kind === undefined || o.kind === kind) {
        o.startM.remove();
        o.endM.remove();
        removed += 1;
      } else {
        keep.push(o);
      }
    }
    entry.overlays = keep;
    return removed;
  }

  /**
   * A wire snapshot of an entry's overlays at their CURRENT (edit-tracked)
   * offsets: `[{ start, end, face, kind, id }]`. Drops overlays a deletion
   * has collapsed (end <= start).
   *
   * @param {BufferEntry} entry
   * @returns {{ start:number, end:number, face:string, kind:string, id:string }[]}
   */
  function overlaySnapshot(entry) {
    const out = [];
    for (const o of entry.overlays) {
      const start = o.startM.offset;
      const end = o.endM.offset;
      if (end <= start) continue;
      out.push({ start, end, face: o.face, kind: o.kind, id: o.id });
    }
    return out;
  }

  /**
   * A plain-data record per buffer for the buffer-list view (C-x C-b). The
   * client renders these. `current` is filled by the caller (it knows which
   * buffer a given client is on); here we report buffer-intrinsic facts.
   *
   * @returns {{ id:string, name:string, lineCount:number, modified:boolean, filePath:string|null }[]}
   */
  function listRecords() {
    return [...entries.values()].map((e) => ({
      id: e.id,
      name: e.buffer.name,
      lineCount: e.buffer.lineCount,
      modified: isModified(e),
      filePath: e.filePath,
    }));
  }

  /** @typedef {object} BufferRegistry */
  return {
    add,
    get,
    has,
    list,
    count,
    first,
    findByName,
    isModified,
    markSaved,
    setFilePath,
    dirtyEntries,
    viewFor,
    remove,
    dropClient,
    addOverlay,
    clearOverlays,
    overlaySnapshot,
    listRecords,
  };
}
