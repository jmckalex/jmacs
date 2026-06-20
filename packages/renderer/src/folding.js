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
 * @property {number} [headerCol] - For a column-aware (inner) fold, the
 *   column on `startLine` to truncate the header at — the end of the
 *   opening delimiter (so the view shows `<p>` then `…`). Present only
 *   when the opening delimiter ends on `startLine`.
 * @property {number} [closeCol] - For a column-aware fold, the column on
 *   `endLine` where the closing delimiter begins (so the view shows
 *   `</p>`). Present only when the closing delimiter starts on `endLine`.
 * @property {boolean} [block] - A *block* fold keeps BOTH delimiter lines
 *   visible when collapsed (the view draws a vertical ellipsis on its own
 *   row between them) instead of hiding the closing line. Used for
 *   jmarkdown `@begin(…)`/`@end(…)` environments.
 */

/**
 * @typedef {object} FoldCapture
 * @property {number} start - Absolute character offset of the node's start.
 * @property {number} end - Absolute character offset of the node's end.
 * @property {number} [innerStart] - For an inner (`@fold.inner`) fold,
 *   the offset just past the opening delimiter.
 * @property {number} [innerEnd] - For an inner fold, the offset at which
 *   the closing delimiter begins.
 * @property {boolean} [block] - See FoldRange.block.
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

  /** @type {Map<number, {endLine: number, headerCol?: number, closeCol?: number}>}
   *  startLine -> the longest range starting there, plus any cut columns. */
  const byStart = new Map();
  for (const cap of captures) {
    const startLine = offsetToLine(lineStarts, cap.start);
    const endLine = Math.min(
      lineCount - 1,
      offsetToLine(lineStarts, cap.end)
    );
    if (endLine <= startLine) continue;
    const existing = byStart.get(startLine);
    if (existing !== undefined && endLine <= existing.endLine) continue;
    const range = { endLine };
    if (cap.block) range.block = true;
    // Column-aware (inner) fold: translate the delimiter offsets into a
    // header cut column and a close resume column, but only when each
    // delimiter lands on the line we'd render it on (the header line and
    // the close line). Otherwise the fold stays line-based.
    if (typeof cap.innerStart === 'number' && typeof cap.innerEnd === 'number') {
      if (offsetToLine(lineStarts, cap.innerStart) === startLine) {
        range.headerCol = cap.innerStart - lineStarts[startLine];
      }
      if (offsetToLine(lineStarts, cap.innerEnd) === endLine) {
        range.closeCol = cap.innerEnd - lineStarts[endLine];
      }
    }
    byStart.set(startLine, range);
  }
  const ranges = Array.from(byStart, ([startLine, r]) => {
    const range = { startLine, endLine: r.endLine };
    if (r.headerCol !== undefined) range.headerCol = r.headerCol;
    if (r.closeCol !== undefined) range.closeCol = r.closeCol;
    if (r.block) range.block = true;
    return range;
  });
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
  /** startLine -> { headerCol?, closeCol? } for column-aware folds only. */
  const cutByStart = new Map();
  /** startLine numbers of *block* folds (both delimiter lines kept). */
  const blockByStart = new Set();
  /** End lines of ranges still open at the current sweep point, innermost
   *  on top (their ends decrease toward the top under proper nesting). */
  const openEnds = [];
  for (const range of ranges) {
    headers.add(range.startLine);
    endByStart.set(range.startLine, range.endLine);
    if (range.headerCol !== undefined || range.closeCol !== undefined) {
      cutByStart.set(range.startLine, {
        headerCol: range.headerCol,
        closeCol: range.closeCol,
      });
    }
    if (range.block) blockByStart.add(range.startLine);
    while (
      openEnds.length > 0 &&
      openEnds[openEnds.length - 1] < range.startLine
    ) {
      openEnds.pop();
    }
    depthByStart.set(range.startLine, openEnds.length);
    openEnds.push(range.endLine);
  }
  return { headers, endByStart, depthByStart, cutByStart, blockByStart };
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
 * @param {Set<number>} [blockByStart] - Block-fold start lines, whose
 *   closing-delimiter line stays visible (only the interior is hidden).
 * @returns {Set<number>}
 */
