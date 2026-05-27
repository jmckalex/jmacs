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
export function selectionRects(buffer, cursorsOrPoint, maybeMark) {
  let cursors;
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
      const { from, to } = buffer.lineAt(buffer.offsetAt(line, 0));
      const lineLength = to - from;
      const fromColumn = line === first.line ? first.column : 0;
      const toColumn = line === last.line ? last.column : lineLength;
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
export function cursorPositions(buffer, cursors) {
  const list = Array.isArray(cursors)
    ? cursors
    : (buffer.selections ?? [{ point: buffer.point, mark: buffer.mark }]);
  return list.map((c) => buffer.positionAt(c.point));
}
