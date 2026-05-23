/**
 * @file Splitting faced character ranges into per-line runs. Pure and
 * DOM-free, so it is tested on its own. Used by the tree-sitter
 * highlighter, whose captures are absolute ranges over the whole
 * document while the view renders line by line.
 */

/** @typedef {import('./highlight.js').Run} Run */

/**
 * Split text into per-line highlighted runs, given faced ranges over
 * the whole text. Ranges are absolute character offsets and need not
 * be sorted; they must not overlap (the tree-sitter injection
 * pipeline guarantees this). Each line's runs concatenate back to
 * that line.
 *
 * Overlap handling is a safety net only. If two ranges share a start
 * the later one in the input wins (deterministic tie-break), and a
 * single `console.warn` is emitted to point at the upstream bug —
 * wrong-but-stable output is better than a crash.
 *
 * @param {string} text
 * @param {{ start: number, end: number, face: string }[]} ranges
 * @returns {Run[][]} One array of runs per line.
 */
export function splitIntoLineRuns(text, ranges) {
  // Sort by start ascending. Ties go to the later input — so a range
  // emitted twice (or two ranges sharing a start) resolves to the one
  // that appeared last. The splitter's first-emit-wins loop combined
  // with this sort gives "later range wins" semantics for ties.
  const indexed = ranges.map((r, i) => [r, i]);
  indexed.sort((a, b) => a[0].start - b[0].start || b[1] - a[1]);
  const sorted = indexed.map((entry) => entry[0]);

  if (hasOverlap(sorted)) {
    // One warning per call — the upstream injection layer should
    // never produce overlap.
    // eslint-disable-next-line no-console
    console.warn(
      'splitIntoLineRuns: overlapping ranges detected; output is ' +
        'stable but the upstream injection or query layer has a bug.'
    );
  }

  const result = [];
  let lineStart = 0;
  let cursor = 0;

  for (const lineText of text.split('\n')) {
    const lineEnd = lineStart + lineText.length;
    const runs = [];
    let col = 0;

    // Skip ranges that end before this line begins.
    while (cursor < sorted.length && sorted[cursor].end <= lineStart) {
      cursor += 1;
    }
    for (let r = cursor; r < sorted.length && sorted[r].start < lineEnd; r += 1) {
      const range = sorted[r];
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
 * True when any pair of sorted-by-start ranges actually overlaps
 * (later.start < earlier.end). Equal starts count as overlap so the
 * "later wins" tie-break path also emits the diagnostic warning.
 *
 * @param {{ start: number, end: number }[]} sorted
 */
function hasOverlap(sorted) {
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    if (sorted[i + 1].start < sorted[i].end) return true;
  }
  return false;
}
