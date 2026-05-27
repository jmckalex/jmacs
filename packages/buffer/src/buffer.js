/**
 * @file Layer 2 — the buffer / semantic model. Wraps an L1 storage
 * buffer and adds the things an *editor* needs: a *set* of cursors
 * (each a `{ point, mark }` pair, with index 0 the primary), editing
 * commands expressed relative to those cursors, and rich change events
 * for the renderer to consume.
 *
 * The cursor set lives on whichever object the buffer is bound to via
 * `buffer.bindCursor(source)` (in production, a text View). The buffer
 * itself owns no cursor storage. The single-cursor API (`point`, `mark`,
 * `selection`, the movement and editing methods) reports the primary
 * and runs every operation across the whole set, so existing
 * single-cursor callers carry on unchanged.
 *
 * Offsets are character positions, zero-indexed; ranges are half-open.
 */

import { createBuffer as createStorageBuffer } from '@editor/storage';

/**
 * @typedef {import('@editor/storage').BufferChange} BufferChange
 */

/**
 * An event delivered to {@link Buffer.onChange} listeners after every
 * mutation or cursor movement.
 *
 * @typedef {object} BufferEvent
 * @property {BufferChange | null} change - The text change, or `null`
 *   when only the cursor moved.
 * @property {number} point - The cursor offset after the event.
 * @property {number | null} mark - The selection anchor, or `null`.
 */

/**
 * A contiguous selected range.
 *
 * @typedef {object} Selection
 * @property {number} start - Offset of the first selected character.
 * @property {number} end - Offset just past the last selected character.
 */

/**
 * A single cursor / selection pair held in the cursor source's `cursors`
 * array. The primary cursor is index 0; secondaries are at index 1+.
 *
 * @typedef {object} CursorState
 * @property {number} point - The caret offset.
 * @property {number | null} mark - The selection anchor, or `null`.
 */

/**
 * The cursor-source contract: any object the buffer is bound to via
 * `bindCursor`. The canonical storage is `cursors`, an array of
 * `{point, mark}` records; `point` and `mark` are also exposed (typically
 * as accessors aliasing `cursors[0]`) for backward compatibility with
 * single-cursor callers.
 *
 * @typedef {object} CursorSource
 * @property {CursorState[]} cursors
 * @property {number} point
 * @property {number | null} mark
 */

/** Build a local cursor-backing object with the same shape as a text
 *  view's cursor state: a `cursors[]` array with index 0 as the primary,
 *  plus `point` / `mark` accessors that alias `cursors[0]`. Used as the
 *  default when no view is bound. */
