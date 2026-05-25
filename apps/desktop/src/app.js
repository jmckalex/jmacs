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
  cons,
  createInterpreter,
  keyword,
  listToArray,
  NIL,
  sym,
  writeString,
} from '@editor/lisp';
import {
  createAudioView,
  createCustomizeView,
  createDocView,
  createEditorView,
  createHoverDoc,
  createInlineEval,
  createImageView,
  createJukeboxView,
  createMarkdownPreview,
  createMinibuffer,
  createReplView,
  createSplitter,
  createTreeSitterHighlighter,
  createVideoView,
  findArt,
  formBoundsAtPoint,
  formBoundsBeforePoint,
  fuzzyFilter,
  highlightLine,
  isAudioFile,
  languageForFilename,
  loadLanguageHighlighters,
  renderMarkdown,
} from '@editor/renderer';
import { createBufferPrimitives, loadStdlib } from '@editor/stdlib';
import { createAudioController } from './audio.js';
import {
  emptyOverrides,
  jsonToLispOverrides,
  lispToJsonOverrides,
} from './face-overrides.js';
import { applyFaceStyles } from './face-styles.js';
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
 *  the image view, the documentation view, the jukebox view, the
 *  audio view or the video view — hiding the others. Pause the
 *  media views when unmounting them so a hidden tab doesn't keep
 *  playing.  */
