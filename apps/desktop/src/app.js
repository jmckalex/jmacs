/**
 * @file Renderer-process entry point. Wires the whole editor together:
 * an L2 buffer, an L4 editor view, a Lisp interpreter, the standard
 * library (commands + keymap), a REPL panel, and a modeline.
 *
 * Every keystroke in the editor is dispatched through the Lisp keymap;
 * the REPL shares the same interpreter and buffer. The editor's
 * behaviour is Lisp, live.
 */

import { createBuffer } from '@editor/buffer';
import { createInterpreter, writeString } from '@editor/lisp';
import { createEditorView, createReplView } from '@editor/renderer';
import { createBufferPrimitives, loadStdlib } from '@editor/stdlib';

const WELCOME = `Welcome.

This is a Lisp-extensible editor. The whole stack is running:

  storage   (L1)   the text itself
  buffer    (L2)   cursor, selection, editing commands, undo
  lisp      (L3)   a custom Lisp — reader, evaluator, macros
  stdlib           the editor's commands and keymap, in Lisp
  renderer  (L4)   these lines, the cursor, the REPL below

Every key you press runs a Lisp command. Arrows, selection, undo —
all defined in packages/stdlib/lisp/, not hardcoded.

The REPL below shares this buffer and this interpreter. Try:

  (doc forward-char)        ;; ask a command what it does
  the-keymap                ;; see the bindings
  (insert! "  <- from Lisp")

And then redefine the editor while it runs:

  (define (newline) (insert! "\\n;; "))

...now press Enter in this buffer. You just changed the editor.
`;

const buffer = createBuffer(WELCOME, { name: 'welcome.txt' });

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

// --- Lisp interpreter and REPL -----------------------------------------

const repl = createReplView(document.getElementById('repl-host'), {
  prompt: 'λ ',
  welcome: 'REPL — type Lisp, press Enter. It shares the editor buffer.',
  onSubmit: evaluateInRepl,
});

const interpreter = createInterpreter({
  write: (text) => repl.appendOutput(text),
  primitives: createBufferPrimitives(buffer),
});

/** Evaluate a line of REPL input and show the result. */
function evaluateInRepl(source) {
  try {
    repl.appendResult(writeString(interpreter.evaluate(source)));
  } catch (error) {
    repl.appendError(error.lispMessage ?? error.message ?? String(error));
  }
}

// Load the standard library — the commands and keymap, written in Lisp.
let keymapReady = false;
try {
  await loadStdlib(interpreter, (name) =>
    fetch(`app://editor/packages/stdlib/lisp/${name}`).then((response) =>
      response.text()
    )
  );
  keymapReady = true;
} catch (error) {
  repl.appendError(`standard library failed to load: ${error.message}`);
}

/** Dispatch a keystroke through the Lisp keymap. */
function dispatchKey(key) {
  try {
    return interpreter.call('handle-key', key) === true;
  } catch (error) {
    repl.appendError(error.lispMessage ?? error.message ?? String(error));
    return true; // consume the key; the error is visible in the REPL
  }
}

// --- editor view --------------------------------------------------------

const editorView = createEditorView(
  buffer,
  document.getElementById('editor-host'),
  keymapReady ? { onKey: dispatchKey } : {}
);

editorView.focus();
