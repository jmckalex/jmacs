/**
 * @file Layer 1 storage. A buffer holds text and nothing else — no
 * semantic awareness. Positions are character offsets, zero-indexed;
 * ranges are half-open `[start, end)`.
 *
 * The current implementation is backed by a plain string. This is
 * correct but copies the whole text on every insert. It will be
 * replaced by a piece tree without changing this public API.
 */

/**
 * A unit of text storage.
 *
 * @typedef {object} Buffer
 * @property {(position: number, text: string) => void} insert
 *   Insert `text` so that it begins at `position`.
 * @property {() => string} toString
 *   The buffer's full contents.
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

  return {
    /**
     * Insert text at a character position.
     *
     * @param {number} position - Character offset at which the inserted
     *   text begins. Must be an integer in `[0, length]`; inserting at
     *   `length` appends.
     * @param {string} insertText - The text to insert.
     */
    insert(position, insertText) {
      if (!Number.isInteger(position)) {
        throw new TypeError('position must be an integer');
      }
      if (position < 0 || position > text.length) {
        throw new RangeError(
          `position ${position} out of range [0, ${text.length}]`
        );
      }
      if (typeof insertText !== 'string') {
        throw new TypeError('insert text must be a string');
      }
      text = text.slice(0, position) + insertText + text.slice(position);
    },

    /**
     * @returns {string} The buffer's full contents.
     */
    toString() {
      return text;
    },
  };
}
