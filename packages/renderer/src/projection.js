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
 * The set of lines a selection touches, with the column span selected
 * on each. Used to paint selection highlights one rectangle per line.
 *
 * Per-view-point: takes the cursor offset (`point`) and selection
 * anchor (`mark`) as explicit arguments. When invoked with two
 * arguments only, the second arg is taken as a `{point, mark}` shape
 * (the legacy callers passed the whole buffer in that slot — kept
 * for back-compat with renderer unit tests).
 *
 * @param {import('@editor/buffer').Buffer} buffer
 * @param {number | { point: number, mark: number | null }} [pointOrCursor]
 * @param {number | null} [maybeMark]
 * @returns {{ line: number, fromColumn: number, toColumn: number,
 *   toLineEnd: boolean }[]} One entry per touched line. `toLineEnd` is
 *   true when the selection continues past this line (its newline is
 *   selected), so the highlight should run to the line's end.
 */
export function selectionRects(buffer, pointOrCursor, maybeMark) {
  let point;
  let mark;
  if (typeof pointOrCursor === 'number') {
    point = pointOrCursor;
    mark = maybeMark === undefined ? null : maybeMark;
  } else if (pointOrCursor && typeof pointOrCursor === 'object') {
    point = pointOrCursor.point;
    mark = pointOrCursor.mark ?? null;
  } else {
    point = buffer.point;
    mark = buffer.mark;
  }
  if (mark === null || mark === point) return [];

  const selection = { start: Math.min(point, mark), end: Math.max(point, mark) };

  const first = buffer.positionAt(selection.start);
  const last = buffer.positionAt(selection.end);
  const rects = [];

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
  return rects;
}
