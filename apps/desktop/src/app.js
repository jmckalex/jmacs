/**
 * @file Renderer-process entry point. Wires the whole editor together:
 * an L2 buffer, an L4 editor view, a Lisp interpreter whose primitives
 * manipulate that buffer, a REPL panel, and a modeline.
 *
 * Because the interpreter's buffer primitives operate on the same
 * buffer the editor view is showing, Lisp typed into the REPL edits the
 * visible document live.
 */

import { createBuffer } from '@editor/buffer';
import { createInterpreter, LispError, NIL, writeString } from '@editor/lisp';
import { createEditorView, createReplView } from '@editor/renderer';

const WELCOME = `Welcome.

This is a Lisp-extensible editor. The whole stack is running:

  storage   (L1)   the text itself
  buffer    (L2)   cursor, selection, editing commands, undo
  lisp      (L3)   a custom Lisp — reader, evaluator, macros
  renderer  (L4)   these lines, the cursor, the REPL below

Type anywhere — the text is a live buffer.

The REPL below shares this buffer. Try evaluating:

  (+ 1 2 3 4)
  (buffer-line-count)
  (insert! "  <- Lisp wrote this")
  (map (lambda (x) (* x x)) (range 1 8))

Lisp that ends in ! changes the buffer; watch this text move.
`;

const buffer = createBuffer(WELCOME, { name: 'welcome.txt' });

const editorView = createEditorView(buffer, document.getElementById('editor-host'));

// --- modeline -----------------------------------------------------------

const nameEl = document.getElementById('modeline-name');
const positionEl = document.getElementById('modeline-position');

function updateModeline() {
  nameEl.textContent = buffer.name;
  const { line, column } = buffer.positionAt(buffer.point);
  positionEl.textContent = `Ln ${line + 1}, Col ${column + 1}`;
}

buffer.onChange(updateModeline);
updateModeline();

// --- Lisp + REPL --------------------------------------------------------

/** A small integer argument, or a clear error for the REPL. */
function asOffset(name, value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new LispError(`${name}: expected an integer offset`);
  }
  return value;
}

/**
 * Buffer primitives — host procedures, bound to the editor's buffer,
 * that the interpreter exposes to Lisp. Names ending in `!` mutate.
 */
const bufferPrimitives = {
  'buffer-text': () => buffer.text,
  'buffer-length': () => buffer.length,
  'buffer-line-count': () => buffer.lineCount,
  'buffer-name': () => buffer.name,
  'point': () => buffer.point,
  'buffer-substring': (args) =>
    buffer.slice(asOffset('buffer-substring', args[0]), asOffset('buffer-substring', args[1])),
  'goto!': (args) => {
    buffer.moveTo(asOffset('goto!', args[0]));
    return NIL;
  },
  'insert!': (args) => {
    buffer.insert(String(args[0]));
    return NIL;
  },
  'delete-backward!': (args) => {
    buffer.deleteBackward(args.length > 0 ? asOffset('delete-backward!', args[0]) : 1);
    return NIL;
  },
  'delete-forward!': (args) => {
    buffer.deleteForward(args.length > 0 ? asOffset('delete-forward!', args[0]) : 1);
    return NIL;
  },
};

const repl = createReplView(document.getElementById('repl-host'), {
  prompt: 'λ ',
  welcome: 'REPL — type Lisp, press Enter. Buffer primitives end in !.',
  onSubmit: evaluateInRepl,
});

const interpreter = createInterpreter({
  write: (text) => repl.appendOutput(text),
  primitives: bufferPrimitives,
});

/** Evaluate a line of REPL input and show the result. */
function evaluateInRepl(source) {
  try {
    repl.appendResult(writeString(interpreter.evaluate(source)));
  } catch (error) {
    repl.appendError(error.lispMessage ?? error.message ?? String(error));
  }
}

editorView.focus();
