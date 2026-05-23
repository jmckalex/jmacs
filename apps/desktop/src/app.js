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
import {
  arrayToList,
  createInterpreter,
  listToArray,
  NIL,
  writeString,
} from '@editor/lisp';
import {
  createCustomizeView,
  createDocView,
  createEditorView,
  createHoverDoc,
  createImageView,
  createMarkdownPreview,
  createMinibuffer,
  createReplView,
  createTreeSitterHighlighter,
  fuzzyFilter,
  highlightLine,
  loadLanguageHighlighters,
  renderMarkdown,
} from '@editor/renderer';
import { createBufferPrimitives, loadStdlib } from '@editor/stdlib';
import { createSplash } from './splash.js';
import { createStickyNotes } from './sticky-notes.js';

const WELCOME = `

      jmacs


      A Lisp-extensible editor — a successor in spirit to Emacs, on a
      clean, legible foundation. Every key you press runs a command
      defined in Lisp; nothing here is hardcoded.


      Getting around

        C-h k    describe a key         C-x C-f   open a file
        M-x      run a command          C-x C-s   save the buffer
        C-x b    switch buffer          C-x C-c   quit
        C-x C-r  reload the editor's own Lisp — hot reload


      The REPL below shares this interpreter and these buffers.
      Try  (doc forward-char)  or  (insert! "  <- from Lisp").


      This is an ordinary, editable buffer. Type anywhere to begin.
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

/** The header of the machine-written custom.lisp settings file. */
const CUSTOM_FILE_HEADER = `;;; custom.lisp — your saved customisations.
;;;
;;; jmacs writes this file; edits made by hand will be overwritten the
;;; next time a setting is saved. For free-form configuration, use
;;; init.lisp instead.

