/**
 * @file The math-preview controller — the minor-mode brain on the
 * renderer side.
 *
 * It ties the scan/typeset/layout pieces together: scan the buffer for
 * math segments (via a mode-supplied `scan` — see
 * `math-preview-providers.js`), decide which to typeset / reveal / mark
 * invalid, typeset (through a cache, lazily), and hand the view a list of
 * replaced ranges. The view's reveal rule (cursor strictly inside →
 * source) does the edit cycle; this controller only has to *not* build a
 * widget for a revealed segment (so it isn't typeset while being edited)
 * and to re-typeset a segment's new body once point leaves it.
 *
 * The controller is mode-agnostic: the only mode-specific input is the
 * `scan` function (which constructs to recognise). `latex-mode` passes
 * the LaTeX scanner, `markdown-mode` a no-environments scanner, etc.
 * When `scan` is omitted it defaults to the LaTeX delimiter scanner, so
 * the historical LaTeX wiring keeps working unchanged.
 *
 * Two layers, split for testing:
 *
 *   - `planSegments(text, points, { scan })` — PURE. Scans and classifies
 *     every segment as `'widget' | 'invalid' | 'revealed'`, given the
 *     cursor offsets. No MathJax, no DOM. Unit-tested directly.
 *   - `createMathPreview(...)` — the stateful controller: holds the
 *     typeset cache, tracks the segment containing point (enter/leave),
 *     and turns the plan into `{ start, end, kind, el }` ranges with lazy
 *     `el()` factories. MathJax + DOM are injected so the cache and
 *     enter/leave logic are unit-testable behind stubs; the actual SVG
 *     mount needs live smoke.
 *
 * `createLatexMathPreview` is kept as a back-compatible alias of
 * `createMathPreview`.
 */

import {
  scanMathSegments,
  segmentContainingPoint,
  isEmptyBody,
} from './math-segments.js';
import {
  createMathCache,
  typesetCached,
  whenMathJaxReady,
  isMathJaxReady,
} from './typeset-math.js';

/**
 * @typedef {import('./math-segments.js').MathSegment} MathSegment
 */

/**
 * @typedef {object} PlannedSegment
 * @property {number} start
 * @property {number} end
 * @property {'inline'|'block'} kind
 * @property {string} body
 * @property {'widget'|'invalid'|'revealed'} disposition - `widget`:
 *   typeset and replace; `invalid`: empty/whitespace body, show source +
 *   wavy underline; `revealed`: a cursor is strictly inside, show source.
 */

/**
 * Classify every math segment in `text` given the cursor offsets. Pure.
 *
 *   - A segment with any cursor strictly inside it (`start < point <
 *     end`) is `'revealed'`.
 *   - Otherwise, an empty/whitespace-only body is `'invalid'`.
 *   - Otherwise it is a `'widget'` to typeset.
 *
 * @param {string} text
 * @param {number[]} points - Cursor offsets.
 * @param {object} [options]
 * @param {(text: string) => MathSegment[]} [options.scan] - The scanner;
 *   defaults to the delimiter scanner. The controller passes a
 *   tree-sitter-backed scanner when one is available.
 * @returns {PlannedSegment[]}
 */
export function planSegments(text, points, options = {}) {
  const scan = typeof options.scan === 'function' ? options.scan : scanMathSegments;
  const segments = scan(text) || [];
  const pts = Array.isArray(points) ? points : [];
  return segments.map((segment) => {
    let disposition;
    if (pts.some((p) => p > segment.start && p < segment.end)) {
      disposition = 'revealed';
    } else if (isEmptyBody(segment.body)) {
      disposition = 'invalid';
    } else {
      disposition = 'widget';
    }
    return {
      start: segment.start,
      end: segment.end,
      kind: segment.kind,
      body: segment.body,
      disposition,
    };
  });
}

/**
 * Detect a point-leave transition between two renders: the segment the
 * cursor was inside last time, that it is no longer inside now. Returns
 * the left segment's body (so the caller can ensure its widget is fresh)
 * or null. Pure — used by the controller and unit-tested directly.
 *
 * @param {MathSegment | null} previousSegment - The segment point was
 *   inside on the previous update (or null).
 * @param {number[]} points - The current cursor offsets.
 * @returns {MathSegment | null} The segment just left, or null.
 */
export function detectLeave(previousSegment, points) {
  if (!previousSegment) return null;
  const stillInside = points.some(
    (p) => p > previousSegment.start && p < previousSegment.end
  );
  return stillInside ? null : previousSegment;
}

/**
 * Create the math-preview controller.
 *
 * @param {object} options
 * @param {() => string} options.getText - The current buffer text.
 * @param {() => number[]} options.getPoints - The current cursor offsets.
 * @param {Document} options.doc - The document widget nodes are made in.
 * @param {() => void} [options.requestRender] - Ask the host to
 *   re-render (used for the one-shot render once MathJax finishes
 *   starting up). Optional; no-op when absent.
 * @param {(text: string) => MathSegment[]} [options.scan] - Override the
 *   scanner (e.g. a tree-sitter-backed one). Defaults to the delimiter
 *   scanner.
 * @param {import('./typeset-math.js').MathJaxLike} [options.mathjax] -
 *   The MathJax instance; defaults to `globalThis.MathJax`. Injected for
 *   tests.
 * @returns {{
 *   ranges: () => Array<{start:number,end:number,kind:'inline'|'block',el:() => Node}>,
 *   update: () => void,
 *   currentSegment: () => MathSegment | null,
 *   cache: ReturnType<typeof createMathCache>,
 *   invalidateAll: () => void,
 * }}
 */
