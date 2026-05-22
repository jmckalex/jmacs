/**
 * @file Colour swatches — inline, clickable colour previews placed
 * beside every colour literal in a rendered buffer line.
 *
 * The view recreates its line DOM on each render (it virtualises), so
 * this module exposes a single pure-ish `decorateLine` step the view
 * calls per line as it builds it. The decorator scans the line's text
 * for colour literals (via the pure `findColourLiterals`) and inserts a
 * small swatch `<span>` after each one.
 *
 * Clicking a swatch opens the modal colour chooser; on OK the chosen
 * hex is written back into the buffer, replacing the literal's text.
 * The buffer edit is done through the buffer's own public command
 * methods — select the literal's range, then `insert` the new text —
 * so this module never reaches past the L2 API.
 */

import { findColourLiterals } from './colour-literals.js';
import { openColourPicker } from './colour-picker.js';

/**
 * Replace the text of a colour literal in a buffer with a new value,
 * using only the buffer's public command surface.
 *
 * The literal occupies `[start, end)` in the buffer's text. We select
 * exactly that span (move the cursor to `start`, then to `end`
 * extending the selection) and `insert` the replacement, which the
 * buffer applies as a replace-of-selection. The cursor is left after
 * the inserted text.
 *
 * @param {import('@editor/buffer').Buffer} buffer
 * @param {number} start - Buffer offset of the literal's first char.
 * @param {number} end - Buffer offset one past its last char.
 * @param {string} replacement - The new literal text.
 */
export function replaceLiteralInBuffer(buffer, start, end, replacement) {
  buffer.moveTo(start);
  buffer.moveTo(end, { extend: true });
  buffer.insert(replacement);
}

/**
 * Create a swatch decorator bound to a buffer source.
 *
 * @param {object} options
 * @param {Document} options.doc - The document swatches are created in.
 * @param {() => import('@editor/buffer').Buffer} options.getBuffer -
 *   Returns the buffer a click should edit (the currently shown one).
 * @returns {{
 *   decorateLine: (lineEl: HTMLElement, lineText: string,
 *                  lineStartOffset: number) => void,
 * }}
 */
export function createColourSwatches({ doc, getBuffer }) {
  /**
   * Decorate one rendered line element: append a clickable swatch
   * after every colour literal its text contains.
   *
   * The line element already holds the line's text (as a single text
   * node or as faced token spans). To place a swatch we walk the
   * element's text nodes, find the node and offset where a literal
   * ends, and insert the swatch span immediately after that point —
   * which keeps the literal's own characters untouched and the swatch
   * inline right after them, whatever highlighting split the line into.
   *
   * @param {HTMLElement} lineEl - The `.editor-line` element.
   * @param {string} lineText - The plain text of the line.
   * @param {number} lineStartOffset - The buffer offset of the line's
   *   first character — used to map a literal to a buffer range.
   */
  function decorateLine(lineEl, lineText, lineStartOffset) {
    const literals = findColourLiterals(lineText);
    if (literals.length === 0) return;

    // Decorate from the last literal to the first: inserting a swatch
    // after an earlier literal would shift the text-node geometry of
    // the later ones, so working right-to-left keeps offsets stable.
    for (let i = literals.length - 1; i >= 0; i -= 1) {
      insertSwatch(lineEl, literals[i], lineStartOffset);
    }
  }

  /** Place a single swatch after `literal` within `lineEl`. */
  function insertSwatch(lineEl, literal, lineStartOffset) {
    const at = locateTextOffset(lineEl, literal.end);
    if (!at) return;

    const swatch = doc.createElement('span');
    swatch.className = 'colour-swatch';
    swatch.dataset.colour = literal.text;
    swatch.title = `Edit colour ${literal.text}`;
    swatch.style.setProperty('--swatch-colour', literal.css);
    // The literal's range in the buffer, captured so a later click
    // edits exactly the right span.
    const bufferStart = lineStartOffset + literal.start;
    const bufferEnd = lineStartOffset + literal.end;

    swatch.addEventListener('mousedown', (event) => {
      // The editor view places the cursor on a mousedown; a click on
      // the swatch must not also do that.
      event.preventDefault();
      event.stopPropagation();
    });
    swatch.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSwatchClick(literal, bufferStart, bufferEnd);
    });

    insertAfter(at.node, at.offset, swatch);
  }

  /** Open the modal and, on OK, write the chosen colour to the buffer. */
  function onSwatchClick(literal, bufferStart, bufferEnd) {
    openColourPicker({
      doc,
      initial: literal.text,
      onChoose: (hex) => {
        const buffer = getBuffer();
        if (!buffer) return;
        // Guard against a stale span: the literal must still be at the
        // captured range. If the buffer changed underneath, do nothing
        // rather than corrupt unrelated text.
        if (buffer.text.slice(bufferStart, bufferEnd) !== literal.text) {
          return;
        }
        replaceLiteralInBuffer(buffer, bufferStart, bufferEnd, hex);
      },
    });
  }

  return { decorateLine };
}

/**
 * Find the text node and in-node offset that sits `charOffset`
 * characters into an element's text content.
 *
 * @param {HTMLElement} element
 * @param {number} charOffset
 * @returns {{ node: Text, offset: number } | null}
 */
function locateTextOffset(element, charOffset) {
  let remaining = charOffset;
  for (const node of textNodesOf(element)) {
    const length = node.data.length;
    if (remaining <= length) {
      return { node, offset: remaining };
    }
    remaining -= length;
  }
  return null;
}

/** Every descendant text node of `element`, in document order. */
function textNodesOf(element) {
  const nodes = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) nodes.push(child);
      else walk(child);
    }
  };
  walk(element);
  return nodes;
}

/**
 * Insert `newNode` into the DOM immediately after the `offset`-th
 * character of text node `node`, splitting the node if the offset is
 * mid-text.
 *
 * @param {Text} node
 * @param {number} offset
 * @param {Node} newNode
 */
function insertAfter(node, offset, newNode) {
  const parent = node.parentNode;
  if (!parent) return;
  if (offset >= node.data.length) {
    // The swatch goes right after this node — and after any node the
    // literal's last span ended exactly on.
    if (node.nextSibling) {
      parent.insertBefore(newNode, node.nextSibling);
    } else {
      parent.append(newNode);
    }
    return;
  }
  // Mid-node: split so the swatch lands between the two halves.
  const tail = node.splitText(offset);
  parent.insertBefore(newNode, tail);
}