`;

/** The commented init.lisp written into the config directory on first run. */
const INIT_TEMPLATE = `;;; init.lisp — your jmacs configuration.
;;;
;;; This file is evaluated at startup, after the standard library and
;;; your saved customisations. It is the jmacs equivalent of .emacs:
;;; ordinary Lisp, so anything goes — set variables, define commands,
;;; bind keys.
;;;
;;; Examples:
;;;   (custom-apply! '*markdown-interpreter* "pandoc -f markdown -t html")
;;;   (define (insert-divider) (insert! "\\n---\\n"))
`;

// --- buffers ------------------------------------------------------------

/** Every open buffer; one is current. */
const buffers = [
  createBuffer(WELCOME, { name: 'welcome.txt' }),
  createBuffer(SCRATCH, { name: 'scratch.lisp' }),
];
let currentIndex = 0;

/** The L2 text buffer the editor view shows and the buffer primitives
 *  act on. Showing a customisation buffer does not change it. */
let currentTextBuffer = buffers[0];

/** The session object the buffer primitives operate through. */
const session = {
  get current() {
    return currentTextBuffer;
  },
};

/** Buffers with unsaved changes. */
const dirtyBuffers = new Set();

// --- modeline -----------------------------------------------------------

const nameEl = document.getElementById('modeline-name');
const positionEl = document.getElementById('modeline-position');

function updateModeline() {
  const shown = buffers[currentIndex];
  const count =
    buffers.length > 1 ? `  ${currentIndex + 1}/${buffers.length}` : '';
  // A special (non-text) buffer — a customisation buffer — has no
  // point and no mode.
  if (shown && shown.kind) {
    nameEl.textContent = shown.name + count;
    positionEl.textContent = '';
    document.title = `${shown.name} — editor`;
    return;
  }
  const buffer = currentTextBuffer;
  const mark = dirtyBuffers.has(buffer) ? '● ' : '';
  const mode = keymapReady
    ? `   ${interpreter.call('major-mode-name')}` +
      interpreter.call('minor-mode-line')
    : '';
  nameEl.textContent = mark + buffer.name + mode + count;
  const { line, column } = buffer.positionAt(buffer.point);
  positionEl.textContent = `Ln ${line + 1}, Col ${column + 1}`;
  // Reflect the current buffer in the OS window title.
  document.title = `${mark}${buffer.name} — editor`;
}

// Watch the current buffer for changes; re-subscribed when it switches.
let unwatch = () => {};
function watchCurrentBuffer() {
  unwatch();
  const buffer = session.current;
  unwatch = buffer.onChange((event) => {
    if (event.change !== null) {
      dirtyBuffers.add(buffer);
      dismissSplash();
      // Keep the Markdown preview pane in step with the buffer.
      refreshMarkdownPreview();
    }
    updateModeline();
  });
}

/** Give the current buffer a major mode if it has none yet. */
function ensureMajorMode() {
  if (keymapReady && session.current.majorMode === null) {
    try {
      interpreter.call('choose-major-mode!');
    } catch (error) {
      repl.appendError(`mode selection failed: ${error.message}`);
    }
  }
}

/** Show the view for `kind` — the editor view, the customisation view,
 *  the image view, or the documentation view — hiding the others. */
function mountView(kind) {
  editorView.element.style.display = kind === 'text' ? '' : 'none';
  customizeView.element.style.display = kind === 'customize' ? '' : 'none';
  imageView.element.style.display = kind === 'image' ? '' : 'none';
  docView.element.style.display = kind === 'doc' ? '' : 'none';
}

/** Switch to the buffer at `index`: mount the matching view, re-point
 *  it, and update the modeline. */
function switchToBuffer(index) {
  if (index < 0 || index >= buffers.length) return;
  dismissSplash();
  currentIndex = index;
  const buffer = buffers[index];
  if (buffer.kind === 'customize') {
    mountView('customize');
    customizeView.setBuffer(buffer);
    customizeView.focus();
  } else if (buffer.kind === 'image') {
    mountView('image');
    imageView.setBuffer(buffer);
    imageView.focus();
  } else if (buffer.kind === 'doc') {
    mountView('doc');
    docView.setBuffer(buffer);
    docView.focus();
  } else {
    currentTextBuffer = buffer;
    mountView('text');
    editorView.setBuffer(buffer);
    stickyNotes.setBuffer(buffer);
    watchCurrentBuffer();
    ensureMajorMode();
    editorView.focus();
    refreshModeMenu();
    syncMarkdownPreviewToBuffer();
  }
  updateModeline();
}

/** Find or create the customisation buffer named `name`, switch to it. */
function openCustomize(name, scope) {
  let index = buffers.findIndex(
    (buffer) => buffer.kind === 'customize' && buffer.name === name
  );
  if (index < 0) {
    buffers.push({ kind: 'customize', name, scope });
    index = buffers.length - 1;
  }
  switchToBuffer(index);
}

/** Find or create the doc buffer for `docName`, fetching the HTML from
 *  the host if it isn't already open. */
async function openDocBuffer(docName) {
  const existing = buffers.findIndex(
    (buffer) => buffer.kind === 'doc' && buffer.docName === docName
  );
  if (existing >= 0) {
    switchToBuffer(existing);
    return;
  }
  let page;
  try {
    page = await window.host.readDocPage(docName);
  } catch (error) {
    repl.appendError(`doc: ${error.message}`);
    return;
  }
  if (page === null) {
    repl.appendError(`no doc page for ${docName}`);
    return;
  }
  buffers.push({
    kind: 'doc',
    name: `*Doc: ${docName}*`,
    docName,
    html: page.html,
  });
  switchToBuffer(buffers.length - 1);
}

/** Minimal HTML-escape for embedding a user-supplied name into an
 *  attribute or text node. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render NAME's docstring as Markdown and show it in a doc buffer.
 *  Reuses any existing doc buffer for the same NAME. This is the
 *  live path — for user-defined procedures whose documentation
 *  isn't in the pre-built manifest. */
async function openDocstringBuffer(docName, source) {
  const existing = buffers.findIndex(
    (buffer) => buffer.kind === 'doc' && buffer.docName === docName
  );
  if (existing >= 0) {
    switchToBuffer(existing);
    return;
  }
  let body;
  try {
    body = await renderMarkdownHtml(source);
  } catch (error) {
    repl.appendError(`doc render failed: ${error.message}`);
    return;
  }
  // Frame the rendered body so the doc-view's article styling
  // applies. The synthesised header matches the static pages'
  // shape: <h3><code>name</code></h3>, then the prose.
  const html =
    `<h3 class="doc-name"><code>${escapeHtml(docName)}</code></h3>\n` +
    `<div class="doc-docstring">${body}</div>`;
  buffers.push({
    kind: 'doc',
    name: `*Doc: ${docName}*`,
    docName,
    html,
  });
  switchToBuffer(buffers.length - 1);
}

// --- file open / save ---------------------------------------------------

async function openFileInteractive() {
  try {
    const result = await window.host.openFile();
    if (result === null) return;
    // An image file comes back with a ready-to-display `imageSrc`
    // (a data URL) rather than text — show it through the image view.
    if (typeof result.imageSrc === 'string') {
      buffers.push({
        kind: 'image',
        name: result.name,
        filePath: result.path,
        src: result.imageSrc,
      });
      switchToBuffer(buffers.length - 1);
      return;
    }
    const buffer = createBuffer(result.content, { name: result.name });
    buffer.filePath = result.path;
    // Load the file's sticky notes from its companion metadata file,
    // before the buffer is shown, so note anchors land against the
    // final text.
    const metadata = await window.host.readMetadata(result.path);
    if (metadata) buffer.metadata = metadata;
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
    // Persist sticky notes alongside the file — this also covers a
    // first save, when the buffer has only just gained a file path.
    await flushMetadata(buffer);
  } catch (error) {
    repl.appendError(`save failed: ${error.message}`);
  }
}

// --- sticky-note metadata ----------------------------------------------
// Sticky notes persist to a `<file>.jmacs-metadata` companion file.
// Writes are debounced and coalesced per buffer; a buffer with no file
// path keeps its notes in memory until its first save.

/** Pending debounced metadata writes, keyed by buffer. */
const metadataTimers = new Map();

/** Write a buffer's note metadata to its companion file. */
function writeMetadata(buffer) {
  if (!buffer.filePath) return Promise.resolve();
  return window.host
    .writeMetadata(buffer.filePath, buffer.metadata ?? { notes: [] })
    .catch((error) => repl.appendError(`metadata save failed: ${error.message}`));
}

/** Write a buffer's metadata now, cancelling any pending debounce. */
function flushMetadata(buffer) {
  clearTimeout(metadataTimers.get(buffer));
  metadataTimers.delete(buffer);
  return writeMetadata(buffer);
}

/** Schedule a debounced metadata write after a note change. */
function scheduleMetadataWrite(buffer) {
  if (!buffer.filePath) return;
  clearTimeout(metadataTimers.get(buffer));
  metadataTimers.set(buffer, setTimeout(() => flushMetadata(buffer), 600));
}

/** Flush every buffer with a pending metadata write. */
function flushAllMetadata() {
  return Promise.all(
    [...metadataTimers.keys()].map((buffer) => flushMetadata(buffer))
  );
}

/** Confirm unsaved changes, flush note metadata, then quit. */
async function quitInteractive() {
  const dirty = dirtyBuffers.size;
  if (
    dirty > 0 &&
    !window.confirm(`Discard unsaved changes in ${dirty} buffer(s)?`)
  ) {
    return;
  }
  await flushAllMetadata();
  window.host.quit();
}

// --- incremental search -------------------------------------------------

const minibuffer = createMinibuffer(document.getElementById('minibuffer-host'));

/** Run an incremental forward search in the minibuffer. */
function startSearch(initialDirection) {
  const buffer = session.current;
  const origin = buffer.point;
  let direction = initialDirection;
  let lastMatch = -1;

  /** Select the match at `index` so the editor highlights it. */
  function showMatch(index, query) {
    buffer.moveTo(index);
    buffer.moveTo(index + query.length, { extend: true });
    lastMatch = index;
  }

  /** Find `query` from offset `from` in `dir`. */
  function find(query, from, dir) {
    return dir === 'forward'
      ? buffer.text.indexOf(query, from)
      : buffer.text.lastIndexOf(query, from);
  }

  minibuffer.prompt(
    initialDirection === 'forward' ? 'I-search: ' : 'I-search backward: ',
    {
      onChange(query) {
        lastMatch = -1;
        if (query === '') {
          buffer.moveTo(origin);
          minibuffer.setStatus('');
          return;
        }
        const from = direction === 'forward' ? origin : Math.max(origin - 1, 0);
        const index = find(query, from, direction);
        if (index >= 0) {
          showMatch(index, query);
          minibuffer.setStatus('');
        } else {
          minibuffer.setStatus('no match');
        }
      },
      onKey(key, query) {
        // C-s / C-r advance to the next match, forward or backward.
        if ((key === 'C-s' || key === 'C-r') && query !== '') {
          direction = key === 'C-s' ? 'forward' : 'backward';
          const base = lastMatch >= 0 ? lastMatch : origin;
          const from = direction === 'forward' ? base + 1 : base - 1;
          const index = find(query, from, direction);
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
    }
  );
}

// --- command palette (M-x) ---------------------------------------------

/** Run the apropos-doc fuzzy search in the minibuffer. */
function startDocSearch() {
  let names;
  try {
    names = listToArray(interpreter.call('doc-manifest')).map(String);
  } catch (error) {
    repl.appendError(
      `apropos-doc: ${error.lispMessage ?? error.message}`
    );
    return;
  }
  if (names.length === 0) {
    repl.appendOutput(
      'apropos-doc: no docs are loaded — run `pnpm run docs` and reload.'
    );
    return;
  }
  minibuffer.prompt('Doc: ', {
    onChange(query) {
      const matches = fuzzyFilter(query, names);
      if (matches.length === 0) {
        minibuffer.setStatus('no matching doc');
        return;
      }
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
        interpreter.evaluate(`(open-doc ${JSON.stringify(chosen)})`);
      } catch (error) {
        repl.appendError(
          error.lispMessage ?? error.message ?? String(error)
        );
      }
    },
    onCancel() {
      editorView.focus();
    },
  });
}

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
        interpreter.evaluate(`(run-command (quote ${chosen}))`);
      } catch (error) {
        repl.appendError(error.lispMessage ?? error.message ?? String(error));
      }
    },
    onCancel() {
      editorView.focus();
    },
  });
}

/**
 * Switch to a buffer chosen by name, with completion, in the
 * minibuffer. A name that matches no open buffer creates a new one —
 * the minibuffer status shows when a submit would create rather than
 * switch.
 */
function startBufferSwitcher() {
  const names = buffers.map((buffer) => buffer.name);

  minibuffer.prompt('Buffer: ', {
    onChange(query) {
      const matches = fuzzyFilter(query, names);
      if (matches.length === 0) {
        const trimmed = query.trim();
        minibuffer.setStatus(trimmed === '' ? '' : `[new buffer: ${trimmed}]`);
        return;
      }
      const shown = matches.slice(0, 6);
      minibuffer.setStatus(
        `[${shown[0]}]` +
          (shown.length > 1 ? '  ' + shown.slice(1).join('  ') : '')
      );
    },
    onSubmit(query) {
      editorView.focus();
      const trimmed = query.trim();
      if (trimmed === '') return;
      // An exact name switches; otherwise the best fuzzy match does.
      const exact = buffers.findIndex((buffer) => buffer.name === trimmed);
      if (exact >= 0) {
        switchToBuffer(exact);
        return;
      }
      const chosen = fuzzyFilter(query, names)[0];
      if (chosen !== undefined) {
        switchToBuffer(buffers.findIndex((buffer) => buffer.name === chosen));
        return;
      }
      // No open buffer matches the typed name — create one.
      buffers.push(createBuffer('', { name: trimmed }));
      switchToBuffer(buffers.length - 1);
    },
    onCancel() {
      editorView.focus();
    },
  });
}

/** Pick a command in the minibuffer and show its documentation. */
function startDescribeCommand() {
  const names = [...new Set(listToArray(interpreter.call('command-names')))];

  minibuffer.prompt('Describe command: ', {
    onChange(query) {
      const matches = fuzzyFilter(query, names);
      if (matches.length === 0) {
        minibuffer.setStatus('no matching command');
        return;
      }
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
        interpreter.call('describe-named-command', chosen);
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

/** Cached doc-page names from `docs/build/manifest.json`. The
 *  `load-doc-manifest!` primitive returns this; populated near
 *  startup once the host has read the file. `null` means unknown
 *  / not loaded; `[]` means the manifest existed but is empty. */
let docManifestNames = null;

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
    // Themes set CSS custom properties on the document root. The Lisp
    // side holds the palettes and decides which is active; this is the
    // host hook that reads the current palette and writes it to the DOM.
    'apply-theme!': () => {
      applyCurrentTheme();
      return NIL;
    },
    // Documentation: open the doc page for NAME in a doc-kind buffer.
    // The page HTML is read from docs/build/ by the host (the
    // renderer is sandboxed). Unknown names print to the REPL.
    'open-doc!': (args) => {
      const name = String(args[0] ?? '');
      if (name === '') return NIL;
      openDocBuffer(name);
      return NIL;
    },
    // Documentation: open the fuzzy-search minibuffer with the
    // manifest's names as candidates; submit opens the matching
    // doc page.
    'start-doc-search!': () => {
      startDocSearch();
      return NIL;
    },
    // Documentation (live path): NAME's docstring is Markdown; render
    // it through `*markdown-interpreter*` and show the result in a
    // doc-kind buffer. Used by `(open-doc …)` for user-defined
    // procedures that aren't in the pre-built manifest.
    'open-docstring-page!': (args) => {
      const name = String(args[0] ?? '');
      const source = String(args[1] ?? '');
      if (name === '' || source === '') return NIL;
      openDocstringBuffer(name, source);
      return NIL;
    },
    // Documentation: return the (cached) list of doc-page names, or
    // `()` when the docs haven't been built. The Lisp side caches
    // this in *doc-manifest*. The manifest itself is fetched once
    // at startup (see `loadDocManifest` below) so this primitive
    // can be synchronous.
    'load-doc-manifest!': () =>
      docManifestNames === null ? NIL : arrayToList(docManifestNames),
    'start-search!': () => {
      startSearch('forward');
      return NIL;
    },
    'start-search-backward!': () => {
      startSearch('backward');
      return NIL;
    },
    'start-command-palette!': () => {
      startCommandPalette();
      return NIL;
    },
    'start-buffer-switcher!': () => {
      startBufferSwitcher();
      return NIL;
    },
    'start-describe-command!': () => {
      startDescribeCommand();
      return NIL;
    },
    // Open a minibuffer prompt for the command argument gatherer; the
    // result is delivered back to Lisp via `minibuffer-delivered`.
    'open-minibuffer!': (args) => {
      minibuffer.prompt(String(args[0]), {
        onSubmit(value) {
          editorView.focus();
          interpreter.call('minibuffer-delivered', value);
        },
        onCancel() {
          editorView.focus();
          interpreter.call('minibuffer-delivered', NIL);
        },
      });
      return NIL;
    },
    'goto-line!': (args) => {
      const buffer = session.current;
      const n = Number(args[0]);
      if (Number.isInteger(n) && n >= 1) {
        buffer.moveTo(buffer.offsetAt(Math.min(n, buffer.lineCount) - 1, 0));
      }
      return NIL;
    },
    'replace-all!': (args) => {
      const buffer = session.current;
      const search = String(args[0]);
      const replacement = String(args[1]);
      if (search !== '') {
        const text = buffer.text;
        const count = text.split(search).length - 1;
        if (count > 0) buffer.setText(text.split(search).join(replacement));
        repl.appendNote(
          count > 0
            ? `replaced ${count} occurrence(s) of "${search}"`
            : `"${search}" not found`
        );
      }
      return NIL;
    },
    'recenter!': () => {
      editorView.recenter();
      return NIL;
    },
    'page-lines': () => editorView.pageLines(),
    'toggle-repl!': () => {
      const hidden = document.body.classList.toggle('repl-hidden');
      if (hidden) editorView.focus();
      return NIL;
    },
    'markdown-preview!': () => {
      toggleMarkdownPreview();
      return NIL;
    },
    'quit-editor!': () => {
      quitInteractive();
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

    // Persist the customisation registry's saved settings to disk.
    'write-custom-file!': (args) => {
      writeCustomFile(args[0]);
      return NIL;
    },
    // Open (or switch to) a customisation buffer.
    'open-customize!': () => {
      openCustomize('*Customize*', { group: 'jmacs' });
      return NIL;
    },
    'open-customize-group!': (args) => {
      openCustomScope({ group: String(args[0]) });
      return NIL;
    },
    'open-customize-variable!': (args) => {
      openCustomScope({ variable: String(args[0]) });
      return NIL;
    },

    // Sticky notes — see sticky-notes.js and sticky-notes.lisp.
    'note-create!': (args) =>
      stickyNotes.create(typeof args[0] === 'number' ? args[0] : undefined),
    'note-delete!': (args) => {
      stickyNotes.remove(String(args[0]));
      return NIL;
    },
    'note-edit!': (args) => {
      stickyNotes.edit(String(args[0]));
      return NIL;
    },
    'note-set-source!': (args) => {
      stickyNotes.setSource(String(args[0]), String(args[1]));
      return NIL;
    },
    'note-source': (args) => {
      const source = stickyNotes.getSource(String(args[0]));
      return source === null ? NIL : source;
    },
    'note-move!': (args) => {
      stickyNotes.move(String(args[0]), args[1], args[2]);
      return NIL;
    },
    'note-resize!': (args) => {
      stickyNotes.resize(String(args[0]), args[1], args[2]);
      return NIL;
    },
    'note-ids': () => arrayToList(stickyNotes.ids()),
    'note-count': () => stickyNotes.count(),
    'note-at-point': () => {
      const id = stickyNotes.noteAtPoint();
      return id === null ? NIL : id;
    },
    'note-goto!': (args) => {
      stickyNotes.gotoNote(String(args[0]));
      return NIL;
    },
    'note-next!': () => {
      stickyNotes.gotoNext();
      return NIL;
    },
    'note-prev!': () => {
      stickyNotes.gotoPrevious();
      return NIL;
    },
    'notes-toggle!': () => {
      stickyNotes.toggle();
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

// --- standard library ---------------------------------------------------

/** Fetch the source of a standard-library file over the app:// scheme. */
function fetchStdlibSource(name) {
  return fetch(`app://editor/packages/stdlib/lisp/${name}`).then((response) =>
    response.text()
  );
}

