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
import { createView, createKindRegistry, viewFilePath } from '@editor/view';
import { createLeafPane, computeRects, leafPanes } from '@editor/pane';
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
  createDirectoryColumnsView,
  createDirectoryTreeView,
  createEditorView,
  createHoverDoc,
  createInlineEval,
  createImageView,
  createJukeboxView,
  createMarkdownPreview,
  createMinibuffer,
  createReplView,
  createShellView,
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
import {
  createBufferPrimitives,
  createPanePrimitives,
  createViewPrimitives,
  loadStdlib,
} from '@editor/stdlib';
import { createAudioController } from './audio.js';
import {
  emptyOverrides,
  jsonToLispOverrides,
  lispToJsonOverrides,
} from './face-overrides.js';
import { applyFaceStyles } from './face-styles.js';
import { createSession } from './session.js';
import { createSplash } from './splash.js';
import { createStickyNotes } from './sticky-notes.js';
import { createTabline } from './tabline.js';

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

// --- views --------------------------------------------------------------
//
// Post view/buffer split (plans/PANES.md): the addressable on-screen
// thing is a View. A text-editing View wraps an L2 buffer; other views
// (image, jukebox, shell, ...) hold their own state. The variable name
// `views` replaces the old `buffers`; non-text views still live in the
// same list because the tabline / *Buffer List* address everything
// uniformly.

/** Every open view; one is current. */
const views = [
  createView({
    kind: 'text',
    buffer: createBuffer(WELCOME, { name: 'welcome.txt' }),
  }),
  createView({
    kind: 'text',
    buffer: createBuffer(SCRATCH, { name: 'scratch.lisp' }),
  }),
];
let currentViewIndex = 0;

/** The current text view's buffer, or the last text view's buffer when
 *  the current view has none. Used by the editor view, sticky notes
 *  and the buffer primitives — none of which mean anything for a
 *  non-text view. Switching to a non-text view *does not* change this:
 *  the editor view stays subscribed to its underlying buffer, so a
 *  user toggling into a doc view and back lands on the same text. */
let currentTextBuffer = views[0].buffer;

/** The session object the buffer primitives and view primitives
 *  operate through. The view primitives read the live currentView;
 *  the buffer primitives read currentView.buffer (and raise
 *  `no-buffer-here` when it's null). */
const session = {
  get currentView() {
    return views[currentViewIndex] ?? null;
  },
};

/** Buffers with unsaved changes. */
const dirtyBuffers = new Set();

/** Monotonic id source for shell-buffer session ids. Each new shell
 *  buffer gets a fresh id; the host keys its child-process table off
 *  this. */
let shellSessionCounter = 0;
function nextShellSessionId() {
  shellSessionCounter += 1;
  return `shell-${shellSessionCounter}-${Date.now()}`;
}

/** A change to the view list or the current index. Refreshes the
 *  tabline and schedules a debounced session save. Both targets are
 *  wired in later (the tabline and session controller depend on the
 *  Lisp interpreter being up); this stays a safe no-op until then. */
let onViewsChanged = () => {};
function notifyViewsChanged() {
  onViewsChanged();
}

// --- modeline -----------------------------------------------------------

const nameEl = document.getElementById('modeline-name');
const positionEl = document.getElementById('modeline-position');

function updateModeline() {
  const shown = views[currentViewIndex];
  const count =
    views.length > 1 ? `  ${currentViewIndex + 1}/${views.length}` : '';
  // A non-text view (image, doc, shell, customize, ...) has no point
  // and no mode — show just the view name.
  if (shown && shown.kind !== 'text') {
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
  // Reflect the current view in the OS window title.
  document.title = `${mark}${buffer.name} — editor`;
}

// Watch the current text view's buffer for changes; re-subscribed
// when the active text view (and so the underlying buffer) switches.
let unwatch = () => {};
function watchCurrentBuffer() {
  unwatch();
  const buffer = currentTextBuffer;
  if (buffer === null) {
    unwatch = () => {};
    return;
  }
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

/** Give the current text view's buffer a major mode if it has none
 *  yet. A no-op when the current view has no buffer (image, shell). */
function ensureMajorMode() {
  if (!keymapReady) return;
  const view = session.currentView;
  const buffer = view ? view.buffer : null;
  if (!buffer || buffer.majorMode !== null) return;
  try {
    interpreter.call('choose-major-mode!');
  } catch (error) {
    repl.appendError(`mode selection failed: ${error.message}`);
  }
}

/** The view-kind registry — every view kind contributes a spec with
 *  a mount hook (and optional dispose hook). The registry is filled
 *  below, after each renderer view has been constructed. */
const kindRegistry = createKindRegistry();

// --- pane tree ----------------------------------------------------------
//
// Phase 2 of plans/PANES.md: the editor area is a JS-owned pane tree.
// With one leaf (this phase) it looks and behaves like today; the
// abstraction is exercised so phase 3's split commands can land on it.
//
// The pane *tree* is a JavaScript data structure; the DOM mirrors only
// its leaves. Each leaf has a `<div class="pane">` under `editor-host`,
// absolute-positioned from the tree's layout.

/** The host element that contains the pane tree's leaves. */
const editorHostEl = /** @type {HTMLElement} */ (
  document.querySelector('#editor-host')
);

/** The root of the pane tree. With one leaf this phase; phase 3
 *  introduces splits. The leaf's view is set after the views list and
 *  the kind registry are wired up — at construction the leaf points to
 *  the initial current view. */
let rootPane = createLeafPane({ view: views[currentViewIndex] ?? null });

/** Map from each live leaf-pane id to the `<div class="pane">` element
 *  that mirrors it. The map is rebuilt whenever the tree changes (phase
 *  3); for now it stays stable across the editor's lifetime. */
const paneElements = new Map();

/** Build (or refresh) the DOM children of `editor-host` to match the
 *  pane tree's leaves. Each leaf gets a `<div class="pane">`; stale
 *  leaves are removed. Idempotent: safe to call on every layout.
 *
 *  This phase the leaf set is constant so the function effectively only
 *  runs its first-call branch (creating the one leaf div). Phase 3's
 *  split commands will exercise the remove/add paths. */
function syncPaneElements() {
  const leaves = leafPanes(rootPane);
  const liveIds = new Set(leaves.map((leaf) => leaf.id));
  // Remove pane divs whose leaves are gone (phase 3 cleanup path).
  for (const [id, el] of paneElements) {
    if (!liveIds.has(id)) {
      el.remove();
      paneElements.delete(id);
    }
  }
  // Add pane divs for leaves that don't have one yet.
  for (const leaf of leaves) {
    if (!paneElements.has(leaf.id)) {
      const el = document.createElement('div');
      el.className = 'pane';
      el.dataset.paneId = leaf.id;
      editorHostEl.append(el);
      paneElements.set(leaf.id, el);
    }
  }
}

/** The DOM element for the (single, this phase) leaf pane. Renderer
 *  view modules mount their root inside this; absolute layout is what
 *  sizes it. */
function editorPaneElement() {
  syncPaneElements();
  const leaves = leafPanes(rootPane);
  const leaf = leaves[0];
  return paneElements.get(leaf.id);
}

/** Pending requestAnimationFrame id for a coalesced relayout, or 0. */
let relayoutHandle = 0;

/** Recompute the layout of every leaf pane against the current editor-
 *  host bounds and write each leaf's rect to its element. Cheap to call
 *  repeatedly — the rounded rects mean a no-op write when the size
 *  didn't change. */
function relayoutPanes() {
  relayoutHandle = 0;
  const hostRect = editorHostEl.getBoundingClientRect();
  // Editor-host is positioned within the workspace; the pane divs use
  // its own coordinate system, so we pass width/height only.
  const rects = computeRects(rootPane, {
    width: hostRect.width,
    height: hostRect.height,
  });
  syncPaneElements();
  for (const [id, rect] of rects) {
    const el = paneElements.get(id);
    if (!el) continue;
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }
}

/** Schedule a relayout for the next animation frame. Coalesces a burst
 *  of resize callbacks (e.g. the REPL or markdown-preview splitter
 *  dragging continuously) into one DOM write per frame. */
function scheduleRelayout() {
  if (relayoutHandle !== 0) return;
  relayoutHandle = requestAnimationFrame(relayoutPanes);
}

// Mount the initial pane div now so the renderer view modules below
// have something to append into. Layout runs once at startup and on
// every editor-host resize.
syncPaneElements();
// Initial layout runs in a microtask so editor-host has its first
// computed size (the workspace flex layout settles after first paint).
queueMicrotask(relayoutPanes);

// Observe editor-host for size changes — splitters dragging, the OS
// window resizing, anything that reshapes the editor area triggers a
// coalesced relayout.
const editorHostResizeObserver = new ResizeObserver(() => scheduleRelayout());
editorHostResizeObserver.observe(editorHostEl);

// --- pane focus ---------------------------------------------------------
//
// Each pane has a focus state (plans/PANES.md, "Focus indication").
// Clicking anywhere inside a pane focuses it. With one pane this is a
// no-op visually, but the data model is exercised: phase 3 will light
// up the subtle border shading when multiple leaves are on screen.
//
// (current-pane) — the Lisp primitive in the next commit — resolves
// through `currentPaneId`. (current-view) reroutes through that.

/** The id of the leaf pane that holds focus. With one leaf this is
 *  always that leaf's id; the variable exists for phase 3. */
let currentPaneId = leafPanes(rootPane)[0]?.id ?? null;

/** Return the pane handle for the currently-focused pane, or null when
 *  no pane is focused (vanishingly rare in practice). */
function currentPane() {
  if (currentPaneId === null) return null;
  for (const leaf of leafPanes(rootPane)) {
    if (leaf.id === currentPaneId) return leaf;
  }
  return null;
}

/** Apply the `.pane--focused` CSS class to the focused leaf's div and
 *  remove it from every other pane. Called whenever `currentPaneId`
 *  changes. With one pane this toggles the class on the only pane. */
function refreshPaneFocusIndicators() {
  for (const [id, el] of paneElements) {
    el.classList.toggle('pane--focused', id === currentPaneId);
  }
}

/** Set the current pane to the leaf whose div was clicked, if any.
 *
 *  Runs on the bubble (no capture), doesn't preventDefault, and doesn't
 *  stop propagation — content inside the pane (the editor's
 *  cursor-positioning click, xterm.js's selection drag, image-view's
 *  pan/zoom, every renderer view) has already had its turn by the time
 *  this runs. */
editorHostEl.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const paneEl = target.closest('.pane');
  if (!paneEl) return;
  const paneId = paneEl.dataset.paneId;
  if (typeof paneId !== 'string' || paneId === currentPaneId) return;
  currentPaneId = paneId;
  refreshPaneFocusIndicators();
});

