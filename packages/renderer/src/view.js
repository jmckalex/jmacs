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
 * The view can be re-pointed at a different View with `setView`,
 * which is how switching between views (and thus buffers) works.
 *
 * This module is only meaningful in a browser/Electron renderer
 * context. The pure projection, keymap and command logic it builds on
 * lives in sibling modules and is tested without a DOM.
 */

import {
  toLines, selectionRects, cursorPositions,
  visualColumn, charIndexAtVisualColumn,
} from './projection.js';
import { handleKeyEvent } from './commands.js';
import { keyEventToString } from './keymap.js';
import { highlightBuffer, highlightLine, languageForName } from './highlight.js';
import { matchingBracket } from './brackets.js';
import { createColourSwatches } from './colour-swatches.js';
import { foldRanges, indexFoldRanges, hiddenLines } from './folding.js';
import { computeMathLayout, spliceInlineWidgets } from './math-layout.js';

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
 * @property {(view: object) => void} setView - Re-point the view at a
 *   different (text) View. Read its `.buffer` for the L2 buffer.
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
 * @param {() => (string | null)} [options.getMajorModeName] - The active
 *   buffer's major-mode display name (e.g. `'LaTeX'`), read fresh each
 *   render. Threaded into the tree-sitter highlighter so mode-scoped user
 *   `kind -> face` override rules apply. Defaults to `() => null`.
 * @param {() => number} [options.getOverrideGeneration] - A counter the
 *   host bumps when the user's highlight override rules change. Folded
 *   into the highlight cache key so a live rule edit re-highlights even
 *   when the buffer text is unchanged. Defaults to `() => 0`.
 * @param {boolean} [options.colourSwatches=true] - Whether to decorate
 *   colour literals in the text with clickable inline swatches.
 * @param {() => number} [options.getPoint] - Per-view-point: where to
 *   read the cursor offset from. Defaults to `() => activeBuffer.point`
 *   so renderer unit tests that pass a bare buffer keep working. The
 *   desktop app passes a closure that reads the *view*'s point, so
 *   two panes over one buffer each render their own cursor.
 * @param {() => number | null} [options.getMark] - The matching reader
 *   for the selection anchor.
 * @param {() => Array<{point: number, mark: number | null}>}
 *   [options.getCursors] - Multi-cursor: the full cursor set the
 *   renderer should paint. Defaults to a single-element list built
 *   from `getPoint()` / `getMark()` (preserves the single-cursor
 *   contract for renderer unit tests). The desktop app passes
 *   `() => view.cursors` so secondary cursors get drawn alongside
 *   the primary.
 * @param {() => number} [options.getTabWidth] - The tab-width in
 *   columns. Read on every render so a live customise edit re-positions
 *   the cursor / selection rects in lockstep with the CSS tab-size
 *   variable. Defaults to `() => 4` (matches the CSS fallback and
 *   the `*tab-width*` defcustom default).
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
  // Multi-cursor: returns this view's full cursor set. When not supplied,
  // synthesise a single-cursor list from getPoint/getMark so the existing
  // single-cursor renderer path (renderer unit tests, hosts that haven't
  // wired multi-cursor yet) keeps working.
  const getCursors =
    typeof options.getCursors === 'function'
      ? options.getCursors
      : () => [{ point: getPoint(), mark: getMark() }];
  const getTabWidth =
    typeof options.getTabWidth === 'function'
      ? options.getTabWidth
      : () => 4;

  // Replaced-range widgets (math preview is the first consumer). A
  // function returning the current list of `{ start, end, kind, el }`
  // ranges, where `el()` returns the widget Node to mount. Read fresh
  // on every render so the controller can swap widgets (re-typeset on
  // edit) without rewiring. Defaults to none, so the existing
  // text-only render path is untouched.
  const getReplacedRanges =
    typeof options.getReplacedRanges === 'function'
      ? options.getReplacedRanges
      : () => [];

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

  // The buffer's major-mode display name, used to pick mode-scoped user
  // highlight override rules at highlight time. Read fresh on every
  // render so a major-mode change re-highlights with the right rules.
  // Defaults to null (no mode scoping) for renderer unit tests.
  const getMajorModeName =
    typeof options.getMajorModeName === 'function'
      ? options.getMajorModeName
      : () => null;

  // A monotonically-increasing counter the host bumps when the user's
  // highlight override rules change. Folded into the highlight cache key
  // so a rule edit forces a re-highlight even when the text is unchanged.
  // Defaults to a constant for hosts/tests with no override store.
  const getOverrideGeneration =
    typeof options.getOverrideGeneration === 'function'
      ? options.getOverrideGeneration
      : () => 0;

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

  /** Drop leading whitespace from a run list, keeping faces intact.
   *  Used when rendering the closing-line preview for a folded header:
   *  the line's leading indent isn't useful inline, but we want to
   *  preserve the highlighting of `</script>`, `}`, `)` etc. */
  function trimLeadingWhitespaceRuns(runs) {
    const out = [];
    let started = false;
    for (const run of runs) {
      if (started) { out.push(run); continue; }
      const trimmed = run.text.replace(/^\s+/, '');
      if (trimmed === '') continue;
      out.push({ text: trimmed, face: run.face });
      started = true;
    }
    return out;
  }

  /** Fill a line element with its highlighted runs. An item may be an
   *  ordinary `{ text, face }` run or a `{ widget }` marker (an inline
   *  replaced-range widget — a math SVG span); the widget's Node is
   *  appended in place of the source characters it covers. */
  function renderRuns(lineEl, runs) {
    if (runs.length === 1 && !runs[0].widget && runs[0].face === null) {
      lineEl.textContent = runs[0].text;
      return;
    }
    for (const run of runs) {
      if (run.widget) {
        // `run.widget` is the originating replaced-range (it carries
        // both the widget `el` factory and the segment offsets). Mount
        // an inline widget span; a falsy widget node degrades to
        // nothing (the reveal path avoids that case).
        const span = mountWidget(run.widget, false);
        if (span) lineEl.append(span);
      } else if (run.face === null) {
        lineEl.append(doc.createTextNode(run.text));
      } else {
        const span = el('span', `tok-${run.face}`);
        span.textContent = run.text;
        lineEl.append(span);
      }
    }
  }

  /**
   * Build the DOM element for a replaced-range widget (a typeset math
   * span/row). Calls the range's `el()` factory for the widget Node,
   * wraps it in a positioned span, and wires a click that reveals the
   * segment by placing point just inside the opening delimiter — the
   * click-to-segment mapping the spec asks for. Returns null when the
   * factory yields no node (an invalid/empty segment renders as source
   * instead, so it should never reach here, but degrade gracefully).
   *
   * @param {{ start: number, end: number, el?: () => Node }} range
   * @param {boolean} block - Block (own row) vs inline.
   * @returns {HTMLElement | null}
   */
  function mountWidget(range, block) {
    const node = typeof range.el === 'function' ? range.el() : range.el;
    if (!node) return null;
    const span = el(
      'span',
      block ? 'math-widget math-block' : 'math-widget math-inline'
    );
    span.append(node);
    // A mousedown on the widget reveals it: place point just inside the
    // opening delimiter (start + 1, strictly inside per the exclusive
    // rule) so the next render shows the source for editing. Stop the
    // event so the editor's own mousedown (grid-based offset) doesn't
    // also fire and land somewhere else.
    span.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      root.focus();
      const target = Math.min(range.start + 1, range.end - 1);
      activeBuffer.moveTo(target);
    });
    return span;
  }

  // The whole-buffer tree-sitter highlight is cached, so a scroll-only
  // render (the text unchanged) does not re-parse the buffer. The key
  // also tracks the major-mode name and the user-override generation so
  // a mode change or a live highlight-rule edit forces a re-parse.
  let highlightCacheText = null;
  let highlightCacheLanguage = null;
  let highlightCacheMode = null;
  let highlightCacheGen = null;
  let highlightCache = null;

  // The "display row" for each buffer line — i.e. its visible row index
  // after hidden (folded-away) lines collapse. `displayRowForLine[L]`
  // is the row number to position line L at, or `-1` if it is currently
  // hidden. `displayRowCount` is the number of rows actually shown.
  // Rebuilt each render.
  /** @type {Int32Array | null} */
  let displayRowForLine = null;
  let displayRowCount = 0;
  /** Visible lines that carry inline math widgets → each widget's source
   *  column span and mounted element. Lets the cursor / selection / click
   *  position by the widget's *measured* pixel width instead of its
   *  source-character count (a typeset `$…$` is usually narrower than its
   *  source, so a column past it would otherwise sit too far right).
   *  Rebuilt each render; only visible, widget-bearing lines appear. */
  let inlineWidgetsByLine = new Map();

  /** Measured display-row count per block-math widget, keyed by its
   *  content (the segment body). A block reserves the rows its source
   *  *spanned* on first sight, then this records how many rows its
   *  typeset height actually needs, so the next render reserves exactly
   *  that — no big empty gap under a compact multi-line `align`, no
   *  overflow under a tall single-line equation. Persists across renders;
   *  re-measured every render, so it self-corrects on font/theme change. */
  let blockRowsByKey = new Map();

  /** Pixel x of a (visual) column on a line, accounting for inline math
   *  widgets fully to its left whose rendered width differs from their
   *  source span. For a line with no widget this is exactly
   *  `column * charWidth` (i.e. `column * 1ch`), so non-math lines are
   *  unaffected. A cursor is never *inside* a shown widget (it would be
   *  revealed), so every widget is wholly left or right of `column`. */
  function columnToXPx(line, column) {
    const cw = charWidth();
    let x = column * cw;
    const widgets = inlineWidgetsByLine.get(line);
    if (widgets) {
      for (const w of widgets) {
        if (w.toColumn <= column) {
          const sourceW = (w.toColumn - w.fromColumn) * cw;
          const realW = w.element ? w.element.getBoundingClientRect().width : sourceW;
          x -= sourceW - realW;
        }
      }
    }
    return x;
  }

  /** A CSS `left`/x value for a column: the cheap `calc(… * 1ch)` for a
   *  plain line, a measured pixel value for a widget-bearing line. */
  function xForColumn(line, column) {
    return inlineWidgetsByLine.has(line)
      ? `${columnToXPx(line, column)}px`
      : `calc(${column} * 1ch)`;
  }

  /** Inverse of `columnToXPx`: the source column nearest pixel x on a
   *  line, accounting for inline widget widths. Plain lines fall back to
   *  `round(x / charWidth)`. */
  function xPxToColumn(line, xPx) {
    const cw = charWidth();
    const widgets = inlineWidgetsByLine.get(line);
    if (!widgets || widgets.length === 0) {
      return Math.max(0, Math.round(xPx / cw));
    }
    let px = 0;
    let col = 0;
    for (const w of widgets) {
      const textPx = (w.fromColumn - col) * cw;
      if (xPx <= px + textPx) return col + Math.max(0, Math.round((xPx - px) / cw));
      px += textPx;
      col = w.fromColumn;
      const realW = w.element
        ? w.element.getBoundingClientRect().width
        : (w.toColumn - w.fromColumn) * cw;
      // A click within the widget snaps to its nearer edge (clicks on the
      // widget itself are handled separately — it reveals on mousedown).
      if (xPx <= px + realW) return xPx < px + realW / 2 ? w.fromColumn : w.toColumn;
      px += realW;
      col = w.toColumn;
    }
    return col + Math.max(0, Math.round((xPx - px) / cw));
  }

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

    // Replaced-range widget layout (math preview). Build the line-offset
    // model the layout needs, gather the cursor offsets that drive the
    // exclusive reveal rule, and compute which inline runs are replaced,
    // which lines a block widget hides, and where each block widget sits.
    // The block-hidden lines are *merged into the fold-hidden set below*
    // so the single display-row / cursor / scroll accounting stays the
    // one source of truth — no parallel line-hiding bookkeeping.
    const lineStarts = new Array(lineCount);
    const lineLengths = new Array(lineCount);
    {
      let off = 0;
      for (let i = 0; i < lineCount; i += 1) {
        lineStarts[i] = off;
        lineLengths[i] = lines[i].content.length;
        off += lines[i].content.length + 1;
      }
    }
    const replacedRanges = getReplacedRanges() || [];
    const cursorPoints = getCursors().map((c) => c.point);
    const mathLayout = computeMathLayout({
      ranges: replacedRanges,
      lineStarts,
      lineLengths,
      points: cursorPoints,
    });
    // Reserve a block widget's *measured* height (cached by content from a
    // prior render) when known; the source-line span computeMathLayout
    // returns is only the first-frame fallback — it over-reserves a
    // compact multi-line `align` and under-reserves a tall equation.
    for (const placement of mathLayout.blockByStartLine.values()) {
      const k = placement.range && placement.range.key;
      if (k != null && blockRowsByKey.has(k)) {
        placement.rowSpan = blockRowsByKey.get(k);
      }
    }
    // Merge the block-widget-hidden lines into the fold-hidden set
    // before display rows are assigned.
    for (const line of mathLayout.hiddenByBlock) hidden.add(line);

    displayRowForLine = new Int32Array(lineCount);
    let row = 0;
    for (let i = 0; i < lineCount; i += 1) {
      if (hidden.has(i)) {
        displayRowForLine[i] = -1;
      } else {
        displayRowForLine[i] = row;
        // A block-math start line reserves the rows its source spanned, so
        // a tall typeset equation keeps its footprint instead of
        // overflowing onto the next visible line.
        const blk = mathLayout.blockByStartLine.get(i);
        row += blk ? blk.rowSpan : 1;
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
    const modeName = getMajorModeName();
    const overrideGen = getOverrideGeneration();
    // Tag the editor root with the buffer's major-mode name so per-mode
    // face colour overrides (mode-scoped `.tok-*` CSS, see
    // face-styles.js) can target this buffer's tokens. Cheap idempotent
    // attribute write.
    if (modeName) {
      if (root.dataset.majorMode !== modeName) root.dataset.majorMode = modeName;
    } else if (root.dataset.majorMode) {
      delete root.dataset.majorMode;
    }
    const cacheFresh =
      text === highlightCacheText &&
      language === highlightCacheLanguage &&
      modeName === highlightCacheMode &&
      overrideGen === highlightCacheGen;
    if (treeSitter) {
      if (cacheFresh) {
        perLine = highlightCache;
      } else {
        try {
          // Pass the major-mode name so mode-scoped user override rules
          // apply; language-wide rules apply regardless.
          perLine = treeSitter(text, modeName);
        } catch {
          perLine = null;
        }
        highlightCacheText = text;
        highlightCacheLanguage = language;
        highlightCacheMode = modeName;
        highlightCacheGen = overrideGen;
        highlightCache = perLine;
      }
    } else if (cacheFresh && highlightCache !== null) {
      perLine = highlightCache;
    } else {
      const whole = highlightBuffer(text, language);
      if (whole !== null) {
        perLine = whole;
        highlightCacheText = text;
        highlightCacheLanguage = language;
        highlightCacheMode = modeName;
        highlightCacheGen = overrideGen;
        highlightCache = perLine;
      }
    }

    // Walk every line so we can keep `lineStartOffset` accurate; skip
    // hidden lines and only emit DOM for lines whose display row is in
    // the viewport window.
    inlineWidgetsByLine = new Map();
    const blockMeasure = [];
    const lineEls = [];
    const numberEls = [];
    let lineStartOffset = 0;
    for (let index = 0; index < lineCount; index += 1) {
      const displayRow = displayRowForLine[index];
      if (displayRow !== -1 && displayRow >= firstRow && displayRow < lastRow) {
        const lineEl = el('div', 'editor-line');
        lineEl.style.top = `calc(${displayRow} * 1lh)`;
        let runs = perLine
          ? perLine[index] ?? []
          : highlightLine(lines[index].content, language);
        // Splice in any inline math widgets that fall on this line,
        // replacing the source characters they cover. Block widgets are
        // emitted as a separate row below (the source lines they span
        // are already hidden).
        const inlinePlacements = mathLayout.inlineByLine.get(index);
        if (inlinePlacements && inlinePlacements.length > 0) {
          runs = spliceInlineWidgets(runs, inlinePlacements);
        }
        const blockPlacement = mathLayout.blockByStartLine.get(index);
        if (blockPlacement) {
          // The start line holds the block's opening delimiter. Show only
          // the source *before* the delimiter (any prefix text on that
          // line), then the widget — so the raw `$$` / `\[` isn't drawn.
          // The body lines below are already hidden (`hiddenByBlock`).
          if (blockPlacement.startColumn > 0) {
            runs = spliceInlineWidgets(runs, [
              {
                fromColumn: blockPlacement.startColumn,
                toColumn: Number.MAX_SAFE_INTEGER,
                range: { el: null, start: 0, end: 0 },
              },
            ]).filter((r) => !r.widget); // drop the placeholder marker
          } else {
            runs = [];
          }
          renderRuns(lineEl, runs);
          const widget = mountWidget(blockPlacement.range, true);
          if (widget) {
            lineEl.append(widget);
            blockMeasure.push({ key: blockPlacement.range.key, el: widget });
          }
          lineEl.classList.add('has-block-math');
          // Reserve the rows the source spanned (see math-layout's
          // rowSpan) so the equation doesn't overflow onto the next line.
          lineEl.style.height = `calc(${blockPlacement.rowSpan} * 1lh)`;
        } else {
          renderRuns(lineEl, runs);
        }
        // Record the inline math widgets mounted on this line (column
        // order matches DOM order), so the cursor/selection/click can
        // position by their measured width rather than source columns.
        if (inlinePlacements && inlinePlacements.length > 0 && !blockPlacement) {
          const widgetEls = lineEl.querySelectorAll('.math-widget.math-inline');
          const captured = [];
          for (let k = 0; k < inlinePlacements.length && k < widgetEls.length; k += 1) {
            captured.push({
              fromColumn: inlinePlacements[k].fromColumn,
              toColumn: inlinePlacements[k].toColumn,
              element: widgetEls[k],
            });
          }
          if (captured.length > 0) inlineWidgetsByLine.set(index, captured);
        }
        // Folded header: tack a `…` glyph plus the closing line's
        // SYNTAX-HIGHLIGHTED text on the end so the user sees both
        // ends of the collapsed structure at a glance with proper
        // colours — e.g. `<script>…</script>` with `</script>`
        // rendered in tag face. Falls back gracefully when the fold
        // range doesn't have a useful closing line.
        if (folded.has(index)) {
          const ellipsis = el('span', 'editor-fold-ellipsis');
          ellipsis.textContent = '…';
          lineEl.append(ellipsis);
          const endLineNum = foldCache.endByStart.get(index);
          if (
            typeof endLineNum === 'number' &&
            endLineNum > index &&
            endLineNum < lines.length
          ) {
            const closeRuns = perLine
              ? (perLine[endLineNum] ?? null)
              : highlightLine(lines[endLineNum].content, language);
            const trimmed = closeRuns ? trimLeadingWhitespaceRuns(closeRuns) : null;
            if (trimmed && trimmed.length > 0) {
              const close = el('span', 'editor-fold-close');
              renderRuns(close, trimmed);
              lineEl.append(close);
            }
          }
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
        // Fold marker, when this line is foldable. A FontAwesome
        // caret — sized via CSS so it's clearly clickable, unlike
        // the small ▸/▾ glyphs in the editor's own monospace font.
        if (foldCache.headers.has(index)) {
          const marker = el('button', 'editor-fold-marker');
          marker.type = 'button';
          marker.dataset.line = String(index);
          marker.title = folded.has(index) ? 'Unfold' : 'Fold';
          const icon = doc.createElement('i');
          icon.className = 'fa-solid ' +
            (folded.has(index) ? 'fa-chevron-right' : 'fa-chevron-down');
          marker.append(icon);
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

    // The block widgets are now laid out: measure each one's real height
    // and remember how many rows it needs (height + the .math-block top/
    // bottom margin, rounded up to whole lines). When that differs from
    // what we reserved this frame, re-render so the next frame reserves
    // exactly the right vertical space. Converges in one extra frame and
    // then stays cached, so there's no flicker on steady state.
    let rowsChanged = false;
    for (const { key, el: widgetEl } of blockMeasure) {
      if (key == null) continue;
      const h = widgetEl.getBoundingClientRect().height;
      if (h <= 0) continue;
      const rows = Math.max(1, Math.ceil((h + 0.4 * lineHeight) / lineHeight));
      if (blockRowsByKey.get(key) !== rows) {
        blockRowsByKey.set(key, rows);
        rowsChanged = true;
      }
    }
    if (rowsChanged) schedule();
  }

  /** Render the selection highlight, one rectangle per touched line,
   *  across every cursor's selection. */
  function renderSelection() {
    const rects = selectionRects(activeBuffer, getCursors(), undefined, getTabWidth());
    selectionLayer.replaceChildren(
      ...rects
        .map((rect) => {
          const row = rowOf(rect.line);
          if (row === -1) return null;
          const span = rect.toColumn - rect.fromColumn;
          const box = el('div', 'editor-selection-rect');
          box.style.top = `calc(${row} * 1lh)`;
          // A selection that runs past this line shows its newline as a
          // sliver of trailing highlight. On a line with inline math
          // widgets, measure the endpoints so the highlight tracks the
          // typeset width rather than the source-character columns.
          if (inlineWidgetsByLine.has(rect.line)) {
            const leftPx = columnToXPx(rect.line, rect.fromColumn);
            const rightPx = columnToXPx(rect.line, rect.toColumn);
            box.style.left = `${leftPx}px`;
            box.style.width = `${rightPx - leftPx + (rect.toLineEnd ? charWidth() * 0.5 : 0)}px`;
          } else {
            box.style.left = `calc(${rect.fromColumn} * 1ch)`;
            box.style.width = rect.toLineEnd
              ? `calc(${span} * 1ch + 0.5ch)`
              : `calc(${span} * 1ch)`;
          }
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
    const tabW = getTabWidth();
    bracketLayer.replaceChildren(
      ...[match.a, match.b]
        .map((at) => {
          const { line, column } = activeBuffer.positionAt(at);
          const row = rowOf(line);
          if (row === -1) return null;
          // Map character column → visual column so the bracket box
          // lines up with the glyph when the line contains tabs.
          const lineMeta = activeBuffer.lineAt(activeBuffer.offsetAt(line, 0));
          const lineText = typeof lineMeta.text === 'string'
            ? lineMeta.text
            : activeBuffer.slice(lineMeta.from, lineMeta.to);
          const visCol = tabW > 0
            ? visualColumn(lineText, column, tabW)
            : column;
          const box = el('div', 'editor-bracket');
          box.style.left = `calc(${visCol} * 1ch)`;
          box.style.top = `calc(${row} * 1lh)`;
          return box;
        })
        .filter((b) => b !== null)
    );
  }

  // A pool of secondary cursor elements, kept attached to `content` so
  // they share the text's ch/lh coordinate space with the primary cursor.
  // Re-used across renders to avoid the cost of recreating them when
  // several cursors live for a while.
  /** @type {HTMLElement[]} */
  const secondaryCursors = [];

  /** Position every cursor (primary + secondaries), the current-line
   *  highlight and the gutter. */
  function renderCursor() {
    const cursors = getCursors();
    const positions = cursorPositions(activeBuffer, cursors, getTabWidth());
    // The primary caret stays in the existing `cursorEl`; secondaries
    // come from the pool. Always at least one cursor — fall back to
    // (0,0) if a caller hands back an empty list.
    const primaryPos = positions[0] ?? { line: 0, column: 0 };
    // If the primary lands inside a folded region, hop it up to the
    // header line — the user shouldn't be able to "see" the cursor
    // sitting on a hidden line. Visually we still draw it at the
    // header's row, in the column the cursor would have on its real line.
    const primaryRow = rowOf(primaryPos.line);
    const primaryDisplayRow = primaryRow === -1
      ? rowOf(findVisibleAncestorLine(primaryPos.line))
      : primaryRow;
    cursorEl.style.left = xForColumn(primaryPos.line, primaryPos.column);
    cursorEl.style.top = `calc(${primaryDisplayRow} * 1lh)`;
    currentLineEl.style.top = `calc(${primaryDisplayRow} * 1lh)`;

    // Grow or shrink the secondary pool to match (cursor count − 1).
    const secondaryCount = Math.max(0, positions.length - 1);
    while (secondaryCursors.length < secondaryCount) {
      const extra = el('div', 'editor-cursor is-secondary');
      content.append(extra);
      secondaryCursors.push(extra);
    }
    while (secondaryCursors.length > secondaryCount) {
      const extra = secondaryCursors.pop();
      extra.remove();
    }
    for (let i = 0; i < secondaryCount; i += 1) {
      const { line, column } = positions[i + 1];
      const row = rowOf(line);
      const displayRow = row === -1 ? rowOf(findVisibleAncestorLine(line)) : row;
      const extra = secondaryCursors[i];
      extra.style.left = xForColumn(line, column);
      extra.style.top = `calc(${displayRow} * 1lh)`;
    }

    // Brighten the primary cursor's line number in the gutter. Only the
    // visible numbers are present, so match on the line each carries.
    for (const numberEl of gutter.children) {
      numberEl.classList.toggle(
        'is-current',
        Number(numberEl.dataset.line) === primaryPos.line
      );
    }

    // Restart the blink on every cursor so they all start solid and
    // stay in phase. CSS animations begin when `is-blinking` is added,
    // so removing → forcing a reflow → re-adding on every cursor in
    // one go ensures the primary and secondaries blink in unison
    // (otherwise each cursor's animation starts at its own t=0 when
    // its element was first mounted, and they drift visibly).
    cursorEl.classList.remove('is-blinking');
    for (const extra of secondaryCursors) extra.classList.remove('is-blinking');
    void cursorEl.offsetWidth;
    cursorEl.classList.add('is-blinking');
    for (const extra of secondaryCursors) extra.classList.add('is-blinking');
  }

  let dirty = false;
  let frame = 0;
  // A render keeps the cursor on screen only when it follows a buffer
  // event — the cursor may have moved. A render that follows a *scroll*
  // must not: pulling the cursor back into view would yank the viewport
  // back, so the user could never scroll past the cursor's line.
  let followCursor = false;
  // Recenter / flash are *deferred to the end of a render*, not run
  // synchronously by their callers. `goto-line!` (and any buffer move)
  // repositions the cursor on the next animation frame, so a recenter or
  // flash issued right after it would otherwise read the cursor's *old*
  // row. Running them in `render()` — after `renderCursor()` has moved
  // `cursorEl` and rebuilt `displayRowForLine` — fixes that, and lets a
  // pending recenter win over the plain follow-cursor scroll (which only
  // nudges the line to the nearest edge, not the centre).
  let pendingRecenter = false;
  let pendingFlash = false;

  /** Paint the transient flash band over the cursor's current line. The
   *  band sits in the content layer (so it scrolls with the text) at the
   *  line's display row, then fades out and removes itself. */
  function paintLineFlash() {
    const positions = cursorPositions(activeBuffer, getCursors(), getTabWidth());
    const pos = positions[0] ?? { line: 0, column: 0 };
    const row = rowOf(pos.line);
    const displayRow = row === -1 ? rowOf(findVisibleAncestorLine(pos.line)) : row;
    const flash = el('div', 'editor-line-flash');
    flash.style.top = `calc(${displayRow} * 1lh)`;
    content.append(flash);
    const remove = () => flash.remove();
    flash.addEventListener('transitionend', remove, { once: true });
    // Fallback in case the transition doesn't fire (element detached, etc.).
    setTimeout(remove, 2000);
    // Paint the start state, then trigger the fade on the next frame.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => flash.classList.add('is-fading'));
    });
  }

  /** Render everything once; called on an animation frame. */
  function render() {
    dirty = false;
    frame = 0;
    renderLines();
    renderSelection();
    renderBrackets();
    renderCursor();
    // Scroll handling, after the cursor has been repositioned. A pending
    // recenter takes precedence over follow-cursor: centre the line and
    // drop the edge-nudge that would otherwise override it.
    if (pendingRecenter) {
      pendingRecenter = false;
      followCursor = false;
      cursorEl.scrollIntoView({ block: 'center', inline: 'nearest' });
    } else if (followCursor) {
      followCursor = false;
      cursorEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (pendingFlash) {
      pendingFlash = false;
      paintLineFlash();
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
    // x → visual column, visual column → character index. Tabs span
    // multiple visual columns, so clicking past a tab needs the
    // inverse-tab-stop math (charIndexAtVisualColumn) to land on the
    // right insertion point.
    const px = clientX - box.left;
    let column;
    if (inlineWidgetsByLine.has(line)) {
      // On a line with inline math widgets, invert the measured layout so
      // a click past the (narrow) typeset math lands on the right offset.
      column = xPxToColumn(line, px);
    } else {
      const visCol = Math.max(0, Math.round(px / charWidth()));
      const tabW = getTabWidth();
      column = visCol;
      if (tabW > 0) {
        const lineMeta = activeBuffer.lineAt(activeBuffer.offsetAt(line, 0));
        const lineText = typeof lineMeta.text === 'string'
          ? lineMeta.text
          : activeBuffer.slice(lineMeta.from, lineMeta.to);
        column = charIndexAtVisualColumn(lineText, visCol, tabW);
      }
    }
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
   * Map a hidden line to the nearest visible line above it — the one
   * visible ancestor to draw the cursor at. Keeps the cursor display
   * (and scroll-follow) sensible when point lands on a line the view has
   * hidden but the buffer knows nothing about: a folded region (→ its
   * header) or the body/closing lines a block-math widget collapses
   * (→ the equation's start line, which carries the widget). Walking up
   * to the first non-hidden line covers both uniformly; previously this
   * only consulted the fold index, so a cursor on a block-math-hidden
   * line stayed at row -1 and scrolled the viewport to the top.
   */
  function findVisibleAncestorLine(line) {
    if (!displayRowForLine || displayRowForLine[line] !== -1) return line;
    let l = line;
    while (l > 0 && displayRowForLine[l] === -1) l -= 1;
    return l;
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

  /** The pixel width of one character, measured from a rendered line.
   *  Skips lines carrying a math widget — the widget's width and its
   *  text content (the SVG / assistive MathML) would skew the average. */
  function charWidth() {
    for (const lineEl of linesEl.children) {
      if (lineEl.querySelector('.math-widget')) continue;
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

    /** Scroll so the cursor's line sits in the middle of the viewport.
     *  Deferred to the next render so it reads the cursor's *new* row
     *  after a preceding buffer move (e.g. `goto-line!`), and wins over
     *  that move's follow-cursor edge-scroll. */
    recenter() {
      pendingRecenter = true;
      schedule();
    },

    /** Flash a transient highlight band over the cursor's line, then fade
     *  it out and remove it. Used by SyncTeX inverse search to call
     *  attention to the line it landed on. Deferred to the next render so
     *  it lands on the line the cursor was just moved to. */
    flashCurrentLine() {
      pendingFlash = true;
      schedule();
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

    /**
     * Re-point this editor view at a new (text-kind) View. Per-pane
     * edit-view instances: one renderer per leaf pane, swapped to a
     * different view as the pane's content changes.
     *
     * The previous `setBuffer(buffer)` shape is kept as a thin shim
     * for callers that haven't migrated yet, but `setView(view)` is
     * the new primary entry point.
     *
     * @param {import('@editor/view').View} next - The view to show.
     *   `next.buffer` is the L2 buffer; the renderer subscribes to it.
     */
    setView(next) {
      const nextBuffer = next && next.buffer ? next.buffer : null;
      if (nextBuffer === null) {
        // Defensive: a non-text view should never reach here; the
        // host's mount dispatch routes elsewhere. No-op rather than crash.
        return;
      }
      if (nextBuffer !== activeBuffer) {
        unsubscribe();
        activeBuffer = nextBuffer;
        unsubscribe = activeBuffer.onChange(scheduleFollowingCursor);
      }
      // Always render, even when the buffer is unchanged: switchToView
      // is called when the view is mounted again after a hidden spell,
      // and any render that fired while the view was hidden produced a
      // 0-height layout. The reveal pass redraws against the real
      // viewport.
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
