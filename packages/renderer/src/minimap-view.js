/**
 * @file `<minimap-view>` — a Nova / VS Code-style minimap companion view.
 *
 * A minimap is a tiny zoomed-out rendering of a text document, shown in a
 * narrow pane beside the editor. It mirrors the editor's scroll position
 * (a translucent "thumb" marks the visible region) and is click/drag-able
 * to navigate. Each source line is drawn as a thin row of colored segments
 * — one rect per syntax token, indentation preserved, colored by the same
 * theme faces the editor uses — so the minimap reads as recognizable code
 * shape rather than legible text.
 *
 * This element is a **dumb renderer**: it never reaches into the editor's
 * internals. The host (`apps/desktop/src/app.js`) resolves the target
 * leaf's *currently active* text content and hands this element a
 * **target adapter** via {@link MinimapView#bindTarget}:
 *
 *   {
 *     buffer, language,
 *     getLineRuns(): Run[][] | null,   // the editor's whole-buffer highlight,
 *                                      // reused for accurate colours; null →
 *                                      // we tokenise per line ourselves
 *     getMetrics(): { scrollTop, viewportHeight, contentHeight, lineHeight },
 *     onScroll(cb): unsubscribe,       // editor scroll-root 'scroll'
 *     onChange(cb): unsubscribe,       // buffer.onChange
 *     scrollToContentFraction(f),      // navigate the editor
 *   }
 *
 * `bindTarget(null)` shows "Minimap not supported for this view" (the
 * active content isn't a text view). The element owns its subscriptions:
 * each `bindTarget` tears the previous ones down first, so there are no
 * leaks across tab switches, tab closes, or editor-instance replacement.
 *
 * Nova-style scaling: each source line gets a fixed minimap height
 * ({@link MM_LINE_H}); when the document is taller than the minimap, the
 * minimap itself scrolls (driven by the editor's scroll fraction) so the
 * thumb stays in view. Short documents show whole, with no minimap scroll.
 *
 * See `plans/` (the minimap plan) and `docs/VIEWS.md` for the view-kind
 * contract this follows (`placeholder-view.js` is the closest template).
 */

import { defineViewElement, ViewElement } from './view-elements.js';
import { highlightLine, languageForName } from './highlight.js';

/** Pixels per source line in the minimap (the fixed Nova-style density). */
const MM_LINE_H = 3;
/** Pixels per character column. Each character is drawn as a 1-column mark
 *  whose fill alpha tracks the character's ink density (see charCoverage),
 *  so the row reads as text-like variation rather than a flat token bar. */
const MM_CHAR_W = 1;
/** Columns past which a line's drawn width is clamped (long lines don't
 *  blow out the minimap horizontally). */
const MM_MAX_COLS = 140;
/** Tab width in columns for indentation (minimap is approximate; the editor
 *  owns the real `tab-width`). */
const MM_TAB_W = 4;
/** Indentation is *compressed* (not removed) so deeply-nested code — HTML,
 *  say — doesn't waste the panel on leading whitespace. Each indent column
 *  costs INDENT_SCALE of a column, capped at MAX_INDENT_COLS, so nesting
 *  stays monotonic (deeper = further right) without the runaway. */
const INDENT_SCALE = 0.4;
const MAX_INDENT_COLS = 14;
/** Debounce for repainting the document bitmap after an edit. */
const EDIT_DEBOUNCE_MS = 60;
/** Minimum thumb height so it stays grabbable on huge files. */
const MIN_THUMB_PX = 8;

// --- pure geometry helpers (exported for unit tests) -------------------

/** Clamp X into [0, 1]. */
export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The editor's scroll position as a fraction of its scrollable range.
 * Returns 0 when the document fits the viewport (no scrollable range).
 *
 * @param {number} scrollTop
 * @param {number} contentHeight
 * @param {number} viewportHeight
 * @returns {number} in [0, 1]
 */
export function scrollTopToContentFraction(scrollTop, contentHeight, viewportHeight) {
  const range = contentHeight - viewportHeight;
  if (range <= 0) return 0;
  return clamp01(scrollTop / range);
}

/**
 * Inverse of {@link scrollTopToContentFraction}: a scroll fraction back to
 * an editor scrollTop.
 *
 * @param {number} f in [0, 1]
 * @param {number} contentHeight
 * @param {number} viewportHeight
 * @returns {number}
 */