// Paint the initial focus indicator. With one pane this just adds the
// class to the only leaf.
refreshPaneFocusIndicators();

/** Hide every renderer view's DOM, then leave the kind registry to
 *  re-mount the active one. Pause the standalone media players and
 *  the shell view when they're being unmounted so a hidden view
 *  doesn't keep playing / streaming into nothing.
 *
 *  This single helper replaces the old per-kind switch statement; the
 *  kind registry's spec.mount(view) takes over from here.
 *
 *  @param {string} activeKind */
function hideInactiveRendererViews(activeKind) {
  editorView.element.style.display = activeKind === 'text' ? '' : 'none';
  customizeView.element.style.display =
    activeKind === 'customize' ? '' : 'none';
  imageView.element.style.display = activeKind === 'image' ? '' : 'none';
  docView.element.style.display = activeKind === 'doc' ? '' : 'none';
  jukeboxView.element.style.display = activeKind === 'jukebox' ? '' : 'none';
  audioView.element.style.display = activeKind === 'audio' ? '' : 'none';
  videoView.element.style.display = activeKind === 'video' ? '' : 'none';
  directoryTreeView.element.style.display =
    activeKind === 'directory-tree' ? '' : 'none';
  directoryColumnsView.element.style.display =
    activeKind === 'directory-columns' ? '' : 'none';
  shellView.element.style.display = activeKind === 'shell' ? '' : 'none';
  if (activeKind !== 'audio') audioView.setBuffer(null);
  if (activeKind !== 'video') videoView.setBuffer(null);
  if (activeKind !== 'shell') shellView.setBuffer(null);
}

/** Switch to the view at INDEX: dispatch through the kind registry to
 *  mount the matching renderer view, and update the modeline.
 *
 *  Phase 2 of plans/PANES.md: the current leaf pane's `view` is updated
 *  to point at the freshly-switched-to view. With one leaf this is the
 *  only place a leaf's view changes; phase 3's split commands will
 *  open new leaves with their own views. */
function switchToViewIndex(index) {
  if (index < 0 || index >= views.length) return null;
  dismissSplash();
  currentViewIndex = index;
  const view = views[index];
  // Update the (single, this phase) leaf pane's view so (current-view)
  // resolving through (current-pane) finds the right handle.
  const leaves = leafPanes(rootPane);
  if (leaves.length > 0) leaves[0].view = view;
  hideInactiveRendererViews(view.kind);
  kindRegistry.mount(view);
  updateModeline();
  notifyViewsChanged();
  return view;
}

/** Switch to a specific view handle (not by index). Returns the view
 *  switched to, or `null` when the handle isn't in the list. */
function switchToView(view) {
  const idx = views.indexOf(view);
  if (idx < 0) return null;
  return switchToViewIndex(idx);
}

/** Remove the view at INDEX from the list, mirroring the semantics of
 *  the old `kill-buffer!`. Out-of-range indices are a no-op. The kind
 *  registry's dispose hook releases any kind-specific resources (a
 *  shell view's child process; an audio/video view's media element). */
