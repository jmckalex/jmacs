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
import { highlightLine, languageForName } from './highlight.js';
import { matchingBracket } from './brackets.js';

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
 * @param {(text: string) => import('./highlight.js').Run[][]}
 *   [options.highlightJavaScript] - A whole-buffer JavaScript
 *   highlighter (tree-sitter). When absent, JavaScript falls back to
 *   the line-based tokenizer.
 * @returns {EditorView}
 */
export function createEditorView(buffer, container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? globalThis;

  // The buffer currently shown; swapped by setBuffer.
  let activeBuffer = buffer;

  const highlightJavaScript =
    typeof options.highlightJavaScript === 'function'
      ? options.highlightJavaScript
      : null;

  const root = el('div', 'editor');
  root.tabIndex = 0;

  const gutter = el('div', 'editor-gutter');
  const content = el('div', 'editor-content');
  const currentLineEl = el('div', 'editor-current-line');
  const selectionLayer = el('div', 'editor-selection');
  const bracketLayer = el('div', 'editor-brackets');
  const linesEl = el('div', 'editor-lines');
  const cursorEl = el('div', 'editor-cursor');
  content.append(currentLineEl, selectionLayer, bracketLayer, linesEl, cursorEl);
  root.append(gutter, content);
  container.append(root);

  /** Create an element with a class name. */
  function el(tag, className) {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  }

  /** Fill a line element with its highlighted runs. */
  function renderRuns(lineEl, runs) {
    if (runs.length === 1 && runs[0].face === null) {
      lineEl.textContent = runs[0].text;
      return;
    }
    for (const run of runs) {
      if (run.face === null) {
        lineEl.append(doc.createTextNode(run.text));
      } else {
        const span = el('span', `tok-${run.face}`);
        span.textContent = run.text;
        lineEl.append(span);
      }
    }
  }

  /** Render the buffer's lines, syntax-highlighted by run. */
  function renderLines() {
    const language = languageForName(activeBuffer.name);
    const lines = toLines(activeBuffer.text);

    // JavaScript uses the tree-sitter highlighter when one was given;
    // it parses the whole buffer at once. Everything else is line-based.
    let perLine = null;
    if (language === 'javascript' && highlightJavaScript) {
      try {
        perLine = highlightJavaScript(activeBuffer.text);
      } catch {
        perLine = null;
      }
    }

    const lineEls = [];
    const numberEls = [];
    lines.forEach((line, index) => {
      const lineEl = el('div', 'editor-line');
      const runs = perLine
        ? perLine[index] ?? []
        : highlightLine(line.content, language);
      renderRuns(lineEl, runs);
      lineEls.push(lineEl);

      const numberEl = el('div', 'editor-line-no');
      numberEl.textContent = String(index + 1);
      numberEls.push(numberEl);
    });
    linesEl.replaceChildren(...lineEls);
    gutter.replaceChildren(...numberEls);
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

  /** Outline the bracket pair around the cursor, if any. */
  function renderBrackets() {
    const match = matchingBracket(
      activeBuffer.text,
      activeBuffer.point,
      languageForName(activeBuffer.name)
    );
    if (match === null) {
      bracketLayer.replaceChildren();
      return;
    }
    bracketLayer.replaceChildren(
      ...[match.a, match.b].map((at) => {
        const { line, column } = activeBuffer.positionAt(at);
        const box = el('div', 'editor-bracket');
        box.style.left = `calc(${column} * 1ch)`;
        box.style.top = `calc(${line} * 1lh)`;
        return box;
      })
    );
  }

  /** Position the cursor, the current-line highlight and the gutter. */
  function renderCursor() {
    const { line, column } = activeBuffer.positionAt(activeBuffer.point);
    cursorEl.style.left = `calc(${column} * 1ch)`;
    cursorEl.style.top = `calc(${line} * 1lh)`;
    currentLineEl.style.top = `calc(${line} * 1lh)`;

    // Brighten the current line's number in the gutter.
    const numbers = gutter.children;
    for (let i = 0; i < numbers.length; i += 1) {
      numbers[i].classList.toggle('is-current', i === line);
    }

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
    renderBrackets();
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
  // Mouse: click to place the cursor, drag to select. A pixel point is
  // mapped to a buffer offset via the browser's own caret hit-testing.
  function offsetFromPoint(clientX, clientY) {
    if (typeof doc.caretRangeFromPoint !== 'function') return null;
    const range = doc.caretRangeFromPoint(clientX, clientY);
    if (range === null) return null;

    const node = range.startContainer;
    let lineEl = node.nodeType === 3 ? node.parentNode : node;
    while (
      lineEl &&
      lineEl !== linesEl &&
      !(lineEl.classList && lineEl.classList.contains('editor-line'))
    ) {
      lineEl = lineEl.parentNode;
    }
    if (!lineEl || !lineEl.classList?.contains('editor-line')) return null;

    const lineIndex = Array.prototype.indexOf.call(linesEl.children, lineEl);
    if (lineIndex < 0) return null;

    // Column: the text in the line before the clicked node, plus its
    // offset within that node.
    let column = range.startOffset;
    if (node.nodeType === 3) {
      column = 0;
      const walker = doc.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
        if (t === node) {
          column += range.startOffset;
          break;
        }
        column += t.textContent.length;
      }
    }
    return activeBuffer.offsetAt(lineIndex, column);
  }

  function onMouseMove(event) {
    const offset = offsetFromPoint(event.clientX, event.clientY);
    if (offset !== null) activeBuffer.moveTo(offset, { extend: true });
  }
  function endDrag() {
    doc.removeEventListener('mousemove', onMouseMove);
    doc.removeEventListener('mouseup', endDrag);
  }
  root.addEventListener('mousedown', (event) => {
    root.focus();
    if (event.button !== 0) return;
    const offset = offsetFromPoint(event.clientX, event.clientY);
    if (offset === null) return;
    activeBuffer.moveTo(offset);
    doc.addEventListener('mousemove', onMouseMove);
    doc.addEventListener('mouseup', endDrag);
    event.preventDefault();
  });

  render();
  root.focus();

  return {
    element: root,

    /** Scroll so the cursor's line sits in the middle of the viewport. */
    recenter() {
      cursorEl.scrollIntoView({ block: 'center', inline: 'nearest' });
    },

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
      endDrag();
      if (frame) win.cancelAnimationFrame(frame);
      root.remove();
    },
  };
}
