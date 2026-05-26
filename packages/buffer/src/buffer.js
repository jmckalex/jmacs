/**
 * @file Layer 2 — the buffer / semantic model. Wraps an L1 storage
 * buffer and adds the things an *editor* needs: a cursor (point), a
 * selection anchor (mark), editing commands expressed relative to the
 * cursor, and rich change events for the renderer to consume.
 *
 * This is a deliberately minimal L2. Text properties, overlays,
 * markers, modes and hooks (all named in the architecture) are not
 * here yet — they are layered on once the editor runs end to end.
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
  // app's per-pane editor instances always bind a view here.
  const localCursor = { point: 0, mark: /** @type {number|null} */ (null) };
  /** The currently bound cursor source. Defaults to the local backing. */
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

  /** The current selection, or `null` when nothing is selected. */
  function currentSelection() {
    const point = cursorSource.point;
    const mark = cursorSource.mark;
    if (mark === null || mark === point) return null;
    return { start: Math.min(point, mark), end: Math.max(point, mark) };
  }

  /**
   * Notify listeners.
   * @param {BufferChange | null} change
   */
  function emit(change) {
    const event = { change, point: cursorSource.point, mark: cursorSource.mark };
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
    // continue to operate via the buffer.

    /** @returns {number} The cursor offset. */
    get point() {
      return cursorSource.point;
    },

    /** @returns {number | null} The selection anchor, or `null`. */
    get mark() {
      return cursorSource.mark;
    },

    /** @returns {Selection | null} The current selection, or `null`. */
    get selection() {
      return currentSelection();
    },

    /**
     * Bind a *view-shaped* cursor source: any object with mutable
     * `point` (number) and `mark` (number | null) fields. Once bound,
     * the buffer's cursor reads and writes go to that object, so two
     * views over one buffer can each own their cursor.
     *
     * Passing `null` reverts to the local backing.
     *
     * @param {{ point: number, mark: number | null } | null} source
     */
    bindCursor(source) {
      if (source === null) {
        cursorSource = localCursor;
      } else {
        cursorSource = source;
      }
    },

    /**
     * Move the cursor to an absolute offset.
     *
     * @param {number} offset - Target offset; clamped to the buffer.
     * @param {object} [opts]
     * @param {boolean} [opts.extend=false] - When true, keep (or set)
     *   the mark so the move extends a selection.
     */
    moveTo(offset, opts = {}) {
      if (opts.extend) {
        if (cursorSource.mark === null) cursorSource.mark = cursorSource.point;
      } else {
        cursorSource.mark = null;
      }
      cursorSource.point = clamp(offset);
      emit(null);
    },

    /**
     * Set the selection anchor.
     * @param {number | null} offset - An offset, or `null` to clear it.
     */
    setMark(offset) {
      cursorSource.mark = offset === null ? null : clamp(offset);
      emit(null);
    },

    /** Clear the selection anchor. */
    clearMark() {
      cursorSource.mark = null;
      emit(null);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveLeft(opts) {
      this.moveTo(cursorSource.point - 1, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveRight(opts) {
      this.moveTo(cursorSource.point + 1, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveUp(opts) {
      const { line, column } = storage.positionAt(cursorSource.point);
      const target = line === 0 ? 0 : storage.offsetAt(line - 1, column);
      this.moveTo(target, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveDown(opts) {
      const { line, column } = storage.positionAt(cursorSource.point);
      const target =
        line >= storage.lineCount - 1
          ? storage.length
          : storage.offsetAt(line + 1, column);
      this.moveTo(target, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveLineStart(opts) {
      this.moveTo(storage.lineAt(cursorSource.point).from, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveLineEnd(opts) {
      this.moveTo(storage.lineAt(cursorSource.point).to, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveBufferStart(opts) {
      this.moveTo(0, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveBufferEnd(opts) {
      this.moveTo(storage.length, opts);
    },

    // --- editing --------------------------------------------------------

    /**
     * Insert text at the cursor. If there is a selection, the inserted
     * text replaces it. The cursor ends just after the inserted text.
     *
     * @param {string} text
     */
    insert(text) {
      const selection = currentSelection();
      if (selection) {
        storage.replace(selection.start, selection.end, text);
        cursorSource.point = selection.start + text.length;
      } else {
        storage.insert(cursorSource.point, text);
        cursorSource.point += text.length;
      }
      cursorSource.mark = null;
      emit(lastChange);
    },

    /**
     * Delete backward from the cursor. With a selection, deletes the
     * selection; otherwise deletes `count` characters before the cursor.
     *
     * @param {number} [count=1]
     * @returns {boolean} Whether anything was deleted.
     */
    deleteBackward(count = 1) {
      const selection = currentSelection();
      if (selection) {
        storage.delete(selection.start, selection.end);
        cursorSource.point = selection.start;
      } else {
        const point = cursorSource.point;
        const from = clamp(point - count);
        if (from === point) return false;
        storage.delete(from, point);
        cursorSource.point = from;
      }
      cursorSource.mark = null;
      emit(lastChange);
      return true;
    },

    /**
     * Delete forward from the cursor. With a selection, deletes the
     * selection; otherwise deletes `count` characters after the cursor.
     *
     * @param {number} [count=1]
     * @returns {boolean} Whether anything was deleted.
     */
    deleteForward(count = 1) {
      const selection = currentSelection();
      if (selection) {
        storage.delete(selection.start, selection.end);
        cursorSource.point = selection.start;
      } else {
        const point = cursorSource.point;
        const to = clamp(point + count);
        if (to === point) return false;
        storage.delete(point, to);
      }
      cursorSource.mark = null;
      emit(lastChange);
      return true;
    },

    /**
     * Replace the entire buffer contents. Used to load a file. The
     * cursor moves to the start and the selection is cleared.
     *
     * @param {string} text - The new contents.
     */
    setText(text) {
      storage.replace(0, storage.length, String(text));
      cursorSource.point = 0;
      cursorSource.mark = null;
      emit(lastChange);
    },

    // --- history --------------------------------------------------------

    /**
     * Undo the last edit and move the cursor to the changed region.
     * @returns {boolean} Whether anything was undone.
     */
    undo() {
      if (!storage.canUndo) return false;
      storage.undo();
      cursorSource.point = clamp(lastChange.start + lastChange.inserted.length);
      cursorSource.mark = null;
      emit(lastChange);
      return true;
    },

    /**
     * Redo the last undone edit and move the cursor to the changed region.
     * @returns {boolean} Whether anything was redone.
     */
    redo() {
      if (!storage.canRedo) return false;
      storage.redo();
      cursorSource.point = clamp(lastChange.start + lastChange.inserted.length);
      cursorSource.mark = null;
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