function killViewAtIndex(target) {
  if (target < 0 || target >= views.length) return;
  const wasCurrent = target === currentViewIndex;
  const victim = views[target];
  // Per-kind cleanup. The dispose hook on the spec runs first (it
  // doesn't know whether the view was current); the audio/video
  // current-view destroy() lives here because it depends on the
  // renderer view that was mounted, not on the View handle.
  kindRegistry.dispose(victim);
  if ((victim.kind === 'audio' || victim.kind === 'video') && wasCurrent) {
    if (victim.kind === 'audio') audioView.destroy();
    else videoView.destroy();
  }
  views.splice(target, 1);
  if (views.length === 0) {
    views.push(createView({
      kind: 'text',
      buffer: createBuffer('', { name: '*scratch*' }),
    }));
    currentViewIndex = -1;
    switchToViewIndex(0);
    return;
  }
  if (wasCurrent) {
    const next = Math.min(target, views.length - 1);
    currentViewIndex = -1; // force switchToViewIndex to re-mount.
    switchToViewIndex(next);
  } else if (target < currentViewIndex) {
    currentViewIndex -= 1;
    updateModeline();
    notifyViewsChanged();
  } else {
    updateModeline();
    notifyViewsChanged();
  }
}

/** Kill the (first) view with NAME, if any. */
function killViewByName(name) {
  killViewAtIndex(views.findIndex((v) => v.name === name));
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

/** Refresh the labels of every open jukebox view. Called by the
 *  `*jukebox-track-format*` :on-change hook so a user customising the
 *  format string sees the change apply to already-open jukeboxes. */
function refreshAllJukeboxLabels() {
  let touched = false;
  for (const view of views) {
    if (view.kind !== 'jukebox' || !Array.isArray(view.tracks)) continue;
    view.labels = view.tracks.map((track) =>
      formatTrackLabel(joinPath(view.dir, track))
    );
    touched = true;
  }
  // Re-mount the current view so the change is visible immediately
  // (a view's labels are read in setBuffer). switchToViewIndex with
  // currentViewIndex forces a re-mount; we only do it when the
  // current view is a jukebox so other views aren't disturbed.
  if (touched && currentViewIndex >= 0 &&
      views[currentViewIndex].kind === 'jukebox') {
    const i = currentViewIndex;
    currentViewIndex = -1;
    switchToViewIndex(i);
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
  let index = views.findIndex(
    (v) => v.kind === 'jukebox' && v.name === name
  );
  // The jukebox view carries two callbacks the renderer invokes: a
  // refresh (re-read the dir and rebuild) and a quit (stop, kill the
  // view, restore the previous one).
  const extras = {
    dir,
    tracks,
    labels,
    art,
    refresh: () => openJukeboxForDirectory(dir),
    quit: () => {
      audio.stop();
      killViewByName(name);
    },
  };
  if (index >= 0) {
    // Reuse the slot — keep the View handle stable but refresh its
    // kind-specific fields. The renderer's setBuffer rebuilds from
    // the new fields.
    Object.assign(views[index], extras);
  } else {
    views.push(createView({ kind: 'jukebox', name, extras }));
    index = views.length - 1;
  }
  switchToViewIndex(index);
}

/** Find or create the customisation view named `name`, switch to it. */
function openCustomize(name, scope) {
  let index = views.findIndex(
    (v) => v.kind === 'customize' && v.name === name
  );
  if (index < 0) {
    views.push(createView({
      kind: 'customize',
      name,
      extras: { scope },
    }));
    index = views.length - 1;
  }
  switchToViewIndex(index);
}

/** Find or create the doc view for `docName`, fetching the HTML from
 *  the host if it isn't already open. */
async function openDocBuffer(docName) {
  const existing = views.findIndex(
    (v) => v.kind === 'doc' && v.docName === docName
  );
  if (existing >= 0) {
    switchToViewIndex(existing);
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
  views.push(createView({
    kind: 'doc',
    name: `*Doc: ${docName}*`,
    extras: { docName, html: page.html },
  }));
  switchToViewIndex(views.length - 1);
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
  const existing = views.findIndex(
    (v) => v.kind === 'doc' && v.docName === docName
  );
  if (existing >= 0) {
    switchToViewIndex(existing);
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
  views.push(createView({
    kind: 'doc',
    name: `*Doc: ${docName}*`,
    extras: { docName, html },
  }));
  switchToViewIndex(views.length - 1);
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
    if (openAsMediaViewIfRecognised(result)) return;
    const buffer = createBuffer(result.content, { name: result.name });
    buffer.filePath = result.path;
    // Load the file's sticky notes from its companion metadata file,
    // before the buffer is shown, so note anchors land against the
    // final text.
    const metadata = await window.host.readMetadata(result.path);
    if (metadata) buffer.metadata = metadata;
    views.push(createView({ kind: 'text', buffer }));
    switchToViewIndex(views.length - 1);
  } catch (error) {
    repl.appendError(`open failed: ${error.message}`);
  }
}

/** Route an open-file IPC result to its matching non-text view, when
 *  the shape calls for one. Returns whether a view was mounted — the
 *  caller falls through to the text path on `false`. */
function openAsMediaViewIfRecognised(result, { switch: shouldSwitch = true } = {}) {
  const finalise = () => {
    if (shouldSwitch) switchToViewIndex(views.length - 1);
    return true;
  };
  // An image file comes back with a ready-to-display `imageSrc`
  // (a data URL) rather than text — show it through the image view.
  if (typeof result.imageSrc === 'string') {
    views.push(createView({
      kind: 'image',
      name: result.name,
      extras: { filePath: result.path, src: result.imageSrc },
    }));
    return finalise();
  }
  // An audio or video file comes back with a `media://` URL the
  // matching player streams. For audio the host has already extracted
  // the embedded tag metadata and album art (best-effort) so the view
  // can render them without another IPC round-trip.
  if (result.mediaKind === 'audio') {
    views.push(createView({
      kind: 'audio',
      name: result.name,
      extras: {
        filePath: result.path,
        src: result.src,
        ...(result.metadata ? { metadata: result.metadata } : {}),
        ...(result.albumArtSrc ? { albumArtSrc: result.albumArtSrc } : {}),
      },
    }));
    return finalise();
  }
  if (result.mediaKind === 'video') {
    views.push(createView({
      kind: 'video',
      name: result.name,
      extras: { filePath: result.path, src: result.src },
    }));
    return finalise();
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
    views.push(createView({
      kind: 'image',
      name: result.name,
      extras: { filePath: result.path, src: result.imageSrc },
    }));
    switchToViewIndex(views.length - 1);
  } catch (error) {
    repl.appendError(`open-image failed: ${error.message}`);
  }
}

/**
 * Open a file by an explicit path, dialog-free, routing it through
 * the same logic the dialog path uses (image / audio / video / text).
 * Used by the desktop smoke arm, available to Lisp as
 * `open-file-path!`, and by the session-restore path on startup.
 *
 * Returns the buffer that was added (or null on failure / unreadable
 * file). When `options.switch` is true (the default) the function
 * also switches to the new buffer; the restore loop sets it to false
 * so it can land on the previously-current buffer at the end.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {boolean} [options.switch=true]
 * @returns {Promise<object | null>}
 */
async function openFileByPath(filePath, { switch: shouldSwitch = true } = {}) {
  try {
    const result = await window.host.openFilePath(filePath);
    if (result === null) {
      if (shouldSwitch) {
        repl.appendError(`open-file-path: unreadable (${filePath})`);
      }
      return null;
    }
    // De-dup by file path: surface the existing view rather than
    // stacking a second copy. Without this, double-clicking the same
    // file twice in the columns view (or `open-file-path!` from
    // Lisp) would litter the tabline with identical entries.
    const existing = views.findIndex((v) => viewFilePath(v) === result.path);
    if (existing >= 0) {
      if (shouldSwitch) switchToViewIndex(existing);
      return views[existing];
    }
    if (openAsMediaViewIfRecognised(result, { switch: shouldSwitch })) {
      notifyViewsChanged();
      return views[views.length - 1];
    }
    if (typeof result.content !== 'string') return null;
    const buffer = createBuffer(result.content, { name: result.name });
    buffer.filePath = result.path;
    const metadata = await window.host.readMetadata(result.path);
    if (metadata) buffer.metadata = metadata;
    const view = createView({ kind: 'text', buffer });
    views.push(view);
    notifyViewsChanged();
    if (shouldSwitch) switchToViewIndex(views.length - 1);
    return view;
  } catch (error) {
    if (shouldSwitch) {
      repl.appendError(`open-file-path failed: ${error.message}`);
    }
    return null;
  }
}

// `viewFilePath` (the file-path derivation helper) moved to
// `@editor/view` in phase 2 of plans/PANES.md so `tabline.js` and
// `session.js` can consume it directly, without the legacy
// buffer-record adapter shims.

async function saveBufferInteractive() {
  const view = session.currentView;
  const buffer = view ? view.buffer : null;
  if (buffer === null) {
    repl.appendError('save: no buffer to save in this view');
    return;
  }
  try {
    const result = await window.host.saveFile(buffer.filePath ?? null, buffer.text);
    if (result === null) return;
    buffer.filePath = result.path;
    buffer.name = result.name;
    // Mirror the rename onto the view (text views derive their
    // display name from the buffer).
    view.name = result.name;
    dirtyBuffers.delete(buffer);
    updateModeline();
    notifyViewsChanged();
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
  const buffer = currentTextBuffer;
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

// --- incremental regexp search ----------------------------------------

/**
 * Compile a JS RegExp from a source string, with the global flag for
 * forward scanning. Returns `null` for an invalid source — the regex
 * isearch swallows mid-typing errors silently.
 */
function compileRegexpSource(source, flags = 'g') {
  if (source === '') return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/**
 * Expand REPLACEMENT against a regex match, honouring `$N` (capture
 * group N), `$&` (the whole match), and `$$` (a literal `$`). Anything
 * else is left alone — so `$x` becomes literal `$x`. This is the
 * standard JS String.replace replacement-string semantics, isolated so
 * the regex-replace and query-replace paths share the same expansion.
 *
 * `match` is the args object the RegExp.replace callback receives:
 * `[wholeMatch, group1, group2, ..., offset, fullString, groupsObj?]`.
 */
function expandReplacement(replacement, match) {
  return replacement.replace(/\$([\d&$])/g, (token, ch) => {
    if (ch === '$') return '$';
    if (ch === '&') return match[0];
    const n = Number(ch);
    const captured = match[n];
    return captured === undefined ? '' : captured;
  });
}

/**
 * The first regexp match in `text` at or after `from`. Returns
 * `{ start, end }` or `null`. The supplied RegExp must carry the `g`
 * flag (we drive `lastIndex` ourselves).
 */
function regexpForwardMatch(text, regexp, from) {
  regexp.lastIndex = Math.max(0, from);
  const match = regexp.exec(text);
  if (match === null) return null;
  // Skip zero-length matches at the same position; they would loop.
  if (match[0].length === 0) {
    regexp.lastIndex = match.index + 1;
    const retry = regexp.exec(text);
    if (retry === null || retry[0].length === 0) return null;
    return { start: retry.index, end: retry.index + retry[0].length };
  }
  return { start: match.index, end: match.index + match[0].length };
}

/**
 * The last regexp match in `text` strictly before `from` (so a backward
 * search past an existing match advances). Returns `{ start, end }` or
 * `null`.
 */
function regexpBackwardMatch(text, regexp, from) {
  regexp.lastIndex = 0;
  const limit = Math.max(0, from);
  let last = null;
  let match;
  while ((match = regexp.exec(text)) !== null) {
    if (match.index >= limit) break;
    last = { start: match.index, end: match.index + match[0].length };
    // Guard against zero-length matches stalling lastIndex.
    if (match[0].length === 0) regexp.lastIndex += 1;
  }
  return last;
}

/** Run an incremental regexp search in the minibuffer. */
function startRegexpSearch(initialDirection) {
  const buffer = currentTextBuffer;
  const origin = buffer.point;
  let direction = initialDirection;
  let lastMatch = null; // { start, end } or null

  /** Show a match by selecting it (the editor renders that). */
  function showMatch(match) {
    buffer.moveTo(match.start);
    buffer.moveTo(match.end, { extend: true });
    lastMatch = match;
  }

  /** Find the next match for `source` from `from` in `dir`. */
  function find(source, from, dir) {
    const regexp = compileRegexpSource(source);
    if (regexp === null) return null;
    return dir === 'forward'
      ? regexpForwardMatch(buffer.text, regexp, from)
      : regexpBackwardMatch(buffer.text, regexp, from);
  }

  minibuffer.prompt(
    initialDirection === 'forward'
      ? 'I-search regexp: '
      : 'I-search regexp backward: ',
    {
      onChange(query) {
        lastMatch = null;
        if (query === '') {
          buffer.moveTo(origin);
          minibuffer.setStatus('');
          return;
        }
        const from = direction === 'forward' ? origin : Math.max(origin, 0);
        const match = find(query, from, direction);
        if (match !== null) {
          showMatch(match);
          minibuffer.setStatus('');
        } else {
          minibuffer.setStatus('no match');
        }
      },
      onKey(key, query) {
        // C-M-s / C-M-r advance to the next match in either direction.
        if ((key === 'C-M-s' || key === 'C-M-r') && query !== '') {
          direction = key === 'C-M-s' ? 'forward' : 'backward';
          const base = lastMatch !== null
            ? (direction === 'forward' ? lastMatch.end : lastMatch.start)
            : origin;
          const from = direction === 'forward' ? base : base;
          const match = find(query, from, direction);
          if (match !== null) {
            showMatch(match);
            minibuffer.setStatus('');
          } else {
            minibuffer.setStatus('no more matches');
          }
          return true;
        }
        return false;
      },
      onSubmit() {
        buffer.clearMark();
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
  // The current view is excluded from the candidates so the
  // suggestion the minibuffer shows in brackets is always a
  // different view — pressing Enter is then a useful switch.
  const names = views
    .filter((_, index) => index !== currentViewIndex)
    .map((v) => v.name);

  minibuffer.prompt('Buffer: ', {
    onChange(query) {
      const matches = fuzzyFilter(query, names);
      if (matches.length === 0) {
        const trimmed = query.trim();
        minibuffer.setStatus(trimmed === '' ? '' : `[new view: ${trimmed}]`);
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
          : views.findIndex((v) => v.name === trimmed);
      if (exact >= 0) {
        switchToViewIndex(exact);
        return;
      }
      const chosen = fuzzyFilter(query, names)[0];
      if (chosen !== undefined) {
        switchToViewIndex(views.findIndex((v) => v.name === chosen));
        return;
      }
      if (trimmed === '') return; // nothing to switch to, nothing to create.
      // No open view matches the typed name — create a fresh text view.
      views.push(createView({
        kind: 'text',
        buffer: createBuffer('', { name: trimmed }),
      }));
      switchToViewIndex(views.length - 1);
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

/** The pane-host the Lisp pane-primitives operate through. With one
 *  leaf this phase the host returns the same leaf every call; phase 3
 *  exposes the split commands that grow the tree. */
const paneHost = {
  currentPane: () => currentPane(),
};

/** The view-host the Lisp view-primitives operate through. Every
 *  closure reads `views`/`currentViewIndex` live, so the host stays
 *  truthful as the editor switches and kills views.
 *
 *  Phase 2 of plans/PANES.md: `currentView` now resolves through the
 *  focused leaf pane (`paneHost.currentPane()?.view`). With one leaf
 *  this is identical to `views[currentViewIndex]`; the indirection
 *  matters when phase 3 introduces multiple leaves. */
const viewHost = {
  currentView: () => {
    const pane = paneHost.currentPane();
    if (pane && pane.kind === 'leaf' && pane.view) return pane.view;
    // Fallback for the (vanishingly rare) no-pane / no-view case —
    // keep the legacy index-based lookup so the editor never lands
    // with a null current view during early startup.
    return views[currentViewIndex] ?? null;
  },
  viewList: () => views.slice(),
  switchToView: (target) => switchToView(target),
  newView: (name) => {
    const finalName = name ?? `untitled-${views.length + 1}`;
    const view = createView({
      kind: 'text',
      buffer: createBuffer('', { name: finalName }),
    });
    views.push(view);
    switchToViewIndex(views.length - 1);
    return view;
  },
  killView: (target) => {
    const idx = views.indexOf(target);
    killViewAtIndex(idx);
  },
  nextView: () => {
    if (views.length === 0) return null;
    return switchToViewIndex((currentViewIndex + 1) % views.length);
  },
  previousView: () => {
    if (views.length === 0) return null;
    return switchToViewIndex(
      (currentViewIndex - 1 + views.length) % views.length
    );
  },
  findViewByName: (name) => views.find((v) => v.name === name) ?? null,
  // The snapshot the *Buffer List* (view-menu) renders against. One
  // hash-map per view, with :name, :kind, :mode, :line-count, :file,
  // :modified. The major mode's display name lives on a text view's
  // buffer; non-text views don't carry a mode.
  listViewRecords: () => views.map((view) => {
    const record = new Map();
    record.set(keyword('name'), view.name ?? '');
    record.set(keyword('kind'), view.kind);
    const buffer = view.buffer;
    const major = buffer ? buffer.majorMode : null;
    const modeName =
      major && typeof major.get === 'function'
        ? major.get(keyword('name')) ?? NIL
        : NIL;
    record.set(keyword('mode'), modeName);
    record.set(
      keyword('line-count'),
      buffer && typeof buffer.lineCount === 'number' ? buffer.lineCount : 0
    );
    const filePath = viewFilePath(view);
    record.set(keyword('file'), filePath ?? NIL);
    record.set(keyword('modified'), buffer ? dirtyBuffers.has(buffer) : false);
    return record;
  }),
};

const interpreter = createInterpreter({
  write: (text) => repl.appendOutput(text),
  primitives: {
    ...createBufferPrimitives(session),
    ...createViewPrimitives(viewHost),
    ...createPanePrimitives(paneHost),

    // File commands run async work and return at once.
    'open-file!': () => {
      openFileInteractive();
      return NIL;
    },
    // Open a file by an explicit path — no dialog. The find-file
    // minibuffer flow drives this with the path it has gathered.
    // Returns nil; errors are reported in the REPL.
    'open-file-path!': (args) => {
      const filePath = expandTilde(String(args[0] ?? ''));
      if (filePath === '') return NIL;
      openFileByPath(filePath);
      return NIL;
    },
    // Show a transient message in the minibuffer's echo area (the
    // status line at the foot of the window). Used by the keymap to
    // surface a mid-build chord prefix ("C-x-"), among other things.
    'show-status!': (args) => {
      minibuffer.setStatus(String(args[0] ?? ''));
      return NIL;
    },
    'clear-status!': () => {
      minibuffer.clearStatus();
      return NIL;
    },
    // The current user's home directory — find-file uses it as the
    // starting point for its TAB-completion path. An empty string is
    // returned when the host does not know the home (unlikely).
    'home-directory': () => HOME,
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
    // Open a directory-tree buffer rooted at `path`. The view lists
    // the directory's entries with FontAwesome icons; folders expand
    // on click; files route through the same open path as the REPL.
    // The path is resolved to a canonical absolute form via expandTilde
    // so '~/Source' works as expected.
    'open-directory-tree!': (args) => {
      const rootPath = expandTilde(String(args[0] ?? ''));
      if (rootPath === '') return NIL;
      // Re-use any existing tree view for this path rather than
      // stacking a new one — same logic the jukebox uses.
      const existing = views.findIndex(
        (v) => v.kind === 'directory-tree' && v.rootPath === rootPath
      );
      if (existing >= 0) {
        switchToViewIndex(existing);
        return NIL;
      }
      const segments = rootPath.split('/');
      const tailName = segments[segments.length - 1] || rootPath;
      views.push(createView({
        kind: 'directory-tree',
        name: `*Tree: ${tailName}*`,
        extras: { rootPath, expanded: new Set() },
      }));
      switchToViewIndex(views.length - 1);
      return NIL;
    },
    // Open a shell view — a child process running the user's default
    // shell ($SHELL, falling back to /bin/zsh) with a transcript and
    // an input line. The process is spawned by the host the first time
    // the view is mounted; killing the view terminates it. Unlike the
    // other "open" primitives, each call creates a new view (a user
    // may want several shells); to switch to an existing one, C-x b
    // by name.
    'open-shell-buffer!': () => {
      const sessionId = nextShellSessionId();
      const sequence = views.filter((v) => v.kind === 'shell').length + 1;
      const name = sequence === 1 ? '*shell*' : `*shell*<${sequence}>`;
      views.push(createView({
        kind: 'shell',
        name,
        extras: {
          sessionId,
          transcript: [],
          ended: false,
          spawned: false,
        },
      }));
      switchToViewIndex(views.length - 1);
      return NIL;
    },
    // Open a Finder-style column-view buffer rooted at `path`. Same
    // re-use semantics as `open-directory-tree!`.
    'open-directory-columns!': (args) => {
      const rootPath = expandTilde(String(args[0] ?? ''));
      if (rootPath === '') return NIL;
      const existing = views.findIndex(
        (v) => v.kind === 'directory-columns' && v.rootPath === rootPath
      );
      if (existing >= 0) {
        switchToViewIndex(existing);
        return NIL;
      }
      const segments = rootPath.split('/');
      const tailName = segments[segments.length - 1] || rootPath;
      views.push(createView({
        kind: 'directory-columns',
        name: `*Columns: ${tailName}*`,
        extras: {
          rootPath,
          columns: [{ path: rootPath, selected: null }],
          previewPath: null,
        },
      }));
      switchToViewIndex(views.length - 1);
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
    'start-regexp-search!': () => {
      startRegexpSearch('forward');
      return NIL;
    },
    'start-regexp-search-backward!': () => {
      startRegexpSearch('backward');
      return NIL;
    },
    // Regexp matching for use by Lisp commands (query-replace,
    // replace-regexp). Returns `(start . end)` for the first match in
    // the current buffer's text at or after FROM, or nil for no match
    // or an invalid pattern.
    'find-regexp-forward': (args) => {
      const source = String(args[0] ?? '');
      const from = Number(args[1] ?? 0);
      const regexp = compileRegexpSource(source);
      if (regexp === null) return NIL;
      const match = regexpForwardMatch(currentTextBuffer.text, regexp, from);
      return match === null ? NIL : cons(match.start, match.end);
    },
    'find-regexp-backward': (args) => {
      const source = String(args[0] ?? '');
      const from = Number(args[1] ?? 0);
      const regexp = compileRegexpSource(source);
      if (regexp === null) return NIL;
      const match = regexpBackwardMatch(currentTextBuffer.text, regexp, from);
      return match === null ? NIL : cons(match.start, match.end);
    },
    // Find a plain (non-regexp) string FROM offset onward; used by the
    // `query-replace` walker (plain string match, per spec).
    'find-string-forward': (args) => {
      const needle = String(args[0] ?? '');
      const from = Number(args[1] ?? 0);
      if (needle === '') return NIL;
      const index = currentTextBuffer.text.indexOf(needle, Math.max(0, from));
      return index < 0 ? NIL : cons(index, index + needle.length);
    },
    // Replace every regexp match in the current buffer; REPLACEMENT
    // supports the standard JS `$N`, `$&`, `$$` back-references.
    // Returns the count of replacements made, or -1 for an invalid
    // pattern.
    'replace-regexp-all!': (args) => {
      const source = String(args[0] ?? '');
      const replacement = String(args[1] ?? '');
      const regexp = compileRegexpSource(source);
      if (regexp === null) return -1;
      const buffer = currentTextBuffer;
      let count = 0;
      const newText = buffer.text.replace(regexp, (...match) => {
        count += 1;
        return expandReplacement(replacement, match);
      });
      if (count > 0) buffer.setText(newText);
      repl.appendNote(
        count > 0
          ? `replaced ${count} occurrence(s) of /${source}/`
          : `/${source}/ — no match`
      );
      return count;
    },
    // Replace the buffer range [start, end) with TEXT in a single edit.
    // Used by `query-replace` to swap one match in.
    'replace-range!': (args) => {
      const start = Number(args[0]);
      const end = Number(args[1]);
      const text = String(args[2] ?? '');
      if (!Number.isInteger(start) || !Number.isInteger(end)) return NIL;
      const buffer = currentTextBuffer;
      buffer.moveTo(Math.min(start, end));
      buffer.deleteForward(Math.abs(end - start));
      buffer.insert(text);
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
      const buffer = currentTextBuffer;
      const n = Number(args[0]);
      if (Number.isInteger(n) && n >= 1) {
        buffer.moveTo(buffer.offsetAt(Math.min(n, buffer.lineCount) - 1, 0));
      }
      return NIL;
    },
    'replace-all!': (args) => {
      const buffer = currentTextBuffer;
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

    // View-list primitives now come from createViewPrimitives(viewHost),
    // spread in below this block. The host shape (viewHost) is defined
    // alongside the interpreter so the closures see the live views.

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
    // Directory listing with per-entry type info, synchronous. Returns
    // a list of (name . type) pairs where type is the keyword
    // :directory or :file. The find-file Lisp completer uses this to
    // add a trailing "/" to directory completions, so further typing
    // keeps descending. Returns nil when the path can't be read.
    'list-directory-paths': (args) => {
      const path = expandTilde(String(args[0] ?? ''));
      const entries = window.host.listDirectoryWithTypesSync(path);
      if (entries === null) return NIL;
      return arrayToList(
        entries.map((entry) => cons(entry.name, keyword(entry.type)))
      );
    },
    // Open a completing minibuffer: a prompt the Lisp side drives
    // through `minibuffer-tab-complete` on Tab and the usual
    // `minibuffer-delivered` on submit/cancel. This is what `find-file`
    // uses to gather a path with TAB completion. The handler is
    // implemented in Lisp (see files.lisp) so the policy — what to
    // complete against, what to show when ambiguous — stays in
    // userland.
    'open-completing-minibuffer!': (args) => {
      const promptText = String(args[0] ?? '');
      const initialValue = args.length > 1 ? String(args[1] ?? '') : '';
      minibuffer.prompt(promptText, {
        initialValue,
        onSubmit(value) {
          editorView.focus();
          interpreter.call('minibuffer-delivered', value);
        },
        onCancel() {
          editorView.focus();
          interpreter.call('minibuffer-delivered', NIL);
        },
        onTab(value) {
          try {
            const result = interpreter.call('minibuffer-tab-complete', value);
            if (typeof result === 'string') return result;
          } catch (error) {
            repl.appendError(
              `tab-complete: ${error.lispMessage ?? error.message}`
            );
          }
          return value;
        },
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

/** Things that want a callback when the editor theme changes. The
 *  shell view registers itself once it exists so xterm.js can
 *  rebuild its palette. Must sit above the first top-level
 *  `applyCurrentTheme()` call below — `applyCurrentTheme` is a
 *  function declaration (hoisted) but this is a `const` (in TDZ
 *  until evaluated), so the call would otherwise crash before the
 *  declaration runs. */
const themeListeners = new Set();

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
  // M-1..M-9 jumps to the Nth buffer (1-indexed). Intercepted here,
  // before the Lisp keymap, so the tabline shortcut is unaffected by
  // user keymap edits. Out-of-range indexes are a no-op (handled).
  if (
    typeof key === 'string' &&
    key.length === 3 &&
    key.startsWith('M-') &&
    key[2] >= '1' &&
    key[2] <= '9'
  ) {
    const target = Number(key[2]) - 1;
    if (target < views.length) switchToViewIndex(target);
    return true;
  }
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
  currentTextBuffer,
  editorPaneElement(),
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
 *  theme leaves out (font-size, font-mono, …) keep the :root defaults.
 *  Also pokes any registered theme listeners (e.g. the shell view's
 *  xterm.js theme; that view reads CSS variables at construction time
 *  and needs telling explicitly when they change). */
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
    for (const listener of themeListeners) {
      try { listener(); } catch { /* listener bug — keep going */ }
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
  editorPaneElement(),
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
const imageView = createImageView(editorPaneElement(), {
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
const docView = createDocView(editorPaneElement(), {
  ...(keymapReady ? { onKey: dispatchKey } : {}),
  closeBuffer: () => {
    if (!keymapReady) return;
    try {
      interpreter.call('kill-view');
    } catch (error) {
      repl.appendError(`kill-view: ${error.lispMessage ?? error.message}`);
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
  editorPaneElement(),
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
  // Look for an audio view currently holding the file's metadata — it
  // would carry any user-added custom keys the writer needs to
  // preserve. A non-text view stores its metadata as a top-level
  // field, set at creation by `openAsMediaViewIfRecognised`.
  const view = views.find(
    (v) => v.kind === 'audio' && v.filePath === path
  );
  const source = view
    ? view.metadata
    : window.host.audioMetadataSync(path);
  const fields = stripDerivedFields(source ?? {});
  mutator(fields);
  const result = window.host.audioMetadataWriteSync(path, fields);
  if (!result || !result.ok) {
    throw new Error(result?.error ?? 'metadata write failed');
  }
  if (view) view.metadata = fields;
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
  editorPaneElement(),
  {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    closeBuffer: () => {
      if (!keymapReady) return;
      try {
        interpreter.call('kill-view');
      } catch (error) {
        repl.appendError(`kill-view: ${error.lispMessage ?? error.message}`);
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
  editorPaneElement(),
  {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    closeBuffer: () => {
      if (!keymapReady) return;
      try {
        interpreter.call('kill-view');
      } catch (error) {
        repl.appendError(`kill-view: ${error.lispMessage ?? error.message}`);
      }
    },
  }
);
videoView.element.style.display = 'none';

// The directory tree-view — a `directory-tree`-kind buffer is shown
// through this view. Folder rows expand on click; file rows route
// through the host's open-file-path so they land in whichever view
// their suffix maps to (text editor, image, audio, video).
const directoryTreeView = createDirectoryTreeView(
  editorPaneElement(),
  {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    listDirectory: (path) => window.host.listDirectoryDetailedSync(path),
    openPath: (path) => {
      openFileByPath(path);
    },
    closeBuffer: () => {
      if (!keymapReady) return;
      try {
        interpreter.call('kill-view');
      } catch (error) {
        repl.appendError(`kill-view: ${error.lispMessage ?? error.message}`);
      }
    },
  }
);
directoryTreeView.element.style.display = 'none';

// The directory columns-view — Finder-style horizontal browser.
// Click a folder → spawns a column to its right; click a file →
// trailing column becomes a preview pane for the file. Double-click
// a file → opens it through the host's open-file-path so it lands
// in whichever view its suffix maps to.
const directoryColumnsView = createDirectoryColumnsView(
  editorPaneElement(),
  {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    listDirectory: (path) => window.host.listDirectoryDetailedSync(path),
    getPreview: (path) => buildColumnPreview(path),
    openPath: (path) => {
      openFileByPath(path);
    },
    closeBuffer: () => {
      if (!keymapReady) return;
      try {
        interpreter.call('kill-view');
      } catch (error) {
        repl.appendError(`kill-view: ${error.lispMessage ?? error.message}`);
      }
    },
  }
);
directoryColumnsView.element.style.display = 'none';

// The shell view — a `shell`-kind buffer is shown through this view.
// v4: xterm.js owns the DOM. The host pipes pty bytes in and out;
// xterm.js parses every escape sequence, draws the grid, and emits
// resize requests when its fit-to-container addon decides cols/rows
// changed. The view stays subscribed across buffer switches so
// background commands keep streaming into the terminal.
const shellView = createShellView(editorPaneElement(), {
  spawn: (sessionId, opts) =>
    window.host && typeof window.host.shellSpawn === 'function'
      ? window.host.shellSpawn(sessionId, opts)
      : Promise.resolve({ ok: false, error: 'shell IPC unavailable' }),
  write: (sessionId, data) =>
    window.host && typeof window.host.shellWrite === 'function'
      ? window.host.shellWrite(sessionId, data)
      : Promise.resolve({ ok: false }),
  resize: (sessionId, cols, rows) =>
    window.host && typeof window.host.shellResize === 'function'
      ? window.host.shellResize(sessionId, cols, rows)
      : Promise.resolve({ ok: false }),
  kill: (sessionId) =>
    window.host && typeof window.host.shellKill === 'function'
      ? window.host.shellKill(sessionId)
      : Promise.resolve({ ok: false }),
  onData: (callback) =>
    window.host && typeof window.host.onShellData === 'function'
      ? window.host.onShellData(callback)
      : () => {},
  onExit: (callback) =>
    window.host && typeof window.host.onShellExit === 'function'
      ? window.host.onShellExit(callback)
      : () => {},
});
shellView.element.style.display = 'none';
// xterm.js reads CSS variables once, at terminal construction. Pump
// any later theme change into it.
themeListeners.add(() => shellView.applyTheme());

// --- kind registry -----------------------------------------------------
//
// Each view kind contributes a `mount` hook (and an optional `dispose`
// hook). The desktop's `switchToViewIndex` routes through this
// registry — the old ten-way switch on `buffer.kind` is gone.
//
// Renderer view modules (createEditorView, createImageView, ...) still
// expose `setBuffer(viewOrNull)` for compat. Each kind here passes the
// View handle to setBuffer; the renderer modules read `view.name`,
// `view.tracks`, `view.html`, etc. — the same fields they used to
// read off the old buffer record.
//
// `tabline` is registered as a kind so the surface is uniform, but no
// UI/Lisp commands construct one this phase (Q11 / phase 3).

kindRegistry.register('text', {
  hasBuffer: true,
  mount: (view) => {
    currentTextBuffer = view.buffer;
    editorView.setBuffer(view.buffer);
    stickyNotes.setBuffer(view.buffer);
    watchCurrentBuffer();
    ensureMajorMode();
    editorView.focus();
    refreshModeMenu();
    syncMarkdownPreviewToBuffer();
  },
});

kindRegistry.register('customize', {
  hasBuffer: false,
  mount: (view) => {
    customizeView.setBuffer(view);
    customizeView.focus();
  },
});

kindRegistry.register('image', {
  hasBuffer: false,
  mount: (view) => {
    imageView.setBuffer(view);
    imageView.focus();
  },
});

kindRegistry.register('doc', {
  hasBuffer: false,
  mount: (view) => {
    docView.setBuffer(view);
    docView.focus();
  },
});

kindRegistry.register('jukebox', {
  hasBuffer: false,
  mount: (view) => {
    jukeboxView.setBuffer(view);
    jukeboxView.focus();
  },
});

kindRegistry.register('audio', {
  hasBuffer: false,
  mount: (view) => {
    audioView.setBuffer(view);
    audioView.focus();
  },
});

kindRegistry.register('video', {
  hasBuffer: false,
  mount: (view) => {
    videoView.setBuffer(view);
    videoView.focus();
  },
});

kindRegistry.register('directory-tree', {
  hasBuffer: false,
  mount: (view) => {
    directoryTreeView.setBuffer(view);
    directoryTreeView.focus();
  },
});

kindRegistry.register('directory-columns', {
  hasBuffer: false,
  mount: (view) => {
    directoryColumnsView.setBuffer(view);
    directoryColumnsView.focus();
  },
});

kindRegistry.register('shell', {
  hasBuffer: false,
  mount: (view) => {
    shellView.setBuffer(view);
    shellView.focus();
  },
  // A shell view owns a child process — kill it so it doesn't leak.
  // The host's `shell:exit` event will fire and remove the session
  // from the main-process table; the view's exit handler is fine to
  // run on a view that may already be unmounted.
  dispose: (view) => {
    if (typeof view.sessionId !== 'string') return;
    try {
      if (window.host && typeof window.host.shellKill === 'function') {
        window.host.shellKill(view.sessionId);
      }
    } catch {
      // Failure here means the process is already gone; nothing to do.
    }
  },
});

// Tabline as a view kind (PANES.md, Q11). The spec is registered so
// the system recognises the kind, but no mount/UI is wired this phase
// — there are no commands to construct a tabline-view yet. The mount
// hook is a defensive stub: if a tabline view somehow finds its way
// into the views list, the user sees a clear error rather than the
// switch silently doing nothing.
kindRegistry.register('tabline', {
  hasBuffer: false,
  mount: () => {
    repl.appendError('tabline-view: not yet implemented (phase 3)');
  },
});

/** Read a file's preview shape for the columns view. Routes through
 *  the existing openFilePath IPC, so images come back as data: URLs,
 *  audio/video as media:// URLs, text as the file body, and anything
 *  else lands in the "binary" branch with a size estimate. */
async function buildColumnPreview(path) {
  try {
    const result = await window.host.openFilePath(path);
    if (result === null) return null;
    const name = result.name ?? path.split('/').pop();
    if (typeof result.imageSrc === 'string') {
      return { kind: 'image', name, src: result.imageSrc };
    }
    if (result.mediaKind === 'audio') {
      return { kind: 'audio', name, src: result.src };
    }
    if (result.mediaKind === 'video') {
      return { kind: 'video', name, src: result.src };
    }
    if (typeof result.content === 'string') {
      return {
        kind: 'text',
        name,
        content: result.content,
        size: result.content.length,
      };
    }
    return { kind: 'binary', name };
  } catch {
    return null;
  }
}

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

/** Open (or reuse) a text view showing the eval log. */
function openEvalLogBuffer() {
  const name = '*Eval log*';
  const text = evalLog.length === 0
    ? '(no evaluations yet)'
    : evalLog.map((entry) => {
        const marker = entry.ok ? '⇒' : '!';
        return `${entry.at}\n  ${entry.source}\n  ${marker} ${entry.label}`;
      }).join('\n\n');
  let index = views.findIndex(
    (v) => v.kind === 'text' && v.name === name
  );
  if (index < 0) {
    views.push(createView({
      kind: 'text',
      buffer: createBuffer(text, { name }),
    }));
    index = views.length - 1;
  } else {
    views[index].buffer.setText(text);
  }
  switchToViewIndex(index);
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
  getBuffer: () => currentTextBuffer,
  render: renderNoteHtml,
  onChange: () => scheduleMetadataWrite(currentTextBuffer),
});
stickyNotes.setBuffer(currentTextBuffer);

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
  markdownPreview.update(currentTextBuffer.text);
}

/** Re-point the preview pane after a buffer switch: render the new
 *  buffer if the pane is open and the buffer is Markdown; otherwise
 *  hide the pane, since it only makes sense for a markdown-mode
 *  buffer. A no-op when the pane is already hidden. */
function syncMarkdownPreviewToBuffer() {
  if (!markdownPreviewVisible()) return;
  if (currentBufferIsMarkdown()) {
    markdownPreview.refreshNow(currentTextBuffer.text);
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
  markdownPreview.refreshNow(currentTextBuffer.text);
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

// --- tabline ------------------------------------------------------------
// One tab per open view, above the workspace. The strip is rebuilt
// whenever the view list or the current index changes; clicks switch
// or kill views; drag reorders them.
//
// Phase 2 of plans/PANES.md: the tabline consumes views directly. The
// old `viewAsTablineRecord` adapter is gone — tabline.js reads
// `view.name` and `viewFilePath(view)` straight off the View handle.

const tabline = createTabline(document.getElementById('tabline-host'), {
  getViews: () => views,
  getCurrentIndex: () => currentViewIndex,
  onSelect: (index) => switchToViewIndex(index),
  onClose: (index) => {
    // Run kill-view! through the interpreter when available so it
    // shares the Lisp side's quit-confirmation / hook behaviour; fall
    // back to the host primitive on early-load (the interpreter isn't
    // ready until after the stdlib loads).
    if (keymapReady) {
      try {
        const view = views[index];
        if (view && typeof view.name === 'string') {
          interpreter.call('kill-view!', view.name);
          return;
        }
      } catch (error) {
        repl.appendError(error.lispMessage ?? error.message ?? String(error));
      }
    }
    // Fall back to the host kill-view primitive — the primitive
    // accepts a name; mirror that path. (Effectively: switch to the
    // target so the no-arg form kills the right one.)
    switchToViewIndex(index);
    interpreter.evaluate('(kill-view!)');
  },
  onReorder: (from, to) => {
    if (from === to) return;
    const moved = views.splice(from, 1)[0];
    views.splice(to, 0, moved);
    // Re-point currentViewIndex onto its moved view.
    if (from === currentViewIndex) {
      currentViewIndex = to;
    } else if (from < currentViewIndex && to >= currentViewIndex) {
      currentViewIndex -= 1;
    } else if (from > currentViewIndex && to <= currentViewIndex) {
      currentViewIndex += 1;
    }
    notifyViewsChanged();
    updateModeline();
  },
});

// --- persistent session -------------------------------------------------
// On change (debounced 500ms) or pagehide, pickle the open views and
// the current one to <userData>/session.json. On the next startup the
// restore loop re-opens each file and lands on the previously-current
// view.
//
// Phase 2 of plans/PANES.md: the session controller consumes views
// directly. The old `viewAsSessionRecord` adapter is gone —
// session.js reads view.kind / view.buffer.point / view.buffer.mark
// straight off the View handle. The on-disk JSON's outer key is still
// `buffers` for backwards compatibility with session.json files saved
// before the view/buffer split.

const sessionController = createSession({
  getViews: () => views,
  getCurrentIndex: () => currentViewIndex,
  openByPath: async (path, entry) => {
    const view = await openFileByPath(path, { switch: false });
    if (view === null) return null;
    // Only text views carry point/mark; image/audio/video views don't.
    const buffer = view.buffer;
    if (buffer && typeof buffer.moveTo === 'function') {
      const point = Number.isFinite(entry.point) ? entry.point : 0;
      const mark = Number.isFinite(entry.mark) ? entry.mark : null;
      buffer.moveTo(point);
      if (mark !== null) buffer.setMark(mark);
    }
    return entry;
  },
  switchToView: switchToViewIndex,
  host: window.host,
});

// Wire the change hook: every list / index change refreshes the
// tabline and queues a session save. `restoring` is set while the
// restore loop runs so the inner view-add doesn't race the save —
// the save fires once at the end of restore, with the final list.
let restoring = false;
onViewsChanged = () => {
  tabline.refresh();
  if (!restoring) sessionController.save();
};
// Render the strip once now (the editor view is already mounted).
tabline.refresh();

// Flush the session synchronously-ish on page unload. The pagehide
// event fires when the renderer is about to be torn down (quit, reload,
// navigation); ipcRenderer.invoke returns a Promise the host will
// process even after pagehide returns.
window.addEventListener('pagehide', () => {
  sessionController.flush();
});

// Restore: re-open the files the previous session left open and land
// on the previously-current buffer. The restore is awaited so the
// buffers are present before the user starts interacting.
restoring = true;
try {
  await sessionController.restore();
} finally {
  restoring = false;
}
