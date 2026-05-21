/**
 * @file Renderer-process entry point. Wires the whole editor together:
 * a list of L2 buffers, an L4 editor view, a Lisp interpreter, the
 * standard library (commands + keymap), file open/save, a REPL panel,
 * and a modeline.
 *
 * Every keystroke in the editor is dispatched through the Lisp keymap;
 * the REPL shares the same interpreter. The editor's behaviour is Lisp,
 * live.
 */

import { createBuffer } from '@editor/buffer';
import { createInterpreter, listToArray, NIL, writeString } from '@editor/lisp';
import {
  createEditorView,
  createJavaScriptHighlighter,
  createMinibuffer,
  createReplView,
  fuzzyFilter,
} from '@editor/renderer';
import { createBufferPrimitives, loadStdlib } from '@editor/stdlib';

const WELCOME = `Welcome.

This is a Lisp-extensible editor. The whole stack is running:

  storage   (L1)   the text itself
  buffer    (L2)   cursor, selection, editing commands, undo
  lisp      (L3)   a custom Lisp — reader, evaluator, macros, modules
  stdlib           the editor's commands and keymap, in Lisp
  renderer  (L4)   these lines, the cursor, the REPL below

Every key you press runs a Lisp command from packages/stdlib/lisp/.

  C-x C-f open a file      C-x C-s save the buffer
  C-x b   next buffer      C-x n   new buffer
  C-x C-r reload the editor's own Lisp (hot reload)
  C-z     undo             C-S-z   redo

The REPL below shares this interpreter. Try:

  (doc forward-char)        ;; ask a command what it does
  (module m (export hi) (define (hi) "hello"))
  (insert! "  <- from Lisp")
`;

const SCRATCH = `;; scratch.lisp — a buffer for evaluating Lisp.
;;
;; This buffer is syntax-highlighted because its name ends in .lisp.
;; Edit freely; press C-x b to switch back to the welcome buffer.

(define (factorial n)
  "The classic recursion."
  (if (= n 0)
      1
      (* n (factorial (- n 1)))))

(define greeting "hello, world")
`;

// --- buffers ------------------------------------------------------------

/** Every open buffer; one is current. */
const buffers = [
  createBuffer(WELCOME, { name: 'welcome.txt' }),
  createBuffer(SCRATCH, { name: 'scratch.lisp' }),
];
let currentIndex = 0;

/** The session object the buffer primitives operate through. */
const session = {
  get current() {
    return buffers[currentIndex];
  },
};

/** Buffers with unsaved changes. */
const dirtyBuffers = new Set();

// --- modeline -----------------------------------------------------------

const nameEl = document.getElementById('modeline-name');
const positionEl = document.getElementById('modeline-position');

function updateModeline() {
  const buffer = session.current;
  const mark = dirtyBuffers.has(buffer) ? '● ' : '';
  const count = buffers.length > 1 ? `  ${currentIndex + 1}/${buffers.length}` : '';
  nameEl.textContent = mark + buffer.name + count;
  const { line, column } = buffer.positionAt(buffer.point);
  positionEl.textContent = `Ln ${line + 1}, Col ${column + 1}`;
}

// Watch the current buffer for changes; re-subscribed when it switches.
let unwatch = () => {};
function watchCurrentBuffer() {
  unwatch();
  const buffer = session.current;
  unwatch = buffer.onChange((event) => {
    if (event.change !== null) dirtyBuffers.add(buffer);
    updateModeline();
  });
}

/** Switch to the buffer at `index`: re-point the view and the modeline. */
function switchToBuffer(index) {
  if (index < 0 || index >= buffers.length) return;
  currentIndex = index;
  editorView.setBuffer(session.current);
  watchCurrentBuffer();
  updateModeline();
}

// --- file open / save ---------------------------------------------------

async function openFileInteractive() {
  try {
    const result = await window.host.openFile();
    if (result === null) return;
    const buffer = createBuffer(result.content, { name: result.name });
    buffer.filePath = result.path;
    buffers.push(buffer);
    switchToBuffer(buffers.length - 1);
  } catch (error) {
    repl.appendError(`open failed: ${error.message}`);
  }
}

async function saveBufferInteractive() {
  const buffer = session.current;
  try {
    const result = await window.host.saveFile(buffer.filePath ?? null, buffer.text);
    if (result === null) return;
    buffer.filePath = result.path;
    buffer.name = result.name;
    dirtyBuffers.delete(buffer);
    updateModeline();
  } catch (error) {
    repl.appendError(`save failed: ${error.message}`);
  }
}

// --- incremental search -------------------------------------------------

const minibuffer = createMinibuffer(document.getElementById('minibuffer-host'));