function mountView(kind) {
  editorView.element.style.display = kind === 'text' ? '' : 'none';
  customizeView.element.style.display = kind === 'customize' ? '' : 'none';
  imageView.element.style.display = kind === 'image' ? '' : 'none';
  docView.element.style.display = kind === 'doc' ? '' : 'none';
  jukeboxView.element.style.display = kind === 'jukebox' ? '' : 'none';
  audioView.element.style.display = kind === 'audio' ? '' : 'none';
  videoView.element.style.display = kind === 'video' ? '' : 'none';
  // Pause the standalone media players on unmount — the jukebox owns
  // the shared audio controller and looks after itself.
  if (kind !== 'audio') audioView.setBuffer(null);
  if (kind !== 'video') videoView.setBuffer(null);
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
  } else if (buffer.kind === 'jukebox') {
    mountView('jukebox');
    jukeboxView.setBuffer(buffer);
    jukeboxView.focus();
  } else if (buffer.kind === 'audio') {
    mountView('audio');
    audioView.setBuffer(buffer);
    audioView.focus();
  } else if (buffer.kind === 'video') {
    mountView('video');
    videoView.setBuffer(buffer);
    videoView.focus();
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

/** Remove the buffer at INDEX from the list, mirroring the semantics
 *  of `kill-buffer!`. Out-of-range indices are a no-op. */
function killBufferAtIndex(target) {
  if (target < 0 || target >= buffers.length) return;
  const wasCurrent = target === currentIndex;
  const victim = buffers[target];
  // Pause and unbind a standalone media element when its buffer is
  // killed while it's still the mounted view — without this the
  // <audio>/<video> would keep streaming the file in the background.
  if ((victim.kind === 'audio' || victim.kind === 'video') && wasCurrent) {
    if (victim.kind === 'audio') audioView.destroy();
    else videoView.destroy();
  }
  buffers.splice(target, 1);
  if (buffers.length === 0) {
    buffers.push(createBuffer('', { name: '*scratch*' }));
    currentIndex = -1;
    switchToBuffer(0);
    return;
  }
  if (wasCurrent) {
    const next = Math.min(target, buffers.length - 1);
    currentIndex = -1; // force switchToBuffer to re-mount.
    switchToBuffer(next);
  } else if (target < currentIndex) {
    currentIndex -= 1;
    updateModeline();
  } else {
    updateModeline();
  }
}

/** Kill the (first) buffer with NAME, if any. */
function killBufferByName(name) {
  killBufferAtIndex(buffers.findIndex((buffer) => buffer.name === name));
}

/** Join DIR and NAME with a single slash. Tiny helper used to build
 *  the absolute path for each jukebox track. */
function joinPath(dir, name) {
  const trimmed = typeof dir === 'string' && dir.endsWith('/')
    ? dir.slice(0, -1)
    : String(dir ?? '');
  return `${trimmed}/${name}`;
}

/** Ask Lisp to format the display label for PATH using the current
 *  `*jukebox-track-format*` template. A failure (interpreter not
 *  ready, format-track not yet defined, anything thrown from the
 *  template) falls back to the bare filename — one bad tag must not
 *  break the whole listing. */
function formatTrackLabel(path) {
  if (!keymapReady) return basenameOf(path);
  try {
    const result = interpreter.call('format-track', path);
    if (typeof result === 'string' && result !== '') return result;
  } catch {
    /* fall through */
  }
  return basenameOf(path);
}

/** The bare filename component of PATH. */
function basenameOf(path) {
  const slash = String(path).lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Refresh the labels of every open jukebox buffer. Called by the
 *  `*jukebox-track-format*` :on-change hook so a user customising the
 *  format string sees the change apply to already-open jukeboxes. */
function refreshAllJukeboxLabels() {
  let touched = false;
  for (const buffer of buffers) {
    if (buffer.kind !== 'jukebox' || !Array.isArray(buffer.tracks)) continue;
    buffer.labels = buffer.tracks.map((track) =>
      formatTrackLabel(joinPath(buffer.dir, track))
    );
    touched = true;
  }
  // Re-mount the current view so the change is visible immediately
  // (a buffer's labels are read in setBuffer). switchToBuffer with
  // currentIndex forces a re-mount; we only do it when the current
  // buffer is a jukebox so other views aren't disturbed.
  if (touched && currentIndex >= 0 &&
      buffers[currentIndex].kind === 'jukebox') {
    const i = currentIndex;
    currentIndex = -1;
    switchToBuffer(i);
  }
}

/** Build a fresh tracks/art listing for DIR and create-or-refresh the
 *  matching jukebox buffer. Reusing an existing buffer by name keeps
 *  the user's switch history sane — `(jukebox "/m")` twice does not
 *  pile up two entries.
 *
 *  The host owns the filesystem; the view never touches it. This
 *  function is the bridge.
 */
function openJukeboxForDirectory(dir) {
  let entries;
  try {
    entries = window.host.listDirectorySync(dir);
  } catch (error) {
    repl.appendError(`jukebox: ${error.message}`);
    return;
  }
  if (entries === null) {
    repl.appendError(`jukebox: cannot read directory ${dir}`);
    return;
  }
  const tracks = entries.filter(isAudioFile);
  const art = findArt(entries);
  // Format the display label for each track via the Lisp helper.
  // Doing this up front (rather than per-row) keeps the renderer free
  // of IPC chatter when the buffer mounts. A formatting error per
  // file degrades to the bare filename — one malformed tag must not
  // break the whole listing.
  const labels = tracks.map((track) =>
    formatTrackLabel(joinPath(dir, track))
  );
  const name = `*Jukebox: ${dir}*`;
  let index = buffers.findIndex(
    (buffer) => buffer.kind === 'jukebox' && buffer.name === name
  );
  // The jukebox buffer carries two callbacks the view invokes: a
  // refresh (re-read the dir and rebuild) and a quit (stop, remove
  // the buffer, restore the previous one).
  const record = {
    kind: 'jukebox',
    name,
    dir,
    tracks,
    labels,
    art,
  };
  record.refresh = () => openJukeboxForDirectory(dir);
  record.quit = () => {
    audio.stop();
    killBufferByName(name);
  };
  if (index >= 0) {
    // Reuse the slot — keep `kind` and `name` stable but refresh
    // payload. The view's setBuffer rebuilds from the new fields.
    Object.assign(buffers[index], record);
  } else {
    buffers.push(record);
    index = buffers.length - 1;
  }
  switchToBuffer(index);
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

// --- audio playback (jukebox mode) --------------------------------------
// A single shared HTMLAudioElement, driven by the Lisp jukebox. The
// ended event is wired further down, once the interpreter exists.
const audio = createAudioController();

/** Expand `~/foo` paths a user types from the REPL — the filesystem
 *  layer (Node's fs in the main process) does it via the IPC helper
 *  in `files.js`, but `play-audio!` and `open-image-file!` build URLs
 *  and dispatch directly from the renderer, so they need the same
 *  expansion at their own entry. */
const HOME = window.host?.homeDirectory ?? '';
function expandTilde(path) {
  if (typeof path !== 'string' || HOME === '') return path;
  if (path === '~') return HOME;
  if (path.startsWith('~/')) return HOME + '/' + path.slice(2);
  return path;
}

// --- file open / save ---------------------------------------------------

async function openFileInteractive() {
  try {
    const result = await window.host.openFile();
    if (result === null) return;
    if (openAsMediaBufferIfRecognised(result)) return;
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

/** Route an open-file IPC result to its matching non-text view, when
 *  the shape calls for one. Returns whether a view was mounted — the
 *  caller falls through to the text path on `false`. */
function openAsMediaBufferIfRecognised(result) {
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
    return true;
  }
  // An audio or video file comes back with a `media://` URL the
  // matching player streams. For audio the host has already extracted
  // the embedded tag metadata and album art (best-effort) so the view
  // can render them without another IPC round-trip.
  if (result.mediaKind === 'audio') {
    buffers.push({
      kind: 'audio',
      name: result.name,
      filePath: result.path,
      src: result.src,
      ...(result.metadata ? { metadata: result.metadata } : {}),
      ...(result.albumArtSrc ? { albumArtSrc: result.albumArtSrc } : {}),
    });
    switchToBuffer(buffers.length - 1);
    return true;
  }
  if (result.mediaKind === 'video') {
    buffers.push({
      kind: 'video',
      name: result.name,
      filePath: result.path,
      src: result.src,
    });
    switchToBuffer(buffers.length - 1);
    return true;
  }
  return false;
}

/**
 * Open an image file by an explicit path, dialog-free. Mounts an
 * `image`-kind buffer for it and switches to it — the same view the
 * dialog path produces. Used by jukebox-mode's M-RET on album art.
 */
async function openImageByPath(filePath) {
  try {
    const result = await window.host.openFilePath(filePath);
    if (result === null || typeof result.imageSrc !== 'string') {
      repl.appendError(`open-image: not an image or unreadable (${filePath})`);
      return;
    }
    buffers.push({
      kind: 'image',
      name: result.name,
      filePath: result.path,
      src: result.imageSrc,
    });
    switchToBuffer(buffers.length - 1);
  } catch (error) {
    repl.appendError(`open-image failed: ${error.message}`);
  }
}

/**
 * Open a file by an explicit path, dialog-free, routing it through
 * the same logic the dialog path uses (image / audio / video / text).
 * Used by the desktop smoke arm and available to Lisp as
 * `open-file-path!`.
 */
async function openFileByPath(filePath) {
  try {
    const result = await window.host.openFilePath(filePath);
    if (result === null) {
      repl.appendError(`open-file-path: unreadable (${filePath})`);
      return;
    }
    if (openAsMediaBufferIfRecognised(result)) return;
    const buffer = createBuffer(result.content ?? '', { name: result.name });
    buffer.filePath = result.path;
    const metadata = await window.host.readMetadata(result.path);
    if (metadata) buffer.metadata = metadata;
    buffers.push(buffer);
    switchToBuffer(buffers.length - 1);
  } catch (error) {
    repl.appendError(`open-file-path failed: ${error.message}`);
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
  // The current buffer is excluded from the candidates so the
  // suggestion the minibuffer shows in brackets is always a
  // different buffer — pressing Enter is then a useful switch.
  const names = buffers
    .filter((_, index) => index !== currentIndex)
    .map((buffer) => buffer.name);

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
      // An exact name switches; otherwise the best fuzzy match does.
      // A blank Enter accepts whatever the bracketed suggestion is —
      // the first fuzzy match against the empty query, i.e. the first
      // candidate alphabetically.
      const exact =
        trimmed === ''
          ? -1
          : buffers.findIndex((buffer) => buffer.name === trimmed);
      if (exact >= 0) {
        switchToBuffer(exact);
        return;
      }
      const chosen = fuzzyFilter(query, names)[0];
      if (chosen !== undefined) {
        switchToBuffer(buffers.findIndex((buffer) => buffer.name === chosen));
        return;
      }
      if (trimmed === '') return; // nothing to switch to, nothing to create.
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

/** Cached face-overrides loaded from `faces.json` at startup. Lisp
 *  reads this via `load-face-overrides!` and installs it before the
 *  first paint, so any user overrides are present from the start.
 *  `null` until the file has been read (it may be missing entirely
 *  on first launch — that case fills it with `emptyOverrides()`). */
let faceOverridesCache = null;

/** The Sym / Keyword constructors face-overrides.js needs to build
 *  Lisp-shaped maps. Passed in so that module stays free of a hard
 *  dependency on `@editor/lisp` (the unit tests use stand-ins). */
const lispFactories = { keyword, sym };

const interpreter = createInterpreter({
  write: (text) => repl.appendOutput(text),
  primitives: {
    ...createBufferPrimitives(session),

    // File commands run async work and return at once.
    'open-file!': () => {
      openFileInteractive();
      return NIL;
    },
    // Open an image file at PATH (a string) as an image-kind buffer.
    // Mirrors `open-file!` for an explicit path; jukebox-mode uses this
    // for M-RET on the album-art file.
    'open-image-file!': (args) => {
      const filePath = expandTilde(String(args[0] ?? ''));
      if (filePath === '') return NIL;
      openImageByPath(filePath);
      return NIL;
    },
    // Open any file at PATH through the dialog-free path, routing it
    // through the same image / audio / video / text logic the dialog
    // uses. The smoke arm calls this to mount audio/video buffers
    // without a dialog stub; users can call it from the REPL too.
    'open-file-path!': (args) => {
      const filePath = expandTilde(String(args[0] ?? ''));
      if (filePath === '') return NIL;
      openFileByPath(filePath);
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
      applyCurrentFaceStyles();
      return NIL;
    },
    // Face customisation: regenerate `<style id="face-overrides">`
    // from the Lisp-side resolved face map. Called whenever any
    // override changes, plus on startup and theme switch.
    'apply-face-styles!': () => {
      applyCurrentFaceStyles();
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
    // Inline eval: the bounds of the form enclosing point in the
    // current buffer, as a `(start . end)` pair, or nil.
    'form-bounds-at-point!': () => {
      if (!currentTextBuffer || typeof currentTextBuffer.text !== 'string') {
        return NIL;
      }
      const bounds = formBoundsAtPoint(
        currentTextBuffer.text,
        currentTextBuffer.point,
        'lisp'
      );
      return bounds === null ? NIL : cons(bounds.start, bounds.end);
    },
    // Inline eval: the bounds of the form immediately before point.
    'form-bounds-before-point!': () => {
      if (!currentTextBuffer || typeof currentTextBuffer.text !== 'string') {
        return NIL;
      }
      const bounds = formBoundsBeforePoint(
        currentTextBuffer.text,
        currentTextBuffer.point,
        'lisp'
      );
      return bounds === null ? NIL : cons(bounds.start, bounds.end);
    },
    // Inline eval: evaluate the current buffer's source in
    // [start, end) and show the result as a pill overlay.
    'eval-region!': (args) => {
      const start = Number(args[0]);
      const end = Number(args[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return NIL;
      evalRegionWithOverlay(start, end);
      return NIL;
    },
    // Inline eval: open (or reuse) the *Eval log* buffer.
    'show-eval-log!': () => {
      openEvalLogBuffer();
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
    // `describe-face-at-point` (C-h F) — surface the tree-sitter
    // capture under the cursor. Returns (LANGUAGE . CAPTURES), or
    // `nil` when the current buffer has no tree-sitter language.
    // CAPTURES is a list of `(start end face)` lists in document order.
    'tree-sitter-captures-for-buffer!': () => {
      if (!currentTextBuffer || typeof currentTextBuffer.text !== 'string') {
        return NIL;
      }
      const name = currentTextBuffer.name;
      const language = languageForFilename(name);
      if (language === null) return NIL;
      const highlighter = highlighters[language];
      if (!highlighter || typeof highlighter.captures !== 'function') {
        return NIL;
      }
      let captureRanges;
      try {
        captureRanges = highlighter.captures(currentTextBuffer.text);
      } catch (error) {
        repl.appendError(`tree-sitter captures: ${error.message}`);
        return NIL;
      }
      const captures = arrayToList(
        captureRanges.map((r) => arrayToList([r.start, r.end, r.face]))
      );
      return cons(language, captures);
    },
    // `describe-face-at-point` fallback — when no capture covers point,
    // surface the tree-sitter node info so the user knows what query
    // rule they'd write to face it. Returns a hash-map with `:language`,
    // `:type` (the node's tree-sitter type), `:start`, `:end`, and
    // `:ancestors` (a list of parent-type strings, immediate-parent
    // first), or `nil` when the buffer has no tree-sitter language or
    // no node covers point.
    'tree-sitter-node-at-point!': (args) => {
      if (!currentTextBuffer || typeof currentTextBuffer.text !== 'string') {
        return NIL;
      }
      const name = currentTextBuffer.name;
      const language = languageForFilename(name);
      if (language === null) return NIL;
      const highlighter = highlighters[language];
      if (!highlighter || typeof highlighter.nodeAtPoint !== 'function') {
        return NIL;
      }
      const pos = Number.isInteger(args[0]) ? args[0] : 0;
      let info;
      try {
        info = highlighter.nodeAtPoint(currentTextBuffer.text, pos);
      } catch (error) {
        repl.appendError(`tree-sitter nodeAtPoint: ${error.message}`);
        return NIL;
      }
      if (info === null) return NIL;
      const record = new Map();
      record.set(keyword('language'), language);
      record.set(keyword('type'), info.type);
      record.set(keyword('start'), info.start);
      record.set(keyword('end'), info.end);
      record.set(keyword('ancestors'), arrayToList(info.ancestors));
      return record;
    },
    // `describe-face-at-point` (C-h F) — resolve a face name to the
    // CSS colour the active theme renders it with. Reads the runtime
    // value of `--tok-<face>` from `document.documentElement`. Falls
    // back to an empty string when nothing is bound.
    'face-color-for': (args) => {
      const face = String(args[0] ?? '');
      if (face === '') return '';
      try {
        const value = getComputedStyle(document.documentElement)
          .getPropertyValue(`--tok-${face}`)
          .trim();
        return value;
      } catch {
        return '';
      }
    },
    // Documentation: return the (cached) list of doc-page names, or
    // `()` when the docs haven't been built. The Lisp side caches
    // this in *doc-manifest*. The manifest itself is fetched once
    // at startup (see `loadDocManifest` below) so this primitive
    // can be synchronous.
    'load-doc-manifest!': () =>
      docManifestNames === null ? NIL : arrayToList(docManifestNames),

    // Face customisation: return the face-overrides hash-map loaded
    // from faces.json at startup, or an empty-overrides map when no
    // file existed. Called once from Lisp right after stdlib load.
    'load-face-overrides!': () =>
      faceOverridesCache ?? emptyOverrides(lispFactories),

    // Face customisation: write the live overrides to faces.json.
    // The Lisp side passes its current `*face-overrides*` map; we
    // convert it back to the JSON shape and hand it to the host.
    'write-face-overrides!': (args) => {
      const overrides = args[0];
      try {
        const json = lispToJsonOverrides(overrides, lispFactories);
        // Fire-and-forget; the write is small and the next read
        // will pick up whatever was last written.
        window.host.writeFaces(json);
      } catch (error) {
        repl.appendError(
          `faces:write: ${error.lispMessage ?? error.message}`
        );
      }
      return NIL;
    },
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
    'toggle-fold-at-point!': () => {
      editorView.toggleFoldAtPoint();
      return NIL;
    },
    'fold-all!': () => {
      editorView.foldAll();
      return NIL;
    },
    'unfold-all!': () => {
      editorView.unfoldAll();
      return NIL;
    },
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
    // Remove a buffer from the list. With no argument, kills the
    // current buffer; with a name, kills the matching one. Killing
    // the last buffer is fine — a fresh empty `*scratch*` is created
    // to keep the list non-empty.
    'kill-buffer!': (args) => {
      const target =
        args.length > 0
          ? buffers.findIndex((buffer) => buffer.name === String(args[0]))
          : currentIndex;
      killBufferAtIndex(target);
      return NIL;
    },
    'buffer-count': () => buffers.length,
    // Switch to the buffer named NAME, if there is one. No-op (returns
    // nil) if no buffer carries that name; otherwise switches and
    // returns #t. The Lisp-side `buffer-menu` uses this to jump to a
    // buffer by name from the *Buffer List* selection.
    'switch-to-buffer!': (args) => {
      const name = String(args[0] ?? '');
      if (name === '') return NIL;
      const index = buffers.findIndex((buffer) => buffer.name === name);
      if (index < 0) return NIL;
      switchToBuffer(index);
      return true;
    },
    // A snapshot of every open buffer as a list of hash-maps with keys
    // :name, :kind (a string — "text", "doc", "image", "customize"),
    // :mode (the major-mode display name, or nil for non-text buffers),
    // :line-count (an integer, 0 for non-text), :file (the absolute
    // path, or nil), :modified (#t for buffers with unsaved changes).
    // The Lisp `buffer-menu` reads this to render *Buffer List*.
    'list-buffers': () => {
      const records = buffers.map((buffer) => {
        const record = new Map();
        record.set(keyword('name'), buffer.name ?? '');
        // Text buffers have no `kind` property; everything else does.
        record.set(keyword('kind'), buffer.kind ?? 'text');
        // The major mode's display name lives on the L2 buffer for text
        // buffers; non-text buffers don't carry a mode.
        const major = buffer.majorMode;
        const modeName =
          major && typeof major.get === 'function'
            ? major.get(keyword('name')) ?? NIL
            : NIL;
        record.set(keyword('mode'), modeName);
        record.set(
          keyword('line-count'),
          typeof buffer.lineCount === 'number' ? buffer.lineCount : 0
        );
        record.set(keyword('file'), buffer.filePath ?? NIL);
        record.set(keyword('modified'), dirtyBuffers.has(buffer));
        return record;
      });
      return arrayToList(records);
    },

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
    // Customize one specific face — opens the customize buffer scoped
    // to a single face row (and scrolled to it).
    'open-customize-face!': (args) => {
      openCustomScope({ face: String(args[0]) });
      return NIL;
    },
    // Customize all faces — opens the customize buffer with the
    // 'Faces' group as its scope.
    'open-customize-faces!': () => {
      openCustomScope({ group: 'faces' });
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

    // Jukebox audio — see audio.js and jukebox-view.js. Each primitive
    // is a thin wrapper over the shared HTMLAudioElement; the panel
    // layout and playlist logic live in the jukebox view (Layer 4).
    'list-directory': (args) => {
      const entries = window.host.listDirectorySync(String(args[0]));
      return entries === null ? NIL : arrayToList(entries);
    },
    // Open (or refresh) the jukebox buffer for DIR. The host reads
    // the directory, filters to audio files, finds an art file, then
    // creates a `jukebox`-kind buffer carrying the state the view
    // needs — no Lisp panel rendering, no buffer text to maintain.
    'open-jukebox-buffer!': (args) => {
      const dir = expandTilde(String(args[0] ?? ''));
      if (dir === '') return NIL;
      openJukeboxForDirectory(dir);
      return NIL;
    },
    // Refresh the `labels` array on every open jukebox buffer. Called
    // by the `*jukebox-track-format*` :on-change hook so a user
    // customising the format string sees it take effect immediately.
    'refresh-jukebox-labels!': () => {
      refreshAllJukeboxLabels();
      return NIL;
    },
    // Read an audio file's embedded tag metadata as a Lisp hash-map
    // keyed by :title :artist :album :track :year :genre :duration.
    // Missing fields are nil; an unsupported / unreadable file is nil
    // overall. The IPC round-trip is synchronous (Lisp interpreter is
    // synchronous), mirroring `list-directory` above.
    'audio-metadata': (args) => {
      const path = expandTilde(String(args[0] ?? ''));
      if (path === '') return NIL;
      const meta = window.host.audioMetadataSync(path);
      if (meta === null || meta === undefined) return NIL;
      const map = new Map();
      const set = (key, value) =>
        map.set(keyword(key), value === null || value === undefined ? NIL : value);
      set('title', meta.title);
      set('artist', meta.artist);
      set('album', meta.album);
      set('track', meta.track);
      set('year', meta.year);
      set('genre', meta.genre);
      set('duration', meta.duration);
      return map;
    },
    // Replace one tag on the audio file at `path` with `value` (or
    // add it if it wasn't present). The host re-serialises the whole
    // file via writeMetadataSync, dropping unrecognised frames per
    // the always-rewrite design in plans/AUDIO-METADATA-EDIT.md.
    // Cover art is preserved by the writer (reads existing APIC).
    // The renderer's cached metadata on any open buffer is the
    // source of truth — it carries user-added custom keys that
    // extractMetadataSync wouldn't surface.
    'set-audio-metadata!': (args) => {
      const path = expandTilde(String(args[0] ?? ''));
      const key = String(args[1] ?? '');
      if (path === '' || key === '') {
        throw new Error('set-audio-metadata!: missing arg');
      }
      const value = args[2] === undefined ? '' : String(args[2]);
      applyAudioMetadataEdit(path, (fields) => {
        fields[key] = value;
      });
      return NIL;
    },
    'remove-audio-metadata!': (args) => {
      const path = expandTilde(String(args[0] ?? ''));
      const key = String(args[1] ?? '');
      if (path === '' || key === '') {
        throw new Error('remove-audio-metadata!: missing arg');
      }
      applyAudioMetadataEdit(path, (fields) => {
        delete fields[key];
      });
      return NIL;
    },
    'play-audio!': (args) => {
      audio.play(expandTilde(String(args[0])));
      return NIL;
    },
    'pause-audio!': () => {
      audio.pause();
      return NIL;
    },
    'stop-audio!': () => {
      audio.stop();
      return NIL;
    },
    'audio-current-time': () => audio.currentTime(),
    'audio-duration': () => audio.duration(),
    'audio-playing?': () => audio.isPlaying(),
    'audio-current-path': () => {
      const p = audio.currentPath();
      return p === null ? NIL : p;
    },
    // Show the directory picker; on confirm, dispatch the chosen path
    // back into Lisp via the jukebox callback. Mirrors how `open-file!`
    // returns immediately and the file is shown when the dialog resolves.
    'prompt-directory!': () => {
      window.host
        .openDirectory()
        .then((path) => {
          if (path === null) return;
          try {
            interpreter.call('jukebox-on-directory-chosen', path);
          } catch (error) {
            repl.appendError(
              error.lispMessage ?? error.message ?? String(error)
            );
          }
        })
        .catch((error) => {
          repl.appendError(`directory open failed: ${error.message}`);
        });
      return NIL;
    },
  },
});

// Auto-advance: the audio element fires `ended`, which the jukebox
// translates into a "next track" command. Other contexts have no such
// command, so the call silently no-ops.
audio.onEnded(() => {
  try {
    interpreter.call('jukebox-track-ended');
  } catch {
    // No jukebox loaded — that is fine; the track has simply finished.
  }
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
    // Reapply face hooks + overrides: a fresh stdlib reset both.
    installFacePersistence();
    if (faceOverridesCache !== null) {
      interpreter.evaluate('(set-face-overrides! (load-face-overrides!))');
    }
    await loadUserConfig();
    applyCurrentTheme();
    applyCurrentFaceStyles();
    repl.appendNote('standard library reloaded');
  } catch (error) {
    repl.appendError(`reload failed: ${error.message}`);
  }
}

/** Wire the renderer-side face persistence into the Lisp face system.
 *  After this runs, every `set-face-attribute` persists to faces.json.
 *  CSS regeneration is already handled by the `apply-face-styles!`
 *  primitive that Lisp calls directly on every change. */
function installFacePersistence() {
  interpreter.evaluate(
    '(set-face-overrides-saver! (lambda () (write-face-overrides! (current-face-overrides))))'
  );
}

let keymapReady = false;
try {
  await loadStdlib(interpreter, fetchStdlibSource, stdlibOptions);
  keymapReady = true;
} catch (error) {
  repl.appendError(`standard library failed to load: ${error.message}`);
}

// Face overrides: read faces.json (or get null if it's missing) and
// install into the Lisp face system before the first paint. The
// stdlib has already loaded `faces.lisp`, so the mutators exist.
if (keymapReady) {
  installFacePersistence();
  try {
    const json = await window.host.readFaces();
    faceOverridesCache = jsonToLispOverrides(json, lispFactories);
    interpreter.evaluate('(set-face-overrides! (load-face-overrides!))');
  } catch (error) {
    repl.appendError(
      `faces: failed to load overrides — ${error.lispMessage ?? error.message}`
    );
  }
}

if (keymapReady) await loadUserConfig();
if (keymapReady) applyCurrentTheme();
if (keymapReady) applyCurrentFaceStyles();

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
const { highlighters, foldCaptures } = await loadLanguageHighlighters(
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
    foldCaptures,
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

/** Turn a `face-row` Lisp list into a plain face object. */
function rowToFace(row) {
  const r = listToArray(row);
  return {
    name: String(r[0]),
    doc: String(r[1] ?? ''),
    foreground: typeof r[2] === 'string' ? r[2] : '',
    background: typeof r[3] === 'string' ? r[3] : '',
    weight: String(r[4] ?? 'normal'),
    slant: String(r[5] ?? 'normal'),
    underline: r[6] === true,
    strikeThrough: r[7] === true,
    state: String(r[8] ?? 'standard'),
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
        faces: [],
      };
    }
    if (scope.face) {
      const model = listToArray(
        interpreter.evaluate(
          `(face-single-model ${writeString(scope.face)})`
        )
      );
      return {
        title: scope.face,
        doc: model[1],
        parent: model[2] === NIL ? null : String(model[2]),
        groups: [],
        settings: [],
        faces: listToArray(model[4]).map(rowToFace),
        scrollToFace: scope.face,
      };
    }
    if (scope.group === 'faces') {
      const model = listToArray(interpreter.call('faces-group-model'));
      return {
        title: model[0],
        doc: model[1],
        parent: model[2] === NIL ? null : String(model[2]),
        groups: [],
        settings: [],
        faces: listToArray(model[4]).map(rowToFace),
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
      faces: [],
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

/** Apply the resolved face map to the document: regenerate
 *  `<style id="face-overrides">` with one rule per face. */
function applyCurrentFaceStyles() {
  try {
    const alist = listToArray(interpreter.call('current-face-styles'));
    applyFaceStyles(document, alist, listToArray);
  } catch (error) {
    repl.appendError(`face-styles: ${error.lispMessage ?? error.message}`);
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

/** Apply a face-attribute change from the customize view. The widget
 *  passes everything as strings/booleans; the wrapper coerces. */
function setFaceFromView(faceName, attr, value) {
  const valueSrc =
    typeof value === 'boolean'
      ? (value ? 'true' : 'false')
      : writeString(String(value));
  interpreter.evaluate(
    `(set-face-attribute-by-strings ${writeString(faceName)} ${writeString(attr)} ${valueSrc})`
  );
}

/** Reset a face — drop the global override and rerender. */
function resetFaceFromView(faceName) {
  interpreter.evaluate(
    `(reset-face-by-string ${writeString(faceName)})`
  );
}

/** Open a customisation buffer for a scope — a subgroup, a variable,
 *  or a single face. */
function openCustomScope(scope) {
  if (scope.variable) {
    openCustomize(`*Customize: ${scope.variable}*`, scope);
  } else if (scope.face) {
    openCustomize(`*Customize Face: ${scope.face}*`, scope);
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
    setFaceAttribute: setFaceFromView,
    resetFace: resetFaceFromView,
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
  closeBuffer: () => {
    if (!keymapReady) return;
    try {
      interpreter.call('kill-buffer');
    } catch (error) {
      repl.appendError(`kill-buffer: ${error.lispMessage ?? error.message}`);
    }
  },
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

// The jukebox view — the view a `jukebox`-kind buffer is shown
// through. Replaces the old text-buffer jukebox mode. The shared
// audio controller is passed in so `audio-playing?` and friends
// stay truthful; `openImage` routes M-RET on the album art through
// the same image-buffer path the dialog uses.
const jukeboxView = createJukeboxView(
  document.getElementById('editor-host'),
  {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    audio,
    openImage: (path) => openImageByPath(expandTilde(path)),
    report: (message) => repl.appendNote(message),
    // Embedded album-art lookup: the host IPC reads the file's tag
    // and returns `{ mime, dataUrl }` or null. The view shows the
    // dataUrl when present, falls back to the directory's sidecar
    // cover otherwise.
    getEmbeddedArt: (path) =>
      window.host.audioAlbumArt(expandTilde(path)),
  }
);
jukeboxView.element.style.display = 'none';

/** Dispatch a metadata-edit Lisp primitive (`set-audio-metadata!` /
 *  `remove-audio-metadata!`) on behalf of the audio view's inline-edit
 *  UI. Returns the shape the view consumes: `{ ok: true }` on success,
 *  `{ ok: false, error }` on failure. The view applies the resulting
 *  change to `buffer.metadata` itself, so the primitive doesn't need
 *  to round-trip the whole metadata object back.
 *
 *  Wraps the call in pause-release / resume-from so the atomic
 *  temp-file + rename inside the host writer doesn't fight an open
 *  `<audio>` file handle (a real failure mode on Windows; harmless
 *  on macOS/Linux but the brief glitch keeps the behaviour
 *  predictable across platforms). */
function runMetadataEdit(primitiveName, buffer, key, value) {
  if (!keymapReady) return { ok: false, error: 'interpreter not ready' };
  if (!buffer || typeof buffer.filePath !== 'string') {
    return { ok: false, error: 'no audio buffer' };
  }
  const snapshot = audioView.pauseAndRelease();
  try {
    if (value === undefined) {
      interpreter.call(primitiveName, buffer.filePath, key);
    } else {
      interpreter.call(primitiveName, buffer.filePath, key, value);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error.lispMessage ?? error.message ?? String(error),
    };
  } finally {
    audioView.resumeFrom(snapshot);
  }
}

/** Read-modify-write for one audio file's tag metadata. The renderer-
 *  cached metadata on any open `audio`-kind buffer for `path` is the
 *  source of truth — it carries user-added custom keys (the plus pill
 *  writes them) that `extractMetadataSync` doesn't surface. Falls back
 *  to a fresh extract when no buffer is open for the file.
 *
 *  Strips derived fields (`duration`, `file`, `format`, `path`) before
 *  the write — the writer ignores them, but cleaner not to send them
 *  over IPC. After a successful write the renderer's cached metadata
 *  is updated in place so future edits build on the new state.
 *
 *  Throws on any write failure so the Lisp primitive surface mirrors
 *  the established `(file-save) → signal` convention. */
function applyAudioMetadataEdit(path, mutator) {
  const buffer = buffers.find(
    (b) => b.kind === 'audio' && b.filePath === path
  );
  const source = buffer
    ? buffer.metadata
    : window.host.audioMetadataSync(path);
  const fields = stripDerivedFields(source ?? {});
  mutator(fields);
  const result = window.host.audioMetadataWriteSync(path, fields);
  if (!result || !result.ok) {
    throw new Error(result?.error ?? 'metadata write failed');
  }
  if (buffer) buffer.metadata = fields;
}

/** Drop the four read-only rows the audio view renders below the tag
 *  fields. They're never written to disk. */
function stripDerivedFields(meta) {
  const out = { ...(meta ?? {}) };
  delete out.duration;
  delete out.file;
  delete out.format;
  delete out.path;
  return out;
}

// The audio view — the view a single `audio`-kind buffer is shown
// through (opening one audio file from the dialog, not a directory).
// Unlike the jukebox, this view owns its own <audio> element so a
// file open here doesn't fight the jukebox's playback head.
const audioView = createAudioView(
  document.getElementById('editor-host'),
  {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    closeBuffer: () => {
      if (!keymapReady) return;
      try {
        interpreter.call('kill-buffer');
      } catch (error) {
        repl.appendError(`kill-buffer: ${error.lispMessage ?? error.message}`);
      }
    },
    // Inline-edit lifecycle. Wired to the stubbed metadata-write
    // primitives — see `set-audio-metadata!` / `remove-audio-metadata!`
    // below. The real writers (agent-audio-edit-id3v2 onwards) replace
    // the stubs without touching the view.
    onSetMetadata: ({ key, value, buffer }) =>
      runMetadataEdit('set-audio-metadata!', buffer, key, value),
    onRemoveMetadata: ({ key, buffer }) =>
      runMetadataEdit('remove-audio-metadata!', buffer, key, undefined),
    showError: (message) => repl.appendError(message),
  }
);
audioView.element.style.display = 'none';

// The video view — the view a `video`-kind buffer is shown through.
const videoView = createVideoView(
  document.getElementById('editor-host'),
  {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    closeBuffer: () => {
      if (!keymapReady) return;
      try {
        interpreter.call('kill-buffer');
      } catch (error) {
        repl.appendError(`kill-buffer: ${error.lispMessage ?? error.message}`);
      }
    },
  }
);
videoView.element.style.display = 'none';

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

/** Inline-evaluation overlay — the pill that pops next to a Lisp
 *  form when the user evaluates it (`C-x C-e`, `C-RET`). */
const inlineEval = createInlineEval({
  overlayLayer: editorView.overlayLayer,
  getBuffer: () => currentTextBuffer,
});

/** Most-recent-first log of evaluations, capped at `EVAL_LOG_MAX`. */
const EVAL_LOG_MAX = 50;
const evalLog = [];

/** Take a substring out of the current buffer with the same bounds
 *  the Lisp side computed. */
function bufferSlice(start, end) {
  if (!currentTextBuffer || typeof currentTextBuffer.text !== 'string') {
    return '';
  }
  const text = currentTextBuffer.text;
  if (start < 0 || end > text.length || start >= end) return '';
  return text.slice(start, end);
}

/** Format a short result label for the pill: writeString-quoted,
 *  collapsed to a single line, truncated to keep the pill compact. */
function formatResultLabel(value) {
  let raw;
  try {
    raw = writeString(value);
  } catch (error) {
    raw = String(value);
  }
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;
}

function formatErrorLabel(error) {
  const message = error?.lispMessage ?? error?.message ?? String(error);
  const oneLine = String(message).replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;
}

/** Record an eval in the log. */
function pushEvalLog(entry) {
  evalLog.unshift({ ...entry, at: new Date().toISOString() });
  if (evalLog.length > EVAL_LOG_MAX) evalLog.length = EVAL_LOG_MAX;
}

/** Evaluate the source in [start, end), show a pill at `end`, and
 *  log the eval. Errors surface on the pill AND in the REPL with
 *  the full stack trace. */
function evalRegionWithOverlay(start, end) {
  const source = bufferSlice(start, end);
  if (source === '') {
    repl.appendError('eval: nothing to evaluate');
    return;
  }
  try {
    const result = interpreter.evaluate(source);
    const label = formatResultLabel(result);
    inlineEval.showResult(end, label);
    pushEvalLog({ source, ok: true, label });
  } catch (error) {
    const label = formatErrorLabel(error);
    inlineEval.showError(end, `! ${label}`);
    pushEvalLog({ source, ok: false, label });
    repl.appendError(
      `eval ${source}\n  ${error.lispMessage ?? error.message ?? String(error)}`
    );
  }
}

/** Open (or reuse) a buffer showing the eval log. */
function openEvalLogBuffer() {
  const name = '*Eval log*';
  const text = evalLog.length === 0
    ? '(no evaluations yet)'
    : evalLog.map((entry) => {
        const marker = entry.ok ? '⇒' : '!';
        return `${entry.at}\n  ${entry.source}\n  ${marker} ${entry.label}`;
      }).join('\n\n');
  let index = buffers.findIndex(
    (buffer) => buffer.kind !== 'doc' && buffer.kind !== 'image' &&
      buffer.kind !== 'customize' && buffer.name === name
  );
  if (index < 0) {
    buffers.push(createBuffer(text, { name }));
    index = buffers.length - 1;
  } else {
    buffers[index].setText(text);
  }
  switchToBuffer(index);
}

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

// --- splitters ---------------------------------------------------------
// Drag-resizable boundaries between the editor and the Markdown
// preview pane, and between the workspace and the REPL. Each
// splitter writes a CSS custom property the layout reads from
// (--preview-width / --repl-height); the host persists the final
// value through panes.json after each drag.

const workspaceEl = document.getElementById('workspace');
const previewSplitterEl = document.getElementById('preview-splitter');
const replSplitterEl = document.getElementById('repl-splitter');

/** The persisted pane sizes — read once at startup and re-saved after
 *  each drag, so the layout survives quits. */
let persistedPanes = {};

/** Persist the current sizes, swallowing IPC failures (the next save
 *  will catch any one-off hiccup; we never block on disk). */
function savePanes() {
  if (typeof window.host?.writePanes !== 'function') return;
  window.host.writePanes(persistedPanes).catch(() => {
    /* a transient write failure should not interrupt the user */
  });
}

const previewSplitter = createSplitter({
  orientation: 'horizontal',
  element: previewSplitterEl,
  target: workspaceEl,
  cssVar: '--preview-width',
  min: 200,
  // The editor needs at least 300px to remain usable.
  max: () => Math.max(200, workspaceEl.getBoundingClientRect().width - 300),
  onResize: (value) => {
    persistedPanes.previewWidth = value;
    savePanes();
  },
});

const replSplitter = createSplitter({
  orientation: 'vertical',
  element: replSplitterEl,
  target: document.body,
  cssVar: '--repl-height',
  min: 80,
  // The workspace + chrome above the REPL needs at least 300px.
  max: () => Math.max(80, window.innerHeight - 300),
  onResize: (value) => {
    persistedPanes.replHeight = value;
    savePanes();
  },
});

// Read any persisted sizes and apply them. The read runs in the
// background so it never blocks the first paint; whatever it finds is
// applied as soon as it arrives.
if (typeof window.host?.readPanes === 'function') {
  window.host
    .readPanes()
    .then((stored) => {
      if (!stored || typeof stored !== 'object') return;
      persistedPanes = { ...stored };
      if (typeof stored.previewWidth === 'number') {
        previewSplitter.set(stored.previewWidth);
      }
      if (typeof stored.replHeight === 'number') {
        replSplitter.set(stored.replHeight);
      }
    })
    .catch(() => {
      /* no saved sizes — the defaults stand */
    });
}

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
