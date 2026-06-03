/**
 * @file Replaced-range widget layout — the pure index math behind the
 * view's math-preview widgets. No DOM; tested on its own.
 *
 * A *replaced range* is `{ start, end, kind }` (the renderer attaches an
 * `el()` factory; this module ignores it). The view passes the full list
 * plus the buffer's line offsets and the current cursor set; this module
 * decides, once per render, how each range is drawn:
 *
 *   - **Reveal:** a range with a cursor strictly inside it (`start <
 *     point < end`, exclusive) is *suppressed* — rendered as ordinary
 *     source so the user can edit it. Every other range is replaced.
 *   - **Inline** ranges (single visual line) replace the covered
 *     characters on their line with the widget element.
 *   - **Block** ranges hide every line the range touches *except its
 *     start line*, folding-style, and emit the widget as a block row at
 *     the start line.
 *
 * The output is two plain structures the view consumes:
 *
 *   - `hiddenByBlock`: a `Set<number>` of buffer lines hidden by block
 *     widgets (merged into the fold-hidden set before display rows are
 *     assigned, so the cursor / scroll / displayRow accounting stays the
 *     single source of truth — exactly the `9/7` hazard the spec warns
 *     about).
 *   - `inlineByLine`: `Map<number, InlinePlacement[]>` — per buffer line,
 *     the inline replacements to splice into that line's runs, in
 *     ascending column order.
 *   - `blockByStartLine`: `Map<number, ReplacedRange>` — the block widget
 *     to emit at each start line.
 *
 * The line-offset model matches the view's: line `L` starts at buffer
 * offset `lineStarts[L]` and its content (no newline) has length
 * `lineLengths[L]`.
 */

import { pointInsideSegment } from './math-segments.js';

/**
 * @typedef {object} ReplacedRange
 * @property {number} start - Buffer offset of the range's first char.
 * @property {number} end - Buffer offset one past its last char.
 * @property {'inline'|'block'} kind
 * @property {*} [el] - Opaque to this module (the renderer's widget
 *   factory). Carried through unchanged so the view can mount it.
 */

/**
 * @typedef {object} InlinePlacement
 * @property {number} fromColumn - Column on the line where the replaced
 *   span begins (inclusive).
 * @property {number} toColumn - Column where it ends (exclusive).
 * @property {ReplacedRange} range - The originating range (for `el`).
 */

/**
 * @typedef {object} BlockPlacement
 * @property {ReplacedRange} range - The originating block range.
 * @property {number} startColumn - Column on the start line where the
 *   block's opening delimiter begins. The view renders the start line's
 *   source only up to this column (the prefix before `$$` / `\[`), then
 *   the widget row — so the raw opening delimiter isn't shown.
 */

/**
 * @typedef {object} MathLayout
 * @property {Set<number>} hiddenByBlock - Buffer lines hidden by block
 *   widgets (start lines excluded).
 * @property {Map<number, InlinePlacement[]>} inlineByLine
 * @property {Map<number, BlockPlacement>} blockByStartLine
 * @property {ReplacedRange[]} revealed - Ranges suppressed because a
 *   cursor is inside them (for diagnostics / tests).
 */

/**
 * True when any cursor in `points` lies strictly inside `range`. A
 * multi-cursor buffer reveals a range if *any* caret is inside it.
 *
 * @param {ReplacedRange} range
 * @param {number[]} points
 * @returns {boolean}
 */
export function rangeRevealedByAnyCursor(range, points) {
  for (const point of points) {
    if (pointInsideSegment(range, point)) return true;
  }
  return false;
}

/**
 * Which buffer line a character offset falls on, and the column within
 * it. `lineStarts` is ascending; the last line has no following start.
 *
 * @param {number[]} lineStarts
 * @param {number} offset
 * @returns {{ line: number, column: number }}
 */
function positionOf(lineStarts, offset) {
  // Binary search for the greatest start <= offset.
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, column: offset - lineStarts[lo] };
}

/**
 * Compute the widget layout for a render.
 *
 * Ranges with a cursor strictly inside are revealed (suppressed).
 * Remaining ranges:
 *
 *   - `kind: 'inline'` always renders as an inline replacement on its
 *     start line, spanning `[startColumn, endColumn)`. (An inline range
 *     is single-line by construction; if a malformed one spans lines it
 *     is dropped — defensive.)
 *   - `kind: 'block'` hides lines `startLine+1 … endLine` and emits the
 *     widget at `startLine`. A *single-line* block range (start and end
 *     on the same line) hides nothing extra and still emits its widget
 *     at that line as a block row, with no inline characters left behind.
 *
 * @param {object} args
 * @param {ReplacedRange[]} args.ranges - All replaced ranges (any order).
 * @param {number[]} args.lineStarts - Buffer offset of each line's start.
 * @param {number[]} args.lineLengths - Each line's content length (no NL).
 * @param {number[]} args.points - Cursor offsets to test for reveal.
 * @returns {MathLayout}
 */