/** List `.lisp` files in the stdlib's `languages/` directory. */
async function listStdlibLanguageFiles() {
  const response = await fetch(
    'app://editor/packages/stdlib/lisp/languages/?list'
  );
  if (!response.ok) return [];
  const names = await response.json();
  return names.filter((name) => name.endsWith('.lisp'));
}

/**
 * Import every JS module in `packages/renderer/src/languages/`. Each
 * module calls `registerLanguage` at top level — loading the module is
 * what registers it. See `packages/renderer/src/languages/README.md`.
 */
async function discoverRendererLanguages() {
  const base = 'app://editor/packages/renderer/src/languages/';
  const response = await fetch(`${base}?list`);
  if (!response.ok) return;
  const names = await response.json();
  for (const name of names) {
    if (!name.endsWith('.js')) continue;
    try {
      await import(/* @vite-ignore */ `${base}${name}`);
    } catch (error) {
      repl.appendError(`language ${name}: ${error.message}`);
    }
  }
}

/**
 * Write the customisation registry's saved settings to custom.lisp.
 * `pairList` is a Lisp list of (name value) pairs; each value is
 * wrapped in `quote` so it round-trips whatever its type.
 */
function writeCustomFile(pairList) {
  const lines = listToArray(pairList).map((pair) => {
    const [name, value] = listToArray(pair);
    return `(custom-set-saved! (quote ${writeString(name)}) (quote ${writeString(value)}))`;
  });
  const text = CUSTOM_FILE_HEADER + lines.join('\n') + '\n';
  window.host
    .writeConfigFile('custom.lisp', text)
    .catch((error) =>
      repl.appendError(`saving customisations failed: ${error.message}`)
    );
}