export function hiddenLines(foldedStartLines, endByStart, blockByStart) {
  const hidden = new Set();
  for (const start of foldedStartLines) {
    const end = endByStart.get(start);
    if (end === undefined) continue;
    // A block fold keeps its closing-delimiter line visible, so hide only
    // the interior (`start+1 … end-1`); a normal fold hides through `end`.
    const last = blockByStart && blockByStart.has(start) ? end - 1 : end;
    for (let line = start + 1; line <= last; line += 1) hidden.add(line);
  }
  return hidden;
}

/**
 * The folded headers whose collapsed interior contains `line` — i.e. the
 * folds that navigating the cursor onto that line should auto-open, so the
 * caret lands where the user moved it instead of being clamped to the
 * header. A block fold keeps its closing-delimiter line visible, so a `line`
 * sitting on that end line is NOT inside it.
 *
 * @param {number} line
 * @param {Iterable<number>} foldedStartLines
 * @param {Map<number, number>} endByStart
 * @param {Set<number>} [blockByStart]
 * @returns {number[]} the matching fold header start lines
 */
export function foldsHidingLine(line, foldedStartLines, endByStart, blockByStart) {
  const out = [];
  for (const start of foldedStartLines) {
    const end = endByStart.get(start);
    if (end === undefined) continue;
    const last = blockByStart && blockByStart.has(start) ? end - 1 : end;
    if (line > start && line <= last) out.push(start);
  }
  return out;
}

/**
 * The fold ranges that enclose LINE — every header whose scope strictly
 * contains it (`startLine < line <= endLine`), returned outermost-first
 * (ascending by `startLine`). This is the chain of still-open structural
 * elements at a given line: the data a "sticky scroll" / code-structure
 * header panel pins at the top of the viewport. The strict `<` means a
 * header is never its own ancestor, so it pins only once the viewport has
 * scrolled past it.
 *
 * Pure and O(headers); the header count on screen is tiny, so a linear
 * scan of `endByStart` is cheaper than maintaining another index.
 *
 * @param {number} line - The (visible) buffer line at the viewport top.
 * @param {Map<number, number>} endByStart - `startLine -> endLine`, from
 *   {@link indexFoldRanges}.
 * @returns {Array<{startLine: number, endLine: number}>}
 */
export function enclosingFolds(line, endByStart) {
  const out = [];
  for (const [startLine, endLine] of endByStart) {
    if (startLine < line && line <= endLine) out.push({ startLine, endLine });
  }
  out.sort((a, b) => a.startLine - b.startLine);
  return out;
}

/**
 * Should a folded header preview its range's *closing* line after the
 * `…`? Only when that line is structurally a close — a bare closing
 * delimiter (`</tag>`, `}`, `)`, `]`) or a short keyword close (`end`,
 * `done`) — so the preview shows `<head>…</head>` but never re-shows a
 * content line that merely happens to end with `</p>`.
 *
 * Without this guard, folding a two-line `<p>…content…</p>` whose `</p>`
 * shares its line with text would append that whole line back after the
 * `…`, hiding nothing. A view-display concern, but pure and fold-shaped,
 * so it lives here with the rest of the fold logic.
 *
 * @param {string} text - The raw (untrimmed) closing-line text.
 * @returns {boolean}
 */
export function isStructuralCloseLine(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length === 0) return false;
  // An XML/HTML end tag, a line opening with a bracket close, or a short
  // bare keyword close. A content line (`And some <span>…</p>`) matches
  // none of these.
  return t.startsWith('</') || /^[)\]}]/.test(t) || t.length <= 5;
}
