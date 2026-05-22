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

/** Keys that are only modifiers — never a keystroke on their own. */
const MODIFIER_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph',
]);

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
 * @param {Record<string, (text: string) =>
 *   import('./highlight.js').Run[][]>} [options.highlighters] - Whole-
 *   buffer tree-sitter highlighters, keyed by language. A language with
 *   no entry falls back to the line-based tokenizer.
 * @returns {EditorView}
 */
export function createEditorView(buffer, container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? globalThis;

  // The buffer currently shown; swapped by setBuffer.
  let activeBuffer = buffer;

  const highlighters =
    options.highlighters && typeof options.highlighters === 'object'
      ? options.highlighters
      : {};

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

  // The whole-buffer tree-sitter highlight is cached, so a scroll-only
  // render (the text unchanged) does not re-parse the buffer.
  let highlightCacheText = null;
  let highlightCacheLanguage = null;
  let highlightCache = null;

  /**
   * Render the gutter and only the lines visible in the viewport.
   *
   * The content and gutter are sized to the whole document so the
   * scrollbar is correct, but only a window of line and line-number
   * elements — those on screen, plus a little overscan — is in the DOM.
   * Each is absolutely positioned at its true line offset.
   */
  function renderLines() {
    const lineHeight = cursorEl.getBoundingClientRect().height || 22;
    const language = languageForName(activeBuffer.name);
    const lines = toLines(activeBuffer.text);
    const lineCount = lines.length;

    content.style.height = `calc(${lineCount} * 1lh)`;
    gutter.style.height = `calc(${lineCount} * 1lh)`;
    gutter.style.width = `calc(${String(lineCount).length}ch + 32px)`;

    // The visible window, with a few lines of overscan each side.
    const overscan = 6;
    const top = root.scrollTop;
    const viewport = root.clientHeight || lineHeight;
    const first = Math.max(0, Math.floor(top / lineHeight) - overscan);
    const last = Math.min(
      lineCount,
      Math.ceil((top + viewport) / lineHeight) + overscan
    );

    // A language with a tree-sitter highlighter is parsed whole; the
    // rest are line-based. The whole-buffer parse is cached across
    // scroll-only renders.
    let perLine = null;
    const treeSitter = highlighters[language];
    if (treeSitter) {
      const text = activeBuffer.text;
      if (text === highlightCacheText && language === highlightCacheLanguage) {
        perLine = highlightCache;
      } else {
        try {
          perLine = treeSitter(text);
        } catch {
          perLine = null;
        }
        highlightCacheText = text;
        highlightCacheLanguage = language;
        highlightCache = perLine;
      }
    }

    const lineEls = [];
    const numberEls = [];
    for (let index = first; index < last; index += 1) {
      const lineEl = el('div', 'editor-line');
      lineEl.style.top = `calc(${index} * 1lh)`;
      const runs = perLine
        ? perLine[index] ?? []
        : highlightLine(lines[index].content, language);
      renderRuns(lineEl, runs);
      lineEls.push(lineEl);

      const numberEl = el('div', 'editor-line-no');
      numberEl.style.top = `calc(${index} * 1lh)`;
      numberEl.dataset.line = String(index);
      numberEl.textContent = String(index + 1);
      numberEls.push(numberEl);
    }
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

    // Brighten the current line's number in the gutter. Only the
    // visible numbers are present, so match on the line each carries.
    for (const numberEl of gutter.children) {
      numberEl.classList.toggle(
        'is-current',
        Number(numberEl.dataset.line) === line
      );
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
    // A bare modifier press (Shift, Control, …) is not a key in its own
    // right — dispatching it would, e.g., feed "S-shift" to a pending
    // key reader. Wait for the real key.
    if (MODIFIER_KEYS.has(event.key)) return;
    const handled = onKey
      ? onKey(keyEventToString(event))
      : handleKeyEvent(activeBuffer, event);
    if (handled) event.preventDefault();
  });

  // Scrolling changes which lines are visible — re-render the window.
  root.addEventListener('scroll', schedule);
  // Mouse: click to place the cursor, drag to select.
  //
  // A click on rendered text is mapped precisely by the browser's caret
  // hit-testing. A click on an empty line, or past the end of a line's
  // text, lands on no text node — there it falls back to the monospace
  // grid geometry.
  function offsetFromPoint(clientX, clientY) {
    if (typeof doc.caretRangeFromPoint === 'function') {
      const range = doc.caretRangeFromPoint(clientX, clientY);
      if (range !== null && range.startContainer.nodeType === 3) {
        const offset = offsetFromTextNode(range.startContainer, range.startOffset);
        if (offset !== null) return offset;
      }
    }
    return offsetFromGeometry(clientX, clientY);
  }

  /** A clicked text node and offset within it → a buffer offset. */
  function offsetFromTextNode(node, nodeOffset) {
    let lineEl = node.parentNode;
    while (lineEl && !lineEl.classList?.contains('editor-line')) {
      lineEl = lineEl.parentNode;
    }
    if (!lineEl) return null;
    const lineIndex = Array.prototype.indexOf.call(linesEl.children, lineEl);
    if (lineIndex < 0) return null;

    // Column: the text in the line before the clicked node, plus its
    // offset within that node.
    let column = 0;
    const walker = doc.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
      if (t === node) {
        column += nodeOffset;
        break;
      }
      column += t.textContent.length;
    }
    return activeBuffer.offsetAt(lineIndex, column);
  }

  /** A pixel point → a buffer offset via the monospace grid. */
  function offsetFromGeometry(clientX, clientY) {
    const box = content.getBoundingClientRect();
    const lineHeight = cursorEl.getBoundingClientRect().height || 22;
    const line = Math.min(
      activeBuffer.lineCount - 1,
      Math.max(0, Math.floor((clientY - box.top) / lineHeight))
    );
    const column = Math.max(0, Math.round((clientX - box.left) / charWidth()));
    return activeBuffer.offsetAt(line, column);
  }

  /** The pixel width of one character, measured from a rendered line. */
  function charWidth() {
    for (const lineEl of linesEl.children) {
      const length = lineEl.textContent.length;
      if (length > 0) return lineEl.getBoundingClientRect().width / length;
    }
    return (cursorEl.getBoundingClientRect().height || 22) * 0.6;
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

  // Double-click selects the word under the pointer.
  root.addEventListener('dblclick', (event) => {
    const offset = offsetFromPoint(event.clientX, event.clientY);
    if (offset === null) return;
    const text = activeBuffer.text;
    const isWord = (ch) => ch !== undefined && /\w/.test(ch);
    let start = offset;
    let end = offset;
    while (start > 0 && isWord(text[start - 1])) start -= 1;
    while (end < text.length && isWord(text[end])) end += 1;
    if (end > start) {
      activeBuffer.moveTo(start);
      activeBuffer.moveTo(end, { extend: true });
    }
  });

  render();
  root.focus();

  return {
    element: root,

    /** Scroll so the cursor's line sits in the middle of the viewport. */
    recenter() {
      cursorEl.scrollIntoView({ block: 'center', inline: 'nearest' });
    },

    /** Roughly how many lines fit in the viewport — used for paging. */
    pageLines() {
      const lineHeight = cursorEl.getBoundingClientRect().height || 22;
      return Math.max(1, Math.floor(root.clientHeight / lineHeight) - 1);
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