export function contentFractionToScrollTop(f, contentHeight, viewportHeight) {
  const range = Math.max(0, contentHeight - viewportHeight);
  return clamp01(f) * range;
}

/**
 * The minimap's own scroll offset and the thumb (viewport indicator) rect,
 * all in minimap pixel space. Everything is driven by the editor's scroll
 * fraction, so it stays consistent under folding (the editor's
 * `contentHeight` already accounts for collapsed rows).
 *
 * @param {{scrollTop:number, viewportHeight:number, contentHeight:number}} metrics
 * @param {number} mmContentH - total minimap document height (lineCount * MM_LINE_H)
 * @param {number} mmViewportH - the minimap canvas's visible pixel height
 * @returns {{ mmScrollTop:number, thumbTop:number, thumbHeight:number }}
 *   `thumbTop` is in screen space (relative to the canvas top).
 */
export function thumbRect(metrics, mmContentH, mmViewportH) {
  const { scrollTop, viewportHeight, contentHeight } = metrics;
  const f = scrollTopToContentFraction(scrollTop, contentHeight, viewportHeight);
  const mmScrollTop = mmContentH > mmViewportH ? f * (mmContentH - mmViewportH) : 0;
  const visibleFrac = contentHeight > 0 ? Math.min(1, viewportHeight / contentHeight) : 1;
  const thumbHeight = Math.max(MIN_THUMB_PX, visibleFrac * mmContentH);
  const thumbTopContent = (contentHeight > 0 ? scrollTop / contentHeight : 0) * mmContentH;
  return { mmScrollTop, thumbTop: thumbTopContent - mmScrollTop, thumbHeight };
}

/**
 * A click/drag at minimap-screen-y → the editor scroll fraction that
 * *centers* the clicked document position in the editor viewport.
 *
 * @param {number} clickY - y on the minimap canvas, in px
 * @param {number} mmScrollTop - the minimap's current scroll offset
 * @param {number} mmContentH - total minimap document height
 * @param {{contentHeight:number, viewportHeight:number}} metrics
 * @returns {number} scroll fraction in [0, 1]
 */
export function clickToScrollFraction(clickY, mmScrollTop, mmContentH, metrics) {
  const { contentHeight, viewportHeight } = metrics;
  const range = contentHeight - viewportHeight;
  if (range <= 0 || mmContentH <= 0) return 0;
  const docFraction = clamp01((clickY + mmScrollTop) / mmContentH);
  const targetTop = docFraction * contentHeight - viewportHeight / 2;
  return clamp01(targetTop / range);
}

/**
 * Parse a CSS `rgb(...)` / `rgba(...)` color string into `[r, g, b]`
 * (0–255), or null if it doesn't look like one. Tolerant of spaces and an
 * alpha component.
 *
 * @param {string} str
 * @returns {[number, number, number] | null}
 */
export function parseRgb(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/rg?b?a?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!m) return null;
  return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
}

/**
 * The leading-whitespace width of a line, in columns (tabs count as
 * `tabW`), summed across its runs — i.e. its indentation. Returns the full
 * width for an all-whitespace line.
 *
 * @param {Array<{text:string, face:(string|null)}>} runs
 * @param {number} tabW - tab width in columns
 * @returns {number}
 */
export function leadingIndentCols(runs, tabW) {
  if (!Array.isArray(runs)) return 0;
  let cols = 0;
  for (const run of runs) {
    const text = (run && run.text) || '';
    for (const ch of text) {
      if (ch === ' ') cols += 1;
      else if (ch === '\t') cols += tabW;
      else return cols;
    }
  }
  return cols; // an all-whitespace line
}

/**
 * Compress an indent of INDENTCOLS columns to a (possibly fractional)
 * starting column: `min(maxCols, indentCols * scale)`. Monotonic, so
 * deeper nesting still starts further right — it just costs less, and is
 * capped so extreme depth can't push content off-panel. Zero stays zero.
 *
 * @param {number} indentCols
 * @param {number} scale - fraction of a column per indent column (0..1)
 * @param {number} maxCols - cap on the compressed indent
 * @returns {number}
 */
export function compressIndent(indentCols, scale, maxCols) {
  if (!(indentCols > 0)) return 0;
  return Math.min(maxCols, indentCols * scale);
}

