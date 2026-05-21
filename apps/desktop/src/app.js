/**
 * @file Renderer-process entry point. Wires the whole editor together:
 * an L2 buffer, an L4 editor view, a Lisp interpreter, the standard
 * library (commands + keymap), file open/save, a REPL panel, and a
 * modeline.
 *
 * Every keystroke in the editor is dispatched through the Lisp keymap;
 * the REPL shares the same interpreter and buffer. The editor's
 * behaviour is Lisp, live.
 */

import { createBuffer } from '@editor/buffer';
import { createInterpreter, NIL, writeString } from '@editor/lisp';
import { createEditorView, createReplView } from '@editor/renderer';
import { createBufferPrimitives, loadStdlib } from '@editor/stdlib';

const WELCOME = `Welcome.

This is a Lisp-extensible editor. The whole stack is running:

  storage   (L1)   the text itself
  buffer    (L2)   cursor, selection, editing commands, undo
  lisp      (L3)   a custom Lisp — reader, evaluator, macros
  stdlib           the editor's commands and keymap, in Lisp
  renderer  (L4)   these lines, the cursor, the REPL below

Every key you press runs a Lisp command, defined in
packages/stdlib/lisp/ — not hardcoded.

  C-x C-f open a file      C-x C-s save the buffer
  C-z     undo             C-S-z   redo

The REPL below shares this buffer and this interpreter. Try:

  (doc forward-char)        ;; ask a command what it does
  the-keymap                ;; see the bindings
  (insert! "  <- from Lisp")

And then redefine the editor while it runs:

  (define (newline) (insert! "\\n;; "))

...now press Enter in this buffer. You just changed the editor.
`;

const buffer = createBuffer(WELCOME, { name: 'welcome.txt' });

// The file the buffer is associated with, and whether it has unsaved
// changes since it was last opened or saved.
let currentPath = null;
let dirty = false;

// --- modeline -----------------------------------------------------------

const nameEl = document.getElementById('modeline-name');
const positionEl = document.getElementById('modeline-position');

function updateModeline() {
  nameEl.textContent = (dirty ? '● ' : '') + buffer.name;
  const { line, column } = buffer.positionAt(buffer.point);
  positionEl.textContent = `Ln ${line + 1}, Col ${column + 1}`;
}

buffer.onChange((event) => {
  if (event.change !== null) dirty = true;
  updateModeline();
});
updateModeline();

// --- file open / save ---------------------------------------------------

/** Mark the buffer clean (just opened or saved) and refresh the modeline. */
function markClean() {
  dirty = false;
  updateModeline();
}

async function openFileInteractive() {
  try {
    const result = await window.host.openFile();
    if (result === null) return;
    buffer.setText(result.content);
    buffer.name = result.name;
    currentPath = result.path;
    markClean();
  } catch (error) {
    repl.appendError(`open failed: ${error.message}`);
  }
}

async function saveBufferInteractive() {
  try {
    const result = await window.host.saveFile(currentPath, buffer.text);
    if (result === null) return;
    currentPath = result.path;
    buffer.name = result.name;
    markClean();
  } catch (error) {
    repl.appendError(`save failed: ${error.message}`);
  }
}

// --- Lisp interpreter and REPL -----------------------------------------

const repl = createReplView(document.getElementById('repl-host'), {
  prompt: 'λ ',
  welcome: 'REPL — type Lisp, press Enter. It shares the editor buffer.',
  onSubmit: evaluateInRepl,
});

const interpreter = createInterpreter({
  write: (text) => repl.appendOutput(text),
  primitives: {
    ...createBufferPrimitives(buffer),
    // File commands run async work (a dialog, IPC) and return at once;
    // the buffer updates when the operation completes.
    'open-file!': () => {
      openFileInteractive();
      return NIL;
    },
    'save-buffer!': () => {
      saveBufferInteractive();
      return NIL;
    },
  },
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