function createLocalCursorState() {
  const state = { cursors: [{ point: 0, mark: null }] };
  Object.defineProperty(state, 'point', {
    get() { return this.cursors[0].point; },
    set(v) { this.cursors[0].point = v; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(state, 'mark', {
    get() { return this.cursors[0].mark; },
    set(v) { this.cursors[0].mark = v; },
    enumerable: true,
    configurable: true,
  });
  return state;
}

/**
 * Create a Layer 2 buffer.
 *
 * The buffer no longer owns its cursor as a *primary* fact: per-view-
 * point (plans/PANES.md Q2) makes the *view* the canonical owner of
 * point/mark, so two views over one buffer have independent cursors.
 * The buffer keeps the cursor API for backward compatibility — the
 * renderer view's per-pane editing path still calls `buf.insert(...)`,
 * `buf.moveLeft(...)` etc. — but the *storage* for the cursor lives
 * in whichever object the buffer is bound to (`buffer.bindCursor(view)`).
 *
 * Until a cursor source is bound, the buffer's `point`/`mark` are
 * backed by a private closure — that's what tests, the renderer's
 * unit tests, and any non-pane caller get. The desktop app rebinds
 * the cursor to the focused view on every focus change, so the buffer
 * reads and writes the view's point/mark directly.
 *
 * @param {string} [initialText=''] - Text to seed the buffer with.
 * @param {object} [options]
 * @param {string} [options.name='untitled'] - A human-readable name.
 * @returns {Buffer}
 */
export function createBuffer(initialText = '', options = {}) {
  const storage = createStorageBuffer(initialText);
  // The local cursor backing — used when no view is bound. This is
  // not the canonical cursor for any view-aware caller; the desktop
  // app's per-pane editor instances always bind a view here. Same
  // `cursors[] + proxied point/mark` shape as a text View, so the
  // multi-cursor code path works whether or not a view is bound.
  const localCursor = createLocalCursorState();
  /** The currently bound cursor source. Defaults to the local backing.
   *  @type {CursorSource} */
  let cursorSource = localCursor;
  let name = options.name ?? 'untitled';

  // The buffer's modes. L2 stores them as opaque values — the standard
  // library defines what a mode is and gives them meaning.
  /** @type {*} */
  let majorMode = null;
  /** @type {*} */
  let minorModes = null;

  /** @type {Set<(event: BufferEvent) => void>} */
  const listeners = new Set();

  // The most recent change reported by L1. Used to position the cursor
  // after undo/redo, where L2 does not compute the change itself.
  /** @type {BufferChange | null} */
  let lastChange = null;
  storage.onChange((change) => {
    lastChange = change;
  });

  /** Clamp an offset into the valid `[0, length]` range. */
  function clamp(offset) {
    if (offset < 0) return 0;
    if (offset > storage.length) return storage.length;
    return offset;
  }

  /** The current cursor array on the bound source. */
  function cursors() {
    return cursorSource.cursors;
  }

  /** The primary cursor (always `cursors[0]`). */
  function primary() {
    return cursors()[0];
  }

  /** The selection of one cursor, or `null` when it isn't selecting. */
  function selectionOf(cursor) {
    if (cursor.mark === null || cursor.mark === cursor.point) return null;
    return {
      start: Math.min(cursor.point, cursor.mark),
      end: Math.max(cursor.point, cursor.mark),
    };
  }

  /** The current selection of the *primary* cursor, or `null`. */
  function currentSelection() {
    return selectionOf(primary());
  }

  /**
   * Move a single cursor to OFFSET, optionally extending its mark to
   * preserve a selection. Used by the multi-cursor movement methods.
   */
  function moveCursor(cursor, offset, opts) {
    if (opts && opts.extend) {
      if (cursor.mark === null) cursor.mark = cursor.point;
    } else {
      cursor.mark = null;
    }
    cursor.point = clamp(offset);
  }

  /**
   * Dedupe and order the cursor set. Carets at the same offset collapse
   * to one; overlapping ranges union. The primary keeps its primary
   * slot when it survives the merge; otherwise the leftmost survivor
   * takes its place.
   */
  function dedupeCursors() {
    const arr = cursors();
    if (arr.length <= 1) return;
    const primaryCursor = arr[0];
    const tagged = arr.map((c) => ({
      cursor: c,
      isPrimary: c === primaryCursor,
      start: c.mark === null ? c.point : Math.min(c.point, c.mark),
      end: c.mark === null ? c.point : Math.max(c.point, c.mark),
    }));
    tagged.sort((a, b) => a.start - b.start || a.end - b.end);

    const merged = [];
    for (const entry of tagged) {
      const last = merged[merged.length - 1];
      // Two caret-only cursors at different offsets do not merge —
      // their `end === start` but the positions differ.
      const overlaps =
        last !== undefined &&
        entry.start <= last.end &&
        !(last.start === last.end &&
          entry.start === entry.end &&
          last.start !== entry.start);
      if (overlaps) {
        last.start = Math.min(last.start, entry.start);
        last.end = Math.max(last.end, entry.end);
        last.isPrimary = last.isPrimary || entry.isPrimary;
        // The surviving cursor keeps its direction (point-end vs mark-
        // end); we just stretch its endpoints to the union.
        if (last.cursor.mark === null) {
          last.cursor.point = last.start;
        } else if (last.cursor.point >= last.cursor.mark) {
          last.cursor.point = last.end;
          last.cursor.mark = last.start;
        } else {
          last.cursor.point = last.start;
          last.cursor.mark = last.end;
        }
      } else {
        merged.push(entry);
      }
    }

    // Rebuild the array in place so the source's `cursors` reference is
    // preserved (the View aliases `point`/`mark` to `cursors[0]`, and
    // replacing the array would break that aliasing).
    arr.length = 0;
    const primaryIndex = merged.findIndex((m) => m.isPrimary);
    if (primaryIndex > 0) {
      const [first] = merged.splice(primaryIndex, 1);
      merged.unshift(first);
    }
    for (const m of merged) arr.push(m.cursor);
  }

  /** Collapse the cursor set down to the primary alone, in place. */
  function collapseInPlace() {
    const arr = cursors();
    if (arr.length > 1) arr.length = 1;
  }

  /**
   * Notify listeners.
   * @param {BufferChange | null} change
   */
  function emit(change) {
    const p = primary();
    const event = { change, point: p.point, mark: p.mark };
    for (const listener of listeners) {
      listener(event);
    }
  }

  /** @type {Buffer} */
  const buffer = {
    // --- identity -------------------------------------------------------

    /** @returns {string} The buffer's name. */
    get name() {
      return name;
    },
    set name(value) {
      name = String(value);
    },

    // --- modes ----------------------------------------------------------
    // L2 stores these opaquely; the standard library interprets them.
    // Setting a mode emits a change event so the view and modeline
    // refresh, exactly as they do for an edit or a cursor move.

    /** @returns {*} The buffer's major mode. */
    get majorMode() {
      return majorMode;
    },
    set majorMode(value) {
      majorMode = value;
      emit(null);
    },

    /** @returns {*} The buffer's active minor modes. */
    get minorModes() {
      return minorModes;
    },
    set minorModes(value) {
      minorModes = value;
      emit(null);
    },

    // --- reading --------------------------------------------------------

    /** @returns {string} The full buffer contents. */
    get text() {
      return storage.toString();
    },

    /** @returns {string} The full buffer contents. */
    toString() {
      return storage.toString();
    },

    /** @returns {number} The number of characters in the buffer. */
    get length() {
      return storage.length;
    },

    /** @returns {number} The number of lines. */
    get lineCount() {
      return storage.lineCount;
    },

    /**
     * @param {number} [start]
     * @param {number} [end]
     * @returns {string}
     */
    slice(start, end) {
      return storage.slice(start, end);
    },

    /**
     * @param {number} position
     * @returns {import('@editor/storage').BufferLine}
     */
    lineAt(position) {
      return storage.lineAt(position);
    },

    /**
     * @param {number} offset
     * @returns {import('@editor/storage').LinePosition}
     */
    positionAt(offset) {
      return storage.positionAt(offset);
    },

    /**
     * @param {number} line
     * @param {number} column
     * @returns {number}
     */
    offsetAt(line, column) {
      return storage.offsetAt(line, column);
    },

    // --- cursor ---------------------------------------------------------
    // Per-view-point: the *storage* for point/mark lives on the bound
    // cursor source (a view, in production; a local backing in tests).
    // The buffer's API still exposes them — that's how the renderer
    // view, the editor commands and the colour-swatch decorator
    // continue to operate via the buffer. Multi-cursor extends this:
    // `selections` exposes the whole set, and the movement / editing
    // methods iterate every cursor.

    /** @returns {number} The primary cursor's offset. */
    get point() {
      return primary().point;
    },

    /** @returns {number | null} The primary cursor's selection anchor. */
    get mark() {
      return primary().mark;
    },

    /** @returns {Selection | null} The primary cursor's selection, or `null`. */
    get selection() {
      return currentSelection();
    },

    // --- multi-cursor ---------------------------------------------------

    /**
     * The full selection set as a snapshot. Index 0 is the primary;
     * subsequent entries are secondary cursors. Mutating the array does
     * not mutate the buffer; use `addSelection` / `collapseToPrimary`.
     *
     * @returns {CursorState[]}
     */
    get selections() {
      return cursors().map((c) => ({ point: c.point, mark: c.mark }));
    },

    /** @returns {number} How many cursors are active. */
    get cursorCount() {
      return cursors().length;
    },

    /**
     * Add a new secondary cursor at OFFSET, optionally with a selection
     * anchor at MARK. A cursor that duplicates an existing one is
     * silently merged.
     *
     * @param {number} offset
     * @param {number | null} [mark=null]
     */
    addSelection(offset, mark = null) {
      const point = clamp(offset);
      const anchor = mark === null ? null : clamp(mark);
      cursors().push({ point, mark: anchor });
      dedupeCursors();
      emit(null);
    },

    /** Collapse all cursors back to the primary alone. */
    collapseToPrimary() {
      const arr = cursors();
      if (arr.length === 1) return;
      arr.length = 1;
      emit(null);
    },

    /**
     * Run FN once per cursor, with its `{ point, mark }` and its index.
     * The buffer's `point` / `mark` getters always report the *primary*
     * (cursors[0]) during the iteration — the visited cursor's state is
     * passed through the callback.
     *
     * @param {(cursor: CursorState, index: number) => void} fn
     */
    forEachSelection(fn) {
      // Snapshot to avoid surprises if FN mutates the cursor set.
      const snapshot = cursors().slice();
      for (let i = 0; i < snapshot.length; i += 1) {
        fn(snapshot[i], i);
      }
    },

    /**
     * Bind a cursor-source: any object with a `cursors` array of
     * `{point, mark}` records plus matching `point` / `mark` accessors
     * (a text View has exactly this shape). Once bound, the buffer's
     * cursor reads and writes go through the source, so two views over
     * one buffer each own their cursor set.
     *
     * Passing `null` reverts to the local backing.
     *
     * @param {CursorSource | null} source
     */
    bindCursor(source) {
      if (source === null) {
        cursorSource = localCursor;
      } else {
        cursorSource = source;
      }
    },

    /**
     * Move the cursor to an absolute offset. An absolute jump is
     * single-cursor by definition ("go to line 17" can't mean "go to
     * line 17 for each caret"), so the set collapses to the primary
     * first.
     *
     * @param {number} offset - Target offset; clamped to the buffer.
     * @param {object} [opts]
     * @param {boolean} [opts.extend=false] - When true, keep (or set)
     *   the mark so the move extends a selection.
     */
    moveTo(offset, opts = {}) {
      collapseInPlace();
      moveCursor(primary(), offset, opts);
      emit(null);
    },

    /**
     * Set the selection anchor on the primary cursor.
     * @param {number | null} offset - An offset, or `null` to clear it.
     */
    setMark(offset) {
      primary().mark = offset === null ? null : clamp(offset);
      emit(null);
    },

    /** Clear the selection anchor on every cursor. */
    clearMark() {
      for (const c of cursors()) c.mark = null;
      emit(null);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveLeft(opts) {
      for (const c of cursors()) moveCursor(c, c.point - 1, opts);
      dedupeCursors();
      emit(null);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveRight(opts) {
      for (const c of cursors()) moveCursor(c, c.point + 1, opts);
      dedupeCursors();
      emit(null);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveUp(opts) {
      for (const c of cursors()) {
        const { line, column } = storage.positionAt(c.point);
        const target = line === 0 ? 0 : storage.offsetAt(line - 1, column);
        moveCursor(c, target, opts);
      }
      dedupeCursors();
      emit(null);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveDown(opts) {
      for (const c of cursors()) {
        const { line, column } = storage.positionAt(c.point);
        const target =
          line >= storage.lineCount - 1
            ? storage.length
            : storage.offsetAt(line + 1, column);
        moveCursor(c, target, opts);
      }
      dedupeCursors();
      emit(null);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveLineStart(opts) {
      for (const c of cursors()) {
        moveCursor(c, storage.lineAt(c.point).from, opts);
      }
      dedupeCursors();
      emit(null);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveLineEnd(opts) {
      for (const c of cursors()) {
        moveCursor(c, storage.lineAt(c.point).to, opts);
      }
      dedupeCursors();
      emit(null);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveBufferStart(opts) {
      // Absolute jump → collapse.
      collapseInPlace();
      moveCursor(primary(), 0, opts);
      emit(null);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveBufferEnd(opts) {
      // Absolute jump → collapse.
      collapseInPlace();
      moveCursor(primary(), storage.length, opts);
      emit(null);
    },

    // --- editing --------------------------------------------------------

    /**
     * Insert text at every cursor. If a cursor has a selection, the
     * inserted text replaces it. After the call, each cursor sits just
     * after the text it inserted, overlapping cursors merge, and any
     * marks are cleared.
     *
     * @param {string} text
     */
    insert(text) {
      // Process cursors in document order, accumulating the offset
      // shift caused by earlier edits so later edits land at the right
      // place after the text has moved.
      const order = cursors()
        .map((c) => ({
          c,
          start: c.mark === null ? c.point : Math.min(c.point, c.mark),
        }))
        .sort((a, b) => a.start - b.start);
      let shift = 0;
      for (const { c } of order) {
        const selection = selectionOf(c);
        if (selection) {
          const start = selection.start + shift;
          const end = selection.end + shift;
          storage.replace(start, end, text);
          c.point = start + text.length;
          shift += text.length - (end - start);
        } else {
          const at = c.point + shift;
          storage.insert(at, text);
          c.point = at + text.length;
          shift += text.length;
        }
        c.mark = null;
      }
      dedupeCursors();
      // The L1 change captured only the *last* low-level edit; for a
      // single-cursor insert that matches what callers expect, while a
      // multi-cursor insert reports the final edit (good enough for the
      // listener to schedule a re-render).
      emit(lastChange);
    },

    /**
     * Delete backward from every cursor. With a selection, deletes the
     * selection; otherwise deletes `count` characters before the cursor.
     *
     * @param {number} [count=1]
     * @returns {boolean} Whether anything was deleted at any cursor.
     */
    deleteBackward(count = 1) {
      let anyDeleted = false;
      const order = cursors()
        .map((c) => ({
          c,
          start: c.mark === null ? c.point : Math.min(c.point, c.mark),
        }))
        .sort((a, b) => a.start - b.start);
      let shift = 0;
      for (const { c } of order) {
        const selection = selectionOf(c);
        if (selection) {
          const start = selection.start + shift;
          const end = selection.end + shift;
          storage.delete(start, end);
          c.point = start;
          shift -= end - start;
          anyDeleted = true;
        } else {
          const at = c.point + shift;
          const from = Math.max(0, at - count);
          if (from === at) {
            c.point = at;
          } else {
            storage.delete(from, at);
            c.point = from;
            shift -= at - from;
            anyDeleted = true;
          }
        }
        c.mark = null;
      }
      dedupeCursors();
      emit(lastChange);
      return anyDeleted;
    },

    /**
     * Delete forward from every cursor. With a selection, deletes the
     * selection; otherwise deletes `count` characters after the cursor.
     *
     * @param {number} [count=1]
     * @returns {boolean} Whether anything was deleted at any cursor.
     */
    deleteForward(count = 1) {
      let anyDeleted = false;
      const order = cursors()
        .map((c) => ({
          c,
          start: c.mark === null ? c.point : Math.min(c.point, c.mark),
        }))
        .sort((a, b) => a.start - b.start);
      let shift = 0;
      for (const { c } of order) {
        const selection = selectionOf(c);
        if (selection) {
          const start = selection.start + shift;
          const end = selection.end + shift;
          storage.delete(start, end);
          c.point = start;
          shift -= end - start;
          anyDeleted = true;
        } else {
          const at = c.point + shift;
          const to = Math.min(storage.length, at + count);
          if (to === at) {
            c.point = at;
          } else {
            storage.delete(at, to);
            c.point = at;
            shift -= to - at;
            anyDeleted = true;
          }
        }
        c.mark = null;
      }
      dedupeCursors();
      emit(lastChange);
      return anyDeleted;
    },

    /**
     * Replace the entire buffer contents. Used to load a file. The
     * cursor set collapses to the primary, moves to the start, and the
     * mark is cleared.
     *
     * @param {string} text - The new contents.
     */
    setText(text) {
      storage.replace(0, storage.length, String(text));
      collapseInPlace();
      primary().point = 0;
      primary().mark = null;
      emit(lastChange);
    },

    // --- history --------------------------------------------------------

    /**
     * Undo the last edit. The cursor set collapses to the primary and
     * moves to the changed region.
     * @returns {boolean} Whether anything was undone.
     */
    undo() {
      if (!storage.canUndo) return false;
      storage.undo();
      collapseInPlace();
      primary().point = clamp(lastChange.start + lastChange.inserted.length);
      primary().mark = null;
      emit(lastChange);
      return true;
    },

    /**
     * Redo the last undone edit. The cursor set collapses to the primary.
     * @returns {boolean} Whether anything was redone.
     */
    redo() {
      if (!storage.canRedo) return false;
      storage.redo();
      collapseInPlace();
      primary().point = clamp(lastChange.start + lastChange.inserted.length);
      primary().mark = null;
      emit(lastChange);
      return true;
    },

    /** @returns {boolean} Whether there is an edit available to undo. */
    get canUndo() {
      return storage.canUndo;
    },

    /** @returns {boolean} Whether there is an edit available to redo. */
    get canRedo() {
      return storage.canRedo;
    },

    // --- observing ------------------------------------------------------

    /**
     * Subscribe to buffer events.
     * @param {(event: BufferEvent) => void} listener
     * @returns {() => void} An unsubscribe function.
     */
    onChange(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('listener must be a function');
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return buffer;
}

/**
 * A Layer 2 buffer. See {@link createBuffer}.
 *
 * @typedef {ReturnType<typeof createBuffer>} Buffer
 */