/**
 * Load the user's saved customisations and their init.lisp — the
 * jmacs equivalent of .emacs. The saved file loads first so a hand
 * edit in init.lisp wins. A broken config file is reported, not fatal.
 * On first run, a commented init.lisp template is written.
 */
async function loadUserConfig() {
  try {
    const customSrc = await window.host.readConfigFile('custom.lisp');
    if (customSrc) interpreter.evaluate(customSrc);
  } catch (error) {
    repl.appendError(`custom.lisp: ${error.lispMessage ?? error.message}`);
  }
  try {
    const initSrc = await window.host.readConfigFile('init.lisp');
    if (initSrc === null) {
      await window.host.writeConfigFile('init.lisp', INIT_TEMPLATE);
    } else {
      interpreter.evaluate(initSrc);
    }
  } catch (error) {
    repl.appendError(`init.lisp: ${error.lispMessage ?? error.message}`);
  }
}

/** The options passed to `loadStdlib` — same shape both at boot and on
 *  hot reload, so language files are picked up by both paths. */
const stdlibOptions = { listLanguageFiles: listStdlibLanguageFiles };

/** Re-evaluate the standard library — hot reload of the editor itself. */
async function reloadStdlib() {
  try {
    await loadStdlib(interpreter, fetchStdlibSource, stdlibOptions);
    await loadUserConfig();
    applyCurrentTheme();
    repl.appendNote('standard library reloaded');
  } catch (error) {
    repl.appendError(`reload failed: ${error.message}`);
  }
}

