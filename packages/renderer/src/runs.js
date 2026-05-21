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
 * be sorted; they must not overlap. Each line's runs concatenate back
 * to that line.
 *
 * @param {string} text
 * @param {{ start: number, end: number, face: string }[]} ranges
 * @returns {Run[][]} One array of runs per line.
 */
export function splitIntoLineRuns(text, ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
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
