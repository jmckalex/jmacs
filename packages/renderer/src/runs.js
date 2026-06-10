/**
 * @file Splitting faced character ranges into per-line runs. Pure and
 * DOM-free, so it is tested on its own. Used by the tree-sitter
 * highlighter, whose captures are absolute ranges over the whole
 * document while the view renders line by line.
 */

/** @typedef {import('./highlight.js').Run} Run */

/**
 * Split text into per-line highlighted runs, given faced ranges over the
 * whole text. Ranges are absolute character offsets and need not be
 * sorted.
 *
 * Ranges MAY overlap or nest — highlight queries routinely capture a
 * delimiter inside the construct it delimits (the `**` inside a `@strong`
 * span, a keyword inside an expression, a `@string` inside an injected
 * region). Overlaps are resolved by {@link flattenInnermost}: at every
 * position the smallest (innermost, most specific) covering range wins,
 * and a larger range keeps only the gaps around it. The result is a flat,
 * non-overlapping cover, so each line's runs concatenate back to it.
 *
 * @param {string} text
 * @param {{ start: number, end: number, face: string }[]} ranges
 * @returns {Run[][]} One array of runs per line.
 */
export function splitIntoLineRuns(text, ranges) {
  const flat = flattenInnermost(ranges);

  const result = [];
  let lineStart = 0;
  let cursor = 0;

  for (const lineText of text.split('\n')) {
    const lineEnd = lineStart + lineText.length;
    const runs = [];
    let col = 0;

    // Skip ranges that end before this line begins.
    while (cursor < flat.length && flat[cursor].end <= lineStart) {
      cursor += 1;
    }
    for (let r = cursor; r < flat.length && flat[r].start < lineEnd; r += 1) {
      const range = flat[r];
      const start = Math.max(range.start - lineStart, col);
      const end = Math.min(range.end - lineStart, lineText.length);
      if (end <= start) continue;
      if (start > col) {
        runs.push({ text: lineText.slice(col, start), face: null });
      }
      runs.push({ text: lineText.slice(start, end), face: range.face });
      col = end;
    }
    if (col < lineText.length) {
      runs.push({ text: lineText.slice(col), face: null });
    }
    result.push(runs);
    lineStart = lineEnd + 1;
  }
  return result;
}

/**
 * Flatten possibly-overlapping faced ranges into a sorted,
 * non-overlapping cover. At each position the smallest covering range
 * wins — so an inner delimiter (`**`, a backtick) shows over the outer
 * `@strong`/`@code` span it sits in, which is the highlighting the old
 * greedy splitter could not produce (a larger range starting first ate
 * the whole span and dropped the inner face). A larger range survives
 * only on the spans no smaller range covers; equal-size overlaps resolve
 * to the later input range; adjacent same-face segments merge.
 *
 * A boundary sweep: linear in the number of distinct boundaries times the
 * (small) nesting depth, so it stays cheap for the leaf-heavy capture
 * sets grammars emit.
 *
 * @param {{ start: number, end: number, face: string }[]} ranges
 * @returns {{ start: number, end: number, face: string }[]}
 */
export function flattenInnermost(ranges) {
  if (ranges.length <= 1) {
    return ranges.map((r) => ({ start: r.start, end: r.end, face: r.face }));
  }

  // Tag with input index for a deterministic equal-size tie-break.
  const tagged = ranges.map((r, i) => ({
    start: r.start,
    end: r.end,
    face: r.face,
    i,
  }));
  const byStart = tagged.slice().sort((a, b) => a.start - b.start);

  // Distinct boundary points, ascending.
  const pts = [];
  for (const r of tagged) {
    pts.push(r.start);
    pts.push(r.end);
  }
  pts.sort((a, b) => a - b);
  const points = [];
  for (const p of pts) {
    if (points.length === 0 || points[points.length - 1] !== p) points.push(p);
  }

  const out = [];
  const active = [];
  let si = 0;
  for (let k = 0; k + 1 < points.length; k += 1) {
    const segStart = points[k];
    const segEnd = points[k + 1];
    // Open ranges that have started by this segment.
    while (si < byStart.length && byStart[si].start <= segStart) {
      active.push(byStart[si]);
      si += 1;
    }
    // Close ranges that have ended at or before this segment's start.
    for (let a = active.length - 1; a >= 0; a -= 1) {
      if (active[a].end <= segStart) active.splice(a, 1);
    }
    // Winner: the smallest range covering the whole segment; ties to the
    // later input range.
    let best = null;
    for (const r of active) {
      if (r.start <= segStart && r.end >= segEnd) {
        if (best === null) {
          best = r;
          continue;
        }
        const rSize = r.end - r.start;
        const bSize = best.end - best.start;
        if (rSize < bSize || (rSize === bSize && r.i > best.i)) best = r;
      }
    }
    if (!best) continue;
    const last = out[out.length - 1];
    if (last && last.end === segStart && last.face === best.face) {
      last.end = segEnd;
    } else {
      out.push({ start: segStart, end: segEnd, face: best.face });
    }
  }
  return out;
}
