/**
 * @file The bridge from Lisp to an L2 buffer. `createBufferPrimitives`
 * produces the host procedures the standard library is written against
 * — movement, editing, selection and history.
 *
 * The primitives operate on a *session*'s current buffer rather than a
 * fixed one, so they keep working as the editor switches buffers. The
 * session is any object with a `current` property holding an L2 buffer.
 *
 * Naming follows the spec: procedures that mutate end in `!`.
 */

import { LispError, NIL } from '@editor/lisp';

/** Assert a value is an integer offset. */
function offset(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new LispError('expected an integer offset');
  }
  return value;
}

/** Whether a character is part of a word. */
const isWordChar = (ch) => /\w/.test(ch);

/** The offset of the next word boundary at or after `from`. */
function forwardWord(text, from) {
  let i = from;
  while (i < text.length && !isWordChar(text[i])) i += 1;
  while (i < text.length && isWordChar(text[i])) i += 1;
  return i;
}

/** The offset of the previous word boundary at or before `from`. */
function backwardWord(text, from) {
  let i = from;
  while (i > 0 && !isWordChar(text[i - 1])) i -= 1;
  while (i > 0 && isWordChar(text[i - 1])) i -= 1;
  return i;
}

/**
 * The offset just past the end of the sentence at or after `from`. A
 * sentence ends at `.`, `!` or `?` followed by whitespace or the end of
 * the buffer.
 */
function forwardSentence(text, from) {
  const match = /[.!?](\s|$)/.exec(text.slice(from));
  return match ? from + match.index + 1 : text.length;
}

/** The offset of the start of the sentence before `from`. */
function backwardSentence(text, from) {
  let start = 0;
  const ends = /[.!?](\s|$)/g;
  let match;
  while ((match = ends.exec(text)) !== null) {
    let s = match.index + 1;
    while (s < text.length && /\s/.test(text[s])) s += 1;
    if (s >= from) break;
    start = s;
  }
  return start;
}

