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
import { highlightBuffer, highlightLine, languageForName } from './highlight.js';
import { matchingBracket } from './brackets.js';
import { createColourSwatches } from './colour-swatches.js';

/** Keys that are only modifiers — never a keystroke on their own. */
const MODIFIER_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph',
]);

/**
 * @typedef {object} EditorView
 * @property {HTMLElement} element - The view's root element.
 * @property {HTMLElement} backgroundLayer - An empty layer behind the
 *   text, in the text's coordinate space; the host fills it.
 * @property {HTMLElement} overlayLayer - An empty layer in front of the
 *   text, in the text's coordinate space; the host fills it.
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
 * @param {boolean} [options.colourSwatches=true] - Whether to decorate
 *   colour literals in the text with clickable inline swatches.
 * @returns {EditorView}
 */
export function createEditorView(buffer, container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? globalThis;

  // The buffer currently shown; swapped by setBuffer.
  let activeBuffer = buffer;

  // The colour-swatch decorator: places a clickable swatch beside every
  // colour literal in a rendered line, and edits the buffer when a
  // swatch's modal is confirmed. It reads the current buffer through
  // the closure, so a setBuffer swap needs no rewiring. On by default;
  // pass `colourSwatches: false` to disable it.
  const colourSwatches =
    options.colourSwatches === false
      ? null
      : createColourSwatches({ doc, getBuffer: () => activeBuffer });

  const highlighters =
    options.highlighters && typeof options.highlighters === 'object'
      ? options.highlighters
      : {};

  const root = el('div', 'editor');
  root.tabIndex = 0;

  const gutter = el('div', 'editor-gutter');
  const content = el('div', 'editor-content');
  // Empty layers for the host to fill — backgroundLayer sits behind the
  // text, overlayLayer in front of it. Both share the text's ch/lh
  // coordinate space and span the whole document.
  const backgroundLayer = el('div', 'editor-background');
  const currentLineEl = el('div', 'editor-current-line');
  const selectionLayer = el('div', 'editor-selection');
  const bracketLayer = el('div', 'editor-brackets');
  const linesEl = el('div', 'editor-lines');
  const cursorEl = el('div', 'editor-cursor');
  const overlayLayer = el('div', 'editor-overlay');
  content.append(
    backgroundLayer,
    currentLineEl,
    selectionLayer,
    bracketLayer,
    linesEl,
    cursorEl,
    overlayLayer
  );
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

    // A language with a tree-sitter highlighter is parsed whole; a
    // language with a built-in whole-buffer tokenizer (LaTeX,
    // Makefile — multi-line constructs need to see across line
    // breaks) goes through `highlightBuffer`; the rest are
    // line-based. The whole-buffer parse is cached across
    // scroll-only renders.
    let perLine = null;
    const treeSitter = highlighters[language];
    const text = activeBuffer.text;
    if (treeSitter) {
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
    } else if (
      text === highlightCacheText &&
      language === highlightCacheLanguage &&
      highlightCache !== null
    ) {
      perLine = highlightCache;
    } else {
      const whole = highlightBuffer(text, language);
      if (whole !== null) {
        perLine = whole;
        highlightCacheText = text;
        highlightCacheLanguage = language;
        highlightCache = perLine;
      }
    }

    // The buffer offset each visible line starts at — its index into
    // `lines` plus the lengths and newlines of every line before it.
    // Only computed up to `first`, the first visible line; `first` can
    // exceed the line count after a switch to a shorter buffer, so the
    // sum is clamped to the lines that actually exist.
    let lineStartOffset = 0;
    for (let index = 0; index < first && index < lineCount; index += 1) {
      lineStartOffset += lines[index].content.length + 1;
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
      // Place any inline decorations (colour swatches) on the line.
      if (colourSwatches) {
        colourSwatches.decorateLine(
          lineEl,
          lines[index].content,
          lineStartOffset
        );
      }
      lineStartOffset += lines[index].content.length + 1;
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
  // A render keeps the cursor on screen only when it follows a buffer
  // event — the cursor may have moved. A render that follows a *scroll*
  // must not: pulling the cursor back into view would yank the viewport
  // back, so the user could never scroll past the cursor's line.
  let followCursor = false;

  /** Render everything once; called on an animation frame. */
  function render() {
    dirty = false;
    frame = 0;
    renderLines();
    renderSelection();
    renderBrackets();
    renderCursor();
    if (followCursor) {
      followCursor = false;
      cursorEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /** Mark the view dirty and ensure a render is scheduled. */
  function schedule() {
    if (dirty) return;
    dirty = true;
    frame = win.requestAnimationFrame(render);
  }

  /** Schedule a render that also keeps the cursor on screen. */
  function scheduleFollowingCursor() {
    followCursor = true;
    schedule();
  }

  let unsubscribe = activeBuffer.onChange(scheduleFollowingCursor);

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
  // A pixel point maps to a buffer offset directly through the
  // monospace grid — the line from the y, the column from the x. This
  // covers every case (mid-line, an empty line, past a line's end) and
  // needs no DOM hit-testing, so it stays fast whatever is drawn behind
  // the text.
  function offsetFromPoint(clientX, clientY) {
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
  /** Select the word straddling a buffer offset (a double-click). */
  function selectWordAt(offset) {
    const text = activeBuffer.text;
    const isWord = (ch) => ch !== undefined && /\w/.test(ch);
    let start = offset;
    let end = offset;
    while (start > 0 && isWord(text[start - 1])) start -= 1;
    while (end < text.length && isWord(text[end])) end += 1;
    if (end > start) {
      activeBuffer.moveTo(start);
      activeBuffer.moveTo(end, { extend: true });
    } else {
      activeBuffer.moveTo(offset);
    }
  }

  // Click to place the cursor; a double-click selects the word.
  //
  // The double-click is read from the mousedown's click count, not from
  // a dblclick event: the mousedown schedules a render that recreates
  // the line elements, detaching the element the press landed on, and
  // the browser then dispatches neither click nor dblclick. The click
  // count on mousedown is unaffected.
  root.addEventListener('mousedown', (event) => {
    root.focus();
    if (event.button !== 0) return;
    const offset = offsetFromPoint(event.clientX, event.clientY);
    if (offset === null) return;
    if (event.detail >= 2) {
      selectWordAt(offset);
    } else {
      activeBuffer.moveTo(offset);
    }
    doc.addEventListener('mousemove', onMouseMove);
    doc.addEventListener('mouseup', endDrag);
    event.preventDefault();
  });

  followCursor = true;
  render();
  root.focus();

  return {
    element: root,
    backgroundLayer,
    overlayLayer,

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
      unsubscribe = activeBuffer.onChange(scheduleFollowingCursor);
      followCursor = true;
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
