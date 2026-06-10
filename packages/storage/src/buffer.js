/**
 * @file Layer 1 storage — the text data structure. A buffer holds text
 * and nothing else: no semantic awareness, no notion of what the text
 * *means*, only what characters are in it.
 *
 * Positions are character offsets, zero-indexed. Ranges are half-open
 * `[start, end)`. Lines and columns are zero-indexed.
 *
 * The current implementation is backed by a plain string, so every edit
 * copies the whole text. This is correct but does not scale; it will be
 * replaced by a piece tree behind this exact public API.
 */

/**
 * A change applied to a buffer. One uniform shape covers insert, delete
 * and replace: an insert has `removed === ''`, a delete has
 * `inserted === ''`, a replace has both non-empty.
 *
 * @typedef {object} BufferChange
 * @property {number} start - Character offset where the change begins.
 * @property {string} removed - Text that was removed at `start`.
 * @property {string} inserted - Text that was inserted at `start`.
 */

/**
 * @callback ChangeListener
 * @param {BufferChange} change - The change that was just applied.
 * @returns {void}
 */

/**
 * A position expressed as a zero-indexed line and column.
 *
 * @typedef {object} LinePosition
 * @property {number} line - Zero-indexed line number.
 * @property {number} column - Zero-indexed character offset within the line.
 */

/**
 * A line of the buffer.
 *
 * @typedef {object} BufferLine
 * @property {number} number - Zero-indexed line number.
 * @property {number} from - Offset of the first character of the line.
 * @property {number} to - Offset just past the last character, excluding
 *   the terminating newline.
 * @property {string} text - The line's text, without its newline.
 */

/**
 * Create a buffer.
 *
 * @param {string} [initialText=''] - Text to seed the buffer with.
 * @returns {Buffer} A new buffer.
 */