let keymapReady = false;
try {
  await loadStdlib(interpreter, fetchStdlibSource, stdlibOptions);
  keymapReady = true;
} catch (error) {
  repl.appendError(`standard library failed to load: ${error.message}`);
}

if (keymapReady) await loadUserConfig();
if (keymapReady) applyCurrentTheme();

// Kick off the doc manifest fetch — fire-and-forget. The
// `load-doc-manifest!` primitive returns the cached value once it
// arrives (so the Lisp side can stay synchronous); the very first
// caller before the fetch completes sees `nil` and the Lisp side
// re-queries on next access.
window.host
  .readDocManifest()
  .then((manifest) => {
    if (manifest !== null) docManifestNames = manifest.names;
  })
  .catch(() => {
    /* leave docManifestNames null */
  });

// Tree-sitter languages are drop-ins: discover the JS registration
// modules in `packages/renderer/src/languages/` (each one registers
// its grammar + query + suffixes on import), then instantiate one
// highlighter per registered language. A grammar that fails to load
// disables only its language; the rest still highlight.
await discoverRendererLanguages();
const highlighters = await loadLanguageHighlighters(
  createTreeSitterHighlighter,
  (tag, error) => {
    repl.appendError(`${tag} highlighter unavailable: ${error.message}`);
  }
);
document.body.dataset.treesitter = Object.keys(highlighters).join(',');

