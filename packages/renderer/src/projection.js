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
export function visualColumn(line, charIndex, tabWidth) {
  const w = Math.max(1, tabWidth | 0);
  const stop = Math.min(charIndex, line.length);
  let col = 0;
  for (let i = 0; i < stop; i += 1) {
    if (line.charCodeAt(i) === 9) {
      col = (Math.floor(col / w) + 1) * w;
    } else {
      col += 1;
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
  for (let i = 0; i < line.length; i += 1) {
    let next;
    if (line.charCodeAt(i) === 9) {
      next = (Math.floor(col / w) + 1) * w;
    } else {
      next = col + 1;
    }
    if (next > targetCol) {
      // Target sits inside this glyph's span — pick the closer edge.
      return (targetCol - col) <= (next - targetCol) ? i : i + 1;
    }
    col = next;
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
