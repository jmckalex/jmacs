/**
 * @file Code folding — the pure part. Turns a list of `@fold` captures
 * (outer-coordinate character offsets) into a list of fold ranges
 * expressed in *line numbers*. The view layer consumes these to skip
 * lines and draw the gutter glyph; folding is a view concern, not part
 * of the L2 buffer.
 *
 * A fold range covers `startLine` through `endLine` inclusive; the
 * convention is that `startLine` (the header) stays visible and lines
 * `startLine + 1 … endLine` are hidden. Single-line captures are
 * dropped — they are not foldable.
 *
 * This module is the analog of `splitIntoLineRuns` / `spliceInjections`
 * in the highlight pipeline: the highlighter produces capture lists, a
 * pure transform turns them into something the renderer consumes. Like
 * those, this is testable without loading any grammar.
 */

/**
 * @typedef {object} FoldRange
 * @property {number} startLine - Zero-indexed line of the fold's header.
 * @property {number} endLine - Zero-indexed line where the fold closes.
 */

/**
 * @typedef {object} FoldCapture
 * @property {number} start - Absolute character offset of the node's start.
 * @property {number} end - Absolute character offset of the node's end.
 */

/**
 * Convert `@fold` captures into per-line fold ranges, in `startLine`
 * order, deduplicated. The text is needed only to translate offsets to
 * line numbers — no other state.
 *
 * Captures that begin and end on the same line are dropped (nothing to
 * fold). Ranges that begin before the buffer ends but extend past it
 * (a malformed grammar capture, or an unterminated construct) are
 * clamped to the last line.
 *
 * @param {string} text
 * @param {FoldCapture[]} captures
 * @returns {FoldRange[]}
 */
export function foldRanges(text, captures) {
  if (!Array.isArray(captures) || captures.length === 0) return [];
  const lineStarts = computeLineStarts(text);
  const lineCount = lineStarts.length;

  /** @type {Map<number, number>} startLine -> max endLine. */
  const byStart = new Map();
  for (const cap of captures) {
    const startLine = offsetToLine(lineStarts, cap.start);
    const endLine = Math.min(
      lineCount - 1,
      offsetToLine(lineStarts, cap.end)
    );
    if (endLine <= startLine) continue;
    const existing = byStart.get(startLine);
    if (existing === undefined || endLine > existing) {
      byStart.set(startLine, endLine);
    }
  }
  const ranges = Array.from(byStart, ([startLine, endLine]) => ({
    startLine,
    endLine,
  }));
  ranges.sort((a, b) => a.startLine - b.startLine);
  return ranges;
}

/**
 * Build the byte-offset of every line's first character. Index `i` is
 * the start of line `i` (zero-indexed); a buffer with no newlines has
 * a single entry `[0]`.
 *
 * @param {string} text
 * @returns {number[]}
 */
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* '\n' */) starts.push(i + 1);
  }
  return starts;
}

/**
 * Binary search: which line contains the given character offset?
 *
 * @param {number[]} lineStarts
 * @param {number} offset
 * @returns {number}
 */
function offsetToLine(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Index fold ranges for quick view-time lookups. Returns:
 *
 *   - `headers`: `Set<number>` of startLine numbers (foldable headers).
 *   - `endByStart`: `Map<number, number>` mapping startLine -> endLine.
 *   - `depthByStart`: `Map<number, number>` mapping startLine -> nesting
 *     depth (0 = outermost). The gutter offsets each fold-range "pill"
 *     horizontally by this depth so nested ranges read as stacked bars.
 *
 * The view uses `headers` to draw the gutter glyph and `endByStart` to
 * compute what to hide when a header is folded.
 *
 * Depth is a single stack sweep: `ranges` arrive sorted by `startLine`
 * (from `foldRanges`) and fold scopes nest properly (or are disjoint), so
 * the number of still-open ancestors when a range starts is its depth.
 *
 * @param {FoldRange[]} ranges
 * @returns {{ headers: Set<number>, endByStart: Map<number, number>, depthByStart: Map<number, number> }}
 */
export function indexFoldRanges(ranges) {
  const headers = new Set();
  const endByStart = new Map();
  const depthByStart = new Map();
  /** End lines of ranges still open at the current sweep point, innermost
   *  on top (their ends decrease toward the top under proper nesting). */
  const openEnds = [];
  for (const range of ranges) {
    headers.add(range.startLine);
    endByStart.set(range.startLine, range.endLine);
    while (
      openEnds.length > 0 &&
      openEnds[openEnds.length - 1] < range.startLine
    ) {
      openEnds.pop();
    }
    depthByStart.set(range.startLine, openEnds.length);
    openEnds.push(range.endLine);
  }
  return { headers, endByStart, depthByStart };
}

/**
 * Given a set of folded header lines and an index of fold ranges,
 * return the set of lines that should be *hidden* — lines strictly
 * between each folded header's startLine and its endLine. The header
 * itself stays visible (with a `…` glyph appended).
 *
 * Lines folded inside another folded range are still in the hidden set;
 * the view's "is this line visible?" check is a simple membership test.
 *
 * @param {Iterable<number>} foldedStartLines
 * @param {Map<number, number>} endByStart
 * @returns {Set<number>}
 */
export function hiddenLines(foldedStartLines, endByStart) {
  const hidden = new Set();
  for (const start of foldedStartLines) {
    const end = endByStart.get(start);
    if (end === undefined) continue;
    for (let line = start + 1; line <= end; line += 1) hidden.add(line);
  }
  return hidden;
}
