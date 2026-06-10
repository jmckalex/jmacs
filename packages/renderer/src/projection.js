/**
 * @file Projection — the pure step of rendering. Turns buffer state
 * into a plain data model the DOM layer can walk. Kept free of any DOM
 * reference so it can be reasoned about and tested on its own.
 */

/**
 * A line as the renderer sees it.
 *
 * @typedef {object} RenderedLine
 * @property {number} number - Zero-indexed line number.
 * @property {string} content - The line's text, without its newline.
 */

/**
 * Split buffer text into a line model. A buffer always has at least one
 * line, so the empty string projects to a single empty line.
 *
 * @param {string} text - The full buffer contents.
 * @returns {RenderedLine[]}
 */
export function toLines(text) {
  return text.split('\n').map((content, number) => ({ number, content }));
}

/**
 * The visual column a character index lands at in LINE, given a TAB
 * width. A literal `\t` advances to the next tab-stop (a multiple of
 * `tabWidth`); every other character advances by one. The buffer's
 * `positionAt` returns *logical* columns (one per character including
 * tabs); the renderer needs the *visual* column to position the
 * cursor, the selection rectangles and the bracket overlays so they
 * line up with the glyphs the browser actually paints.
 *
 * @param {string} line - The line's text (no trailing newline).
 * @param {number} charIndex - Character offset within the line.
 * @param {number} tabWidth - Stops per tab — typically 4.
 * @returns {number} The visual column at `charIndex`.
 */
/**
 * Whether a code point renders double-width in a monospace context — East
 * Asian Wide / Fullwidth (CJK ideographs, kana, Hangul, fullwidth forms)
 * plus most emoji. An approximation of the Unicode East-Asian-Width
 * property (the full table is huge) covering the common cases, so the
 * cursor, selection and click mapping line up with double-width glyphs the
 * way they do with tabs.
 *
 * @param {number} cp - A Unicode code point.
 * @returns {boolean}
 */
export function isWideCharacter(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, CJK symbols, compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat / small forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+ (supplementary)
  );
}

export function visualColumn(line, charIndex, tabWidth) {
  const w = Math.max(1, tabWidth | 0);
  const stop = Math.min(charIndex, line.length);
  let col = 0;
  let i = 0;
  while (i < stop) {
    const code = line.charCodeAt(i);
    if (code === 9) {
      col = (Math.floor(col / w) + 1) * w;
      i += 1;
    } else {
      const cp = line.codePointAt(i);
      col += isWideCharacter(cp) ? 2 : 1;
      i += cp > 0xffff ? 2 : 1; // skip the low surrogate of an astral char
    }
  }
  return col;
}

/**
 * The inverse of `visualColumn`: the character index in LINE closest
 * to a target visual column. Used by the mouse-to-offset path so a
 * click between glyphs picks the right insertion point even when the
 * line contains tabs.
 *
 * @param {string} line
 * @param {number} targetCol - The visual column the user clicked.
 * @param {number} tabWidth
 * @returns {number}
 */
export function charIndexAtVisualColumn(line, targetCol, tabWidth) {
  const w = Math.max(1, tabWidth | 0);
  if (targetCol <= 0) return 0;
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    let next;
    let size;
    if (code === 9) {
      next = (Math.floor(col / w) + 1) * w;
      size = 1;
    } else {
      const cp = line.codePointAt(i);
      size = cp > 0xffff ? 2 : 1;
      next = col + (isWideCharacter(cp) ? 2 : 1);
    }
    if (next > targetCol) {
      // Target sits inside this glyph's span — pick the closer edge.
      return (targetCol - col) <= (next - targetCol) ? i : i + size;
    }
    col = next;
    i += size;
  }
  return line.length;
}

/**
 * The set of lines every selection touches, with the column span
 * selected on each. Used to paint selection highlights one rectangle
 * per line, across all cursors.
 *
 * Per-view-point + multi-cursor: pass `cursors` (an array of
 * `{point, mark}` records — typically a view's `cursors[]` so the
 * renderer paints *that* view's set rather than the buffer-bound
 * view's). When omitted, falls back to `buffer.selections`. The legacy
 * 3-arg form `(buffer, point, mark)` is preserved so older callers
 * (and the renderer view's single-cursor-per-pane plumbing) keep
 * working with a single selection.
 *
 * @param {import('@editor/buffer').Buffer} buffer
 * @param {Array<{point: number, mark: number | null}> | number} [cursorsOrPoint]
 * @param {number | null} [maybeMark]
 * @returns {{ line: number, fromColumn: number, toColumn: number,
 *   toLineEnd: boolean }[]} One entry per (cursor, touched-line) pair.
 *   `toLineEnd` is true when the selection continues past this line
 *   (its newline is selected), so the highlight should run to the
 *   line's end.
 */