/**
 * A character's ink density in [0, 1] — how much of a cell it fills.
 * Whitespace is 0; sparse glyphs (`.`, `i`, `|`) are low; dense ones
 * (`M`, `@`, `#`) are high. Used to modulate each character's fill alpha so
 * the minimap row varies like real text instead of a flat bar (the
 * "pixelated charsheet" trick, reduced to a single coverage value per
 * char — enough at 1px width).
 *
 * @param {string} ch - a single character
 * @returns {number}
 */
export function charCoverage(ch) {
  if (ch === ' ' || ch === '\t' || ch === '' || ch === undefined) return 0;
  if (ch.charCodeAt(0) < 33) return 0; // control chars
  if ('@#$%&MWBNQRGHmw8'.includes(ch)) return 1;
  if (/[A-Z0-9]/.test(ch)) return 0.85;
  if ('.,\'`:;'.includes(ch)) return 0.3;
  if ('ilI|!()[]{}-_'.includes(ch)) return 0.45;
  return 0.65; // most lowercase + punctuation
}

/**
 * The innermost fold scope containing LINE — the smallest `{startLine,
 * endLine}` with `startLine <= line <= endLine`. Null when none contains it.
 * This is the "relevant construct" whose extent the hover highlights.
 *
 * @param {number} line
 * @param {Array<{startLine:number, endLine:number}>} scopes
 * @returns {{startLine:number, endLine:number} | null}
 */
export function enclosingScope(line, scopes) {
  if (!Array.isArray(scopes)) return null;
  let best = null;
  for (const s of scopes) {
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
    }
  }
  return best;
}

/**
 * The leading-whitespace prefix of a string (spaces and tabs only).
 *
 * @param {string} text
 * @returns {string}
 */
export function leadingWhitespace(text) {
  const m = /^[ \t]*/.exec(typeof text === 'string' ? text : '');
  return m ? m[0] : '';
}

/**
 * The longest leading-whitespace prefix common to every non-blank line — the
 * amount a code excerpt can be dedented without disturbing its *relative*
 * indentation. Blank / whitespace-only lines don't constrain it (they're
 * ignored). Returns '' when there's no shared indent (or no non-blank line).
 *
 * @param {string[]} lines
 * @returns {string}
 */
