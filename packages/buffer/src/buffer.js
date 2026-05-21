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
 * @param {string} [initialText=''] - Text to seed the buffer with.
 * @param {object} [options]
 * @param {string} [options.name='untitled'] - A human-readable name.
 * @returns {Buffer}
 */
export function createBuffer(initialText = '', options = {}) {
  const storage = createStorageBuffer(initialText);
  let point = 0;
  /** @type {number | null} */
  let mark = null;
  let name = options.name ?? 'untitled';

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
    if (mark === null || mark === point) return null;
    return { start: Math.min(point, mark), end: Math.max(point, mark) };
  }

  /**
   * Notify listeners.
   * @param {BufferChange | null} change
   */
  function emit(change) {
    const event = { change, point, mark };
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

    /** @returns {number} The cursor offset. */
    get point() {
      return point;
    },

    /** @returns {number | null} The selection anchor, or `null`. */
    get mark() {
      return mark;
    },

    /** @returns {Selection | null} The current selection, or `null`. */
    get selection() {
      return currentSelection();
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
        if (mark === null) mark = point;
      } else {
        mark = null;
      }
      point = clamp(offset);
      emit(null);
    },

    /**
     * Set the selection anchor.
     * @param {number | null} offset - An offset, or `null` to clear it.
     */
    setMark(offset) {
      mark = offset === null ? null : clamp(offset);
      emit(null);
    },

    /** Clear the selection anchor. */
    clearMark() {
      mark = null;
      emit(null);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveLeft(opts) {
      this.moveTo(point - 1, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveRight(opts) {
      this.moveTo(point + 1, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveUp(opts) {
      const { line, column } = storage.positionAt(point);
      const target = line === 0 ? 0 : storage.offsetAt(line - 1, column);
      this.moveTo(target, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveDown(opts) {
      const { line, column } = storage.positionAt(point);
      const target =
        line >= storage.lineCount - 1
          ? storage.length
          : storage.offsetAt(line + 1, column);
      this.moveTo(target, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveLineStart(opts) {
      this.moveTo(storage.lineAt(point).from, opts);
    },

    /** @param {{ extend?: boolean }} [opts] */
    moveLineEnd(opts) {
      this.moveTo(storage.lineAt(point).to, opts);
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
        point = selection.start + text.length;
      } else {
        storage.insert(point, text);
        point += text.length;
      }
      mark = null;
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
        point = selection.start;
      } else {
        const from = clamp(point - count);
        if (from === point) return false;
        storage.delete(from, point);
        point = from;
      }
      mark = null;
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
        point = selection.start;
      } else {
        const to = clamp(point + count);
        if (to === point) return false;
        storage.delete(point, to);
      }
      mark = null;
      emit(lastChange);
      return true;
    },

    // --- history --------------------------------------------------------

    /**
     * Undo the last edit and move the cursor to the changed region.
     * @returns {boolean} Whether anything was undone.
     */
    undo() {
      if (!storage.canUndo) return false;
      storage.undo();
      point = clamp(lastChange.start + lastChange.inserted.length);
      mark = null;
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
      point = clamp(lastChange.start + lastChange.inserted.length);
      mark = null;
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