export function selectionRects(buffer, cursorsOrPoint, maybeMark, tabWidth) {
  let cursors;
  let tabW = typeof tabWidth === 'number' && tabWidth > 0 ? tabWidth : 0;
  if (Array.isArray(cursorsOrPoint)) {
    cursors = cursorsOrPoint;
  } else if (typeof cursorsOrPoint === 'number') {
    cursors = [{ point: cursorsOrPoint, mark: maybeMark === undefined ? null : maybeMark }];
  } else if (cursorsOrPoint && typeof cursorsOrPoint === 'object') {
    cursors = [{ point: cursorsOrPoint.point, mark: cursorsOrPoint.mark ?? null }];
  } else {
    cursors = buffer.selections ?? [{ point: buffer.point, mark: buffer.mark }];
  }

  const rects = [];
  for (const cursor of cursors) {
    if (cursor.mark === null || cursor.mark === cursor.point) continue;
    const start = Math.min(cursor.point, cursor.mark);
    const end = Math.max(cursor.point, cursor.mark);
    const first = buffer.positionAt(start);
    const last = buffer.positionAt(end);
    for (let line = first.line; line <= last.line; line += 1) {
      const lineMeta = buffer.lineAt(buffer.offsetAt(line, 0));
      const lineText = typeof lineMeta.text === 'string'
        ? lineMeta.text
        : buffer.slice(lineMeta.from, lineMeta.to);
      const lineLength = lineMeta.to - lineMeta.from;
      const fromChar = line === first.line ? first.column : 0;
      const toChar = line === last.line ? last.column : lineLength;
      // Visual columns when a tab width is supplied — without it the
      // legacy character-indexed columns survive (renderer-test fixtures
      // that don't pass a tabWidth still see the same numbers).
      const fromColumn = tabW > 0 ? visualColumn(lineText, fromChar, tabW) : fromChar;
      const toColumn = tabW > 0 ? visualColumn(lineText, toChar, tabW) : toChar;
      rects.push({
        line,
        fromColumn,
        toColumn,
        toLineEnd: line !== last.line,
      });
    }
  }
  return rects;
}

/**
 * A face-tagged offset range to paint as a styled box, e.g. a snippet
 * field. Like {@link selectionRects} but each input range carries a
 * `face` the renderer turns into a CSS class, and the rects are derived
 * from absolute buffer offsets (not from cursor/mark), so they survive
 * edits as long as the supplier keeps the offsets live.
 *
 * @typedef {object} DecorationRange
 * @property {number} start - Absolute buffer offset where the box opens.
 * @property {number} end - Absolute buffer offset where the box closes.
 * @property {string} face - The face name; the renderer paints the box
 *   with the `.tok-<face>` rule the face-styles module generates.
 */

/**
 * One painted rectangle per (range, touched-line) pair, mirroring the
 * shape {@link selectionRects} returns but with the range's `face`
 * carried through. Zero-width ranges (`start === end`) still emit a
 * single zero-width rect so an empty field is visible as a thin caret-
 * width marker; the renderer can widen it to a sliver. Ranges whose
 * bounds fall outside the buffer are clamped, and an inverted or null
 * range is skipped.
 *
 * The columns are *visual* columns when a positive `tabWidth` is passed
 * (so the box lines up with the glyphs past a tab), matching
 * `selectionRects`.
 *
 * @param {import('@editor/buffer').Buffer} buffer
 * @param {DecorationRange[]} ranges - Face-tagged absolute offset ranges.
 * @param {number} [tabWidth] - Stops per tab; 0/undefined keeps the
 *   legacy character-indexed columns (test fixtures rely on this).
 * @returns {{ line: number, fromColumn: number, toColumn: number,
 *   toLineEnd: boolean, face: string }[]}
 */
export function decorationRects(buffer, ranges, tabWidth) {
  if (!Array.isArray(ranges) || ranges.length === 0) return [];
  const tabW = typeof tabWidth === 'number' && tabWidth > 0 ? tabWidth : 0;
  const docLength = typeof buffer.length === 'number'
    ? buffer.length
    : (typeof buffer.text === 'string' ? buffer.text.length : 0);
  const rects = [];
  for (const range of ranges) {
    if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') {
      continue;
    }
    const face = typeof range.face === 'string' ? range.face : '';
    if (face === '') continue;
    let start = Math.max(0, Math.min(range.start, docLength));
    let end = Math.max(0, Math.min(range.end, docLength));
    if (end < start) continue;
    const first = buffer.positionAt(start);
    const last = buffer.positionAt(end);
    for (let line = first.line; line <= last.line; line += 1) {
      const lineMeta = buffer.lineAt(buffer.offsetAt(line, 0));
      const lineText = typeof lineMeta.text === 'string'
        ? lineMeta.text
        : buffer.slice(lineMeta.from, lineMeta.to);
      const lineLength = lineMeta.to - lineMeta.from;
      const fromChar = line === first.line ? first.column : 0;
      const toChar = line === last.line ? last.column : lineLength;
      const fromColumn = tabW > 0 ? visualColumn(lineText, fromChar, tabW) : fromChar;
      const toColumn = tabW > 0 ? visualColumn(lineText, toChar, tabW) : toChar;
      rects.push({
        line,
        fromColumn,
        toColumn,
        // A range that continues past this line shows its newline as a
        // sliver of trailing box, the same convention selectionRects uses.
        toLineEnd: line !== last.line,
        face,
      });
    }
  }
  return rects;
}

/**
 * The on-screen position of every caret in CURSORS, in document order.
 * When `cursors` is omitted, falls back to `buffer.selections`. Used
 * by the renderer to paint one caret per cursor.
 *
 * @param {import('@editor/buffer').Buffer} buffer
 * @param {Array<{point: number, mark: number | null}>} [cursors]
 * @returns {{ line: number, column: number }[]}
 */
export function cursorPositions(buffer, cursors, tabWidth) {
  const list = Array.isArray(cursors)
    ? cursors
    : (buffer.selections ?? [{ point: buffer.point, mark: buffer.mark }]);
  const tabW = typeof tabWidth === 'number' && tabWidth > 0 ? tabWidth : 0;
  return list.map((c) => {
    const pos = buffer.positionAt(c.point);
    if (tabW <= 0) return pos;
    const lineMeta = buffer.lineAt(buffer.offsetAt(pos.line, 0));
    const lineText = typeof lineMeta.text === 'string'
      ? lineMeta.text
      : buffer.slice(lineMeta.from, lineMeta.to);
    return { line: pos.line, column: visualColumn(lineText, pos.column, tabW) };
  });
}
