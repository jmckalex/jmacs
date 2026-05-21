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

  /** Whether a movement call asked to extend the selection. */
  const extend = (args) => ({ extend: args[0] === true });

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
      buffer().moveTo(offset(args[0]));
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