export function createMathPreview(options) {
  const getText = options.getText;
  const getPoints = options.getPoints;
  const doc = options.doc;
  const requestRender =
    typeof options.requestRender === 'function' ? options.requestRender : () => {};
  const scan = typeof options.scan === 'function' ? options.scan : scanMathSegments;
  const mathjax = options.mathjax;

  const cache = createMathCache();

  /** The segment point was inside on the last update (for enter/leave). */
  let currentSegment = null;
  /** Whether we've already done the one-shot "MathJax just became ready"
   *  re-render, so we don't keep scheduling it. */
  let readyArmed = false;

  /** Resolve the MathJax instance fresh (it may load after construction). */
  function mj() {
    return mathjax ?? globalThis.MathJax;
  }

  /**
   * Build the inline/SVG widget node for a valid segment, from the
   * cache. The cached node is canonical; we clone it so the same body
   * appearing twice on screen mounts independently. Returns null when
   * MathJax produced nothing (treated as invalid → caller falls back to
   * the invalid source span).
   *
   * @param {PlannedSegment} segment
   * @returns {Node | null}
   */
  function widgetNode(segment) {
    const display = segment.kind === 'block';
    const node = typesetCached(cache, segment.body, display, mj());
    if (!node) return null;
    return typeof node.cloneNode === 'function' ? node.cloneNode(true) : node;
  }

  /**
   * Build the source-with-wavy-underline span for an invalid/empty
   * segment: the raw source text (delimiters included) in a
   * `.math-invalid` span. Clicking it reveals the segment for editing
   * via the view's normal click-to-reveal path.
   *
   * @param {PlannedSegment} segment
   * @returns {Node}
   */
  function invalidNode(segment) {
    const span = doc.createElement('span');
    span.className = 'math-invalid';
    span.textContent = getText().slice(segment.start, segment.end);
    return span;
  }

  /**
   * Recompute the segment-under-point tracking and arm a one-shot
   * re-render if MathJax was not ready when we needed it. Called once
   * per render before `ranges()` reads.
   */
  function update() {
    const text = getText();
    const points = getPoints();
    const segments = scan(text) || [];
    const nowInside = segmentContainingPoint(segments, points[0] ?? -1);
    // Detect leave: if we were inside a segment and aren't anymore, its
    // body may have changed — but typesetCached is keyed by body, so a
    // changed body is already a cache miss and re-typesets on next read.
    // Nothing extra to do beyond updating the tracked segment.
    currentSegment = nowInside;

    // If MathJax isn't ready (loaded but startup not resolved, or not
    // present yet), schedule one re-render for when it is, so segments
    // left as source during startup flip to widgets.
    if (!readyArmed && !isMathJaxReady(mj())) {
      readyArmed = true;
      whenMathJaxReady(() => {
        readyArmed = false;
        requestRender();
      }, mj());
    }
  }

  /**
   * The replaced ranges for the current render: a widget range per
   * non-revealed segment (a typeset SVG for a valid body, a source +
   * wavy-underline span for an invalid one). Revealed segments are
   * omitted, so the view shows their source.
   *
   * If MathJax isn't ready yet, valid segments are omitted too (left as
   * source) until the one-shot ready re-render fires.
   *
   * @returns {Array<{start:number,end:number,kind:'inline'|'block',el:() => Node}>}
   */
  function ranges() {
    const text = getText();
    const points = getPoints();
    const planned = planSegments(text, points, { scan });
    const ready = isMathJaxReady(mj());
    /** @type {Array<{start:number,end:number,kind:'inline'|'block',el:() => Node}>} */
    const out = [];
    for (const segment of planned) {
      if (segment.disposition === 'revealed') continue;
      if (segment.disposition === 'invalid') {
        out.push({
          start: segment.start,
          end: segment.end,
          kind: segment.kind,
          key: segment.body,
          el: () => invalidNode(segment),
        });
        continue;
      }
      // widget — only if MathJax is ready and produces a node; else
      // leave it as source (omit) until the ready re-render.
      if (!ready) continue;
      const probe = widgetNode(segment);
      if (probe === null) {
        // MathJax threw → invalid; show source + wavy underline instead.
        out.push({
          start: segment.start,
          end: segment.end,
          kind: segment.kind,
          key: segment.body,
          el: () => invalidNode(segment),
        });
        continue;
      }
      // Re-typeset on each el() call so a re-render after an edit shows
      // the new SVG; the cache makes a repeat cheap.
      out.push({
        start: segment.start,
        end: segment.end,
        kind: segment.kind,
        key: segment.body,
        el: () => widgetNode(segment) ?? invalidNode(segment),
      });
    }
    return out;
  }

  /** Drop every cached typeset node (e.g. on a theme/font change). */
  function invalidateAll() {
    cache.clear();
  }

  return {
    ranges,
    update,
    currentSegment: () => currentSegment,
    cache,
    invalidateAll,
  };
}

/**
 * Back-compatible alias for {@link createMathPreview}. Retained for the
 * original LaTeX-only import name; new code should use `createMathPreview`
 * and pass a mode-specific `scan`.
 *
 * @type {typeof createMathPreview}
 */
export const createLatexMathPreview = createMathPreview;