/** Dispatch a keystroke through the Lisp keymap. */
function dispatchKey(key) {
  try {
    const handled = interpreter.call('handle-key', key) === true;
    // A key may have switched mode (e.g. toggle-math-mode) — keep the
    // mode menu in step.
    refreshModeMenu();
    return handled;
  } catch (error) {
    repl.appendError(error.lispMessage ?? error.message ?? String(error));
    return true; // consume the key; the error is visible in the REPL
  }
}

// --- mode menu ----------------------------------------------------------
// The native menu shows the current buffer's mode commands. The
// renderer owns the keymaps, so it builds the menu data here and ships
// it to the main process; a click comes back through onMenuCommand.

/** The mode menu for the current buffer, or null when it has none. */
function currentModeMenu() {
  if (!keymapReady) return null;
  let raw;
  try {
    raw = listToArray(interpreter.call('mode-menu-entries'));
  } catch (error) {
    repl.appendError(`mode menu failed: ${error.message}`);
    return null;
  }
  if (raw.length === 0) return null;
  const items = raw.map((entry) => {
    const [keys, command, docText] = listToArray(entry);
    return { label: `${command}    ${keys}`, command, toolTip: docText };
  });
  return { label: interpreter.call('major-mode-name'), items };
}

let lastModeMenuJson = null;

/** Recompute the mode menu and, when it changed, send it to the host. */
function refreshModeMenu() {
  if (!keymapReady) return;
  const menu = currentModeMenu();
  const json = JSON.stringify(menu);
  if (json === lastModeMenuJson) return;
  lastModeMenuJson = json;
  window.host.setModeMenu(menu);
}

// --- editor view --------------------------------------------------------

const editorView = createEditorView(
  session.current,
  document.getElementById('editor-host'),
  {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    highlighters,
  }
);

// --- the customisation view's data bridge ------------------------------
// The view is decoupled from the Lisp; these turn registry data into
// plain objects for it, and route its callbacks back into the registry.

/** Turn a `custom-field` Lisp list into a plain setting object. */
function fieldToSetting(field) {
  const f = listToArray(field);
  return {
    name: f[0],
    type: String(f[1]).replace(/^:/, ''),
    value: f[2] === NIL ? null : f[2],
    default: f[3] === NIL ? null : f[3],
    doc: f[4],
    state: f[5],
    options: f[6] === NIL ? [] : listToArray(f[6]),
  };
}

/** The model the customisation view renders for a buffer's scope. */
function getCustomModel(scope) {
  if (!keymapReady) return null;
  try {
    if (scope.variable) {
      const field = interpreter.evaluate(
        `(custom-field (quote ${scope.variable}))`
      );
      return {
        title: scope.variable,
        doc: '',
        parent: null,
        groups: [],
        settings: [fieldToSetting(field)],
      };
    }
    const model = listToArray(
      interpreter.evaluate(`(custom-group-model (quote ${scope.group}))`)
    );
    return {
      title: model[0],
      doc: model[1],
      parent: model[2] === NIL ? null : model[2],
      groups: listToArray(model[3]).map((pair) => {
        const g = listToArray(pair);
        return { name: g[0], doc: g[1] };
      }),
      settings: listToArray(model[4]).map(fieldToSetting),
    };
  } catch (error) {
    repl.appendError(`customize: ${error.lispMessage ?? error.message}`);
    return null;
  }
}

/** Apply the current theme: read each (--var . value) pair from Lisp
 *  and write it to the document root's inline style. Settings the
 *  theme leaves out (font-size, font-mono, …) keep the :root defaults. */
function applyCurrentTheme() {
  try {
    const pairs = listToArray(interpreter.call('current-theme-css-vars'));
    for (const pair of pairs) {
      const cssVar = String(pair.head);
      const value = String(pair.tail ?? '');
      if (cssVar.startsWith('--') && value !== '') {
        document.documentElement.style.setProperty(cssVar, value);
      }
    }
  } catch (error) {
    repl.appendError(`theme: ${error.lispMessage ?? error.message}`);
  }
}

/** Apply a setting for the session — a value, quote-wrapped to survive
 *  its type. */
function applyCustomSetting(name, value) {
  interpreter.evaluate(
    `(custom-apply! (quote ${name}) (quote ${writeString(value)}))`
  );
  if (name === '*theme*') applyCurrentTheme();
}

