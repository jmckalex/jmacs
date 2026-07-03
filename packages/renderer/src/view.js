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
  toLines, selectionRects, cursorPositions, decorationRects,
  visualColumn, charIndexAtVisualColumn, isWideCharacter,
} from './projection.js';
import { handleKeyEvent } from './commands.js';
import { keyEventToString, altComposedInsert } from './keymap.js';
import { highlightBuffer, highlightLine, languageForName } from './highlight.js';
import { matchingBracket } from './brackets.js';
import { createColourSwatches } from './colour-swatches.js';
import {
  foldRanges,
  indexFoldRanges,
  hiddenLines,
  foldsHidingLine,
  isStructuralCloseLine,
  enclosingFolds,
  stickyHeaderRows,
} from './folding.js';
import { lineIndentColumns, computeIndentGuides } from './indent-guides.js';
import { computeMathLayout, spliceInlineWidgets } from './math-layout.js';
import { createFollowTracker } from './follow-cursor.js';

/** Keys that are only modifiers — never a keystroke on their own. */
const MODIFIER_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph',
]);

/**
 * How many rows below the viewport top to consider when gathering sticky
 * header candidates. A scope sticks up to `slot` rows before its header
 * reaches the geometric top (it slots in at the bottom of the stack), so the
 * look-ahead only needs to exceed the deepest slot a panel will ever show;
 * this is comfortably above any real nesting depth. (It also bounds the
 * per-frame gather — the cost is the same linear scan of the fold index the
 * old enclosing-chain lookup did.)
 */