export function createBuffer(initialText = '') {
  if (typeof initialText !== 'string') {
    throw new TypeError('initialText must be a string');
  }

  let text = initialText;
  /** @type {Set<ChangeListener>} */
  const listeners = new Set();
  /** @type {BufferChange[]} */
  const undoStack = [];
  /** @type {BufferChange[]} */
  const redoStack = [];

  /**
   * Validate that `offset` is an integer in `[0, length]`.
   * @param {number} offset
   * @param {string} name - Used in error messages.
   */
  function assertOffset(offset, name) {
    if (!Number.isInteger(offset)) {
      throw new TypeError(`${name} must be an integer`);
    }
    if (offset < 0 || offset > text.length) {
      throw new RangeError(
        `${name} ${offset} out of range [0, ${text.length}]`
      );
    }
  }

  /**
   * Apply a change to the text and notify listeners. Does not record
   * history — callers decide whether a change is undoable.
   * @param {BufferChange} change
   */
  function emit(change) {
    text =
      text.slice(0, change.start) +
      change.inserted +
      text.slice(change.start + change.removed.length);
    for (const listener of listeners) {
      listener(change);
    }
  }

  /**
   * Apply a user-initiated edit: record it for undo, drop the redo
   * stack, then apply it.
   * @param {BufferChange} change
   */
  function applyEdit(change) {
    undoStack.push(change);
    redoStack.length = 0;
    emit(change);
  }

  /**
   * Offsets at which each line begins. Line 0 begins at 0; a new line
   * begins after every `\n`. Recomputed on demand — acceptable while
   * the backing store is a plain string.
   * @returns {number[]}
   */
  function lineStarts() {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        starts.push(i + 1);
      }
    }
    return starts;
  }

  /** @type {Buffer} */
  const buffer = {
    /**
     * Insert text at a character position.
     *
     * @param {number} position - Offset at which the inserted text
     *   begins. An integer in `[0, length]`; `length` appends.
     * @param {string} insertText - The text to insert.
     */
    insert(position, insertText) {
      assertOffset(position, 'position');
      if (typeof insertText !== 'string') {
        throw new TypeError('insert text must be a string');
      }
      applyEdit({ start: position, removed: '', inserted: insertText });
    },

    /**
     * Delete the characters in the half-open range `[start, end)`.
     *
     * @param {number} start - Offset of the first character to remove.
     * @param {number} end - Offset just past the last character.
     * @returns {string} The text that was removed.
     */
    delete(start, end) {
      assertOffset(start, 'start');
      assertOffset(end, 'end');
      if (start > end) {
        throw new RangeError(`start ${start} is after end ${end}`);
      }
      const removed = text.slice(start, end);
      applyEdit({ start, removed, inserted: '' });
      return removed;
    },

    /**
     * Replace the range `[start, end)` with new text.
     *
     * @param {number} start - Offset of the first character to replace.
     * @param {number} end - Offset just past the last character.
     * @param {string} newText - The replacement text.
     * @returns {string} The text that was removed.
     */
    replace(start, end, newText) {
      assertOffset(start, 'start');
      assertOffset(end, 'end');
      if (start > end) {
        throw new RangeError(`start ${start} is after end ${end}`);
      }
      if (typeof newText !== 'string') {
        throw new TypeError('replacement text must be a string');
      }
      const removed = text.slice(start, end);
      applyEdit({ start, removed, inserted: newText });
      return removed;
    },

    /**
     * Return the text in the half-open range `[start, end)`.
     *
     * @param {number} [start=0] - Offset of the first character.
     * @param {number} [end] - Offset just past the last character;
     *   defaults to the buffer length.
     * @returns {string}
     */
    slice(start = 0, end = text.length) {
      assertOffset(start, 'start');
      assertOffset(end, 'end');
      return text.slice(start, end);
    },

    /** @returns {string} The buffer's full contents. */
    toString() {
      return text;
    },

    /**
     * The offset `count` whole characters before `offset`. A "character"
     * is a Unicode code point, so a surrogate pair counts as one and the
     * result never lands between a high and low surrogate. Clamped to 0.
     *
     * This is what callers should use to move or delete "by one
     * character": stepping by a raw code unit can split an astral
     * character (e.g. an emoji) and corrupt the text.
     *
     * @param {number} offset - A starting offset in `[0, length]`.
     * @param {number} [count=1] - How many characters to step back.
     * @returns {number}
     */
    stepBackward(offset, count = 1) {
      assertOffset(offset, 'offset');
      let pos = offset;
      for (let i = 0; i < count && pos > 0; i++) {
        const lo = text.charCodeAt(pos - 1);
        if (pos >= 2 && lo >= 0xdc00 && lo <= 0xdfff) {
          const hi = text.charCodeAt(pos - 2);
          pos -= hi >= 0xd800 && hi <= 0xdbff ? 2 : 1;
        } else {
          pos -= 1;
        }
      }
      return pos;
    },

    /**
     * The offset `count` whole characters after `offset`. The forward
     * mirror of {@link Buffer#stepBackward}: a surrogate pair counts as
     * one character and the result never lands between a high and low
     * surrogate. Clamped to `length`.
     *
     * @param {number} offset - A starting offset in `[0, length]`.
     * @param {number} [count=1] - How many characters to step forward.
     * @returns {number}
     */
    stepForward(offset, count = 1) {
      assertOffset(offset, 'offset');
      let pos = offset;
      for (let i = 0; i < count && pos < text.length; i++) {
        const hi = text.charCodeAt(pos);
        if (hi >= 0xd800 && hi <= 0xdbff && pos + 1 < text.length) {
          const lo = text.charCodeAt(pos + 1);
          pos += lo >= 0xdc00 && lo <= 0xdfff ? 2 : 1;
        } else {
          pos += 1;
        }
      }
      return pos;
    },

    /** @returns {number} The number of characters in the buffer. */
    get length() {
      return text.length;
    },

    /** @returns {number} The number of lines (always at least 1). */
    get lineCount() {
      return lineStarts().length;
    },

    /**
     * The line containing a given offset.
     *
     * @param {number} position - An offset in `[0, length]`.
     * @returns {BufferLine}
     */
    lineAt(position) {
      assertOffset(position, 'position');
      const starts = lineStarts();
      let line = 0;
      while (line + 1 < starts.length && starts[line + 1] <= position) {
        line += 1;
      }
      const from = starts[line];
      const to = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
      return { number: line, from, to, text: text.slice(from, to) };
    },

    /**
     * Convert a character offset to a line/column position.
     *
     * @param {number} offset - An offset in `[0, length]`.
     * @returns {LinePosition}
     */
    positionAt(offset) {
      assertOffset(offset, 'offset');
      const starts = lineStarts();
      let line = 0;
      while (line + 1 < starts.length && starts[line + 1] <= offset) {
        line += 1;
      }
      return { line, column: offset - starts[line] };
    },

    /**
     * Convert a line/column position to a character offset.
     *
     * @param {number} line - A zero-indexed line number.
     * @param {number} column - A zero-indexed column. Clamped to the
     *   length of the line.
     * @returns {number}
     */
    offsetAt(line, column) {
      if (!Number.isInteger(line) || !Number.isInteger(column)) {
        throw new TypeError('line and column must be integers');
      }
      const starts = lineStarts();
      if (line < 0 || line >= starts.length) {
        throw new RangeError(
          `line ${line} out of range [0, ${starts.length - 1}]`
        );
      }
      if (column < 0) {
        throw new RangeError(`column ${column} is negative`);
      }
      const lineEnd =
        line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
      return Math.min(starts[line] + column, lineEnd);
    },

    /**
     * Subscribe to change events. The listener fires after every
     * mutation, including those produced by undo and redo.
     *
     * @param {ChangeListener} listener
     * @returns {() => void} A function that removes the listener.
     */
    onChange(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('listener must be a function');
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Undo the most recent edit. Edits produced by undo and redo are
     * not themselves recorded as new edits.
     *
     * @returns {boolean} `true` if an edit was undone, `false` if there
     *   was nothing to undo.
     */
    undo() {
      const change = undoStack.pop();
      if (change === undefined) {
        return false;
      }
      redoStack.push(change);
      emit({
        start: change.start,
        removed: change.inserted,
        inserted: change.removed,
      });
      return true;
    },

    /**
     * Redo the most recently undone edit.
     *
     * @returns {boolean} `true` if an edit was redone, `false` if there
     *   was nothing to redo.
     */
    redo() {
      const change = redoStack.pop();
      if (change === undefined) {
        return false;
      }
      undoStack.push(change);
      emit(change);
      return true;
    },

    /** @returns {boolean} Whether there is an edit available to undo. */
    get canUndo() {
      return undoStack.length > 0;
    },

    /** @returns {boolean} Whether there is an edit available to redo. */
    get canRedo() {
      return redoStack.length > 0;
    },
  };

  return buffer;
}

/**
 * A unit of text storage. See {@link createBuffer}.
 *
 * @typedef {object} Buffer
 * @property {(position: number, text: string) => void} insert
 * @property {(start: number, end: number) => string} delete
 * @property {(start: number, end: number, newText: string) => string} replace
 * @property {(start?: number, end?: number) => string} slice
 * @property {() => string} toString
 * @property {(offset: number, count?: number) => number} stepBackward
 * @property {(offset: number, count?: number) => number} stepForward
 * @property {number} length
 * @property {number} lineCount
 * @property {(position: number) => BufferLine} lineAt
 * @property {(offset: number) => LinePosition} positionAt
 * @property {(line: number, column: number) => number} offsetAt
 * @property {(listener: ChangeListener) => (() => void)} onChange
 * @property {() => boolean} undo
 * @property {() => boolean} redo
 * @property {boolean} canUndo
 * @property {boolean} canRedo
 */
