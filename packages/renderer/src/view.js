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
import { foldRanges, indexFoldRanges, hiddenLines } from './folding.js';

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
 * @param {Record<string, (text: string) =>
 *   import('./folding.js').FoldCapture[]>} [options.foldCaptures] -
 *   Tree-sitter fold-capture extractors, keyed by language. A language
 *   without an entry has no fold support.
 * @param {boolean} [options.colourSwatches=true] - Whether to decorate
 *   colour literals in the text with clickable inline swatches.
 * @param {() => number} [options.getPoint] - Per-view-point: where to
 *   read the cursor offset from. Defaults to `() => activeBuffer.point`
 *   so renderer unit tests that pass a bare buffer keep working. The
 *   desktop app passes a closure that reads the *view*'s point, so
 *   two panes over one buffer each render their own cursor.
 * @param {() => number | null} [options.getMark] - The matching reader
 *   for the selection anchor.
 * @returns {EditorView}
 */
export function createEditorView(buffer, container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? globalThis;

  // The buffer currently shown; swapped by setBuffer.
  let activeBuffer = buffer;

  // Per-view-point: where the cursor lives. By default the cursor is
  // read off the buffer (the buffer in turn delegates to whatever it
  // is bindCursor'd to — typically the focused view), preserving the
  // renderer's unit-test contract. The desktop app overrides these to
  // read from the View bound to this editor instance, so a non-focused
  // pane's renderer still draws *its* cursor, not the focused pane's.
  const getPoint =
    typeof options.getPoint === 'function'
      ? options.getPoint
      : () => activeBuffer.point;
  const getMark =
    typeof options.getMark === 'function'
      ? options.getMark
      : () => activeBuffer.mark;

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

  const foldCapturesByLanguage =
    options.foldCaptures && typeof options.foldCaptures === 'object'
      ? options.foldCaptures
      : {};

  /**
   * Per-buffer fold state: maps a buffer object to the set of
   * `startLine` numbers that are currently folded. A WeakMap so the
   * state evaporates when a buffer is dropped (kill-buffer).
   *
   * @type {WeakMap<object, Set<number>>}
   */
  const foldedByBuffer = new WeakMap();

  /** Get (or lazily create) the folded-start-line set for the given buffer. */
  function foldsFor(buffer) {
    let set = foldedByBuffer.get(buffer);
    if (!set) {
      set = new Set();
      foldedByBuffer.set(buffer, set);
    }
    return set;
  }

  // Cached fold-range index for the current buffer text — `{ headers,
  // endByStart }`. Recomputed when the text or language changes; a
  // scroll-only render reuses it.
  let foldCacheText = null;
  let foldCacheLanguage = null;
  /** @type {{ headers: Set<number>, endByStart: Map<number, number> }} */
  let foldCache = { headers: new Set(), endByStart: new Map() };

  /** Recompute and cache the fold index for the current buffer text. */
  function refreshFoldIndex() {
    const text = activeBuffer.text;
    const language = languageForName(activeBuffer.name);
    if (text === foldCacheText && language === foldCacheLanguage) {
      return foldCache;
    }
    const extractor = foldCapturesByLanguage[language];
    if (typeof extractor === 'function') {
      try {
        foldCache = indexFoldRanges(foldRanges(text, extractor(text)));
      } catch {
        foldCache = { headers: new Set(), endByStart: new Map() };
      }
    } else {
      foldCache = { headers: new Set(), endByStart: new Map() };
    }
    foldCacheText = text;
    foldCacheLanguage = language;
    return foldCache;
  }

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

  // The "display row" for each buffer line — i.e. its visible row index
  // after hidden (folded-away) lines collapse. `displayRowForLine[L]`
  // is the row number to position line L at, or `-1` if it is currently
  // hidden. `displayRowCount` is the number of rows actually shown.
  // Rebuilt each render.
  /** @type {Int32Array | null} */
  let displayRowForLine = null;
  let displayRowCount = 0;
  /** Translate a buffer line number to its visible row (or hidden). */
  function rowOf(line) {
    if (!displayRowForLine || line < 0 || line >= displayRowForLine.length) {
      return line;
    }
    return displayRowForLine[line];
  }

  /**
   * Render the gutter and only the lines visible in the viewport.
   *
   * The content and gutter are sized to the whole document so the
   * scrollbar is correct, but only a window of line and line-number
   * elements — those on screen, plus a little overscan — is in the DOM.
   * Each is absolutely positioned at its true line offset.
   *
   * Code folding: hidden lines (those strictly between a folded
   * header's `startLine` and its `endLine`) collapse out — the next
   * visible line takes the slot vacated by them, so the document
   * shrinks while folded. Headers carry a `…` glyph and the gutter
   * shows a click target (▾ / ▸) for foldable lines.
   */
  function renderLines() {
    const lineHeight = cursorEl.getBoundingClientRect().height || 22;
    const language = languageForName(activeBuffer.name);
    const lines = toLines(activeBuffer.text);
    const lineCount = lines.length;

    // Compute which lines are hidden by the current fold state, and
    // build the buffer-line -> display-row map.
    refreshFoldIndex();
    const folded = foldsFor(activeBuffer);
    // Drop folded entries that no longer name a foldable header (the
    // text changed under them).
    for (const start of folded) {
      if (!foldCache.endByStart.has(start)) folded.delete(start);
    }
    const hidden = hiddenLines(folded, foldCache.endByStart);
    displayRowForLine = new Int32Array(lineCount);
    let row = 0;
    for (let i = 0; i < lineCount; i += 1) {
      if (hidden.has(i)) {
        displayRowForLine[i] = -1;
      } else {
        displayRowForLine[i] = row;
        row += 1;
      }
    }
    displayRowCount = row;

    content.style.height = `calc(${displayRowCount} * 1lh)`;
    gutter.style.height = `calc(${displayRowCount} * 1lh)`;
    gutter.style.width = `calc(${String(lineCount).length}ch + 48px)`;

    // The visible window in display-row coordinates, with a few lines
    // of overscan each side. `firstRow`/`lastRow` are display rows.
    const overscan = 6;
    const top = root.scrollTop;
    const viewport = root.clientHeight || lineHeight;
    const firstRow = Math.max(0, Math.floor(top / lineHeight) - overscan);
    const lastRow = Math.min(
      displayRowCount,
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

    // Walk every line so we can keep `lineStartOffset` accurate; skip
    // hidden lines and only emit DOM for lines whose display row is in
    // the viewport window.
    const lineEls = [];
    const numberEls = [];
    let lineStartOffset = 0;
    for (let index = 0; index < lineCount; index += 1) {
      const displayRow = displayRowForLine[index];
      if (displayRow !== -1 && displayRow >= firstRow && displayRow < lastRow) {
        const lineEl = el('div', 'editor-line');
        lineEl.style.top = `calc(${displayRow} * 1lh)`;
        const runs = perLine
          ? perLine[index] ?? []
          : highlightLine(lines[index].content, language);
        renderRuns(lineEl, runs);
        // Folded header: tack a `…` glyph on the end of the line so the
        // user can see at a glance that content is hidden here.
        if (folded.has(index)) {
          const ellipsis = el('span', 'editor-fold-ellipsis');
          ellipsis.textContent = ' …';
          lineEl.append(ellipsis);
        }
        if (colourSwatches) {
          colourSwatches.decorateLine(
            lineEl,
            lines[index].content,
            lineStartOffset
          );
        }
        lineEls.push(lineEl);

        const numberEl = el('div', 'editor-line-no');
        numberEl.style.top = `calc(${displayRow} * 1lh)`;
        numberEl.dataset.line = String(index);
        // Fold marker, when this line is foldable.
        if (foldCache.headers.has(index)) {
          const marker = el('button', 'editor-fold-marker');
          marker.type = 'button';
          marker.dataset.line = String(index);
          marker.textContent = folded.has(index) ? '▸' : '▾';
          marker.title = folded.has(index) ? 'Unfold' : 'Fold';
          marker.addEventListener('mousedown', (ev) => {
            // Don't let the click bubble to the editor-area mousedown
            // (which would place the cursor and start a drag).
            ev.preventDefault();
            ev.stopPropagation();
            toggleFoldAt(index);
          });
          numberEl.append(marker);
        }
        const num = doc.createElement('span');
        num.className = 'editor-line-no-num';
        num.textContent = String(index + 1);
        numberEl.append(num);
        numberEls.push(numberEl);
      }
      lineStartOffset += lines[index].content.length + 1;
    }
    linesEl.replaceChildren(...lineEls);
    gutter.replaceChildren(...numberEls);
  }

  /** Render the selection highlight, one rectangle per touched line. */
  function renderSelection() {
    const rects = selectionRects(activeBuffer, getPoint(), getMark());
    selectionLayer.replaceChildren(
      ...rects
        .map((rect) => {
          const row = rowOf(rect.line);
          if (row === -1) return null;
          const span = rect.toColumn - rect.fromColumn;
          const box = el('div', 'editor-selection-rect');
          box.style.left = `calc(${rect.fromColumn} * 1ch)`;
          box.style.top = `calc(${row} * 1lh)`;
          // A selection that runs past this line shows its newline as a
          // sliver of trailing highlight.
          box.style.width = rect.toLineEnd
            ? `calc(${span} * 1ch + 0.5ch)`
            : `calc(${span} * 1ch)`;
          return box;
        })
        .filter((b) => b !== null)
    );
  }

  /** Outline the bracket pair around the cursor, if any. */
  function renderBrackets() {
    const match = matchingBracket(
      activeBuffer.text,
      getPoint(),
      languageForName(activeBuffer.name)
    );
    if (match === null) {
      bracketLayer.replaceChildren();
      return;
    }
    bracketLayer.replaceChildren(
      ...[match.a, match.b]
        .map((at) => {
          const { line, column } = activeBuffer.positionAt(at);
          const row = rowOf(line);
          if (row === -1) return null;
          const box = el('div', 'editor-bracket');
          box.style.left = `calc(${column} * 1ch)`;
          box.style.top = `calc(${row} * 1lh)`;
          return box;
        })
        .filter((b) => b !== null)
    );
  }

  /** Position the cursor, the current-line highlight and the gutter. */
  function renderCursor() {
    const { line, column } = activeBuffer.positionAt(getPoint());
    // If the cursor lands inside a folded region, hop it up to the
    // header line — the user shouldn't be able to "see" the cursor
    // sitting on a hidden line. Visually we still draw it at the
    // header's row, in the column the cursor would have on its real
    // line.
    const row = rowOf(line);
    const displayRow = row === -1 ? rowOf(findVisibleAncestorLine(line)) : row;
    cursorEl.style.left = `calc(${column} * 1ch)`;
    cursorEl.style.top = `calc(${displayRow} * 1lh)`;
    currentLineEl.style.top = `calc(${displayRow} * 1lh)`;

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
    const row = Math.max(0, Math.floor((clientY - box.top) / lineHeight));
    const line = lineForDisplayRow(row);
    const column = Math.max(0, Math.round((clientX - box.left) / charWidth()));
    return activeBuffer.offsetAt(line, column);
  }

  /**
   * Translate a display row back to a buffer line number. With no
   * folding the two coincide. Hidden lines collapse, so a display row
   * can map to any of several possible buffer lines — pick the first
   * (the lowest-numbered) visible line at that row.
   */
  function lineForDisplayRow(row) {
    if (!displayRowForLine) {
      return Math.min(activeBuffer.lineCount - 1, Math.max(0, row));
    }
    const clamped = Math.max(0, Math.min(displayRowCount - 1, row));
    for (let i = 0; i < displayRowForLine.length; i += 1) {
      if (displayRowForLine[i] === clamped) return i;
    }
    return Math.max(0, activeBuffer.lineCount - 1);
  }

  /**
   * Walk up from a hidden line to its enclosing folded header — the
   * one visible ancestor. Used to keep the cursor display sensible
   * when point lands inside a fold (the buffer doesn't know about
   * folds; only the view does).
   */
  function findVisibleAncestorLine(line) {
    if (!displayRowForLine || displayRowForLine[line] !== -1) return line;
    const folded = foldsFor(activeBuffer);
    let best = line;
    for (const start of folded) {
      const end = foldCache.endByStart.get(start);
      if (end === undefined) continue;
      if (line > start && line <= end && start < best) best = start;
    }
    return best;
  }

  // --- folding controls -------------------------------------------------
  // The view owns the per-buffer fold state. The host's Lisp keymap
  // routes the `C-c TAB` / `C-c C-,` / `C-c C-.` commands through
  // `toggleFoldAtPoint` / `foldAll` / `unfoldAll`.

  /** Toggle the fold at the header that contains buffer line `line`. */
  function toggleFoldAt(line) {
    refreshFoldIndex();
    const folded = foldsFor(activeBuffer);
    if (folded.has(line)) {
      folded.delete(line);
      schedule();
      return true;
    }
    if (foldCache.headers.has(line)) {
      folded.add(line);
      schedule();
      return true;
    }
    return false;
  }

  /** Toggle the fold whose header straddles the cursor (the nearest
   *  preceding header inside whose range the cursor sits, or the
   *  header on point's own line). */
  function toggleFoldAtPoint() {
    refreshFoldIndex();
    const { line } = activeBuffer.positionAt(getPoint());
    // If point is *on* a header line, that wins.
    if (foldCache.headers.has(line)) return toggleFoldAt(line);
    // Otherwise, find the smallest enclosing foldable scope.
    let bestStart = -1;
    let bestSpan = Infinity;
    for (const [start, end] of foldCache.endByStart) {
      if (line > start && line <= end) {
        const span = end - start;
        if (span < bestSpan) {
          bestStart = start;
          bestSpan = span;
        }
      }
    }
    if (bestStart >= 0) return toggleFoldAt(bestStart);
    return false;
  }

  /** Fold every foldable scope in the current buffer. */
  function foldAll() {
    refreshFoldIndex();
    const folded = foldsFor(activeBuffer);
    let changed = false;
    for (const start of foldCache.headers) {
      if (!folded.has(start)) {
        folded.add(start);
        changed = true;
      }
    }
    if (changed) schedule();
    return changed;
  }

  /** Unfold every fold in the current buffer. */
  function unfoldAll() {
    const folded = foldsFor(activeBuffer);
    if (folded.size === 0) return false;
    folded.clear();
    schedule();
    return true;
  }

  /** Count the lines visible right now (after folding). For tests. */
  function visibleLineCount() {
    return displayRowCount;
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

    /** The buffer offset for a viewport pixel position. Exposed so
     *  the hover-doc tooltip can resolve a mouse coordinate. */
    offsetFromPoint,

    // --- folding ------------------------------------------------------
    /** Toggle the fold whose header contains the cursor. */
    toggleFoldAtPoint,
    /** Toggle the fold at a specific buffer line. */
    toggleFoldAt,
    /** Fold every foldable scope in the current buffer. */
    foldAll,
    /** Unfold every fold in the current buffer. */
    unfoldAll,
    /** Number of lines actually visible (collapsed by folds). For tests. */
    visibleLineCount,

    setBuffer(next) {
      if (next !== activeBuffer) {
        unsubscribe();
        activeBuffer = next;
        unsubscribe = activeBuffer.onChange(scheduleFollowingCursor);
      }
      // Always render, even when the buffer is unchanged: switchToBuffer
      // calls setBuffer when the view is mounted again after a hidden
      // spell, and any render that fired while the view was hidden
      // produced a 0-height layout (the gutter and only ~7 lines of
      // overscan). The reveal pass redraws against the real viewport.
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