const STICKY_LOOKAHEAD = 64;

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
 * @param {() => import('./projection.js').DecorationRange[]}
 *   [options.getDecorations] - Face-tagged offset ranges to paint as
 *   styled boxes behind the text (e.g. snippet fields + mirrors). Read
 *   on *every* render, so the boxes track the buffer as it changes — the
 *   supplier returns live absolute offsets and the renderer recomputes
 *   the rectangles each frame, exactly as it does for the selection.
 *   Defaults to a function returning no decorations.
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
  // The highlighter grammar for the active buffer. The MAJOR MODE is the source
  // of truth (server-pushed `highlightLang`), so a file whose extension was
  // re-registered to another mode — e.g. `.md` in jmarkdown-mode — highlights by
  // that mode, not by its filename. Falls back to the filename when no mode hint
  // is present (a plain L2 buffer, or before the first server VIEW).
  const activeLanguage = () =>
    (activeBuffer && activeBuffer.highlightLang) || languageForName(activeBuffer.name);
  // Face-tagged decoration ranges (snippet fields + mirrors). Read every
  // render so the boxes recompute from live offsets and survive edits —
  // unlike the inline-eval pill, which hides on any mutation. Default to
  // none so renderer unit tests and hosts that haven't wired snippets
  // keep the old behaviour.
  const getDecorations =
    typeof options.getDecorations === 'function'
      ? options.getDecorations
      : () => [];

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

  // Reported (once) when the render loop catches a throw — a bad
  // highlighter, a widget factory that blew up, a malformed overlay. The
  // host logs it and surfaces a message; the render itself degrades to
  // plain text rather than freezing. Defaults to a no-op.
  const onRenderError =
    typeof options.onRenderError === 'function' ? options.onRenderError : () => {};
  /** True only while a degraded (plain-text, no-highlight, no-widget)
   *  retry of the current frame is in flight — see `render()`. */
  let renderDegraded = false;
  /** So a deterministic render error logs once, not every frame. */
  let renderErrorReported = false;

  /** Surface a render-loop error to the host at most once. */
  function reportRenderError(error) {
    if (renderErrorReported) return;
    renderErrorReported = true;
    try {
      onRenderError(error);
    } catch {
      // The reporter must never itself break the render loop.
    }
  }

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

  // Languages that get "sticky" code-structure headers — the chain of
  // open enclosing elements pinned at the top of the viewport as you
  // scroll into nested markup (VS Code's sticky scroll / Nova's structure
  // headers). Default to HTML + PHP, where nesting runs deepest; a host
  // can widen or disable it. The pinned set is computed from the same
  // fold ranges the gutter folds use, so a language with no fold captures
  // simply shows nothing.
  const stickyHeaderLanguages = new Set(
    Array.isArray(options.stickyHeaderLanguages)
      ? options.stickyHeaderLanguages
      : ['html', 'php', 'javascript', 'typescript', 'python', 'jmarkdown', 'latex']
  );

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
  /** @type {{ headers: Set<number>, endByStart: Map<number, number>, depthByStart: Map<number, number> }} */
  let foldCache = emptyFoldCache();

  function emptyFoldCache() {
    return {
      headers: new Set(),
      endByStart: new Map(),
      depthByStart: new Map(),
      cutByStart: new Map(),
      blockByStart: new Set(),
    };
  }

  /** Recompute and cache the fold index for the current buffer text. */
  function refreshFoldIndex() {
    const text = activeBuffer.text;
    const language = activeLanguage();
    if (text === foldCacheText && language === foldCacheLanguage) {
      return foldCache;
    }
    const extractor = foldCapturesByLanguage[language];
    if (typeof extractor === 'function') {
      try {
        foldCache = indexFoldRanges(foldRanges(text, extractor(text)));
      } catch {
        foldCache = emptyFoldCache();
      }
    } else {
      foldCache = emptyFoldCache();
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
  // Vertical indent guides, behind the text. Filled by `renderLines`.
  const indentGuideLayer = el('div', 'editor-indent-guides');
  const currentLineEl = el('div', 'editor-current-line');
  // Face-tagged decoration boxes (snippet fields + mirrors) sit behind
  // the selection so an active field shows its face tint with the
  // selection highlight drawn over it until the user types.
  const decorationLayer = el('div', 'editor-decorations');
  const selectionLayer = el('div', 'editor-selection');
  const bracketLayer = el('div', 'editor-brackets');
  const linesEl = el('div', 'editor-lines');
  const cursorEl = el('div', 'editor-cursor');
  const overlayLayer = el('div', 'editor-overlay');
  // Sticky code-structure headers (HTML/PHP): two browser-pinned anchors,
  // each `position: sticky; top: 0; height: 0` (see styles.css), so the
  // browser keeps them at the viewport top with no per-frame JS. Their
  // rows are positioned absolutely within. The gutter anchor carries the
  // pinned line numbers; the content anchor carries the header rows.
  const contentStickyLayer = el('div', 'editor-sticky');
  const gutterStickyLayer = el('div', 'editor-gutter-sticky');
  // The IME input sink. A custom, div-rendered editor has no natural
  // editable element, so IME composition (CJK input, dead keys, accents)
  // has nowhere to happen. A focused, visually-hidden <textarea> gives it
  // one: it is the editor's focus target, kept over the caret so the IME
  // candidate window appears there. Normal keys still flow through the
  // keydown → keymap path (the buffer, not the textarea, holds the text);
  // only *composed* text is read back from the sink on commit.
  const input = el('textarea', 'editor-input');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('aria-hidden', 'true');
  input.tabIndex = -1;
  content.append(
    backgroundLayer,
    indentGuideLayer,
    currentLineEl,
    decorationLayer,
    selectionLayer,
    bracketLayer,
    linesEl,
    cursorEl,
    input,
    overlayLayer,
    contentStickyLayer
  );

  /** True while an IME composition is in progress — key dispatch is
   *  suppressed and the committed text is inserted on `compositionend`. */
  let composing = false;
  // macOS press-and-hold accent support. Holding a bare printable key opens the
  // OS accent chooser — a COMPOSITION — instead of repeating (see the keydown
  // handler's repeat guard). `printableBaseCandidate` marks the just-typed
  // printable as a possible BASE character; if a composition then opens over it,
  // the chosen accent must REPLACE that base char rather than append — else
  // holding "e" and picking "é" yields "eé". The flag is set ONLY on the
  // self-insert path, so a plain dead-key / CJK composition (which never
  // self-inserts a base) is untouched — and if the OS routes the first keydown
  // straight through the IME (no self-insert), the flag stays false and nothing
  // is deleted. So the replace is safe whichever way the OS behaves.
  let printableBaseCandidate = false;
  let compositionReplacesBase = false;
  input.addEventListener('compositionstart', () => {
    composing = true;
    compositionReplacesBase = printableBaseCandidate;
  });
  input.addEventListener('compositionend', (event) => {
    composing = false;
    const text = typeof event.data === 'string' ? event.data : '';
    input.value = ''; // the sink only hosts composition — never accumulate
    const replaceBase = compositionReplacesBase;
    compositionReplacesBase = false;
    printableBaseCandidate = false;
    if (text) {
      // Press-and-hold commit: drop the base char the keydown already inserted
      // so the chosen accent takes its place ("e" → "é", not "eé").
      if (replaceBase && typeof activeBuffer.deleteBackward === 'function') {
        activeBuffer.deleteBackward(1);
      }
      activeBuffer.insert(text);
      followCursor = true;
      schedule();
    }
    // A composition that opened over a base char but committed nothing (Escape /
    // cancel) leaves the base char as already typed — nothing to do.
  });
  // The sink is deliberately NOT cleared here on every `input`. A bare printable
  // now flows INTO it (its keydown isn't preventDefault'd — see the keydown
  // handler) and must REMAIN there so macOS press-and-hold can mark that base
  // char and start the accent COMPOSITION over it; clearing it immediately left
  // nothing to compose, so the popup showed but no composition began and the
  // number-select self-inserted. The stale char is instead dropped at the start
  // of the NEXT keystroke (keydown) and by `compositionend`. During a
  // composition the value is macOS's marked text — never touched here.

  /** Focus the editor: focus the hidden input sink (a child of root), so
   *  the IME composes there and keystrokes still bubble to root's keydown
   *  listener. `preventScroll` stops focusing from yanking the viewport. */
  function focusInput() {
    input.focus({ preventScroll: true });
  }
  gutter.append(gutterStickyLayer);
  root.append(gutter, content);
  container.append(root);

  /** Create an element with a class name. */
  function el(tag, className) {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  }

  /** Whether TEXT contains any East Asian wide / fullwidth / emoji char.
   *  Wide glyphs render narrower than the two-column grid assumes, so a
   *  line with one gets its caret x measured from the DOM instead of the
   *  cheap `column * 1ch`. */
  function hasWide(text) {
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i);
      if (isWideCharacter(cp)) return true;
      i += cp > 0xffff ? 2 : 1;
    }
    return false;
  }

  /** The pixel x (relative to the line's left edge) of character offset
   *  `charIndex` within the already-rendered LINEEL, by measuring a Range
   *  over the line's text nodes. Exact for any font / glyph width — used
   *  only for lines that contain wide glyphs, where the grid drifts.
   *  Returns null when the offset can't be located. */
  function measureCaretXPxIn(lineEl, charIndex) {
    if (charIndex <= 0) return 0;
    const range = doc.createRange();
    range.setStart(lineEl, 0);
    const walker = doc.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    let acc = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const len = node.nodeValue.length;
      if (charIndex <= acc + len) {
        range.setEnd(node, charIndex - acc);
        return (
          range.getBoundingClientRect().right -
          lineEl.getBoundingClientRect().left
        );
      }
      acc += len;
    }
    return null;
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

  /** Keep the run text in columns `[0, col)`, splitting the run that
   *  straddles `col`. Faces are preserved. Used to render the opening
   *  delimiter of a column-folded header (`<p>` from `<p>This is…`).
   *  Operates on plain `{ text, face }` runs (no widget markers). */
  function sliceRunsToColumn(runs, col) {
    const out = [];
    let seen = 0;
    for (const run of runs) {
      if (seen >= col) break;
      const room = col - seen;
      if (run.text.length <= room) {
        out.push(run);
      } else {
        out.push({ text: run.text.slice(0, room), face: run.face });
      }
      seen += run.text.length;
    }
    return out;
  }

  /** Keep the run text from column `col` onward, splitting the straddling
   *  run. Used to render the closing delimiter of a column-folded header
   *  (`</p>` from `…mathematics.</p>`). Plain `{ text, face }` runs. */
  function sliceRunsFromColumn(runs, col) {
    const out = [];
    let seen = 0;
    for (const run of runs) {
      const end = seen + run.text.length;
      if (end > col) {
        const from = Math.max(0, col - seen);
        out.push(from === 0 ? run : { text: run.text.slice(from), face: run.face });
      }
      seen = end;
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
      focusInput();
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
  // For each buffer line, the bottom-most display row occupied by the last
  // *visible* line at or before it. Hidden lines carry the previous value.
  // Lets a fold-range pill find its bottom row in O(1) even when nested
  // folds hide its end line. Rebuilt alongside `displayRowForLine`.
  /** @type {Int32Array | null} */
  let lastVisibleRowForLine = null;
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
    const language = activeLanguage();
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
    // Navigating the cursor into a collapsed region auto-unfolds it, so the
    // caret lands where you moved it rather than being clamped to the header.
    revealFoldsAtPoint(folded);
    const hidden = hiddenLines(folded, foldCache.endByStart, foldCache.blockByStart);

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
    // In a degraded retry, skip widgets entirely (a throwing widget
    // factory is a prime suspect for the failure we are recovering from).
    const replacedRanges = renderDegraded ? [] : getReplacedRanges() || [];
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
    lastVisibleRowForLine = new Int32Array(lineCount);
    let row = 0;
    let lastVisibleRow = 0;
    for (let i = 0; i < lineCount; i += 1) {
      if (hidden.has(i)) {
        displayRowForLine[i] = -1;
      } else {
        displayRowForLine[i] = row;
        // A block-math start line reserves the rows its source spanned, so
        // a tall typeset equation keeps its footprint instead of
        // overflowing onto the next visible line. A *folded block fold*
        // (@begin/@end) reserves a second row for its vertical ellipsis,
        // drawn between the kept @begin and @end lines.
        const blk = mathLayout.blockByStartLine.get(i);
        const foldedBlock = folded.has(i) && foldCache.blockByStart.has(i);
        row += blk ? blk.rowSpan : (foldedBlock ? 2 : 1);
        lastVisibleRow = row - 1; // bottom display row this line occupies
      }
      lastVisibleRowForLine[i] = lastVisibleRow;
    }
    displayRowCount = row;

    content.style.height = `calc(${displayRowCount} * 1lh)`;
    gutter.style.height = `calc(${displayRowCount} * 1lh)`;
    // Gutter layout, right→left from the gutter's right edge: a small
    // content gap, the fold rail (chevrons + range pills), the 1px
    // vertical rule just right of the ones-place, a gap, then the
    // right-aligned numbers, then left padding. Only the digit count
    // varies; everything right of the rule is a fixed column so the
    // chevrons align regardless of line-number width. Offsets live in
    // CSS (.editor-line-no / .editor-fold-marker / .editor-fold-pill).
    gutter.style.width = `calc(${String(lineCount).length}ch + 42px)`;

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
    // Highlighting is the most error-prone work in the render (a whole-
    // buffer tokenizer, user override rules). In a degraded retry, skip
    // it entirely — `perLine` stays null, so the lines paint as plain
    // text and the editor stays usable instead of freezing.
    if (!renderDegraded) {
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
    }

    // Walk every line so we can keep `lineStartOffset` accurate; skip
    // hidden lines and only emit DOM for lines whose display row is in
    // the viewport window.
    inlineWidgetsByLine = new Map();
    const blockMeasure = [];
    const lineEls = [];
    const numberEls = [];
    // Fold chevrons and range pills live in the gutter's fixed rail
    // (right of the rule), positioned absolutely — not inside the
    // per-line number element — so they align across line-number widths.
    const chevronEls = [];
    // Indentation (in columns) of each visible display row, for the indent
    // guides; `null` for a blank line (bridged in `computeIndentGuides`).
    const tabWidth = getTabWidth();
    const visibleIndents = new Array(Math.max(0, lastRow - firstRow)).fill(null);
    let lineStartOffset = 0;
    for (let index = 0; index < lineCount; index += 1) {
      const displayRow = displayRowForLine[index];
      if (displayRow !== -1 && displayRow >= firstRow && displayRow < lastRow) {
        visibleIndents[displayRow - firstRow] = lineIndentColumns(
          lines[index].content,
          tabWidth
        );
        const lineEl = el('div', 'editor-line');
        lineEl.dataset.line = String(index);
        lineEl.style.top = `calc(${displayRow} * 1lh)`;
        let runs = perLine
          ? perLine[index] ?? []
          : highlightLine(lines[index].content, language);
        // A column-aware (`@fold.inner`) folded header renders as just
        // its opening delimiter, then `…`, then the closing delimiter
        // (`<p>…</p>`). Slice the runs to the opening delimiter and skip
        // the inline/block-math and colour-swatch passes — the cut
        // content, and anything inside it, is hidden.
        const foldCut = folded.has(index)
          ? foldCache.cutByStart.get(index)
          : undefined;
        const innerFold = !!(foldCut && foldCut.headerCol !== undefined);
        if (innerFold) runs = sliceRunsToColumn(runs, foldCut.headerCol);
        // Splice in any inline math widgets that fall on this line,
        // replacing the source characters they cover. Block widgets are
        // emitted as a separate row below (the source lines they span
        // are already hidden).
        const inlinePlacements = mathLayout.inlineByLine.get(index);
        if (!innerFold && inlinePlacements && inlinePlacements.length > 0) {
          runs = spliceInlineWidgets(runs, inlinePlacements);
        }
        const blockPlacement = mathLayout.blockByStartLine.get(index);
        if (blockPlacement && !innerFold) {
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
        if (!innerFold && inlinePlacements && inlinePlacements.length > 0 && !blockPlacement) {
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
        // rendered in tag face. Only when that closing line is
        // *structurally a close* (`</tag>`, `}`, …); a content line that
        // merely ends with `</p>` is left hidden, so folding it actually
        // collapses the content rather than re-showing the whole line.
        if (folded.has(index) && foldCache.blockByStart.has(index)) {
          // Block fold (jmarkdown @begin/@end): keep the @begin line whole
          // and the @end line visible below (hiddenLines leaves it shown);
          // reserve a second row (see the row-span loop) and draw an
          // indented vertical ellipsis on it to mark the collapsed body.
          lineEl.style.height = 'calc(2 * 1lh)';
          const vEllipsis = el('span', 'editor-fold-vellipsis');
          vEllipsis.textContent = '⋮';
          // Indent the ellipsis to the collapsed body — the first non-blank
          // interior line's indent, else one level past the header.
          const endLine = foldCache.endByStart.get(index);
          let indentCols = lineIndentColumns(lines[index].content, tabWidth) + tabWidth;
          for (let b = index + 1; b < endLine && b < lines.length; b += 1) {
            if (lines[b].content.trim().length > 0) {
              indentCols = lineIndentColumns(lines[b].content, tabWidth);
              break;
            }
          }
          vEllipsis.style.left = `calc(${indentCols} * 1ch)`;
          lineEl.append(vEllipsis);
        } else if (folded.has(index)) {
          const ellipsis = el('span', 'editor-fold-ellipsis');
          ellipsis.textContent = '…';
          lineEl.append(ellipsis);
          const endLineNum = foldCache.endByStart.get(index);
          const closeRuns =
            typeof endLineNum === 'number' &&
            endLineNum > index &&
            endLineNum < lines.length
              ? (perLine
                  ? (perLine[endLineNum] ?? null)
                  : highlightLine(lines[endLineNum].content, language))
              : null;
          // A column-aware fold shows the closing delimiter sliced from
          // the close line (`</p>`); a line-based fold previews the whole
          // closing line, but only when it is structurally a close.
          let tail = null;
          if (closeRuns) {
            if (innerFold && foldCut.closeCol !== undefined) {
              tail = sliceRunsFromColumn(closeRuns, foldCut.closeCol);
            } else if (
              !innerFold &&
              isStructuralCloseLine(lines[endLineNum].content)
            ) {
              tail = trimLeadingWhitespaceRuns(closeRuns);
            }
          }
          if (tail && tail.length > 0) {
            const close = el('span', 'editor-fold-close');
            renderRuns(close, tail);
            lineEl.append(close);
          }
        }
        if (!innerFold && colourSwatches) {
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
        const num = doc.createElement('span');
        num.className = 'editor-line-no-num';
        num.textContent = String(index + 1);
        numberEl.append(num);
        numberEls.push(numberEl);

        // Fold chevron, when this line is foldable. A FontAwesome caret
        // — sized via CSS so it's clearly clickable, unlike the small
        // ▸/▾ glyphs in the editor's own monospace font. Positioned in
        // the gutter's fixed rail (not inside numberEl), so every
        // chevron lands in the same column whatever the line width.
        if (foldCache.headers.has(index)) {
          const marker = el('button', 'editor-fold-marker');
          marker.type = 'button';
          marker.dataset.line = String(index);
          marker.style.top = `calc(${displayRow} * 1lh)`;
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
          wireRangeHover(marker, index);
          chevronEls.push(marker);
        }
      }
      lineStartOffset += lines[index].content.length + 1;
    }

    // Fold-range pills — same-width rounded capsules marking each
    // foldable range, in a single fixed column (the chevron sits centred
    // in the capsule's top). Virtualization-safe: positioned in absolute
    // gutter-row coordinates (top/height in `1lh`), but an element is
    // created only for ranges intersecting the visible window, so the
    // DOM stays bounded on a big file. A folded range collapses to its
    // chevron (no pill). Nested ranges overlap and stack on the z-axis —
    // a child always has a higher start line, so it comes later in the
    // DOM and paints on top of its parent; each pill's fill strengthens
    // with depth, so outer (further-back) ranges read lighter and inner
    // ranges read stronger, giving the concentric-bracket look.
    const pillEls = [];
    for (const [startLine, endLineRaw] of foldCache.endByStart) {
      if (folded.has(startLine)) continue; // collapsed → chevron only
      const topRow = displayRowForLine[startLine];
      if (topRow === -1) continue; // header hidden inside a parent fold
      const endLine = Math.min(endLineRaw, lineCount - 1);
      const bottomRow = lastVisibleRowForLine[endLine];
      if (bottomRow <= topRow) continue; // nothing visible to span
      if (bottomRow < firstRow || topRow >= lastRow) continue; // offscreen
      const pill = el('div', 'editor-fold-pill');
      pill.style.top = `calc(${topRow} * 1lh)`;
      pill.style.height = `calc(${bottomRow - topRow + 1} * 1lh)`;
      // Every bar is the same fixed-width rectangle (perfect overlap, set
      // in CSS); nesting reads from each scope's dark-bordered rounded
      // caps, not from any width difference.
      pill.dataset.line = String(startLine);
      pill.title = 'Fold';
      pill.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        toggleFoldAt(startLine);
      });
      wireRangeHover(pill, startLine);
      pillEls.push(pill);
    }

    linesEl.replaceChildren(...lineEls);

    // Indent guides — a thin vertical line behind the text at each
    // indentation level it crosses, over the visible window. Positioned
    // in the shared ch/lh space, so they scroll with the text.
    const guideEls = [];
    for (const g of computeIndentGuides(visibleIndents, tabWidth)) {
      const guide = el('div', 'editor-indent-guide');
      // Rainbow by nesting level (col / tabWidth), cycling every 6 — the
      // colours live in CSS so the palette stays themeable.
      const level = Math.max(1, Math.round(g.col / tabWidth));
      guide.classList.add(`editor-indent-guide-c${(level - 1) % 6}`);
      guide.style.left = `${g.col}ch`;
      guide.style.top = `calc(${firstRow + g.start} * 1lh)`;
      guide.style.height = `calc(${g.end - g.start + 1} * 1lh)`;
      guideEls.push(guide);
    }
    indentGuideLayer.replaceChildren(...guideEls);
    // Pills first, then chevrons on top (a chevron sits at the top of
    // its pill on the header row and must stay the clickable element).
    // Keep `gutterStickyLayer` in the list: it is a `position: sticky`
    // sibling that holds the pinned sticky-header line numbers, and
    // omitting it here would detach it (so the numbers would scroll away
    // with the rest of the gutter instead of staying pinned).
    gutter.replaceChildren(...numberEls, ...pillEls, ...chevronEls, gutterStickyLayer);

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

  /** Paint the face-tagged decoration boxes (snippet fields + mirrors).
   *  Recomputed from live offsets every render, so the boxes track the
   *  buffer as it changes; the host supplies the ranges and faces. */
  function renderDecorations() {
    let ranges;
    try {
      ranges = getDecorations();
    } catch {
      // A decoration-supplier error must never break rendering — drop
      // the boxes for this frame and carry on.
      ranges = [];
    }
    if (!Array.isArray(ranges) || ranges.length === 0) {
      if (decorationLayer.firstChild) decorationLayer.replaceChildren();
      return;
    }
    const rects = decorationRects(activeBuffer, ranges, getTabWidth());
    decorationLayer.replaceChildren(
      ...rects
        .map((rect) => {
          const row = rowOf(rect.line);
          if (row === -1) return null;
          const span = rect.toColumn - rect.fromColumn;
          const box = el('div', `editor-decoration tok-${rect.face}`);
          // Inflate the box a sliver on each side (PAD) so the rounded
          // pill has horizontal breathing room around the glyphs rather
          // than clipping them at the rounded ends.
          const PAD = '0.18em';
          box.style.left = `calc(${rect.fromColumn} * 1ch - ${PAD})`;
          box.style.top = `calc(${row} * 1lh)`;
          // A zero-width field (empty default) still gets a thin marker
          // so the user can see where it is; otherwise width tracks the
          // span, plus a sliver when the box runs past the line's end.
          if (span <= 0) {
            box.style.width = `calc(0.5ch + 2 * ${PAD})`;
            box.classList.add('is-empty');
          } else {
            const base = rect.toLineEnd
              ? `${span} * 1ch + 0.5ch`
              : `${span} * 1ch`;
            box.style.width = `calc(${base} + 2 * ${PAD})`;
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
      activeLanguage()
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
    // Caret x: the cheap grid value, unless the caret's line contains a
    // wide (CJK / fullwidth / emoji) glyph — those render narrower than the
    // grid's two-columns-per-char assumption, so measure the real x from
    // the rendered DOM, the way the caret sits at the glyph's advance edge
    // for ASCII. The querySelector + textContent check are cheap; the
    // measuring reflow only happens on wide-char lines.
    let caretLeft = xForColumn(primaryPos.line, primaryPos.column);
    const caretLineEl = linesEl.querySelector(
      `.editor-line[data-line="${primaryPos.line}"]`
    );
    // A line with inline widgets (math preview) is already positioned by
    // columnToXPx, which subtracts each widget's real width — do NOT re-measure
    // from the DOM there. measureCaretXPxIn walks the line's text nodes counting
    // characters, but a MathJax widget carries a hidden assistive-MathML copy of
    // the formula whose (math-italic Unicode) text both trips `hasWide` and gets
    // counted, so a source column mis-maps to the wrong DOM offset — the caret
    // drifts a few glyphs and shifts on re-render. The DOM measurement is only
    // for wide (CJK / emoji) glyphs on widget-free lines.
    if (
      caretLineEl &&
      !inlineWidgetsByLine.has(primaryPos.line) &&
      hasWide(caretLineEl.textContent)
    ) {
      const caretPoint = cursors[0] ? cursors[0].point : 0;
      const caretCol = activeBuffer.positionAt(caretPoint).column;
      const measured = measureCaretXPxIn(caretLineEl, caretCol);
      if (measured !== null) caretLeft = `${measured}px`;
    }
    cursorEl.style.left = caretLeft;
    cursorEl.style.top = `calc(${primaryDisplayRow} * 1lh)`;
    // Keep the IME sink over the caret so the candidate window opens at
    // the cursor, not the editor corner.
    input.style.left = cursorEl.style.left;
    input.style.top = cursorEl.style.top;
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
    // Scope to `.editor-line-no` — the gutter also holds fold chevrons
    // and range pills (which carry their own `data-line`).
    for (const numberEl of gutter.querySelectorAll('.editor-line-no')) {
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
  // WHICH follow renders actually scroll the caret into view: only when the
  // caret may have moved. A real edit or a switch/reveal forces it; otherwise
  // the follow is gated on the offset having changed since the last follow, so
  // a pure repaint (an overlay refresh, a redundant server view/cursor
  // reconcile, a status tick) preserves a viewport the user scrolled away from
  // instead of yanking it back to the caret (the "autosave scrolls my editor"
  // bug). See follow-cursor.js.
  const followTracker = createFollowTracker();
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
    // The render loop is the editor's heartbeat — a throw here (a bad
    // highlighter, a widget factory that blew up, a malformed overlay)
    // must never stop repaint. Try the full render; on a throw, retry
    // this frame *degraded* (plain text, no highlight, no widgets) so the
    // visible text still paints, and report once. The degrade is
    // per-frame, so highlighting returns the moment the offending content
    // is edited away.
    renderDegraded = false;
    try {
      renderLines();
    } catch (error) {
      reportRenderError(error);
      renderDegraded = true;
      try {
        renderLines();
      } catch {
        // Even the plain path failed — leave the lines as-is; the cursor
        // and selection below still run, and the rAF loop stays alive.
      }
      renderDegraded = false;
    }
    // Sticky code-structure headers — reuses the fold index and highlight
    // cache `renderLines` just refreshed. Isolated so a throw here can't
    // stop the cursor from tracking.
    try {
      renderStickyHeaders();
    } catch (error) {
      reportRenderError(error);
    }
    // Snippet field / mirror decorations — a main-side pass the branch
    // predates. Isolated like the passes below so a bad decoration can't
    // stop the cursor from tracking.
    try {
      renderDecorations();
    } catch (error) {
      reportRenderError(error);
    }
    // Isolate the remaining passes so one failing can't stop the others —
    // the cursor must keep tracking even if selection/brackets throw.
    try {
      renderSelection();
    } catch (error) {
      reportRenderError(error);
    }
    try {
      renderBrackets();
    } catch (error) {
      reportRenderError(error);
    }
    try {
      renderCursor();
      // Scroll handling, after the cursor has been repositioned. A pending
      // recenter takes precedence over follow-cursor: centre the line and
      // drop the edge-nudge that would otherwise override it.
      if (pendingRecenter) {
        pendingRecenter = false;
        followCursor = false;
        followTracker.recentered(getPoint());
        cursorEl.scrollIntoView({ block: 'center', inline: 'nearest' });
      } else if (followCursor) {
        followCursor = false;
        // Follow only when the caret moved since the last follow, a real edit
        // forced it, or a switch/reveal did. Otherwise this is a pure repaint
        // (an overlay refresh, a redundant view/cursor reconcile) — leave the
        // user's scroll where it is. `scrollIntoView({block:'nearest'})` is
        // already a no-op when the caret is on screen, so this only changes
        // the scrolled-away case, which is exactly the yank we must not do.
        if (followTracker.shouldScroll(getPoint())) {
          cursorEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      if (pendingFlash) {
        pendingFlash = false;
        paintLineFlash();
      }
    } catch (error) {
      reportRenderError(error);
    }
  }

  /** Mark the view dirty and ensure a render is scheduled. */
  function schedule() {
    if (dirty) return;
    dirty = true;
    frame = win.requestAnimationFrame(render);
  }

  /** Schedule a render that keeps the cursor on screen. A real text edit
   *  (`event.change` non-null) FORCES the follow — Emacs keeps the caret
   *  visible on self-insert / delete even when the offset itself did not
   *  advance. A change-less event (an overlay refresh, a cursor-only adopt)
   *  does not force it, so the follow is gated on the caret actually having
   *  moved and a decoration repaint never yanks a scrolled-away viewport. */
  function scheduleFollowingCursor(event) {
    if (event && event.change !== null) followTracker.forceOnce();
    followCursor = true;
    schedule();
  }

  let unsubscribe = activeBuffer.onChange(scheduleFollowingCursor);

  // Re-render when the editor's own box changes — the utility dock
  // hiding/showing, a splitter drag, the OS window resizing. The render
  // window (renderLines) is sized from the root's clientHeight, so a
  // grow exposes rows the last render never drew; without this they
  // stay blank until the next scroll/edit. Guarded for the node test
  // environment, which has no ResizeObserver.
  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  if (resizeObserver) resizeObserver.observe(root);

  // Key handling: use the host's dispatcher when given (the editor's
  // Lisp keymap), otherwise fall back to the renderer's built-in keymap
  // so the view stays usable on its own.
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  root.addEventListener('keydown', (event) => {
    // A bare modifier press (Shift, Control, …) is not a key in its own
    // right — dispatching it would, e.g., feed "S-shift" to a pending
    // key reader. Wait for the real key.
    if (MODIFIER_KEYS.has(event.key)) return;
    // While an IME is composing, let it handle the key — don't dispatch to
    // the editor keymap (which would self-insert the raw keys or fire
    // commands mid-composition). `isComposing` covers the composition;
    // keyCode 229 is the IME "still processing" sentinel that also covers
    // the first keydown of a composition, before `isComposing` flips.
    if (composing || event.isComposing || event.keyCode === 229) return;
    const keyString = keyEventToString(event);
    const barePrintable = [...keyString].length === 1;
    // macOS press-and-hold: a HELD bare printable must NOT repeat-insert — the
    // OS opens the accent chooser instead. Navigation / editing keys (arrows,
    // Backspace, …) keep auto-repeating. Suppressing the repeat also keeps the
    // caret — and the IME sink positioned over it — put, so the chooser opens at
    // the caret instead of wherever a runaway repeat dragged it.
    if (event.repeat && barePrintable) return;
    // Drop the char the PREVIOUS keystroke left in the sink (we no longer clear
    // it on `input`, so a held base char survives for the OS accent
    // composition). This key's own char is inserted into the sink by the
    // browser AFTER this handler returns, so the sink ends holding just it.
    if (input.value !== '') input.value = '';
    let handled = onKey
      ? onKey(keyString)
      : handleKeyEvent(activeBuffer, event);
    // An unbound Option chord that composed a printable character
    // (curly quotes, accents) self-inserts the composed character — a
    // bound `A-…` chord above wins, so users can still bind Option keys.
    if (!handled && onKey && altComposedInsert(event)) {
      handled = onKey(event.key);
    }
    // Do NOT preventDefault a bare printable. Marking the key "handled" tells
    // Chromium to swallow it, which SUPPRESSES the native macOS press-and-hold
    // accent COMPOSITION — the popup then detaches to the window corner and a
    // number-select types the digit instead of picking the accent. We already
    // self-inserted the char via onKey (through the keymap, so auto-pair /
    // electric keys still fire); the stray copy that lands in the hidden sink is
    // dropped by the sink's `input` handler. Command keys, chords and named keys
    // (Enter / Tab / Space / …) are still preventDefaulted so the textarea sink
    // never acts on them.
    if (handled && !barePrintable) event.preventDefault();
    // Remember a just-typed bare printable as a possible accent BASE char (for a
    // press-and-hold composition that may open next); any OTHER handled key
    // clears the candidacy. A suppressed repeat returned above, so the flag
    // survives the hold.
    printableBaseCandidate = handled && barePrintable;
  });

  // Scrolling changes which lines are visible — re-render the window.
  root.addEventListener('scroll', schedule);
  // Mouse: click to place the cursor, drag to select.
  //
  // The row comes from the y through the line grid (folding-aware). The
  // column comes from the x: when the line's rendered DOM mirrors its
  // source text exactly, the browser's own caret hit-testing
  // (`columnFromCaret`) maps the click precisely for any glyph width —
  // proportional fallback glyphs (IPA, emoji), wide CJK, tabs. Otherwise
  // (a math widget, a folded preview, or no native caret API) it falls
  // back to the monospace `charWidth()` grid.
  function offsetFromPoint(clientX, clientY) {
    const box = content.getBoundingClientRect();
    const lineHeight = cursorEl.getBoundingClientRect().height || 22;
    const row = Math.max(0, Math.floor((clientY - box.top) / lineHeight));
    const line = lineForDisplayRow(row);
    const px = clientX - box.left;
    if (inlineWidgetsByLine.has(line)) {
      // On a line with inline math widgets, invert the measured layout so
      // a click past the (narrow) typeset math lands on the right offset.
      return activeBuffer.offsetAt(line, xPxToColumn(line, px));
    }
    // Precise path: hit-test against the actual rendered glyphs. Exact
    // where the fixed-width grid drifts (a proportional fallback glyph
    // mid-line skews the global `charWidth()` average, landing point in
    // the wrong column — the reported `<p class='fragment'>` bug).
    const caretCol = columnFromCaret(line, clientX);
    if (caretCol !== null) return activeBuffer.offsetAt(line, caretCol);
    // Fallback: the monospace grid. x → visual column, visual column →
    // character index. Tabs span multiple visual columns, so clicking
    // past a tab needs the inverse-tab-stop math (charIndexAtVisualColumn)
    // to land on the right insertion point.
    const visCol = Math.max(0, Math.round(px / charWidth()));
    const tabW = getTabWidth();
    let column = visCol;
    if (tabW > 0) {
      const lineMeta = activeBuffer.lineAt(activeBuffer.offsetAt(line, 0));
      const lineText = typeof lineMeta.text === 'string'
        ? lineMeta.text
        : activeBuffer.slice(lineMeta.from, lineMeta.to);
      column = charIndexAtVisualColumn(lineText, visCol, tabW);
    }
    return activeBuffer.offsetAt(line, column);
  }

  /**
   * Map a click x on buffer LINE to a source column via the browser's
   * native caret hit-testing — exact for any glyph width. Guarded: only
   * fires when the rendered line element's `textContent` equals the
   * buffer line text, so a math-widget line or a folded-header preview
   * (whose DOM deliberately differs from the source) falls through to
   * the grid estimate instead. Returns the column, or `null` to mean
   * "fall back": line element absent, DOM differs from source, no native
   * caret API, or the resolved caret lands outside the line.
   *
   * @param {number} line
   * @param {number} clientX
   * @returns {number | null}
   */
  function columnFromCaret(line, clientX) {
    const lineEl = linesEl.querySelector(
      `.editor-line[data-line="${line}"]`
    );
    if (!lineEl || lineEl.querySelector('.math-widget')) return null;
    const lineMeta = activeBuffer.lineAt(activeBuffer.offsetAt(line, 0));
    const lineText = typeof lineMeta.text === 'string'
      ? lineMeta.text
      : activeBuffer.slice(lineMeta.from, lineMeta.to);
    if (lineEl.textContent !== lineText) return null;
    const rect = lineEl.getBoundingClientRect();
    // Probe at the line's vertical centre: the row is already fixed from
    // y, so only x should steer the hit-test — this keeps the native
    // resolution on THIS line even if y sat near a row boundary.
    const caret = caretPositionAt(clientX, rect.top + rect.height / 2);
    if (!caret || !lineEl.contains(caret.node)) return null;
    const range = doc.createRange();
    range.selectNodeContents(lineEl);
    try {
      range.setEnd(caret.node, caret.offset);
    } catch {
      return null;
    }
    return range.toString().length;
  }

  /** Native caret hit-test, normalised across the two browser APIs to
   *  `{ node, offset }` (or null). Electron/Chromium has the legacy
   *  `caretRangeFromPoint`; `caretPositionFromPoint` is the standard
   *  spelling, kept as a fallback. */
  function caretPositionAt(x, y) {
    if (typeof doc.caretRangeFromPoint === 'function') {
      const r = doc.caretRangeFromPoint(x, y);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    if (typeof doc.caretPositionFromPoint === 'function') {
      const p = doc.caretPositionFromPoint(x, y);
      if (p) return { node: p.offsetNode, offset: p.offset };
    }
    return null;
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

  // --- sticky code-structure headers ------------------------------------

  /**
   * Pin the chain of open enclosing elements at the top of the viewport
   * (sticky scroll). Runs after `renderLines`, reusing the fold index and
   * highlight cache it just refreshed. For an enabled language, the buffer
   * line at the viewport top determines its enclosing fold ranges
   * (`enclosingFolds`); each range's header line is drawn as a pinned row
   * — its line number in the gutter anchor, its highlighted text in the
   * content anchor — stacked outermost-first. Both anchors are
   * `position: sticky; top: 0` so the browser holds them in place; this
   * pass only rebuilds *which* lines they show, on scroll and on edit.
   */
  function renderStickyHeaders() {
    const clearSticky = () => {
      if (contentStickyLayer.firstChild) contentStickyLayer.replaceChildren();
      if (gutterStickyLayer.firstChild) gutterStickyLayer.replaceChildren();
    };
    const language = activeLanguage();
    if (!stickyHeaderLanguages.has(language) || !displayRowForLine) {
      clearSticky();
      return;
    }
    const lineHeight = cursorEl.getBoundingClientRect().height || 22;
    const scrollTop = root.scrollTop;
    const topRow = Math.floor(scrollTop / lineHeight);
    // Candidate scopes for the panel, in display-row space: every fold still
    // open at the viewport top (its end at or below the top) whose header is
    // at or just below the top. The small look-ahead below the top lets a
    // scope stick the instant its header meets the bottom of the stack rather
    // than a row after it has slid behind the panel; `stickyHeaderRows` makes
    // the final per-slot call. Folded-away headers (display row -1) drop out.
    const scopes = [];
    for (const [startLine, endLine] of foldCache.endByStart) {
      const startRow = rowOf(startLine);
      const endRow = rowOf(endLine);
      if (startRow < 0 || endRow < topRow) continue;
      if (startRow > topRow + STICKY_LOOKAHEAD) continue;
      scopes.push({ startLine, startRow, endRow });
    }
    scopes.sort((a, b) => a.startRow - b.startRow || a.startLine - b.startLine);
    const layout = stickyHeaderRows(scopes, scrollTop, lineHeight);
    if (layout.length === 0) {
      clearSticky();
      return;
    }
    const lines = toLines(activeBuffer.text);
    // The highlight cache holds per-line runs for these (tree-sitter) modes;
    // fall back to a per-line tokenise if it is somehow absent (e.g. a
    // degraded frame, or a hand-tokenised language like latex/jmarkdown).
    const perLine = highlightCache;
    const rows = doc.createDocumentFragment();
    const numbers = doc.createDocumentFragment();
    const n = layout.length;
    layout.forEach(({ startLine: bufLine, y }, i) => {
      const top = `${y}px`;
      // Outer headers paint above inner ones, so the deepest header tucks
      // *behind* its ancestors as it slides up and out.
      const z = String(n - i);

      const numberRow = el('div', 'editor-gutter-sticky-row');
      numberRow.style.top = top;
      numberRow.style.zIndex = z;
      const numberEl = el('div', 'editor-line-no');
      numberEl.textContent = String(bufLine + 1);
      numberRow.append(numberEl);
      numbers.append(numberRow);

      const rowEl = el('div', 'editor-line editor-sticky-line');
      rowEl.style.top = top;
      rowEl.style.zIndex = z;
      rowEl.dataset.line = String(bufLine);
      if (i === n - 1) rowEl.classList.add('is-deepest');
      const text = lines[bufLine] ? lines[bufLine].content : '';
      const runs =
        perLine && perLine[bufLine] ? perLine[bufLine] : highlightLine(text, language);
      renderRuns(rowEl, runs);
      // Click a header to jump to it (mousedown, so it beats the editor's
      // own click-to-place-point on the obscured line beneath).
      rowEl.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        jumpToStickyHeader(bufLine);
      });
      rows.append(rowEl);
    });
    contentStickyLayer.replaceChildren(rows);
    gutterStickyLayer.replaceChildren(numbers);
  }

  /**
   * Scroll a clicked sticky header into view, landing it just below its
   * own pinned ancestors (so the line you clicked is the first one not
   * covered by the remaining stack), and reveal it if it sits inside a
   * collapsed fold.
   *
   * @param {number} bufLine
   */
  function jumpToStickyHeader(bufLine) {
    const folded = foldsFor(activeBuffer);
    for (const start of foldsHidingLine(
      bufLine,
      folded,
      foldCache.endByStart,
      foldCache.blockByStart
    )) {
      folded.delete(start);
    }
    const lineHeight = cursorEl.getBoundingClientRect().height || 22;
    const ancestors = enclosingFolds(bufLine, foldCache.endByStart).length;
    root.scrollTop = Math.max(0, (rowOf(bufLine) - ancestors) * lineHeight);
    schedule();
  }

  // --- folding controls -------------------------------------------------
  // The view owns the per-buffer fold state. The host's Lisp keymap
  // routes the `C-c TAB` / `C-c C-,` / `C-c C-.` commands through
  // `toggleFoldAtPoint` / `foldAll` / `unfoldAll`.

  /**
   * Cross-highlight a fold range's gutter elements. The chevron and the
   * range pill for the same header both carry `data-fold-start`, so
   * hovering either one brightens both — "highlight to indicate the
   * relevant range". Re-wired per render (the gutter is rebuilt each
   * frame); transient `:hover`-style state, no cleanup needed.
   *
   * @param {HTMLElement} elem
   * @param {number} startLine
   */
  function wireRangeHover(elem, startLine) {
    const key = String(startLine);
    elem.dataset.foldStart = key;
    const set = (on) => {
      for (const sib of gutter.querySelectorAll(
        `[data-fold-start="${key}"]`
      )) {
        sib.classList.toggle('is-range-active', on);
      }
    };
    elem.addEventListener('mouseenter', () => set(true));
    elem.addEventListener('mouseleave', () => set(false));
  }

  /** True if the fold headed by `start` hides buffer position
   *  (`line`, `column`): a line strictly inside the range, or — for an
   *  inner (column-aware) fold — the header line at or past the opening
   *  delimiter (where the content collapses behind the `…`). */
  function foldHidesPoint(start, line, column) {
    const end = foldCache.endByStart.get(start);
    if (typeof end !== 'number') return false;
    if (line > start && line <= end) return true;
    const cut = foldCache.cutByStart.get(start);
    return !!(
      cut &&
      cut.headerCol !== undefined &&
      line === start &&
      column >= cut.headerCol
    );
  }

  /** The offset to land point on just past the fold headed by `start` —
   *  the start of the first line below the range. When the range ends the
   *  buffer (no line below), fall back to the fold point on the header
   *  line itself. */
  function offsetPastFold(start) {
    const end = foldCache.endByStart.get(start);
    if (end + 1 <= activeBuffer.lineCount - 1) {
      return activeBuffer.offsetAt(end + 1, 0);
    }
    const cut = foldCache.cutByStart.get(start);
    return activeBuffer.offsetAt(start, cut?.headerCol ?? 0);
  }

  /** When a fold closes over point, drop point just after the folded
   *  element so the caret isn't stranded in (now-hidden) content — the
   *  editor's chosen behaviour. No-op when point is already outside the
   *  range. */
  function escapeFoldedPoint(start) {
    const { line, column } = activeBuffer.positionAt(getPoint());
    if (foldHidesPoint(start, line, column)) {
      activeBuffer.moveTo(offsetPastFold(start));
    }
  }

  /** Auto-unfold any fold whose collapsed interior a cursor has moved into,
   *  so navigating into a folded region opens it instead of stranding the
   *  caret on the header. Mutates the `folded` set in place; returns whether
   *  it changed anything. Called from renderLines before the hidden set is
   *  computed, so the same render shows the revealed lines. (Folding leaves
   *  point on the line past the fold — escapeFoldedPoint / offsetPastFold —
   *  so collapsing never trips this and instantly re-opens.) */
  function revealFoldsAtPoint(folded) {
    if (folded.size === 0) return false;
    let changed = false;
    for (const cursor of getCursors()) {
      const { line } = activeBuffer.positionAt(cursor.point);
      for (const start of foldsHidingLine(
        line, folded, foldCache.endByStart, foldCache.blockByStart
      )) {
        if (folded.delete(start)) changed = true;
      }
    }
    return changed;
  }

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
      escapeFoldedPoint(line);
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
    if (changed) {
      // Drop point past the outermost fold it now sits in, so the caret
      // isn't stranded in hidden content.
      const { line, column } = activeBuffer.positionAt(getPoint());
      let outerStart = -1;
      let outerEnd = -1;
      for (const start of foldCache.headers) {
        const end = foldCache.endByStart.get(start);
        if (foldHidesPoint(start, line, column) && end > outerEnd) {
          outerEnd = end;
          outerStart = start;
        }
      }
      if (outerStart >= 0) activeBuffer.moveTo(offsetPastFold(outerStart));
      schedule();
    }
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
    focusInput();
    // A click moves the caret away from a just-typed printable, so it is no
    // longer an accent base char for a press-and-hold composition.
    printableBaseCandidate = false;
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
  focusInput();

  return {
    element: root,
    backgroundLayer,
    overlayLayer,

    /** The whole-buffer per-line highlight runs (`Run[][]`) currently
     *  cached, or null when none is built (degraded render). Exposed so a
     *  companion view (the minimap) can reuse the exact token colouring the
     *  editor computed — including tree-sitter languages — instead of
     *  re-tokenising. Read-only; the cache is owned by `renderLines`. */
    lineRuns() {
      return highlightCache;
    },

    /** The structural fold scopes — `{ startLine, endLine }` per foldable
     *  construct (function / block / section / element). Exposed so the
     *  minimap can highlight the extent of the construct under the pointer.
     *  Read-only snapshot of the current fold index. */
    foldScopes() {
      if (!foldCache || !foldCache.endByStart) return [];
      return [...foldCache.endByStart].map(([startLine, endLine]) => ({
        startLine,
        endLine,
      }));
    },

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

    /** Force a re-render on the next frame without moving the cursor or
     *  scroll. For hosts that change a replaced-range widget's content
     *  out of band (e.g. the notebook view, when a cell finishes running)
     *  and need the widget layer to re-mount — there is no buffer edit to
     *  trigger the usual onChange-driven render. */
    refresh() {
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
    setView(next, options = {}) {
      const nextBuffer = next && next.buffer ? next.buffer : null;
      if (nextBuffer === null) {
        // Defensive: a non-text view should never reach here; the
        // host's mount dispatch routes elsewhere. No-op rather than crash.
        return;
      }
      const bufferChanged = nextBuffer !== activeBuffer;
      if (bufferChanged) {
        unsubscribe();
        activeBuffer = nextBuffer;
        unsubscribe = activeBuffer.onChange(scheduleFollowingCursor);
      }
      // Always render, even when the buffer is unchanged: switchToView
      // is called when the view is mounted again after a hidden spell,
      // and any render that fired while the view was hidden produced a
      // 0-height layout. The reveal pass redraws against the real
      // viewport.
      //
      // A switch / reveal (the default) FORCES the follow so the target's
      // caret is shown. A server-driven reconcile passes `followMode: 'auto'`:
      // then the follow is gated on the caret actually having moved, so a
      // repaint that left the caret put (an overlay update, a redundant
      // view/cursor message) preserves the user's scroll instead of yanking
      // it back. A switch to a DIFFERENT buffer always forces (its caret may
      // sit at the same numeric offset yet be off-screen).
      if (options.followMode !== 'auto' || bufferChanged) followTracker.forceOnce();
      followCursor = true;
      render();
    },

    focus: () => focusInput(),

    destroy: () => {
      unsubscribe();
      endDrag();
      if (resizeObserver) resizeObserver.disconnect();
      if (frame) win.cancelAnimationFrame(frame);
      root.remove();
    },
  };
}