/** Re-wrap a paragraph's words to a fill column, keeping its indent. */
function fillParagraph(words, indent, fillColumn) {
  const lines = [];
  let current = indent + words[0];
  for (let w = 1; w < words.length; w += 1) {
    if ((current + ' ' + words[w]).length > fillColumn) {
      lines.push(current);
      current = indent + words[w];
    } else {
      current += ' ' + words[w];
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Build the buffer primitives for a session.
 *
 * @param {{ current: import('@editor/buffer').Buffer }} session - An
 *   object whose `current` property is the buffer to operate on.
 * @returns {Record<string, (args: *[]) => *>} A map of primitive name
 *   to implementation, ready for `createInterpreter({ primitives })`.
 */
export function createBufferPrimitives(session) {
  /** The buffer to act on right now. */
  const buffer = () => session.current;

  // Movement extends the selection when the call asks (a #t argument —
  // shift-style) or when the mark is set: once a region is active, the
  // cursor keeps extending it until the mark is cleared (C-g, an edit).
  const extend = (args) => ({
    extend: args[0] === true || buffer().mark !== null,
  });

  return {
    // --- reading --------------------------------------------------------
    'buffer-text': () => buffer().text,
    'buffer-length': () => buffer().length,
    'buffer-line-count': () => buffer().lineCount,
    'buffer-name': () => buffer().name,
    'point': () => buffer().point,
    'mark': () => (buffer().mark === null ? NIL : buffer().mark),
    'buffer-substring': (args) =>
      buffer().slice(offset(args[0]), offset(args[1])),
    'line-start': () => buffer().lineAt(buffer().point).from,
    'line-end': () => buffer().lineAt(buffer().point).to,
    'line-indent': () => /^[ \t]*/.exec(buffer().lineAt(buffer().point).text)[0],
    // --- modes — L2 stores the mode; the stdlib gives it meaning -------
    'buffer-major-mode': () => buffer().majorMode ?? NIL,
    'set-major-mode!': (args) => {
      buffer().majorMode = args[0];
      return NIL;
    },
    'buffer-minor-modes': () => buffer().minorModes ?? NIL,
    'set-minor-modes!': (args) => {
      buffer().minorModes = args[0];
      return NIL;
    },
    'word-forward-offset': () => forwardWord(buffer().text, buffer().point),
    'word-backward-offset': () => backwardWord(buffer().text, buffer().point),
    'sentence-forward-offset': () =>
      forwardSentence(buffer().text, buffer().point),
    'sentence-backward-offset': () =>
      backwardSentence(buffer().text, buffer().point),
    'fill-paragraph!': () => {
      const buf = buffer();
      const lines = buf.text.split('\n');
      const cursorLine = buf.positionAt(buf.point).line;
      const isBlank = (i) =>
        i < 0 || i >= lines.length || lines[i].trim() === '';
      if (isBlank(cursorLine)) return NIL;

      // The paragraph is the run of non-blank lines around the cursor.
      let start = cursorLine;
      while (!isBlank(start - 1)) start -= 1;
      let end = cursorLine;
      while (!isBlank(end + 1)) end += 1;

      const indent = /^[ \t]*/.exec(lines[start])[0];
      const words = lines
        .slice(start, end + 1)
        .join(' ')
        .trim()
        .split(/\s+/);
      const wrapped = fillParagraph(words, indent, 72);

      const from = buf.offsetAt(start, 0);
      const to = buf.offsetAt(end, lines[end].length);
      buf.moveTo(from);
      buf.deleteForward(to - from);
      buf.insert(wrapped.join('\n'));
      return NIL;
    },
    'region-active?': () => buffer().selection !== null,
    'region-text': () => {
      const selection = buffer().selection;
      return selection === null
        ? ''
        : buffer().slice(selection.start, selection.end);
    },

    // --- cursor movement; an optional #t argument extends a selection --
    'cursor-left!': (args) => {
      buffer().moveLeft(extend(args));
      return NIL;
    },
    'cursor-right!': (args) => {
      buffer().moveRight(extend(args));
      return NIL;
    },
    'cursor-up!': (args) => {
      buffer().moveUp(extend(args));
      return NIL;
    },
    'cursor-down!': (args) => {
      buffer().moveDown(extend(args));
      return NIL;
    },
    'cursor-line-start!': (args) => {
      buffer().moveLineStart(extend(args));
      return NIL;
    },
    'cursor-line-end!': (args) => {
      buffer().moveLineEnd(extend(args));
      return NIL;
    },
    'cursor-buffer-start!': (args) => {
      buffer().moveBufferStart(extend(args));
      return NIL;
    },
    'cursor-buffer-end!': (args) => {
      buffer().moveBufferEnd(extend(args));
      return NIL;
    },
    'goto!': (args) => {
      // Like the cursor commands, a jump extends an active region.
      buffer().moveTo(offset(args[0]), { extend: buffer().mark !== null });
      return NIL;
    },

    // --- selection ------------------------------------------------------
    'set-mark!': (args) => {
      const b = buffer();
      b.setMark(args.length > 0 ? offset(args[0]) : b.point);
      return NIL;
    },
    'clear-mark!': () => {
      buffer().clearMark();
      return NIL;
    },

    // --- editing --------------------------------------------------------
    'insert!': (args) => {
      buffer().insert(String(args[0]));
      return NIL;
    },
    'delete-backward!': () => {
      buffer().deleteBackward();
      return NIL;
    },
    'delete-forward!': () => {
      buffer().deleteForward();
      return NIL;
    },
    'delete-region!': (args) => {
      const a = offset(args[0]);
      const b = offset(args[1]);
      const buf = buffer();
      buf.moveTo(Math.min(a, b));
      buf.deleteForward(Math.abs(b - a));
      return NIL;
    },

    // --- history --------------------------------------------------------
    'undo!': () => {
      buffer().undo();
      return NIL;
    },
    'redo!': () => {
      buffer().redo();
      return NIL;
    },
  };
}
