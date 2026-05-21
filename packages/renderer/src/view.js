/**
 * @file The DOM view — the one part of the renderer that touches the
 * DOM. It subscribes to an L2 buffer, projects its state into elements,
 * and feeds keyboard input back as editing commands.
 *
 * Rendering is batched: buffer events mark the view dirty and a single
 * render runs on the next animation frame, regardless of how many
 * events arrived. Geometry is expressed in CSS `ch` (column) and `lh`
 * (line) units, so a monospace font needs no pixel measurement.
 *
 * The view can be re-pointed at a different buffer with `setBuffer`,
 * which is how switching between buffers works.
 *
 * This module is only meaningful in a browser/Electron renderer
 * context. The pure projection, keymap and command logic it builds on
 * lives in sibling modules and is tested without a DOM.
 */

import { toLines, selectionRects } from './projection.js';
import { handleKeyEvent } from './commands.js';
import { keyEventToString } from './keymap.js';

/**
 * @typedef {object} EditorView
 * @property {HTMLElement} element - The view's root element.
 * @property {(buffer: object) => void} setBuffer - Re-point the view
 *   at a different buffer.
 * @property {() => void} focus - Give the editor keyboard focus.
 * @property {() => void} destroy - Unsubscribe and remove the view.
 */

/**
 * Mount an editor view for a buffer inside a container element.
 *
 * @param {import('@editor/buffer').Buffer} buffer - The initial buffer.
 * @param {HTMLElement} container - The element to mount into.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Key dispatcher.
 *   Receives a normalised key string (see `keyEventToString`) and
 *   returns whether the key was handled. When given, it replaces the
 *   renderer's own built-in keymap — this is how the editor's real,
 *   Lisp-defined keymap takes over.
 * @returns {EditorView}
 */
export function createEditorView(buffer, container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? globalThis;

  // The buffer currently shown; swapped by setBuffer.
  let activeBuffer = buffer;

  const root = el('div', 'editor');
  root.tabIndex = 0;

  const content = el('div', 'editor-content');
  const selectionLayer = el('div', 'editor-selection');
  const linesEl = el('div', 'editor-lines');
  const cursorEl = el('div', 'editor-cursor');
  content.append(selectionLayer, linesEl, cursorEl);
  root.append(content);
  container.append(root);

  /** Create an element with a class name. */
  function el(tag, className) {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  }

  /** Render the buffer's lines. */
  function renderLines() {
    const lines = toLines(activeBuffer.text);
    linesEl.replaceChildren(
      ...lines.map((line) => {
        const lineEl = el('div', 'editor-line');
        lineEl.textContent = line.content;
        return lineEl;
      })
    );
  }

  /** Render the selection highlight, one rectangle per touched line. */
  function renderSelection() {
    const rects = selectionRects(activeBuffer);
    selectionLayer.replaceChildren(
      ...rects.map((rect) => {
        const span = rect.toColumn - rect.fromColumn;
        const box = el('div', 'editor-selection-rect');
        box.style.left = `calc(${rect.fromColumn} * 1ch)`;
        box.style.top = `calc(${rect.line} * 1lh)`;
        // A selection that runs past this line shows its newline as a
        // sliver of trailing highlight.
        box.style.width = rect.toLineEnd
          ? `calc(${span} * 1ch + 0.5ch)`
          : `calc(${span} * 1ch)`;
        return box;
      })
    );
  }

  /** Position the cursor at the buffer's point. */
  function renderCursor() {
    const { line, column } = activeBuffer.positionAt(activeBuffer.point);
    cursorEl.style.left = `calc(${column} * 1ch)`;
    cursorEl.style.top = `calc(${line} * 1lh)`;
    // Restart the blink so the cursor is solid right after it moves.
    cursorEl.classList.remove('is-blinking');
    void cursorEl.offsetWidth;
    cursorEl.classList.add('is-blinking');
  }

  let dirty = false;
  let frame = 0;

  /** Render everything once; called on an animation frame. */
  function render() {
    dirty = false;
    frame = 0;
    renderLines();
    renderSelection();
    renderCursor();
    cursorEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Mark the view dirty and ensure a render is scheduled. */
  function schedule() {
    if (dirty) return;
    dirty = true;
    frame = win.requestAnimationFrame(render);
  }

  let unsubscribe = activeBuffer.onChange(schedule);

  // Key handling: use the host's dispatcher when given (the editor's
  // Lisp keymap), otherwise fall back to the renderer's built-in keymap
  // so the view stays usable on its own.
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  root.addEventListener('keydown', (event) => {
    const handled = onKey
      ? onKey(keyEventToString(event))
      : handleKeyEvent(activeBuffer, event);
    if (handled) event.preventDefault();
  });
  root.addEventListener('mousedown', () => root.focus());

  render();
  root.focus();

  return {
    element: root,

    setBuffer(next) {
      if (next === activeBuffer) return;
      unsubscribe();
      activeBuffer = next;
      unsubscribe = activeBuffer.onChange(schedule);
      render();
    },

    focus: () => root.focus(),

    destroy: () => {
      unsubscribe();
      if (frame) win.cancelAnimationFrame(frame);
      root.remove();
    },
  };
}