/** Apply a setting and persist it. */
function saveCustomSetting(name, value) {
  interpreter.evaluate(
    `(custom-apply-and-save! (quote ${name}) (quote ${writeString(value)}))`
  );
  if (name === '*theme*') applyCurrentTheme();
}

/** Reset a setting to its default value. */
function resetCustomSetting(name) {
  interpreter.evaluate(`(custom-reset! (quote ${name}))`);
  if (name === '*theme*') applyCurrentTheme();
}

/** Open a customisation buffer for a scope — a subgroup or a variable. */
function openCustomScope(scope) {
  if (scope.variable) {
    openCustomize(`*Customize: ${scope.variable}*`, scope);
  } else {
    openCustomize(`*Customize: ${scope.group}*`, scope);
  }
}

// The customisation view — the editor's first non-text buffer view.
// It shares #editor-host with the editor view; switchToBuffer shows
// whichever the current buffer's kind calls for. Keys typed in it
// (outside a form control) go through the same Lisp keymap.
const customizeView = createCustomizeView(
  document.getElementById('editor-host'),
  {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    getModel: getCustomModel,
    applySetting: applyCustomSetting,
    saveSetting: saveCustomSetting,
    resetSetting: resetCustomSetting,
    openScope: openCustomScope,
  }
);
customizeView.element.style.display = 'none';

// The image view — the view an `image`-kind buffer is shown through.
// Like the customisation view it shares #editor-host; switchToBuffer
// shows whichever the current buffer's kind calls for. Keys typed in
// it go through the same Lisp keymap.
const imageView = createImageView(document.getElementById('editor-host'), {
  ...(keymapReady ? { onKey: dispatchKey } : {}),
});
imageView.element.style.display = 'none';

/** Highlight a code block's body with the same pipeline the editor
 *  view uses: tree-sitter where we have a grammar (Track B languages),
 *  the hand-tokenizer fallback for the rest. Returns per-line runs;
 *  the doc-view turns them into `<span class="tok-…">` spans. */
function highlightCodeForDocView(text, language) {
  if (typeof text !== 'string' || text === '') return null;
  const treeSitter = highlighters[language];
  if (treeSitter) {
    try {
      return treeSitter(text);
    } catch {
      /* fall through to the line tokenizer */
    }
  }
  return text.split('\n').map((line) => highlightLine(line, language));
}

// The documentation view — the view a `doc`-kind buffer is shown
// through. Cross-links inside the rendered HTML carry
// `data-jmacs-doc="name"`; clicking one routes through Lisp's
// `open-doc`, which calls `open-doc!` (host primitive) below.
const docView = createDocView(document.getElementById('editor-host'), {
  ...(keymapReady ? { onKey: dispatchKey } : {}),
  openDoc: (name) => {
    if (keymapReady) {
      try {
        interpreter.call('open-doc', name);
      } catch (error) {
        repl.appendError(`open-doc: ${error.lispMessage ?? error.message}`);
      }
    } else {
      openDocBuffer(name);
    }
  },
  highlightCode: highlightCodeForDocView,
});
docView.element.style.display = 'none';

/** The hover-doc tooltip — appears beside the cursor when the mouse
 *  rests on a documented Lisp symbol. The lookup chain mirrors
 *  `open-doc`: pre-built manifest first, then the live docstring. */
const hoverDoc = createHoverDoc(editorView.element, {
  offsetFromPoint: (x, y) => editorView.offsetFromPoint(x, y),
  symbolAtOffset: (offset) => {
    if (!keymapReady) return null;
    try {
      const result = interpreter.evaluate(
        `(symbol-at-offset (buffer-text) ${offset})`
      );
      return typeof result === 'string' ? result : null;
    } catch {
      return null;
    }
  },
  summarise: (symbol) => {
    if (!keymapReady) return null;
    let value;
    try {
      value = interpreter.call('doc-summary-for', symbol);
    } catch {
      return null;
    }
    if (value === NIL || value === null || value === undefined) return null;
    const parts = listToArray(value);
    if (parts.length < 2) return null;
    const [kind, name, source] = parts.map((part) =>
      typeof part === 'string' ? part : String(part)
    );
    if (kind === 'manifest') return { kind: 'manifest', name };
    if (kind === 'live') {
      let preview = '';
      try {
        const trimmed = (source ?? '').slice(0, 320);
        preview = renderMarkdown(trimmed);
      } catch {
        preview = '';
      }
      return { kind: 'live', name, preview };
    }
    return null;
  },
  openDoc: (symbol) => {
    if (!keymapReady) return;
    try {
      interpreter.call('open-doc', symbol);
    } catch (error) {
      repl.appendError(`open-doc: ${error.lispMessage ?? error.message}`);
    }
  },
});

// The Markdown renderer used for sticky notes and the live-docstring
// path in the doc-view. Driven by the `*markdown-interpreter*` Lisp
// variable: the magic value `"marked"` selects the bundled marked.js
// library; any other string is a shell command that reads Markdown
// on stdin and prints HTML on stdout.
const DEFAULT_MARKDOWN_INTERPRETER = 'marked';

/** The current `*markdown-interpreter*` setting, falling back to the
 *  default if the Lisp side isn't ready or the value is empty. */
function currentMarkdownInterpreter() {
  try {
    const value = interpreter.evaluate('*markdown-interpreter*');
    if (typeof value === 'string' && value.trim() !== '') return value;
  } catch {
    // Not yet defined — fall through to the default.
  }
  return DEFAULT_MARKDOWN_INTERPRETER;
}