export function commonIndent(lines) {
  if (!Array.isArray(lines)) return '';
  let prefix = null;
  for (const line of lines) {
    const text = typeof line === 'string' ? line : '';
    if (!/\S/.test(text)) continue; // blank/whitespace-only: no constraint
    const lead = leadingWhitespace(text);
    if (prefix === null) { prefix = lead; continue; }
    let i = 0;
    const max = Math.min(prefix.length, lead.length);
    while (i < max && prefix[i] === lead[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix === '') break;
  }
  return prefix || '';
}

/**
 * Drop the first N characters from a list of `{text, face}` runs, returning a
 * new list. Runs wholly inside the dropped prefix vanish; the one straddling
 * the boundary is trimmed. Used to dedent a flyout line by an excerpt's
 * common indent while keeping each surviving run's face.
 *
 * @param {Array<{text:string, face:(string|null)}>} runs
 * @param {number} n - characters to drop from the line start
 * @returns {Array<{text:string, face:(string|null)}>}
 */
export function dropLeadingChars(runs, n) {
  if (!Array.isArray(runs)) return [];
  if (!(n > 0)) return runs.slice();
  let remaining = n;
  const out = [];
  for (const run of runs) {
    if (remaining <= 0) { out.push(run); continue; }
    const text = (run && run.text) || '';
    if (text.length <= remaining) { remaining -= text.length; continue; }
    out.push({ ...run, text: text.slice(remaining) });
    remaining = 0;
  }
  return out;
}

/** Lines above/below the hovered line shown in the code-preview flyout. */
const FLYOUT_RADIUS = 6;

// --- the custom element ------------------------------------------------

export class MinimapView extends ViewElement {
  constructor() {
    super();
    /** @type {object | null} - the minimap view object (host payload). */
    this._buffer = null;
    /** @type {object | null} - the bound target adapter. */
    this._adapter = null;
    /** @type {Array<() => void>} - adapter subscription teardowns. */
    this._unsubs = [];
    /** @type {Map<string, string>} - face name → cached fill color. */
    this._colorCache = new Map();
    /** @type {Map<string, {canvas: HTMLCanvasElement, cols: number}>} -
     *  `${color} ${char}` → a downscaled, pre-tinted glyph cell (the
     *  charsheet). Lazily filled as characters are drawn; cleared on a
     *  colour / font / DPR change. */
    this._cellCache = new Map();
    this._cellDpr = 0;
    this._dpr = 1;
    /** @type {string|null} - the editor's mono font, resolved once. */
    this._monoFont = null;
    /** @type {HTMLCanvasElement|null} - reused scratch for glyph rasterising. */
    this._scratch = null;
    this._unitAdvance = 0; // width of one Latin column at the render size
    /** @type {Array<Array<{text:string, face:(string|null)}>> | null} */
    this._runsCache = null;
    this._mounted = false;
    this._raf = 0;
    this._editTimer = 0;
    this._dragging = false;
    /** @type {HTMLCanvasElement | null} */
    this._canvas = null;
    /** @type {HTMLElement | null} */
    this._thumb = null;
    /** @type {HTMLElement | null} - the hover scope-extent band. */
    this._band = null;
    /** @type {HTMLElement | null} - the hover code-preview flyout (in body). */
    this._flyout = null;
    /** Last hovered source line, so we rebuild the band/flyout only on a
     *  line change rather than every pointer pixel. -1 = not hovering. */
    this._lastHoverLine = -1;
    /** @type {HTMLElement | null} */
    this._message = null;
    /** @type {HTMLElement | null} */
    this._probe = null;
    /** @type {ResizeObserver | null} */
    this._resizeObserver = null;
    this._options = null;
  }

  /** Host configuration. Must run before the first `connectedCallback`. */
  configure(options) {
    if (this._mounted) {
      throw new Error('MinimapView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'minimap';
  }

  /** Repoint at the minimap view object. The element carries no real
   *  payload of its own — the buffer slot only gives the host's mount
   *  dispatch something to set. The mirrored *text* arrives via
   *  {@link bindTarget}. */
  setBuffer(next) {
    this._buffer = next;
  }

  get buffer() {
    return this._buffer;
  }

  /** A minimap never takes editing focus — clicks navigate the editor and
   *  leave the keyboard where it was. */
  focus() {}

  // --- target binding -------------------------------------------------

  /**
   * Bind (or unbind) the text content this minimap mirrors. Passing `null`
   * shows the "not supported" message. Always tears down the previous
   * adapter's subscriptions first, so switching/closing tabs leaks nothing.
   *
   * @param {object | null} adapter
   */
  bindTarget(adapter) {
    this._teardownSubs();
    this._adapter = adapter ?? null;
    this._runsCache = null;
    this._hideHover(); // a new target's scopes/lines differ — recompute on hover
    if (!this._mounted) return; // painted on connectedCallback
    if (!this._adapter) {
      this._showMessage(true);
      return;
    }
    this._showMessage(false);
    const onChange = this._adapter.onChange;
    const onScroll = this._adapter.onScroll;
    if (typeof onChange === 'function') {
      this._unsubs.push(onChange(() => this._scheduleEdit()));
    }
    if (typeof onScroll === 'function') {
      this._unsubs.push(onScroll(() => this._scheduleScroll()));
    }
    this._scheduleFull();
  }

  /** Drop the cached colours + glyph charsheet and repaint. A theme/face
   *  change recolours; a font change reshapes — both invalidate the cells,
   *  and the mono font is re-resolved lazily. */
  invalidateColors() {
    this._colorCache.clear();
    this._cellCache.clear();
    this._monoFont = null;
    this._unitAdvance = 0;
    if (this._mounted && this._adapter) this._scheduleFull();
  }

  // --- lifecycle ------------------------------------------------------

  connectedCallback() {
    this._ensureMounted();
    if (this._adapter) {
      // (Re)wire subscriptions now that we're live, then paint.
      this.bindTarget(this._adapter);
    } else {
      this._showMessage(true);
    }
  }

  disconnectedCallback() {
    /* hide-not-kill: a DOM move keeps the element alive (see VIEWS.md) */
  }

  destroy() {
    this._teardownSubs();
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch { /* gone */ }
      this._resizeObserver = null;
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._editTimer) clearTimeout(this._editTimer);
    if (this._flyout) {
      try { this._flyout.remove(); } catch { /* already gone */ }
      this._flyout = null;
    }
    this._raf = 0;
    this._editTimer = 0;
    this._adapter = null;
    this._buffer = null;
    this._runsCache = null;
    this._cellCache.clear();
    this._scratch = null;
  }

  // --- internal: mount -----------------------------------------------

  _ensureMounted() {
    if (this._mounted) return;
    const doc = this.ownerDocument;
    this.classList.add('minimap-view');

    const canvas = doc.createElement('canvas');
    canvas.className = 'minimap-canvas';
    this._canvas = canvas;

    const thumb = doc.createElement('div');
    thumb.className = 'minimap-thumb';
    this._thumb = thumb;

    // The hover scope-extent band — covers the enclosing construct's lines.
    const band = doc.createElement('div');
    band.className = 'minimap-hover-band';
    band.style.display = 'none';
    this._band = band;

    const message = doc.createElement('div');
    message.className = 'minimap-message';
    message.textContent = 'Minimap not supported for this view';
    message.style.display = 'none';
    this._message = message;

    // Off-screen probe for resolving `.tok-{face}` → a concrete color.
    const probe = doc.createElement('span');
    probe.className = 'minimap-probe';
    this._probe = probe;

    this.append(canvas, thumb, band, message, probe);
    this._wireEvents();

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._scheduleFull());
      this._resizeObserver.observe(this);
    }
    this._mounted = true;
  }

  _wireEvents() {
    const canvas = /** @type {HTMLCanvasElement} */ (this._canvas);
    const navigate = (event) => {
      if (!this._adapter || typeof this._adapter.scrollToContentFraction !== 'function') {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const y = event.clientY - rect.top;
      const metrics = this._safeMetrics();
      if (!metrics) return;
      const mmContentH = this._lineCount() * MM_LINE_H;
      const { mmScrollTop } = thumbRect(metrics, mmContentH, rect.height);
      const f = clickToScrollFraction(y, mmScrollTop, mmContentH, metrics);
      this._adapter.scrollToContentFraction(f);
    };
    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this._dragging = true;
      this._hideHover(); // the preview is noise while scrubbing
      try { canvas.setPointerCapture(event.pointerId); } catch { /* ok */ }
      navigate(event);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (this._dragging) navigate(event);
      else this._onHover(event);
    });
    canvas.addEventListener('pointerleave', () => this._hideHover());
    const endDrag = () => { this._dragging = false; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
  }

  _showMessage(show) {
    if (this._message) this._message.style.display = show ? '' : 'none';
    if (this._canvas) this._canvas.style.display = show ? 'none' : '';
    if (this._thumb) this._thumb.style.display = show ? 'none' : '';
    if (show) this._hideHover();
  }

  // --- internal: hover (scope-extent band + code-preview flyout) ------

  _onHover(event) {
    if (this._dragging || !this._adapter) return;
    const canvas = /** @type {HTMLCanvasElement} */ (this._canvas);
    const rect = canvas.getBoundingClientRect();
    if (rect.height <= 0) return;
    const metrics = this._safeMetrics();
    if (!metrics) return;
    const runsPerLine = this._runsPerLine();
    const lineCount = runsPerLine.length;
    if (lineCount === 0) return;
    const mmContentH = lineCount * MM_LINE_H;
    const { mmScrollTop } = thumbRect(metrics, mmContentH, rect.height);
    const y = event.clientY - rect.top;
    const line = Math.max(0, Math.min(lineCount - 1,
      Math.floor((y + mmScrollTop) / MM_LINE_H)));
    if (line === this._lastHoverLine) {
      // Same line: just let the flyout track the cursor vertically.
      if (this._flyout && this._flyout.style.display !== 'none') {
        this._positionFlyout(this._flyout, event.clientY);
      }
      return;
    }
    this._lastHoverLine = line;
    // Scope-extent band over the enclosing construct.
    let scopes = [];
    try {
      scopes = typeof this._adapter.getFoldScopes === 'function'
        ? this._adapter.getFoldScopes()
        : [];
    } catch { scopes = []; }
    const scope = enclosingScope(line, scopes);
    if (this._band) {
      if (scope) {
        this._band.style.top = `${scope.startLine * MM_LINE_H - mmScrollTop}px`;
        this._band.style.height =
          `${(scope.endLine - scope.startLine + 1) * MM_LINE_H}px`;
        this._band.style.display = '';
      } else {
        this._band.style.display = 'none';
      }
    }
    this._renderFlyout(line, runsPerLine, event.clientY);
  }

  /** Build the code-preview flyout: a readable, syntax-highlighted slice of
   *  the lines around CENTERLINE, reusing the same `.tok-*` face classes the
   *  editor uses (so the theme colours it). */
  _renderFlyout(centerLine, runsPerLine, clientY) {
    const total = runsPerLine.length;
    if (total === 0) { this._hideFlyout(); return; }
    const doc = this.ownerDocument;
    const first = Math.max(0, centerLine - FLYOUT_RADIUS);
    const last = Math.min(total - 1, centerLine + FLYOUT_RADIUS);
    // The preview is narrow where the editor is wide, so dedent the excerpt by
    // its common leading indentation: deeply-nested code then spends the
    // flyout's width on content, not shared whitespace, while relative nesting
    // (and the editor's tab-width, via `.minimap-flyout-code`'s tab-size) is
    // preserved.
    const sliceTexts = [];
    for (let i = first; i <= last; i += 1) {
      const runs = runsPerLine[i];
      sliceTexts.push(
        Array.isArray(runs) ? runs.map((r) => (r && r.text) || '').join('') : ''
      );
    }
    const dedent = commonIndent(sliceTexts).length;
    const frag = doc.createDocumentFragment();
    for (let i = first; i <= last; i += 1) {
      const lineEl = doc.createElement('div');
      lineEl.className =
        i === centerLine ? 'minimap-flyout-line is-current' : 'minimap-flyout-line';
      const no = doc.createElement('span');
      no.className = 'minimap-flyout-no';
      no.textContent = String(i + 1);
      const code = doc.createElement('span');
      code.className = 'minimap-flyout-code';
      const runs = dropLeadingChars(runsPerLine[i], dedent);
      if (runs.length > 0) {
        for (const run of runs) {
          const span = doc.createElement('span');
          if (run.face) span.className = `tok-${run.face}`;
          span.textContent = run.text;
          code.append(span);
        }
      }
      lineEl.append(no, code);
      frag.append(lineEl);
    }
    const flyout = this._ensureFlyout();
    flyout.replaceChildren(frag);
    flyout.style.display = '';
    this._positionFlyout(flyout, clientY);
  }

  _positionFlyout(flyout, clientY) {
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const rect = /** @type {HTMLCanvasElement} */ (this._canvas).getBoundingClientRect();
    const fw = flyout.offsetWidth;
    const fh = flyout.offsetHeight;
    // Put the flyout on the roomier side of the minimap.
    let left = rect.left > winW / 2 ? rect.left - 8 - fw : rect.right + 8;
    left = Math.max(8, Math.min(left, winW - fw - 8));
    let top = clientY - fh / 2;
    top = Math.max(8, Math.min(top, winH - fh - 8));
    flyout.style.left = `${left}px`;
    flyout.style.top = `${top}px`;
  }

  _ensureFlyout() {
    if (this._flyout) return this._flyout;
    const doc = this.ownerDocument;
    const flyout = doc.createElement('div');
    flyout.className = 'minimap-flyout';
    (doc.body || this).append(flyout);
    this._flyout = flyout;
    return flyout;
  }

  _hideFlyout() {
    if (this._flyout) this._flyout.style.display = 'none';
  }

  _hideHover() {
    this._lastHoverLine = -1;
    if (this._band) this._band.style.display = 'none';
    this._hideFlyout();
  }

  // --- internal: scheduling ------------------------------------------

  _scheduleFull() {
    this._schedule();
  }

  _scheduleScroll() {
    this._schedule();
  }

  _scheduleEdit() {
    if (this._editTimer) clearTimeout(this._editTimer);
    this._editTimer = setTimeout(() => {
      this._editTimer = 0;
      this._runsCache = null; // re-tokenise / re-read on next paint
      this._schedule();
    }, EDIT_DEBOUNCE_MS);
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._paint();
    });
  }

  // --- internal: data -------------------------------------------------

  _safeMetrics() {
    try {
      const m = this._adapter && this._adapter.getMetrics();
      if (!m || !Number.isFinite(m.contentHeight)) return null;
      return m;
    } catch {
      return null;
    }
  }

  /** Whole-buffer per-line runs: prefer the editor's own highlight cache
   *  (accurate for tree-sitter languages too); fall back to tokenising each
   *  line ourselves when the editor hasn't a cache to share. */
  _runsPerLine() {
    const adapter = this._adapter;
    if (!adapter) return [];
    // Prefer the editor's live whole-buffer highlight — accurate for
    // tree-sitter languages and cheap to read, so read it fresh each paint
    // (a late async parse is then picked up on the next repaint). Only the
    // hand-tokenised fallback is cached, until the next edit.
    let runs = null;
    try {
      runs = typeof adapter.getLineRuns === 'function' ? adapter.getLineRuns() : null;
    } catch {
      runs = null;
    }
    if (Array.isArray(runs)) return runs;
    if (this._runsCache) return this._runsCache;
    const text = (adapter.buffer && adapter.buffer.text) || '';
    const language = adapter.language || languageForName(
      (adapter.buffer && adapter.buffer.name) || ''
    );
    this._runsCache = text.split('\n').map((line) => {
      try {
        return highlightLine(line, language);
      } catch {
        return [{ text: line, face: null }];
      }
    });
    return this._runsCache;
  }

  _lineCount() {
    return this._runsPerLine().length;
  }

  /** The solid fill colour for a face (alpha is applied per character via
   *  globalAlpha in `_drawLine`). Resolved once via the probe, then cached. */
  _colorFor(face) {
    const key = face || '';
    const cached = this._colorCache.get(key);
    if (cached) return cached;
    const probe = this._probe;
    let color = 'rgb(150,150,150)';
    if (probe) {
      probe.className = face ? `minimap-probe tok-${face}` : 'minimap-probe';
      const rgb = parseRgb(getComputedStyle(probe).color);
      if (rgb) color = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    }
    this._colorCache.set(key, color);
    return color;
  }

  // --- internal: paint ------------------------------------------------

  _paint() {
    if (!this._mounted) return;
    if (!this._adapter) { this._showMessage(true); return; }
    const metrics = this._safeMetrics();
    const canvas = /** @type {HTMLCanvasElement} */ (this._canvas);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!metrics || cssW <= 0 || cssH <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this._cellDpr) {
      // Glyph cells are baked at device resolution — rebuild on a DPR change
      // (e.g. dragging the window between displays).
      this._cellCache.clear();
      this._cellDpr = dpr;
    }
    this._dpr = dpr;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const runsPerLine = this._runsPerLine();
    const lineCount = runsPerLine.length;
    const mmContentH = lineCount * MM_LINE_H;
    const { mmScrollTop, thumbTop, thumbHeight } = thumbRect(metrics, mmContentH, cssH);

    // Only the lines inside the current minimap window need painting.
    const first = Math.max(0, Math.floor(mmScrollTop / MM_LINE_H));
    const last = Math.min(lineCount, Math.ceil((mmScrollTop + cssH) / MM_LINE_H));
    for (let i = first; i < last; i += 1) {
      const y = i * MM_LINE_H - mmScrollTop;
      this._drawLine(ctx, runsPerLine[i], y);
    }

    if (this._thumb) {
      this._thumb.style.top = `${Math.max(0, thumbTop)}px`;
      this._thumb.style.height = `${thumbHeight}px`;
    }
  }

  _drawLine(ctx, runs, y) {
    if (!Array.isArray(runs)) return;
    // Leading indentation is compressed so deeply-nested code still uses the
    // panel for content; content then advances at full per-column width.
    const indentCols = leadingIndentCols(runs, MM_TAB_W);
    const startCol = compressIndent(indentCols, INDENT_SCALE, MAX_INDENT_COLS);
    let col = 0;          // expanded column from the line start
    let contentCol = 0;   // column since the end of the leading indent
    for (const run of runs) {
      const text = run.text || '';
      const face = run.face ?? null;
      for (let k = 0; k < text.length; k += 1) {
        const ch = text[k];
        if (col < indentCols) { col += ch === '\t' ? MM_TAB_W : 1; continue; }
        const drawCol = startCol + contentCol;
        if (drawCol >= MM_MAX_COLS) { ctx.globalAlpha = 1; return; }
        if (ch === '\t') { contentCol += MM_TAB_W; col += MM_TAB_W; continue; }
        if (ch === ' ') { contentCol += 1; col += 1; continue; }
        const color = this._colorFor(face);
        const cell = this._ensureCell(ch, color);
        if (cell && cell.canvas) {
          // Charsheet path: blit the pre-tinted glyph cell. The ctx carries
          // the DPR transform, so the cell's device pixels map 1:1.
          ctx.globalAlpha = face ? 1 : 0.72;
          ctx.drawImage(cell.canvas, drawCol * MM_CHAR_W, y, cell.cols * MM_CHAR_W, MM_LINE_H);
          contentCol += cell.cols;
          col += cell.cols;
        } else {
          // Fallback (no canvas / headless): a coverage-alpha block.
          const cov = charCoverage(ch);
          ctx.fillStyle = color;
          ctx.globalAlpha = (face ? 0.95 : 0.6) * (0.45 + 0.55 * cov);
          ctx.fillRect(drawCol * MM_CHAR_W, y, MM_CHAR_W, Math.max(1, MM_LINE_H - 1));
          contentCol += 1;
          col += 1;
        }
      }
    }
    ctx.globalAlpha = 1; // reset for the thumb / next line
  }

  /** The editor's mono font as a CSS `font` value at PX (resolved once). */
  _monoFontString(px) {
    if (!this._monoFont) {
      const v = (typeof getComputedStyle === 'function'
        ? getComputedStyle(this.ownerDocument.documentElement)
          .getPropertyValue('--font-mono')
        : '').trim();
      this._monoFont = v || 'monospace';
    }
    return `${px}px ${this._monoFont}`;
  }

  /**
   * The charsheet cell for (CHAR, COLOR): the glyph rasterised in COLOR and
   * downscaled to a `cols × 1`-column minimap cell, cached. Column count
   * comes from the font's own advance (so a full-width CJK glyph is 2
   * columns), which is what makes this faithful for non-Latin scripts.
   * Returns null if the platform has no canvas (Node tests → fillRect path).
   */
  _ensureCell(char, color) {
    const key = `${color} ${char}`;
    const cached = this._cellCache.get(key);
    if (cached) return cached;
    const doc = this.ownerDocument;
    let scratch = this._scratch;
    if (!scratch) {
      scratch = doc.createElement('canvas');
      this._scratch = scratch;
    }
    const sctx = scratch.getContext('2d');
    if (!sctx) return null;
    const RENDER_PX = 16; // supersample size for a clean downscale
    sctx.font = this._monoFontString(RENDER_PX);
    if (!this._unitAdvance) this._unitAdvance = sctx.measureText('n').width || RENDER_PX * 0.6;
    const adv = sctx.measureText(char).width || this._unitAdvance;
    const cols = Math.max(1, Math.min(2, Math.round(adv / this._unitAdvance)));
    const rw = Math.max(1, Math.ceil(adv));
    const rh = Math.ceil(RENDER_PX * 1.3);
    scratch.width = rw;
    scratch.height = rh; // resizing clears the context — re-set state below
    sctx.font = this._monoFontString(RENDER_PX);
    sctx.textBaseline = 'alphabetic';
    sctx.fillStyle = color;
    sctx.fillText(char, 0, RENDER_PX);
    const dpr = this._dpr || 1;
    const cw = Math.max(1, Math.round(MM_CHAR_W * cols * dpr));
    const ch = Math.max(1, Math.round(MM_LINE_H * dpr));
    const cell = doc.createElement('canvas');
    cell.width = cw;
    cell.height = ch;
    const cctx = cell.getContext('2d');
    if (!cctx) return null;
    cctx.imageSmoothingEnabled = true;
    cctx.drawImage(scratch, 0, 0, rw, rh, 0, 0, cw, ch);
    const entry = { canvas: cell, cols };
    this._cellCache.set(key, entry);
    return entry;
  }

  // --- internal: teardown --------------------------------------------

  _teardownSubs() {
    for (const unsub of this._unsubs) {
      try { unsub(); } catch { /* already gone */ }
    }
    this._unsubs = [];
  }
}

defineViewElement('minimap-view', MinimapView);
