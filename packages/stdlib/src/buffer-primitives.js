/**
 * @file The bridge from Lisp to an L2 buffer. `createBufferPrimitives`
 * produces the host procedures the standard library is written against
 * — movement, editing, selection and history.
 *
 * The primitives operate on a *session*'s current view's buffer rather
 * than a fixed one, so they keep working as the editor switches views.
 * The session is any object with a `currentView` getter returning a
 * View; a View's `buffer` slot is the L2 buffer (or `null`, for non-
 * text views — calling a buffer primitive then raises `'no-buffer-here`).
 *
 * The buffer-vs-view split (plans/PANES.md, "View as primary"):
 * text-editing primitives (`point`, `insert!`, `buffer-text`, …) keep
 * their names — they operate on the *underlying text*, which is still
 * a buffer. The primitives that *address* the on-screen thing
 * (`view-name`, `set-view-name!`) live here too but were renamed away
 * from `buffer-name` etc. — the addressable thing is now the view.
 *
 * Naming follows the spec: procedures that mutate end in `!`.
 */

import { LispError, NIL, arrayToList, cons } from '@editor/lisp';

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
 * The session is an object with a `currentView` property (a View, as
 * `@editor/view`'s `createView` returns). The View's `buffer` slot is
 * the L2 buffer text primitives operate on; a non-text view (null
 * buffer) makes those primitives raise `'no-buffer-here`.
 *
 * A small backward-compat path is provided: if a caller still passes
 * the old shape `{ current: Buffer }`, that buffer is wrapped in a
 * synthetic text view. The desktop app's session uses the new shape;
 * the buffer-menu test fixtures used the old shape and benefit from
 * not having to know about `@editor/view`.
 *
 * @param {{ currentView?: import('@editor/view').View, current?: import('@editor/buffer').Buffer }} session
 * @returns {Record<string, (args: *[]) => *>} A map of primitive name
 *   to implementation, ready for `createInterpreter({ primitives })`.
 */
export function createBufferPrimitives(session) {
  /** The current text view (if any), or null. The view owns point and
   *  mark — per-view-point (plans/PANES.md Q2). */
  const currentTextView = () => {
    if (typeof session.currentView !== 'undefined') {
      const view = session.currentView;
      return view && view.buffer ? view : null;
    }
    return null;
  };

  /** The L2 buffer the text primitives act on, or null. The buffer's
   *  own `point`/`mark` getters route through `buffer.bindCursor(view)`
   *  — see `@editor/buffer` — so when a view is bound the cursor reads
   *  and writes land on the view's own fields. */
  const currentBuffer = () => {
    const view = currentTextView();
    if (view) {
      // Make sure the buffer's cursor is bound to the live view so
      // primitives that read `buf.point` / `buf.mark` see (and mutate)
      // the view's per-view-point state. Idempotent — bindCursor just
      // swaps the cursor source.
      if (typeof view.buffer.bindCursor === 'function' &&
          typeof view.point === 'number') {
        view.buffer.bindCursor(view);
      }
      return view.buffer;
    }
    // Old shape (test fixtures): a session with `current` returning a
    // Buffer directly. Treat it as a text view's buffer.
    if (typeof session.current !== 'undefined') {
      return session.current ?? null;
    }
    return null;
  };

  /** The buffer to act on right now. Raises when the current view has
   *  no buffer (e.g. an image view, a shell view) so the call site
   *  surfaces a clear error rather than reading `null.text`. */
  const buffer = () => {
    const buf = currentBuffer();
    if (buf === null) {
      throw new LispError('no-buffer-here: current view has no buffer');
    }
    return buf;
  };

  // Movement extends the selection when the call asks (a #t argument —
  // shift-style) or when the mark is set: once a region is active, the
  // cursor keeps extending it until the mark is cleared (C-g, an edit).
  const extend = (args) => ({
    extend: args[0] === true || buffer().mark !== null,
  });

  return {
    // --- reading --------------------------------------------------------
    // Text-editing primitives keep their names — they operate on the
    // underlying text data, not the on-screen addressable thing.
    'buffer-text': () => buffer().text,
    'buffer-length': () => buffer().length,
    'buffer-line-count': () => buffer().lineCount,
    // `view-name` (formerly `buffer-name`): the modeline label of the
    // current view. For text views this delegates to the buffer's
    // name (since text views derive their name from the buffer); for
    // non-text views the view supplies its own name.
    'view-name': () => {
      if (typeof session.currentView !== 'undefined') {
        return session.currentView ? session.currentView.name : '';
      }
      return buffer().name;
    },
    'point': () => buffer().point,
    'mark': () => (buffer().mark === null ? NIL : buffer().mark),
    'buffer-substring': (args) =>
      buffer().slice(offset(args[0]), offset(args[1])),
    'line-start': () => buffer().lineAt(buffer().point).from,
    'line-end': () => buffer().lineAt(buffer().point).to,
    'line-indent': () => /^[ \t]*/.exec(buffer().lineAt(buffer().point).text)[0],
    // --- modes — L2 stores the mode; the stdlib gives it meaning -------
    // The two read primitives tolerate a buffer-less current view —
    // they return nil rather than raising. The keymap chain (modes.lisp)
    // calls them every keystroke, including in non-text views; a
    // non-text view simply has no mode chain, and the global keymap
    // takes over. The `set-` mutators still raise — they only make
    // sense in a buffer.
    'buffer-major-mode': () => {
      const buf = currentBuffer();
      return buf && buf.majorMode != null ? buf.majorMode : NIL;
    },
    'set-major-mode!': (args) => {
      buffer().majorMode = args[0];
      return NIL;
    },
    'buffer-minor-modes': () => {
      const buf = currentBuffer();
      return buf && buf.minorModes != null ? buf.minorModes : NIL;
    },
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
      // One undo step for the whole fill (delete + insert).
      buf.beginChangeGroup();
      try {
        buf.moveTo(from);
        buf.deleteForward(to - from);
        buf.insert(wrapped.join('\n'));
      } finally {
        buf.endChangeGroup();
      }
      return NIL;
    },
    // Atomic undo grouping: every edit between the begin/end pair lands
    // on the undo stack as ONE step. Lisp code should reach these
    // through `atomic-change-group` (editing.lisp), which closes the
    // group even when the body raises.
    'begin-change-group!': () => {
      buffer().beginChangeGroup();
      return NIL;
    },
    'end-change-group!': () => {
      buffer().endChangeGroup();
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

    // --- multi-cursor / multi-selection --------------------------------
    'add-selection!': (args) => {
      const b = buffer();
      const point = offset(args[0]);
      const mark = args.length > 1 && args[1] !== NIL ? offset(args[1]) : null;
      b.addSelection(point, mark);
      return NIL;
    },
    'collapse-to-primary!': () => {
      buffer().collapseToPrimary();
      return NIL;
    },
    'cursor-count': () => buffer().cursorCount,
    'selections': () => {
      // Each entry surfaces as a (point . mark-or-nil) pair so Lisp can
      // walk the list with car/cdr.
      const b = buffer();
      return arrayToList(
        b.selections.map((s) => cons(s.point, s.mark === null ? NIL : s.mark))
      );
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
    'set-buffer-text!': (args) => {
      buffer().setText(String(args[0]));
      return NIL;
    },
    // `set-view-name!` (formerly `set-buffer-name!`): rename the
    // current view. For text views the rename is mirrored to the
    // underlying buffer's name (text views derive their display name
    // from the buffer); for non-text views the view's own name is
    // updated.
    'set-view-name!': (args) => {
      const newName = String(args[0]);
      if (typeof session.currentView !== 'undefined') {
        const view = session.currentView;
        if (view) {
          view.name = newName;
          if (view.buffer) view.buffer.name = newName;
        }
      } else {
        buffer().name = newName;
      }
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