export function computeMathLayout({ ranges, lineStarts, lineLengths, points }) {
  /** @type {Set<number>} */
  const hiddenByBlock = new Set();
  /** @type {Map<number, InlinePlacement[]>} */
  const inlineByLine = new Map();
  /** @type {Map<number, ReplacedRange>} */
  const blockByStartLine = new Map();
  /** @type {ReplacedRange[]} */
  const revealed = [];

  if (!Array.isArray(ranges) || ranges.length === 0) {
    return { hiddenByBlock, inlineByLine, blockByStartLine, revealed };
  }
  const pts = Array.isArray(points) ? points : [];
  const lastLine = lineStarts.length - 1;

  // Process in document order so inline placements per line come out
  // ascending and block start lines are deterministic.
  const sorted = [...ranges].sort((a, b) => a.start - b.start);

  for (const range of sorted) {
    if (rangeRevealedByAnyCursor(range, pts)) {
      revealed.push(range);
      continue;
    }
    const startPos = positionOf(lineStarts, range.start);
    const endPos = positionOf(lineStarts, range.end);

    if (range.kind === 'block') {
      // Hide every line strictly after the start line up to (and
      // including) the end line — the start line stays visible and
      // carries the widget. Clamp to the buffer's last line.
      const endLine = Math.min(endPos.line, lastLine);
      for (let line = startPos.line + 1; line <= endLine; line += 1) {
        hiddenByBlock.add(line);
      }
      blockByStartLine.set(startPos.line, {
        range,
        startColumn: startPos.column,
      });
      continue;
    }

    // Inline: must be single-line. A multi-line inline range is
    // malformed (the scanner never produces one); drop it defensively.
    if (endPos.line !== startPos.line) continue;
    const line = startPos.line;
    const placement = {
      fromColumn: startPos.column,
      toColumn: endPos.column,
      range,
    };
    let list = inlineByLine.get(line);
    if (!list) {
      list = [];
      inlineByLine.set(line, list);
    }
    list.push(placement);
  }

  // Keep each line's inline placements ascending by column (they already
  // are, given the document-order pass, but be explicit).
  for (const list of inlineByLine.values()) {
    list.sort((a, b) => a.fromColumn - b.fromColumn);
  }

  return { hiddenByBlock, inlineByLine, blockByStartLine, revealed };
}

/**
 * Splice inline widget placeholders into a line's run list, replacing
 * the characters under each placement with a `{ widget: el }` marker.
 *
 * The input `runs` are ordinary `{ text, face }` runs whose texts
 * concatenate to the line. The output interleaves the surviving text
 * runs with `{ widget }` markers in column order, where `widget` is the
 * originating `ReplacedRange` (carrying both its `el` factory and its
 * `start`/`end` offsets so the view can mount the node and wire a
 * click-to-reveal that places point inside the segment). The view turns
 * a text run into a span/text-node (as today) and a `{ widget }` marker
 * into the mounted element.
 *
 * Placements must be non-overlapping and ascending by `fromColumn`
 * (guaranteed by `computeMathLayout`). A placement that runs past the
 * line's text is clamped to the line length.
 *
 * @param {import('./highlight.js').Run[]} runs
 * @param {InlinePlacement[]} placements
 * @returns {Array<{text: string, face: string|null} | {widget: *}>}
 */
export function spliceInlineWidgets(runs, placements) {
  if (!placements || placements.length === 0) return runs.slice();
  // Flatten the line to a single string + a per-character face map so we
  // can re-cut around the widget spans without losing highlighting on
  // the surviving text.
  let lineText = '';
  /** @type {(string|null)[]} */
  const faceAt = [];
  for (const run of runs) {
    for (const ch of run.text) {
      lineText += ch;
      faceAt.push(run.face);
    }
  }
  const len = lineText.length;

  /** @type {Array<{text: string, face: string|null} | {widget: *}>} */
  const out = [];
  let col = 0;

  const pushText = (from, to) => {
    // Re-coalesce consecutive same-face characters into runs.
    let i = from;
    while (i < to) {
      const face = faceAt[i];
      let j = i + 1;
      while (j < to && faceAt[j] === face) j += 1;
      out.push({ text: lineText.slice(i, j), face });
      i = j;
    }
  };

  for (const placement of placements) {
    const from = Math.max(col, Math.min(placement.fromColumn, len));
    const to = Math.max(from, Math.min(placement.toColumn, len));
    if (from > col) pushText(col, from);
    out.push({ widget: placement.range });
    col = to;
  }
  if (col < len) pushText(col, len);
  return out;
}