/** Run an incremental forward search in the minibuffer. */
function startSearch() {
  const buffer = session.current;
  const origin = buffer.point;
  let lastMatch = -1;

  /** Select the match at `index` so the editor highlights it. */
  function showMatch(index, query) {
    buffer.moveTo(index);
    buffer.moveTo(index + query.length, { extend: true });
    lastMatch = index;
  }

  minibuffer.prompt('I-search: ', {
    onChange(query) {
      if (query === '') {
        buffer.moveTo(origin);
        lastMatch = -1;
        minibuffer.setStatus('');
        return;
      }
      const index = buffer.text.indexOf(query, origin);
      if (index >= 0) {
        showMatch(index, query);
        minibuffer.setStatus('');
      } else {
        minibuffer.setStatus('no match');
      }
    },
    onKey(key, query) {
      // A repeated C-s advances to the next match.
      if (key === 'C-s' && query !== '') {
        const from = lastMatch >= 0 ? lastMatch + 1 : origin;
        const index = buffer.text.indexOf(query, from);
        if (index >= 0) {
          showMatch(index, query);
          minibuffer.setStatus('');
        } else {
          minibuffer.setStatus('no more matches');
        }
        return true;
      }
      return false;
    },
    onSubmit() {
      buffer.clearMark(); // keep the cursor at the match
      editorView.focus();
    },
    onCancel() {
      buffer.moveTo(origin);
      editorView.focus();
    },
  });
}

// --- command palette (M-x) ---------------------------------------------

/** Run the command palette in the minibuffer. */
function startCommandPalette() {
  const names = [...new Set(listToArray(interpreter.call('command-names')))];

  minibuffer.prompt('M-x ', {
    onChange(query) {
      const matches = fuzzyFilter(query, names);
      if (matches.length === 0) {
        minibuffer.setStatus('no matching command');
        return;
      }
      // The first match runs on Enter; show it bracketed.
      const shown = matches.slice(0, 6);
      minibuffer.setStatus(
        `[${shown[0]}]` +
          (shown.length > 1 ? '  ' + shown.slice(1).join('  ') : '')
      );
    },
    onSubmit(query) {
      editorView.focus();
      const chosen = fuzzyFilter(query, names)[0];
      if (chosen === undefined) return;
      try {
        interpreter.call(chosen);
      } catch (error) {
        repl.appendError(error.lispMessage ?? error.message ?? String(error));
      }
    },
    onCancel() {
      editorView.focus();
    },
  });
}

// --- Lisp interpreter and REPL -----------------------------------------

const repl = createReplView(document.getElementById('repl-host'), {
  prompt: 'λ ',
  welcome: 'REPL — type Lisp, press Enter. It shares the editor buffers.',
  onSubmit: evaluateInRepl,
});

const interpreter = createInterpreter({
  write: (text) => repl.appendOutput(text),
  primitives: {
    ...createBufferPrimitives(session),

    // File commands run async work and return at once.
    'open-file!': () => {
      openFileInteractive();
      return NIL;
    },
    'save-buffer!': () => {
      saveBufferInteractive();
      return NIL;
    },
    'reload-stdlib!': () => {
      reloadStdlib();
      return NIL;
    },
    'start-search!': () => {
      startSearch();
      return NIL;
    },
    'start-command-palette!': () => {
      startCommandPalette();
      return NIL;
    },

    // Buffer-list commands — they re-point the editor view.
    'next-buffer!': () => {
      switchToBuffer((currentIndex + 1) % buffers.length);
      return NIL;
    },
    'previous-buffer!': () => {
      switchToBuffer((currentIndex - 1 + buffers.length) % buffers.length);
      return NIL;
    },
    'new-buffer!': (args) => {
      const name =
        args.length > 0 ? String(args[0]) : `untitled-${buffers.length + 1}`;
      buffers.push(createBuffer('', { name }));
      switchToBuffer(buffers.length - 1);
      return NIL;
    },
    'buffer-count': () => buffers.length,
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

// --- standard library ---------------------------------------------------

/** Fetch the source of a standard-library file over the app:// scheme. */
function fetchStdlibSource(name) {
  return fetch(`app://editor/packages/stdlib/lisp/${name}`).then((response) =>
    response.text()
  );
}

/** Re-evaluate the standard library — hot reload of the editor itself. */
async function reloadStdlib() {
  try {
    await loadStdlib(interpreter, fetchStdlibSource);
    repl.appendNote('standard library reloaded');
  } catch (error) {
    repl.appendError(`reload failed: ${error.message}`);
  }
}

let keymapReady = false;
try {
  await loadStdlib(interpreter, fetchStdlibSource);
  keymapReady = true;
} catch (error) {
  repl.appendError(`standard library failed to load: ${error.message}`);
}

// The tree-sitter JavaScript highlighter (the Lisp keeps its tokenizer).
// Highlighting still works without it: JavaScript falls back line-based.
let highlightJavaScript = null;
try {
  const highlighter = await createJavaScriptHighlighter();
  highlightJavaScript = highlighter.highlight;
  document.body.dataset.treesitter = 'ready';
} catch (error) {
  repl.appendError(`JavaScript highlighter unavailable: ${error.message}`);
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
  session.current,
  document.getElementById('editor-host'),
  {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    highlightJavaScript,
  }
);

watchCurrentBuffer();
updateModeline();
editorView.focus();
