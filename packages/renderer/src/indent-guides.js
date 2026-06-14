/**
 * @file Indent guides — the pure part. Turns the indentation of a run of
 * visible rows into vertical guide segments the view draws behind the
 * text (à la VS Code / Nova). Like `folding.js`, this is a pure
 * transform, testable without a DOM.
 */

/**
 * The indentation of a line in columns, with tabs expanded to the next
 * tab stop — or `null` when the line is blank (empty or all whitespace).
 * A blank line has no indentation of its own; it inherits its
 * neighbours' so guides can bridge it.
 *
 * @param {string} content
 * @param {number} tabWidth
 * @returns {number | null}
 */
export function lineIndentColumns(content, tabWidth) {
  let col = 0;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += tabWidth - (col % tabWidth);
    else return col;
  }
  return null;
}

/**
 * @typedef {object} IndentGuide
 * @property {number} col - The column the guide sits at.
 * @property {number} start - First (inclusive) relative row it spans.
 * @property {number} end - Last (inclusive) relative row it spans.
 */

/**
 * Compute indent-guide segments for a contiguous run of rows. `indents[r]`
 * is row r's indentation in columns, or `null` for a blank row. A guide
 * at column `col` (col = tabWidth, 2·tabWidth, … — the column-0 guide at
 * the left edge is intentionally omitted) is drawn through a row whose
 * *effective* indent exceeds `col`; a blank row's effective indent is the
 * *larger* of its nearest non-blank neighbours, so a guide bridges blank
 * lines inside a block — including the blank right below a header whose
 * body is indented deeper. Adjacent rows merge into one segment.
 *
 * @param {(number | null)[]} indents
 * @param {number} tabWidth
 * @returns {IndentGuide[]}
 */
export function computeIndentGuides(indents, tabWidth) {
  const n = indents.length;
  if (n === 0 || tabWidth <= 0) return [];

  // Effective indent per row: a real line keeps its own; a blank row
  // takes max(nearest non-blank above, nearest non-blank below) — or the
  // one that exists, or 0 when it is blank-to-the-edge on both sides. The
  // max keeps a guide unbroken across a blank that sits between a header
  // and its deeper body.
  const prevNonBlank = new Array(n);
  let prev = null;
  for (let r = 0; r < n; r += 1) {
    if (indents[r] != null) prev = indents[r];
    prevNonBlank[r] = prev;
  }
  const eff = new Array(n);
  let next = null;
  for (let r = n - 1; r >= 0; r -= 1) {
    if (indents[r] != null) {
      next = indents[r];
      eff[r] = indents[r];
    } else {
      const p = prevNonBlank[r];
      eff[r] =
        p == null ? (next == null ? 0 : next)
        : next == null ? p
        : Math.max(p, next);
    }
  }

  let maxIndent = 0;
  for (let r = 0; r < n; r += 1) if (eff[r] > maxIndent) maxIndent = eff[r];

  /** @type {IndentGuide[]} */
  const guides = [];
  // Start at the first real indent column — no guide at the left edge.
  for (let col = tabWidth; col < maxIndent; col += tabWidth) {
    let runStart = -1;
    for (let r = 0; r <= n; r += 1) {
      const on = r < n && eff[r] > col;
      if (on) {
        if (runStart === -1) runStart = r;
      } else if (runStart !== -1) {
        guides.push({ col, start: runStart, end: r - 1 });
        runStart = -1;
      }
    }
  }
  return guides;
}