/**
 * Render a Markdown source string to an HTML fragment.
 *
 * Returns a Promise resolving to the HTML; throws when the chosen
 * interpreter fails. The marked path is synchronous internally but
 * returns a Promise for shape parity with the shell-out path.
 */
async function renderMarkdownHtml(source) {
  const interp = currentMarkdownInterpreter();
  if (interp === 'marked') return renderMarkdown(source);
  const result = await window.host.renderJMarkdown(interp, source);
  if (result && typeof result.html === 'string') return result.html;
  throw new Error(result?.error ?? `${interp} render failed`);
}

// Sticky notes call this; the doc-view's live-docstring path does
// the same. Throwing — the command failed, e.g. it is not installed
// — makes the notes module fall back to showing the raw source.
const renderNoteHtml = renderMarkdownHtml;

// Sticky notes fill the view's overlay layer; they ride the document.
const stickyNotes = createStickyNotes({
  overlayLayer: editorView.overlayLayer,
  getBuffer: () => session.current,
  render: renderNoteHtml,
  onChange: () => scheduleMetadataWrite(session.current),
});
stickyNotes.setBuffer(session.current);

// --- Markdown preview pane ---------------------------------------------
// A toggleable pane (markdown-preview, C-c v) that renders the current
// markdown-mode buffer to HTML through the same JMarkdown pipeline the
// sticky notes use, refreshing — debounced — as the buffer is edited.

/** Typeset mathematics in the rendered preview, once MathJax is ready.
 *  A nice-to-have: MathJax is already loaded for the sticky notes. */
function typesetPreview(element) {
  const mathJax = globalThis.MathJax;
  if (!mathJax) return;
  const run = () => {
    if (typeof mathJax.typesetClear === 'function') {
      mathJax.typesetClear([element]);
    }
    if (typeof mathJax.typesetPromise === 'function') {
      mathJax.typesetPromise([element]).catch(() => {});
    }
  };
  const ready = mathJax.startup && mathJax.startup.promise;
  if (ready) ready.then(run).catch(() => {});
  else run();
}

const markdownPreview = createMarkdownPreview(
  document.getElementById('markdown-preview-host'),
  { render: renderNoteHtml, typeset: typesetPreview }
);
// The pane starts hidden; markdown-preview reveals it.
document.body.classList.add('markdown-preview-hidden');

/** Whether the current buffer is in markdown-mode. */
function currentBufferIsMarkdown() {
  if (!keymapReady) return false;
  try {
    return interpreter.call('major-mode-name') === 'Markdown';
  } catch {
    return false;
  }
}

/** Whether the preview pane is currently visible. */
function markdownPreviewVisible() {
  return !document.body.classList.contains('markdown-preview-hidden');
}

/** Render the current buffer into the preview pane, debounced. Used on
 *  edits; a no-op when the pane is hidden. */
function refreshMarkdownPreview() {
  if (!markdownPreviewVisible()) return;
  markdownPreview.update(session.current.text);
}

/** Re-point the preview pane after a buffer switch: render the new
 *  buffer if the pane is open and the buffer is Markdown; otherwise
 *  hide the pane, since it only makes sense for a markdown-mode
 *  buffer. A no-op when the pane is already hidden. */
function syncMarkdownPreviewToBuffer() {
  if (!markdownPreviewVisible()) return;
  if (currentBufferIsMarkdown()) {
    markdownPreview.refreshNow(session.current.text);
  } else {
    document.body.classList.add('markdown-preview-hidden');
    markdownPreview.clear();
  }
}

/** Toggle the Markdown preview pane. Showing it renders the current
 *  buffer at once; the pane only makes sense for a markdown-mode
 *  buffer, so opening it on any other buffer is reported and skipped. */
function toggleMarkdownPreview() {
  if (markdownPreviewVisible()) {
    document.body.classList.add('markdown-preview-hidden');
    markdownPreview.clear();
    editorView.focus();
    return;
  }
  if (!currentBufferIsMarkdown()) {
    repl.appendNote('markdown-preview: the current buffer is not in Markdown mode');
    return;
  }
  document.body.classList.remove('markdown-preview-hidden');
  markdownPreview.refreshNow(session.current.text);
  editorView.focus();
}

watchCurrentBuffer();
ensureMajorMode();
updateModeline();
editorView.focus();

// Native menus: run a command chosen from a menu, and publish the
// current buffer's mode menu to the host.
window.host.onMenuCommand((command) => {
  editorView.focus();
  try {
    interpreter.evaluate(`(run-command (quote ${command}))`);
  } catch (error) {
    repl.appendError(error.lispMessage ?? error.message ?? String(error));
  }
  refreshModeMenu();
});
refreshModeMenu();

// The startup splash: the editor's own Lisp, behind the welcome text.
// It lives in the view's background layer and is dismissed — faded out
// and removed — the first time a buffer is edited or switched.
const splash = createSplash();
let splashLive = true;
function dismissSplash() {
  if (!splashLive) return;
  splashLive = false;
  splash.classList.remove('is-visible');
  setTimeout(() => splash.remove(), 1100);
}
editorView.backgroundLayer.append(splash);
requestAnimationFrame(() => splash.classList.add('is-visible'));
