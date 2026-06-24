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
  createView,
  viewFilePath,
  isTablineView,
  tablineActiveChild,
} from '@editor/view';
import {
  createLeafPane,
  createSplitPane,
  computeRects,
  computeSplitterEdges,
  findPaneById,
  insertAtRootBorder,
  insertAtSplit,
  leafPanes,
  paneInDirection,
  parentOf,
  replacePane,
  siblingOf,
  swapLeaves,
  permuteLeaves,
  spiralOrder,
  bumpIdCounterPast,
  SPLIT_HORIZONTAL,
  SPLIT_VERTICAL,
} from '@editor/pane';
import {
  applyProcedure,
  arrayToList,
  cons,
  createInterpreter,
  keyword,
  LispError,
  listToArray,
  NIL,
  sym,
  Sym,
  writeString,
} from '@editor/lisp';
import {
  AudioView,
  BrowserView,
  CustomizeView,
  DocView,
  BookmarkView,
  DirectoryColumnsView,
  DirectoryTreeView,
  createEditorView,
  createHoverDoc,
  createInlineEval,
  ImageView,
  JukeboxView,
  PdfView,
  createMarkdownPreview,
  buildPreviewHead,
  createMinibuffer,
  createReplView,
  createUtilityDock,
  createOutputPanel,
  createCompletionsPanel,
  ShellView,
  GnuplotView,
  NotebookView,
  ViewListView,
  RecoverView,
  createReftexSelectPanel,
  createReftexCiteFormatPanel,
  createReftexCitePanel,
  PlaceholderView,
  cloneTargetForKind,
  isPlaceholderView,
  resolvePlaceholderAction,
  createSplitter,
  createTreeSitterHighlighter,
  VideoView,
  findArt,
  formBoundsAtPoint,
  formBoundsBeforePoint,
  fuzzyFilter,
  highlightLine,
  isAudioFile,
  keyEventToString,
  altComposedInsert,
  languageForFilename,
  loadLanguageHighlighters,
  createHighlightOverrideStore,
  renderMarkdown,
  parseCitations,
  formatBibliography,
  formatCitation,
  citationKeys,
  citationEntries,
  formatBibliographyEntries,
  registerCslStyle,
  parseCitationsLenient,
  createMathPreview,
  mathPreviewProviderForMode,
  TextView,
  TablineView,
  ElementView,
} from '@editor/renderer';
import {
  createBufferPrimitives,
  createLatexPrimitives,
  createPanePrimitives,
  createViewPrimitives,
  loadStdlib,
  pathDirname,
} from '@editor/stdlib';
import { createAudioController } from './audio.js';
import {
  emptyOverrides,
  jsonToLispOverrides,
  lispToJsonFacesFile,
  jsonToLispUserFaces,
  jsonToLispHighlightRules,
} from './face-overrides.js';
import { applyFaceStyles, BASE_FACE_NAME } from './face-styles.js';
import { resolveElementModuleUrl, normalizeFit } from './element-spec.js';
import {
  isMathPreviewActive,
  bufferMajorModeName,
} from './math-preview-host.js';
import { buildModeMenuItems } from './mode-menu-build.js';
import { createRecovery } from './recovery-controller.js';
import { hashText } from './recovery.js';
import { createSession } from './session.js';
import {
  upsertProject,
  projectNameFromRoot,
  setProjectThumbnail,
} from './project-index.js';
import { openProjectChooser } from './project-chooser.js';
import { pickEditingLeaf } from './tree-open.js';
import { shouldDrawFocusBorder } from './pane-focus.js';
import { materialIconUrlForEntry } from './material-icons.js';
import { createSplash } from './splash.js';
import { createStickyNotes } from './sticky-notes.js';
import { createBookmarks } from './bookmarks.js';
import { enterAddPaneMode } from './add-pane-mode.js';
import { enterMoveViewsMode } from './move-view-mode.js';
import { createTabline } from '@editor/renderer';
// G2 (plans/MWB-GRADUATION.md): the server-view client core. Imported
// unconditionally (it has no top-level effects), but only CONSTRUCTED behind
// the GODOT_SERVER flag in the late boot — so flag-off is byte-for-byte today.
import { createServerViewClient } from './server-view-client.js';
// The wire-protocol message tags (no side effects). Used only by the
// serverMode-only __godotG2 test hook below to feed a synthetic SNAPSHOT.
import { MSG } from '../mwb/protocol.js';
// G2 router gate: a pure predicate the global key router consults so it stands
// down (defers to the server) in server-mode once the server view is mounted —
// focus-independent, so the dual-dispatch undo bell can't ring. No-op flag-off
// (serverMode false → always returns false → the router runs as today).
import { shouldGlobalRouterDefer } from './server-router-gate.js';
// (The leaf-flip retired the G2 overlay container, so the stale-<text-view>
// sweep `clearStaleServerViews` is no longer imported — the bound leaf reuses
// one instance across buffer switches; nothing accumulates. The module +
// its tests remain for now as dead code, to delete in a follow-up.)
// G2 chrome: the generic PICKER panel the server-view client renders in
// server-mode (buffer list / M-x / RefTeX). Imported unconditionally (no
// top-level effects); only USED inside the serverMode-gated boot below.
import { createPickerPanel } from '../mwb/picker-panel.js';
// G4 Step 3b: static panes (a split pane showing a DIFFERENT buffer than the
// focused one) render from a ClientBuffer seeded with the PANE_TREE leaf's text.
// Imported unconditionally (pure factory, no top-level effects); used only in
// the serverMode pane-layout reconcile below.
import { createClientBuffer } from '../mwb/client-buffer.js';

/**
 * Build a Lisp hash-map (a JS `Map` with interned-keyword keys) from a
 * plain object — the shape the host's citation / synctex primitives
 * return. (latex-primitives.js keeps its own copy for its own scope; this
 * is the app.js-scope equivalent, used by the citation primitives.)
 *
 * @param {Record<string, *>} fields
 * @returns {Map<*, *>}
 */
function record(fields) {
  const map = new Map();
  for (const [key, value] of Object.entries(fields)) {
    map.set(keyword(key), value);
  }
  return map;
}

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
const INIT_TEMPLATE = `;;; init.lisp — your Godot configuration.
;;;
;;; This file is evaluated at startup, after the standard library and
;;; your saved customisations. It is the Godot equivalent of .emacs:
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

/** First-launch seed views: shown only when there's no saved session
 *  to restore. Tracked by identity so we can drop them after a
 *  successful restore (the saved session is then the authoritative
 *  list, and these would otherwise accumulate at the head of `views`
 *  across restarts — discoverable via `C-x b` but not in any tabline). */
const initialSeedViews = [
  createView({
    kind: 'text',
    buffer: createBuffer(WELCOME, { name: 'welcome.txt' }),
  }),
  createView({
    kind: 'text',
    buffer: createBuffer(SCRATCH, { name: 'scratch.lisp' }),
  }),
];

/** Every open view; one is current. */
const views = [...initialSeedViews];
let currentViewIndex = 0;

// Current effective `*tab-width*`. Updated by the `set-css-tab-width!`
// primitive whenever the Lisp setting changes; read by every
// createEditorView instance through its `getTabWidth` callback so
// cursor / selection / bracket positioning stays in lock-step with
// the CSS `--tab-width` variable.
let currentTabWidth = 4;

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
 *  `no-buffer-here` when it's null).
 *
 *  `currentView` resolves through the pane tree: the focused leaf's
 *  view, peeled through any tabline-views to the active child. This
 *  is the same logic `viewHost.currentView` uses (see below), and the
 *  two MUST stay aligned — otherwise buffer primitives operate on a
 *  stale view (the one `currentViewIndex` happens to point at, which
 *  isn't always the user-visible one once tabline tabs are switched).
 *  The legacy `views[currentViewIndex]` is a last-resort fallback for
 *  the no-pane-yet startup window. */
const session = {
  get currentView() {
    const pane = currentPane();
    if (pane && pane.kind === 'leaf' && pane.view) {
      return peelTabline(pane.view);
    }
    return views[currentViewIndex] ?? null;
  },
};

/** Buffers with unsaved changes. */
const dirtyBuffers = new Set();

/** Per-buffer saved-state baseline — the length + content-hash of the
 *  text that matches what's on disk (set when a file is opened and when
 *  it is saved). A buffer counts as dirty only while its current text
 *  differs from this, so undoing every edit back to the saved state
 *  clears the modified flag. A buffer with no baseline (a new/scratch
 *  buffer, or a recovered crash snapshot — unsaved by definition) is
 *  treated as dirty whenever it changes, until its first save. */
const savedBaseline = new WeakMap();

/** Record BUFFER's current text as its saved baseline (on open / save). */
function markBufferSaved(buffer) {
  const text = typeof buffer?.text === 'string' ? buffer.text : '';
  savedBaseline.set(buffer, { length: text.length, hash: hashText(text) });
}

/** Whether BUFFER's current text matches its saved baseline. False when
 *  the buffer has no baseline (treat as not-yet-clean). */
function bufferMatchesSaved(buffer) {
  const base = savedBaseline.get(buffer);
  if (!base) return false;
  const text = typeof buffer?.text === 'string' ? buffer.text : '';
  return text.length === base.length && hashText(text) === base.hash;
}

/** The autosave / crash-recovery controller: snapshots every dirty
 *  buffer to `<userData>/recovery/` (debounced on edit, immediate on
 *  blur), drops a buffer's snapshot when it is saved, and clears them
 *  all on a clean confirmed quit. A crash leaves the snapshots in place
 *  for the next launch to offer back. */
const recovery = createRecovery({
  getDirtyBuffers: () => dirtyBuffers,
  host: window.host,
  // Live-read the Lisp defcustoms (see system.lisp) so a user can
  // toggle autosave or retune the interval from Lisp without a restart.
  // Both default safely (on, 1000ms) before the stdlib has loaded.
  isEnabled: () => {
    if (!keymapReady) return true;
    try {
      return interpreter.evaluate('*autosave-recovery*') !== false;
    } catch {
      return true;
    }
  },
  getDebounceMs: () => {
    if (!keymapReady) return 1000;
    try {
      const v = interpreter.evaluate('*autosave-recovery-interval*');
      return typeof v === 'number' && v > 0 ? v : 1000;
    } catch {
      return 1000;
    }
  },
});

/** Set once a clean quit is committed (the unsaved-changes confirm
 *  passed), so the `pagehide` handler doesn't re-snapshot dirty buffers
 *  after `recovery.clear()` already wiped them. */
let quitting = false;

/**
 * Report a renderer-side fault — a render-loop throw, a global `error`,
 * or an unhandled promise rejection (§3). Logs it to the REPL eval log,
 * flashes a one-line minibuffer note, and triggers an immediate
 * crash-recovery snapshot flush so a fault that spirals into a
 * crash-loop can't eat unsaved work. Never throws — the reporter must
 * not become a second fault.
 *
 * @param {string} label - A short prefix, e.g. `render error`.
 * @param {*} error
 */
function reportRendererFault(label, error) {
  const detail =
    (error && (error.message ?? error.lispMessage)) || String(error);
  try {
    repl.appendError(`${label}: ${detail}`);
  } catch {
    /* the eval log may not be up yet */
  }
  try {
    minibuffer.message(`${label} — see the eval log`);
  } catch {
    /* the minibuffer may not be up yet */
  }
  try {
    recovery.flush();
  } catch {
    /* best-effort */
  }
}

// §3a global safety net: any uncaught error or unhandled promise
// rejection in the renderer is logged + recovery-flushed instead of
// silently killing a flow. The render loop has its own finer-grained
// guard (view.js); this catches everything else — a broken event
// handler, a rejected async command, an overlay built outside render.
window.addEventListener('error', (event) => {
  reportRendererFault('uncaught error', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  reportRendererFault('unhandled rejection', event.reason);
});

// G1/G2 (plans/MWB-GRADUATION.md): when GODOT_SERVER=1, main forks the Model-B
// server and transfers a MessagePort to this renderer (re-dispatched by the
// preload as a `godot:server-port` window message). G1 stashed the port; G2
// routes ONE real editor view through it (see the server-view boot near the
// end of this file). With the flag off (`host.serverMode` false), this listener
// is never registered, so the renderer is byte-for-byte unchanged. The block
// reads only `window.host` (always present) and module-globals, so it is safe
// at module-init time.
//
// @type {MessagePort | null} — the connected server port in server mode, else null.
var godotServerPort = null; // eslint-disable-line no-var -- hoisted; set from a window-message listener registered at init.
// @type {(() => void) | null} — the G2 boot hook, defined late once the
// highlighters + key normaliser exist. The port may connect before or after
// that, so whichever runs second fires it. Hoisted so the init-time listener
// can reference it before the boot assigns it (it's null until then).
var bootServerViewClient = null; // eslint-disable-line no-var -- hoisted; assigned in the async boot, called from here.
if (window.host && window.host.serverMode) {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== 'godot:server-port') return;
    const [port] = event.ports;
    if (!port) return;
    godotServerPort = port;
    console.info('[godot] Model-B server port connected (GODOT_SERVER=1)');
    // If the boot already ran (highlighters ready), wire the G2 client now;
    // otherwise the boot will call us once it's ready (it checks the port).
    if (typeof bootServerViewClient === 'function') bootServerViewClient();
  });
}

/** Monotonic id source for shell-buffer session ids. Each new shell
 *  buffer gets a fresh id; the host keys its child-process table off
 *  this. */
let shellSessionCounter = 0;
function nextShellSessionId() {
  shellSessionCounter += 1;
  return `shell-${shellSessionCounter}-${Date.now()}`;
}

/** Monotonic id source for gnuplot-buffer session ids. Each new gnuplot
 *  buffer gets a fresh id; the host keys its child-process table off
 *  this. */
let gnuplotSessionCounter = 0;
function nextGnuplotSessionId() {
  gnuplotSessionCounter += 1;
  return `gnuplot-${gnuplotSessionCounter}-${Date.now()}`;
}

/** Monotonic id source for notebook views. The reactive engine keys its
 *  per-notebook record (cell values, dep graph) off this id. */
let notebookCounter = 0;
function nextNotebookId() {
  notebookCounter += 1;
  return `notebook-${notebookCounter}-${Date.now()}`;
}

/** Rename the notebook with NOTEBOOK-ID to NAME (its display + buffer
 *  name; the file on disk is unchanged). Keyed by id, not by "current
 *  view", so it's robust to focus moving during a minibuffer prompt. */
function renameNotebookById(id, name) {
  const n = String(name ?? '').trim();
  if (n === '') return;
  const view = views.find((v) => v.kind === 'notebook' && v.notebookId === id);
  if (!view) return;
  view.name = n;
  if (view.buffer) view.buffer.name = n;
  updateModeline();
  notifyViewsChanged();
  // Refresh every notebook view's header picker so the new name shows in
  // the dropdown — the inline ✎ button refreshes its own, but the M-x
  // command path (rename-notebook-by-id!) has no view handle, so do it for
  // all notebook elements here.
  for (const el of document.querySelectorAll('notebook-view')) {
    if (typeof el.refreshHeader === 'function') el.refreshHeader();
  }
}

/** Switch to the next (DELTA +1) or previous (-1) open notebook, wrapping
 *  around. If the current view isn't a notebook, jump to the first/last. */
function cycleNotebook(delta) {
  const notebooks = views.filter((v) => v.kind === 'notebook');
  if (notebooks.length === 0) return;
  const current = views[currentViewIndex];
  const here = current && current.kind === 'notebook' ? notebooks.indexOf(current) : -1;
  const next =
    here === -1
      ? delta > 0
        ? 0
        : notebooks.length - 1
      : (here + delta + notebooks.length) % notebooks.length;
  switchToViewIndex(views.indexOf(notebooks[next]));
}

/** A change to the view list or the current index. Refreshes the
 *  tabline and schedules a debounced session save. Both targets are
 *  wired in later (the tabline and session controller depend on the
 *  Lisp interpreter being up); this stays a safe no-op until then. */
let onViewsChanged = () => {};
function notifyViewsChanged() {
  onViewsChanged();
}

/** Peel through any number of tabline-view layers (nested tablines —
 *  Q10 — peel all the way through, matching the brief's lean: the
 *  user's intent for nested tabs is "the deepest active child is what
 *  I'm editing"). Returns the input untouched when it is not a
 *  tabline-view; returns the tabline itself when its active tab is
 *  out of range (empty tabline). The depth cap is a defensive guard
 *  against a degenerate cycle — a tabline-view's tabs shouldn't
 *  contain itself, but never assume. */
function peelTabline(view) {
  let v = view;
  for (let depth = 0; depth < 16; depth += 1) {
    if (!isTablineView(v)) return v;
    const child = tablineActiveChild(v);
    if (child === null) return v;
    v = child;
  }
  return v;
}

/** True when VIEW is the server-backed text view the Model-B leaf-flip
 *  installs as a leaf's `view` (`GODOT_SERVER=1`). Such a view is a live
 *  façade over the `ClientBuffer` mirror: its `buffer` IS the mirror and its
 *  point/mark/cursors read straight off it. Two render seams branch on this —
 *  the leaf's `onKey` routes to the server's keymap, and its decorations come
 *  from the mirror (not the in-renderer snippet store). The `_serverBacked`
 *  marker is ONLY ever set inside the serverMode boot block, so this is always
 *  false flag-off and every guard keyed on it is a no-op in the normal editor. */
function isServerBackedView(view) {
  return !!(view && view._serverBacked === true);
}

/** The next index in `views` from FROM, stepping by DELTA (+1 / -1) and
 *  skipping transient placeholder entries. Wraps around. Returns -1 when
 *  there is no non-placeholder view to land on. Used by the
 *  next/previous-view cycling fallback so the cycle never lands on a
 *  placeholder. */
function nextNonPlaceholderIndex(from, delta) {
  const n = views.length;
  if (n === 0) return -1;
  for (let step = 1; step <= n; step += 1) {
    const i = ((from + delta * step) % n + n) % n;
    if (!isPlaceholderView(views[i])) return i;
  }
  return -1;
}

// --- modeline -----------------------------------------------------------

const nameEl = document.getElementById('modeline-name');
const positionEl = document.getElementById('modeline-position');

function updateModeline() {
  // In server-mode the modeline is driven by the server's VIEW message (the
  // G2 chrome paints nameEl/positionEl from the spine's renderModeline); the
  // in-renderer editor is idle behind the overlay, so its modeline must stand
  // down or it would fight the server's. Flag-off this guard is never taken.
  if (window.host && window.host.serverMode) return;
  const shown = views[currentViewIndex];
  // A placeholder chooser pane shows its label and no count — never a
  // `9/7`-style index (it isn't part of the user-visible view list).
  if (isPlaceholderView(shown)) {
    const label = shown.name || '(choose a view)';
    nameEl.textContent = label;
    positionEl.textContent = '';
    document.title = `${label} — Godot`;
    return;
  }
  // The user-visible count excludes placeholders, and the index is the
  // current view's position among the *real* views (so a split that
  // dropped a placeholder doesn't push the count past the list — the
  // `9/7` hazard). Falls back to no count when only one real view.
  const realViews = views.filter((v) => !isPlaceholderView(v));
  const realIndex = shown ? realViews.indexOf(shown) : -1;
  const count =
    realViews.length > 1 && realIndex >= 0
      ? `  ${realIndex + 1}/${realViews.length}`
      : '';
  // A non-text view (image, doc, shell, customize, ...) has no point
  // and no mode — show just the view name.
  if (shown && shown.kind !== 'text') {
    nameEl.textContent = shown.name + count;
    positionEl.textContent = '';
    document.title = `${shown.name} — Godot`;
    return;
  }
  const buffer = currentTextBuffer;
  const mark = dirtyBuffers.has(buffer) ? '● ' : '';
  const mode = keymapReady
    ? `   ${interpreter.call('major-mode-name')}` +
      interpreter.call('minor-mode-line')
    : '';
  // The snippet indicator (e.g. "[snippet: 2/4]") appears while a snippet
  // is being navigated; the Lisp getter returns "" when none is active.
  const snippet = keymapReady
    ? interpreter.call('snippet-modeline-indicator')
    : '';
  const snippetTag = snippet ? `   ${snippet}` : '';
  nameEl.textContent = mark + buffer.name + mode + snippetTag + count;
  const { line, column } = buffer.positionAt(buffer.point);
  positionEl.textContent = `Ln ${line + 1}, Col ${column + 1}`;
  // Reflect the current view in the OS window title.
  document.title = `${mark}${buffer.name} — Godot`;
}

/** Make BUFFER the current text buffer AND re-point the dirty / autosave
 *  watch at it. Every path that changes which buffer is current must go
 *  through this, not a bare `currentTextBuffer = …` assignment —
 *  otherwise edits to the newly-current buffer go unwatched: no dirty
 *  mark, no autosave snapshot, and the quit guard sees nothing to
 *  confirm. (The bug the focus / pane-switch / session-install paths had:
 *  they updated `currentTextBuffer` without re-subscribing the watch, so
 *  editing after a focus change or session restore silently lost the
 *  unsaved-changes signal.) */
function setCurrentTextBuffer(buffer) {
  currentTextBuffer = buffer;
  watchCurrentBuffer();
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
      // Dirty only while the text differs from the saved baseline, so
      // undoing every edit back to the saved state clears the flag (and
      // drops the now-pointless recovery snapshot).
      if (bufferMatchesSaved(buffer)) {
        dirtyBuffers.delete(buffer);
        recovery.forget(buffer);
      } else {
        dirtyBuffers.add(buffer);
        recovery.save();
      }
      dismissSplash();
      // Keep the Markdown preview pane in step with the buffer.
      refreshMarkdownPreview();
      // While a snippet is active, reflow the active field's extent and
      // the trailing offsets after each edit. A no-op when no snippet is
      // active (guarded in Lisp).
      if (keymapReady) {
        try {
          interpreter.call('snippet-after-edit!');
        } catch {
          // A reflow error must not break editing; the snippet simply
          // stops tracking. Surfaced lazily on the next command.
        }
      }
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
 *  mountKindView are wired up — at construction the leaf points to
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

/** Live handle for an active add-pane overlay (the visual macro that
 *  highlights splitters + outer borders). `null` when the mode is off.
 *  Re-entering the chord toggles it; a successful click or Escape
 *  clears it via the `exit` shim installed at entry. */
let addPaneHandle = null;

/** Live handle for an active move-views overlay (swap-views /
 *  permute-views), or `null` when off. Same toggle/clear lifecycle as
 *  `addPaneHandle`. */
let moveViewHandle = null;


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
  // Keep the splitter handles aligned with their split-node edges.
  // Phase 3a — refreshSplitterHandles is a no-op on a one-leaf tree
  // (computeSplitterEdges returns no entries).
  refreshSplitterHandles();
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

// Module state read by the pane-focus machinery below. These are hoisted
// here because the initial focus paint (further down) calls into
// `refreshPaneFocusIndicators` / `isNoFocusPane`, which read `keymapReady`
// and `activeProjectPath` — declaring those at their original (much later)
// positions left them in the temporal dead zone at first paint, throwing a
// ReferenceError that aborted the whole boot. They are reassigned later
// where they're used (stdlib-load sets keymapReady; openProject sets the
// project pointers).
let keymapReady = false;
/** Absolute root of the open project, or null when in the home session. */
let activeProjectPath = null;
/** The per-project session controller while a project is open, else null. */
let projectSession = null;

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

/** The `*pane-focus-border*` setting ('auto | 'on | 'off), read from Lisp
 *  on demand. Falls back to 'auto before the stdlib is loaded, or if the
 *  read fails. */
function paneFocusBorderMode() {
  if (!keymapReady) return 'auto';
  try {
    return symbolNameOf(interpreter.call('pane-focus-border-setting')) || 'auto';
  } catch {
    return 'auto';
  }
}

/** How many panes are focusable — the 'auto focus-border mode draws the
 *  border only when this is > 1 (a lone editing surface needs no marker). */
function countFocusablePanes() {
  return leafPanes(rootPane).filter((l) => !isNoFocusPane(l.id)).length;
}

/** Apply the `.pane--focused` CSS class to the focused leaf's div and
 *  remove it from every other pane. Called whenever `currentPaneId`
 *  changes. Honours `*pane-focus-border*`: in 'auto, the border is hidden
 *  when there's only one focusable pane (e.g. a project, where the
 *  sidebars are passive and the tabline always has focus). */
function refreshPaneFocusIndicators() {
  const drawBorder = shouldDrawFocusBorder(
    paneFocusBorderMode(),
    countFocusablePanes()
  );
  for (const [id, el] of paneElements) {
    el.classList.toggle('pane--focused', drawBorder && id === currentPaneId);
  }
}

/** Set the current pane to the leaf whose div the user pressed in, if
 *  any. Both `mousedown` and `click` are wired up: a press on the
 *  editor content re-renders the line elements (the press target gets
 *  detached), which suppresses the subsequent `click` event entirely —
 *  so without the mousedown branch a click inside an editor *placed*
 *  the cursor in that pane but never moved focus to it.
 *
 *  Runs on the bubble (no capture), doesn't preventDefault, and doesn't
 *  stop propagation — content inside the pane (the editor's
 *  cursor-positioning click, xterm.js's selection drag, image-view's
 *  pan/zoom, every renderer view) has already had its turn by the time
 *  this runs. */
function focusPaneFromEvent(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  // Splitter handles aren't panes — pressing one focuses nothing.
  if (target.closest('.pane-splitter')) return;
  // A :no-focus element-view (e.g. bib-search, server mode) must not steal pane
  // focus — it acts on the active document, which keeps focus. (The clicked
  // input still takes DOM focus normally; only the server pane-focus is held.)
  if (target.closest('element-view[data-no-focus="true"]')) return;
  const paneEl = target.closest('.pane');
  if (!paneEl) return;
  const paneId = paneEl.dataset.paneId;
  if (typeof paneId !== 'string' || paneId === currentPaneId) return;
  setCurrentPaneId(paneId);
  // G4 Step 3: in server mode the SERVER owns the focused leaf, so a click must
  // also move focus there — else a server-side command (C-x 3 split, find-file)
  // acts on the server's stale focus, not the pane the user just clicked. The
  // server re-pushes PANE_TREE, which the reconcile reflects. (paneId is the
  // server's leaf id — buildServerPaneNode reuses it; a non-matching id, e.g. a
  // window-1 tabline pane, is a harmless no-op server-side.)
  if (serverViewClient && typeof serverViewClient.sendPaneIntent === 'function') {
    serverViewClient.sendPaneIntent({ op: 'focus-pane', paneId });
  }
}
// Capture-phase listeners: run *before* the click target's own handlers
// fire. A tabline-tab's mousedown handler rebuilds the strip (replaces
// its children to update is-current), which detaches the tab element
// from the DOM mid-event. Bubble-phase focus would then see
// `target.closest('.pane') === null` and never run setCurrentPaneId,
// leaving the wrong pane focused.
editorHostEl.addEventListener('mousedown', focusPaneFromEvent, true);
editorHostEl.addEventListener('click', focusPaneFromEvent, true);

/** Per-pane focusability set from Lisp (`set-pane-focusable!`): leaf id →
 *  boolean (true = focusable, false = not). An explicit entry overrides
 *  the defaults below. Lets users design custom UIs (passive sidebars,
 *  etc.) without persisting across restart (re-derived for projects). */
const paneFocusOverride = new Map();

/** View kinds that are passive sidebars when shown in a project: like
 *  Nova's, they don't become the active pane (so focus stays in the
 *  editing tabline). The minimap / bib-search opt out via `view.noFocus`
 *  instead; these are kinds that are normally focusable on their own but
 *  passive inside a project. */
const PROJECT_SIDEBAR_KINDS = new Set([
  'directory-tree',
  'directory-columns',
  'bookmark',
]);

/** True when pane PANEID is non-focusable — it never becomes the active
 *  pane (clicking still works; the view acts on the active pane). Sources,
 *  in priority order: an explicit `set-pane-focusable!` override; a view
 *  that opted out of focus (`:no-focus` — the minimap, bib-search); or, in
 *  a project, a passive sidebar kind (the tree / bookmark, so focus stays
 *  in the middle tabline like a normal Nova window). Peels a tabline to the
 *  visible child. */
function isNoFocusPane(paneId) {
  const override = paneFocusOverride.get(paneId);
  if (override !== undefined) return override === false;
  const leaf = leafPanes(rootPane).find((l) => l.id === paneId);
  if (!leaf) return false;
  const view = peelTabline(leaf.view);
  if (view && view.noFocus) return true;
  if (
    activeProjectPath !== null &&
    view &&
    PROJECT_SIDEBAR_KINDS.has(view.kind)
  ) {
    return true;
  }
  return false;
}

/** Set the currently-focused pane id and refresh derived state:
 *  the focus indicator, the cursor binding for the new focused
 *  text view's buffer, the `editorView` pointer the legacy callsites
 *  use, the modeline, and `currentViewIndex` (so view-list cycling
 *  treats the focused pane's view as "current"). With two views over
 *  one buffer (Q9 auto-duplicate), the bindCursor rebind here is
 *  what gives the active view its own cursor on focus change. */
function setCurrentPaneId(nextId) {
  if (typeof nextId !== 'string' || nextId === currentPaneId) return;
  // `:no-focus` views never become the active pane — every focus path
  // (click, C-x o, restore) routes through here, so the guard is central.
  if (isNoFocusPane(nextId)) return;
  currentPaneId = nextId;
  refreshPaneFocusIndicators();
  const leaf = leafPanes(rootPane).find((l) => l.id === currentPaneId);
  if (!leaf) return;
  // Phase 3b: a leaf may now hold a tabline-view containing the actual
  // editable view as its active child. Peel through for cursor binding
  // / modeline / currentViewIndex sync; the tabline-view itself isn't
  // in `views`, doesn't carry a buffer, and isn't what `(current-view)`
  // resolves to.
  const peeled = peelTabline(leaf.view);
  const view = isTablineView(peeled) ? null : peeled;
  if (view) {
    // Sync currentViewIndex so view-list cycling and the modeline
    // reflect the focused pane's view. This is index-based on `views`
    // so we look it up rather than mutating from the click handler.
    const idx = views.indexOf(view);
    if (idx >= 0) currentViewIndex = idx;
    if (view.kind === 'text' && view.buffer) {
      // Rebind the buffer's cursor source to this view, so a buffer
      // shared between panes serves each view its own point/mark.
      if (typeof view.buffer.bindCursor === 'function') {
        view.buffer.bindCursor(view);
      }
      setCurrentTextBuffer(view.buffer);
    }
    // Re-point the legacy `editorView` pointer at the focused leaf's
    // instance. Sticky-notes, hover-doc and inline-eval keep their
    // bindings to the *original* instance — that's an acknowledged
    // 3a limitation (they were captured at startup and don't follow
    // focus). Text editing commands routed via the buffer keep working
    // through the bindCursor path above.
    const instance = editorViewByPaneId.get(currentPaneId);
    if (instance) {
      editorView = instance;
    }
  }
  updateModeline();
}

// Paint the initial focus indicator. With one pane this just adds the
// class to the only leaf.
refreshPaneFocusIndicators();

// --- pane splits + navigation (phase 3a) -------------------------------
//
// The host-side implementation of split-horizontal! / split-vertical! /
// delete-pane! / delete-other-panes! / other-pane / focus-pane-direction!
// / balance-panes! / set-split-ratio! — invoked from `paneHost` above.
//
// Tree mutations go through `replacePane` (structural sharing); the
// focus pane id, the editor-view instance map, and the splitter handle
// divs follow.

/** Build the placeholder view a freshly-split pane gets. The split no
 *  longer silently auto-clones the originating view (the old
 *  `buildDuplicateViewForSplit` — the root of the "four copies in the
 *  View List" bug); instead the new pane shows a chooser that asks the
 *  user what it should hold. The originating view is remembered on
 *  `previousView` so the chooser's *clone* action can reproduce it.
 *
 *  The placeholder is pushed to `views` (transient — it keeps
 *  currentViewIndex / the modeline valid) but is excluded from the View
 *  List and the cycling ring, and is spliced out the instant it is
 *  filled (`replacePlaceholder`) or its pane is closed.
 *
 *  Phase 3b: when the source leaf holds a tabline-view, peel through to
 *  its active child so *clone* reproduces the visible view rather than
 *  the tabline wrapper. */
function buildPlaceholderForSplit(originalView) {
  const peeled = peelTabline(originalView);
  const origin = peeled && !isTablineView(peeled) ? peeled : originalView;
  const placeholder = createView({
    kind: 'placeholder',
    name: '(choose a view)',
    extras: { previousView: origin ?? null },
  });
  views.push(placeholder);
  notifyViewsChanged();
  return placeholder;
}

/** A fresh `*scratch*` text view — the clone fallback and the `s` action. */
function freshScratchView() {
  return createView({
    kind: 'text',
    buffer: createBuffer('', { name: '*scratch*' }),
  });
}

/** Clone the originating view ORIGINVIEW as a *new instance at the same
 *  target* (plans/PANES-PLACEHOLDER.md's clone table). Returns a fresh
 *  view object NOT yet in `views` — `replacePlaceholder` pushes it. The
 *  per-kind decision is the pure `cloneTargetForKind`; the host turns
 *  the tag into a concrete `createView`. */
function cloneViewForPlaceholder(originView) {
  if (!originView) return freshScratchView();
  switch (cloneTargetForKind(originView.kind)) {
    case 'same-buffer':
      // Text: a new view over the same buffer, fresh point, mark cleared
      // (Q2/Q9 — independent cursor; today's text duplicate semantics).
      if (originView.buffer) {
        return createView({
          kind: 'text',
          buffer: originView.buffer,
          point: typeof originView.point === 'number' ? originView.point : 0,
        });
      }
      return freshScratchView();
    case 'same-url':
      // Browser: a new browser at the same URL.
      return createView({
        kind: 'browser',
        name: originView.name ?? originView.url ?? 'about:blank',
        extras: {
          url:
            typeof originView.url === 'string' && originView.url !== ''
              ? originView.url
              : 'about:blank',
        },
      });
    case 'same-file': {
      // pdf / image / audio / video: a new view of the same file. The
      // origin already carries `filePath` / `src` (and audio's metadata /
      // art) on its own fields — reproduce them on a fresh instance.
      const extras = { filePath: originView.filePath, src: originView.src };
      if (originView.metadata) extras.metadata = originView.metadata;
      if (originView.albumArtSrc) extras.albumArtSrc = originView.albumArtSrc;
      return createView({
        kind: originView.kind,
        name: originView.name ?? null,
        extras,
      });
    }
    case 'fresh':
      // Session-bearing kinds: a fresh instance (a pty's scrollback etc.
      // can't be cloned — "same target" means a new session/root).
      if (originView.kind === 'shell') {
        const sessionId = nextShellSessionId();
        const seq = views.filter((v) => v.kind === 'shell').length + 1;
        return createView({
          kind: 'shell',
          name: seq === 1 ? '*shell*' : `*shell*<${seq}>`,
          extras: { sessionId, transcript: [], ended: false, spawned: false },
        });
      }
      if (originView.kind === 'gnuplot') {
        const sessionId = nextGnuplotSessionId();
        const seq = views.filter((v) => v.kind === 'gnuplot').length + 1;
        return createView({
          kind: 'gnuplot',
          name: seq === 1 ? '*gnuplot*' : `*gnuplot*<${seq}>`,
          extras: { sessionId, ended: false, spawned: false },
        });
      }
      if (originView.kind === 'notebook') {
        const notebookId = nextNotebookId();
        const seq = views.filter((v) => v.kind === 'notebook').length + 1;
        const name = seq === 1 ? '*notebook*' : `*notebook*<${seq}>`;
        return createView({
          kind: 'notebook',
          name,
          buffer: { text: '', filePath: null, name },
          extras: { notebookId },
        });
      }
      // directory-tree / directory-columns: a fresh view at the same
      // root. Build a NEW instance directly (not the ensure-helpers,
      // which reuse an existing view for a path — that would put one
      // View object in two panes, the Q9 violation the placeholder
      // exists to avoid). A blank root falls through to scratch.
      if (originView.kind === 'directory-tree' && typeof originView.rootPath === 'string' && originView.rootPath !== '') {
        const segments = originView.rootPath.split('/');
        const tail = segments[segments.length - 1] || originView.rootPath;
        return createView({
          kind: 'directory-tree',
          name: `*Tree: ${tail}*`,
          extras: { rootPath: originView.rootPath, expanded: new Set() },
        });
      }
      if (originView.kind === 'directory-columns' && typeof originView.rootPath === 'string' && originView.rootPath !== '') {
        const segments = originView.rootPath.split('/');
        const tail = segments[segments.length - 1] || originView.rootPath;
        return createView({
          kind: 'directory-columns',
          name: `*Columns: ${tail}*`,
          extras: {
            rootPath: originView.rootPath,
            columns: [{ path: originView.rootPath, selected: null }],
            previewPath: null,
          },
        });
      }
      return freshScratchView();
    case 'scratch':
    default:
      return freshScratchView();
  }
}

/** Replace the placeholder in LEAF with NEWVIEW, leaving no residue:
 *  the placeholder is spliced out of `views`, its element disposed, and
 *  currentViewIndex re-pointed at NEWVIEW. The leaf becomes leaf-direct
 *  on NEWVIEW and the new view is mounted + focused. */
function replacePlaceholder(leaf, newView) {
  if (!leaf || leaf.kind !== 'leaf' || !newView) return;
  const placeholder = leaf.view;
  // Put the new view in the leaf and the global list before tearing the
  // placeholder down, so the splice + index fix-up below see a coherent
  // state.
  leaf.view = newView;
  if (!views.includes(newView)) views.push(newView);
  // Splice the placeholder out of `views` (no residue). Its element is
  // disposed via disposeKindView.
  splicePlaceholderFromViews(placeholder);
  // Build the new view's renderer + focus it. For a leaf-direct text
  // view, ensure its editor instance exists first.
  if (newView.kind === 'text') ensureEditorViewForLeaf(leaf);
  // currentPaneId is already this leaf (the placeholder pane was
  // focused); re-sync currentViewIndex to the new view and mount it.
  setCurrentPaneId(leaf.id);
  currentViewIndex = views.indexOf(newView);
  hideInactiveRendererViews(newView.kind);
  mountKindView(newView);
  refreshPaneFocusIndicators();
  scheduleRelayout();
  updateModeline();
  notifyViewsChanged();
}

/** Remove PLACEHOLDER from `views` and dispose its element, fixing
 *  currentViewIndex so it never outlives the splice (the 9/7 hazard).
 *  No-op when PLACEHOLDER isn't a placeholder or isn't in `views`. */
function splicePlaceholderFromViews(placeholder) {
  if (!isPlaceholderView(placeholder)) return;
  const idx = views.indexOf(placeholder);
  if (idx < 0) {
    disposePlaceholderElementForView(placeholder);
    return;
  }
  views.splice(idx, 1);
  disposePlaceholderElementForView(placeholder);
  // Keep currentViewIndex valid relative to the splice.
  if (currentViewIndex > idx) {
    currentViewIndex -= 1;
  } else if (currentViewIndex === idx) {
    currentViewIndex = Math.min(currentViewIndex, views.length - 1);
  }
}

/** The `o` action: find-file into the placeholder's pane. The chosen
 *  file opens in the focused pane (this one); afterwards the placeholder
 *  is spliced out. */
function fillPlaceholderViaOpen(leaf) {
  const placeholder = leaf.view;
  // openFileInteractive is async and lands the file in the focused pane
  // (which is this placeholder leaf). It replaces `leaf.view` through
  // switchToViewIndex's plain-leaf branch, orphaning the placeholder in
  // `views`. Splice it out once the open settles — whether or not a file
  // was actually chosen, if the leaf no longer shows the placeholder.
  const after = () => {
    if (leaf.view !== placeholder) splicePlaceholderFromViews(placeholder);
  };
  openFileInteractive().then(after, after);
}

/** The `r` action: run the typed command in the placeholder's pane. The
 *  focused pane is this one, so a view-opening command (e.g. `gnuplot`)
 *  lands here. Afterwards the placeholder is spliced out. */
function fillPlaceholderViaCommand(leaf, text) {
  const placeholder = leaf.view;
  try {
    interpreter.evaluate(`(run-command (quote ${text}))`);
  } catch (error) {
    repl.appendError(formatLispError(error));
  }
  // A view-opening command replaced `leaf.view` via switchToViewIndex;
  // a non-view command (or a failure) leaves the placeholder in place.
  if (leaf.view !== placeholder) splicePlaceholderFromViews(placeholder);
}

/** Split TARGET (a leaf) and put a GIVEN view into the new sibling
 *  leaf — the programmatic counterpart to the placeholder-showing
 *  `splitPaneAtLeaf`. TARGET is replaced with a split node; a freshly-
 *  created leaf holding VIEW is its sibling. With SIDE = `'after'`
 *  (default) the new leaf is the *second* child (right of / below the
 *  original); with SIDE = `'before'` it is the *first* child (left of /
 *  above the original). The originating leaf's id is preserved across
 *  the replacement so its editor-view bindings don't churn.
 *
 *  VIEW must already be a real view (in `views`); this function does NOT
 *  push it — the caller (e.g. `splitAndOpenFile`, or `splitPaneAtLeaf`
 *  with a freshly-built placeholder) owns that. There is no placeholder
 *  and no chooser: the new pane is filled directly, leaving no orphaned-
 *  view residue.
 *
 *  Focus MOVES to the new pane and its element is mounted + focused so
 *  its accelerator keys are live. Returns `{ first, second }`. */
function splitPaneAtLeafWith(targetLeaf, orientation, ratio, side, view) {
  if (!targetLeaf || targetLeaf.kind !== 'leaf') return null;
  if (
    orientation !== SPLIT_HORIZONTAL &&
    orientation !== SPLIT_VERTICAL
  ) return null;
  if (side !== 'after' && side !== 'before') return null;
  if (!view) return null;
  const newLeaf = createLeafPane({ view });
  // Ratio interpretation: it always describes the *first* child's
  // share. With SIDE='before' the new leaf is first, so the supplied
  // ratio applies to it directly. With SIDE='after' the originating
  // leaf is first; same interpretation. No flip needed at this layer.
  const first = side === 'before' ? newLeaf : targetLeaf;
  const second = side === 'before' ? targetLeaf : newLeaf;
  const split = createSplitPane({
    orientation,
    ratio,
    first,
    second,
  });
  rootPane = replacePane(rootPane, targetLeaf, split);
  syncPaneElements();
  // For a leaf-direct text view, ensure its editor instance exists
  // before mounting (the placeholder path skips this — placeholders are
  // never text).
  if (view.kind === 'text') ensureEditorViewForLeaf(newLeaf);
  // Focus moves to the new pane and its element is mounted + focused so
  // its accelerator keys are live. setCurrentPaneId syncs
  // currentViewIndex to VIEW; mountKindView builds the element.
  setCurrentPaneId(newLeaf.id);
  hideInactiveRendererViews(view.kind);
  mountKindView(view);
  refreshPaneFocusIndicators();
  refreshSplitterHandles();
  scheduleRelayout();
  return { first, second };
}

/** Open VIEW (a `:no-focus` helper panel — bib-search, a HUD, …) in a new
 *  split beside the focused pane, WITHOUT moving the editing focus or
 *  touching the document's visibility. Unlike `splitPaneAtLeafWith` this
 *  deliberately skips `setCurrentPaneId` (the panel is :no-focus, so the
 *  document keeps Godot's currentView) and `hideInactiveRendererViews`
 *  (which would blank the still-focused document's leaf-direct text-view —
 *  the VIEWS.md hazard). The panel mounts to the document's right; the
 *  document keeps its DOM focus too (we don't focus the panel). */
function openNoFocusViewInSplit(view) {
  const focused = currentPane();
  if (!focused || focused.kind !== 'leaf') {
    // No leaf to split against (e.g. a bare tabline root) — fall back to a
    // plain switch so the panel at least opens somewhere.
    const idx = views.indexOf(view);
    if (idx >= 0) switchToViewIndex(idx);
    return;
  }
  const targetLeaf = focused;
  const newLeaf = createLeafPane({ view });
  // Side-by-side: the document (first child) keeps the larger share; the
  // panel (second child) sits narrower on the right.
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.64,
    first: targetLeaf,
    second: newLeaf,
  });
  rootPane = replacePane(rootPane, targetLeaf, split);
  syncPaneElements();
  // Mount the panel's element in its new pane — but do NOT focus it, so the
  // document keeps DOM focus (currentPaneId is untouched → currentView too).
  const paneEl = paneElements.get(newLeaf.id);
  const el = ensureElementHostForView(view, paneEl);
  if (el) el.style.display = '';
  refreshPaneFocusIndicators();
  refreshSplitterHandles();
  scheduleRelayout();
}

/** Common implementation of split-horizontal! / split-vertical!.
 *  Replaces TARGET (a leaf) with a split node; a freshly-created leaf
 *  is its sibling, holding a *placeholder* chooser. With SIDE =
 *  `'after'` (default) the new leaf is the *second* child (right of /
 *  below the original); with SIDE = `'before'` it is the *first* child
 *  (left of / above the original). The originating leaf's id is
 *  preserved across the replacement so its editor-view bindings don't
 *  churn.
 *
 *  Focus MOVES to the new placeholder pane (a deliberate change from
 *  the old "originating pane keeps focus" contract — the user is now
 *  asked what the new pane should hold, so the keyboard belongs there).
 *  Returns `{ first, second }`.
 *
 *  This is the user-facing split (the keyboard `split-*!` primitives and
 *  the paneHost split methods route through it). The programmatic
 *  fill-a-pane-directly variant is `splitPaneAtLeafWith`. */
function splitPaneAtLeaf(targetLeaf, orientation, ratio, side = 'after') {
  if (!targetLeaf || targetLeaf.kind !== 'leaf') return null;
  if (
    orientation !== SPLIT_HORIZONTAL &&
    orientation !== SPLIT_VERTICAL
  ) return null;
  if (side !== 'after' && side !== 'before') return null;
  const placeholder = buildPlaceholderForSplit(targetLeaf.view);
  return splitPaneAtLeafWith(targetLeaf, orientation, ratio, side, placeholder);
}

/** The bare name of a Lisp symbol/keyword/string argument (a Sym and a
 *  Keyword both carry a `.name`), with any leading `:` stripped, or null
 *  when ARG isn't symbol-like. Mirrors pane-primitives' `sideFromArg` /
 *  `coerceEdge` coercion so `open-file-in-split!` reads its
 *  orientation/side args the same way the split primitives read theirs. */
function symbolNameOf(arg) {
  let name = null;
  if (typeof arg === 'string') name = arg;
  else if (arg && typeof arg === 'object' && typeof arg.name === 'string') {
    name = arg.name;
  }
  if (name === null) return null;
  return name.startsWith(':') ? name.slice(1) : name;
}

/** Programmatically split the focused pane and open FILEPATH directly in
 *  the new sibling pane — no placeholder, no chooser. The split runs at
 *  an even 0.5 ratio; ORIENTATION is `SPLIT_HORIZONTAL` / `SPLIT_VERTICAL`
 *  and SIDE is `'after'` (default) / `'before'`. When PERSIST is true the
 *  opened view is flagged session-persistent (the latex-output PDF case);
 *  this is applied atomically with the open so a Lisp caller needn't race
 *  the async open to find the handle. Focus moves to the new pane
 *  (consistent with `splitPaneAtLeaf`). Returns the opened view, or null
 *  on failure (unreadable path, no focused leaf, unrecognised
 *  orientation). This is the programmatic counterpart to the user-facing
 *  `split-*!` primitives — callers that want a pane filled straight away
 *  (latex-view's source|PDF) use this instead of split-then-open, which
 *  would strand a placeholder. */
async function splitAndOpenFile(filePath, orientation, side = 'after', persist = false) {
  const target = currentPane();
  if (!target || target.kind !== 'leaf') return null;
  // Split with a placeholder; splitPaneAtLeaf moves focus to the new pane.
  // Then open FILEPATH into that focused pane through the *normal* open
  // path — switchToViewIndex replaces the placeholder with the file's view,
  // the proven `fillPlaceholderViaOpen` mechanism the `o` action uses. (A
  // bespoke mount via splitPaneAtLeafWith mis-rendered PDFs and didn't
  // honour {switch:false}, switching the source pane to the PDF instead.)
  const split = splitPaneAtLeaf(target, orientation, 0.5, side);
  if (!split) return null;
  const newLeaf = side === 'before' ? split.first : split.second;
  const placeholder = newLeaf.view;
  // forceDuplicate: a fresh View even if the file is already open elsewhere
  // (Q9). The open lands in the focused (new) leaf, replacing its placeholder.
  await openFileByPath(filePath, { forceDuplicate: true });
  // Splice the orphaned placeholder out of `views` — no residue.
  if (newLeaf.view !== placeholder) splicePlaceholderFromViews(placeholder);
  const view = newLeaf.view;
  if (view && persist === true && view.kind === 'pdf') {
    view.persist = true;
    activeSession().save();
  }
  return view;
}

/** Insert a fresh leaf "in the gap" of the split node with id SPLIT_ID.
 *  The new leaf gets a *placeholder* chooser (remembering the focused
 *  view as the clone origin) and becomes the focused pane. Returns the
 *  inserted leaf, or `null` when the split id isn't in the tree. */
function addPaneAtSplitterId(splitId) {
  if (typeof splitId !== 'string') return null;
  const splitNode = findPaneById(rootPane, splitId);
  if (!splitNode || splitNode.kind !== 'split') return null;
  const sourceView =
    (currentPane()?.view) ?? views[currentViewIndex] ?? null;
  const placeholder = buildPlaceholderForSplit(sourceView);
  const newLeaf = createLeafPane({ view: placeholder });
  rootPane = insertAtSplit(rootPane, splitNode, newLeaf);
  syncPaneElements();
  setCurrentPaneId(newLeaf.id);
  hideInactiveRendererViews(placeholder.kind);
  mountKindView(placeholder);
  refreshPaneFocusIndicators();
  refreshSplitterHandles();
  scheduleRelayout();
  return newLeaf;
}

/** Insert a fresh leaf at SIDE of the root pane (`'top'`/`'bottom'`/
 *  `'left'`/`'right'`). Wraps the whole existing tree in a new outer
 *  split, with the fresh leaf on that side. Returns the inserted leaf
 *  or `null` for an unrecognised side. */
function addPaneAtRootBorder(side) {
  if (
    side !== 'top' && side !== 'bottom' &&
    side !== 'left' && side !== 'right'
  ) {
    return null;
  }
  const sourceView =
    (currentPane()?.view) ?? views[currentViewIndex] ?? null;
  const placeholder = buildPlaceholderForSplit(sourceView);
  const newLeaf = createLeafPane({ view: placeholder });
  rootPane = insertAtRootBorder(rootPane, side, newLeaf);
  syncPaneElements();
  setCurrentPaneId(newLeaf.id);
  hideInactiveRendererViews(placeholder.kind);
  mountKindView(placeholder);
  refreshPaneFocusIndicators();
  refreshSplitterHandles();
  scheduleRelayout();
  return newLeaf;
}

/** Implementation of `delete-pane!`. Collapses TARGET's parent split
 *  into TARGET's sibling, drops a layer of the tree. No-op when TARGET
 *  is the root (the only pane in the window). */
function deletePaneInTree(targetLeaf) {
  if (!targetLeaf || targetLeaf.kind !== 'leaf') return;
  const parent = parentOf(rootPane, targetLeaf);
  if (!parent) {
    // TARGET is the root — there's no parent split to collapse. The
    // editor area always has at least one pane; no-op.
    return;
  }
  const sibling = siblingOf(rootPane, targetLeaf);
  if (!sibling) return;
  // Dispose the editor-view instance bound to the deleted leaf (text
  // leaves only). Non-text views' singletons stay alive — they may
  // outlive the pane they were originally mounted in.
  disposeEditorViewForLeaf(targetLeaf);
  // A placeholder pane closed without being filled leaves no residue:
  // splice its transient view out of `views` (and dispose its element).
  // Do this before the tree mutation so the index fix-up sees the
  // current `currentViewIndex`.
  if (isPlaceholderView(targetLeaf.view)) {
    splicePlaceholderFromViews(targetLeaf.view);
  }
  rootPane = replacePane(rootPane, parent, sibling);
  syncPaneElements();
  // Focus follows: if the deleted leaf held focus, the sibling's first
  // leaf takes over. Otherwise the existing focus survives.
  if (currentPaneId === targetLeaf.id) {
    const leaves = leafPanes(sibling);
    if (leaves.length > 0) {
      const next = leaves[0];
      currentPaneId = next.id;
      const view = next.view;
      if (view) {
        const idx = views.indexOf(view);
        if (idx >= 0) currentViewIndex = idx;
        if (view.kind === 'text' && view.buffer) {
          if (typeof view.buffer.bindCursor === 'function') {
            view.buffer.bindCursor(view);
          }
          setCurrentTextBuffer(view.buffer);
        }
        const instance = editorViewByPaneId.get(next.id);
        if (instance) editorView = instance;
        // Re-run the mount for the surviving pane's view so its
        // renderer is correctly displayed.
        hideInactiveRendererViews(view.kind);
        mountKindView(view);
      }
    }
  }
  refreshPaneFocusIndicators();
  refreshSplitterHandles();
  scheduleRelayout();
  updateModeline();
  // If the removed leaf was a minimap's target, the reconcile drops the now
  // orphaned minimap; otherwise it just rebinds survivors. Deferred, so it
  // runs after this deletion's tree surgery is complete.
  scheduleMinimapReconcile();
}

/** Implementation of `delete-other-panes!`. Makes TARGET fill the
 *  whole editor area, disposing every other leaf's editor-view
 *  instance (text leaves only). */
function deleteOtherPanesInTree(targetLeaf) {
  if (!targetLeaf || targetLeaf.kind !== 'leaf') return;
  if (rootPane === targetLeaf) return;
  // Dispose every editor-view instance for leaves that are about to
  // disappear (text leaves only — non-text singletons aren't per-pane).
  // A placeholder pane among them leaves no residue: splice it out.
  for (const leaf of leafPanes(rootPane)) {
    if (leaf === targetLeaf) continue;
    disposeEditorViewForLeaf(leaf);
    if (isPlaceholderView(leaf.view)) splicePlaceholderFromViews(leaf.view);
  }
  rootPane = targetLeaf;
  syncPaneElements();
  if (currentPaneId !== targetLeaf.id) {
    currentPaneId = targetLeaf.id;
    const view = targetLeaf.view;
    if (view) {
      const idx = views.indexOf(view);
      if (idx >= 0) currentViewIndex = idx;
      if (view.kind === 'text' && view.buffer) {
        if (typeof view.buffer.bindCursor === 'function') {
          view.buffer.bindCursor(view);
        }
        setCurrentTextBuffer(view.buffer);
      }
      const instance = editorViewByPaneId.get(targetLeaf.id);
      if (instance) editorView = instance;
    }
  }
  refreshPaneFocusIndicators();
  refreshSplitterHandles();
  scheduleRelayout();
  updateModeline();
}

/** Set of every leaf-kind view that is currently *visible* in some
 *  pane other than EXCLUDE. "Visible" means: the active child of a
 *  tabline-view, or the direct view of a plain leaf. Hidden tabs
 *  (inactive children of a tabline-view) are *not* visible. Used by
 *  the C-x b picker (Q4) so it can drop candidates that are already
 *  showing on screen elsewhere.
 *
 *  A nested tabline-view's active child is also collected (nested
 *  tablines, Q10).
 *
 *  @param {*} exclude - The pane to skip (typically the focused pane).
 *  @returns {Set<import('@editor/view').View>}
 */
function viewsVisibleInOtherPanes(exclude) {
  const visible = new Set();
  for (const leaf of leafPanes(rootPane)) {
    if (leaf === exclude) continue;
    let v = leaf.view;
    while (v && isTablineView(v)) {
      const child = tablineActiveChild(v);
      if (!child) break;
      visible.add(child);
      v = child; // walk through nested tablines
    }
    if (v && !isTablineView(v)) visible.add(v);
  }
  return visible;
}

/** Cycle focus to the next leaf in display order (depth-first).
 *  Returns the new current pane handle. */
function focusNextPane() {
  const leaves = leafPanes(rootPane);
  if (leaves.length <= 1) return currentPane();
  const i = leaves.findIndex((l) => l.id === currentPaneId);
  const start = i < 0 ? 0 : i;
  // Cycle to the next *focusable* pane — skip passive sidebars (the tree /
  // bookmark in a project, the minimap, …) so C-x o stays among editing panes.
  for (let step = 1; step <= leaves.length; step += 1) {
    const cand = leaves[(start + step) % leaves.length];
    if (cand.id === currentPaneId) continue;
    if (isNoFocusPane(cand.id)) continue;
    setCurrentPaneId(cand.id);
    return cand;
  }
  return currentPane();
}

/** Focus a *specific* leaf pane by its handle (the absolute counterpart
 *  to `focusNextPane` / `focusPaneByDirection`, which move focus
 *  relatively). Used by features that already hold the pane they want
 *  focused — e.g. inverse SyncTeX, which focuses the pane showing the
 *  resolved source file instead of landing in whatever pane the PDF
 *  click stole focus to. Returns the focused leaf, or null when PANE
 *  isn't a leaf currently in the tree (a split node, a stale handle).
 *  Re-focusing the already-current pane is a no-op that still returns
 *  the leaf. */
function focusPaneHandle(pane) {
  if (!pane || typeof pane !== 'object' || pane.kind !== 'leaf') return null;
  const leaf = leafPanes(rootPane).find((l) => l.id === pane.id);
  if (!leaf) return null;
  setCurrentPaneId(leaf.id);
  return leaf;
}

/** Spatial pane navigation: focus the leaf adjacent to the current one
 *  in DIRECTION. Returns the new current pane handle, or null when
 *  there's no neighbour on that side. */
function focusPaneByDirection(direction) {
  const hostRect = editorHostEl.getBoundingClientRect();
  const rects = computeRects(rootPane, {
    width: hostRect.width,
    height: hostRect.height,
  });
  const targetId = paneInDirection(rects, currentPaneId, direction);
  if (targetId === null) return null;
  setCurrentPaneId(targetId);
  return leafPanes(rootPane).find((l) => l.id === targetId) ?? null;
}

/** Reset every split node's ratio to 0.5. The tree is structurally
 *  shared by the splits; the ratios are mutable fields on each node, so
 *  we walk and write in place. A relayout follows. */
function balancePanesInTree() {
  walkAndBalance(rootPane);
  refreshSplitterHandles();
  scheduleRelayout();
}

function walkAndBalance(node) {
  if (!node || node.kind !== 'split') return;
  node.ratio = 0.5;
  walkAndBalance(node.first);
  walkAndBalance(node.second);
}

/** Set a split node's ratio in place (the layout reads the live ratio
 *  each frame). RATIO is assumed already clamped by the caller. */
function setSplitRatioOnNode(splitNode, ratio) {
  if (!splitNode || splitNode.kind !== 'split') return;
  splitNode.ratio = ratio;
  refreshSplitterHandles();
  scheduleRelayout();
}

// --- splitter handle DOM + drag ----------------------------------------
//
// One thin div per split-node's interior edge. The handle's pointerdown
// captures, pointermove updates the split node's ratio, pointerup
// releases. Coalesced relayouts through scheduleRelayout().

/** Map from split-pane id to the splitter-handle <div>. Rebuilt on
 *  every tree change so stale ids drop out. */
const splitterHandlesById = new Map();

const SPLITTER_THICKNESS = 4;
const SPLITTER_MIN_RATIO = 0.05;
const SPLITTER_MAX_RATIO = 0.95;

function clampSplitterRatio(r) {
  if (typeof r !== 'number' || Number.isNaN(r)) return 0.5;
  if (r < SPLITTER_MIN_RATIO) return SPLITTER_MIN_RATIO;
  if (r > SPLITTER_MAX_RATIO) return SPLITTER_MAX_RATIO;
  return r;
}

/** Rebuild the splitter handles to match the current tree. Existing
 *  handles whose split id still appears are reused (so any in-flight
 *  pointer capture survives); stale ones are removed; new ones get a
 *  pointerdown listener that drives the drag. */
function refreshSplitterHandles() {
  const hostRect = editorHostEl.getBoundingClientRect();
  const edges = computeSplitterEdges(rootPane, {
    width: hostRect.width,
    height: hostRect.height,
  }, { thickness: SPLITTER_THICKNESS });
  const live = new Set(edges.map((e) => e.splitId));
  for (const [id, el] of splitterHandlesById) {
    if (!live.has(id)) {
      el.remove();
      splitterHandlesById.delete(id);
    }
  }
  for (const edge of edges) {
    let el = splitterHandlesById.get(edge.splitId);
    if (!el) {
      el = document.createElement('div');
      el.className = `pane-splitter pane-splitter--${edge.orientation}`;
      el.dataset.splitId = edge.splitId;
      attachSplitterDrag(el);
      editorHostEl.append(el);
      splitterHandlesById.set(edge.splitId, el);
    } else {
      // Orientation is fixed per split (the tree doesn't reshape on
      // resize) but defensively keep the class in sync.
      el.className = `pane-splitter pane-splitter--${edge.orientation}`;
    }
    el.style.left = `${edge.left}px`;
    el.style.top = `${edge.top}px`;
    el.style.width = `${edge.width}px`;
    el.style.height = `${edge.height}px`;
  }
}

/** Find a split node in the tree by id. The walk is O(n) in tree size;
 *  splits are rare so a Map cache isn't worth it. */
function findSplitById(node, id) {
  if (!node) return null;
  if (node.kind === 'split') {
    if (node.id === id) return node;
    return findSplitById(node.first, id) ?? findSplitById(node.second, id);
  }
  return null;
}

/** Wire pointer events on a splitter handle so dragging it updates the
 *  bordering split node's ratio. */
function attachSplitterDrag(handle) {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const splitId = handle.dataset.splitId;
    if (!splitId) return;
    const splitNode = findSplitById(rootPane, splitId);
    if (!splitNode) return;
    event.preventDefault();
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* setPointerCapture can throw mid-test; the drag still works
         through the document-level listeners below. */
    }
    handle.classList.add('pane-splitter--dragging');
    const hostRect = editorHostEl.getBoundingClientRect();
    const isHorizontal = splitNode.orientation === SPLIT_HORIZONTAL;
    // The split node's bounding rect — we compute fresh, since nested
    // splits don't fill the whole host.
    const rects = computeRects(rootPane, {
      width: hostRect.width,
      height: hostRect.height,
    });
    // The split's rect is the union of its leaves' rects in the
    // appropriate axis. Easier: re-walk the tree and find the parent
    // rect by tracking which subtree we're inside.
    const parentRect = computeSplitNodeRect(rootPane, splitId, {
      left: 0, top: 0,
      width: hostRect.width, height: hostRect.height,
    }) ?? rects.values().next().value;
    const start = isHorizontal ? event.clientX : event.clientY;
    const startRatio = splitNode.ratio;
    const onMove = (ev) => {
      const pos = isHorizontal ? ev.clientX : ev.clientY;
      const delta = pos - start;
      const denominator = isHorizontal ? parentRect.width : parentRect.height;
      const ratio = clampSplitterRatio(
        denominator > 0 ? startRatio + delta / denominator : startRatio
      );
      splitNode.ratio = ratio;
      scheduleRelayout();
      refreshSplitterHandles();
    };
    const onUp = (ev) => {
      handle.classList.remove('pane-splitter--dragging');
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

/** Walk the tree to find the rect of a particular split node. */
function computeSplitNodeRect(node, id, rect) {
  if (!node) return null;
  if (node.kind === 'split' && node.id === id) return rect;
  if (node.kind !== 'split') return null;
  if (node.orientation === SPLIT_HORIZONTAL) {
    const firstW = Math.max(0, Math.round(rect.width * node.ratio));
    const secondW = Math.max(0, rect.width - firstW);
    const found = computeSplitNodeRect(node.first, id, {
      left: rect.left, top: rect.top, width: firstW, height: rect.height,
    });
    if (found) return found;
    return computeSplitNodeRect(node.second, id, {
      left: rect.left + firstW, top: rect.top,
      width: secondW, height: rect.height,
    });
  }
  const firstH = Math.max(0, Math.round(rect.height * node.ratio));
  const secondH = Math.max(0, rect.height - firstH);
  const found = computeSplitNodeRect(node.first, id, {
    left: rect.left, top: rect.top, width: rect.width, height: firstH,
  });
  if (found) return found;
  return computeSplitNodeRect(node.second, id, {
    left: rect.left, top: rect.top + firstH,
    width: rect.width, height: secondH,
  });
}

/** Hide every renderer view's DOM, then let mountKindView re-mount
 *  the active one. Pause the standalone media players and
 *  the shell view when they're being unmounted so a hidden view
 *  doesn't keep playing / streaming into nothing.
 *
 *  Phase 3a: the per-pane editor-view instances each manage their own
 *  display through their pane element — a text leaf's instance is
 *  visible whenever the leaf's pane element exists. The focused
 *  pane's instance is *always* visible when its view kind is text;
 *  a focused pane showing a non-text view hides the text instance
 *  attached to that same pane (the non-text singleton overlays it).
 *  Non-focused text panes are unaffected by the focused pane's kind.
 *
 *  @param {string} activeKind */
function hideInactiveRendererViews(activeKind) {
  // The focused pane's currently-mounted text editor follows the active
  // kind — visible iff the focused view is text. This only applies to
  // the *leaf-direct* text-view: a `<text-view>` that's a direct child
  // of the pane element, used when the pane's view is text (no tabline
  // wrapper). For tabline panes, per-tab text-view visibility is
  // managed by `mountTablineActiveChild`'s display loop. Reaching into
  // a tabline's `.tabline-content` here would re-show whichever tab
  // happens to be first in document order, stacking it over the active
  // one inside the content area.
  //
  // This function should only be called from paths where the *focused
  // leaf itself* is changing what it shows — i.e. switchToViewIndex's
  // non-tabline branch. The cross-pane tabline-mount path uses
  // `hideInactiveSingletons` instead, because hiding the focused leaf's
  // text-view on the strength of *another* pane's active tab kind is
  // exactly the bug behind "click a video tab in pane B, pane A's
  // leaf text-view goes blank".
  const focusedPaneEl = currentPaneId
    ? paneElements.get(currentPaneId)
    : null;
  const focusedTextView = focusedPaneEl
    ? focusedPaneEl.querySelector(':scope > text-view')
    : null;
  if (focusedTextView) {
    focusedTextView.style.display = activeKind === 'text' ? '' : 'none';
  }
  // Non-focused panes' leaf-direct text editors follow THEIR OWN view
  // kind: visible only when that pane is showing a leaf-direct *text*
  // view. A non-focused pane showing a non-text leaf view (a PDF, image,
  // gnuplot, …) must keep its text-view hidden so the singleton overlay
  // stays visible. Showing it unconditionally was the bug behind "open a
  // gnuplot view in pane A and pane B's PDF is replaced by an empty
  // text buffer". Same direct-child-only constraint.
  const leafById = new Map();
  for (const leaf of leafPanes(rootPane)) leafById.set(leaf.id, leaf);
  for (const [paneId, paneEl] of paneElements) {
    if (paneId === currentPaneId) continue;
    const leaf = leafById.get(paneId);
    const showsLeafText =
      !!leaf && !isTablineView(leaf.view) && !!leaf.view && leaf.view.kind === 'text';
    for (const tv of paneEl.querySelectorAll(':scope > text-view')) {
      tv.style.display = showsLeafText ? '' : 'none';
    }
  }
  hideInactiveSingletons();
}

/** Hide every singleton view-element whose kind isn't currently shown
 *  as a leaf-direct view by some pane. Per-tab elements inside a
 *  tabline's `.tabline-content` are managed by `mountTablineActiveChild`
 *  and are independent of the singleton-display state. */
function hideInactiveSingletons() {
  // For each non-text singleton, visibility is keyed on whether some
  // leaf shows it as its *direct* view (no tabline). Tabline tabs use
  // their own per-tab elements — for them the singleton stays hidden.
  // `kindsInUse` therefore only counts leaf-direct-view cases.
  const kindsInUse = new Set();
  for (const leaf of leafPanes(rootPane)) {
    if (isTablineView(leaf.view)) continue; // tabline tabs handle themselves
    if (leaf.view && leaf.view.kind !== 'text' && leaf.view.kind !== 'tabline') {
      kindsInUse.add(leaf.view.kind);
    }
  }
  // Iterate the single source of truth — SINGLETON_VIEWS, declared
  // after all the singletons themselves exist. Audio/video/shell flag
  // themselves as media-bearing: when their kind isn't in use anywhere,
  // they release the buffer too (an idle audio pane keeps the buffer
  // alive — only the truly-unused case resets).
  for (const { kind, el, releasesBuffer } of SINGLETON_VIEWS) {
    const inUse = kindsInUse.has(kind);
    el.style.display = inUse ? '' : 'none';
    if (!inUse && releasesBuffer) el.setBuffer(null);
  }
  // Browsers and placeholders are per-instance, not in SINGLETON_VIEWS —
  // toggle their own elements here too.
  hideInactiveBrowsers();
  hideInactiveDocs();
  hideInactivePlaceholders();
  hideInactiveElementHosts();
}

/** Switch to the view at INDEX: dispatch through mountKindView to
 *  mount the matching renderer view, and update the modeline.
 *
 *  Phase 3a of plans/PANES.md: the *currently focused* leaf pane's
 *  `view` is updated to point at the freshly-switched-to view, so
 *  `(current-view)` (which resolves through `(current-pane)`) finds
 *  the right handle. With one leaf this falls back to that leaf;
 *  with multiple leaves the switch only affects the focused one.
 *
 *  Phase 3b (Q2): the focused pane's view dictates the routing —
 *    * tabline-view: add the target as a new tab (if not already in
 *      the tabs list), then activate it. The tabline-view stays as
 *      the leaf's view; only the active index changes.
 *    * plain-leaf : swap the leaf's view directly (today's path). */
function switchToViewIndex(index) {
  if (index < 0 || index >= views.length) return null;
  dismissSplash();
  currentViewIndex = index;
  scheduleMinimapReconcile(); // a leaf-direct view swap re-targets its minimap
  const view = views[index];
  const focused = currentPane();
  if (focused && isTablineView(focused.view)) {
    // Tabline routing: ensure VIEW is in the focused tabline's tabs
    // (add at end if absent), then activate it. The kind-registry's
    // mount for the active child runs inside `activateTabInTabline`,
    // and `applyTextMountSideEffects` (from `mountTablineActiveChild`)
    // updates the modeline / sticky-notes / Markdown preview etc.
    const tlv = focused.view;
    let tabIndex = tlv.tabs.indexOf(view);
    if (tabIndex < 0) {
      tlv.tabs.push(view);
      tabIndex = tlv.tabs.length - 1;
    }
    activateTabInTabline(tlv, tabIndex);
    updateModeline();
    notifyViewsChanged();
    return view;
  }
  // Plain-leaf path (or no focused pane — defensive): swap the view.
  let landingLeaf = focused;
  if (focused) {
    focused.view = view;
  } else {
    const leaves = leafPanes(rootPane);
    if (leaves.length > 0) {
      leaves[0].view = view;
      landingLeaf = leaves[0];
    }
  }
  // Non-text singleton views (image / audio / video / jukebox /
  // customize / doc / shell / directory-*) are module-level instances
  // whose elements are created once at startup, originally parented
  // to the FIRST leaf's pane element. After splits and session
  // restores their original parent may have been destroyed, leaving
  // the element orphaned (display:'' alone won't bring it back into
  // the DOM). Re-parent the singleton into the landing leaf's pane
  // element so it actually appears. The tabline path does the same
  // thing into `.tabline-content` inside `mountTablineActiveChild`.
  const singleton = singletonElementForKind(view.kind);
  const landingEl = landingLeaf ? paneElements.get(landingLeaf.id) : null;
  if (singleton && landingEl && singleton.parentNode !== landingEl) {
    landingEl.append(singleton);
  }
  hideInactiveRendererViews(view.kind);
  mountKindView(view);
  updateModeline();
  notifyViewsChanged();
  return view;
}

/** Switch to a specific view handle (not by index). Returns the view
 *  switched to, or `null` when the handle isn't in the list.
 *
 *  Phase 3a, Q9 collision rule: when TARGET is already the *active*
 *  view in some other pane (its direct leaf view, or the active tab
 *  of another pane's tabline-view), the switch is refused — the
 *  workflow for "two views of the same file" is the auto-duplicate
 *  path on `open-file-path!`, not switch-to-view. Refused calls log
 *  a REPL error and return null. */
function switchToView(view) {
  const idx = views.indexOf(view);
  if (idx < 0) return null;
  const focused = currentPane();
  if (focused) {
    for (const leaf of leafPanes(rootPane)) {
      if (leaf === focused) continue;
      const leafActive = isTablineView(leaf.view)
        ? tablineActiveChild(leaf.view)
        : leaf.view;
      if (leafActive === view) {
        repl.appendError(
          `switch-to-view: view "${view.name ?? '?'}" is already shown ` +
          `in another pane; use open-file to show it side-by-side`
        );
        return null;
      }
    }
  }
  return switchToViewIndex(idx);
}

/** Walk the pane tree and remove VICTIM from every tabline-view's
 *  tabs. Returns an array of `{ tlv, leaf }` records for tablines
 *  whose tabs went empty after the removal — the caller can use these
 *  to auto-collapse the affected panes (per Q6). */
function removeViewFromAllTablines(victim) {
  const emptied = [];
  function visit(view, leaf) {
    if (!isTablineView(view)) return;
    const idx = view.tabs.indexOf(victim);
    if (idx >= 0) {
      // Reuse the in-place tabline mutation so display state stays
      // honest (display:none on the closed child's editor instance,
      // active re-anchored, strip re-rendered).
      removeTabInTabline(view, idx);
    }
    if (view.tabs.length === 0) emptied.push({ tlv: view, leaf });
    // Recurse into nested tabline-views (Q10).
    for (const child of view.tabs) visit(child, leaf);
  }
  for (const leaf of leafPanes(rootPane)) visit(leaf.view, leaf);
  return emptied;
}

/** Remove the view at INDEX from the list, mirroring the semantics of
 *  the old `kill-buffer!`. Out-of-range indices are a no-op. The kind
 *  registry's dispose hook releases any kind-specific resources (a
 *  shell view's child process; an audio/video view's media element).
 *
 *  Phase 3b (Q6): the victim is also removed from every tabline's
 *  tabs. A tabline whose tabs go empty triggers auto-collapse of its
 *  pane (per `delete-pane!`); the root-pane case substitutes a fresh
 *  `*scratch*` view so the editor never lands without a current view. */
function killViewAtIndex(target) {
  if (target < 0 || target >= views.length) return;
  const wasCurrent = target === currentViewIndex;
  const victim = views[target];
  // Killing a placeholder chooser is "discard this empty pane": close
  // the pane (which splices the placeholder out, leaving no residue)
  // rather than pull a foreign view into it. The split path only ever
  // creates a placeholder as a leaf-direct view, so find that leaf.
  if (isPlaceholderView(victim)) {
    const leaf = leafPanes(rootPane).find((l) => l.view === victim);
    if (leaf) {
      deletePaneInTree(leaf);
      return;
    }
    // No pane shows it (shouldn't happen) — just splice it out.
    splicePlaceholderFromViews(victim);
    return;
  }
  // Per-kind cleanup. The dispose hook on the spec runs first (it
  // doesn't know whether the view was current); the audio/video
  // current-view destroy() lives here because it depends on the
  // renderer view that was mounted, not on the View handle.
  disposeKindView(victim);
  if ((victim.kind === 'audio' || victim.kind === 'video') && wasCurrent) {
    if (victim.kind === 'audio') audioView.destroy();
    else videoView.destroy();
  }
  views.splice(target, 1);
  // Strip VICTIM from any tabline-view that contains it. Record the
  // ones that went empty so we can auto-collapse their panes (Q6).
  const emptied = removeViewFromAllTablines(victim);
  // For each emptied tabline: if it's not the root pane, collapse its
  // pane out of the tree. If it IS the root pane, the editor always
  // has at least one pane and that pane needs at least one tab — so
  // substitute a fresh `*scratch*` directly into the tabline (Q6).
  // (Pre-ring-fence, the kill loop relied on `switchToViewIndex`
  // pulling foreign views in from `views[]` to repopulate an emptied
  // tabline. With the ring-fence, no foreign views can enter; the
  // scratch substitution has to be explicit on this path.)
  for (const { tlv, leaf } of emptied) {
    if (leaf !== rootPane) {
      deletePaneInTree(leaf);
      continue;
    }
    const scratch = createView({
      kind: 'text',
      buffer: createBuffer('', { name: '*scratch*' }),
    });
    views.push(scratch);
    tlv.tabs.push(scratch);
    tlv.active = 0;
    // Re-mount the active child: removeTabInTabline ran with an empty
    // tabs list and was a no-op for the mount, so the scratch needs an
    // explicit mount pass to become the visible tab.
    mountTablineActiveChild(tlv);
  }
  if (views.length === 0) {
    // No tabline emptied (or the leaf-direct case) and the global
    // view list ran out. Add a scratch so `currentViewIndex` has
    // something to land on. (The tabline-substitution above already
    // handled the empty-root-tabline case.)
    const scratch = createView({
      kind: 'text',
      buffer: createBuffer('', { name: '*scratch*' }),
    });
    views.push(scratch);
    currentViewIndex = -1;
    switchToViewIndex(0);
    return;
  }
  if (wasCurrent) {
    // Ring-fence the tabline: if the focused leaf still holds a
    // tabline-view with remaining tabs, `removeTabInTabline` (called
    // from `removeViewFromAllTablines` above) already re-anchored the
    // tabline's active index to a surviving sibling and mounted that
    // tab. Reaching into the global `views[]` for a "next" pick would
    // pull a view that belongs to some other pane into this tabline
    // — exactly the leak this guard prevents.
    //
    // For an auto-collapsed pane (tabline emptied → deletePaneInTree
    // fired), focus has already followed to the sibling and the
    // sibling's view was mounted; we only need a modeline sync.
    //
    // The only case that still goes through the global-next pick is a
    // leaf-direct kill — the focused leaf's view IS the dead victim,
    // and there's no per-container list to consult, so the legacy
    // global-pick behaviour stands.
    const focused = currentPane();
    if (focused
        && focused.kind === 'leaf'
        && isTablineView(focused.view)
        && focused.view.tabs.length > 0) {
      const activeChild = tablineActiveChild(focused.view);
      currentViewIndex = activeChild !== null
        ? views.indexOf(activeChild)
        : -1;
      updateModeline();
      notifyViewsChanged();
    } else if (focused
               && focused.kind === 'leaf'
               && focused.view !== victim) {
      // Auto-collapsed: deletePaneInTree pointed focus at a sibling
      // and set currentViewIndex inside its branch. Just refresh.
      updateModeline();
      notifyViewsChanged();
    } else {
      const next = Math.min(target, views.length - 1);
      currentViewIndex = -1; // force switchToViewIndex to re-mount.
      switchToViewIndex(next);
    }
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

/** The navigation node tree the doc panes navigate by (functions + nodes +
 *  top + roots + order), set when the manifest loads. Documentation opens as
 *  a pane view now (see `openDocInPane` and the doc per-instance helpers,
 *  mirroring the browser view), not the utility dock. */
let docNavTree = null;

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
  let body;
  try {
    body = await renderMarkdownHtml(source);
  } catch (error) {
    repl.appendError(`doc render failed: ${error.message}`);
    return;
  }
  // Frame the rendered body in the same `article.doc-page[data-node-id]`
  // shape the built pages use, so the doc-view lifts it correctly. This
  // node isn't in the manifest tree, so the view shows it with minimal
  // chrome (Contents stays reachable; Prev/Up/Next are disabled).
  const html =
    `<article class="doc-page docstring-page" data-node-id="${escapeHtml(docName)}">` +
    `<h3 class="doc-name"><code>${escapeHtml(docName)}</code></h3>\n` +
    `<div class="doc-docstring">${body}</div></article>`;
  showDocInPane(docName, html, docName);
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
/** The editor's per-user data directory (where init.lisp, custom.lisp,
 *  faces.json live). Used by the snippet engine to find
 *  `<userData>/snippets`. Empty when the host can't resolve it. */
const USER_DATA_DIR = window.host?.userDataDirectory ?? '';
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
    // Q9 (plans/PANES.md): when the chosen file is already a text view
    // visible in some *other* pane, take the auto-duplicate path —
    // fresh View over the same buffer with its own point/mark, switch
    // the current pane to it. The buffer keeps its content / metadata;
    // we don't re-read the file from disk.
    const existing = views.findIndex(
      (v) => viewFilePath(v) === result.path
    );
    if (existing >= 0) {
      const existingView = views[existing];
      const focused = currentPane();
      const showingElsewhere =
        focused
          ? leafPanes(rootPane).some(
              (leaf) => leaf !== focused && leaf.view === existingView
            )
          : false;
      if (
        showingElsewhere &&
        existingView.kind === 'text' &&
        existingView.buffer
      ) {
        const dup = createView({ kind: 'text', buffer: existingView.buffer });
        views.push(dup);
        notifyViewsChanged();
        switchToViewIndex(views.length - 1);
        return;
      }
      switchToViewIndex(existing);
      return;
    }
    const buffer = createBuffer(result.content, { name: result.name });
    buffer.filePath = result.path;
    // The just-loaded content is the saved baseline (it matches disk).
    markBufferSaved(buffer);
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

/** Whether a freshly-opened PDF should be session-persistent by default,
 *  read from the `*pdf-restore-default*` defcustom. Defaults to false
 *  (generic / texdoc PDFs are transient) when the var is unset or the
 *  read fails — so a missing/broken setting never makes a transient doc
 *  sticky. */
function pdfRestoreDefault() {
  try {
    return interpreter.evaluate('*pdf-restore-default*') === true;
  } catch {
    return false;
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
  // A PDF file is served over the media:// protocol (Chromium streams
  // it with Range support, same as audio/video). PDF.js inside
  // <pdf-view> fetches the URL and renders each page to a canvas.
  if (result.pdfKind === true) {
    // A freshly-opened PDF is ephemeral by default (a transient
    // texdoc/consult doc); `*pdf-restore-default*` lets the user make
    // every PDF persist instead. latex-view marks its own output PDF
    // persistent regardless (via `*latex-pdf-restore*`).
    views.push(createView({
      kind: 'pdf',
      name: result.name,
      extras: { filePath: result.path, src: result.src, persist: pdfRestoreDefault() },
    }));
    return finalise();
  }
  // A `.rxlisp` file is a reactive Lisp notebook: open it through the
  // notebook view, its `(cell …)` source backing `buffer.text` so the
  // generic save path round-trips it.
  if (result.notebookKind === true) {
    views.push(createView({
      kind: 'notebook',
      name: result.name,
      buffer: {
        text: result.content ?? '',
        filePath: result.path,
        name: result.name,
      },
      extras: { notebookId: nextNotebookId() },
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
 * @param {boolean} [options.forceDuplicate=false] - Bypass the path
 *   de-dup. Used by session restore: each persisted blob gets its own
 *   View handle so two tablines holding the same path don't end up
 *   aliasing one View (which would make a close-X in one tabline kill
 *   the tab in the other too). The buffer is still shared when one
 *   already exists for the path — the duplicate is at the View layer,
 *   the buffer/file content is one.
 * @returns {Promise<object | null>}
 */
async function openFileByPath(filePath, {
  switch: shouldSwitch = true,
  forceDuplicate = false,
} = {}) {
  try {
    const result = await window.host.openFilePath(filePath);
    if (result === null) {
      if (shouldSwitch) {
        repl.appendError(`open-file-path: unreadable (${filePath})`);
      }
      return null;
    }
    // De-dup by file path: surface the existing view rather than
    // stacking a second copy — *unless* the existing view is already
    // visible in another pane of the current window (Q9 auto-duplicate
    // path, plans/PANES.md). In that case we create a *fresh* view
    // over the same buffer with its own per-view-point, append it to
    // the view list, and switch the current pane to it. The buffer is
    // shared; the views (and their cursors) are independent.
    const existing = views.findIndex((v) => viewFilePath(v) === result.path);
    if (existing >= 0) {
      const existingView = views[existing];
      // Restore path: always create a fresh View over the shared
      // buffer. Skip the showing-elsewhere check; we want one View per
      // persisted blob, period.
      if (
        forceDuplicate &&
        existingView.kind === 'text' &&
        existingView.buffer
      ) {
        const dup = createView({ kind: 'text', buffer: existingView.buffer });
        views.push(dup);
        notifyViewsChanged();
        if (shouldSwitch) switchToViewIndex(views.length - 1);
        return dup;
      }
      const focused = currentPane();
      // Find any other pane already showing this view. A pane "shows"
      // the view either as its direct view (leaf-direct) or as a tab
      // inside its tabline-view. The latter case was previously
      // missed, which let the same View object end up referenced by
      // two tab positions — Q9 violation, and its cursor state ended
      // up shared across the two displays.
      const showingElsewhere =
        focused
          ? leafPanes(rootPane).some((leaf) => {
              if (leaf === focused) return false;
              if (leaf.view === existingView) return true;
              if (
                isTablineView(leaf.view) &&
                Array.isArray(leaf.view.tabs) &&
                leaf.view.tabs.includes(existingView)
              ) {
                return true;
              }
              return false;
            })
          : false;
      if (
        showingElsewhere &&
        existingView.kind === 'text' &&
        existingView.buffer
      ) {
        // Auto-duplicate path. Before making a *new* dup, check whether
        // the focused tabline already holds a dup of this file — if so,
        // surface it. Without this check, repeated opens of the same
        // file in the same tabline build a fresh dup every call (since
        // findIndex still finds the original showing-elsewhere view),
        // accumulating duplicate tabs that all share the buffer. The
        // user sees N identical tabs and session.json persists the lot.
        if (focused && isTablineView(focused.view)) {
          const existingDup = focused.view.tabs.find(
            (tab) =>
              tab !== existingView &&
              tab.kind === 'text' &&
              viewFilePath(tab) === result.path
          );
          if (existingDup) {
            if (shouldSwitch) switchToViewIndex(views.indexOf(existingDup));
            return existingDup;
          }
        }
        // Auto-duplicate: fresh View, fresh point/mark, same buffer.
        const dup = createView({ kind: 'text', buffer: existingView.buffer });
        views.push(dup);
        notifyViewsChanged();
        if (shouldSwitch) switchToViewIndex(views.length - 1);
        return dup;
      }
      if (shouldSwitch) switchToViewIndex(existing);
      return existingView;
    }
    if (openAsMediaViewIfRecognised(result, { switch: shouldSwitch })) {
      notifyViewsChanged();
      return views[views.length - 1];
    }
    if (typeof result.content !== 'string') return null;
    const buffer = createBuffer(result.content, { name: result.name });
    buffer.filePath = result.path;
    // The just-loaded content is the saved baseline (it matches disk).
    markBufferSaved(buffer);
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
    let result = await window.host.saveFile(buffer.filePath ?? null, buffer.text);
    if (result === null) return;
    // The file changed on disk since we read it — another program rewrote
    // it. Don't silently clobber that change: ask first. Cancelling is
    // non-destructive (the buffer keeps its edits, the disk keeps its
    // version), so the user can reload or diff before deciding.
    if (result.conflict) {
      const overwrite = window.confirm(
        `"${result.name}" has changed on disk since you opened it.\n\n` +
          'OK = overwrite it with your version.\n' +
          'Cancel = write nothing and keep editing ' +
          '(re-open the file to load the disk version).'
      );
      if (!overwrite) {
        repl.appendError(
          `save: "${result.name}" changed on disk — not overwritten. ` +
            'Re-open the file to load the disk version.'
        );
        return;
      }
      result = await window.host.saveFile(buffer.filePath ?? null, buffer.text, {
        force: true,
      });
      if (result === null || result.conflict) return;
    }
    buffer.filePath = result.path;
    buffer.name = result.name;
    // Mirror the rename onto the view (text views derive their
    // display name from the buffer).
    view.name = result.name;
    dirtyBuffers.delete(buffer);
    // The saved text is the new clean baseline, so a later undo back to
    // it (or a re-edit) is measured against what's actually on disk.
    markBufferSaved(buffer);
    // The buffer is on disk now — drop its crash-recovery snapshot.
    recovery.forget(buffer);
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
  // A clean, confirmed quit is not a crash: drop every recovery snapshot
  // so the next launch doesn't offer to "recover" work the user chose to
  // discard (or had already saved). `quitting` stops the pagehide handler
  // below from re-writing snapshots after this.
  quitting = true;
  await flushAllMetadata();
  await recovery.clear();
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
 *
 * Phase 3b (Q4): the picker source is the global view list minus
 * (a) the current view (so the bracketed suggestion is always a
 * different view) and (b) any view currently *visible* in some other
 * pane — the user can't switch to a view that's already on screen in
 * another pane. The auto-duplicate path on `open-file-path!` covers
 * the "two views of the same file" workflow instead.
 */
function startBufferSwitcher() {
  const focused = currentPane();
  const elsewhere = viewsVisibleInOtherPanes(focused);
  const names = views
    .filter((view, index) => index !== currentViewIndex && !elsewhere.has(view))
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

// The utility dock — the tabbed chrome region at the bottom. The REPL is its
// resident tab; tools (RefTeX pickers, doc, compile output) open additional
// tabs here instead of overlaying the editor. `onFocusOrigin` reads the LIVE
// `editorView` binding (it is reassigned across the session), so a tool that
// closes / a dock that hides returns focus to the current text view.
const utilityHostEl = document.getElementById('utility-host');
const utilityDock = createUtilityDock({
  hostEl: utilityHostEl,
  tabsEl: utilityHostEl.querySelector('.utility-tabs'),
  contentEl: utilityHostEl.querySelector('.utility-content'),
  onFocusOrigin: () => {
    if (editorView && typeof editorView.focus === 'function') editorView.focus();
  },
});

// The transient tab `show-completions!` opens for find-file's ambiguous TAB
// candidates. Held as a constant so the display primitives and the
// completing-minibuffer teardown (submit/cancel) all name the same tab.
const COMPLETIONS_TAB_ID = 'completions';
// The directory prefix the live completions list is relative to (the part
// of the typed path up to its last '/'). `show-completions!` keeps it
// current so a click can rebuild the full path; the panel reads it live
// (it is created once and reused across TABs).
let completionsDirectory = '';

/** Single-click in the completions panel = select. NAME is a candidate's
 *  display string (a directory carries a trailing '/'); fill the minibuffer
 *  with `completionsDirectory + NAME` and refocus it. Non-destructive (the
 *  panel stays open) so a double-click can still activate the same row. */
function completeFromPanel(name) {
  minibuffer.setValue(completionsDirectory + name);
}

/** Open (or update in place) the transient "Completions" utility-dock tab with
 *  ITEMS (display strings; a directory carries a trailing '/'), relative to
 *  DIRECTORY (the typed path prefix, for click-to-complete). Shared by the Lisp
 *  `show-completions!` primitive (flag-off) and the server-mode completion reply
 *  (showServerCompletions). `focus:false` keeps the minibuffer focused. */
function displayCompletionsPanel(items, directory) {
  completionsDirectory = directory ?? '';
  const panel = utilityDock.hasTab(COMPLETIONS_TAB_ID)
    ? utilityDock.getPanel(COMPLETIONS_TAB_ID)
    : null;
  if (panel && typeof panel.setItems === 'function') {
    panel.setItems(items);
  } else {
    utilityDock.openUtilityPanel({
      id: COMPLETIONS_TAB_ID,
      title: 'Completions',
      icon: 'fa-solid fa-list-ul',
      focus: false,
      makePanel: () => createCompletionsPanel({
        items,
        onSelect: completeFromPanel,
        onActivate: activateFromPanel,
      }),
    });
  }
}

/** Double-click in the completions panel = activate (file-browser idiom): a
 *  file OPENS (submit the prompt — drops the panel, delivers the path); a
 *  directory is ENTERED — re-running TAB completion so its contents list and
 *  the panel updates. */
function activateFromPanel(name) {
  const full = completionsDirectory + name;
  if (name.endsWith('/')) {
    let next = full;
    try {
      const result = interpreter.call('minibuffer-tab-complete', full);
      if (typeof result === 'string') next = result;
    } catch (error) {
      repl.appendError(`tab-complete: ${error.lispMessage ?? error.message}`);
    }
    minibuffer.setValue(next);
  } else {
    minibuffer.submit(full);
  }
}

// The REPL is built detached, then mounted as the dock's resident tab; the
// dock reparents `repl.element` into its content area. The `repl` facade is
// unchanged — every appendOutput/appendResult/… call site keeps working.
const repl = createReplView(document.createElement('div'), {
  prompt: 'λ ',
  welcome: 'REPL — type Lisp, press Enter. It shares the editor buffers.',
  onSubmit: evaluateInRepl,
});
// focus:false — the editor keeps focus at startup; the REPL is just mounted.
utilityDock.openUtilityPanel({ id: 'repl-view', makePanel: () => repl, focus: false });

// Registry of named utility-panel factories. Commands/tools/processes (mostly
// Lisp) address panels BY NAME via the `utility-panel-*!` primitives, since the
// panels themselves are JS DOM factories. A factory is
// `(handle, opts) => panel` (the openUtilityPanel contract; `handle` is the
// per-tab {close, focus, activate}). Built-ins seeded here; tools can add more
// via `registerUtilityPanelFactory`.
const utilityPanelFactories = new Map();
function registerUtilityPanelFactory(name, makePanel) {
  utilityPanelFactories.set(String(name), makePanel);
}
registerUtilityPanelFactory('output', (handle, opts) =>
  createOutputPanel({ title: opts?.title, onClose: handle.close }));

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

/** The persisted user highlight rules, as the Lisp store shape
 *  (scope-key -> list of (pattern . face)) — built from faces.json at
 *  startup, or `null` when none were persisted. Installed via
 *  `installHighlightRules` after each stdlib (re)load. */
let highlightRulesCache = null;

/** The persisted user-created faces, as the Lisp `*user-faces*` map —
 *  built from faces.json at startup, `null` when none. Re-installed via
 *  `set-user-faces!` after each stdlib (re)load (a fresh stdlib drops
 *  the registry). */
let userFacesCache = null;

/** The Sym / Keyword constructors face-overrides.js needs to build
 *  Lisp-shaped maps. Passed in so that module stays free of a hard
 *  dependency on `@editor/lisp` (the unit tests use stand-ins). */
const lispFactories = { keyword, sym };

/** The pane-host the Lisp pane-primitives operate through. Phase 3a:
 *  the split / delete / navigate methods land here, backed by the
 *  immutable-replace tree helpers in `@editor/pane`. The host mutates
 *  `rootPane` (rebinding the module-level binding when a split or
 *  delete swaps a subtree) and reschedules a layout pass; the DOM and
 *  editor-view instances follow. */
const paneHost = {
  currentPane: () => currentPane(),
  splitHorizontal: (pane, ratio, side) =>
    splitPaneAtLeaf(pane, SPLIT_HORIZONTAL, ratio, side),
  splitVertical: (pane, ratio, side) =>
    splitPaneAtLeaf(pane, SPLIT_VERTICAL, ratio, side),
  addPaneAtSplitter: (splitId) => addPaneAtSplitterId(splitId),
  addPaneAtBorder: (side) => addPaneAtRootBorder(side),
  deletePane: (pane) => deletePaneInTree(pane),
  deleteOtherPanes: (pane) => deleteOtherPanesInTree(pane),
  otherPane: () => focusNextPane(),
  focusPaneDirection: (direction) => focusPaneByDirection(direction),
  focusPane: (pane) => focusPaneHandle(pane),
  balancePanes: () => balancePanesInTree(),
  setSplitRatio: (pane, ratio) => setSplitRatioOnNode(pane, ratio),
  // Phase 3b tabline-view operations. Implementations sit further
  // down the file with the rest of the tabline mount machinery —
  // these closures forward; the host pickle-shape is what
  // pane-primitives.js depends on.
  currentTabline: () => currentTablineView(),
  promoteToTabline: (pane) => promoteToTablineOnPane(pane),
  demoteTabline: (tlv) => demoteTablineView(tlv),
  addTab: (tlv, view, index) => addTabToTabline(tlv, view, index),
  removeTab: (tlv, index) => {
    removeTabInTabline(tlv, index);
    return tlv;
  },
  activateTab: (tlv, index) => {
    activateTabInTabline(tlv, index);
    return tlv;
  },
  setTablineEdge: (tlv, edge) => setTablineEdgeOnTabline(tlv, edge),
  // Cross-tabline tab move + pane-view swap. Cover the workflows the
  // user spelled out: "move a view from one pane to another" + "close
  // a pane while keeping the view alive". (The latter is what
  // `delete-pane!` already does; the move primitives below close the
  // gap on the former.)
  moveTab: (srcTlv, srcIdx, dstTlv, dstIdx) =>
    moveTabAcrossTablines(srcTlv, srcIdx, dstTlv, dstIdx),
  // swap-views / permute-views move the *frames* (swap leaf positions in
  // the tree, relayout repositions the divs) so view DOM never moves and
  // webview/pdf/shell panes survive. See plans/PANES-SWAP-PERMUTE.md.
  swapPanes: (paneA, paneB) => swapPaneFrames(paneA, paneB),
  permutePanes: (dests) => permutePaneFrames(dests),
  panesInSpiralOrder: () => spiralOrderedLeaves(),
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
    if (pane && pane.kind === 'leaf' && pane.view) {
      // Phase 3b focus-resolution shift: when the focused pane holds a
      // tabline-view, the user is editing its active child — peel
      // through (possibly several layers, Q10 nested tablines).
      return peelTabline(pane.view);
    }
    // Fallback for the (vanishingly rare) no-pane / no-view case —
    // keep the legacy index-based lookup so the editor never lands
    // with a null current view during early startup.
    return views[currentViewIndex] ?? null;
  },
  viewList: () => views.slice(),
  // Toggle a minimap companion beside the focused leaf. SIDE ('left'|'right')
  // and WIDTHFRACTION come from the `*minimap-*` defcustoms (the command
  // reads them and passes them through).
  toggleMinimap: (side, widthFraction) =>
    toggleMinimapForFocusedLeaf(side, widthFraction),
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
  // Phase 3b (Q5): cycle the focused pane's tabs only — a tabline-view
  // advances to the next/prev tab; a plain-leaf pane has only one
  // view in it so cycling is a no-op (returns the view itself).
  nextView: () => {
    dismissSplash();
    const focused = currentPane();
    if (focused && isTablineView(focused.view)) {
      const tlv = focused.view;
      if (tlv.tabs.length === 0) return null;
      const nextIdx = (tlv.active + 1) % tlv.tabs.length;
      activateTabInTabline(tlv, nextIdx);
      // Sync currentViewIndex so legacy index-based callers (modeline
      // count `i/N`, session save's current pointer) reflect the
      // active tab.
      const child = tlv.tabs[nextIdx];
      const i = views.indexOf(child);
      if (i >= 0) currentViewIndex = i;
      updateModeline();
      notifyViewsChanged();
      return child;
    }
    // Plain-leaf pane: one view per pane, nothing to cycle.
    if (focused && focused.view) return focused.view;
    if (views.length === 0) return null;
    // Defensive fallback (no focused pane): step to the next index,
    // skipping any transient placeholder entries.
    const next = nextNonPlaceholderIndex(currentViewIndex, 1);
    return next < 0 ? null : switchToViewIndex(next);
  },
  previousView: () => {
    dismissSplash();
    const focused = currentPane();
    if (focused && isTablineView(focused.view)) {
      const tlv = focused.view;
      if (tlv.tabs.length === 0) return null;
      const prevIdx =
        (tlv.active - 1 + tlv.tabs.length) % tlv.tabs.length;
      activateTabInTabline(tlv, prevIdx);
      const child = tlv.tabs[prevIdx];
      const i = views.indexOf(child);
      if (i >= 0) currentViewIndex = i;
      updateModeline();
      notifyViewsChanged();
      return child;
    }
    if (focused && focused.view) return focused.view;
    if (views.length === 0) return null;
    const prev = nextNonPlaceholderIndex(currentViewIndex, -1);
    return prev < 0 ? null : switchToViewIndex(prev);
  },
  findViewByName: (name) => views.find((v) => v.name === name) ?? null,
  // The snapshot the *Buffer List* (view-menu) renders against. One
  // hash-map per view, with :name, :kind, :mode, :line-count, :file,
  // :modified. The major mode's display name lives on a text view's
  // buffer; non-text views don't carry a mode.
  listViewRecords: () => {
    // Phase 3b (Q12): the :pane column is the 1-based spiral position of
    // the pane showing each view (the swap-views / permute-views badge
    // numbering — tracks on-screen position, not an internal leaf id);
    // views in no pane (incl. buried tabs) are nil. Placeholders are
    // transient chooser panes — never shown here (decision 2).
    const paneByView = panePositionByView();
    return views.filter((view) => !isPlaceholderView(view)).map((view) => {
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
      record.set(keyword('pane'), paneByView.get(view) ?? NIL);
      return record;
    });
  },
};

// --- general process runner (run-process!) -----------------------------
//
// Each `(run-process! …)` call gets a monotonic runId (a counter, not a
// timestamp/random — deterministic and collision-free for the session).
// The on-exit Lisp procedure is parked in `runProcessCallbacks` keyed by
// that id; the single `onRunProcessExit` listener (wired once, below)
// looks it up when the host reports the exit, builds the result hash-map,
// and applies the procedure exactly once.
let nextRunId = 0;
/** @type {Map<string, *>} runId → the parked on-exit Lisp procedure. */
const runProcessCallbacks = new Map();

const interpreter = createInterpreter({
  write: (text) => repl.appendOutput(text),
  primitives: {
    ...createBufferPrimitives(session),
    ...createViewPrimitives(viewHost),
    ...createPanePrimitives(paneHost),
    ...createLatexPrimitives(),

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
    // `(open-element-view! SPEC)` — open a generic element-view from a
    // Lisp spec hash-map (:tag :module :attrs :keyboard :title :on-ready).
    // The single `element` kind hosts any custom element; the spec says
    // which one. The Lisp `define-element-view` macro drives this. See
    // plans/ELEMENT-VIEWS.md.
    'open-element-view!': (args) => {
      const spec = args[0];
      if (!(spec instanceof Map)) {
        throw new LispError('open-element-view!: expected a spec hash-map');
      }
      const field = (name) => spec.get(keyword(name));
      const tag = lispText(field('tag'));
      if (tag === '') {
        throw new LispError('open-element-view!: spec needs a :tag');
      }
      const keyboardRaw = field('keyboard');
      const onReadyRaw = field('on-ready');
      const titleRaw = field('title');
      const extras = {
        tag,
        moduleUrl: resolveElementModuleUrl(lispText(field('module'))),
        attrs: parseElementAttrs(field('attrs')),
        fit: normalizeFit(lispText(field('fit'))),
        // A helper/satellite view (e.g. a bibliography panel) that acts on
        // the *active* view and must never become the focused pane itself.
        noFocus: field('no-focus') === true,
        keyboard:
          keyboardRaw === undefined || keyboardRaw === null || keyboardRaw === NIL
            ? 'grab'
            : lispText(keyboardRaw),
        onReady:
          onReadyRaw === undefined || onReadyRaw === null || onReadyRaw === NIL
            ? null
            : onReadyRaw,
      };
      const name =
        titleRaw === undefined || titleRaw === null || titleRaw === NIL
          ? tag
          : lispText(titleRaw);
      // Server mode: the renderer computes the spec (here — it owns
      // define-element-view + host primitives), but the view must live as a
      // SERVER data-source to get a pane slot + restore. Send the plain spec up;
      // the server holds it + switches the leaf, and the client mounts
      // <element-view> from the PANE_TREE. (onReady is a Lisp callback that
      // can't cross the wire — deferred; noFocus is honoured server-side later.)
      if (window.host && window.host.serverMode) {
        if (serverViewClient) {
          serverViewClient.openElementView({
            name,
            tag: extras.tag,
            moduleUrl: extras.moduleUrl,
            attrs: extras.attrs,
            fit: extras.fit,
            keyboard: extras.keyboard,
            noFocus: extras.noFocus,
          });
        }
        return NIL;
      }
      // A :no-focus panel (e.g. bib-search) opens BESIDE the document in
      // its own split, keeping the editing focus on the document — and
      // reuses an already-open instance of the same tag rather than
      // stacking splits. A normal element-view replaces the focused pane.
      if (extras.noFocus) {
        const open = views.find((v) =>
          v && v.kind === 'element' && v.tag === extras.tag &&
          leafPanes(rootPane).some((l) => l.view === v));
        if (open) return NIL; // already showing
        const view = createView({ kind: 'element', name, extras });
        views.push(view);
        openNoFocusViewInSplit(view);
        return NIL;
      }
      views.push(createView({ kind: 'element', name, extras }));
      switchToViewIndex(views.length - 1);
      return NIL;
    },
    // `(host-file-url ABS-PATH)` — turn an absolute host path into an
    // `app://editor/__host__/…` URL the renderer can fetch. bib-search uses
    // it to load the active document's .bib. The path's directory must be
    // allowlisted; opening the document allowlisted its dir and the bib
    // resolves under it, so this covers the common case. Returns "" for a
    // non-absolute / empty path.
    'host-file-url': (args) => {
      const path = String(args[0] ?? '');
      if (path === '' || !path.startsWith('/')) return '';
      // Vouch for this specific file's real directory so the __host__
      // route serves it even when it (or a symlink to it) lives outside a
      // folder the user opened — e.g. a bibliography symlinked to a shared
      // .bib. Best-effort; the fetch still 403s gracefully if it fails.
      try {
        if (window.host && typeof window.host.allowHostFile === 'function') {
          window.host.allowHostFile(path);
        }
      } catch { /* ignore — fall through to the URL */ }
      return hostFileUrl(path);
    },
    // `(find-file-new! PATH)` — visit a path that does NOT exist yet:
    // open an empty text buffer whose file is PATH, so the next
    // `save-buffer` (C-x C-s) creates it. Emacs's find-file-on-a-missing-
    // file behaviour. If a view already visits PATH, just switch to it.
    // The file is NOT written to disk here — only on save. Returns nil.
    'find-file-new!': (args) => {
      const filePath = expandTilde(String(args[0] ?? ''));
      if (filePath === '') return NIL;
      const existing = views.findIndex((v) => viewFilePath(v) === filePath);
      if (existing >= 0) {
        switchToViewIndex(existing);
        return NIL;
      }
      const name = filePath.slice(filePath.lastIndexOf('/') + 1) || filePath;
      const buffer = createBuffer('', { name });
      buffer.filePath = filePath;
      const view = createView({ kind: 'text', buffer });
      views.push(view);
      notifyViewsChanged();
      switchToViewIndex(views.length - 1);
      return NIL;
    },
    // `(clipboard-text)` — the system clipboard's plain text (''
    // when empty or unavailable). The kill ring's `yank` reads this so
    // C-y pastes text copied in another application.
    'clipboard-text': () => {
      try {
        const text = window.host.clipboardReadText();
        return typeof text === 'string' ? text : '';
      } catch {
        return '';
      }
    },
    // `(clipboard-set-text! TEXT)` — write TEXT to the system clipboard.
    // The kill ring mirrors every kill/copy here so editor kills paste
    // into other apps. Returns nil.
    'clipboard-set-text!': (args) => {
      try {
        window.host.clipboardWriteText(String(args[0] ?? ''));
      } catch {
        // No clipboard host (e.g. headless): silently skip.
      }
      return NIL;
    },
    // Show a transient message in the minibuffer's echo area (the
    // status line at the foot of the window). Used by the keymap to
    // surface a mid-build chord prefix ("C-x-"), among other things.
    'show-status!': (args) => {
      minibuffer.setStatus(String(args[0] ?? ''));
      return NIL;
    },
    // `(enter-add-pane-mode!)` — toggle the visual add-pane macro: an
    // overlay over #editor-host that lights up every splitter and the
    // four outer borders; click one to insert a fresh pane there. A
    // second call (or Escape, or a click on overlay empty space)
    // cancels without inserting. Returns nil.
    'enter-add-pane-mode!': () => {
      if (addPaneHandle && addPaneHandle.active) {
        addPaneHandle.exit();
        addPaneHandle = null;
        return NIL;
      }
      addPaneHandle = enterAddPaneMode({
        host: editorHostEl,
        getRootPane: () => rootPane,
        onPickSplitter: (splitId) => {
          addPaneAtSplitterId(splitId);
          addPaneHandle = null;
        },
        onPickBorder: (side) => {
          addPaneAtRootBorder(side);
          addPaneHandle = null;
        },
      });
      // The user might dismiss via Escape — clear our handle so the
      // next entry doesn't try to exit() a dead overlay.
      const original = addPaneHandle.exit;
      addPaneHandle.exit = () => {
        original();
        addPaneHandle = null;
      };
      return NIL;
    },
    // `(enter-move-views-mode! kind)` — enter the swap-views /
    // permute-views overlay (KIND is 'swap or 'permute). Numbers every
    // pane and reads digit input over the whole window (so it works with
    // a browser pane focused); on Enter it moves the frames. Re-entering
    // toggles the overlay off. See plans/PANES-SWAP-PERMUTE.md.
    'enter-move-views-mode!': (args) => {
      if (moveViewHandle && moveViewHandle.active) {
        moveViewHandle.exit();
        moveViewHandle = null;
        return NIL;
      }
      const raw = args[0];
      const name =
        typeof raw === 'string'
          ? raw
          : raw && typeof raw === 'object' && typeof raw.name === 'string'
            ? raw.name
            : 'swap';
      const mode = name === 'permute' ? 'permute' : 'swap';
      moveViewHandle = enterMoveViewsMode({
        mode,
        host: editorHostEl,
        getRootPane: () => rootPane,
        onCommit: (assignments) => {
          moveViewHandle = null;
          if (mode === 'swap') {
            const panes = spiralOrderedLeaves();
            const a = panes[assignments[0] - 1];
            const b = panes[assignments[1] - 1];
            if (a && b) swapPaneFrames(a, b);
          } else {
            permutePaneFrames(assignments);
          }
        },
      });
      // Clear the handle on any exit (Escape / click / commit), so the
      // next entry doesn't try to exit() a dead overlay.
      if (moveViewHandle) {
        const original = moveViewHandle.exit;
        moveViewHandle.exit = () => {
          original();
          moveViewHandle = null;
        };
      }
      return NIL;
    },
    // Push the *tab-width* setting onto the document root as the
    // `--tab-width` CSS variable AND cache the value for the
    // renderer's cursor-positioning math. `.editor-line` and the
    // directory-columns preview line read the CSS var via
    // `tab-size: var(--tab-width)`; the cached number is what
    // `getTabWidth` returns to createEditorView so the cursor /
    // selection rects line up with the rendered glyph when the line
    // contains tabs. Called once on startup (after stdlib loads) and
    // again from the *tab-width* defcustom's on-change hook whenever
    // the user changes it.
    'set-css-tab-width!': (args) => {
      const value = Number(args[0]);
      const width = Number.isFinite(value) && value > 0 ? value | 0 : 4;
      document.documentElement.style.setProperty('--tab-width', String(width));
      currentTabWidth = width;
      return NIL;
    },
    // Paint the editor's line spacing onto the `--line-height` CSS var, which
    // `.editor { line-height: var(--line-height) }` reads — so every line's
    // `1lh`-based position reflows in step (no re-render needed). Driven by
    // the *line-height* defcustom: once on startup, then on its on-change.
    // Clamped to a sane multiple so a fat-fingered value can't break layout.
    'set-css-line-height!': (args) => {
      const value = Number(args[0]);
      const lh = Number.isFinite(value) && value >= 1 && value <= 3 ? value : 1.35;
      document.documentElement.style.setProperty('--line-height', String(lh));
      return NIL;
    },
    'clear-status!': () => {
      minibuffer.clearStatus();
      return NIL;
    },
    // Show CANDIDATES (a list of display strings; a directory carries a
    // trailing '/') in a transient, scrollable utility-dock tab — the
    // home for find-file's ambiguous TAB completions, which used to be
    // crammed into the non-scrolling inline status line. Opened with
    // `focus: false` so the minibuffer keeps focus while the user keeps
    // typing / TABbing. Updating an open panel reuses it in place (no
    // re-activation) so it never steals focus mid-keystroke. The tab is
    // removed by `clear-completions!` (on TAB progress) or when the
    // completing minibuffer closes (see `open-completing-minibuffer!`).
    'show-completions!': (args) => {
      displayCompletionsPanel(listToArray(args[0] ?? NIL).map(String), String(args[1] ?? ''));
      return NIL;
    },
    'clear-completions!': () => {
      utilityDock.closeUtilityTab(COMPLETIONS_TAB_ID);
      return NIL;
    },
    // `(view-modified?)` — whether the current view's buffer has unsaved
    // changes (the same dirty set the modeline ● and the quit guard
    // read). `kill-view`'s confirm-before-kill guard asks this before
    // destroying a buffer.
    'view-modified?': () => {
      const view = views[currentViewIndex];
      const buffer = view && view.kind === 'text' ? view.buffer : null;
      return buffer ? dirtyBuffers.has(buffer) : false;
    },
    // `(new-scratch-view!)` — a fresh Lisp scratch view, seeded like the
    // first-run scratch.lisp and uniquely named (scratch.lisp,
    // scratch-2.lisp, …). Routed through switchToViewIndex, so it joins
    // the focused pane as a new tab when that pane holds a tabline.
    // Needed because the startup seed views are deliberately dropped on
    // session restore — this conjures a scratch mid-session.
    'new-scratch-view!': () => {
      const names = new Set(views.map((v) => v.name));
      let name = 'scratch.lisp';
      for (let i = 2; names.has(name); i += 1) name = `scratch-${i}.lisp`;
      const view = createView({
        kind: 'text',
        buffer: createBuffer(SCRATCH, { name }),
      });
      views.push(view);
      switchToViewIndex(views.length - 1);
      return view;
    },
    // --- citation.js bridges -------------------------------------------
    // The renderer-side wrapper (`packages/renderer/src/citation.js`)
    // owns the heavy bundle. These primitives are thin string-in /
    // string-out shells so the Lisp side never sees JS objects — a
    // *bibliography handle* is just the CSL-JSON serialised as a
    // string. Errors are caught and surfaced as a Lisp error message.

    // `(read-file-text! PATH)` — synchronously read the file at PATH
    // (tilde-expanded by the host) and return its UTF-8 contents as a
    // string. Returns nil on read failure. Used by `cite.lisp`'s
    // `load-bibliography` and available to any Lisp code that needs
    // file content inline.
    'read-file-text!': (args) => {
      const path = String(args[0] ?? '');
      if (path === '') return NIL;
      const text = window.host.readFileTextSync(path);
      return typeof text === 'string' ? text : NIL;
    },
    // `(citation-parse SOURCE)` — parse a bibliographic source (BibTeX,
    // BibLaTeX, CSL-JSON, RIS-via-csl-json, etc. — Citation.js
    // auto-detects from content) and return the CSL-JSON serialisation
    // of its entries. The result is the handle every other citation
    // primitive expects.
    'citation-parse': (args) => {
      const source = String(args[0] ?? '');
      if (source === '') return '';
      try { return parseCitations(source); }
      catch (error) {
        throw new LispError(`citation-parse: ${error.message ?? error}`);
      }
    },
    // `(citation-parse-lenient SOURCE)` — like `citation-parse`, but
    // tolerant: a single entry Citation.js can't parse (e.g. a name field
    // with a bare TeX accent `Fran{\c}ois`) would otherwise throw away the
    // WHOLE bibliography. Returns a record `{:handle CSL-JSON :skipped N}`;
    // N is how many entries were dropped. The RefTeX cite picker uses this
    // so one bad entry never blanks the picker.
    'citation-parse-lenient': (args) => {
      const source = String(args[0] ?? '');
      try {
        const { json, skipped } = parseCitationsLenient(source);
        return record({ handle: json, skipped });
      } catch (error) {
        throw new LispError(`citation-parse-lenient: ${error.message ?? error}`);
      }
    },
    // `(citation-format-bibliography HANDLE [STYLE [FORMAT [LANG]]])`
    // — render every entry in HANDLE as a bibliography. STYLE is a
    // CSL style id (default `*citation-style*` — the Lisp side
    // resolves it before calling here, or passes nil for `apa`).
    // FORMAT is `'text` or `'html`. LANG is a BCP-47 locale.
    'citation-format-bibliography': (args) => {
      const handle = String(args[0] ?? '');
      if (handle === '') return '';
      const style = args[1] != null && args[1] !== NIL ? String(args[1]) : 'apa';
      const format = args[2] != null && args[2] !== NIL ? String(args[2]) : 'text';
      const lang = args[3] != null && args[3] !== NIL ? String(args[3]) : 'en-US';
      try { return formatBibliography(handle, { style, format, lang }); }
      catch (error) {
        throw new LispError(`citation-format-bibliography: ${error.message ?? error}`);
      }
    },
    // `(citation-format HANDLE [STYLE [FORMAT [LANG]]])` — render an
    // in-text citation for the entries in HANDLE. Same arg shape as
    // `citation-format-bibliography`.
    'citation-format': (args) => {
      const handle = String(args[0] ?? '');
      if (handle === '') return '';
      const style = args[1] != null && args[1] !== NIL ? String(args[1]) : 'apa';
      const format = args[2] != null && args[2] !== NIL ? String(args[2]) : 'text';
      const lang = args[3] != null && args[3] !== NIL ? String(args[3]) : 'en-US';
      try { return formatCitation(handle, { style, format, lang }); }
      catch (error) {
        throw new LispError(`citation-format: ${error.message ?? error}`);
      }
    },
    // `(citation-keys HANDLE)` — the BibTeX / CSL-JSON keys present in
    // HANDLE, as a Lisp list of strings. Useful for building a picker.
    'citation-keys': (args) => {
      const handle = String(args[0] ?? '');
      if (handle === '') return NIL;
      try {
        const keys = citationKeys(handle);
        let acc = NIL;
        for (let i = keys.length - 1; i >= 0; i -= 1) acc = cons(keys[i], acc);
        return acc;
      } catch (error) {
        throw new LispError(`citation-keys: ${error.message ?? error}`);
      }
    },
    // `(citation-entries HANDLE)` — a best-effort projection of each
    // entry in HANDLE into a picker-friendly hash-map
    // `{:key :author :year :title}`. `author` is the first author's
    // family (or a "given family" join, or an institutional literal);
    // `year` is the issued year as an integer; missing fields are nil.
    // This drives a citation picker (downstream of this branch).
    'citation-entries': (args) => {
      const handle = String(args[0] ?? '');
      if (handle === '') return NIL;
      try {
        const entries = citationEntries(handle);
        const records = entries.map((e) => {
          const map = new Map();
          map.set(keyword('key'), e.key ?? '');
          map.set(keyword('author'), e.author == null ? NIL : e.author);
          map.set(keyword('year'), e.year == null ? NIL : e.year);
          map.set(keyword('title'), e.title == null ? NIL : e.title);
          return map;
        });
        return arrayToList(records);
      } catch (error) {
        throw new LispError(`citation-entries: ${error.message ?? error}`);
      }
    },
    // `(citation-format-entries HANDLE STYLE)` — format each entry in
    // HANDLE (a parsed-bib handle from `citation-parse`) to HTML via the
    // CSL STYLE, returned as a list of `{:key :html}` records in entry
    // order. The HTML carries the style's inline markup (italics,
    // numbering) so the cite picker can show a professionally formatted
    // reference per row; the inserted text is still `\cite{key}`. STYLE is
    // a template id — a built-in (`apa`/`vancouver`/`harvard1`) or one
    // registered via `citation-register-style!`. Returns nil for an empty
    // handle.
    'citation-format-entries': (args) => {
      const handle = String(args[0] ?? '');
      if (handle === '') return NIL;
      const style = args[1] != null && args[1] !== NIL ? String(args[1]) : 'apa';
      try {
        const entries = formatBibliographyEntries(handle, { style });
        return arrayToList(
          entries.map((e) => record({ key: e.key ?? '', html: e.html ?? '' }))
        );
      } catch (error) {
        throw new LispError(`citation-format-entries: ${error.message ?? error}`);
      }
    },
    // `(citation-format-keys HANDLE KEYS-CSV STYLE)` — format ONLY the
    // entries in HANDLE whose id is in the comma-separated KEYS-CSV, as a
    // list of `{:key :html}`. The cite picker calls this for just the rows
    // it is showing, so a large bibliography is never formatted whole
    // (formatting is the costly step; the cheap key/author/year/title
    // index drives filtering). Unknown keys are silently absent.
    'citation-format-keys': (args) => {
      const handle = String(args[0] ?? '');
      const keysCsv = String(args[1] ?? '');
      if (handle === '' || keysCsv === '') return NIL;
      const style = args[2] != null && args[2] !== NIL ? String(args[2]) : 'apa';
      try {
        const wanted = new Set(
          keysCsv.split(',').map((s) => s.trim()).filter(Boolean)
        );
        const subset = JSON.parse(handle).filter((e) => wanted.has(e.id));
        const entries = formatBibliographyEntries(JSON.stringify(subset), { style });
        return arrayToList(
          entries.map((e) => record({ key: e.key ?? '', html: e.html ?? '' }))
        );
      } catch (error) {
        throw new LispError(`citation-format-keys: ${error.message ?? error}`);
      }
    },
    // `(citation-register-style! XML)` — register a custom CSL style from
    // its XML and return the template id to pass as STYLE to
    // `citation-format-entries`. Lets `*reftex-cite-style*` point at a
    // user-supplied `.csl` file for any style beyond the three built-ins.
    // Idempotent (re-registering a known id is a no-op).
    'citation-register-style!': (args) => {
      const xml = String(args[0] ?? '');
      if (xml === '') return NIL;
      try {
        return registerCslStyle(xml);
      } catch (error) {
        throw new LispError(`citation-register-style!: ${error.message ?? error}`);
      }
    },

    // --- LaTeX / RefTeX host primitives --------------------------------
    // (The pure scanning + path helpers are provided by
    // createLatexPrimitives, spread in above. These need app.js scope:
    // the filesystem, the view list, the process runner, the pdf
    // singleton.)

    // `(file-exists? PATH)` — #t when PATH (tilde-expanded host-side)
    // names an existing file or directory, #f otherwise. Synchronous,
    // mirroring `read-file-text!`. RefTeX uses it to skip \input chains
    // whose targets are absent.
    'file-exists?': (args) => {
      const path = String(args[0] ?? '');
      if (path === '') return false;
      return window.host.fileExistsSync(path) === true;
    },

    // `(view-file-path VIEW)` — the filesystem path associated with
    // VIEW (its buffer's file, or a non-text view's own path), or nil.
    // Thin wrapper over the `viewFilePath` derivation helper.
    'view-file-path': (args) => {
      const path = viewFilePath(args[0]);
      return typeof path === 'string' ? path : NIL;
    },

    // `(set-view-persistent! VIEW BOOL)` — set whether the session
    // restores VIEW across a relaunch. Most non-text views are ephemeral;
    // this opts a specific one (e.g. a latexed-output PDF) back in. BOOL
    // is Lisp-truthy (anything but #f turns it on). Returns BOOL.
    'set-view-persistent!': (args) => {
      const view = args[0];
      const on = args[1] !== false;
      if (view && typeof view === 'object' && 'kind' in view) {
        view.persist = on;
        activeSession().save();
      }
      return on;
    },
    // `(view-persistent? VIEW)` — #t when VIEW is flagged to survive a
    // relaunch, #f otherwise (the default for most non-text views).
    'view-persistent?': (args) => {
      const view = args[0];
      return !!(view && typeof view === 'object' && view.persist === true);
    },

    // `(view-directory VIEW)` — the directory containing VIEW's file,
    // or nil when VIEW has no path. The compile/view loop runs the
    // LaTeX toolchain in this directory.
    'view-directory': (args) => {
      const path = viewFilePath(args[0]);
      return typeof path === 'string' ? pathDirname(path) : NIL;
    },

    // `(run-process! PROGRAM ARGS CWD ON-EXIT)` — spawn PROGRAM (a
    // string) with ARGS (a Lisp list of strings) in CWD (a directory
    // string, or nil for the default). ON-EXIT is a Lisp procedure
    // called once, with one argument: a hash-map
    // `{:stdout STR :stderr STR :code INT-OR-NIL}` (code nil when the
    // process was killed by a signal or failed to spawn). The host
    // spawns with NO shell interpretation. Returns the runId string.
    'run-process!': (args) => {
      const program = String(args[0] ?? '');
      if (program === '') return NIL;
      const argList = args[1] != null && args[1] !== NIL
        ? listToArray(args[1]).map((a) => String(a))
        : [];
      const cwd = args[2] != null && args[2] !== NIL ? String(args[2]) : undefined;
      const onExit = args[3];

      const runId = `run-${nextRunId++}`;
      if (onExit != null && onExit !== NIL) {
        runProcessCallbacks.set(runId, onExit);
      }
      window.host.runProcess(runId, program, argList, cwd ? { cwd } : {});
      return runId;
    },

    // `(pdf-reload! [PATH])` — reload the PDF view after a recompile.
    // A recompile produces the SAME path with NEW bytes, which the
    // pdf-view's same-path load guard would skip; `.reload()` bypasses
    // it. With no PATH, reloads the singleton's current PDF; with a
    // PATH, only reloads when the singleton is showing that file. A
    // no-op (returns nil) when no PDF is open.
    'pdf-reload!': (args) => {
      const current = pdfView.buffer;
      if (!current) return NIL;
      const wanted = args[0] != null && args[0] !== NIL
        ? String(args[0]) : null;
      if (wanted !== null && viewFilePath(current) !== wanted) return NIL;
      if (typeof pdfView.reload === 'function') pdfView.reload();
      return NIL;
    },

    // `(pdf-current-path)` — the filesystem path of the PDF the singleton
    // pdf-view is currently showing, or nil when no PDF is open. Inverse
    // SyncTeX resolves the master/output PDF from this — the clicked PDF
    // is the one on screen, and `synctex edit -o <that.pdf>` resolves the
    // source `Input:` file itself, so no master detection is needed.
    'pdf-current-path': () => {
      const current = pdfView.buffer;
      if (!current) return NIL;
      const path = viewFilePath(current);
      return typeof path === 'string' ? path : NIL;
    },

    // `(pdf-synctex-show! PATH PAGE X Y [W H])` — forward SyncTeX: scroll
    // the singleton PDF (when it is showing PATH) to PAGE and flash a
    // transient highlight at the SyncTeX-reported source spot. X/Y are the
    // click point and W/H the optional box size, all in PDF points (PAGE
    // 1-based). A no-op (returns nil) when no PDF is open or the singleton
    // is showing a different file — mirrors `pdf-reload!`.
    'pdf-synctex-show!': (args) => {
      const current = pdfView.buffer;
      if (!current) return NIL;
      const wanted = args[0] != null && args[0] !== NIL ? String(args[0]) : null;
      if (wanted !== null && viewFilePath(current) !== wanted) return NIL;
      const page = Number(args[1]);
      const x = Number(args[2]);
      const y = Number(args[3]);
      if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
        return NIL;
      }
      const w = args.length > 4 && args[4] !== NIL ? Number(args[4]) : 0;
      const h = args.length > 5 && args[5] !== NIL ? Number(args[5]) : 0;
      if (typeof pdfView.syncTexShow === 'function') {
        // The box anchor is (x, y) here: latex-synctex.lisp passes the
        // box's h/v as X/Y so the highlight covers the box, not just the
        // click point. `h_` avoids clobbering the box-height with the
        // anchor `h`.
        pdfView.syncTexShow(page, x, y, { h: x, v: y, w, h_: h });
      }
      return NIL;
    },

    // The current user's home directory — find-file uses it as the
    // starting point for its TAB-completion path. An empty string is
    // returned when the host does not know the home (unlikely).
    'home-directory': () => HOME,
    // --- snippet support (packages/stdlib/lisp/snippets.lisp) ----------
    // The user's snippet root directory — `<userData>/snippets`. The
    // snippet engine searches `<root>/<mode>/` for trigger files and
    // reads `.yas-parents` from each mode directory. Returns "" when the
    // host can't resolve userData (then only the built-in starter set is
    // available). The directory is not created here — a missing directory
    // simply yields no user snippets.
    'snippet-user-directory': () =>
      USER_DATA_DIR === '' ? '' : `${USER_DATA_DIR}/snippets`,
    // Format a date/time string for the built-in date snippets. KIND is
    // "date" (YYYY-MM-DD), "datetime" (YYYY-MM-DD HH:MM) or "year"
    // (YYYY). Snippet bodies use the backtick forms `date` / `datetime` /
    // `year`, which the engine resolves through this primitive.
    'snippet-date-string': (args) => {
      const kind = String(args[0] ?? 'date');
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ymd =
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      if (kind === 'year') return String(now.getFullYear());
      if (kind === 'datetime') {
        return `${ymd} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      }
      return ymd;
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
    // `(open-file-in-split! PATH [ORIENTATION [SIDE [PERSIST]]])` — the
    // programmatic counterpart to the placeholder-showing `split-*!`
    // primitives: split the focused pane and open PATH directly in the
    // new sibling pane, with no chooser/placeholder and no orphaned-view
    // residue (the source|PDF layout latex-view wants). ORIENTATION is a
    // symbol/keyword `horizontal` (default) / `vertical`; SIDE is `after`
    // (default) / `before`. PERSIST (Lisp-truthy, default #f) flags the
    // opened view session-persistent — threaded here so latex-view can
    // mark its output PDF without racing the async open for the handle.
    // Fires the async open like `open-file-path!` and returns nil (the
    // split lands once the file resolves).
    'open-file-in-split!': (args) => {
      const filePath = expandTilde(String(args[0] ?? ''));
      if (filePath === '') return NIL;
      const orientation =
        symbolNameOf(args[1]) === 'vertical' ? SPLIT_VERTICAL : SPLIT_HORIZONTAL;
      const side = symbolNameOf(args[2]) === 'before' ? 'before' : 'after';
      const persist = args.length > 3 && args[3] !== false && args[3] !== NIL;
      splitAndOpenFile(filePath, orientation, side, persist);
      return NIL;
    },
    // `(set-view-text! NAME TEXT)` — replace the whole text of the text
    // view named NAME, creating it (a fresh text view) if absent, WITHOUT
    // changing the focused pane. The compile loop uses this to update
    // *TeX output* / *TeX errors* in place: the old approach switched the
    // focused pane to the view, set its text, and switched back, which
    // (a) refused + clobbered the current buffer when the view was already
    // shown in another pane (switchToView's guard), and (b) stole focus.
    // A displayed view re-renders via its buffer's change notification.
    // Returns the view, or nil (empty name, or a non-text view of that
    // name we won't clobber).
    'set-view-text!': (args) => {
      const name = String(args[0] ?? '');
      const text = String(args[1] ?? '');
      if (name === '') return NIL;
      const existing = views.find((v) => v.name === name);
      if (existing) {
        if (!existing.buffer) return NIL;
        existing.buffer.setText(text);
        return existing;
      }
      const view = createView({
        kind: 'text',
        buffer: createBuffer(text, { name }),
      });
      views.push(view);
      if (viewListView && typeof viewListView.refresh === 'function') {
        viewListView.refresh();
      }
      return view;
    },
    // Open a directory-tree buffer rooted at `path`. The view lists
    // the directory's entries with FontAwesome icons; folders expand
    // on click; files route through the same open path as the REPL.
    // The path is resolved to a canonical absolute form via expandTilde
    // so '~/Source' works as expected.
    'open-directory-tree!': (args) => {
      const rootPath = expandTilde(String(args[0] ?? ''));
      if (rootPath === '') return NIL;
      const view = ensureDirectoryTreeViewForPath(rootPath);
      switchToViewIndex(views.indexOf(view));
      return NIL;
    },
    // Open a file double-clicked in a directory tree-view, routing it to
    // the pane chosen by TARGET (`*directory-tree-open-target*`): 'editing-
    // pane (the main editing area, default), 'other-pane, or 'this-pane.
    // The tree-view's `directory-tree-open-file` Lisp function calls this.
    'open-file-from-tree!': (args) => {
      const path = String(args[0] ?? '');
      if (path === '') return NIL;
      // TARGET is either a pane id (a string — an explicit wired leaf) or a
      // symbol ('editing-pane / 'other-pane / 'this-pane — the heuristic).
      const raw = args[1];
      const target =
        typeof raw === 'string' && raw !== ''
          ? raw
          : symbolNameOf(raw) || 'editing-pane';
      openFileFromTree(path, target);
      return NIL;
    },
    // The pane id the current dir-tree opens files into (wired by the
    // project), or nil — read by the `directory-tree-open-file` Lisp fn.
    'current-directory-tree-target': () => {
      const treeView = projectDirTreeView();
      const id = treeView && treeView.openTargetPaneId;
      return typeof id === 'string' && id !== '' ? id : NIL;
    },
    // Wire the current dir-tree to open files into pane PANE-ID (a leaf id),
    // or clear it with nil. Lets Lisp point a tree at a specific pane.
    'set-directory-tree-target!': (args) => {
      const treeView = projectDirTreeView();
      if (!treeView) return NIL;
      const raw = args[0];
      treeView.openTargetPaneId =
        raw == null || raw === NIL || raw === '' ? null : String(raw);
      return NIL;
    },
    // Mark the current pane focusable (#t) or passive (#f). A passive pane
    // never becomes the active pane — clicking still works (the view acts
    // on the active pane), but focus stays in the editing area. This is how
    // Lisp builds Nova-style sidebars. Making the current pane passive moves
    // focus to the next focusable pane.
    'set-pane-focusable!': (args) => {
      if (currentPaneId === null) return NIL;
      const focusable = args[0] !== false; // only an explicit #f is passive
      paneFocusOverride.set(currentPaneId, focusable);
      if (!focusable) focusNextPane();
      refreshPaneFocusIndicators();
      return NIL;
    },
    // #t when the current pane is focusable, #f when it's passive.
    'pane-focusable?': () =>
      currentPaneId !== null && !isNoFocusPane(currentPaneId),
    // Open the bookmark outline for the current text buffer (C-x r l) in
    // a narrow pane to the RIGHT of the focused pane — a navigator, so the
    // source buffer stays visible (jump from the outline moves it). If the
    // outline is already shown anywhere, reuse that pane (re-target +
    // focus it) instead of splitting again; otherwise split the focused
    // pane side-by-side (the source — a leaf view OR a whole tabline —
    // rides into the left child, the outline into the new right child).
    'open-bookmark-view!': () => {
      const buf = currentTextBuffer;
      if (!buf) return NIL;
      const view = ensureBookmarkView();
      retargetBookmarkView(buf);
      const shownLeaf = leafPanes(rootPane).find((leaf) => leaf.view === view);
      if (shownLeaf) {
        setCurrentPaneId(shownLeaf.id);
        return NIL;
      }
      const focused = currentPane();
      if (focused && focused.kind === 'leaf') {
        // ratio is the FIRST (source) child's share; bias narrow-right.
        splitPaneAtLeafWith(focused, SPLIT_HORIZONTAL, 0.7, 'after', view);
      } else {
        switchToViewIndex(views.indexOf(view));
      }
      return NIL;
    },
    // Show the directory picker; on confirm, open the chosen directory as
    // a project workspace. Returns immediately — the workspace is built
    // when the dialog resolves (mirrors `prompt-directory!`).
    'open-project!': () => {
      window.host
        .openDirectory()
        .then((path) => {
          if (path === null) return;
          return openProject(path);
        })
        .catch((error) => {
          repl.appendError(error.lispMessage ?? error.message ?? String(error));
        });
      return NIL;
    },
    // Open a specific directory as a project, no picker — for scripting
    // and tests. `(open-project-at! "~/Source/btt")`.
    'open-project-at!': (args) => {
      const root = String(args[0] ?? '');
      if (root === '') return NIL;
      openProject(root).catch((error) => {
        repl.appendError(error.lispMessage ?? error.message ?? String(error));
      });
      return NIL;
    },
    // Close the open project and return to the home session. A no-op when
    // no project is open.
    'close-project!': () => {
      closeProject().catch((error) => {
        repl.appendError(error.lispMessage ?? error.message ?? String(error));
      });
      return NIL;
    },
    // The open project's absolute root, or nil in the home session. A data
    // accessor (no `!`) — the chooser and modeline can read it.
    'current-project': () => (activeProjectPath === null ? NIL : activeProjectPath),
    // Open the Project Chooser launcher modal — a grid of known projects
    // (thumbnails + search) to pick from, plus Open Folder / Add Project.
    'open-project-chooser!': () => {
      showProjectChooser();
      return NIL;
    },
    // Open the *View List* — a clickable HTML table of every open view
    // (the replacement for the old text *Buffer List*). There is one
    // such view; this finds or creates it, switches the current pane to
    // it, and refreshes its rows so they reflect the live view list.
    'open-view-list!': () => {
      const view = ensureViewListView();
      switchToViewIndex(views.indexOf(view));
      viewListView.refresh();
      return NIL;
    },
    // Re-scan the crash-recovery snapshots and open the *Recover* view —
    // the manual entry point to the same flow the startup scan runs. The
    // scan is async; the view opens once it resolves (showing an
    // empty-state when there is nothing to recover).
    'recover-session!': () => {
      scanForRecovery().then(openRecoverView);
      return NIL;
    },
    // --- Utility pane (the tabbed bottom dock) -------------------------
    // Open (or reuse) a utility panel as a tab. FACTORY selects a
    // registered factory; ID is the tab id (defaults to FACTORY, i.e. a
    // single instance); TITLE is the tab label (defaults to ID). So one
    // 'output' factory can back several tabs ("tex-output", "tex-errors").
    // Does NOT steal focus (informational) — use utility-panel-activate! /
    // -focus! to bring it forward. Returns the tab id, or NIL if no such
    // factory.
    'utility-panel-open!': (args) => {
      const factoryName = String(args[0] ?? '');
      const id = args[1] != null && args[1] !== NIL ? String(args[1]) : factoryName;
      const title = args[2] != null && args[2] !== NIL ? String(args[2]) : id;
      const factory = utilityPanelFactories.get(factoryName);
      if (!factory) {
        repl.appendError(`utility-panel-open!: no panel "${factoryName}"`);
        return NIL;
      }
      utilityDock.openUtilityPanel({
        id,
        title,
        makePanel: (handle) => factory(handle, { title }),
        focus: false,
      });
      return id;
    },
    // Bring the named tab forward (creating focus on it). No-op if absent.
    'utility-panel-activate!': (args) => {
      utilityDock.activateUtilityTab(String(args[0] ?? ''));
      return NIL;
    },
    // Append TEXT to the named panel's log (streaming output). No-op if the
    // panel isn't open or doesn't accept appends.
    'utility-panel-append!': (args) => {
      const panel = utilityDock.getPanel(String(args[0] ?? ''));
      if (panel && typeof panel.appendOutput === 'function') {
        panel.appendOutput(String(args[1] ?? ''));
      }
      return NIL;
    },
    // Replace the named panel's content with TEXT.
    'utility-panel-set!': (args) => {
      const panel = utilityDock.getPanel(String(args[0] ?? ''));
      if (panel && typeof panel.setContent === 'function') {
        panel.setContent(String(args[1] ?? ''));
      }
      return NIL;
    },
    // Close the named tab (no-op for the non-closable resident REPL).
    'utility-panel-close!': (args) => {
      utilityDock.closeUtilityTab(String(args[0] ?? ''));
      return NIL;
    },
    // Focus the active utility tab's panel.
    'utility-panel-focus!': () => {
      utilityDock.focusUtilityPane();
      return NIL;
    },
    // Cycle the active utility tab by DELTA (wraps); default +1.
    'utility-cycle-tab!': (args) => {
      const n = Number(args[0]);
      utilityDock.cycleUtilityTab(Number.isFinite(n) && n !== 0 ? n : 1);
      return NIL;
    },
    // Open the *RefTeX Select* picker as a right-edge drawer overlaid on
    // the editor (the document stays visible underneath). RefTeX's
    // reftex-reference uses this as the selection-first path; the panel
    // reads its rows through reftex-select-candidates and its keys call
    // back into reftex-select-on-{select,peek,cancel}. SPC-peek navigates
    // the editor pane UNDER the overlay (the bug the old pane-takeover
    // form couldn't fix). See `openReftexSelectOverlay`.
    'open-reftex-select!': () => {
      openReftexSelectOverlay();
      return NIL;
    },
    // RefTeX R3 citation flow (bottom dock). `open-reftex-cite-format!`
    // opens the format menu (\cite / \citep / …); choosing one runs
    // reftex-cite-format-chosen, which calls `open-reftex-cite-select!` —
    // and because a dock is already up, that SWAPS it in place for the
    // cite picker. The picker reads its rows via reftex-cite-select-rows
    // and inserts via reftex-cite-insert.
    'open-reftex-cite-format!': () => {
      openReftexCiteFormat();
      return NIL;
    },
    'open-reftex-cite-select!': () => {
      openReftexCiteSelect();
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
    // Open a gnuplot buffer: a long-lived gnuplot child shown through
    // the L4 gnuplot view (a notebook REPL — per-command cells over an
    // input line). The process is spawned by the host on first mount and
    // killed when the view is killed. Like `open-shell-buffer!`, each
    // call creates a new view; switch to an existing one with C-x b.
    'open-gnuplot-buffer!': () => {
      const sessionId = nextGnuplotSessionId();
      const sequence = views.filter((v) => v.kind === 'gnuplot').length + 1;
      const name = sequence === 1 ? '*gnuplot*' : `*gnuplot*<${sequence}>`;
      views.push(createView({
        kind: 'gnuplot',
        name,
        extras: {
          sessionId,
          ended: false,
          spawned: false,
        },
      }));
      switchToViewIndex(views.length - 1);
      return NIL;
    },
    // Open a reactive Lisp notebook: a sheet of `(cell NAME EXPR)` cells
    // shown through the L4 notebook view, where editing one cell
    // recomputes everything downstream. Like `open-gnuplot-buffer!`,
    // each call creates a fresh view; switch to an existing one with
    // C-x b. In-memory for now (M2); a `.rxlisp` file backing comes with
    // persistence (M3).
    'open-notebook-buffer!': () => {
      const notebookId = nextNotebookId();
      const sequence = views.filter((v) => v.kind === 'notebook').length + 1;
      const name = sequence === 1 ? '*notebook*' : `*notebook*<${sequence}>`;
      views.push(createView({
        kind: 'notebook',
        name,
        // The canonical `(cell …)` source lives in buffer.text so the
        // generic save path works once the user gives it a file.
        buffer: { text: '', filePath: null, name },
        extras: { notebookId },
      }));
      switchToViewIndex(views.length - 1);
      return NIL;
    },
    // The current notebook's id, or nil. Captured by the rename command
    // *before* it prompts, so the rename targets the right notebook even
    // after the minibuffer moves focus.
    'current-notebook-id': () => {
      const view = session.currentView;
      return view && view.kind === 'notebook' && typeof view.notebookId === 'string'
        ? view.notebookId
        : NIL;
    },
    // Rename the notebook with this id (display + buffer name; the file on
    // disk is unchanged — use save-as to rename that).
    'rename-notebook-by-id!': (args) => {
      renameNotebookById(String(args[0] ?? ''), String(args[1] ?? ''));
      return NIL;
    },
    // Cycle among open notebooks (also reachable via the header picker).
    'next-notebook!': () => {
      cycleNotebook(1);
      return NIL;
    },
    'previous-notebook!': () => {
      cycleNotebook(-1);
      return NIL;
    },
    // Open a Finder-style column-view buffer rooted at `path`. Same
    // re-use semantics as `open-directory-tree!`.
    'open-directory-columns!': (args) => {
      const rootPath = expandTilde(String(args[0] ?? ''));
      if (rootPath === '') return NIL;
      const view = ensureDirectoryColumnsViewForPath(rootPath);
      switchToViewIndex(views.indexOf(view));
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
      openDocInPane(name);
      return NIL;
    },
    // Open the manual at its Top node (the table-of-contents root), so the
    // doc-view's sidebar/breadcrumb/Next-Prev are anchored at the top. The
    // top id comes from the loaded node tree; the manual's known root slug
    // is the fallback before the manifest has arrived (readDocPage resolves
    // a node id either way).
    'open-manual!': () => {
      openDocInPane((docNavTree && docNavTree.top) || 'the-jmacs-manual');
      return NIL;
    },
    // Open URL in a browser-kind view. Creates the view, pushes it onto
    // the global list, switches to it, returns nil. The page title
    // overwrites `view.name` once the webview reports it.
    'open-url!': (args) => {
      const url = String(args[0] ?? '').trim();
      if (url === '') return NIL;
      const current = session.currentView;
      // If the active pane already shows a browser, navigate THAT one in
      // place — don't spawn a duplicate browser view (and don't yank a
      // browser element over from another pane). Find the live element
      // showing this view (the leaf-direct singleton or a per-tab
      // instance) and repaint it at the new URL.
      if (current && current.kind === 'browser') {
        current.url = url;
        current.name = url;
        const el = browserElementByView.get(current);
        if (el) el.setBuffer(current);
        updateModeline();
        notifyViewsChanged();
        return NIL;
      }
      // The active pane isn't a browser — open a fresh browser there.
      const view = createView({
        kind: 'browser',
        name: url,
        extras: { url },
      });
      views.push(view);
      notifyViewsChanged();
      switchToViewIndex(views.length - 1);
      return NIL;
    },
    // `(pdf-extract-text [callback])` — extract the text of the
    // currently-visible page of the PDF view in the focused pane.
    //
    // PDF.js's text-content API is async, so the primitive returns nil
    // immediately. CALLBACK is invoked with `(text page-num)` once the
    // text is ready; without a callback the text is appended to the
    // REPL. CALLBACK can be a symbol naming a global procedure or a
    // procedure value (a lambda).
    //
    // Errors land in the REPL — the asynchrony means we can't raise
    // them through the original primitive call. Synchronous validation
    // (no PDF in focus, document still loading) does throw.
    'pdf-extract-text': (args) => {
      const view = session.currentView;
      if (!view || view.kind !== 'pdf') {
        throw new LispError(
          'pdf-extract-text: no PDF view in the focused pane'
        );
      }
      const el = elementForViewInstance(view);
      if (el === null || typeof el.extractPageText !== 'function') {
        throw new LispError('pdf-extract-text: PDF view not mounted');
      }
      const pageNum = el.currentPageNumber;
      if (pageNum < 1) {
        throw new LispError('pdf-extract-text: document still loading');
      }
      const cb = args[0];
      el.extractPageText(pageNum).then((text) => {
        if (cb !== undefined && cb !== NIL) {
          deliverLispCallback(cb, [text, pageNum], 'pdf-extract-text');
          return;
        }
        repl.appendOutput(text);
        if (text.length > 0 && !text.endsWith('\n')) repl.appendOutput('\n');
      }).catch((error) => {
        repl.appendError(
          `pdf-extract-text: ${error.message ?? error}`
        );
      });
      return NIL;
    },
    // `(pdf-extract-page-range M N [callback])` — extract pages M
    // through N (inclusive, 1-based) of the focused-pane PDF view.
    // CALLBACK is invoked with `(texts m last)` once every page is
    // resolved, where `texts` is a list of strings; without a callback,
    // the pages are appended to the REPL with `--- page N ---`
    // separators. Range bounds are clamped to the document; an
    // inverted range raises.
    'pdf-extract-page-range': (args) => {
      const m = Math.floor(Number(args[0]));
      const n = Math.floor(Number(args[1]));
      if (!Number.isFinite(m) || !Number.isFinite(n) || m < 1 || n < m) {
        throw new LispError(
          `pdf-extract-page-range: invalid range (${args[0]} .. ${args[1]})`
        );
      }
      const view = session.currentView;
      if (!view || view.kind !== 'pdf') {
        throw new LispError(
          'pdf-extract-page-range: no PDF view in the focused pane'
        );
      }
      const el = elementForViewInstance(view);
      if (el === null || typeof el.extractPageRangeText !== 'function') {
        throw new LispError('pdf-extract-page-range: PDF view not mounted');
      }
      const pageCount = el.pageCount;
      if (pageCount < 1) {
        throw new LispError(
          'pdf-extract-page-range: document still loading'
        );
      }
      const last = Math.min(n, pageCount);
      const cb = args[2];
      el.extractPageRangeText(m, last).then((texts) => {
        if (cb !== undefined && cb !== NIL) {
          deliverLispCallback(
            cb, [arrayToList(texts), m, last], 'pdf-extract-page-range'
          );
          return;
        }
        for (let i = 0; i < texts.length; i += 1) {
          repl.appendOutput(`--- page ${m + i} ---\n${texts[i]}\n`);
        }
      }).catch((error) => {
        repl.appendError(
          `pdf-extract-page-range: ${error.message ?? error}`
        );
      });
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

    // Face customisation: write the COMPLETE faces.json — colour
    // overrides + user-created faces + highlight rules — in one blob.
    // The Lisp side passes `(current-faces-file)`; we serialise all
    // three sections (lists are unfolded via listToArray for the rules).
    'write-faces!': (args) => {
      const facesFile = args[0];
      try {
        const json = lispToJsonFacesFile(facesFile, lispFactories, listToArray);
        window.host.writeFaces(json);
      } catch (error) {
        repl.appendError(
          `faces:write: ${error.lispMessage ?? error.message}`
        );
      }
      return NIL;
    },
    // Highlight customisation: receive the user's `kind -> face` rule
    // set from Lisp (highlight-rules.lisp) and push it into the live
    // highlighter store. Each ARG[0] element is a record with :scope
    // ("mode" | "language"), :key (mode display name / language tag),
    // :pattern (a tree-sitter node type or query fragment), and :face
    // (a registered face name). The store recompiles the affected
    // languages' queries lazily at the next highlight; we re-render the
    // open editors so the change is visible immediately.
    'set-highlight-overrides!': (args) => {
      const list = args[0];
      const entries = [];
      try {
        for (const rec of listToArray(list)) {
          if (!(rec instanceof Map)) continue;
          const scope = rec.get(keyword('scope'));
          const key = rec.get(keyword('key'));
          const pattern = rec.get(keyword('pattern'));
          const face = rec.get(keyword('face'));
          entries.push({
            scope: typeof scope === 'string' ? scope : 'language',
            key: key == null ? '' : String(key),
            pattern: pattern == null ? '' : String(pattern),
            face: face == null ? '' : String(face),
          });
        }
        highlightOverrideStore.replaceAll(entries);
        rerenderAllEditors();
      } catch (error) {
        repl.appendError(
          `highlight-overrides: ${error.lispMessage ?? error.message}`
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
    // the current buffer's text at or after FROM, or `#f` for no
    // match (miss convention: absence -> #f, safe as a bare if-test).
    // An invalid pattern is also `#f` — deliberately the same value
    // as a miss, because these back incremental search, where a
    // half-typed regexp ("[a-") simply matches nothing.
    'find-regexp-forward': (args) => {
      const source = String(args[0] ?? '');
      const from = Number(args[1] ?? 0);
      const regexp = compileRegexpSource(source);
      if (regexp === null) return false;
      const match = regexpForwardMatch(currentTextBuffer.text, regexp, from);
      return match === null ? false : cons(match.start, match.end);
    },
    'find-regexp-backward': (args) => {
      const source = String(args[0] ?? '');
      const from = Number(args[1] ?? 0);
      const regexp = compileRegexpSource(source);
      if (regexp === null) return false;
      const match = regexpBackwardMatch(currentTextBuffer.text, regexp, from);
      return match === null ? false : cons(match.start, match.end);
    },
    // Find a plain (non-regexp) string FROM offset onward; used by the
    // `query-replace` walker (plain string match, per spec). No match
    // — including an empty needle — is `#f`.
    'find-string-forward': (args) => {
      const needle = String(args[0] ?? '');
      const from = Number(args[1] ?? 0);
      if (needle === '') return false;
      const index = currentTextBuffer.text.indexOf(needle, Math.max(0, from));
      return index < 0 ? false : cons(index, index + needle.length);
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
    // `(point-line-col)` — the cursor's 1-based line and column in the
    // current text buffer, as a cons `(LINE . COL)`. The buffer reports
    // a 0-based line/column from `positionAt(point)`; we add 1 to each so
    // both match the 1-based convention SyncTeX (and the status bar) use.
    // Returns nil when no text buffer is current. Used by forward search
    // (`synctex view -i LINE:COL:file`).
    'point-line-col': () => {
      const buffer = currentTextBuffer;
      if (!buffer || typeof buffer.positionAt !== 'function') return NIL;
      const { line, column } = buffer.positionAt(buffer.point);
      return cons(line + 1, column + 1);
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
    // `(flash-current-line!)` — briefly highlight the cursor's line with a
    // transient mild-yellow band that fades out, to call attention to it
    // (SyncTeX inverse search uses it on the landed source line).
    'flash-current-line!': () => {
      if (typeof editorView.flashCurrentLine === 'function') {
        editorView.flashCurrentLine();
      }
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
      utilityDock.toggleUtilityDock();
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
      openCustomize('*Customize*', { group: 'godot' });
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

    // Bookmarks — see bookmarks.js and bookmarks.lisp.
    'bookmark-set!': (args) => {
      const name = bookmarks.set(String(args[0]));
      return name === null ? NIL : name;
    },
    'bookmark-jump!': (args) => {
      bookmarks.jump(String(args[0]));
      return NIL;
    },
    'bookmark-delete!': (args) => {
      bookmarks.remove(String(args[0]));
      return NIL;
    },
    'bookmark-names': () => arrayToList(bookmarks.names()),
    'bookmark-count': () => bookmarks.count(),

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
          // The command is finishing — drop the transient completions tab
          // (a no-op when none is open, e.g. RefTeX/LaTeX prompts).
          utilityDock.closeUtilityTab(COMPLETIONS_TAB_ID);
          editorView.focus();
          interpreter.call('minibuffer-delivered', value);
        },
        onCancel() {
          utilityDock.closeUtilityTab(COMPLETIONS_TAB_ID);
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
/** Format a Lisp error for display: its message, plus the source location
 *  of the offending form when the evaluator tagged one (B6) — so a failing
 *  multi-line definition says *where*, not just *what*. */
function formatLispError(error) {
  const message = error?.lispMessage ?? error?.message ?? String(error);
  const loc = error?.location;
  return loc ? `${message} (at line ${loc.line}:${loc.col})` : message;
}

function evaluateInRepl(source) {
  try {
    repl.appendResult(writeString(interpreter.evaluate(source)));
  } catch (error) {
    repl.appendError(formatLispError(error));
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
  // One-time: a custom.lisp saved before the `light` → `solarized-light`
  // theme rename selects a now-gone theme; rewrite and re-save it. A no-op
  // once migrated, and for any other persisted theme value.
  try {
    interpreter.call('-migrate-stale-theme!');
  } catch (error) {
    repl.appendError(`theme migration: ${error.lispMessage ?? error.message}`);
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

/**
 * Report any standard-library files that failed to load. `loadStdlib`
 * isolates each file, so a broken one no longer aborts the rest — but the
 * user still needs to know which file failed (and that its commands are
 * gone), so name each one in the REPL.
 *
 * @param {{name: string, phase: string, error: Error}[]} failures
 */
function reportStdlibFailures(failures) {
  if (!failures || failures.length === 0) return;
  for (const { name, error } of failures) {
    repl.appendError(
      `stdlib: ${name} failed to load — ${error.lispMessage ?? error.message}`
    );
  }
  repl.appendError(
    `stdlib: ${failures.length} file(s) failed to load; the rest loaded. ` +
      'Commands defined in the failed file(s) are unavailable.'
  );
}

/** Re-evaluate the standard library — hot reload of the editor itself. */
async function reloadStdlib() {
  try {
    const { failures } = await loadStdlib(
      interpreter,
      fetchStdlibSource,
      stdlibOptions
    );
    reportStdlibFailures(failures);
    // Reapply face hooks + state: a fresh stdlib reset all of them.
    // Re-register user faces FIRST (overrides/rules may reference them).
    installFacePersistence();
    if (userFacesCache !== null) {
      interpreter.call('set-user-faces!', userFacesCache);
    }
    if (faceOverridesCache !== null) {
      interpreter.evaluate('(set-face-overrides! (load-face-overrides!))');
    }
    // Re-install the user highlight rules into the freshly-built stdlib
    // (a reload reset *highlight-rules* to empty) and re-push them so the
    // live highlighter keeps the user's overrides.
    installHighlightRules();
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
  // The saver writes the WHOLE faces.json — colour overrides, user-
  // created faces, and highlight rules — so both the face-change and
  // highlight-rule-change paths (which share this hook) persist
  // everything in one atomic write.
  interpreter.evaluate(
    '(set-face-overrides-saver! (lambda () (write-faces! (current-faces-file))))'
  );
}

/** Install the persisted user highlight rules into the (freshly-loaded)
 *  stdlib and push them into the live highlighter. A no-op-but-safe push
 *  of the empty set when nothing was persisted. Called after the first
 *  stdlib load and after every reload-stdlib (which resets the Lisp
 *  `*highlight-rules*`). */
function installHighlightRules() {
  try {
    if (highlightRulesCache !== null) {
      interpreter.call('set-highlight-rules!', highlightRulesCache);
    } else {
      interpreter.call('push-highlight-rules!');
    }
  } catch (error) {
    repl.appendError(
      `highlight-rules: ${error.lispMessage ?? error.message}`
    );
  }
}

/** Things that want a callback when the editor theme changes. The
 *  shell view registers itself once it exists so xterm.js can
 *  rebuild its palette. Must sit above the first top-level
 *  `applyCurrentTheme()` call below — `applyCurrentTheme` is a
 *  function declaration (hoisted) but this is a `const` (in TDZ
 *  until evaluated), so the call would otherwise crash before the
 *  declaration runs. */
const themeListeners = new Set();

// `keymapReady` is declared near the top of the module (the pane-focus
// machinery reads it during the initial paint); set it here once the
// stdlib has loaded.
try {
  // Per-file isolation: a single broken stdlib file is reported and
  // skipped, not allowed to abort the load and leave the editor with no
  // keymap. The outer catch is now only a backstop for a catastrophic
  // failure (e.g. the source fetch itself is broken).
  const { failures } = await loadStdlib(
    interpreter,
    fetchStdlibSource,
    stdlibOptions
  );
  keymapReady = true;
  reportStdlibFailures(failures);
} catch (error) {
  repl.appendError(`standard library failed to load: ${error.message}`);
}

// Faces: read faces.json (or get null if it's missing) and install into
// the Lisp face system before the first paint. The stdlib has already
// loaded `faces.lisp` + `highlight-rules.lisp`, so the mutators exist.
// We install in dependency order: USER FACES first (so colour overrides
// and highlight rules can reference them), then the colour overrides.
// The highlight rules are installed later (`installHighlightRules`, once
// the override store + highlighters exist) from `highlightRulesCache`.
if (keymapReady) {
  installFacePersistence();
  try {
    const json = await window.host.readFaces();
    faceOverridesCache = jsonToLispOverrides(json, lispFactories);
    userFacesCache = jsonToLispUserFaces(json, lispFactories);
    highlightRulesCache = jsonToLispHighlightRules(
      json,
      lispFactories,
      arrayToList,
      cons
    );
    interpreter.call('set-user-faces!', userFacesCache);
    interpreter.evaluate('(set-face-overrides! (load-face-overrides!))');
  } catch (error) {
    repl.appendError(
      `faces: failed to load overrides — ${error.lispMessage ?? error.message}`
    );
  }
}

if (keymapReady) await loadUserConfig();

// Sync the `--tab-width` CSS variable with the live *tab-width*
// setting. Runs after stdlib + user config load so a user-customised
// value lands here. The `on-change` hook (installed via
// `custom-on-change!` below) keeps the var in sync afterwards.
if (keymapReady) {
  try {
    const value = interpreter.evaluate('*tab-width*');
    interpreter.call('set-css-tab-width!', value);
    // Install an on-change hook so subsequent customise edits update
    // the CSS var. The Lisp side stores the hook in the *custom-registry*;
    // we wrap a host-side closure as a Lisp lambda via `eval`.
    interpreter.evaluate(`
      (set! *custom-registry*
        (assoc *custom-registry* '*tab-width*
          (assoc (get *custom-registry* '*tab-width* {})
                 :on-change (lambda (_n v) (set-css-tab-width! v)))))
    `);
  } catch (error) {
    repl.appendError(`tab-width sync failed: ${error.lispMessage ?? error.message}`);
  }
}
// Sync the editor line-height CSS var from *line-height* on startup; the
// defcustom's on-change keeps it current after customise edits.
if (keymapReady) {
  try {
    interpreter.call('set-css-line-height!', interpreter.evaluate('*line-height*'));
  } catch { /* an old config without the setting — the CSS default stands */ }
}
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
    if (manifest === null) return;
    docManifestNames = manifest.names;
    // The navigation node tree (TeXinfo-style): hand it to the doc-view so
    // it can render the sidebar, breadcrumb, and Next/Prev/Up. If the Manual
    // panel is already open (docs opened before the manifest resolved), push
    // the tree to it now.
    if (manifest.nodes && manifest.top) {
      docNavTree = {
        nodes: manifest.nodes,
        top: manifest.top,
        // Without `roots` the doc-view's sidebar falls back to rendering
        // the top root alone — the reference tiers and the Lisp guide
        // disappear from the TOC.
        roots: Array.isArray(manifest.roots) ? manifest.roots : [],
        order: Array.isArray(manifest.order) ? manifest.order : [],
      };
      // Hand the tree to any doc panes already open (manifest resolved
      // after a doc was opened).
      broadcastDocManifest();
    }
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
// The live store of user-defined `kind -> face` highlight rules. Built
// before the highlighters so each one can consult it (rules are applied
// on top of the base grammar query, recompiled live). The Lisp side
// (highlight-rules.lisp) pushes rules in through `set-highlight-overrides!`.
const highlightOverrideStore = createHighlightOverrideStore();
const { highlighters, foldCaptures } = await loadLanguageHighlighters(
  createTreeSitterHighlighter,
  (tag, error) => {
    repl.appendError(`${tag} highlighter unavailable: ${error.message}`);
  },
  highlightOverrideStore
);
document.body.dataset.treesitter = Object.keys(highlighters).join(',');

// --- G2: route ONE real view through the Model-B server -----------------
//
// plans/MWB-GRADUATION.md §G2 + the leaf-flip. With GODOT_SERVER=1, route the
// FOCUSED LEAF's own real editor view (the real `<text-view>` / `createEditorView`,
// the real highlighters loaded just above, the real `keyEventToString`) through
// the server: it opens the server's seed buffer through a HELLO/SNAPSHOT, builds
// a ClientBuffer mirror, makes `leaf.view` a live façade over that mirror, and
// lets the EXISTING pane render show the leaf's `<text-view>` from it. Keystrokes
// route to the server (onKey → intent → delta/view-update → mirror → re-render).
// No overlay: the leaf's own view IS the server view (the reverted Step A tried
// a foreign overlay element and lost to the render loop). Broad coverage (splits,
// multi-window) is G3/G4; this binds ONE leaf.
//
// ‼ FLAG-OFF IS BYTE-FOR-BYTE TODAY: this whole block is gated on
// `window.host.serverMode` (the G1 gate, false by default). When false,
// `serverViewClient` stays null, no client mounts, `leaf.view` is never
// re-pointed, and the in-renderer interpreter drives everything exactly as
// today. The only shared-pipeline touch-points — `serverViewKeyOption` and the
// `getDecorations` guard in `ensureEditorViewForLeaf` — both short-circuit to
// their original behaviour when `serverMode` is false, so there is zero risk to
// the flag-off path.
let serverViewClient = null;
// --- the shared server-view façade (server mode only; inert flag-off) -------
// In server mode the focused leaf becomes a tabline of the server's open
// buffers (Increment 2). The client mirrors only ONE buffer at a time — the
// ACTIVE one — so there is ONE shared façade view whose getters read the single
// live mirror; it always occupies the tabline's active slot, with the other
// server buffers shown as lightweight proxy tabs (labels only, no live
// content). `serverMirror` is null and `serverFacadeView` is never tabbed
// flag-off, so every render branch keyed on `isServerBackedView` is a no-op in
// the normal editor.
let serverMirror = null;
const serverFacadeView = {
  id: 'server-facade',
  kind: 'text',
  _serverBacked: true,
  get buffer() { return serverMirror; },
  get name() { return serverMirror ? serverMirror.name : '*server*'; },
  get point() { return serverMirror ? serverMirror.point : 0; },
  get mark() { return serverMirror ? serverMirror.mark : null; },
  get cursors() { return serverMirror ? serverMirror.cursors : [{ point: 0, mark: null }]; },
};
if (window.host && window.host.serverMode) {
  // The leaf-flip (plans/MWB-GRADUATION.md): the server drives the focused
  // leaf's OWN `<text-view>` through the real pane pipeline — NOT a separate
  // full-bleed overlay. We make `leaf.view` a live façade over the mirror and
  // let `ensureEditorViewForLeaf` + the existing tabline/warehouse/sync render
  // show it; panes/splits/tabs/multi-window then inherit server-backing for
  // free. The id of the leaf this client's mirror is bound to, captured on the
  // first mount so a buffer switch re-points the SAME leaf.
  let serverBoundLeafId = null;

  /** The live leaf this client is bound to, or null before the first mount /
   *  if it was deleted. */
  function serverBoundLeaf() {
    if (serverBoundLeafId === null) return null;
    return leafPanes(rootPane).find((l) => l.id === serverBoundLeafId) ?? null;
  }

  // The lightweight proxy tabs (id/name/dirty only, never mounted) a leaf-tabline
  // shows for its inactive tabs — only the active tab carries content. Keyed by
  // buffer id, shared across this window's tabline leaves.
  /** @type {Map<string, object>} bufferId -> proxy tab view (label only). */
  const serverTabProxies = new Map();

  // G4 Step 3 — the last pane-layout the server pushed. EVERY window renders its
  // leaf layout from this PANE_TREE (the unify); the wire tree is
  // `{kind:'split',orientation,ratio,first,second}` /
  // `{kind:'leaf',id,bufferId,focused,name,point,mark,tabline?,tabs?}` (no pixels).
  let serverPaneTreeWire = null;
  // Step 3b: per-buffer STATIC mirrors for panes showing a DIFFERENT buffer than
  // the focused/active one. Seeded + refreshed from each PANE_TREE leaf's `text`
  // (not live deltas — they update on a structural/focus change, which is when a
  // background buffer can change in THIS window). Same-buffer panes use the live
  // shared serverMirror instead. Pruned to the currently-shown set each reconcile.
  /** @type {Map<string, object>} bufferId -> static ClientBuffer. */
  const serverStaticBuffers = new Map();
  // Step 3c: per-leaf tabline-views, keyed by the server leaf id. A leaf flagged
  // `tabline` in the PANE_TREE renders as a real tabline-view of its OWN curated
  // tabs (NOT the window's whole buffer set). Reused across reconciles so its
  // tablineState / per-tab elements survive a focus-only re-render; disposed when
  // the leaf vanishes or flips back to a single view.
  /** @type {Map<string, object>} leafId -> tabline-view. */
  const serverLeafTablines = new Map();
  // The STABLE active-tab view for a tabline leaf, keyed by leaf id and updated
  // in place each reconcile — so its per-tab `<text-view>` element is reused
  // (keyed by view identity in editorByChild) instead of churned. ONE object per
  // leaf serves BOTH focus states (makeLeafTabView flips it LIVE↔STATIC), so a
  // focus change never swaps the tab between two elements with independent scroll
  // — the leaf-flip fix (#2). Used for focused AND non-focused tabline leaves.
  /** @type {Map<string, object>} leafId -> stable active-tab view (live-or-static). */
  const serverLeafActiveTabViews = new Map();
  // Non-text DATA-SOURCE views (image/audio/video/pdf), keyed by the server
  // source id. A media leaf/tab carries `viewKind` + `filePath` on the wire; the
  // client builds the matching element-view here and loads the bytes itself via
  // window.host.openFilePath (the server never reads them). Reused across
  // reconciles (the element survives a focus-only re-render); pruned when the
  // source is no longer shown.
  /** @type {Map<string, object>} sourceId -> element-view object. */
  const serverMediaViews = new Map();

  /** Map a window.host.openFilePath result to createView options for the matching
   *  element-view — MIRRORS openAsMediaViewIfRecognised's per-kind extras (image
   *  / audio / video / pdf), without pushing into the global `views` list. Null
   *  when the result isn't a recognised media shape. */
  function serverMediaViewSpec(result) {
    if (!result || typeof result !== 'object') return null;
    if (typeof result.imageSrc === 'string') {
      return { kind: 'image', name: result.name, extras: { filePath: result.path, src: result.imageSrc } };
    }
    if (result.mediaKind === 'audio') {
      return { kind: 'audio', name: result.name, extras: {
        filePath: result.path, src: result.src,
        ...(result.metadata ? { metadata: result.metadata } : {}),
        ...(result.albumArtSrc ? { albumArtSrc: result.albumArtSrc } : {}),
      } };
    }
    if (result.mediaKind === 'video') {
      return { kind: 'video', name: result.name, extras: { filePath: result.path, src: result.src } };
    }
    if (result.pdfKind === true) {
      return { kind: 'pdf', name: result.name, extras: { filePath: result.path, src: result.src, persist: true } };
    }
    return null;
  }

  /** Load a media source's bytes (via the main process) and bind them onto its
   *  element-view. Async — the view mounts immediately (blank) and repaints when
   *  the src arrives; an already-mounted element is re-bound, else the next
   *  reconcile mounts it with the src. Tolerant: a failed load just leaves blank. */
  async function loadServerMediaSrc(view, filePath) {
    if (!filePath || !window.host || typeof window.host.openFilePath !== 'function') return;
    let result;
    try { result = await window.host.openFilePath(filePath); } catch { return; }
    const spec = serverMediaViewSpec(result);
    if (!spec) return;
    Object.assign(view, spec.extras); // src (+ audio metadata / album art)
    if (typeof result.name === 'string') view.name = result.name;
    const el = elementForViewInstance(view);
    if (el && typeof el.setBuffer === 'function') {
      try { el.setBuffer(view); } catch { /* ignore */ }
    } else if (serverPaneTreeWire) {
      renderServerPaneLayout(); // not mounted yet → reconcile mounts it with the src
    }
  }

  /** Build (or reuse) the element-view for a media data-source leaf/tab (Step:
   *  data-sources). Keyed by the source id so its element survives reconciles;
   *  the bytes load asynchronously (loadServerMediaSrc). Marked `_serverMedia`
   *  so the reconcile mounts it via mountKindView (the existing element pipeline). */
  function buildServerMediaView(w) {
    let v = serverMediaViews.get(w.bufferId);
    if (!v) {
      // A DIRECTORY data-source (directory-tree / directory-columns) reads the
      // filesystem itself from `rootPath` — no bytes to load. An ELEMENT
      // data-source carries its spec (tag / moduleUrl / attrs / fit / keyboard /
      // noFocus) on the wire `state`; <element-view> reads those spread onto the
      // view. A media source (image/audio/video/pdf) loads its bytes from
      // `filePath` asynchronously.
      const directoryKind =
        w.viewKind === 'directory-tree' || w.viewKind === 'directory-columns';
      const elementKind = w.viewKind === 'element';
      const jukeboxKind = w.viewKind === 'jukebox';
      const bookmarkKind = w.viewKind === 'bookmark';
      let extras;
      if (bookmarkKind) {
        // The outline of a text buffer's bookmarks. The server holds the records
        // (each at its edit-tracked offset + line/column); the view renders them
        // and sends semantic ops back. Refreshed below on every reconcile so a
        // fanned-out edit re-renders (the mutable-source seam).
        const s = (w.state && typeof w.state === 'object') ? w.state : {};
        extras = {
          records: Array.isArray(s.records) ? s.records : [],
          sourceName: typeof s.sourceName === 'string' ? s.sourceName : '',
          sourceBufferId: s.sourceBufferId ?? null,
        };
      } else if (elementKind) {
        const s = (w.state && typeof w.state === 'object') ? w.state : {};
        extras = {
          tag: s.tag,
          moduleUrl: s.moduleUrl,
          attrs: Array.isArray(s.attrs) ? s.attrs : [],
          fit: s.fit,
          keyboard: s.keyboard,
          noFocus: s.noFocus === true,
        };
      } else if (directoryKind) {
        extras = { rootPath: w.filePath, expanded: new Set() };
      } else if (jukeboxKind) {
        // The server lists the directory's audio files + album art; the client
        // formats per-track labels (the same Lisp helper + audio-metadata IPC as
        // flag-off) and plays tracks via media:// URLs (jukebox-view).
        const s = (w.state && typeof w.state === 'object') ? w.state : {};
        const dir = typeof s.dir === 'string' ? s.dir : '';
        const tracks = Array.isArray(s.tracks) ? s.tracks : [];
        extras = {
          dir,
          tracks,
          art: typeof s.art === 'string' ? s.art : null,
          labels: tracks.map((t) => formatTrackLabel(joinPath(dir, t))),
          // refresh (g) re-reads the dir — deferred in server mode (v1 is
          // immutable; the mutable-source seam would re-scan + restate).
          refresh: () => {},
          // quit (q) stops playback; the pane itself closes via the tabline ×.
          quit: () => { try { audio.stop(); } catch { /* ignore */ } },
        };
      } else {
        extras = { filePath: w.filePath };
      }
      v = createView({
        kind: w.viewKind,
        name: w.name || `*${w.viewKind}*`,
        extras,
      });
      v._serverMedia = true;
      v._serverSourceId = w.bufferId;
      // The tab click / close handlers resolve a tab to a server id via
      // `_serverBufferId` (the same field a proxy tab carries), so a media /
      // directory / element / jukebox tab is switchable / closable like any other.
      v._serverBufferId = w.bufferId;
      serverMediaViews.set(w.bufferId, v);
      // Only media needs an async byte-load; directory / element / jukebox /
      // bookmark render themselves from the spec / state.
      if (!directoryKind && !elementKind && !jukeboxKind && !bookmarkKind) {
        loadServerMediaSrc(v, w.filePath);
      }
    }
    // The bookmark outline is a MUTABLE data-source: refresh the (possibly
    // REUSED) view's records from the latest wire state on EVERY reconcile, so a
    // fanned-out edit (setState → PANE_TREE) re-renders. The reconcile re-mounts
    // the leaf → mountKindView → el.setBuffer(view), which repaints from these.
    // This is the mutable-source client seam — lit here first.
    if (w.viewKind === 'bookmark') {
      const s = (w.state && typeof w.state === 'object') ? w.state : {};
      v.records = Array.isArray(s.records) ? s.records : [];
      v.sourceName = typeof s.sourceName === 'string' ? s.sourceName : '';
      v.sourceBufferId = s.sourceBufferId ?? null;
    }
    return v;
  }

  /** Get-or-create the lightweight proxy tab for server buffer B (id/name only;
   *  never mounted — only the active buffer's façade tab has an element). */
  function ensureServerProxy(b) {
    let p = serverTabProxies.get(b.id);
    if (!p) {
      p = {
        id: `srvtab-${b.id}`, kind: 'text', _serverBacked: true,
        _serverBufferId: b.id, buffer: null, point: 0, mark: null,
        name: b.name, _modified: !!b.modified, filePath: b.filePath ?? null,
      };
      serverTabProxies.set(b.id, p);
    } else {
      p.name = b.name; p._modified = !!b.modified; p.filePath = b.filePath ?? null;
    }
    return p;
  }

  /** G4 Step 1 — the single-pane (fresh window) mount. The leaf's OWN
   *  `<text-view>` renders the mirror via the shared façade — NO tabline. This
   *  is the original leaf-flip mount: the façade is a text view, so the real
   *  pane pipeline mounts it with no fight, and the user composes the window
   *  from here (open a file / add a tabline-view). A fresh window opens this
   *  way on its own *scratch*; window 1 keeps the tabline. */
  /** A STATIC server-backed leaf view — a NON-focused pane in a split. It reads
   *  the SHARED mirror for text (3a assumes the panes share the active buffer;
   *  per-buffer mirrors are 3b) but carries its OWN cursor from the server's
   *  pane-tree leaf data. The FOCUSED leaf instead uses the live serverFacadeView
   *  (its cursor tracks the mirror as you type). */
  function makeServerStaticLeafView(wire) {
    const point = Number.isFinite(wire.point) ? wire.point : 0;
    const mark = wire.mark === null || Number.isFinite(wire.mark) ? wire.mark : null;
    return {
      kind: 'text',
      _serverBacked: true,
      buffer: serverMirror,
      name: typeof wire.name === 'string'
        ? wire.name
        : (serverMirror ? serverMirror.name : '*server*'),
      point,
      mark,
      cursors: [{ point, mark }],
    };
  }

  /** The focused leaf id in a wire pane-tree (the server marks exactly one). */
  function wireFocusedId(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.kind === 'leaf') return node.focused ? node.id : null;
    return wireFocusedId(node.first) ?? wireFocusedId(node.second);
  }

  /** Walk every leaf of a wire pane-tree. */
  function forEachWireLeaf(node, fn) {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'leaf') { fn(node); return; }
    forEachWireLeaf(node.first, fn);
    forEachWireLeaf(node.second, fn);
  }

  /** The id of the active buffer (the focused leaf's buffer = the live mirror),
   *  or null before the first snapshot. */
  function activeServerBufferId() {
    return serverViewClient ? serverViewClient.currentBufferId() : null;
  }

  /** Get-or-create the STATIC ClientBuffer for a different-buffer leaf, seeding /
   *  refreshing it from the leaf's wire `text`. The buffer is display-only (its
   *  text is server-pushed via PANE_TREE, never edited locally); a switch to
   *  this pane re-binds it to the live mirror. */
  function serverStaticBufferFor(wire) {
    const text = typeof wire.text === 'string' ? wire.text : '';
    let buf = serverStaticBuffers.get(wire.bufferId);
    if (!buf) {
      buf = createClientBuffer({
        initialText: text,
        name: wire.name || '*buffer*',
        point: Number.isFinite(wire.point) ? wire.point : 0,
        sendIntent: () => {}, // display-only; edits route through the server
      });
      serverStaticBuffers.set(wire.bufferId, buf);
    } else if (buf.text !== text) {
      // Refresh in place (keep the object so mounted views stay subscribed).
      try {
        buf.applyResync({
          text,
          cursors: [{ point: Number.isFinite(wire.point) ? wire.point : 0, mark: wire.mark ?? null }],
        });
      } catch { /* tolerant */ }
    }
    return buf;
  }

  /** A static view over a given buffer (the focused/same-buffer panes use the
   *  live serverFacadeView / shared mirror; this is for a DIFFERENT buffer). */
  function makeServerStaticBufferView(wire, buf) {
    const point = Number.isFinite(wire.point) ? wire.point : 0;
    const mark = wire.mark === null || Number.isFinite(wire.mark) ? wire.mark : null;
    return {
      kind: 'text',
      _serverBacked: true,
      buffer: buf,
      name: typeof wire.name === 'string' ? wire.name : (buf ? buf.name : '*buffer*'),
      point,
      mark,
      cursors: [{ point, mark }],
    };
  }

  /** The live `<text-view>` element rendering the FOCUSED leaf — the leaf's own
   *  editor instance, or (a tabline focused leaf) the façade element in its
   *  active tab. Null before the first mount. Used by the focused-leaf adapter
   *  (focus / recenter / pageLines) and the reconcile's focus-restore. */
  function focusedServerLeafElement() {
    const leaf = leafPanes(rootPane).find((l) => l.id === currentPaneId);
    if (!leaf) return null;
    if (isTablineView(leaf.view)) {
      const st = tablineStateByView.get(leaf.view);
      if (!st) return null;
      // The focused tabline's active text tab is now its per-leaf view object
      // (makeLeafTabView), not the shared façade — resolve its element via the
      // active child (st.activeEditor is the same element, kept as a fallback).
      const active = tablineActiveChild(leaf.view);
      return st.editorByChild.get(active) ?? st.activeEditor ?? null;
    }
    return editorViewByPaneId.get(leaf.id) ?? null;
  }

  /** A per-leaf active-tab view object for a server tabline's TEXT tab. ONE of
   *  these exists per tabline leaf (cached in serverLeafActiveTabViews), so the
   *  tab's `<text-view>` element is REUSED — and its scrollTop preserved — across
   *  focus changes. It flips between LIVE (focused: tracks the shared mirror, like
   *  the old façade, so typing re-renders without a reconcile) and STATIC (not
   *  focused: a snapshot at the wire point/buffer) via `_live`, but stays the SAME
   *  object throughout. This is the leaf-flip fix (#2): focus no longer swaps the
   *  active tab between two elements (the shared façade vs a static view) with
   *  independent scroll, which had scrolled the document to the top when a
   *  sibling pane (e.g. the bookmark outline) took focus. */
  function makeLeafTabView() {
    return {
      kind: 'text',
      _serverBacked: true,
      _live: false,
      _staticBuffer: null,
      _staticPoint: 0,
      _staticMark: null,
      _serverBufferId: null,
      _name: null,
      // LIVE → the shared mirror (point/cursors track typing); STATIC → the wire
      // snapshot. Getters so the SAME object serves both without churning.
      get buffer() { return this._live ? serverMirror : this._staticBuffer; },
      get name() {
        const b = this._live ? serverMirror : this._staticBuffer;
        return this._name ?? (b ? b.name : '*buffer*');
      },
      get point() {
        return this._live ? (serverMirror ? serverMirror.point : 0) : this._staticPoint;
      },
      get mark() {
        return this._live ? (serverMirror ? serverMirror.mark : null) : this._staticMark;
      },
      get cursors() {
        return this._live
          ? (serverMirror ? serverMirror.cursors : [{ point: 0, mark: null }])
          : [{ point: this._staticPoint, mark: this._staticMark }];
      },
    };
  }

  /** The content view for a tabline leaf's ACTIVE text tab: the STABLE per-leaf
   *  object above, bound LIVE when focused (tracks the mirror) or STATIC when not
   *  (a snapshot mirroring buildServerPaneNode's non-focused branches — a buffer
   *  DIFFERENT from the active one reads its own static text (3b); the SAME buffer
   *  reads the live shared mirror (3a), so a tabline split off the focused pane
   *  isn't empty). The inactive tabs are lightweight proxies; only the active tab
   *  carries content. A non-text active tab (media) mounts its element-view. */
  function serverLeafActiveTabView(w) {
    if (w.viewKind && w.viewKind !== 'text') return buildServerMediaView(w);
    let v = serverLeafActiveTabViews.get(w.id);
    if (!v) { v = makeLeafTabView(); serverLeafActiveTabViews.set(w.id, v); }
    v._live = !!w.focused;
    v._serverBufferId = w.bufferId ?? null;
    v._name = typeof w.name === 'string' ? w.name : null;
    if (!v._live) {
      v._staticBuffer =
        (w.bufferId && w.bufferId !== activeServerBufferId() && typeof w.text === 'string')
          ? serverStaticBufferFor(w) // 3b: a different buffer, its own snapshot text
          : serverMirror;            // 3a: the same buffer as active, the live mirror
      v._staticPoint = Number.isFinite(w.point) ? w.point : 0;
      v._staticMark = w.mark === null || Number.isFinite(w.mark) ? w.mark : null;
    }
    return v;
  }

  /** Build (or reuse) the tabline-view for a `tabline` leaf (Step 3c): one tab
   *  per id in the leaf's OWN curated `tabs` list — the active tab is the live
   *  façade (focused) or a static view (non-focused), every other tab a
   *  lightweight proxy (label only). Reused by leaf id so its tablineState
   *  survives a reconcile. Marked `_serverLeafTabline` so the tab click / close
   *  handlers route through the server (focus-pane + switch / close-tab). */
  function buildServerLeafTabline(w) {
    const tabs = Array.isArray(w.tabs) ? w.tabs : [];
    const activeId = w.bufferId;
    let tlv = serverLeafTablines.get(w.id);
    if (!tlv) {
      tlv = createView({ kind: 'tabline', extras: { tabs: [], active: 0, edge: 'top' } });
      tlv._serverLeafTabline = true;
      tlv._serverLeafId = w.id;
      serverLeafTablines.set(w.id, tlv);
    }
    const activeTextView = serverLeafActiveTabView(w);
    tlv.tabs = tabs.map((t) => {
      // A MEDIA tab uses its element-view whether active or not (like a real
      // tabline's non-text tabs) — a consistent object across reconciles, so
      // switching media↔media doesn't churn a proxy in over the view (which left
      // the new tab unswitchable / unloaded). Only the active tab is shown; the
      // others mount hidden.
      if (t.viewKind && t.viewKind !== 'text') {
        return buildServerMediaView({
          bufferId: t.bufferId, viewKind: t.viewKind, name: t.name, filePath: t.filePath,
        });
      }
      // A text tab: the active one is the façade/static content; the rest proxies.
      return t.bufferId === activeId
        ? activeTextView
        : ensureServerProxy({
            id: t.bufferId, name: t.name, modified: t.modified, filePath: t.filePath,
          });
    });
    const activeIdx = tabs.findIndex((t) => t.bufferId === activeId);
    tlv.active = activeIdx >= 0 ? activeIdx : 0;
    return tlv;
  }

  /** Build a client pane node from the server's wire pane-tree, reusing the
   *  server's stable leaf/split ids (so paneElements survive a focus-only
   *  reconcile). A `tabline` leaf becomes a real tabline-view of its own curated
   *  tabs (3c); else the focused leaf gets the live façade; a same-buffer pane a
   *  static view over the live mirror (3a); a DIFFERENT-buffer pane a static
   *  view over its own buffer seeded from the tree's text (3b). */
  function buildServerPaneNode(wire) {
    if (wire && wire.kind === 'split') {
      const ratio =
        typeof wire.ratio === 'number' && wire.ratio > 0.05 && wire.ratio < 0.95
          ? wire.ratio : 0.5;
      return createSplitPane({
        id: wire.id,
        orientation: wire.orientation === 'vertical' ? SPLIT_VERTICAL : SPLIT_HORIZONTAL,
        ratio,
        first: buildServerPaneNode(wire.first),
        second: buildServerPaneNode(wire.second),
      });
    }
    const w = wire || {};
    let view;
    if (w.tabline) {
      view = buildServerLeafTabline(w); // 3c: a tabline of this leaf's own tabs
    } else if (w.viewKind && w.viewKind !== 'text') {
      // A bare non-text data-source pane: media (image/audio/video/pdf) or a
      // directory-view (directory-tree / directory-columns).
      view = buildServerMediaView(w);
    } else if (w.focused) {
      view = serverFacadeView; // the live active buffer
    } else if (w.bufferId && w.bufferId !== activeServerBufferId() && typeof w.text === 'string') {
      view = makeServerStaticBufferView(w, serverStaticBufferFor(w)); // 3b: a different buffer
    } else {
      view = makeServerStaticLeafView(w); // 3a: same buffer, over the live mirror
    }
    return createLeafPane({ id: w.id, view });
  }

  /** Reconcile the client's pane tree to the server's PANE_TREE: rebuild
   *  rootPane, drop editor instances for leaves that vanished, mount each leaf's
   *  <text-view>, lay out, and focus the server's focused leaf. Splits become
   *  visible; C-x 2/3/0/1/o drive the layout through the server. */
  function reconcileServerPaneTree() {
    if (!serverPaneTreeWire) return;
    rootPane = buildServerPaneNode(serverPaneTreeWire);
    // Prune static buffers no longer shown as a different-buffer pane.
    const activeId = activeServerBufferId();
    const stillStatic = new Set();
    const tablineLeafIds = new Set();
    const shownMedia = new Set();
    forEachWireLeaf(serverPaneTreeWire, (lf) => {
      if (lf.tabline) tablineLeafIds.add(lf.id);
      // A leaf whose ACTIVE content is a media source (a bare media pane, or a
      // tabline leaf whose active tab is media) carries `viewKind`; a tabline's
      // media TABS (active or not) each keep their element-view, so keep all of
      // them (their views are reused across reconciles).
      if (lf.viewKind && lf.viewKind !== 'text') shownMedia.add(lf.bufferId);
      if (Array.isArray(lf.tabs)) {
        for (const t of lf.tabs) {
          if (t.viewKind && t.viewKind !== 'text') shownMedia.add(t.bufferId);
        }
      }
      if (!lf.focused && lf.bufferId && lf.bufferId !== activeId && typeof lf.text === 'string') {
        stillStatic.add(lf.bufferId);
      }
    });
    for (const id of [...serverStaticBuffers.keys()]) {
      if (!stillStatic.has(id)) serverStaticBuffers.delete(id);
    }
    // Drop element-views for media sources no longer shown as an active view.
    for (const id of [...serverMediaViews.keys()]) {
      if (!shownMedia.has(id)) serverMediaViews.delete(id);
    }
    // Dispose tabline-views whose leaf vanished or flipped back to a single view
    // (toggle-tabline off / delete-pane), so no orphan strip lingers.
    for (const [id, tlv] of serverLeafTablines) {
      if (!tablineLeafIds.has(id)) {
        try { disposeTablineKind(tlv); } catch { /* ignore */ }
        serverLeafTablines.delete(id);
        serverLeafActiveTabViews.delete(id);
      }
    }
    // Tear down editor instances for leaves the new tree no longer has (an
    // unsplit / delete-pane), so nothing renders behind the new layout.
    const liveIds = new Set(leafPanes(rootPane).map((l) => l.id));
    for (const [id, inst] of editorViewByPaneId) {
      if (!liveIds.has(id)) {
        try { inst.destroy(); } catch { /* ignore */ }
        try { inst.remove(); } catch { /* ignore */ }
        editorViewByPaneId.delete(id);
      }
    }
    currentPaneId = wireFocusedId(serverPaneTreeWire)
      ?? leafPanes(rootPane)[0]?.id ?? null;
    serverBoundLeafId = currentPaneId;
    syncPaneElements();
    for (const leaf of leafPanes(rootPane)) {
      if (isTablineView(leaf.view)) {
        // A leaf that just flipped text→tabline still has its leaf-direct
        // <text-view> mounted behind the new strip — unlink it (TextView.destroy
        // nulls the inner editor but leaves the host element), then mount the
        // tabline via its own pipeline (mountKindView, not the text path).
        const stale = editorViewByPaneId.get(leaf.id);
        if (stale) {
          try { stale.destroy(); } catch { /* ignore */ }
          try { stale.remove(); } catch { /* ignore */ }
          editorViewByPaneId.delete(leaf.id);
        }
        mountKindView(leaf.view, { paneEl: paneElements.get(leaf.id) });
        // ensureTabElement reuses the active tab's element but doesn't re-bind it;
        // re-point it at its (in-place-updated) view so a non-focused tab reflects
        // content/cursor changes — and a 3a→3b (or focus) flip rebinds its buffer.
        const st = tablineStateByView.get(leaf.view);
        const activeChild = tablineActiveChild(leaf.view);
        if (st && activeChild) {
          const el = st.editorByChild.get(activeChild);
          // A text tab re-binds via setView; a media tab (image/audio/video/pdf
          // element) has no setView — re-bind it via setBuffer so swapping one
          // media tab in over another actually re-points the element.
          if (el && typeof el.setView === 'function') {
            try { el.setView(activeChild); } catch { /* ignore */ }
          } else if (el && typeof el.setBuffer === 'function') {
            try { el.setBuffer(activeChild); } catch { /* ignore */ }
          }
        }
      } else if (leaf.view && leaf.view._serverMedia) {
        // A bare media pane (image/audio/video/pdf): mount the element-view via
        // the existing per-kind pipeline (mountKindView). A media tab inside a
        // tabline is handled by the tabline branch above (per-tab element).
        const stale = editorViewByPaneId.get(leaf.id);
        if (stale) {
          try { stale.destroy(); } catch { /* ignore */ }
          try { stale.remove(); } catch { /* ignore */ }
          editorViewByPaneId.delete(leaf.id);
        }
        // A bookmark outline re-mounts on EVERY reconcile (its records refresh on
        // fan-out); only focus it when it is the focused leaf, so a `C-x r m`
        // from the document — which refreshes the open outline — doesn't yank
        // focus off the document. Other media keep the old always-focus behaviour.
        const focus = !(leaf.view.kind === 'bookmark' && leaf.id !== currentPaneId);
        mountKindView(leaf.view, { paneEl: paneElements.get(leaf.id), focus });
      } else if (leaf.view && leaf.view.kind === 'text') {
        const inst = ensureEditorViewForLeaf(leaf);
        if (inst) { try { inst.setView(leaf.view); } catch { /* ignore */ } }
      }
    }
    // A bare media pane mounts the per-kind SINGLETON (image/audio/video/pdf),
    // which starts display:none — the singleton mount path doesn't reveal it
    // (unlike the named-kind branches). hideInactiveSingletons shows whichever
    // singleton a leaf now displays directly and hides the rest; without it a
    // media pane (e.g. in a second window) renders blank. A no-op for a text /
    // tabline-only window (no leaf-direct singleton in use).
    hideInactiveSingletons();
    relayoutPanes();
    refreshPaneFocusIndicators();
    // A reconcile that REPLACED the focused leaf's element (toggle-tabline
    // flipping it to/from a tabline destroys the old <text-view>) orphans
    // keyboard focus to <body>. Restore it to the focused leaf's element — but
    // ONLY when focus is genuinely orphaned, so an open minibuffer/picker (whose
    // input holds focus) is never stolen from. A buffer switch re-focuses via the
    // SNAPSHOT path instead, so this is a no-op there (activeElement is the view).
    if (document.activeElement === document.body || document.activeElement === null) {
      const el = focusedServerLeafElement();
      if (el && typeof el.focus === 'function') {
        try { el.focus(); } catch { /* ignore */ }
      }
    }
  }

  /** Single-leaf fallback before the first PANE_TREE arrives (the SNAPSHOT beats
   *  it on HELLO): the leaf's own <text-view> over the façade, no tabline. */
  function mountServerSingleFallback() {
    const leaf = serverBoundLeaf() ?? currentPane() ?? leafPanes(rootPane)[0];
    if (!leaf) return;
    serverBoundLeafId = leaf.id;
    currentPaneId = leaf.id;
    leaf.view = serverFacadeView;
    const inst = ensureEditorViewForLeaf(leaf);
    if (inst) { try { inst.setView(serverFacadeView); } catch { /* ignore */ } }
  }

  /** Render a 'single' window's layout: the server pane-tree if present, else
   *  the single-leaf fallback. Called on the first mount + each PANE_TREE. */
  function renderServerPaneLayout() {
    if (serverPaneTreeWire) reconcileServerPaneTree();
    else mountServerSingleFallback();
  }

  /** The mountView adapter for a 'single' window: it always resolves the CURRENT
   *  focused leaf's <text-view> (dynamic), so it survives a reconcile (a split /
   *  focus change rebuilds the tree, but focus/scroll still target the right
   *  pane). */
  function makeServerFocusedLeafAdapter() {
    // The focused leaf's live element — a plain leaf's editor instance, or (a
    // tabline focused leaf) the façade element in its active tab.
    const focusedInstance = focusedServerLeafElement;
    return {
      setView: () => { const i = focusedInstance(); if (i) { try { i.setView(i.boundView ?? serverFacadeView); } catch { /* ignore */ } } },
      focus: () => { const i = focusedInstance(); if (i) { try { i.focus(); } catch { /* ignore */ } } },
      recenter: () => { const i = focusedInstance(); if (i) { try { i.recenter(); } catch { /* ignore */ } } },
      pageLines: () => { const i = focusedInstance(); try { return i ? i.pageLines() : 0; } catch { return 0; } },
      destroy: () => { /* soft */ },
    };
  }

  /** A server PANE_TREE push: store it and render the new layout — splits appear
   *  / collapse, a tabline leaf re-renders. Every window renders from its
   *  PANE_TREE now (the unify); a push before the first mirror is just stored. */
  function applyServerPaneTree(tree) {
    serverPaneTreeWire = tree;
    if (serverMirror) renderServerPaneLayout();
  }

  /** The `mountView` collaborator. A SNAPSHOT (re)points the shared mirror; the
   *  window then renders its pane layout from the server's PANE_TREE (the unify:
   *  EVERY window is a composable pane layout — window 1 a tabline leaf of its
   *  restored files, fresh windows a single scratch pane; one render path). */
  function mountServerView(mirror) {
    serverMirror = mirror;
    // The startup splash (the faint Lisp backdrop) is dismissed by an edit /
    // view-switch — none of which fire for a fresh server window, so it lingered
    // behind the empty *scratch* (the "(cond" ghost). The server drives the view
    // now, so retire it. Idempotent.
    dismissSplash();
    renderServerPaneLayout();
    return makeServerFocusedLeafAdapter();
  }

  // Define the boot hook the init-time port listener calls (or that we call
  // here, whichever runs second — the highlighters are ready now, so if the
  // port already connected we boot immediately below).
  // The server-driven DOM chrome (server-mode only): the modeline, the echo
  // area / pending-prefix, the minibuffer prompt, and the generic picker panel
  // — all driven from the server's VIEW / PICKER messages. The real editor's
  // own in-renderer chrome is idle behind the G2 overlay, so these drive the
  // SAME DOM nodes (modeline footer + minibuffer host) the user already sees.
  let g2PickerHost = null;
  let g2PickerPanel = null;
  function closeServerPicker() {
    if (g2PickerPanel) { try { g2PickerPanel.destroy(); } catch { /* ignore */ } }
    if (g2PickerHost && g2PickerHost.parentNode) {
      g2PickerHost.parentNode.removeChild(g2PickerHost);
    }
    g2PickerPanel = null;
    g2PickerHost = null;
  }
  // After a minibuffer/picker closes, keyboard focus must return to the
  // server-routed view or the next keystroke goes nowhere. The client exposes
  // the mounted <text-view> via getView(); refocus it on the next tick (after
  // the close handler finishes blurring the input).
  function refocusServerView() {
    const v = serverViewClient && serverViewClient.getView();
    if (v && typeof v.focus === 'function') {
      requestAnimationFrame(() => {
        // A CHAINED prompt (M-x → a command that itself prompts, e.g.
        // directory-tree) closes the M-x prompt and opens a new one in the same
        // burst: close → schedule this refocus → open + focus the new input.
        // If that new prompt is up by the time this fires, don't steal its focus
        // back to the editor (the bug: the chained prompt needed a click).
        if (minibuffer.isOpen()) return;
        try { v.focus(); } catch { /* ignore */ }
      });
    }
  }
  const serverChrome = {
    // The server bakes the modeline string (renderModeline). Show it whole in
    // the name slot; the line:col is already inside the string, so the position
    // slot is cleared (the server is authoritative for it now).
    setModeline: (modeline) => {
      nameEl.textContent = modeline;
      positionEl.textContent = '';
      document.title = `${modeline} — Godot`;
    },
    // The echo area: a mid-chord prefix (e.g. "C-x-") or a one-off status. The
    // minibuffer component reuses its row as the echo area when no prompt is up.
    setEcho: (status) => minibuffer.setStatus(status ?? ''),
    // A server-suspended minibuffer read: open the real minibuffer; its input
    // routes back up as MINIBUFFER_* intents (the spine resumes the command).
    // On submit/cancel, return focus to the server view so typing resumes.
    openMinibuffer: (prompt, value, cbs) => {
      minibuffer.prompt(prompt, {
        initialValue: value ?? '',
        onChange: (v) => cbs.onChange(v),
        onSubmit: (v) => {
          utilityDock.closeUtilityTab(COMPLETIONS_TAB_ID);
          cbs.onSubmit(v); refocusServerView();
        },
        onCancel: () => {
          utilityDock.closeUtilityTab(COMPLETIONS_TAB_ID);
          cbs.onCancel(); refocusServerView();
        },
        // TAB: ask the server to complete the path (find-file, case-insensitive).
        // The reply (showCompletions below) fills the input + shows candidates;
        // returning undefined leaves the input unchanged until then.
        onTab: (v) => { if (serverViewClient) serverViewClient.requestMinibufferComplete(v); },
      });
    },
    closeMinibuffer: () => {
      utilityDock.closeUtilityTab(COMPLETIONS_TAB_ID);
      minibuffer.close(); refocusServerView();
    },
    // The server's TAB-completion reply: fill the minibuffer with the completed
    // value and show the candidate list (find-file). The minibuffer keeps focus.
    showCompletions: ({ value, items, directory }) => {
      if (typeof value === 'string') minibuffer.setValue(value);
      displayCompletionsPanel(Array.isArray(items) ? items : [], directory ?? '');
    },
    // The generic picker (buffer list, M-x, RefTeX, completions): an overlay
    // panel; the choice/cancel routes back up as PICKER_* intents.
    openPicker: (request, cbs) => {
      closeServerPicker(); // one picker at a time
      g2PickerHost = document.createElement('div');
      g2PickerHost.className = 'mwb-picker-overlay';
      document.body.appendChild(g2PickerHost);
      g2PickerPanel = createPickerPanel(g2PickerHost, {
        request,
        onChoose: (v) => { cbs.onChoose(v); closeServerPicker(); refocusServerView(); },
        onCancel: () => { cbs.onCancel(); closeServerPicker(); refocusServerView(); },
      });
    },
    closePicker: closeServerPicker,
    // The server's open-buffer set (a BUFFER_LIST push). Every window renders its
    // tabs from the PANE_TREE now, so this just keeps the *View List* table in
    // step (it reads server-sourced viewListRecords); the leaf-tabline strips
    // refresh on the PANE_TREE reconcile.
    setBufferList: () => {
      if (viewListView && typeof viewListView.refresh === 'function') viewListView.refresh();
    },
    // C-x C-c: the client resolves the quit chord (the server can't close the
    // window); run the normal interactive quit (flush + host.quit()).
    requestQuit: () => quitInteractive(),
    // C-x 5 2: the server resolved the new-window command and asked us to open
    // another window onto the shared server. host.newWindow() → main creates +
    // attaches it as a new client. (Guarded: only present in server mode.)
    requestNewWindow: () => {
      if (window.host && typeof window.host.newWindow === 'function') {
        window.host.newWindow();
      }
    },
    // G4 Step 3: the server pushed this window's pane layout. Render it (splits
    // become visible). Only a 'single' (fresh / composable) window reflects the
    // server tree; window 1 keeps its tabline.
    setPaneTree: (tree) => applyServerPaneTree(tree),
  };

  bootServerViewClient = () => {
    if (serverViewClient || !godotServerPort) return;
    serverViewClient = createServerViewClient({
      port: godotServerPort,
      mountView: mountServerView,
      highlighters,
      foldCaptures,
      keyEventToString,
      chrome: serverChrome,
      // Re-report the viewport line count when the window resizes (the dock
      // hiding/showing, an OS resize), so a screenful (C-v/M-v) tracks the
      // live pane height. Returns an unsubscribe the client calls on destroy.
      subscribeResize: (report) => {
        window.addEventListener('resize', report);
        return () => window.removeEventListener('resize', report);
      },
      // The renderer owns element-view commands (define-element-view, incl.
      // user config): announce their names so the server's M-x routes them
      // back down (RUN_CLIENT_COMMAND), and run them here when it does.
      clientCommandNames: elementViewCommandNames,
      runClientCommand: (name, bibPath) => {
        try {
          // bib-search can't see the active document in server mode (the
          // renderer session is inert), so the server resolved its bibliography
          // and sent it here. Pin it via the override the command consults; a
          // null clears any stale pin. Defensive: a missing var (bib-search not
          // loaded) must not block the command run.
          const v = typeof bibPath === 'string' && bibPath !== ''
            ? writeString(bibPath) : 'nil';
          try { interpreter.evaluate(`(set! *bib-search-doc-override* ${v})`); }
          catch { /* bib-search lisp not loaded — fine */ }
          interpreter.evaluate(`(run-command (quote ${name}))`);
        } catch (error) {
          repl.appendError(
            `run ${name}: ${error.lispMessage ?? error.message ?? error}`
          );
        }
      },
    });
    serverViewClient.connect();
    console.info('[godot] G2: real view routed through the server');
    // A tiny, serverMode-only test hook so the flag-gated electron self-test
    // (mwb/server-view-selftest.js) can drive a key into the server-routed
    // view and read the mirror back — no production code reads this. It is
    // never defined flag-off (this whole block is gated on serverMode).
    window.__godotG2 = {
      dispatchKey: (k) => serverViewClient.dispatchKey(k),
      mirrorText: () => {
        const m = serverViewClient.getMirror();
        return m ? m.text : null;
      },
      isMounted: () => serverViewClient.getView() != null,
      bufferId: () => serverViewClient.currentBufferId(),
      // The single-live-view invariant probe: how many <text-view> elements
      // sit in the bound leaf's pane. Must stay 1 across a buffer switch
      // (find-file / C-x b / kill-buffer) — the leaf-flip re-points the SAME
      // leaf/instance, so the count never grows. The multibuffer self-test
      // asserts it, and the architect can eyeball it after opening a file.
      textViewCount: () => {
        const leaf = serverBoundLeaf();
        const paneEl = leaf ? paneElements.get(leaf.id) : null;
        return paneEl ? paneEl.querySelectorAll('text-view').length : 0;
      },
      // Feed a synthetic SNAPSHOT for a DIFFERENT buffer through the real
      // client → onSnapshot → mountServerView path, so the self-test can prove
      // the real-app buffer switch re-mirrors + keeps exactly one live view
      // WITHOUT driving the minibuffer DOM. This is the same message the server
      // sends on find-file/switch; only the bufferId differs from the seed, so
      // onSnapshot treats it as a switch.
      simulateSwitch: (text, name, bufferId) => {
        serverViewClient.handleMessage({
          type: MSG.SNAPSHOT,
          text: String(text ?? ''),
          point: 0,
          name: String(name ?? 'scratch'),
          bufferId: String(bufferId ?? 'sim-switch'),
          seq: 0,
        });
      },
    };
  };
  // If the port beat the boot, wire it now.
  if (godotServerPort) bootServerViewClient();
}

// Install the persisted user highlight rules now that the override store
// and the highlighters exist. (The faces.json read above already filled
// `highlightRulesCache`.) Re-render-on-push is a guarded no-op here —
// the editors mount below — so the rules are simply seeded into the
// store, ready for the first highlight call.
if (keymapReady) installHighlightRules();

/** Dispatch a keystroke through the Lisp keymap. */
function dispatchKey(key) {
  // M-1..M-9 jumps to the Nth buffer (1-indexed). Intercepted here,
  // before the Lisp keymap, so the tabline shortcut is unaffected by
  // user keymap edits. Out-of-range indexes are a no-op (handled).
  // Placeholders are excluded so the count matches the user-visible
  // View List (the Nth *real* view, not the Nth `views[]` slot).
  if (
    typeof key === 'string' &&
    key.length === 3 &&
    key.startsWith('M-') &&
    key[2] >= '1' &&
    key[2] <= '9'
  ) {
    const nth = Number(key[2]) - 1;
    const realViews = views.filter((v) => !isPlaceholderView(v));
    const target = views.indexOf(realViews[nth]);
    if (target >= 0) switchToViewIndex(target);
    return true;
  }
  try {
    const handled = interpreter.call('handle-key', key) === true;
    // A key may have switched mode (e.g. toggle-math-mode) — keep the
    // mode menu in step.
    refreshModeMenu();
    // If point has wandered out of an active snippet's body (an arrow
    // key, a click-driven move), soft-commit it — the text stays, the
    // active record is dropped. Field navigation (TAB/S-TAB) keeps point
    // inside the body, so it does not trip this. A no-op when no snippet
    // is active (guarded in Lisp).
    try {
      interpreter.call('snippet-soft-commit-if-outside');
    } catch {
      // Ignore — never let the soft-commit check break key dispatch.
    }
    return handled;
  } catch (error) {
    repl.appendError(error.lispMessage ?? error.message ?? String(error));
    return true; // consume the key; the error is visible in the REPL
  }
}

/** Keys that are modifiers in their own right — a bare press of one is
 *  not a keystroke to dispatch (waiting for the real key). */
const BARE_MODIFIER_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'OS', 'AltGraph', 'Fn',
]);

/** True when EL (a keydown target) is a native text-entry control that
 *  owns its own keys — a minibuffer / REPL / customize / pdf input, or a
 *  browser-view's URL bar. The editor's own `.editor` surface is a
 *  focusable div, not an input/contenteditable, so it is excluded here
 *  on purpose (we *do* want to route for it). */
function targetOwnsKeys(el) {
  return (
    el instanceof Element &&
    el.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
    ) !== null
  );
}

// --- the global key router ---------------------------------------------
//
// Key dispatch must not depend on which DOM element happens to hold
// focus. Each view's keydown listener (the text `.editor`, image-view,
// audio-view, …) only fires when its own element is focused, so a key
// pressed while DOM focus has drifted to <body> — after the window
// regains focus, after a DOM rebuild detached the focused element, after
// a programmatic pane switch — is lost, and prefix chords like C-x C-f go
// unrecognised in non-text views. `handle-key` already resolves against
// the *logical* current view (not `document.activeElement`), so a single
// window-level listener can route every otherwise-unhandled key.
//
// Bubble phase + a `defaultPrevented` guard is what makes this safe: any
// deeper listener (a focused view, a modal overlay, a native input) runs
// first, and if it claimed the key it has already called preventDefault —
// so we stand down and never double-dispatch. Only keys that reach <body>
// unclaimed are routed here. browser-view is exempt by nature: a focused
// <webview> delivers keydown to the guest page, which never reaches us.
window.addEventListener('keydown', (event) => {
  if (!keymapReady) return;
  // Server-mode (Model B): once the server view is mounted it is the sole
  // dispatcher. A focused TEXT view routes its own keys (its onKey →
  // serverViewClient.dispatchKey), so the global router stands down for it — else
  // a key reaching <body> (focus drift) would be dispatched twice. BUT a focused
  // NON-TEXT view (a media / element data-source view) has no such onKey, so a
  // command CHORD would be lost and could trap the user on, e.g., a video. Route
  // just those held-modifier chords up to the server here; bare keys
  // (space=play/pause, arrows=seek) stay with the element. Flag-off
  // serverViewClient is null, so this whole branch is skipped.
  if (window.host && window.host.serverMode && serverViewClient && serverViewClient.getView()) {
    if (event.defaultPrevented) return;            // a deeper listener claimed it
    if (BARE_MODIFIER_KEYS.has(event.key)) return; // a bare modifier press
    if (targetOwnsKeys(event.target)) return;      // minibuffer / native input
    const focusedLeaf = leafPanes(rootPane).find((l) => l.id === currentPaneId);
    const fv = focusedLeaf ? peelTabline(focusedLeaf.view) : null;
    const isTextFocus = !!fv && !isTablineView(fv)
      && (fv.kind === 'text' || fv._serverBacked === true);
    if (isTextFocus) return; // the text-view's own onKey dispatches it
    if (!(event.metaKey || event.ctrlKey || event.altKey)) return; // bare → the element
    const chord = keyEventToString(event);
    if (serverViewClient.dispatchKey(chord)) event.preventDefault();
    return;
  }
  // Flag-off (and the pre-mount window): the router runs exactly as today.
  if (shouldGlobalRouterDefer(
    !!(window.host && window.host.serverMode),
    !!(serverViewClient && serverViewClient.getView())
  )) {
    return;
  }
  // A deeper listener already claimed it (focused view, modal, input).
  if (event.defaultPrevented) return;
  // A bare modifier press is not a keystroke in its own right.
  if (BARE_MODIFIER_KEYS.has(event.key)) return;
  // Native inputs keep every key — including editor chords — so a user
  // typing in the minibuffer/REPL/url-bar is never interrupted.
  if (targetOwnsKeys(event.target)) return;
  // Add-pane mode runs its own transient key handling over the host.
  if (editorHostEl.dataset.addPane) return;

  // (The pre-Meta Cmd+V/C/X clipboard chords and the capture-phase
  // Cmd+W close-tab handler used to live here. With Command as Meta,
  // those chords ARE Emacs bindings — Cmd+W is M-w copy-region, Cmd+X
  // is M-x, Cmd+V is M-v — and the kill ring already syncs with the
  // system clipboard. Native inputs returned above keep their own
  // chords, and an unclaimed Cmd chord falls through to its menu role
  // (Cmd+C copy, Cmd+Z undo, Cmd+O open…), since menu accelerators
  // only fire for keydowns the renderer leaves unhandled.)

  const key = keyEventToString(event);
  // A bare printable character self-inserts; only route that to a text
  // view. Command keys and chords route regardless of the view kind, so
  // C-x C-f (etc.) work from an image, pdf or audio view too.
  if (key.length === 1) {
    const current = views[currentViewIndex];
    if (!current || current.kind !== 'text') return;
  }
  let handled = dispatchKey(key);
  // An unbound Option chord that composed a printable character (curly
  // quotes, accents) self-inserts the composed character into a text
  // view — a bound `A-…` chord above wins, so Option stays bindable.
  if (!handled && altComposedInsert(event)) {
    const current = views[currentViewIndex];
    if (current && current.kind === 'text') handled = dispatchKey(event.key);
  }
  if (handled) event.preventDefault();
});

// Right-click → Paste (and any other native paste action — the Edit
// menu's Paste item included). The custom renderer isn't
// contenteditable, so a paste event would otherwise do nothing. Route it
// through the clipboard-aware `yank`. Native inputs keep their own paste.
window.addEventListener('paste', (event) => {
  if (!keymapReady) return;
  // Same server-mode stand-down as the key router: the in-renderer `yank`
  // would mutate the idle editor, not the server's buffer. (Flag-off: false.)
  if (shouldGlobalRouterDefer(
    !!(window.host && window.host.serverMode),
    !!(serverViewClient && serverViewClient.getView())
  )) {
    return;
  }
  if (targetOwnsKeys(event.target)) return;
  const current = views[currentViewIndex];
  if (!current || current.kind !== 'text') return;
  event.preventDefault();
  try {
    interpreter.call('yank');
  } catch (error) {
    repl.appendError(`paste: ${error.message}`);
  }
});

// --- mode menu ----------------------------------------------------------
// The native menu shows the current buffer's mode commands. The
// renderer owns the keymaps, so it builds the menu data here and ships
// it to the main process; a click comes back through onMenuCommand.

/** The mode menu for the current buffer, or null when it has none.
 *
 * Two shapes, both consumed by menu.js's recursive renderer:
 *  - flat (the default): `items` are leaves `{label, command, toolTip}`,
 *    one per bound command — byte-for-byte the historical menu;
 *  - nested: when the mode registered a structured menu
 *    (`mode-menu-sections`), `items` are submenus `{label, items:[…]}`,
 *    one per section, whose leaves are resolved (keys + docstring) from
 *    the same flat `mode-menu-entries` data.
 */
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

  // The structured (sectioned) menu, when this mode registered one.
  let sections = [];
  try {
    sections = listToArray(interpreter.call('mode-menu-sections-resolved'))
      .map((section) => listToArray(section).map((cell, i) =>
        i === 0 ? cell : listToArray(cell)));
  } catch (error) {
    // A registry slip shouldn't lose the menu — fall back to flat.
    repl.appendError(`mode menu sections failed: ${error.message}`);
    sections = [];
  }

  const flatEntries = raw.map((entry) => listToArray(entry));
  const items = buildModeMenuItems(flatEntries, sections);
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

// --- snippet field decorations -----------------------------------------
//
// While a snippet is being navigated, the active field is painted with
// `snippet-active-face`, its live mirrors with `snippet-mirror-face`, and
// the not-yet-reached (forthcoming) fields with `snippet-inactive-face`,
// so the upcoming tab stops are visible as "pending" pills.
// The Lisp side keeps the field offsets current as the user edits
// (`snippet-after-edit!`), and exposes them as absolute `(start . end)`
// ranges; the renderer recomputes the boxes from these offsets on every
// frame, so they track the buffer under edits (unlike the inline-eval
// pill, which hides on any mutation). The active-field *selection* still
// rides on top until the user types, so "type to replace" is unchanged —
// the face box augments it, it doesn't replace it.
//
// The faces become `.tok-snippet-active-face` / `.tok-snippet-mirror-face`
// CSS rules through the same `current-face-styles` -> face-styles.js path
// every other face uses, so a theme / customise edit re-tints the boxes
// with no extra wiring.

/** Read one `(start . end)` cons pair into a `{start, end}` of finite
 *  numbers, or null when the value is nil / malformed. */
function snippetRangePair(pair, face) {
  if (pair === null || pair === undefined || pair === NIL) return null;
  const start = Number(pair.head);
  const end = Number(pair.tail);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end, face };
}

/**
 * The face-tagged decoration ranges for an active snippet, or an empty
 * array when none is active (or the read fails). Only the buffer that
 * actually holds the active snippet — the focused text buffer the
 * snippet primitives operate on — gets painted; a background pane over a
 * different buffer returns nothing.
 *
 * @param {object | null} buffer - The buffer this renderer is showing.
 * @returns {Array<{start: number, end: number, face: string}>}
 */
function snippetDecorationsFor(buffer) {
  if (!keymapReady) return [];
  // The active snippet is global (one across the editor) and its offsets
  // are into the focused buffer; only paint on the pane showing it.
  if (!buffer || buffer !== currentTextBuffer) return [];
  try {
    const ranges = [];
    // Forthcoming tab stops first, so the active / mirror boxes paint
    // over them if anything ever overlaps. These read as amber "pending"
    // pills via `snippet-inactive-face`.
    for (const pending of listToArray(interpreter.call('snippet-forthcoming-regions'))) {
      const p = snippetRangePair(pending, 'snippet-inactive-face');
      if (p !== null) ranges.push(p);
    }
    const active = snippetRangePair(
      interpreter.call('snippet-active-region'),
      'snippet-active-face'
    );
    if (active !== null) ranges.push(active);
    for (const mirror of listToArray(interpreter.call('snippet-mirror-regions'))) {
      const m = snippetRangePair(mirror, 'snippet-mirror-face');
      if (m !== null) ranges.push(m);
    }
    return ranges;
  } catch {
    // A snippet read must never break rendering — drop the boxes for
    // this frame. The next render retries.
    return [];
  }
}

// --- editor view (per-pane instances) -----------------------------------
//
// Phase 3a of plans/PANES.md: each leaf pane that holds a text view owns
// its own `createEditorView` instance, mounted inside that pane's div.
// With one pane (the only case in this commit) there's one entry in
// the map and `editorView` is that instance, so behaviour matches phase 2.
// When commit 4's split commands land, the map grows by one entry per
// leaf — each renders its own view, with its own cursor (per-view-point).
//
// The map is keyed by leaf pane id. The text kind's mount hook creates
// an instance on first use and reuses it on subsequent mounts. Disposal
// (commit 4) drops the entry and destroys the instance.

/** @type {Map<string, ReturnType<typeof createEditorView>>} */
const editorViewByPaneId = new Map();

// --- math preview (math-preview-mode) -----------------------------------
//
// The renderer owns the typesetting controller (createMathPreview); the
// host owns its lifecycle, one per leaf pane (keyed by leaf id, like
// editorViewByPaneId). A controller is created lazily the first time a
// leaf's buffer is seen with the mode on, reused while the mode stays on
// (its body/typeset cache persists across renders), and disposed when the
// leaf's editor view is torn down. The mode toggle itself needs no
// special path: enabling/disabling the minor mode sets buffer.minorModes,
// which emits an onChange the renderer is already subscribed to, so the
// view re-renders and re-reads getMathReplacedRanges below — which now
// sees the mode on (ranges) or off (empty).
//
// The mode is *general*: any major mode can enable `math-preview-mode`.
// What math each buffer recognises is chosen by its major mode via the
// renderer's provider registry (mathPreviewProviderForMode), selected by
// the major mode's display name (LaTeX recognises \begin…\end
// environments; Markdown / the common config does not). A major mode with
// no provider gets no preview even with the minor mode on. The original
// LaTeX UX is preserved: `latex-math-preview-mode` is an alias of this
// general mode (see math-preview.lisp / latex.lisp), so a `.tex` buffer
// toggled with C-c C-p still enables this very mode and the LaTeX provider
// scans it exactly as before.

/** @type {Map<string, ReturnType<typeof createMathPreview>>} */
const mathPreviewByPaneId = new Map();

/** The stdlib's general `math-preview-mode` map, resolved once the keymap
 *  (and so the stdlib) is loaded. Compared by identity against a
 *  buffer's minor-mode list. Null until resolved / if resolution fails.
 *  `latex-math-preview-mode` is an alias of this same map, so a LaTeX
 *  buffer toggled the old way is still recognised here. */
let mathPreviewMode = null;
/** Whether we've attempted to resolve `mathPreviewMode` yet. */
let mathPreviewModeResolved = false;

/** Resolve (once) the general `math-preview-mode` map from the stdlib. */
function resolveMathPreviewMode() {
  if (mathPreviewModeResolved || !keymapReady) return mathPreviewMode;
  mathPreviewModeResolved = true;
  try {
    mathPreviewMode = interpreter.evaluate('math-preview-mode');
  } catch {
    // The mode is defined in math-preview.lisp; if it isn't loaded the
    // feature is simply unavailable and we leave the reference null
    // (→ inactive).
    mathPreviewMode = null;
  }
  return mathPreviewMode;
}

/** The math-preview replaced ranges for LEAF's view this render, or an
 *  empty list when the leaf's buffer does not have math-preview-mode on,
 *  its major mode has no math provider, or the feature isn't available.
 *  Called by the leaf's renderer on every render via its
 *  `getReplacedRanges` option.
 *
 *  When the mode is on, this lazily creates / reuses the leaf's controller,
 *  runs its per-render `update()` (point tracking + the MathJax-startup
 *  one-shot re-render arm), and returns `ranges()`. When the mode goes off,
 *  it returns `[]` so the view shows plain source; the idle controller is
 *  disposed so its cache is released.
 *
 *  @param {*} leaf - The leaf pane whose view is rendering.
 *  @returns {Array<{start:number,end:number,kind:'inline'|'block',el?:() => Node}>}
 */
function getMathReplacedRanges(leaf) {
  const mode = resolveMathPreviewMode();
  // Peel a tabline wrapper to the active text child; the buffer/point
  // live on the text view, exactly as the getPoint/getCursors closures do.
  const view = peelTabline(leaf.view);
  const isText = view && !isTablineView(view) && view.kind === 'text';
  const buffer = isText ? view.buffer : null;
  if (!buffer || !isMathPreviewActive(buffer, mode)) {
    // Mode off (or no buffer): drop any idle controller and show source.
    disposeMathPreviewForLeaf(leaf);
    return [];
  }
  // Pick the scanner provider by the buffer's major mode. No provider
  // (a mode without math support) → show source, no controller.
  const provider = mathPreviewProviderForMode(bufferMajorModeName(buffer, keyword));
  if (!provider) {
    disposeMathPreviewForLeaf(leaf);
    return [];
  }
  let controller = mathPreviewByPaneId.get(leaf.id);
  if (!controller) {
    // The controller reads text / point fresh through these closures,
    // and the closures re-peel `leaf.view` on each call — so the same
    // controller follows the leaf across a view/buffer swap or a
    // multi-cursor change without needing to be rebuilt. (A swap to a
    // non-text view is handled above: getMathReplacedRanges returns []
    // for it, and the controller never runs.) The buffer's body/typeset
    // cache is keyed by math-body text, so it stays valid across swaps.
    const peeledTextView = () => {
      const v = peelTabline(leaf.view);
      return v && !isTablineView(v) && v.kind === 'text' ? v : null;
    };
    controller = createMathPreview({
      getText: () => {
        const v = peeledTextView();
        return v && v.buffer ? v.buffer.text : '';
      },
      getPoints: () => {
        const v = peeledTextView();
        if (!v) return [];
        const cursors = Array.isArray(v.cursors) ? v.cursors : null;
        if (cursors && cursors.length > 0) {
          return cursors.map((c) => c.point);
        }
        return [typeof v.point === 'number' ? v.point : 0];
      },
      doc: document,
      // The scanner is mode-specific. Resolve the provider fresh on each
      // scan so a major-mode change on this leaf's buffer (e.g. a buffer
      // swap or M-x change-mode) is reflected without rebuilding the
      // controller; falls back to the LaTeX scanner if the provider has
      // gone (defensive — getMathReplacedRanges already gated on one).
      scan: (text) => {
        const v = peeledTextView();
        const buf = v ? v.buffer : null;
        const p = mathPreviewProviderForMode(bufferMajorModeName(buf, keyword));
        return p ? p.scan(text) : provider.scan(text);
      },
      // The buffer's own macro definitions (JMarkdown's `Math macros:`
      // header), prepended to every typeset segment. Resolved fresh per
      // update, like the scanner.
      preamble: (text) => {
        const v = peeledTextView();
        const buf = v ? v.buffer : null;
        const p = mathPreviewProviderForMode(bufferMajorModeName(buf, keyword));
        const harvest = (p ?? provider).preamble;
        return typeof harvest === 'function' ? harvest(text) : '';
      },
      // The startup one-shot: once MathJax finishes loading, ask the
      // leaf's renderer to redraw so segments left as source during
      // startup flip to typeset widgets. A tabline tab supplies its own
      // per-tab element (`leaf.element`); a bare leaf resolves the
      // pane's editor instance by id.
      requestRender: () => {
        const instance = leaf.element ?? editorViewByPaneId.get(leaf.id);
        if (instance) instance.setView(leaf.view);
      },
    });
    mathPreviewByPaneId.set(leaf.id, controller);
  }
  // Per-render bookkeeping (segment-under-point tracking, MathJax-ready
  // arm) must run before ranges() reads.
  controller.update();
  return controller.ranges();
}

/** Drop the math-preview controller bound to LEAF, if any. Releases its
 *  typeset cache. Safe to call when none exists. */
function disposeMathPreviewForLeaf(leaf) {
  mathPreviewByPaneId.delete(leaf.id);
}

/** The leaf pane whose view is currently focused. Used to resolve
 *  `editorView` callsites that operate on the "current" instance. */
function focusedTextLeafId() {
  // For now, currentPaneId resolves through the pane focus model; with
  // one pane it's that pane's id. The variable is declared above this
  // section in the pane block.
  return currentPaneId;
}

/** The `onKey` configure option for a leaf's `<text-view>`.
 *
 *  Flag-off (the common case) this is byte-for-byte the original: bind the
 *  in-renderer `dispatchKey` once the keymap is ready, nothing before.
 *
 *  Flag-on (Model B) it installs a per-keystroke router instead, because
 *  `TextView.configure()` cannot re-run after mount (it throws) yet a leaf may
 *  become server-backed *after* its element was built. The closure decides live
 *  on each key: a server-backed leaf sends the key to the server's keymap
 *  (the leaf-flip — auto-pair / chords / self-insert all resolve server-side);
 *  any other leaf falls back to the in-renderer dispatch exactly as flag-off. */
function serverViewKeyOption(instance) {
  if (!(window.host && window.host.serverMode)) {
    return keymapReady ? { onKey: dispatchKey } : {};
  }
  return {
    onKey: (key) => {
      const v = peelTabline(instance._boundLeaf.view);
      if (isServerBackedView(v) && serverViewClient) {
        return serverViewClient.dispatchKey(key);
      }
      return keymapReady ? dispatchKey(key) : false;
    },
  };
}

/** The `onKey` for a NON-TEXT element-view (image/audio/video/pdf) that routes to
 *  the SERVER's keymap in server mode — so a chord (C-x C-f, M-x, C-x b…) typed
 *  while a media view is focused reaches the server instead of being swallowed by
 *  the idle in-renderer dispatchKey (which would preventDefault it, so the
 *  window-level router never sees it either). Flag-off it is exactly the legacy
 *  `keymapReady ? { onKey: dispatchKey } : {}`. serverViewClient is resolved at
 *  key-press time (it's null when the singletons are configured at boot). */
function serverMediaKeyOption() {
  if (window.host && window.host.serverMode) {
    return { onKey: (key) => (serverViewClient ? serverViewClient.dispatchKey(key) : false) };
  }
  return keymapReady ? { onKey: dispatchKey } : {};
}

/** Create (or reuse) the <text-view> custom element for LEAF, mount it
 *  inside the leaf's pane element, and point it at LEAF.view.
 *
 *  Phase 2c of plans/VIEWS-AS-CUSTOM-ELEMENTS.md: the per-pane editor
 *  *instance* is now a TextView element. It exposes the same setView /
 *  focus / destroy / recenter / etc. API the createEditorView return
 *  used to, so the call sites that used `instance.setView(...)` etc.
 *  are unchanged. What changes is `instance.element` — that used to
 *  be the editor's `.editor` div; under the new model the instance IS
 *  the element, and consumers use it directly. */
function ensureEditorViewForLeaf(leaf) {
  const paneEl = paneElements.get(leaf.id);
  if (!paneEl) return null;
  let instance = editorViewByPaneId.get(leaf.id);
  if (instance) {
    // Re-attach if a re-layout detached the element (defensive).
    if (instance.parentNode !== paneEl) {
      paneEl.append(instance);
    }
    // The pane tree is immutable: every update hands us a *new* leaf
    // object for this pane id. The instance is reused by id, so its
    // per-view closures (getPoint / getReplacedRanges / …) must be
    // re-pointed at the current leaf — otherwise they keep reading the
    // leaf captured when the pane was first created (e.g. the startup
    // welcome buffer), which is what broke math preview / decorations
    // for restored or freshly-opened buffers.
    instance._boundLeaf = leaf;
    instance.setView(leaf.view);
    return instance;
  }
  // Build a fresh <text-view> element. configure() must run *before*
  // the element is appended — connectedCallback reads the options to
  // mount the inner editor.
  instance = /** @type {*} */ (document.createElement('text-view'));
  // The closures below read `instance._boundLeaf`, kept current here and
  // on every reuse, rather than capturing `leaf` (a per-update snapshot).
  instance._boundLeaf = leaf;
  instance.configure({
    ...serverViewKeyOption(instance),
    highlighters,
    foldCaptures,
    // Per-view-point: each pane's renderer reads the cursor from
    // *its* leaf's view, not from the global "current view". When a
    // background pane re-renders (its buffer's shared text changed in
    // another pane), it still draws its own cursor.
    //
    // Phase 3b: when the leaf holds a tabline-view, peel through to
    // the active child — the tabline wrapper carries no point/mark of
    // its own; the child (a text view) does. Nested tabline-views
    // (Q10) peel all the way through.
    getPoint: () => {
      const v = peelTabline(instance._boundLeaf.view);
      return v && !isTablineView(v) && typeof v.point === 'number' ? v.point : 0;
    },
    getMark: () => {
      const v = peelTabline(instance._boundLeaf.view);
      return v && !isTablineView(v) && v.mark !== undefined ? v.mark : null;
    },
    // Multi-cursor: the renderer paints this leaf's view's full cursor
    // set. Falls back to a single-cursor list synthesised from
    // getPoint/getMark when the view hasn't been given a cursors[]
    // (non-text views, defensively).
    getCursors: () => {
      const v = peelTabline(instance._boundLeaf.view);
      if (v && !isTablineView(v) && Array.isArray(v.cursors)) return v.cursors;
      return [{
        point: v && typeof v.point === 'number' ? v.point : 0,
        mark: v && v.mark !== undefined ? v.mark : null,
      }];
    },
    getTabWidth: () => currentTabWidth,
    // Snippet field + mirror boxes for this leaf's buffer. Recomputed
    // every render from live offsets, so they survive edits.
    getDecorations: () => {
      const v = peelTabline(instance._boundLeaf.view);
      // Server-backed leaf: the decorations (shared overlays / multi-cursor)
      // are pushed by the server onto the mirror — the in-renderer snippet
      // store is empty server-side, so read the mirror instead.
      if (isServerBackedView(v)) {
        return Array.isArray(v.buffer && v.buffer.decorations)
          ? v.buffer.decorations
          : [];
      }
      const b = v && !isTablineView(v) ? v.buffer : null;
      return snippetDecorationsFor(b);
    },
    // Per-view math preview: the renderer reads this fresh each render
    // and merges the ranges into its replaced-range / fold layout. It
    // returns [] unless this leaf's buffer has math-preview-mode on and
    // its major mode has a math provider.
    getReplacedRanges: () => getMathReplacedRanges(instance._boundLeaf),
    // User highlight overrides: the buffer's major-mode name selects
    // mode-scoped `kind -> face` rules; the override generation forces a
    // re-tokenize when the rule set changes (see set-highlight-overrides!).
    getMajorModeName: () => {
      const v = peelTabline(instance._boundLeaf.view);
      const buf = v && !isTablineView(v) ? v.buffer : null;
      return bufferMajorModeName(buf, keyword);
    },
    getOverrideGeneration: () => highlightOverrideStore.generation(),
    onRenderError: (error) => reportRendererFault('render error', error),
  });
  instance.setView(leaf.view);     // populates pending buffer/view
  paneEl.append(instance);          // triggers connectedCallback → mount
  editorViewByPaneId.set(leaf.id, instance);
  return instance;
}

/** Dispose of the editor view bound to LEAF (commit 4 will call this
 *  on pane deletion). Safe to call when no instance exists. */
function disposeEditorViewForLeaf(leaf) {
  const instance = editorViewByPaneId.get(leaf.id);
  if (!instance) return;
  instance.destroy();
  editorViewByPaneId.delete(leaf.id);
  // Release the leaf's math-preview controller (and its typeset cache).
  disposeMathPreviewForLeaf(leaf);
}

// The "current" editor view — the instance bound to the focused leaf
// pane. Reassigned by switchToViewIndex / focus changes. With one
// pane this is the single instance; with several panes (commit 4) it
// follows focus.
const initialLeaf = leafPanes(rootPane)[0];
ensureEditorViewForLeaf(initialLeaf);
/** @type {ReturnType<typeof createEditorView>} */
let editorView = /** @type {*} */ (editorViewByPaneId.get(initialLeaf.id));

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
  const name = String(r[0]);
  return {
    name,
    doc: String(r[1] ?? ''),
    foreground: typeof r[2] === 'string' ? r[2] : '',
    background: typeof r[3] === 'string' ? r[3] : '',
    weight: String(r[4] ?? 'normal'),
    slant: String(r[5] ?? 'normal'),
    underline: r[6] === true,
    strikeThrough: r[7] === true,
    // Typography: size is a number (or '' when unset), family a string.
    // The base face owns these; on other faces they are blank (inherit).
    size: typeof r[8] === 'number' ? r[8] : '',
    family: typeof r[9] === 'string' ? r[9] : '',
    isBase: name === BASE_FACE_NAME,
    state: String(r[10] ?? 'standard'),
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
    const modeAlist = listToArray(
      interpreter.call('current-mode-face-styles')
    );
    applyFaceStyles(document, alist, listToArray, modeAlist);
  } catch (error) {
    repl.appendError(`face-styles: ${error.lispMessage ?? error.message}`);
  }
}

/** Force every mounted text editor — pane leaves and tabline children —
 *  to re-render. A CSS-only face change is picked up by re-painting the
 *  existing `.tok-*` spans, but a highlight-RULE change adds or removes
 *  spans, so the buffer must be re-tokenized. Re-pointing each instance
 *  at its current view re-runs the render (the override-generation in
 *  the cache key forces the tree-sitter parse to repeat). Tolerant:
 *  a disposed/unmounted instance is skipped. */
function rerenderAllEditors() {
  // Guard against an early call (e.g. the startup rule push runs before
  // the pane/tabline registries are initialised): those are module-level
  // `const`s, so touching them in their TDZ throws. A no-op then is
  // correct — no editor is mounted yet to re-render.
  let paneInstances;
  try {
    paneInstances = editorViewByPaneId;
  } catch {
    return;
  }
  for (const instance of paneInstances.values()) {
    try {
      if (instance && instance.boundView) instance.setView(instance.boundView);
    } catch { /* tolerant — a disposed instance */ }
  }
  for (const state of tablineStateByView.values()) {
    if (!state || !(state.editorByChild instanceof Map)) continue;
    for (const el of state.editorByChild.values()) {
      try {
        if (el && typeof el.setView === 'function' && el.boundView) {
          el.setView(el.boundView);
        }
      } catch { /* tolerant */ }
    }
  }
  // A highlight-rule / face change recolours the minimap's segments too.
  forEachMinimapElement((el) => el.invalidateColors());
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
// Phase 3d: customize-view is a custom element now. The configure
// options factory is also used by the tabline mount path to build
// per-tab `<customize-view>` instances (one per customize view in the
// tabline).
function configureCustomizeView() {
  return {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    getModel: getCustomModel,
    applySetting: applyCustomSetting,
    saveSetting: saveCustomSetting,
    resetSetting: resetCustomSetting,
    openScope: openCustomScope,
    setFaceAttribute: setFaceFromView,
    resetFace: resetFaceFromView,
  };
}
const customizeView = /** @type {*} */ (document.createElement('customize-view'));
customizeView.configure(configureCustomizeView());
editorPaneElement().append(customizeView);
customizeView.style.display = 'none';

// The image view — the view an `image`-kind buffer is shown through.
// Like the customisation view it shares #editor-host; switchToBuffer
// shows whichever the current buffer's kind calls for. Keys typed in
// it go through the same Lisp keymap.
// Phase 3a: image-view is a custom element now. The instance IS the
// element; what was `imageView.element` is just `imageView`. The
// configure factory is reused by the tabline mount path so each
// image tab gets its own `<image-view>` (one per view, not shared).
function configureImageView() {
  return { ...serverMediaKeyOption() };
}
const imageView = /** @type {*} */ (document.createElement('image-view'));
imageView.configure(configureImageView());
editorPaneElement().append(imageView);
imageView.style.display = 'none';

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
// Phase 3e: doc-view is a custom element now. Factory is reused by
// the tabline mount path for per-tab `<doc-view>` instances.
function configureDocView() {
  return {
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
      // In-view navigation — a clicked cross-link, menu item, breadcrumb, or
      // nav button. The target is a built page: a navigation node id (e.g.
      // "getting-started") OR a documented function name. Open it directly;
      // readDocPage resolves either against the manifest. This is distinct
      // from the `open-doc` command (C-h f / M-x), which looks up docs for an
      // arbitrary symbol and falls back to rendering its docstring — that
      // command only knows function names, so routing node-id clicks through
      // it reported "no doc page".
      openDocInPane(name);
    },
    highlightCode: highlightCodeForDocView,
    manifest: docNavTree,
  };
}
// Doc pages render as utility-dock tabs now (see openDocUtilityPanel), not as
// pane-tree views — so there is no singleton doc-view element. configureDocView
// above is reused by the doc panel for cross-link / highlight / key wiring.

// The jukebox view — the view a `jukebox`-kind buffer is shown
// through. Replaces the old text-buffer jukebox mode. The shared
// audio controller is passed in so `audio-playing?` and friends
// stay truthful; `openImage` routes M-RET on the album art through
// the same image-buffer path the dialog uses.
// Phase 3f: jukebox-view is a custom element now. Factory reused by
// the tabline mount for per-tab `<jukebox-view>` instances.
function configureJukeboxView() {
  const serverMode = !!(window.host && window.host.serverMode);
  return {
    // onKey routes chords to the server's keymap in server mode; flag-off
    // byte-for-byte. (Jukebox's own SPC/RET/n/p/s keys are handled inside the
    // view; onKey only forwards the chords it doesn't claim.)
    ...serverMediaKeyOption(),
    audio,
    openImage: (path) => {
      // M-RET on the album art opens it as an image. Server mode: route through
      // the server's find-file (a media data-source); flag-off: open locally.
      if (serverMode) {
        if (serverViewClient) serverViewClient.visitPath(expandTilde(path));
        return;
      }
      openImageByPath(expandTilde(path));
    },
    report: (message) => repl.appendNote(message),
    // Embedded album-art lookup: the host IPC reads the file's tag
    // and returns `{ mime, dataUrl }` or null. The view shows the
    // dataUrl when present, falls back to the directory's sidecar
    // cover otherwise.
    getEmbeddedArt: (path) =>
      window.host.audioAlbumArt(expandTilde(path)),
  };
}
const jukeboxView = /** @type {*} */ (document.createElement('jukebox-view'));
jukeboxView.configure(configureJukeboxView());
editorPaneElement().append(jukeboxView);
jukeboxView.style.display = 'none';

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
// Phase 3b: audio-view is a custom element now. The instance IS the
// element; what was `audioView.element` is just `audioView`. Factory
// reused by the tabline mount path for per-tab `<audio-view>`
// instances (one per audio view, not a shared singleton).
function configureAudioView() {
  return {
    ...serverMediaKeyOption(),
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
  };
}
const audioView = /** @type {*} */ (document.createElement('audio-view'));
audioView.configure(configureAudioView());
editorPaneElement().append(audioView);
audioView.style.display = 'none';

// The video view — the view a `video`-kind buffer is shown through.
// Phase 3c: video-view is a custom element now. The instance IS the
// element; what was `videoView.element` is just `videoView`. Factory
// reused by the tabline mount path.
function configureVideoView() {
  return {
    ...serverMediaKeyOption(),
    closeBuffer: () => {
      if (!keymapReady) return;
      try {
        interpreter.call('kill-view');
      } catch (error) {
        repl.appendError(`kill-view: ${error.lispMessage ?? error.message}`);
      }
    },
  };
}
const videoView = /** @type {*} */ (document.createElement('video-view'));
videoView.configure(configureVideoView());
editorPaneElement().append(videoView);
videoView.style.display = 'none';

// The pdf view — the view a `pdf`-kind buffer is shown through.
// PDF.js renders each page to a canvas with an overlapping text layer;
// the chrome (page nav, zoom, find) is custom so it theme-matches
// and the keymap can stay live (chord keys forward through onKey).
// The factory is reused by `perKindConfigureFactory` so each pdf tab
// gets its own `<pdf-view>` element — the per-instance `PDFDocumentProxy`,
// scroll position, and zoom are how tabbed PDFs survive a tab switch
// with their state intact.
function configurePdfView() {
  return {
    ...serverMediaKeyOption(),
    // Inverse SyncTeX: an Option-click in the PDF jumps the editor to the
    // source. The pdf-view hands us the 1-based page and the clicked PDF
    // point (SyncTeX convention); `latex-synctex-inverse` runs
    // `synctex edit` and opens the resulting file:line. Guarded by the
    // keymap-ready latch and wrapped so a Lisp error can't break the click.
    onSyncTexClick: (page, x, y) => {
      if (!keymapReady) return;
      try {
        interpreter.call('latex-synctex-inverse', page, x, y);
      } catch (error) {
        repl.appendError(error.lispMessage ?? error.message ?? String(error));
      }
    },
  };
}
const pdfView = /** @type {*} */ (document.createElement('pdf-view'));
pdfView.configure(configurePdfView());
editorPaneElement().append(pdfView);
pdfView.style.display = 'none';

// The browser view — the view a `browser`-kind buffer is shown through.
// v1 is an Electron <webview> in a `persist:browser-views` partition;
// the wrapper adds a back/forward/reload/URL/stop toolbar and forwards
// chord keystrokes through the Lisp keymap so SPC etc. don't compete
// with the editor when the wrapper has focus. Each browser tab gets
// its own `<browser-view>` from `perKindConfigureFactory` so navigation
// state (history, scroll, URL) survives a tab switch — Chromium's
// per-webview state is the only thing keeping that intact.
function configureBrowserView() {
  return {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    defaultUrl: 'about:blank',
    partition: 'persist:browser-views',
    // Page title updates flow through here so the modeline + tabline
    // pick up the page's <title> as the view's label.
    onTitleChanged: () => notifyViewsChanged(),
  };
}
// Browsers are PER-INSTANCE, not a shared singleton: each browser VIEW
// owns its own <browser-view> element (and Chromium <webview> guest),
// created directly in its pane and never moved. Moving a <webview>
// re-creates its guest, which used to drop open-url!'s navigation and
// "jump" the one shared browser between panes. This mirrors how the
// tabline already gives each browser tab its own element (editorByChild),
// but for leaf-direct browser panes — so two browsers can sit in two
// panes at once, each with its own history/URL.
const browserElementByView = new Map();

/** The <browser-view> element for browser VIEW — created (configured +
 *  mounted in PANE-EL) on first use, then reused. Pointing it at the view
 *  navigates the webview to the view's URL. The element is born in its
 *  pane and re-attached only if a re-layout detached it (defensive). */
function ensureBrowserElementForView(view, paneEl) {
  let el = browserElementByView.get(view);
  if (el) {
    if (paneEl && el.parentNode !== paneEl) paneEl.append(el);
    el.setBuffer(view);
    return el;
  }
  el = /** @type {*} */ (document.createElement('browser-view'));
  el.configure(configureBrowserView());
  el.setBuffer(view); // pending buffer; painted on connectedCallback
  if (paneEl) paneEl.append(el); // triggers mount → navigate to view.url
  browserElementByView.set(view, el);
  return el;
}

/** Show every browser element whose view is a leaf-direct active view;
 *  hide the rest. Called from `hideInactiveSingletons` so it runs
 *  wherever non-text view visibility is recomputed. */
function hideInactiveBrowsers() {
  const active = new Set();
  for (const leaf of leafPanes(rootPane)) {
    if (!isTablineView(leaf.view) && leaf.view && leaf.view.kind === 'browser') {
      active.add(leaf.view);
    }
  }
  for (const [view, el] of browserElementByView) {
    el.style.display = active.has(view) ? '' : 'none';
  }
}

/** Tear down the browser element bound to VIEW (on kill). */
function disposeBrowserElementForView(view) {
  const el = browserElementByView.get(view);
  if (!el) return;
  try { el.destroy(); } catch { /* already gone */ }
  el.remove();
  browserElementByView.delete(view);
}

// --- minimap companion views (per-instance, mirrors the browser) --------
// A `<minimap-view>` is a narrow companion pane bound to a *target leaf*
// (the editor pane it sits beside). It mirrors whatever text that leaf
// currently presents — a bare text-view, or the active text tab of a
// tabline — and follows tab switches / promotion / demotion, because we
// re-resolve the active content on every reconcile rather than caching it.
// The element is a dumb renderer driven by a host-built adapter; only the
// host knows the pane tree + the live editor instances, so the adapter
// (and its rebinding) lives here. See the minimap plan + docs/VIEWS.md.
const minimapElementByView = new Map();   // minimap view object -> element
const minimapByTargetLeafId = new Map();  // target leaf id -> minimap view object
let minimapReconcileScheduled = false;

/** The `<minimap-view>` element for minimap VIEW — created + mounted in
 *  PANE-EL on first use, then reused (mirrors `ensureBrowserElementForView`). */
function ensureMinimapElementForView(view, paneEl) {
  let el = minimapElementByView.get(view);
  if (el) {
    if (paneEl && el.parentNode !== paneEl) paneEl.append(el);
    el.setBuffer(view);
    return el;
  }
  el = /** @type {*} */ (document.createElement('minimap-view'));
  el.configure({});
  el.setBuffer(view);
  if (paneEl) paneEl.append(el);
  minimapElementByView.set(view, el);
  return el;
}

/** Tear down the minimap element bound to VIEW. */
function disposeMinimapElementForView(view) {
  const el = minimapElementByView.get(view);
  if (!el) return;
  try { el.destroy(); } catch { /* already gone */ }
  el.remove();
  minimapElementByView.delete(view);
}

/** Run FN over every live minimap element (theme/face invalidation).
 *  Tolerant of an early call before the registry's TDZ clears. */
function forEachMinimapElement(fn) {
  try {
    for (const el of minimapElementByView.values()) fn(el);
  } catch { /* registry not yet initialised */ }
}

/** Build the target adapter bridging a minimap to a live `<text-view>`
 *  element (its scroll root + buffer). Kept here because only the host can
 *  reach the editor instance; the element stays a dumb renderer. */
function buildMinimapAdapter(buffer, textViewEl) {
  const metricsFrom = (root) => {
    if (!root) return { scrollTop: 0, viewportHeight: 0, contentHeight: 0, lineHeight: 0 };
    const cursor = root.querySelector('.editor-cursor');
    const lineHeight = (cursor && cursor.getBoundingClientRect().height) || 22;
    return {
      scrollTop: root.scrollTop,
      viewportHeight: root.clientHeight,
      contentHeight: root.scrollHeight,
      lineHeight,
    };
  };
  return {
    buffer,
    getLineRuns: () =>
      typeof textViewEl.lineRuns === 'function' ? textViewEl.lineRuns() : null,
    getFoldScopes: () =>
      typeof textViewEl.foldScopes === 'function' ? textViewEl.foldScopes() : [],
    getMetrics: () => metricsFrom(textViewEl.scrollElement),
    onScroll: (cb) => {
      const root = textViewEl.scrollElement;
      if (!root) return () => {};
      root.addEventListener('scroll', cb, { passive: true });
      return () => root.removeEventListener('scroll', cb);
    },
    onChange: (cb) =>
      buffer && typeof buffer.onChange === 'function' ? buffer.onChange(cb) : () => {},
    scrollToContentFraction: (f) => {
      const root = textViewEl.scrollElement;
      if (!root) return;
      root.scrollTop = f * Math.max(0, root.scrollHeight - root.clientHeight);
    },
  };
}

/** Resolve the target leaf's *current* active text content + its live
 *  editor element and (re)bind the minimap. If the active content isn't a
 *  text view → bind null ("not supported"). If the target leaf is gone →
 *  remove the minimap. Uniform across bare-leaf text and tabline-wrapped
 *  text (the editor-instance source differs; `peelTabline` unifies content). */
function rebindMinimapForLeaf(targetLeafId) {
  const view = minimapByTargetLeafId.get(targetLeafId);
  if (!view) return;
  const el = minimapElementByView.get(view);
  if (!el) return;
  const leaf = leafPanes(rootPane).find((l) => l.id === targetLeafId);
  if (!leaf) { removeMinimapForLeaf(targetLeafId); return; }
  const content = peelTabline(leaf.view);
  if (!content || content.kind !== 'text' || !content.buffer) {
    el.bindTarget(null);
    return;
  }
  const textViewEl = isTablineView(leaf.view)
    ? (tablineStateByView.get(leaf.view)?.activeEditor ?? null)
    : ensureEditorViewForLeaf(leaf);
  if (!textViewEl || typeof textViewEl.scrollElement === 'undefined') {
    el.bindTarget(null);
    return;
  }
  el.bindTarget(buildMinimapAdapter(content.buffer, textViewEl));
}

/** Coalesced, deferred reconcile: after any structural change settles
 *  (a microtask, so the pane tree is stable), rebind every minimap to its
 *  target's current content — and drop minimaps whose target leaf is gone.
 *  Tolerant of an early call before the registries' TDZ clears, mirroring
 *  `rerenderAllEditors`. */
function scheduleMinimapReconcile() {
  try {
    if (minimapByTargetLeafId.size === 0 || minimapReconcileScheduled) return;
  } catch { return; }
  minimapReconcileScheduled = true;
  queueMicrotask(() => {
    minimapReconcileScheduled = false;
    for (const [leafId] of [...minimapByTargetLeafId]) rebindMinimapForLeaf(leafId);
  });
}

/** Remove the minimap bound to TARGETLEAFID: dispose its element and
 *  collapse its pane. Map entry cleared first so the reconcile loop / the
 *  pane-delete don't re-enter. */
function removeMinimapForLeaf(targetLeafId) {
  const view = minimapByTargetLeafId.get(targetLeafId);
  if (!view) return;
  minimapByTargetLeafId.delete(targetLeafId);
  const minimapLeaf = leafPanes(rootPane).find((l) => l.view === view);
  disposeMinimapElementForView(view);
  if (minimapLeaf) deletePaneInTree(minimapLeaf);
}

/** Attach a minimap pane beside TARGETLEAF, on SIDE ('left'|'right'), with
 *  WIDTHFRACTION the minimap's share (clamped). Models `openNoFocusViewInSplit`
 *  — it deliberately does NOT move focus or call `hideInactiveRendererViews`,
 *  so the editor keeps the keyboard and its text-view stays visible. */
function attachMinimapBesideLeaf(targetLeaf, side, widthFraction) {
  if (!targetLeaf || targetLeaf.kind !== 'leaf') return null;
  if (minimapByTargetLeafId.has(targetLeaf.id)) return null; // already has one
  const onLeft = side === 'left';
  const frac = Math.max(0.05, Math.min(0.45,
    Number.isFinite(widthFraction) ? widthFraction : 0.16));
  const minimapView = createView({
    kind: 'minimap',
    name: 'Minimap',
    // `:no-focus` — clicking the minimap navigates the editor; it must never
    // become the active pane (or "act on the active view" would target the
    // minimap). isNoFocusPane / setCurrentPaneId honour this flag centrally.
    extras: { side: onLeft ? 'left' : 'right', noFocus: true },
  });
  const minimapLeaf = createLeafPane({ view: minimapView });
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: onLeft ? frac : 1 - frac,
    first: onLeft ? minimapLeaf : targetLeaf,
    second: onLeft ? targetLeaf : minimapLeaf,
  });
  rootPane = replacePane(rootPane, targetLeaf, split);
  minimapByTargetLeafId.set(targetLeaf.id, minimapView);
  syncPaneElements();
  ensureMinimapElementForView(minimapView, paneElements.get(minimapLeaf.id));
  refreshPaneFocusIndicators();
  refreshSplitterHandles();
  scheduleRelayout();
  rebindMinimapForLeaf(targetLeaf.id);
  return minimapLeaf;
}

/** Toggle the minimap for the focused leaf. SIDE / WIDTHFRACTION come from
 *  the Lisp defcustoms via the command. */
function toggleMinimapForFocusedLeaf(side, widthFraction) {
  const leaf = currentPane();
  if (!leaf || leaf.kind !== 'leaf' || !leaf.view) return;
  if (leaf.view.kind === 'minimap') return; // never minimap a minimap
  if (minimapByTargetLeafId.has(leaf.id)) {
    removeMinimapForLeaf(leaf.id);
    scheduleRelayout();
    return;
  }
  attachMinimapBesideLeaf(leaf, side, widthFraction);
}

// --- generic element-host views (per-instance, mirrors the browser) -----
// `<element-view>` hosts an arbitrary third-party custom element described
// entirely by the view's `extras` (tag / moduleUrl / attrs / keyboard /
// onReady), set by the `open-element-view!` primitive from a Lisp spec.
// One `element` kind backs every component a user registers with
// `define-element-view` — no new JS kind per component. See
// plans/ELEMENT-VIEWS.md.
const elementHostByView = new Map();

/** Render a Lisp value (a Sym, a Keyword, or a string) as plain text. */
function lispText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.name === 'string') return value.name;
  if (value === undefined || value === null || value === NIL) return '';
  return String(value);
}

/** Parse a spec's `:attrs` — a Lisp list whose entries are a bare symbol
 *  (a boolean attribute) or a list `(name value)` — into `[name, value]`
 *  pairs (`value` is `true` for boolean attributes). */
function parseElementAttrs(list) {
  if (list === undefined || list === null || list === NIL) return [];
  const out = [];
  for (const entry of listToArray(list)) {
    if (typeof entry === 'string' || entry instanceof Sym) {
      const name = lispText(entry);
      if (name !== '') out.push([name, true]);
      continue;
    }
    const parts = listToArray(entry);
    if (parts.length === 0) continue;
    const name = lispText(parts[0]);
    if (name === '') continue;
    let value = true;
    if (parts.length > 1) {
      const v = parts[1];
      value = (v === true || v === false || typeof v === 'number')
        ? v
        : lispText(v);
    }
    out.push([name, value]);
  }
  return out;
}

/** The command names the renderer owns by registering element-views
 *  (`define-element-view`) — the `element-views` registry's keys (built-ins +
 *  any in user config). Server mode announces these so M-x routes them back
 *  down (RUN_CLIENT_COMMAND). Tolerant: [] before the stdlib registers any. */
function elementViewCommandNames() {
  try {
    const reg = interpreter.call('element-views');
    if (reg instanceof Map) {
      return [...reg.keys()].map((k) => lispText(k)).filter((n) => n !== '');
    }
  } catch { /* stdlib/registry not ready — element-views just aren't M-x-routable yet */ }
  return [];
}

function configureElementView() {
  return {
    // onKey routes chords to the server's keymap in server mode; flag-off
    // byte-for-byte (keymapReady ? dispatchKey : nothing).
    ...serverMediaKeyOption(),
    // Lets the hosted element run a Lisp `:on-ready` callback (its arg is
    // the embedded element instance).
    deliver: (callback, callArgs) =>
      deliverLispCallback(callback, callArgs, 'element-view'),
    // The generic insert-text channel: drop the element's text into the
    // ACTIVE view (the document — a :no-focus panel keeps focus there).
    // Routes through `(insert!)` so it shares undo / markers / watchers
    // with normal edits. Bib-agnostic — the bibliography panel uses it to
    // insert `\cite{…}`.
    insertText: (text) => {
      if (typeof text !== 'string' || text === '') return;
      // Server mode: route the insert to the SERVER's active buffer (the
      // document) — the in-renderer session is inert. The server fans the delta
      // back so the document updates.
      if (window.host && window.host.serverMode) {
        if (serverViewClient) serverViewClient.insertText(text);
        return;
      }
      try {
        interpreter.evaluate(`(insert! ${writeString(text)})`);
      } catch (error) {
        repl.appendError(
          `element-view insert-text: ${error.lispMessage ?? error.message ?? error}`
        );
      }
    },
    // The generic open-external channel: a hosted element asks the host to
    // open a resource in an OS app. bib-search uses it to open an entry's
    // PDF — `detail.bdsk` is a BibDesk `Bdsk-File-N` value (base64),
    // `detail.bibPath` the .bib's path (anchors the relativePath fallback).
    // The element gets a `pdf-opened` / `pdf-error` event back so it can
    // show feedback.
    openExternal: (detail) => {
      const bdsk = detail && detail.bdsk;
      if (typeof bdsk !== 'string' || bdsk === '') return;
      const reply = (type, info) => {
        const el = detail && detail.source;
        if (el && typeof el.dispatchEvent === 'function') {
          el.dispatchEvent(new CustomEvent(type, { detail: info }));
        }
      };
      if (!window.host || typeof window.host.bdskOpen !== 'function') {
        reply('pdf-error', { error: 'unavailable' });
        return;
      }
      Promise.resolve(
        window.host.bdskOpen({ bdsk, bibPath: detail.bibPath })
      ).then((result) => {
        if (result && result.ok) reply('pdf-opened', { path: result.path });
        else reply('pdf-error', { error: (result && result.error) || 'failed' });
      }).catch((error) => {
        reply('pdf-error', { error: error?.message ?? String(error) });
      });
    },
  };
}

/** The <element-view> element for VIEW — created (configured + mounted in
 *  PANE-EL) on first use, then reused. Like the browser, each element-host
 *  view owns its element and is never moved between panes. */
function ensureElementHostForView(view, paneEl) {
  let el = elementHostByView.get(view);
  if (el) {
    if (paneEl && el.parentNode !== paneEl) paneEl.append(el);
    el.setBuffer(view);
    return el;
  }
  el = /** @type {*} */ (document.createElement('element-view'));
  el.configure(configureElementView());
  // Server mode: mark a :no-focus panel (bib-search) so a click on it doesn't
  // send a focus-pane intent that would move the server's focus off the
  // document (which must stay active for the panel's insert-text to land).
  if (window.host && window.host.serverMode && view && view.noFocus) {
    el.dataset.noFocus = 'true';
  }
  el.setBuffer(view); // spec read on connectedCallback
  if (paneEl) paneEl.append(el); // triggers boot → import module + create tag
  elementHostByView.set(view, el);
  return el;
}

/** Show every element-host whose view is a leaf-direct active view; hide
 *  the rest. Called from `hideInactiveSingletons`. */
function hideInactiveElementHosts() {
  const active = new Set();
  for (const leaf of leafPanes(rootPane)) {
    if (!isTablineView(leaf.view) && leaf.view && leaf.view.kind === 'element') {
      active.add(leaf.view);
    }
  }
  for (const [view, el] of elementHostByView) {
    el.style.display = active.has(view) ? '' : 'none';
  }
}

/** Tear down the element-host bound to VIEW (on kill) — removes the
 *  embedded element, firing its own teardown (`destroy()` /
 *  `disconnectedCallback`). */
function disposeElementHostForView(view) {
  const el = elementHostByView.get(view);
  if (!el) return;
  try { el.destroy(); } catch { /* already gone */ }
  el.remove();
  elementHostByView.delete(view);
}

// --- documentation as a pane view (per-instance, mirrors the browser) ---
// A `doc`-kind view shows the navigable manual in a pane (bigger than the
// utility dock). Each doc view owns its own <doc-view> element so two doc
// panes can coexist; in-view navigation (links/sidebar/Next-Prev) replaces
// the focused doc pane's content in place via `openDocInPane`.
const docElementByView = new Map();

/** The <doc-view> element for doc VIEW, created/mounted in PANE-EL on first
 *  use then reused (the leaf-direct case; tabline tabs get theirs via
 *  ensureTabElement/editorByChild). */
function ensureDocElementForView(view, paneEl) {
  let el = docElementByView.get(view);
  if (el) {
    if (paneEl && el.parentNode !== paneEl) paneEl.append(el);
    el.setBuffer(view);
    return el;
  }
  el = /** @type {*} */ (document.createElement('doc-view'));
  el.configure(configureDocView());
  if (docNavTree) el.setManifest(docNavTree);
  el.setBuffer(view);
  if (paneEl) paneEl.append(el);
  docElementByView.set(view, el);
  return el;
}

/** Show leaf-direct doc elements whose view is active; hide the rest.
 *  Called from `hideInactiveSingletons`. */
function hideInactiveDocs() {
  const active = new Set();
  for (const leaf of leafPanes(rootPane)) {
    if (!isTablineView(leaf.view) && leaf.view && leaf.view.kind === 'doc') {
      active.add(leaf.view);
    }
  }
  for (const [view, el] of docElementByView) {
    el.style.display = active.has(view) ? '' : 'none';
  }
}

/** Tear down the doc element bound to VIEW (on kill). */
function disposeDocElementForView(view) {
  const el = docElementByView.get(view);
  if (!el) return;
  try { el.destroy(); } catch { /* already gone */ }
  el.remove();
  docElementByView.delete(view);
}

/** Push the navigation tree to every live doc element (leaf-direct + tabs),
 *  for the case where the manifest resolves after a doc pane is open. */
function broadcastDocManifest() {
  for (const el of docElementByView.values()) {
    if (typeof el.setManifest === 'function') el.setManifest(docNavTree);
  }
  for (const state of tablineStateByView.values()) {
    for (const [child, el] of state.editorByChild) {
      if (child.kind === 'doc' && el && typeof el.setManifest === 'function') {
        el.setManifest(docNavTree);
      }
    }
  }
}

/** Show pre-built doc HTML in a pane: navigate the focused doc pane in
 *  place if there is one, else open a fresh doc view. NAME is the node id /
 *  function name (used as the view's identity + so in-view nav knows where
 *  it is); LABEL is the tab/modeline title. */
function showDocInPane(name, html, label) {
  const cur = views[currentViewIndex];
  if (cur && cur.kind === 'doc') {
    cur.html = html;
    cur.docName = name;
    cur.name = label;
    const el = elementForViewInstance(cur);
    if (el && typeof el.setBuffer === 'function') el.setBuffer(cur);
    notifyViewsChanged();
    updateModeline();
    return;
  }
  const view = createView({
    kind: 'doc', name: label, extras: { html, docName: name },
  });
  views.push(view);
  notifyViewsChanged();
  switchToViewIndex(views.length - 1);
}

/** Open the documentation page for a node id / function name in a pane. */
async function openDocInPane(name) {
  let page;
  try {
    page = await window.host.readDocPage(name);
  } catch (error) {
    repl.appendError(`doc: ${error.message}`);
    return;
  }
  if (page === null) {
    repl.appendError(`no doc page for ${name}`);
    return;
  }
  const node = docNavTree && docNavTree.nodes ? docNavTree.nodes[name] : null;
  showDocInPane(name, page.html, node ? node.title : (name || 'Manual'));
}

// The directory tree-view — a `directory-tree`-kind buffer is shown
// through this view. Folder rows expand on click; file rows route
// through the host's open-file-path so they land in whichever view
// their suffix maps to (text editor, image, audio, video).
// Phase 3g: directory-tree is a custom element now. Factory reused by
// the tabline mount path for per-tab `<directory-tree-view>` instances.
function configureDirectoryTreeView() {
  const serverMode = !!(window.host && window.host.serverMode);
  return {
    // onKey routes chords to the server's keymap in server mode (so C-x C-f /
    // M-x reach it), else the in-renderer dispatchKey. Flag-off byte-for-byte.
    ...serverMediaKeyOption(),
    listDirectory: (path) => window.host.listDirectoryDetailedSync(path),
    // Colour file/folder icons from the vendored Material Icon Theme set.
    iconUrlFor: (name, isDirectory, expanded) =>
      materialIconUrlForEntry(name, isDirectory, expanded),
    openPath: (path) => {
      // Server mode: open the file by path through the server's find-file
      // (visitFile), switching the focused leaf onto it.
      if (serverMode) {
        if (serverViewClient) serverViewClient.visitPath(path);
        return;
      }
      // Route through the `directory-tree-open-file` Lisp function so the
      // target honours `*directory-tree-open-target*` and stays user-
      // overridable. Fall back to the focused-pane open if the stdlib
      // routing isn't available yet.
      if (keymapReady) {
        try {
          interpreter.call('directory-tree-open-file', path);
          return;
        } catch {
          /* fall through to the default */
        }
      }
      openFileInTabAdjacent(path);
    },
    closeBuffer: () => {
      // Server mode: closing a directory pane isn't wired server-side yet
      // (follow-on). The pane is replaced when a file is opened from it.
      if (serverMode) return;
      if (!keymapReady) return;
      try {
        interpreter.call('kill-view');
      } catch (error) {
        repl.appendError(`kill-view: ${error.lispMessage ?? error.message}`);
      }
    },
  };
}
const directoryTreeView = /** @type {*} */ (document.createElement('directory-tree-view'));
directoryTreeView.configure(configureDirectoryTreeView());
editorPaneElement().append(directoryTreeView);
directoryTreeView.style.display = 'none';

// The view-list view — a clickable HTML table of every open view (the
// *View List*, replacing the old text *Buffer List*). The element pulls
// its rows from getViews() on every render, so the host keeps it live by
// calling refresh() on notifyViewsChanged.

/** Map each on-screen view to the 1-based clockwise-spiral position of the
 *  pane showing it — the same numbering the swap-views / permute-views
 *  badges use, so the *View List*'s Pane column tracks where a view sits
 *  on screen (which shifts as panes are rearranged) rather than an internal
 *  leaf id (which doesn't). Tabline active children inherit their leaf's
 *  position; views in no pane are absent. */
function panePositionByView() {
  const hostRect = editorHostEl.getBoundingClientRect();
  const { indexByLeaf } = spiralOrder(rootPane, {
    width: hostRect.width,
    height: hostRect.height,
  });
  const byView = new Map();
  for (const leaf of leafPanes(rootPane)) {
    const slot = indexByLeaf.get(leaf);
    if (typeof slot !== 'number') continue;
    const position = slot + 1;
    let v = leaf.view;
    while (v && isTablineView(v)) {
      const child = tablineActiveChild(v);
      if (!child) break;
      if (!byView.has(child)) byView.set(child, position);
      v = child;
    }
    if (v && !isTablineView(v) && !byView.has(v)) byView.set(v, position);
  }
  return byView;
}

/** Plain-JS records for the view-list — one per open view, with a stable
 *  id so selection isn't ambiguous when two views share a name. Mirrors
 *  viewHost.listViewRecords (the Lisp `list-views`) but returns JS. */
function viewListRecords() {
  // Server mode: the *View List* shows the SERVER's open buffers — the
  // in-renderer `views[]` holds only the welcome seed (the real buffers live
  // server-side). Build rows from the last BUFFER_LIST; each row's id IS the
  // server buffer id, so selectView/killView route it to switch/close.
  if (window.host && window.host.serverMode && serverViewClient) {
    return serverViewClient.getBufferList().map((b) => ({
      id: b.id,
      name: b.name ?? '',
      kind: 'text',
      mode: null, // server-side major mode not surfaced yet (task: mode coverage)
      lines: typeof b.lineCount === 'number' ? b.lineCount : 0,
      pane: b.current ? 1 : null,
      file: b.filePath ?? null,
      modified: !!b.modified,
      current: !!b.current,
    }));
  }
  const paneByView = panePositionByView();
  const current = session.currentView;
  // Placeholders are transient chooser panes — excluded from the *View
  // List* table (decision 2). They keep no buffer and would only show
  // as noise rows the user can't meaningfully act on.
  return views.filter((view) => !isPlaceholderView(view)).map((view) => {
    const buffer = view.buffer;
    const major = buffer ? buffer.majorMode : null;
    const mode =
      major && typeof major.get === 'function' ? major.get(keyword('name')) : null;
    return {
      id: view.id,
      name: view.name ?? '',
      kind: view.kind,
      mode: typeof mode === 'string' ? mode : null,
      lines: buffer && typeof buffer.lineCount === 'number' ? buffer.lineCount : 0,
      pane: paneByView.get(view) ?? null,
      file: viewFilePath(view) ?? null,
      modified: buffer ? dirtyBuffers.has(buffer) : false,
      current: view === current,
    };
  });
}

function configureViewListView() {
  return {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    chordPending: () =>
      keymapReady && interpreter.call('chord-in-progress?') === true,
    getViews: viewListRecords,
    selectView: (id) => {
      // Server mode: the id is a server buffer id — switch to it (the server
      // re-syncs + re-pushes BUFFER_LIST, re-marking the active row/tab).
      if (window.host && window.host.serverMode && serverViewClient) {
        serverViewClient.switchBuffer(id);
        return;
      }
      const view = views.find((v) => v.id === id);
      if (view) switchToView(view);
    },
    killView: (id) => {
      // Server mode: close the server buffer (kill-buffer via switch + C-x k).
      if (window.host && window.host.serverMode && serverViewClient) {
        serverViewClient.closeBuffer(id);
        return;
      }
      const idx = views.findIndex((v) => v.id === id);
      if (idx !== -1) killViewAtIndex(idx);
    },
  };
}
const viewListView = /** @type {*} */ (document.createElement('view-list-view'));
viewListView.configure(configureViewListView());
editorPaneElement().append(viewListView);
viewListView.style.display = 'none';

// The *Recover* view — shown at startup when crash-recovery snapshots are
// found (see recovery.js + the autosave controller). It lists the
// recoverable buffers; the user recovers each into a live (unsaved)
// buffer or discards it.

/** The recoverable snapshots offered this session, mutated as the user
 *  recovers / discards rows. Populated by the startup scan. */
let recoverableSnapshots = [];

/** A snapshot's display name: its buffer name, else the file's basename,
 *  else a generic recovered-buffer label. */
function recoverDisplayName(snap) {
  if (snap.name) return snap.name;
  if (snap.path) return snap.path.split('/').pop() || snap.path;
  return '*recovered*';
}

/** Display records for the *Recover* table. */
function recoverViewRecords() {
  return recoverableSnapshots.map((s) => ({
    key: s.key,
    name: recoverDisplayName(s),
    path: s.path ?? null,
    savedAt: s.savedAt,
  }));
}

/** Drop a snapshot from the offered list and repaint the *Recover* view.
 *  The view stays open (showing an empty-state once the list clears) so
 *  the user closes it when ready. */
function removeRecoverEntry(key) {
  recoverableSnapshots = recoverableSnapshots.filter((s) => s.key !== key);
  recoverView.refresh();
}

/** Recover one snapshot: open its text as a live, dirty buffer (keeping
 *  the file path so `C-x C-s` overwrites the original), drop the on-disk
 *  snapshot, and remove the row. The recovered buffer is added as a
 *  background tab so the *Recover* list stays put for the next choice. */
function recoverSnapshot(key) {
  const snap = recoverableSnapshots.find((s) => s.key === key);
  if (!snap) return;
  const text = typeof snap.text === 'string' ? snap.text : '';
  // If this file is already open (session restore reopens every persisted
  // file from disk on startup), recover INTO that existing view —
  // overwrite its content with the recovered, unsaved text and mark it
  // dirty — rather than minting a SECOND view of the same path. A
  // duplicate would be persisted to session.json and then faithfully
  // re-created (openByPath uses forceDuplicate) on every later restore,
  // so the file would keep reappearing as an extra tabline tab.
  const existing = snap.path
    ? views.find(
        (v) => v.kind === 'text' && v.buffer && viewFilePath(v) === snap.path
      )
    : null;
  if (existing && typeof existing.buffer.setText === 'function') {
    existing.buffer.setText(text);
    dirtyBuffers.add(existing.buffer);
  } else {
    const buffer = createBuffer(text, { name: recoverDisplayName(snap) });
    if (snap.path) buffer.filePath = snap.path;
    const view = createView({ kind: 'text', buffer });
    views.push(view);
    // The recovered content is, by definition, unsaved.
    dirtyBuffers.add(buffer);
    const tlv = currentTablineView();
    if (tlv && !tlv.tabs.includes(view)) {
      addTabToTabline(tlv, view, tlv.tabs.length);
    }
  }
  window.host.deleteRecovery(key).catch(() => {});
  removeRecoverEntry(key);
  notifyViewsChanged();
}

/** Discard one snapshot: delete it from disk and remove the row. */
function discardSnapshot(key) {
  window.host.deleteRecovery(key).catch(() => {});
  removeRecoverEntry(key);
}

function configureRecoverView() {
  return {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    chordPending: () =>
      keymapReady && interpreter.call('chord-in-progress?') === true,
    getEntries: recoverViewRecords,
    recover: recoverSnapshot,
    discard: discardSnapshot,
    recoverAll: () => {
      for (const s of [...recoverableSnapshots]) recoverSnapshot(s.key);
    },
    discardAll: () => {
      for (const s of [...recoverableSnapshots]) discardSnapshot(s.key);
    },
  };
}
const recoverView = /** @type {*} */ (document.createElement('recover-view'));
recoverView.configure(configureRecoverView());
editorPaneElement().append(recoverView);
recoverView.style.display = 'none';

// The *RefTeX Select* picker — RefTeX's label / cite picker, mounted as a
// right-edge drawer overlaid on the editor (NOT a pane view). The panel
// is populated and driven entirely from Lisp (reftex-refs.lisp): the
// candidate model, the origin view+point, and the select / peek / cancel
// actions all live there. The host closures are thin bridges that marshal
// Lisp records into the renderer's plain-JS candidate objects and forward
// the user's choices back. See plans/RefTeX.md "The interactive views".
//
// reftexSelectCandidates reads a flat list the Lisp side prepared when
// the picker opened; each Lisp candidate is a list (name type macro
// context), which we map positionally into {name,type,macro,context}.
function reftexSelectCandidates() {
  if (!keymapReady) return [];
  try {
    const rows = listToArray(interpreter.call('reftex-select-candidates'));
    return rows.map((row) => {
      const fields = listToArray(row).map((v) => (v === NIL ? '' : String(v)));
      return {
        name: fields[0] ?? '',
        type: fields[1] ?? '',
        macro: fields[2] ?? '',
        context: fields[3] ?? '',
      };
    });
  } catch (error) {
    repl.appendError(`reftex-select: ${error.lispMessage ?? error.message}`);
    return [];
  }
}

/** Invoke a RefTeX-select Lisp callback (select / peek / cancel),
 *  swallowing and reporting any Lisp error so the picker never crashes
 *  the renderer. */
function reftexSelectCallback(name, arg) {
  if (!keymapReady) return;
  try {
    if (arg === undefined) interpreter.call(name);
    else interpreter.call(name, arg);
  } catch (error) {
    repl.appendError(`${name}: ${error.lispMessage ?? error.message}`);
  }
}

/** The cite *format menu* rows the Lisp side prepared: each Lisp row is
 *  `(key macro desc)`, mapped positionally to `{key, macro, desc}`. */
function reftexCiteFormats() {
  if (!keymapReady) return [];
  try {
    return listToArray(interpreter.call('reftex-cite-formats')).map((row) => {
      const f = listToArray(row).map((v) => (v === NIL ? '' : String(v)));
      return { key: f[0] ?? '', macro: f[1] ?? '', desc: f[2] ?? '' };
    });
  } catch (error) {
    repl.appendError(`reftex-cite: ${error.lispMessage ?? error.message}`);
    return [];
  }
}

/** The cheap cite *index* the Lisp side prepared: each Lisp row is
 *  `(key plain)`, mapped to `{key, plain}`. The picker filters this
 *  client-side; the CSL HTML is fetched lazily via `reftexCiteFormatted`
 *  for the rows actually shown, so a big bibliography isn't formatted
 *  whole. */
function reftexCiteIndex() {
  if (!keymapReady) return [];
  try {
    return listToArray(interpreter.call('reftex-cite-index')).map((row) => {
      const r = listToArray(row).map((v) => (v === NIL ? '' : String(v)));
      return { key: r[0] ?? '', plain: r[1] ?? '' };
    });
  } catch (error) {
    repl.appendError(`reftex-cite: ${error.lispMessage ?? error.message}`);
    return [];
  }
}

/** CSL-format just the entries named in KEYSCSV (the rows the picker is
 *  about to show), as `{key, html}` pairs. Backed by `reftex-cite-format`
 *  → `citation-format-keys` over a sub-handle. */
function reftexCiteFormatted(keysCsv) {
  if (!keymapReady || !keysCsv) return [];
  try {
    return listToArray(interpreter.call('reftex-cite-format', keysCsv)).map((row) => {
      const r = listToArray(row).map((v) => (v === NIL ? '' : String(v)));
      return { key: r[0] ?? '', html: r[1] ?? '' };
    });
  } catch (error) {
    repl.appendError(`reftex-cite: ${error.lispMessage ?? error.message}`);
    return [];
  }
}

/** Invoke a cite-flow Lisp callback (format-chosen / insert / cancel),
 *  reporting errors without crashing the renderer. */
function reftexCiteCallback(name, arg) {
  if (!keymapReady) return;
  try {
    if (arg === undefined) interpreter.call(name);
    else interpreter.call(name, arg);
  } catch (error) {
    repl.appendError(`${name}: ${error.lispMessage ?? error.message}`);
  }
}

/** R2: the *RefTeX Select* label/reference picker, as a utility-pane tab.
 *  Modal (captures keys, beats a focused webview); SPC-peek drives the editor
 *  pane underneath via the peek callback, then re-focuses the dock so the next
 *  key still feeds the panel. */
function openReftexSelectOverlay() {
  utilityDock.openUtilityPanel({
    id: 'reftex-select',
    title: 'RefTeX Select',
    icon: 'fa-solid fa-anchor',
    modal: true,
    makePanel: (dock) => createReftexSelectPanel({
      getCandidates: reftexSelectCandidates,
      onSelect: (name) => {
        // Lisp inserts at the origin + re-points editorView; closing the tab
        // then returns focus to that origin view.
        reftexSelectCallback('reftex-select-on-select', name);
        dock.close();
      },
      onPeek: (name) => {
        reftexSelectCallback('reftex-select-on-peek', name);
        dock.focus();
      },
      onCancel: () => {
        reftexSelectCallback('reftex-select-on-cancel');
        dock.close();
      },
    }),
  });
}

/** R3 step 1: the cite *format menu* (choose \cite / \citep / …) as the
 *  `reftex-cite` tab. Picking a format runs the Lisp callback, which calls
 *  open-reftex-cite-select! — re-opening the SAME tab id replaces the format
 *  menu with the picker in place (the swap). */
function openReftexCiteFormat() {
  utilityDock.openUtilityPanel({
    id: 'reftex-cite',
    title: 'Select citation format',
    icon: 'fa-solid fa-quote-right',
    modal: true,
    makePanel: (dock) => createReftexCiteFormatPanel({
      getFormats: reftexCiteFormats,
      onPick: (macro) => reftexCiteCallback('reftex-cite-format-chosen', macro),
      onCancel: () => {
        reftexCiteCallback('reftex-cite-on-cancel');
        dock.close();
      },
    }),
  });
}

/** R3 step 2: the cite *picker* (cheap index, lazily formats shown rows, mark
 *  + insert). Re-opens the `reftex-cite` tab, replacing the format menu. */
function openReftexCiteSelect() {
  utilityDock.openUtilityPanel({
    id: 'reftex-cite',
    title: 'Insert citation',
    icon: 'fa-solid fa-book',
    modal: true,
    makePanel: (dock) => createReftexCitePanel({
      getIndex: reftexCiteIndex,
      getFormatted: reftexCiteFormatted,
      onInsert: (keysCsv) => {
        reftexCiteCallback('reftex-cite-insert', keysCsv);
        dock.close();
      },
      onCancel: () => {
        reftexCiteCallback('reftex-cite-on-cancel');
        dock.close();
      },
    }),
  });
}

// The placeholder view — the chooser a freshly-split pane shows until
// the user decides what it should hold (replacing split's old silent
// auto-clone). Like browsers, placeholders are PER-INSTANCE, not a shared
// singleton: each split mints its own placeholder VIEW, and that view owns
// its own <placeholder-view> element, created in its pane and never moved.
// A placeholder is a transient `views` entry (so currentViewIndex / the
// modeline stay valid) but is excluded from the View List, skipped by
// next/previous-view, never persisted, and spliced out of `views` the
// instant it is filled or its pane is closed. See plans/PANES-PLACEHOLDER.md.
const placeholderElementByView = new Map();

/** A human label naming the origin view for the clone chip. */
function placeholderCloneLabel(originView) {
  const peeled = originView ? peelTabline(originView) : null;
  const v = peeled && !isTablineView(peeled) ? peeled : originView;
  if (!v) return 'the previous view';
  if (v.kind === 'text') return 'this buffer';
  const pretty =
    typeof v.kind === 'string' && v.kind.length > 0
      ? v.kind.charAt(0).toUpperCase() + v.kind.slice(1)
      : 'the previous view';
  return `the ${pretty.toLowerCase()} view`;
}

/** The configure options for a placeholder element bound to the
 *  placeholder VIEW shown in LEAF. Each closure resolves the leaf
 *  lazily by id (the tree is copy-on-write, so the leaf object can be
 *  re-created across a relayout — the id is stable). The actions all
 *  route through `replacePlaceholder` / the open + run-command paths,
 *  which splice the placeholder out of `views`. */
function configurePlaceholderView(view) {
  const findLeaf = () =>
    leafPanes(rootPane).find((l) => l.view === view) ?? null;
  const origin = () => (view && view.previousView) || null;
  return {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    cloneEnabled: !!origin(),
    cloneLabel: placeholderCloneLabel(origin()),
    defaultAction: () => {
      let raw = null;
      try {
        if (keymapReady) raw = interpreter.evaluate('*placeholder-default-action*');
      } catch {
        raw = null;
      }
      return resolvePlaceholderAction(raw);
    },
    onOpen: () => {
      const leaf = findLeaf();
      if (leaf) fillPlaceholderViaOpen(leaf);
    },
    onClone: () => {
      const leaf = findLeaf();
      if (!leaf) return;
      const cloned = cloneViewForPlaceholder(origin());
      replacePlaceholder(leaf, cloned);
    },
    onNewFile: () => {
      const leaf = findLeaf();
      if (!leaf) return;
      const scratch = createView({
        kind: 'text',
        buffer: createBuffer('', { name: '*scratch*' }),
      });
      replacePlaceholder(leaf, scratch);
    },
    onRunCommand: (text) => {
      const leaf = findLeaf();
      if (leaf) fillPlaceholderViaCommand(leaf, text);
    },
  };
}

/** The <placeholder-view> element for placeholder VIEW — created
 *  (configured + mounted in PANE-EL) on first use, then reused. The
 *  element is born in its pane and re-attached only if a relayout
 *  detached it (defensive), mirroring `ensureBrowserElementForView`. */
function ensurePlaceholderElementForView(view, paneEl) {
  let el = placeholderElementByView.get(view);
  if (el) {
    if (paneEl && el.parentNode !== paneEl) paneEl.append(el);
    return el;
  }
  el = /** @type {*} */ (document.createElement('placeholder-view'));
  el.configure(configurePlaceholderView(view));
  el.setBuffer(view);
  if (paneEl) paneEl.append(el);
  placeholderElementByView.set(view, el);
  return el;
}

/** Show every placeholder element whose view is a leaf-direct active
 *  view; hide the rest. Called from `hideInactiveSingletons`. */
function hideInactivePlaceholders() {
  const active = new Set();
  for (const leaf of leafPanes(rootPane)) {
    if (!isTablineView(leaf.view) && leaf.view && leaf.view.kind === 'placeholder') {
      active.add(leaf.view);
    }
  }
  for (const [view, el] of placeholderElementByView) {
    el.style.display = active.has(view) ? '' : 'none';
  }
}

/** Tear down the placeholder element bound to VIEW and drop it from the
 *  element map. Called when the placeholder is replaced or its pane is
 *  closed. */
function disposePlaceholderElementForView(view) {
  const el = placeholderElementByView.get(view);
  if (!el) return;
  try { el.destroy(); } catch { /* already gone */ }
  el.remove();
  placeholderElementByView.delete(view);
}

// The directory columns-view — Finder-style horizontal browser.
// Click a folder → spawns a column to its right; click a file →
// trailing column becomes a preview pane for the file. Double-click
// a file → opens it through the host's open-file-path so it lands
// in whichever view its suffix maps to.
// Phase 3g: directory-columns is a custom element now. Factory reused
// by the tabline mount path for per-tab `<directory-columns-view>` instances.
function configureDirectoryColumnsView() {
  const serverMode = !!(window.host && window.host.serverMode);
  return {
    // onKey routes to the server's keymap in server mode; flag-off byte-for-byte.
    ...serverMediaKeyOption(),
    listDirectory: (path) => window.host.listDirectoryDetailedSync(path),
    getPreview: (path) => buildColumnPreview(path),
    // Same tree-sitter highlighter registry the editor uses, so the
    // preview pane colourises the file the same way as if it were open.
    highlighters,
    openPath: (path) => {
      // Server mode: open by path through the server's find-file (visitFile).
      if (serverMode) {
        if (serverViewClient) serverViewClient.visitPath(path);
        return;
      }
      openFileInTabAdjacent(path);
    },
    onRevealInFolder: (path) => window.host.revealInFolder(path),
    onTrash: (path) => window.host.trashFile(path),
    onRename: (path, newName) => {
      const slash = path.lastIndexOf('/');
      const parent = slash >= 0 ? path.slice(0, slash) : '';
      const to = parent === '' ? newName : `${parent}/${newName}`;
      return window.host.renameFile(path, to);
    },
    closeBuffer: () => {
      // Server mode: closing a directory pane isn't wired server-side yet.
      if (serverMode) return;
      if (!keymapReady) return;
      try {
        interpreter.call('kill-view');
      } catch (error) {
        repl.appendError(`kill-view: ${error.lispMessage ?? error.message}`);
      }
    },
  };
}
const directoryColumnsView = /** @type {*} */ (document.createElement('directory-columns-view'));
directoryColumnsView.configure(configureDirectoryColumnsView());
editorPaneElement().append(directoryColumnsView);
directoryColumnsView.style.display = 'none';

// The bookmark view — a `bookmark`-kind buffer (extras.sourceBuffer is the
// text buffer it annotates) is shown through this outliner. Outline edits
// write back to the source buffer's metadata.bookmarks via `persist`.
function configureBookmarkView() {
  // Server mode: the outline is a MUTABLE 'bookmark' data-source. Its records
  // come from the server (on the bound view object), and edits are SEMANTIC ops
  // sent up (jump/rename/delete/indent/outdent/toggle) — the view never mutates
  // its own copy or touches buffer metadata; it re-renders from the fanned-out
  // state. Keys route to the SERVER keymap (serverMediaKeyOption), exactly like
  // the directory-tree / jukebox views; q closes the pane via C-x 0.
  if (window.host && window.host.serverMode) {
    return {
      ...serverMediaKeyOption(),
      closeBuffer: () => {
        if (serverViewClient) {
          serverViewClient.dispatchKey('C-x');
          serverViewClient.dispatchKey('0');
        }
      },
      // The view passes its bound source id; route the op to the server.
      emitOp: (sourceId, op) => {
        if (serverViewClient && sourceId) serverViewClient.bookmarkOp(sourceId, op);
      },
    };
  }
  return {
    ...(keymapReady ? { onKey: dispatchKey } : {}),
    // While a chord is mid-flight (C-x just pressed) the outline must
    // forward the *next* key — even a plain one like the `0` of `C-x 0`
    // — to the keymap instead of swallowing it; otherwise focus is
    // trapped in the outline and prefix chords (C-x 0/1/2/b/p …) die.
    chordPending: () =>
      keymapReady && interpreter.call('chord-in-progress?') === true,
    closeBuffer: () => {
      // q collapses the outline's pane (the source returns full-width);
      // the single outline view persists hidden and re-opens on C-x r l.
      const view = views.find((v) => v.kind === 'bookmark');
      if (!view) return;
      const leaf = leafPanes(rootPane).find((l) => l.view === view);
      if (leaf) deletePaneInTree(leaf);
    },
    persist: (buf) => {
      if (buf) scheduleMetadataWrite(buf);
    },
    jump: (buf, name) => {
      const idx = views.findIndex((v) => v.kind === 'text' && v.buffer === buf);
      if (idx < 0) return;
      // Focus the pane already showing the source (a direct leaf view OR a
      // tab in a tabline) BEFORE switching, so the jump lands there rather
      // than pulling the source into the outline's own (right) pane. Falls
      // back to the focused pane when the source isn't shown anywhere.
      const targetView = views[idx];
      const leaf = leafPanes(rootPane).find(
        (l) =>
          l.view === targetView ||
          (isTablineView(l.view) && l.view.tabs.includes(targetView))
      );
      if (leaf) setCurrentPaneId(leaf.id);
      switchToViewIndex(idx);
      // The engine now tracks `buf` (markers recreated on mount), so a
      // jump-by-name lands on the live marker, post-relocation.
      bookmarks.jump(name);
    },
  };
}
const bookmarkView = /** @type {*} */ (document.createElement('bookmark-view'));
bookmarkView.configure(configureBookmarkView());
editorPaneElement().append(bookmarkView);
bookmarkView.style.display = 'none';

// The shell view — a `shell`-kind buffer is shown through this view.
// v4: xterm.js owns the DOM. The host pipes pty bytes in and out;
// xterm.js parses every escape sequence, draws the grid, and emits
// resize requests when its fit-to-container addon decides cols/rows
// changed. The view stays subscribed across buffer switches so
// background commands keep streaming into the terminal.
// Phase 3h: shell-view is a custom element now. hide-not-kill: a pane
// disconnect fires disconnectedCallback, but the pty stays alive;
// only destroy() reaps it. Factory reused by the tabline mount path
// for per-tab `<shell-view>` instances — each shell view has its own
// pty session and its own xterm.
function configureShellView() {
  return {
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
  };
}
const shellView = /** @type {*} */ (document.createElement('shell-view'));
shellView.configure(configureShellView());
editorPaneElement().append(shellView);
shellView.style.display = 'none';
// xterm.js reads CSS variables once, at terminal construction. Pump
// any later theme change into it.
themeListeners.add(() => shellView.applyTheme());
// A theme switch changes every face colour — drop each minimap's cached
// palette so it repaints with the new colours.
themeListeners.add(() => forEachMinimapElement((el) => el.invalidateColors()));

// The gnuplot view — a notebook REPL over a long-lived gnuplot child.
// Like shell-view it's a hide-not-kill custom element; the factory is
// reused by the tabline mount path for per-tab `<gnuplot-view>`
// instances, each with its own gnuplot session. There's no resize
// channel (gnuplot is a plain pipe, no pty), but there is a `signal`
// member (C-c interrupts a running plot) and chord-key forwarding via
// `onKey` so the host keymap fires while the input is focused.
function configureGnuplotView() {
  return {
    spawn: (sessionId, opts) =>
      window.host && typeof window.host.gnuplotSpawn === 'function'
        ? window.host.gnuplotSpawn(sessionId, opts)
        : Promise.resolve({ ok: false, error: 'gnuplot IPC unavailable' }),
    write: (sessionId, data) =>
      window.host && typeof window.host.gnuplotWrite === 'function'
        ? window.host.gnuplotWrite(sessionId, data)
        : Promise.resolve({ ok: false }),
    signal: (sessionId) =>
      window.host && typeof window.host.gnuplotSignal === 'function'
        ? window.host.gnuplotSignal(sessionId)
        : Promise.resolve({ ok: false }),
    kill: (sessionId) =>
      window.host && typeof window.host.gnuplotKill === 'function'
        ? window.host.gnuplotKill(sessionId)
        : Promise.resolve({ ok: false }),
    onResult: (callback) =>
      window.host && typeof window.host.onGnuplotResult === 'function'
        ? window.host.onGnuplotResult(callback)
        : () => {},
    onExit: (callback) =>
      window.host && typeof window.host.onGnuplotExit === 'function'
        ? window.host.onGnuplotExit(callback)
        : () => {},
    chordPending: () =>
      keymapReady && interpreter.call('chord-in-progress?') === true,
    exportSvg: (svg, name) =>
      window.host && typeof window.host.gnuplotSaveSvg === 'function'
        ? window.host.gnuplotSaveSvg(svg, name)
        : Promise.resolve(null),
    setTheme: (sessionId, theme) =>
      window.host && typeof window.host.gnuplotSetTheme === 'function'
        ? window.host.gnuplotSetTheme(sessionId, theme)
        : Promise.resolve({ ok: false }),
    ...(keymapReady ? { onKey: dispatchKey } : {}),
  };
}
const gnuplotView = /** @type {*} */ (document.createElement('gnuplot-view'));
gnuplotView.configure(configureGnuplotView());
editorPaneElement().append(gnuplotView);
gnuplotView.style.display = 'none';
themeListeners.add(() => gnuplotView.applyTheme());

// The notebook view — a reactive Lisp notebook (a sheet of `(cell …)`
// cells). Per-view-instance like gnuplot: this singleton is the
// leaf-direct element and the factory is reused by the tabline mount
// path for per-tab `<notebook-view>` instances. Evaluation is in-process
// through the shared interpreter's reactive engine, so the only
// callbacks are `evaluate` (run the engine for this notebook id, marshal
// the per-cell records to plain JS) and chord-key forwarding so the host
// keymap fires while a cell editor is focused. `onSourceChange` (mirror
// the canonical source into a backing buffer) is wired with persistence.
const NOTEBOOK_KEYS = {
  name: keyword('name'),
  output: keyword('output'),
  state: keyword('state'),
  error: keyword('error'),
  graphic: keyword('graphic'),
  deps: keyword('deps'),
};
/** Marshal one Lisp cell-record map into a plain JS object. */
function marshalNotebookCell(m) {
  return {
    name: String(m.get(NOTEBOOK_KEYS.name) ?? ''),
    output: String(m.get(NOTEBOOK_KEYS.output) ?? ''),
    state: String(m.get(NOTEBOOK_KEYS.state) ?? 'ok'),
    error: String(m.get(NOTEBOOK_KEYS.error) ?? ''),
    graphic: String(m.get(NOTEBOOK_KEYS.graphic) ?? ''),
    deps: listToArray(m.get(NOTEBOOK_KEYS.deps) ?? NIL).map(String),
  };
}
function configureNotebookView() {
  return {
    evaluate: (id, source) => {
      try {
        const cells = listToArray(
          interpreter.call('notebook-eval!', id, source)
        );
        return cells.map(marshalNotebookCell);
      } catch {
        return [];
      }
    },
    chordPending: () =>
      keymapReady && interpreter.call('chord-in-progress?') === true,
    // A cell edit changed the canonical source (the view already wrote it
    // into buffer.text). Mark the buffer dirty so C-x C-s saves it and the
    // modeline shows the unsaved indicator.
    onSourceChange: (buffer) => {
      if (buffer) {
        dirtyBuffers.add(buffer);
        recovery.save();
        updateModeline();
      }
    },
    // The notebook picker: list the open notebooks and switch to one.
    listNotebooks: () =>
      views
        .filter((v) => v.kind === 'notebook')
        .map((v) => ({ id: v.notebookId, name: v.name ?? '*notebook*' })),
    selectNotebook: (id) => {
      const idx = views.findIndex(
        (v) => v.kind === 'notebook' && v.notebookId === id
      );
      if (idx !== -1) switchToViewIndex(idx);
    },
    renameNotebook: (id, name) => renameNotebookById(id, name),
    // Forward editor chords (C-x b, M-x, …) to the host keymap. Always
    // present and guarded at call time, so it works regardless of whether
    // the keymap had finished loading when this factory ran.
    onKey: (key) => keymapReady && dispatchKey(key),
  };
}
const notebookView = /** @type {*} */ (document.createElement('notebook-view'));
notebookView.configure(configureNotebookView());
editorPaneElement().append(notebookView);
notebookView.style.display = 'none';

// --- kind dispatch -----------------------------------------------------
//
// Phase 4a: the `kindRegistry` abstraction is gone. Every view kind is
// a custom element; mounting just means "tell the right singleton to
// `setBuffer(view)` and `focus()`", and disposing is mostly a no-op
// (the singleton's state is GC'd; only shell needs to reap a pty).
// The two helpers below replace the `kindRegistry.register` calls plus
// the `kindRegistry.mount` / `kindRegistry.dispose` dispatch.
//
// Renderer view modules still expose `setBuffer(viewOrNull)` for compat
// — the modules read `view.name`, `view.tracks`, `view.html`, etc., the
// same fields they used to read off the old buffer record.

/** The non-text singletons, in one place. `hideInactiveRendererViews`
 *  iterates this list to toggle display; `singletonElementForKind`
 *  looks up by kind. `releasesBuffer` flags the media-bearing singletons
 *  (audio / video / shell) — when their kind isn't in use anywhere,
 *  `hideInactiveRendererViews` also clears their buffer so a stale
 *  source doesn't keep playing / consuming memory. The other kinds
 *  (image / doc / customize / jukebox / directory-*) hang on to their
 *  last buffer, so reactivating them shows what was last there. */
const SINGLETON_VIEWS = [
  { kind: 'customize',         el: customizeView,         releasesBuffer: false },
  { kind: 'image',             el: imageView,             releasesBuffer: false },
  { kind: 'jukebox',           el: jukeboxView,           releasesBuffer: false },
  { kind: 'audio',             el: audioView,             releasesBuffer: true  },
  { kind: 'video',             el: videoView,             releasesBuffer: true  },
  { kind: 'pdf',               el: pdfView,               releasesBuffer: false },
  // browser is per-instance (browserElementByView) — not a singleton.
  { kind: 'directory-tree',    el: directoryTreeView,     releasesBuffer: false },
  { kind: 'view-list',         el: viewListView,          releasesBuffer: false },
  { kind: 'recover',           el: recoverView,           releasesBuffer: false },
  { kind: 'directory-columns', el: directoryColumnsView,  releasesBuffer: false },
  { kind: 'bookmark',          el: bookmarkView,          releasesBuffer: false },
  { kind: 'shell',             el: shellView,             releasesBuffer: true  },
  { kind: 'gnuplot',           el: gnuplotView,           releasesBuffer: true  },
  { kind: 'notebook',          el: notebookView,          releasesBuffer: false },
];

/** Side-effect bundle for mounting a text view: rebind the cursor,
 *  pin the editor as `currentTextBuffer`, re-subscribe sticky notes /
 *  buffer-watch / mode menu / Markdown preview, and ensure the major
 *  mode is set. Called by the text kind's mount AND by the tabline
 *  mount when a text tab becomes active — both paths need the same
 *  state shifts to keep the modeline / sticky-notes / Markdown preview
 *  in step with what's actually visible. The INSTANCE parameter is
 *  the editor-view to focus and re-point; null when the caller didn't
 *  resolve one (a tabline-routed mount that hasn't yet created the
 *  per-tab editor instance — the tabline's own mount path handles the
 *  instance work and calls this helper afterwards). */
function applyTextMountSideEffects(view, instance) {
  if (!view || view.kind !== 'text' || !view.buffer) return;
  // Server-backed (Model B) view: the SERVER owns the buffer, cursor, mode and
  // overlays. The in-renderer machinery below doesn't apply — and `bindCursor`
  // (an L2 Buffer method the ClientBuffer mirror lacks) would throw. Just point
  // the active editor at it and render; everything else is server-driven.
  if (isServerBackedView(view)) {
    if (instance) {
      editorView = instance;
      instance.setView(view);
      if (typeof instance.focus === 'function') instance.focus();
    }
    return;
  }
  currentTextBuffer = view.buffer;
  // Per-view-point (plans/PANES.md Q2): bind the buffer's cursor to
  // the view so the buffer's `point`/`mark` API reads and writes the
  // view's own fields. Two text views over one buffer can each own
  // their cursor; switching to a view rebinds the buffer to it.
  view.buffer.bindCursor(view);
  if (instance) {
    editorView = instance;
    instance.setView(view);
    // Per-tab text-views each have their own overlay layer. Re-point
    // sticky-notes at the now-active editor's overlay so notes render
    // on top of the right text-view, not whichever overlay was active
    // at boot.
    if (instance.overlayLayer) {
      stickyNotes.setOverlayLayer(instance.overlayLayer);
      // The inline-eval pill has the same per-pane problem: it must
      // render into the active editor's overlay. Without this, pills
      // were invisible in any pane not served by the boot-time editor
      // instance (e.g. every pane of a restored session).
      inlineEval.setOverlayLayer(instance.overlayLayer);
    }
  }
  stickyNotes.setBuffer(view.buffer);
  bookmarks.setBuffer(view.buffer);
  // If the bookmark outline is open beside us, follow focus to this buffer.
  followBookmarkView(view.buffer);
  watchCurrentBuffer();
  ensureMajorMode();
  if (editorView && typeof editorView.focus === 'function') editorView.focus();
  refreshModeMenu();
  syncMarkdownPreviewToBuffer();
}

/** Mount VIEW into the renderer. Dispatches by kind:
 *
 *   - text: ensure a per-leaf editor instance exists, then apply
 *     the text-mount side effects (modeline, sticky notes, …).
 *   - tabline: see `mountTablineKind` below — it manages its own
 *     state map and the active-child mount.
 *   - any other kind: tell the kind's singleton custom element to
 *     `setBuffer(view)` and `focus()`. Returns silently for an
 *     unknown kind (defensive; the strip's onSelect routes through
 *     here and must not crash if a malformed view sneaks in).
 *
 * The CONTEXT parameter is only consulted by the tabline branch
 * (it carries the host pane element when the caller can supply one).
 */
function mountKindView(view, context) {
  if (!view || typeof view.kind !== 'string') return;
  if (view.kind === 'text') {
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    const instance = leaf ? ensureEditorViewForLeaf(leaf) : null;
    applyTextMountSideEffects(view, instance);
    return;
  }
  if (view.kind === 'tabline') {
    mountTablineKind(view, context);
    return;
  }
  if (view.kind === 'browser') {
    // Per-instance: mount THIS view's own browser element in its pane.
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    const paneEl = leaf ? paneElements.get(leaf.id) : null;
    const el = ensureBrowserElementForView(view, paneEl);
    el.style.display = '';
    el.focus();
    return;
  }
  if (view.kind === 'doc') {
    // Per-instance, like browser: mount THIS doc view's own element.
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    const paneEl = leaf ? paneElements.get(leaf.id) : null;
    const el = ensureDocElementForView(view, paneEl);
    el.style.display = '';
    el.focus();
    return;
  }
  if (view.kind === 'placeholder') {
    // Per-instance, like browser: mount THIS placeholder's own element
    // in its pane and focus it so its accelerator keys are live.
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    const paneEl = leaf ? paneElements.get(leaf.id) : null;
    const el = ensurePlaceholderElementForView(view, paneEl);
    el.style.display = '';
    el.focus();
    return;
  }
  if (view.kind === 'element') {
    // Per-instance, like browser: mount THIS view's own element-host.
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    const paneEl = leaf ? paneElements.get(leaf.id) : null;
    const el = ensureElementHostForView(view, paneEl);
    el.style.display = '';
    el.focus();
    return;
  }
  if (view.kind === 'minimap') {
    // Per-instance companion: mount THIS minimap's element in its pane, but
    // do NOT focus it — clicks navigate the editor and the keyboard stays
    // with the document. Its content is bound via the (deferred) reconcile.
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    const paneEl = leaf ? paneElements.get(leaf.id) : null;
    const el = ensureMinimapElementForView(view, paneEl);
    el.style.display = '';
    scheduleMinimapReconcile();
    return;
  }
  const el = singletonElementForKind(view.kind);
  if (el) {
    // Re-parent the singleton into THIS view's pane element so it
    // actually appears there. `switchToViewIndex` did this inline, but
    // the split-with-view path (`splitPaneAtLeafWith`, how the bookmark
    // outline opens) did not — leaving the singleton mounted in its
    // previous parent while the freshly-split pane rendered blank ("the
    // pane appeared but nothing was shown"). Centralised here so every
    // leaf-direct singleton mount (switch / split / restore) is covered;
    // the restore path passes its pane element explicitly via context.
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    const paneEl =
      (context && context.paneEl) ||
      (leaf ? paneElements.get(leaf.id) : null);
    if (paneEl && el.parentNode !== paneEl) paneEl.append(el);
    el.setBuffer(view);
    // Callers may suppress the focus (a non-focused bookmark outline re-mounting
    // on a fan-out must not steal focus from the document). Default: focus.
    if (!context || context.focus !== false) el.focus();
  }
}

/** Dispose any kind-specific resources held by VIEW. Most kinds have
 *  none (the singleton's state is GC'd). Three exceptions:
 *
 *   - shell: kill the child process so it doesn't leak.
 *   - gnuplot: kill the gnuplot child so it doesn't leak.
 *   - tabline: detach the container and release the per-tabline state.
 */
function disposeKindView(view, context) {
  if (!view || typeof view.kind !== 'string') return;
  if (view.kind === 'browser') {
    // Per-instance: reap this view's own browser element + webview.
    disposeBrowserElementForView(view);
    return;
  }
  if (view.kind === 'doc') {
    // Per-instance: reap this doc view's own element.
    disposeDocElementForView(view);
    return;
  }
  if (view.kind === 'placeholder') {
    // Per-instance: reap this placeholder's own element.
    disposePlaceholderElementForView(view);
    return;
  }
  if (view.kind === 'element') {
    // Per-instance: reap this view's element-host (removes the embedded
    // element, firing its own teardown).
    disposeElementHostForView(view);
    return;
  }
  if (view.kind === 'minimap') {
    // Per-instance: reap this minimap's element (its destroy() drops the
    // adapter subscriptions + ResizeObserver). The target-leaf registry is
    // cleared by removeMinimapForLeaf; clear it here too for the rare path
    // where the minimap view is disposed directly.
    for (const [leafId, v] of [...minimapByTargetLeafId]) {
      if (v === view) minimapByTargetLeafId.delete(leafId);
    }
    disposeMinimapElementForView(view);
    return;
  }
  if (view.kind === 'shell') {
    if (typeof view.sessionId !== 'string') return;
    try {
      if (window.host && typeof window.host.shellKill === 'function') {
        window.host.shellKill(view.sessionId);
      }
    } catch {
      // Process is already gone — nothing to do.
    }
    return;
  }
  if (view.kind === 'gnuplot') {
    if (typeof view.sessionId !== 'string') return;
    try {
      if (window.host && typeof window.host.gnuplotKill === 'function') {
        window.host.gnuplotKill(view.sessionId);
      }
    } catch {
      // Process is already gone — nothing to do.
    }
    return;
  }
  if (view.kind === 'notebook') {
    // No subprocess; just drop the engine's stored notebook record so a
    // closed notebook's cell values don't linger.
    if (typeof view.notebookId === 'string') {
      try {
        if (keymapReady) interpreter.call('notebook-forget!', view.notebookId);
      } catch {
        // Engine not ready / already gone — nothing to do.
      }
    }
    return;
  }
  if (view.kind === 'tabline') {
    disposeTablineKind(view, context);
    return;
  }
}

// Tabline as a view kind (PANES.md, Q11 / PANES-PHASE-3B.md). A
// tabline-view is a *structural* view: it contains other views in its
// `tabs` array, with one active at a time, and renders a thin tab
// strip on one of the pane's four edges plus a content area where the
// active child mounts.
//
// Per-tabline state — the `<tabline-view>` container, the strip handle,
// the per-text-child editor instances — lives in `tablineStateByView`,
// keyed by the tabline-view itself. The mount hook builds it on first
// call and reuses it on subsequent calls (active-tab change, edge
// change, refresh after a tabs splice). The dispose hook tears the
// container down and destroys every editor instance.
//
// Recursion into the active child:
//   * text child  — a dedicated editor-view instance per child view,
//                   mounted inside the content area; switching tabs
//                   hides/shows siblings, so per-view-point survives.
//   * other kinds — for this phase, we recurse through
//                   `mountKindView(child)`. The existing non-text
//                   singletons (image, audio, ...) display-toggle their
//                   own DOM in `editorPaneElement()` — that pre-tabline
//                   placement remains until commit 5 rewires open-file
//                   to route into the active pane's tabline. With the
//                   commit-3 startup wrap all the restored tabs are
//                   text, so this gap doesn't bite at boot.
//
// Nested tabline-views (Q10): allowed. The recursion handles them
// naturally — a child can itself be a tabline-view, in which case the
// child's mount builds its own `<tabline-view>` inside the parent's
// `.tabline-content`. Disposal walks the same path.

/** Per-tabline-view rendering state. Each text tab has its own
 *  `<text-view>` element, tracked in `editorByChild` keyed by the tab's
 *  view. All of them live inside `state.contentEl` — that's where the
 *  tabline's tabs belong — and only the active one has `display: ''`;
 *  the rest have `display: none`. `activeEditor` / `activeEditorChild`
 *  are windows onto the map — pointers to "what's currently mounted." */
/** @type {Map<import('@editor/view').View, {
 *   container: HTMLElement,
 *   stripEl: HTMLElement,
 *   contentEl: HTMLElement,
 *   strip: { refresh: () => void, setEdge: (edge: string) => void },
 *   activeEditor: ReturnType<typeof createEditorView> | null,
 *   activeEditorChild: import('@editor/view').View | null,
 *   mountedChild: import('@editor/view').View | null,
 *   editorByChild: Map<import('@editor/view').View, *>,
 * }>} */
const tablineStateByView = new Map();

/** Build (or fetch) the per-tabline rendering state for VIEW. The
 *  container is created lazily; once built it survives until the
 *  tabline-view's dispose hook runs. */
function ensureTablineState(view) {
  let state = tablineStateByView.get(view);
  if (state) return state;

  // Phase 2d: the per-tabline container is now a `<tabline-view>`
  // custom element. In `data-host-managed` mode it skips its own auto-
  // mount so we can keep building the bespoke strip + resizer + content
  // structure inside it during the transition. The win for now is
  // structural: the element gives the tabline DOM identity, Q9-by-
  // construction at the container level, and lifecycle hooks. The full
  // tabs-as-children migration happens once Phase 3 has converted the
  // non-text kinds to custom elements (so they can actually live as
  // `<tabline-view>.children`).
  const container = /** @type {*} */ (document.createElement('tabline-view'));
  container.setAttribute('data-host-managed', '');
  container.dataset.edge = view.edge ?? 'top';
  container.dataset.tablineViewId = view.id;

  const stripEl = document.createElement('div');
  stripEl.className = 'tabline-strip';
  container.append(stripEl);

  // Resizer between strip and content. CSS shows it only for vertical
  // tabline edges (left/right). The drag handler reads/writes view.width
  // so the chosen width persists across edge changes and session restore.
  const resizerEl = document.createElement('div');
  resizerEl.className = 'tabline-resizer';
  container.append(resizerEl);
  attachTablineResizerDrag(resizerEl, view);

  const contentEl = document.createElement('div');
  contentEl.className = 'tabline-content';
  container.append(contentEl);

  // The strip is a per-tabline `createTabline`. Phase 3b (Q7): the
  // close `×` on a tab calls `kill-view!` against that tab's view,
  // so the tabline ↔ global-views interaction is one story — close
  // means kill (the view leaves both the global list AND every
  // tabline). The reorder + select callbacks stay tabline-local
  // (no global side-effects).
  const strip = createTabline(stripEl, {
    getTabs: () => view.tabs,
    getActiveIndex: () => view.active,
    edge: view.edge ?? 'top',
    onSelect: (i) => activateTabInTabline(view, i),
    onClose: (i) => {
      // A per-leaf server tabline (Step 3c): closing a tab un-curates that buffer
      // from THIS tabline (it lives on in the pool — NOT a global kill). Focus
      // the leaf, then send a close-tab pane intent; the server re-points to a
      // neighbour if the active tab closed and re-pushes PANE_TREE.
      if (view._serverLeafTabline) {
        const target = view.tabs[i];
        if (!target || !serverViewClient) return;
        const id = target === serverFacadeView
          ? serverViewClient.currentBufferId()
          : target._serverBufferId;
        if (!id) return;
        serverViewClient.sendPaneIntent({ op: 'focus-pane', paneId: view._serverLeafId });
        serverViewClient.sendPaneIntent({ op: 'close-tab', paneId: view._serverLeafId, bufferId: id });
        return;
      }
      const target = view.tabs[i];
      if (!target) return;
      const globalIdx = views.indexOf(target);
      if (globalIdx >= 0) killViewAtIndex(globalIdx);
      else removeTabInTabline(view, i);
    },
    onReorder: (from, to) => {
      // A per-leaf server tabline (Step 3c): the server owns the tab order, so a
      // drag routes UP (focus the leaf, then reorder its curated tabs); the
      // re-pushed PANE_TREE re-renders the strip in the new order. A local
      // splice would be reverted by the next reconcile.
      if (view._serverLeafTabline) {
        if (serverViewClient) {
          serverViewClient.sendPaneIntent({ op: 'focus-pane', paneId: view._serverLeafId });
          serverViewClient.sendPaneIntent({ op: 'reorder-tab', paneId: view._serverLeafId, from, to });
        }
        return;
      }
      reorderTabInTabline(view, from, to);
    },
  });

  state = {
    container,
    stripEl,
    resizerEl,
    contentEl,
    strip,
    activeEditor: null,
    activeEditorChild: null,
    mountedChild: null,
    editorByChild: new Map(),
  };
  tablineStateByView.set(view, state);
  applyTablineStripWidth(view);
  return state;
}

/** Default width (px) of a vertical tabline strip when the tabline-view
 *  has no user-set `width`. The min/max clamp the drag range. */
const TABLINE_STRIP_DEFAULT_WIDTH = 160;
const TABLINE_STRIP_MIN_WIDTH = 80;
const TABLINE_STRIP_MAX_WIDTH = 480;

/** Apply (or clear) the tabline-strip's inline width based on the view's
 *  edge + width. Vertical edges (left/right) get an explicit pixel width
 *  (view.width when set, default otherwise); horizontal edges clear it
 *  so the strip falls back to its 32px height-driven flex sizing. Called
 *  on mount, on edge changes, and after a resizer drag. */
function applyTablineStripWidth(view) {
  const state = tablineStateByView.get(view);
  if (!state) return;
  const isVertical = view.edge === 'left' || view.edge === 'right';
  if (isVertical) {
    const width = (typeof view.width === 'number' && view.width > 0)
      ? view.width
      : TABLINE_STRIP_DEFAULT_WIDTH;
    state.stripEl.style.width = `${width}px`;
  } else {
    state.stripEl.style.width = '';
  }
}

/** Pointer drag on the tabline-resizer: change view.width. Only fires
 *  when the tabline is on a vertical edge (the resizer is display:none
 *  otherwise; the guard inside makes it a no-op if someone forces an
 *  event in). On release, the session is asked to save so the chosen
 *  width survives a relaunch. */
function attachTablineResizerDrag(resizerEl, view) {
  resizerEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (view.edge !== 'left' && view.edge !== 'right') return;
    const state = tablineStateByView.get(view);
    if (!state) return;
    event.preventDefault();
    try { resizerEl.setPointerCapture(event.pointerId); } catch { /* tests */ }
    resizerEl.classList.add('is-dragging');
    const startX = event.clientX;
    const startWidth = state.stripEl.getBoundingClientRect().width;
    // For the right-edge tabline, the strip is on the right of the
    // container (visually) but still first in DOM (the container uses
    // row-reverse flex). Dragging the resizer rightward should SHRINK
    // the right strip; leftward should grow it. The opposite for left.
    const direction = view.edge === 'right' ? -1 : 1;
    const onMove = (ev) => {
      const delta = (ev.clientX - startX) * direction;
      const next = Math.max(
        TABLINE_STRIP_MIN_WIDTH,
        Math.min(TABLINE_STRIP_MAX_WIDTH, startWidth + delta)
      );
      view.width = next;
      state.stripEl.style.width = `${next}px`;
    };
    const onUp = (ev) => {
      resizerEl.classList.remove('is-dragging');
      try { resizerEl.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      // Persist the new width via the debounced session save.
      activeSession().save();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

/** The per-kind configure factory, or null when the kind isn't a
 *  non-text view managed by the tabline mount (text and tabline have
 *  their own paths). */
function perKindConfigureFactory(kind) {
  switch (kind) {
    case 'customize':         return configureCustomizeView;
    case 'image':             return configureImageView;
    case 'jukebox':           return configureJukeboxView;
    case 'audio':             return configureAudioView;
    case 'video':             return configureVideoView;
    case 'pdf':               return configurePdfView;
    case 'browser':           return configureBrowserView;
    case 'element':           return configureElementView;
    case 'doc':               return configureDocView;
    // Placeholders are leaf-direct only (a split's new pane); the
    // leaf-direct mount path (`ensurePlaceholderElementForView`) binds
    // the per-view closures. A placeholder should never become a tabline
    // tab, but if one ever does, give the strip a benign config whose
    // actions resolve the leaf by the active view — no crash, no orphan.
    case 'placeholder':       return () => configurePlaceholderView(null);
    case 'directory-tree':    return configureDirectoryTreeView;
    case 'directory-columns': return configureDirectoryColumnsView;
    case 'bookmark':          return configureBookmarkView;
    case 'view-list':         return configureViewListView;
    case 'recover':           return configureRecoverView;
    case 'shell':             return configureShellView;
    case 'gnuplot':           return configureGnuplotView;
    case 'notebook':          return configureNotebookView;
    default:                  return null;
  }
}

/** Ensure CHILD has its DOM element in STATE.editorByChild and parented
 *  in STATE.contentEl with `display: none`. Returns the element. Lazy,
 *  idempotent: a child that already has an element keeps it.
 *
 *  Each kind gets its own custom element instance:
 *  - text: `<text-view>` with closures bound to THIS child.
 *  - image / audio / video / customize / doc / jukebox / shell /
 *    directory-tree / directory-columns: the matching `<X-view>` via
 *    its per-kind configure factory.
 *  - tabline: the nested tabline's container (from `ensureTablineState`).
 *    Its content is mounted recursively when it becomes the active tab.
 *
 *  The map is the single source of truth for "what DOM elements does
 *  this tabline own." Removal goes through `removeTabInTabline`;
 *  dispose iterates the whole map. */
function ensureTabElement(state, child) {
  let el = state.editorByChild.get(child);
  if (el !== undefined) return el;

  if (child.kind === 'text' && child.buffer) {
    // Server-backed (Model B) tab — the façade rendering the active server
    // buffer. Its keys route to the server's keymap and its decorations come
    // from the mirror; mode/math-preview are server-side (so null/[] here).
    // Every other tab keeps the in-renderer wiring exactly as before.
    const serverBacked = isServerBackedView(child);
    el = /** @type {*} */ (document.createElement('text-view'));
    el.configure({
      ...(serverBacked
        ? { onKey: (key) => (serverViewClient ? serverViewClient.dispatchKey(key) : false) }
        : (keymapReady ? { onKey: dispatchKey } : {})),
      highlighters,
      foldCaptures,
      getPoint: () => typeof child.point === 'number' ? child.point : 0,
      getMark: () => child.mark !== undefined ? child.mark : null,
      getCursors: () => {
        if (Array.isArray(child.cursors)) return child.cursors;
        return [{
          point: typeof child.point === 'number' ? child.point : 0,
          mark: child.mark !== undefined ? child.mark : null,
        }];
      },
      getTabWidth: () => currentTabWidth,
      // Snippet field + mirror boxes for this tab's buffer (server-backed: the
      // server-pushed overlays / multi-cursor set on the mirror instead).
      getDecorations: serverBacked
        ? () => (child.buffer && Array.isArray(child.buffer.decorations)
          ? child.buffer.decorations : [])
        : () => snippetDecorationsFor(child.buffer ?? null),
      // Per-view math preview — the leaf-direct path
      // (`ensureEditorViewForLeaf`) wires this too; a tabline tab must
      // have it as well or math-preview-mode renders nothing in tabs.
      // The tab IS a plain text view (no tabline to peel), so the handle
      // points `view`/`id` straight at `child` and supplies this tab's
      // own element for the MathJax-startup re-render. (Server-backed: math
      // preview is a server-side feature, so [] here.)
      getReplacedRanges: serverBacked
        ? () => []
        : () => getMathReplacedRanges({ id: child, view: child, element: el }),
      getMajorModeName: serverBacked
        ? () => null
        : () => bufferMajorModeName(child.buffer ?? null, keyword),
      getOverrideGeneration: () => highlightOverrideStore.generation(),
      onRenderError: (error) => reportRendererFault('render error', error),
    });
    el.setView(child);
  } else if (child.kind === 'tabline') {
    // Nested tabline: the per-tabline state owns the container element.
    const nestedState = ensureTablineState(child);
    el = nestedState.container;
  } else {
    const factory = perKindConfigureFactory(child.kind);
    if (!factory) return null;
    el = /** @type {*} */ (document.createElement(child.kind + '-view'));
    el.configure(factory());
    el.setBuffer(child);
  }

  state.editorByChild.set(child, el);
  if (el.parentNode !== state.contentEl) {
    state.contentEl.append(el);
  }
  // Don't pre-set display here. The element inherits its CSS default
  // (block/flex per the per-kind rule), which lets `connectedCallback`
  // initialise the inner DOM with proper layout dimensions. The caller
  // is responsible for setting `display: 'none'` on inactive tabs and
  // `display: ''` on the active one (the display loop in
  // `mountTablineActiveChild`, or `addTabToTabline` for new tabs).
  return el;
}

/** Re-mount the active child of TABLINEVIEW into its content area.
 *
 *  Each tab has its own DOM element (per-view-instance, not a shared
 *  singleton-per-kind). Every tab — text, non-text, nested tabline —
 *  gets its element eagerly created and parented inside `contentEl`,
 *  with `display: none`. The active tab gets `display: ''`. Switching
 *  tabs is a CSS toggle, never element re-creation. Session-restored
 *  tablines come up with every tab already "live" in the DOM. */
function mountTablineActiveChild(tablineView) {
  const state = tablineStateByView.get(tablineView);
  if (!state) return;
  // A tab switch / close / activation changes what a minimap on this leaf
  // mirrors — reconcile after the mount settles (deferred microtask).
  scheduleMinimapReconcile();

  // Eager creation for non-text tabs: each one gets its element built
  // up-front so a session restore with N tabs comes up with N elements
  // in contentEl, not lazy-on-click. Text tabs stay lazy here — the
  // inner editor's line-height / scroll measurement reads the container
  // bounding box, which is zero under `display: none`, so we let the
  // active text-view be created the moment it's activated (with the
  // correct dimensions). Non-text tabs don't measure font metrics, so
  // they're safe to create hidden.
  for (const tab of tablineView.tabs) {
    if (tab.kind !== 'text') ensureTabElement(state, tab);
  }

  const child = (typeof tablineView.active === 'number' &&
                 tablineView.active >= 0 &&
                 tablineView.active < tablineView.tabs.length)
    ? tablineView.tabs[tablineView.active] ?? null
    : null;
  state.mountedChild = child;

  if (!child) {
    // Empty tabline: hide every element. They stay parented in
    // contentEl so the DOM reflects the tabline's actual membership.
    for (const el of state.editorByChild.values()) {
      el.style.display = 'none';
    }
    state.activeEditor = null;
    state.activeEditorChild = null;
    return;
  }

  // Orphan sweep: any view-element in contentEl that isn't in
  // editorByChild is leftover from a path that removed the map entry
  // without removing the DOM (or appended without registering).
  // Remove them; the tabline-view-element bookkeeping is authoritative.
  const knownEls = new Set(state.editorByChild.values());
  for (const childEl of [...state.contentEl.children]) {
    const tag = childEl.tagName.toLowerCase();
    if (tag.endsWith('-view') && !knownEls.has(childEl)) {
      try { childEl.destroy?.(); } catch { /* tolerant */ }
      childEl.remove();
    }
  }
  // Show only the active element; hide all others.
  for (const [otherChild, otherEl] of state.editorByChild) {
    otherEl.style.display = otherChild === child ? '' : 'none';
  }

  if (child.kind === 'tabline') {
    // Nested tabline-views (Q10). Recurse — the child's mount manages
    // its own tabs inside its container (already in our contentEl via
    // ensureTabElement). Sweep singletons only; never touch the
    // focused leaf's text-view from this branch (the activated
    // tabline may live in a *non-focused* pane, in which case the
    // focused leaf's display state has nothing to do with us).
    state.activeEditor = null;
    state.activeEditorChild = null;
    hideInactiveSingletons();
    mountKindView(child, { paneEl: state.contentEl });
    return;
  }

  if (child.kind === 'text' && child.buffer) {
    // Sweep singletons (the leaf-direct-view path uses them; the
    // tabline path uses per-tab elements, so the singletons go quiet
    // when a tabline's active tab is text). Same as the tabline
    // branch above: never touch the focused leaf's text-view here.
    hideInactiveSingletons();
    // Lazy creation for text — see the eager-loop comment above for
    // why text tabs need to be created at the moment they're activated,
    // not pre-built hidden.
    const tv = ensureTabElement(state, child);
    if (tv !== null) tv.style.display = '';
    state.activeEditor = tv;
    state.activeEditorChild = child;
    applyTextMountSideEffects(child, tv);
    return;
  }

  // Non-text active child: focus the per-tab element. Singletons get
  // swept for visibility-cascade reasons; per-tab text-views in any
  // other pane's tabline are owned by their own mount. The focused
  // leaf's leaf-direct text-view (when there is one) is only
  // toggled by the path that *changed* the focused leaf's view —
  // not as a side effect of a click in another tabline.
  const activeEl = state.editorByChild.get(child);
  state.activeEditor = null;
  state.activeEditorChild = null;
  hideInactiveSingletons();
  if (activeEl && typeof activeEl.focus === 'function') {
    activeEl.focus();
  }
}

/** The renderer-singleton element for a non-text view kind, or null if
 *  the kind doesn't have a known singleton. Used by the tabline mount
 *  to re-parent the active singleton into its content area. */
function singletonElementForKind(kind) {
  const entry = SINGLETON_VIEWS.find((s) => s.kind === kind);
  return entry ? entry.el : null;
}

/** The per-view-instance DOM element backing a view object. A View in a
 *  tabline owns its element via `editorByChild`; a leaf-direct
 *  non-text view falls back to the per-kind singleton. Returns null
 *  when neither is mounted yet. Used by the Lisp surface to reach the
 *  current view's element-side API (e.g. pdf-extract-text). */
function elementForViewInstance(view) {
  if (!view || typeof view.kind !== 'string') return null;
  for (const state of tablineStateByView.values()) {
    const el = state.editorByChild.get(view);
    if (el !== undefined) return el;
  }
  // Browsers and docs are per-instance, keyed by view rather than a singleton.
  if (view.kind === 'browser' && browserElementByView.has(view)) {
    return browserElementByView.get(view);
  }
  if (view.kind === 'doc' && docElementByView.has(view)) {
    return docElementByView.get(view);
  }
  if (view.kind === 'element' && elementHostByView.has(view)) {
    return elementHostByView.get(view);
  }
  return singletonElementForKind(view.kind);
}

/** Invoke a Lisp callback with the given JS-side arguments. The
 *  callback may be either a symbol (looked up as a global procedure
 *  name) or a procedure value (lambda / primitive); errors raised
 *  during the call land in the REPL under PRIMNAME so an async result
 *  delivery can't crash the surrounding event. */
function deliverLispCallback(callback, callArgs, primName) {
  try {
    if (callback instanceof Sym) {
      interpreter.call(callback.name, ...callArgs);
    } else {
      applyProcedure(callback, callArgs);
    }
  } catch (error) {
    repl.appendError(
      `${primName} callback: ${error.lispMessage ?? error.message ?? error}`
    );
  }
}

/** Activate tab INDEX in TABLINEVIEW, refresh the strip, and re-mount
 *  the active child. Idempotent on the current active index.
 *
 *  When the activated tabline belongs to the focused leaf, this also
 *  syncs `currentViewIndex` to the new active tab's position in the
 *  global `views` list and refreshes the modeline. Without that step
 *  the modeline would still show whichever tab was active before —
 *  visible in particular on directory-tree double-click and other
 *  tab-activating paths that bypass `switchToViewIndex` (its own
 *  tabline branch already does this synchronisation). */
function activateTabInTabline(tablineView, index) {
  if (!Array.isArray(tablineView.tabs)) return;
  if (index < 0 || index >= tablineView.tabs.length) return;
  // A per-leaf server tabline (Step 3c): clicking a tab focuses THIS leaf on the
  // server (the click may be in a non-focused pane), then switches its active
  // tab. Both route up; the server re-pushes PANE_TREE and the reconcile
  // re-renders the strip with the new active tab. The active tab IS the façade
  // (switch is a server no-op); a proxy carries its own id.
  if (tablineView._serverLeafTabline) {
    if (!serverViewClient) return;
    const target = tablineView.tabs[index];
    const id = target === serverFacadeView
      ? serverViewClient.currentBufferId()
      : (target && target._serverBufferId);
    serverViewClient.sendPaneIntent({ op: 'focus-pane', paneId: tablineView._serverLeafId });
    if (id) serverViewClient.switchBuffer(id);
    return;
  }
  tablineView.active = index;
  const state = tablineStateByView.get(tablineView);
  if (state) state.strip.refresh();
  mountTablineActiveChild(tablineView);
  // If this tabline lives in the focused leaf, the user just changed
  // what they see — keep the global pointers in step.
  const focused = currentPane();
  if (focused && focused.view === tablineView) {
    const child = tablineActiveChild(tablineView);
    if (child) {
      const viewIdx = views.indexOf(child);
      if (viewIdx >= 0) currentViewIndex = viewIdx;
      updateModeline();
    }
  }
}

/** Remove tab INDEX from TABLINEVIEW. Adjusts `active` to land on the
 *  previous tab (or 0); when the last tab is removed `active` becomes
 *  0 and the content area goes empty. The kill-view path layers auto-
 *  collapse on top: a tabline that goes empty triggers `delete-pane!`
 *  on its leaf (or, for the root-pane case, a fresh `*scratch*` view
 *  is installed instead). */
function removeTabInTabline(tablineView, index) {
  if (!Array.isArray(tablineView.tabs)) return;
  if (index < 0 || index >= tablineView.tabs.length) return;
  const removed = tablineView.tabs[index];
  tablineView.tabs.splice(index, 1);
  const state = tablineStateByView.get(tablineView);
  if (state && state.activeEditorChild === removed) {
    state.activeEditorChild = null;
    state.activeEditor = null;
  }
  // Drop the per-child element for the removed tab. Destroy releases
  // any inner-view state (buffer subscriptions, pty handles, media
  // sources); `remove()` detaches the wrapper from contentEl so it
  // doesn't accumulate as an orphan after the tab is gone.
  if (state) {
    const removedEl = state.editorByChild.get(removed);
    if (removedEl !== undefined) {
      try { removedEl.destroy?.(); } catch { /* tolerant */ }
      try { removedEl.remove(); } catch { /* already detached */ }
      state.editorByChild.delete(removed);
    }
  }
  // Re-anchor active: if we removed the active tab (or one before it),
  // step back so we land on a valid index.
  if (tablineView.tabs.length === 0) {
    tablineView.active = 0;
  } else if (index < tablineView.active) {
    tablineView.active -= 1;
  } else if (index === tablineView.active) {
    tablineView.active = Math.max(0, index - 1);
  }
  if (state) state.strip.refresh();
  mountTablineActiveChild(tablineView);
}

/** Reorder a tab from FROM to TO inside TABLINEVIEW, updating active
 *  so it re-points at its (moved) original element. */
function reorderTabInTabline(tablineView, from, to) {
  if (from === to) return;
  if (!Array.isArray(tablineView.tabs)) return;
  if (from < 0 || from >= tablineView.tabs.length) return;
  if (to < 0 || to >= tablineView.tabs.length) return;
  const moved = tablineView.tabs.splice(from, 1)[0];
  tablineView.tabs.splice(to, 0, moved);
  // Re-anchor active onto its (possibly moved) view.
  if (from === tablineView.active) {
    tablineView.active = to;
  } else if (from < tablineView.active && to >= tablineView.active) {
    tablineView.active -= 1;
  } else if (from > tablineView.active && to <= tablineView.active) {
    tablineView.active += 1;
  }
  const state = tablineStateByView.get(tablineView);
  if (state) state.strip.refresh();
}

/** Mount the tabline-view inside the pane element supplied via the
 *  context. Falls back to the focused leaf's pane element when no
 *  context is given (defensive — every caller should pass paneEl). */
function mountTablineKind(view, context) {
  let paneEl = context && context.paneEl ? context.paneEl : null;
  if (!paneEl) {
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    paneEl = leaf ? paneElements.get(leaf.id) : null;
  }
  if (!paneEl) return; // Nowhere to render — drop quietly.
  const state = ensureTablineState(view);
  if (state.container.parentNode !== paneEl) paneEl.append(state.container);
  state.container.dataset.edge = view.edge ?? 'top';
  state.strip.setEdge(view.edge ?? 'top');
  applyTablineStripWidth(view);
  state.strip.refresh();
  mountTablineActiveChild(view);
}

/** Dispose the tabline-view: destroy every per-tab editor and detach
 *  the container. Does not dispose the child views' own state (a
 *  non-text singleton's resources belong to the singleton, not to the
 *  tabline). */
function disposeTablineKind(view) {
  const state = tablineStateByView.get(view);
  if (!state) return;
  // Destroy every per-tab element. `editorByChild` is the source of
  // truth; `activeEditor` is just a window onto the active entry and
  // gets cleared with the rest. Detach each element from the DOM so
  // no orphan wrappers survive in the (about-to-be-removed) contentEl.
  for (const el of state.editorByChild.values()) {
    try { el.destroy?.(); } catch { /* half-mounted is fine */ }
    try { el.remove(); } catch { /* already detached */ }
  }
  state.editorByChild.clear();
  state.activeEditor = null;
  state.activeEditorChild = null;
  if (state.container.parentNode) state.container.remove();
  tablineStateByView.delete(view);
}

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
const hoverDoc = createHoverDoc(editorView, {
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

// Bookmarks fill no overlay — they're invisible named positions backed by
// buffer markers (see bookmarks.js), persisted through the same companion-
// metadata pipeline the notes use.
const bookmarks = createBookmarks({
  onChange: () => {
    scheduleMetadataWrite(currentTextBuffer);
    refreshBookmarkOutline();
  },
});
bookmarks.setBuffer(currentTextBuffer);

// --- Markdown preview pane ---------------------------------------------
// A toggleable pane (markdown-preview, C-c v) that renders the current
// markdown-mode buffer to HTML through the same JMarkdown pipeline the
// sticky notes use, refreshing — debounced — as the buffer is edited.

/** Typeset mathematics inside the preview iframe, once its own MathJax
 *  has started. The iframe loads its own MathJax (see buildPreviewHead),
 *  so this runs against THAT instance, not the editor's. `elements` is
 *  the set to typeset: the whole body `[body]` after a rebuild, or just
 *  the math spans morphdom brought in fresh on the incremental path. */
function typesetPreview(frameWindow, elements) {
  const mathJax = frameWindow && frameWindow.MathJax;
  if (!mathJax) return;
  if (!Array.isArray(elements) || elements.length === 0) return;
  const run = () => {
    if (typeof mathJax.typesetPromise === 'function') {
      mathJax.typesetPromise(elements).catch(() => {});
    }
  };
  const ready = mathJax.startup && mathJax.startup.promise;
  if (ready) ready.then(run).catch(() => {});
  else run();
}

/** Build an `app://editor/__host__/…` URL for an absolute file path —
 *  the renderer-side mirror of serve.js's `hostFileUrl` (keep in sync).
 *  Serves any local file same-origin, so the preview iframe can load the
 *  book's CSS and a file's relative assets. */
function hostFileUrl(filePath) {
  return (
    'app://editor/__host__' +
    filePath.split('/').map(encodeURIComponent).join('/')
  );
}

/** The MathJax config the preview iframe uses — mirrors index.html. */
const PREVIEW_MATHJAX_CONFIG = {
  tex: {
    inlineMath: [['$', '$'], ['\\(', '\\)']],
    displayMath: [['$$', '$$'], ['\\[', '\\]']],
    // Honour `\$` as a literal dollar (renderMarkdown preserves it), so a
    // price like "\$45" isn't paired into math.
    processEscapes: true,
  },
  svg: { fontCache: 'local' },
  startup: { typeset: false },
};
const PREVIEW_MATHJAX_SRC =
  'app://editor/apps/desktop/vendor/mathjax/tex-svg.js';
const PREVIEW_DEFAULT_CSS_URL =
  'app://editor/apps/desktop/markdown-preview.css';

/** The current markdown buffer's directory as a base URL the iframe
 *  resolves relative assets against — or null for an unsaved buffer. */
function currentPreviewBaseUrl() {
  const path = currentTextBuffer && currentTextBuffer.filePath;
  if (typeof path !== 'string' || path === '') return null;
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  return dir ? hostFileUrl(dir) : null;
}

/** The user's `*markdown-preview-css*` paths as iframe-loadable URLs.
 *  Absolute (and `~`) paths go through the host-file scheme; a relative
 *  path is left as-is to resolve against the iframe's <base>. */
function currentPreviewCssUrls() {
  let paths = [];
  try {
    paths = listToArray(interpreter.evaluate('*markdown-preview-css*')).map(String);
  } catch {
    paths = [];
  }
  return paths.map((p) => {
    let path = p;
    if (path.startsWith('~/')) path = window.host.homeDirectory + path.slice(1);
    return path.startsWith('/') ? hostFileUrl(path) : path;
  });
}

/** Whether the built-in preview stylesheet should be linked. */
function previewDefaultStyleOn() {
  try {
    return interpreter.evaluate('*markdown-preview-default-style*') !== false;
  } catch {
    return true;
  }
}

/** The <head> for the preview iframe: base + stylesheets + MathJax. */
function buildPreviewFrameHead() {
  return buildPreviewHead({
    baseUrl: currentPreviewBaseUrl(),
    cssUrls: currentPreviewCssUrls(),
    defaultCssUrl: previewDefaultStyleOn() ? PREVIEW_DEFAULT_CSS_URL : null,
    mathjaxSrc: PREVIEW_MATHJAX_SRC,
    mathjaxConfig: PREVIEW_MATHJAX_CONFIG,
  });
}

const markdownPreview = createMarkdownPreview(
  document.getElementById('markdown-preview-host'),
  {
    render: renderNoteHtml,
    buildHead: buildPreviewFrameHead,
    typeset: typesetPreview,
  }
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
const utilitySplitterEl = document.getElementById('utility-splitter');

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

const utilitySplitter = createSplitter({
  orientation: 'vertical',
  element: utilitySplitterEl,
  target: document.body,
  // Legacy var/key names kept so persisted panes.json needs no migration.
  cssVar: '--repl-height',
  min: 80,
  // The workspace + chrome above the dock needs at least 300px.
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
        utilitySplitter.set(stored.replHeight);
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

// A native Quit (Cmd+Q / app-menu Quit) is intercepted in the main
// process and routed here, so it gets the same unsaved-changes confirm
// and metadata flush as C-x C-c (quitInteractive) instead of dropping
// edits silently. quitInteractive calls host.quit() to actually exit.
if (window.host && typeof window.host.onConfirmQuit === 'function') {
  window.host.onConfirmQuit(() => {
    quitInteractive();
  });
}

// Wire the one-shot process runner's completion channel exactly once.
// When a `(run-process! …)` child exits, the host sends one
// `process:exit` with the buffered output; we look up the parked
// on-exit Lisp procedure (keyed by runId), build the result hash-map
// `{:stdout :stderr :code}`, apply the procedure, and forget the entry.
if (window.host && typeof window.host.onRunProcessExit === 'function') {
  window.host.onRunProcessExit(({ runId, stdout, stderr, code }) => {
    const proc = runProcessCallbacks.get(runId);
    runProcessCallbacks.delete(runId);
    if (proc == null || proc === NIL) return;
    const result = new Map();
    result.set(keyword('stdout'), typeof stdout === 'string' ? stdout : '');
    result.set(keyword('stderr'), typeof stderr === 'string' ? stderr : '');
    result.set(keyword('code'), typeof code === 'number' ? code : NIL);
    try {
      applyProcedure(proc, [result]);
    } catch (error) {
      repl.appendError(error.lispMessage ?? error.message ?? String(error));
    }
  });
}

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
// Phase 3b: the window-chrome `#tabline-host` strip is gone. The root
// pane now holds a tabline-view (its mount draws the strip inside the
// pane), and every per-pane tabline-view's strip refreshes through
// `refreshPaneTabStrips()` whenever the view list / current view
// changes. The auto-add-tab / leaf-swap routing on open-file lands in
// commit 5; this commit only wires the boot wrap and the helpers the
// rest of the app can call into.

/** Walk the pane tree and refresh every tabline-view's strip, including
 *  nested tabline-views (Q10). Replaces the singleton `tabline.refresh()`
 *  call the chrome strip used to drive. Cheap: a no-op when no pane
 *  holds a tabline-view; otherwise one `strip.refresh()` per tabline. */
function refreshPaneTabStrips() {
  function visit(view) {
    if (!isTablineView(view)) return;
    const state = tablineStateByView.get(view);
    if (state) state.strip.refresh();
    for (const child of view.tabs) visit(child);
  }
  for (const leaf of leafPanes(rootPane)) visit(leaf.view);
}

/** The tabline-view installed by `wrapRootInTabline()` at boot, kept
 *  as a module-level handle so the kill-view path can recognise the
 *  root-pane case for its scratch-substitution fallback (Q6). Null
 *  before the wrap runs, and after `demote-tabline!` collapses it. */
let rootTablineView = null;

/** The id of the leaf the root tabline was wrapped onto at boot.
 *  Tracked alongside `rootTablineView`; cleared at the same time. */
let rootTablineLeafId = null;

/** Pre-seed TABLINEVIEW's single editor instance with the existing
 *  per-pane editor bound to LEAF, so the tabline mount reuses it for
 *  the active child instead of constructing a fresh one. This is what
 *  keeps sticky-notes / hover-doc / inline-eval bindings alive across
 *  the boot wrap and the `promote-to-tabline!` command — those modules
 *  captured DOM references from the editor instance at startup;
 *  rebuilding would orphan them.
 *
 *  The instance's `getPoint`/`getMark` closures already peel through
 *  the leaf's view, so they automatically follow the active tab once
 *  the tabline is installed on the leaf.
 *
 *  Returns the inherited instance, or null when there's nothing to
 *  inherit (no instance, no leaf, the active child isn't a text view). */
function inheritExistingEditorIntoTabline(tablineView, leaf) {
  const existingInstance = editorViewByPaneId.get(leaf.id) ?? null;
  if (!existingInstance) return null;
  const active = tablineActiveChild(tablineView);
  if (!active || active.kind !== 'text') return null;
  const state = ensureTablineState(tablineView);
  state.activeEditor = existingInstance;
  state.activeEditorChild = active;
  // Seed editorByChild so subsequent tab switches treat this inherited
  // instance as the per-child element for `active`. Other tabs' editors
  // are constructed lazily in `mountTablineActiveChild` when they first
  // become the active child.
  state.editorByChild.set(active, existingInstance);
  if (existingInstance.parentNode !== state.contentEl) {
    state.contentEl.append(existingInstance);
  }
  return existingInstance;
}

/** Build a fresh `*scratch*` text view, push it into the global view
 *  list (so `(view-list)` finds it) and return the handle. Used by
 *  `installRootPane` to fill leaves that had nothing to restore. */
function buildScratchTextView() {
  const view = createView({
    kind: 'text',
    buffer: createBuffer('', { name: '*scratch*' }),
  });
  views.push(view);
  return view;
}

/** Find an existing directory-tree view for ROOTPATH or build a fresh
 *  one and push it into `views`. Shared between the `open-directory-tree!`
 *  primitive (which then auto-switches to the view) and the session
 *  restore path (which places it in a specific leaf without switching). */
function ensureDirectoryTreeViewForPath(rootPath) {
  const existing = views.find(
    (v) => v.kind === 'directory-tree' && v.rootPath === rootPath
  );
  if (existing) return existing;
  const segments = rootPath.split('/');
  const tailName = segments[segments.length - 1] || rootPath;
  const view = createView({
    kind: 'directory-tree',
    name: `*Tree: ${tailName}*`,
    extras: { rootPath, expanded: new Set() },
  });
  views.push(view);
  return view;
}

/** Find the single *View List* view, or build it and push it into
 *  `views`. There is only ever one (it lists all the others), so this is
 *  a find-or-create by kind rather than by name. */
function ensureViewListView() {
  const existing = views.find((v) => v.kind === 'view-list');
  if (existing) return existing;
  const view = createView({ kind: 'view-list', name: '*View List*' });
  views.push(view);
  return view;
}

/** Find the single *Recover* view, or build it and push it into `views`.
 *  Like the *View List*, there is only ever one. */
function ensureRecoverView() {
  const existing = views.find((v) => v.kind === 'recover');
  if (existing) return existing;
  const view = createView({ kind: 'recover', name: '*Recover*' });
  views.push(view);
  return view;
}

/** Show the *Recover* view in the focused pane (promoting it to a
 *  tabline first so recovered buffers can land as sibling tabs), and
 *  repaint its rows. */
function openRecoverView() {
  const pane = currentPane();
  if (pane) promoteToTablineOnPane(pane);
  const view = ensureRecoverView();
  switchToViewIndex(views.indexOf(view));
  recoverView.refresh();
}

/** Read the recovery snapshots and keep the ones worth offering: a
 *  snapshot whose on-disk file is older than it (unsaved edits were
 *  lost), or that has no on-disk file at all (a path-less or deleted
 *  buffer). Updates `recoverableSnapshots`; returns the count. Never
 *  throws — a recovery-scan failure must not block startup. */
async function scanForRecovery() {
  let snapshots;
  try {
    snapshots = await window.host.listRecovery();
  } catch {
    recoverableSnapshots = [];
    return 0;
  }
  recoverableSnapshots = Array.isArray(snapshots)
    ? snapshots.filter(
        (s) =>
          s &&
          typeof s.text === 'string' &&
          (!s.diskExists ||
            (typeof s.diskModified === 'number' && s.savedAt > s.diskModified))
      )
    : [];
  return recoverableSnapshots.length;
}

/** Find an existing directory-columns view for ROOTPATH or build a
 *  fresh one and push it into `views`. Companion to
 *  `ensureDirectoryTreeViewForPath`. */
function ensureDirectoryColumnsViewForPath(rootPath) {
  const existing = views.find(
    (v) => v.kind === 'directory-columns' && v.rootPath === rootPath
  );
  if (existing) return existing;
  const segments = rootPath.split('/');
  const tailName = segments[segments.length - 1] || rootPath;
  const view = createView({
    kind: 'directory-columns',
    name: `*Columns: ${tailName}*`,
    extras: {
      rootPath,
      columns: [{ path: rootPath, selected: null }],
      previewPath: null,
    },
  });
  views.push(view);
  return view;
}

/** Find an existing bookmark view for SOURCEBUFFER or build a fresh one
 *  and push it into `views`. The view edits the source buffer's
 *  metadata.bookmarks directly; jump / persist are host callbacks. */
/** The single bookmark outline. There is one — it re-targets to whichever
 *  text buffer has focus (see `followBookmarkView`) rather than one view
 *  per buffer, so the outline beside your buffer always shows that
 *  buffer's bookmarks. Find-or-create. */
function ensureBookmarkView() {
  const existing = views.find((v) => v.kind === 'bookmark');
  if (existing) return existing;
  const view = createView({
    kind: 'bookmark',
    name: '*Bookmarks*',
    extras: { sourceBuffer: null },
  });
  views.push(view);
  return view;
}

/** Point the bookmark outline at BUFFER and repaint it. Updates the
 *  view's name (for the modeline / *View List*) too. */
function retargetBookmarkView(buffer) {
  const view = views.find((v) => v.kind === 'bookmark');
  if (!view) return;
  // createView spreads `extras` onto the view, so the source lives at
  // `view.sourceBuffer` (there is no `view.extras`). The element re-reads
  // it from the handle on setBuffer.
  view.sourceBuffer = buffer;
  const name = buffer && buffer.name ? buffer.name : 'buffer';
  view.name = `*Bookmarks: ${name}*`;
  bookmarkView.setBuffer(view);
}

/** Auto-follow: when focus moves to a text buffer and the outline is
 *  shown, re-target it to that buffer. A no-op when the outline is closed
 *  or already on this buffer, so it's cheap to call on every focus
 *  change. */
function followBookmarkView(buffer) {
  if (!buffer) return;
  const view = views.find((v) => v.kind === 'bookmark');
  if (!view || view.sourceBuffer === buffer) return;
  if (!leafPanes(rootPane).some((leaf) => leaf.view === view)) return;
  retargetBookmarkView(buffer);
}

/** Repaint the open bookmark outline in place — called when a bookmark is
 *  set/deleted so the change shows immediately (the engine otherwise only
 *  schedules a metadata write). A no-op when the outline isn't shown. */
function refreshBookmarkOutline() {
  const view = views.find((v) => v.kind === 'bookmark');
  if (!view) return;
  if (!leafPanes(rootPane).some((leaf) => leaf.view === view)) return;
  bookmarkView.setBuffer(view);
}

/** Open a file from a directory-tree / directory-columns row and place
 *  it as a NEW TAB in the focused pane, promoting the pane to a
 *  tabline first if it's still a plain leaf. The previous behaviour
 *  was to call `openFileByPath` directly, which replaced the
 *  directory view with the opened file's view — losing the user's
 *  navigation context. Now the column / tree stays put and the file
 *  appears alongside it. */
/**
 * Open FILEPATH from a directory tree-view, honouring TARGET (the value of
 * `*directory-tree-open-target*`). Unlike `openFileInTabAdjacent` — which
 * opens in the *focused* pane and so lands the file in the tree's own pane
 * when you double-click there — this routes the file to the main editing
 * area (a tabline / text pane that isn't the tree or another sidebar), so a
 * project's left-sidebar tree opens files in its middle tabline.
 *
 * - `this-pane`     → the old behaviour (the tree's own pane).
 * - `editing-pane`  → the main editing pane (default).
 * - `other-pane`    → the next editing pane after the tree.
 * When no editing pane exists, the file opens in a split beside the tree.
 */
async function openFileFromTree(filePath, target) {
  if (target === 'this-pane') {
    await openFileInTabAdjacent(filePath);
    return;
  }
  const opened = await openFileByPath(filePath, { switch: false });
  if (!opened) return;
  const leaves = leafPanes(rootPane);
  let targetLeaf = null;
  // An explicit pane-id target (a leaf id wired into the dir-tree by the
  // project — see reapplyProjectDirTreeTarget) wins: no guessing which pane
  // is "the editing area", and it's robust to focus / sidebar passivity.
  if (target !== 'editing-pane' && target !== 'other-pane') {
    targetLeaf = leaves.find((leaf) => leaf.id === target) ?? null;
  }
  // Otherwise — or when the wired pane no longer exists — fall back to the
  // symbolic heuristic (a standalone M-x directory-tree has no wired target).
  if (!targetLeaf) {
    const descriptors = leaves.map((leaf) => {
      const peeled = peelTabline(leaf.view);
      return {
        id: leaf.id,
        kind: peeled ? peeled.kind : null,
        isTabline: isTablineView(leaf.view),
      };
    });
    const symbolic = target === 'other-pane' ? 'other-pane' : 'editing-pane';
    const targetId = pickEditingLeaf(descriptors, currentPane()?.id ?? null, symbolic);
    targetLeaf = targetId ? leaves.find((leaf) => leaf.id === targetId) : null;
  }
  if (!targetLeaf) {
    // No suitable editing pane (e.g. the tree is the only pane): open the
    // file beside the current pane in a new split rather than inside a sidebar.
    const here = currentPane();
    if (here && here.kind === 'leaf') {
      splitPaneAtLeafWith(here, SPLIT_HORIZONTAL, 0.3, 'after', opened);
    } else {
      switchToViewIndex(views.indexOf(opened));
    }
    return;
  }
  // Promote the target to a tabline if needed, add the file as a tab, focus
  // the editing pane, and activate the new tab.
  const tlv = isTablineView(targetLeaf.view)
    ? targetLeaf.view
    : promoteToTablineOnPane(targetLeaf);
  if (!tlv) {
    switchToViewIndex(views.indexOf(opened));
    return;
  }
  if (!tlv.tabs.includes(opened)) {
    addTabToTabline(tlv, opened, tlv.tabs.length);
  }
  setCurrentPaneId(targetLeaf.id);
  const idx = tlv.tabs.indexOf(opened);
  if (idx >= 0) activateTabInTabline(tlv, idx);
}

async function openFileInTabAdjacent(filePath) {
  const pane = currentPane();
  if (!pane) {
    // No focused pane (shouldn't happen for a click in the column view,
    // since the click would have set focus, but be defensive): fall back.
    openFileByPath(filePath);
    return;
  }
  // Open the file but don't switch — we'll attach it ourselves.
  const opened = await openFileByPath(filePath, { switch: false });
  if (!opened) return;
  // Promote the pane to a tabline if it isn't one yet. A plain leaf
  // wraps its current view into a fresh tabline as the first tab; an
  // already-tabline pane is returned as-is.
  const tlv = isTablineView(pane.view) ? pane.view : promoteToTablineOnPane(pane);
  if (!tlv) {
    // Defensive: promotion failed. Fall back to the old behaviour so
    // the file at least opens.
    switchToViewIndex(views.indexOf(opened));
    return;
  }
  // Add the opened view as a tab at the end of the strip and activate
  // it. The column / tree view stays as the previous tab(s).
  if (!tlv.tabs.includes(opened)) {
    addTabToTabline(tlv, opened, tlv.tabs.length);
  }
  const newIdx = tlv.tabs.indexOf(opened);
  if (newIdx >= 0) activateTabInTabline(tlv, newIdx);
}

/** Materialise a serialised view-blob (text-view / tabline-view / null)
 *  into a runtime view handle. Text-view blobs are resolved through
 *  `handlesByBlob` (the restore loop opened them already); tabline-view
 *  blobs recurse; null view-blobs become a fresh `*scratch*` text view.
 *
 *  Returns the live view handle. The caller wires it into a leaf. */
function materialiseRestoredView(blob, handlesByBlob) {
  if (!blob) return buildScratchTextView();
  if (blob.kind === 'bookmark') {
    // The bookmark outline is the singleton; ensure it and re-target it
    // to the persisted source file if that file is open as a text view
    // (the restore loop opened it already). Otherwise it stays blank and
    // re-targets to whatever buffer gets focus, per its follow behaviour.
    const view = ensureBookmarkView();
    const srcPath = typeof blob.path === 'string' ? blob.path : null;
    if (srcPath) {
      const srcView = views.find(
        (v) => v.kind === 'text' && viewFilePath(v) === srcPath
      );
      if (srcView && srcView.buffer) {
        view.sourceBuffer = srcView.buffer;
        view.name = `*Bookmarks: ${srcView.buffer.name ?? 'buffer'}*`;
      }
    }
    return view;
  }
  if (
    blob.kind === 'text' || blob.kind === 'image' ||
    blob.kind === 'audio' || blob.kind === 'video' || blob.kind === 'pdf' ||
    blob.kind === 'directory-tree' || blob.kind === 'directory-columns'
  ) {
    const handle = handlesByBlob.get(blob);
    // If the file failed to open, fall back to a fresh scratch so the
    // owning leaf still has something to render. (Applies to all file-
    // backed kinds — a missing audio file becomes scratch too.) `pdf`
    // must be here too: `collectTextViewBlobs` opens it (it's a persisted
    // file-backed kind), so its handle is in `handlesByBlob` — omitting it
    // left the pdf opened-but-orphaned (in the view list, not in its pane).
    return handle ?? buildScratchTextView();
  }
  if (blob.kind === 'tabline') {
    const tabs = blob.tabs
      .map((tabBlob) => materialiseRestoredView(tabBlob, handlesByBlob))
      // Drop scratch-replacements from failed-to-open files? No — the
      // brief says a failed tab is dropped; keep the scratch behaviour
      // for leaves only. Tablines with a missing tab: skip the slot.
      // We recompute from handlesByBlob: scratch fallback applies to
      // leaves but not to tablines (a missing tab shouldn't expand the
      // strip with a scratch). Re-walk:
      .filter((v) => v !== null);
    // Recompute tabs without the scratch substitution: a missing file
    // tab is silently dropped. (Nested tablines with their own tabs
    // are kept as-is; they recursively materialised already.)
    const tabsClean = [];
    for (const tabBlob of blob.tabs) {
      if (!tabBlob) continue;
      if (
        tabBlob.kind === 'text' || tabBlob.kind === 'image' ||
        tabBlob.kind === 'audio' || tabBlob.kind === 'video' || tabBlob.kind === 'pdf' ||
        tabBlob.kind === 'directory-tree' || tabBlob.kind === 'directory-columns'
      ) {
        const handle = handlesByBlob.get(tabBlob);
        // Dedup by handle: multiple blobs in the same tabline that
        // resolve to the same path (e.g. an existing session.json that
        // accumulated duplicate tabs before the openFileByPath auto-dup
        // fix) all map to one handle. Without this, the restored tabline
        // shows N identical tab slots — visually broken even though the
        // underlying view is one.
        if (handle && !tabsClean.includes(handle)) tabsClean.push(handle);
        continue;
      }
      if (tabBlob.kind === 'tabline') {
        tabsClean.push(materialiseRestoredView(tabBlob, handlesByBlob));
      }
    }
    void tabs; // silence — kept for the comment-block clarity above.
    // An empty editing tabline (e.g. a project whose middle pane had no
    // open files at quit) restores with a fresh *scratch* so the pane isn't
    // left blank (and focus doesn't land on a tab-less tabline).
    const finalTabs = tabsClean.length === 0
      ? [buildScratchTextView()]
      : tabsClean;
    const active = Math.max(0, Math.min(blob.active ?? 0, finalTabs.length - 1));
    const extras = { tabs: finalTabs, active, edge: blob.edge ?? 'top' };
    if (typeof blob.width === 'number' && Number.isFinite(blob.width) && blob.width > 0) {
      extras.width = blob.width;
    }
    return createView({
      kind: 'tabline',
      extras,
    });
  }
  return buildScratchTextView();
}

/** Recursively build a runtime pane tree from a serialised pane-blob,
 *  threading the views from `handlesByBlob` into each leaf. The pane
 *  ids from the blob are preserved verbatim so `currentPaneId` after
 *  restore refers to the same leaf the user had focused on quit. */
function buildRestoredPaneTree(blob, handlesByBlob) {
  if (!blob) return null;
  if (blob.kind === 'leaf') {
    bumpIdCounterPast(blob.id);
    const view = materialiseRestoredView(blob.view, handlesByBlob);
    return createLeafPane({ id: blob.id, view });
  }
  if (blob.kind === 'split') {
    const first = buildRestoredPaneTree(blob.first, handlesByBlob);
    const second = buildRestoredPaneTree(blob.second, handlesByBlob);
    if (!first || !second) {
      // A split that lost a child collapses to whatever survived.
      return first ?? second ?? null;
    }
    bumpIdCounterPast(blob.id);
    return createSplitPane({
      id: blob.id,
      orientation: blob.orientation,
      ratio: blob.ratio,
      first,
      second,
    });
  }
  return null;
}

/** Install a freshly-built pane tree as the editor's root. Disposes
 *  the existing editor-view instances, swaps `rootPane`, refreshes the
 *  DOM, mounts each leaf's view through mountKindView, points
 *  `currentPaneId` at the requested leaf (or the first leaf when the
 *  saved id no longer exists), and updates the focused-pane state.
 *
 *  Called once from `sessionController.restore`. Idempotent in the
 *  sense that re-installing the same tree yields the same result, but
 *  every call disposes every existing editor instance — not for hot
 *  reuse. */
function installRootPane(newRoot, savedCurrentPaneId) {
  if (!newRoot) return;
  // Dispose every existing per-leaf editor instance. The initial
  // bootstrap leaf had one; restored tablines will build their own.
  for (const leafId of [...editorViewByPaneId.keys()]) {
    const instance = editorViewByPaneId.get(leafId);
    if (instance) {
      try { instance.destroy(); } catch { /* tolerant */ }
    }
    editorViewByPaneId.delete(leafId);
  }
  // Drop any tabline-view state too (the welcome/scratch initial root
  // had none, but a re-install path needs to be honest).
  for (const view of [...tablineStateByView.keys()]) {
    try { disposeKindView(view); } catch { /* tolerant */ }
  }
  rootPane = newRoot;
  // Update the focused pane id, falling back to the first leaf when
  // the saved id doesn't match any leaf in the new tree.
  const leaves = leafPanes(rootPane);
  // Drop per-pane focus overrides for panes that no longer exist (e.g. a
  // workspace switch installs a whole new tree), so the map can't grow
  // unbounded or collide with a reused id.
  const liveLeafIds = new Set(leaves.map((l) => l.id));
  for (const id of [...paneFocusOverride.keys()]) {
    if (!liveLeafIds.has(id)) paneFocusOverride.delete(id);
  }
  const matching = leaves.find((l) => l.id === savedCurrentPaneId);
  currentPaneId = matching
    ? matching.id
    : (leaves[0]?.id ?? null);
  // Never land focus on a passive pane (e.g. a restored project whose saved
  // focus was a sidebar): fall back to the first focusable leaf.
  if (currentPaneId !== null && isNoFocusPane(currentPaneId)) {
    const focusable = leaves.find((l) => !isNoFocusPane(l.id));
    if (focusable) currentPaneId = focusable.id;
  }
  // Rebuild the pane DOM around the new tree, then mount each leaf's
  // view through mountKindView. Tabline-view leaves cause the
  // registry to construct fresh per-pane editor instances for each
  // tabline's active text child.
  syncPaneElements();
  for (const leaf of leaves) {
    const view = leaf.view;
    if (!view) continue;
    if (isTablineView(view)) {
      mountKindView(view, { paneEl: paneElements.get(leaf.id) });
    } else {
      // Plain-leaf with a non-text singleton view (image / audio /
      // video / jukebox / directory-tree / directory-columns / ...):
      // the singleton element was originally parented to the boot leaf,
      // which the restore loop above just disposed. Re-parent it to
      // this leaf's pane element AND flip its display visible — the
      // boot setup hides every singleton (`display:none`), so
      // re-parenting alone leaves the pane empty until some other code
      // path (hideInactiveRendererViews) makes it visible. Mirrors the
      // same step `switchToViewIndex`'s plain-leaf path does for the
      // open-from-Lisp flow.
      const singleton = singletonElementForKind(view.kind);
      const paneEl = paneElements.get(leaf.id);
      if (singleton && paneEl) {
        if (singleton.parentNode !== paneEl) paneEl.append(singleton);
        singleton.style.display = '';
      }
      mountKindView(view);
    }
  }
  // Sync the global view pointers with whatever the focused pane shows.
  const focusedLeaf = leaves.find((l) => l.id === currentPaneId);
  const focusedView = focusedLeaf
    ? (isTablineView(focusedLeaf.view)
        ? tablineActiveChild(focusedLeaf.view)
        : focusedLeaf.view)
    : null;
  if (focusedView && views.indexOf(focusedView) >= 0) {
    currentViewIndex = views.indexOf(focusedView);
  }
  if (focusedView && focusedView.kind === 'text' && focusedView.buffer) {
    setCurrentTextBuffer(focusedView.buffer);
  }
  // Refresh per-pane focus indicators and splitter handles, schedule a
  // relayout so the freshly-installed tree sizes itself against the
  // editor-host bounds.
  refreshPaneFocusIndicators();
  refreshSplitterHandles();
  scheduleRelayout();
  // Remember the boot tabline-view (if the root was a single leaf
  // holding one) so the kill-view scratch-fallback (Q6) keeps working.
  if (rootPane.kind === 'leaf' && isTablineView(rootPane.view)) {
    rootTablineView = rootPane.view;
    rootTablineLeafId = rootPane.id;
  } else {
    rootTablineView = null;
    rootTablineLeafId = null;
  }
  notifyViewsChanged();
  updateModeline();
}

/** Wrap the root leaf's view in a tabline-view whose tabs are every
 *  open view in display order, with `active` pointing at the current
 *  view. Called once at startup after `sessionController.restore()`.
 *
 *  The pre-existing editor instance bound to the root leaf's id is
 *  inherited by the tabline state via `inheritExistingEditorIntoTabline`,
 *  so sticky-notes, hover-doc and inline-eval (which captured DOM
 *  references from that instance at startup) keep working. */
function wrapRootInTabline() {
  if (rootPane.kind !== 'leaf') return; // splits-before-wrap shouldn't happen, but bail safely.
  const leaf = rootPane;
  // The list of tabs is `views`. If the list is empty (vanishingly
  // rare — early startup always has a welcome / scratch pair), skip
  // the wrap.
  if (views.length === 0) return;
  const activeIdx = Math.max(0, Math.min(currentViewIndex, views.length - 1));
  const tabline = createView({
    kind: 'tabline',
    extras: {
      tabs: views.slice(),
      active: activeIdx,
      edge: 'top',
    },
  });
  // Inherit the existing editor instance so sticky-notes etc. survive.
  inheritExistingEditorIntoTabline(tabline, leaf);
  // Install the tabline-view as the leaf's view and dispatch the mount
  // hook so the strip renders. The leaf id is unchanged.
  leaf.view = tabline;
  rootTablineView = tabline;
  rootTablineLeafId = leaf.id;
  mountKindView(tabline, { paneEl: paneElements.get(leaf.id) });
}

// --- tabline-view operations (commit 4) --------------------------------
// Host-side methods backing the Lisp `(promote-to-tabline!)` /
// `(demote-tabline!)` / `(add-tab! ...)` etc. primitives. The Lisp
// pane-primitives layer is a thin shape adapter; the structural
// changes (replacing a leaf's view, splicing tabs, re-mounting) live
// here where the DOM and the `tablineStateByView` map are visible.
//
// A note on the tabs vs `views` invariant: tabline-views are *not*
// in the global `views[]` list (per the brief's data model — they
// live only inside pane handles). The tabs of a tabline-view, by
// contrast, are leaf-kind views that *are* in `views[]`. Adding a
// view as a tab does not append it to `views`; calling `add-tab!`
// with a view not already in `views` is supported (some Lisp may
// construct a tab from a fresh view handle), but the view must still
// be a leaf-kind view — composing a tabline-view as a tab of itself
// or another tabline is the Q10 nested case, allowed but ugly.

/** Return the tabline-view in the focused leaf pane, or null when the
 *  focused pane's view is a plain leaf or there is no focused pane.
 *  Symmetric with `(current-view)` — peels one level on the focused
 *  pane and returns the tabline if found. Nested tabline-views: this
 *  returns the *outer* tabline (the one the focused pane holds); to
 *  reach an inner one a caller would walk through `tablineActiveChild`
 *  themselves. */
function currentTablineView() {
  const pane = currentPane();
  if (!pane || pane.kind !== 'leaf') return null;
  return isTablineView(pane.view) ? pane.view : null;
}

/** Replace PANE's leaf view with a fresh tabline-view containing that
 *  view as its sole tab. No-op when PANE is not a leaf or its view is
 *  already a tabline-view (returns the existing tabline in that case).
 *  Returns the tabline-view; null when PANE was unusable. */
function promoteToTablineOnPane(pane) {
  if (!pane || pane.kind !== 'leaf') return null;
  if (isTablineView(pane.view)) return pane.view;
  const original = pane.view;
  const tabline = createView({
    kind: 'tabline',
    extras: {
      tabs: original ? [original] : [],
      active: 0,
      edge: 'top',
    },
  });
  // Inherit the existing editor instance so sticky-notes etc. on the
  // promoted pane keep their bindings. Symmetric with the boot wrap.
  inheritExistingEditorIntoTabline(tabline, pane);
  pane.view = tabline;
  const paneEl = paneElements.get(pane.id);
  if (paneEl) mountKindView(tabline, { paneEl });
  refreshPaneTabStrips();
  updateModeline();
  scheduleMinimapReconcile(); // promotion changed the leaf's view shape
  return tabline;
}

/** Replace the leaf holding TLV with TLV's active child's view (or
 *  the first tab when there's no active). The tabline's per-state DOM
 *  is disposed; the active child takes over. Returns the surviving
 *  view, or null when TLV isn't actually installed on a leaf in the
 *  current tree. */
function demoteTablineView(tlv) {
  if (!isTablineView(tlv)) return null;
  // Find the leaf this tabline lives in.
  let host = null;
  for (const leaf of leafPanes(rootPane)) {
    if (leaf.view === tlv) { host = leaf; break; }
  }
  if (!host) return null;
  // Pick the survivor: the active child, or the first tab if none.
  const survivor = tablineActiveChild(tlv) ?? tlv.tabs[0] ?? null;
  // The tabline's `activeEditor` (the single editor instance
  // managed by mountTablineActiveChild) is what we want to keep
  // alive for the surviving view. Move its element back into the
  // pane element and re-register it in `editorViewByPaneId` so post-
  // demotion code paths (focus changes, switchToView) find it. The
  // tabline mount's dispose path then *won't* destroy it — we steal
  // it before disposing.
  const state = tablineStateByView.get(tlv);
  let inheritedInstance = null;
  if (state && state.activeEditor && survivor && survivor.kind === 'text') {
    inheritedInstance = state.activeEditor;
    state.activeEditor = null;
    state.activeEditorChild = null;
    // Drop the stolen instance from editorByChild so the upcoming
    // disposeKindView call doesn't destroy what we just rescued. The
    // map key is the survivor (which was the active child).
    state.editorByChild.delete(survivor);
    const paneEl = paneElements.get(host.id);
    if (paneEl && inheritedInstance.parentNode !== paneEl) {
      paneEl.append(inheritedInstance);
    }
    editorViewByPaneId.set(host.id, inheritedInstance);
  }
  // Dispose the tabline-view's remaining state. disposeKindView for
  // tabline destroys any *remaining* editor instances in
  // editorByChildId (we removed the inherited one above) and detaches
  // the container.
  disposeKindView(tlv);
  if (rootTablineView === tlv) {
    rootTablineView = null;
    rootTablineLeafId = null;
  }
  // Install the survivor on the leaf and re-mount through the kind
  // registry. For a text survivor with an inherited editor instance
  // already in place, the text mount's `ensureEditorViewForLeaf`
  // finds it and just calls `setView(survivor)`.
  host.view = survivor;
  if (survivor) {
    hideInactiveRendererViews(survivor.kind);
    mountKindView(survivor);
  }
  updateModeline();
  scheduleMinimapReconcile(); // demotion changed the leaf's view shape
  return survivor;
}

/** Append VIEW to TLV's tabs at INDEX (or the end when undefined).
 *  Refreshes the strip; does not activate. Returns the tabline-view. */
function addTabToTabline(tlv, view, index) {
  if (!isTablineView(tlv) || !view) return tlv;
  const tabs = tlv.tabs;
  const target =
    typeof index === 'number' && index >= 0 && index <= tabs.length
      ? index
      : tabs.length;
  tabs.splice(target, 0, view);
  // Adjust active so it still points at the same view as before.
  if (target <= tlv.active) tlv.active += 1;
  const state = tablineStateByView.get(tlv);
  if (state) {
    // Eager creation for non-text tabs: build the new tab's element so
    // it's live in contentEl before the next mount. Hide it
    // immediately — addTabToTabline doesn't activate; that's a
    // separate call (activateTabInTabline → mountTablineActiveChild).
    // Text tabs stay lazy: the inner editor's line-height /
    // scroll measurement reads the container bounding box, so the
    // first mount has to happen while the wrapper is actually
    // visible.
    if (view.kind !== 'text') {
      const el = ensureTabElement(state, view);
      if (el) el.style.display = 'none';
    }
    state.strip.refresh();
  }
  return tlv;
}

/** Move the tab at SRC-IDX in SRC-TLV into DST-TLV at DST-IDX (or the
 *  end when undefined). Idempotent on src === dst with no index
 *  change. The moved view becomes the active tab in the destination.
 *  When the destination is the same as the source, this collapses to
 *  a reorder. Returns the destination tabline-view. */
function moveTabAcrossTablines(srcTlv, srcIdx, dstTlv, dstIdx) {
  if (!isTablineView(srcTlv) || !isTablineView(dstTlv)) return dstTlv;
  if (
    typeof srcIdx !== 'number' ||
    srcIdx < 0 || srcIdx >= srcTlv.tabs.length
  ) return dstTlv;
  const view = srcTlv.tabs[srcIdx];
  if (!view) return dstTlv;
  // Same-tabline move → reorder. Compute the destination index
  // accounting for the splice that removed the source tab.
  if (srcTlv === dstTlv) {
    let target =
      typeof dstIdx !== 'number' || dstIdx < 0 || dstIdx > srcTlv.tabs.length
        ? srcTlv.tabs.length - 1
        : (dstIdx > srcIdx ? dstIdx - 1 : dstIdx);
    if (target === srcIdx) return srcTlv;
    reorderTabInTabline(srcTlv, srcIdx, target);
    activateTabInTabline(srcTlv, target);
    return srcTlv;
  }
  // Cross-tabline: remove from src (without killing the view), insert
  // into dst, activate.
  removeTabInTabline(srcTlv, srcIdx);
  const target =
    typeof dstIdx === 'number' && dstIdx >= 0 && dstIdx <= dstTlv.tabs.length
      ? dstIdx
      : dstTlv.tabs.length;
  addTabToTabline(dstTlv, view, target);
  activateTabInTabline(dstTlv, target);
  return dstTlv;
}

/** Every leaf pane handle in clockwise-spiral badge order (the numbering
 *  swap-views / permute-views show). Slot 0 is the top-left pane. */
function spiralOrderedLeaves() {
  const hostRect = editorHostEl.getBoundingClientRect();
  const { ordered } = spiralOrder(rootPane, {
    width: hostRect.width,
    height: hostRect.height,
  });
  return ordered;
}

/** Swap which view PANE-A and PANE-B show by *moving the frames*: exchange
 *  the two leaves' positions in the tree and relayout. No view DOM moves —
 *  relayout only repositions the existing `.pane` divs by id — so a
 *  browser/pdf/shell guest is never recreated, and the per-leaf maps stay
 *  valid (the leaf nodes keep their ids + contents, just land in new
 *  slots; focus follows the view). Returns true on success, false on a
 *  no-op (same leaf, missing handle, or a non-leaf). */
function swapPaneFrames(paneA, paneB) {
  if (!paneA || !paneB || paneA === paneB) return false;
  if (paneA.kind !== 'leaf' || paneB.kind !== 'leaf') return false;
  rootPane = swapLeaves(rootPane, paneA, paneB);
  syncPaneElements();
  refreshPaneFocusIndicators();
  refreshSplitterHandles();
  scheduleRelayout();
  updateModeline();
  // Pane positions changed (not the view set) — refresh the View List so
  // its spiral Pane column tracks the move, and re-pickle the session.
  notifyViewsChanged();
  return true;
}

/** Rearrange every pane's view by moving the frames. DESTS is a 1-based
 *  destination slot per pane in spiral order: the content of pane K
 *  (1-based) moves to slot DESTS[K]. DESTS must be a permutation of 1..N.
 *  Returns true on success, false on a malformed / non-bijective DESTS or
 *  a mismatched length. Same frame-move guarantees as swapPaneFrames. */
function permutePaneFrames(dests) {
  const hostRect = editorHostEl.getBoundingClientRect();
  const dims = { width: hostRect.width, height: hostRect.height };
  const { ordered, indexByLeaf } = spiralOrder(rootPane, dims);
  const n = ordered.length;
  if (!Array.isArray(dests) || dests.length !== n) return false;
  // occupantBySlot[slot] = the leaf whose content should land at that
  // slot. Pane k (ordered[k]) goes to slot dests[k] - 1.
  const occupantBySlot = new Array(n);
  const seen = new Set();
  for (let k = 0; k < n; k += 1) {
    const dest = dests[k] - 1;
    if (!Number.isInteger(dest) || dest < 0 || dest >= n || seen.has(dest)) {
      return false;
    }
    seen.add(dest);
    occupantBySlot[dest] = ordered[k];
  }
  rootPane = permuteLeaves(rootPane, indexByLeaf, occupantBySlot);
  syncPaneElements();
  refreshPaneFocusIndicators();
  refreshSplitterHandles();
  scheduleRelayout();
  updateModeline();
  // Pane positions changed (not the view set) — refresh the View List so
  // its spiral Pane column tracks the move, and re-pickle the session.
  notifyViewsChanged();
  return true;
}

/** Update TLV.edge to EDGE and refresh the strip's data-edge attribute
 *  + the CSS flex direction (the kind-registry mount drives both via
 *  the per-pane state). Returns the tabline-view. */
function setTablineEdgeOnTabline(tlv, edge) {
  if (!isTablineView(tlv)) return tlv;
  if (
    edge !== 'top' && edge !== 'bottom' &&
    edge !== 'left' && edge !== 'right'
  ) return tlv;
  tlv.edge = edge;
  const state = tablineStateByView.get(tlv);
  if (state) {
    state.container.dataset.edge = edge;
    state.strip.setEdge(edge);
    applyTablineStripWidth(tlv);
  }
  return tlv;
}

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

const sessionOptions = {
  getRootPane: () => rootPane,
  getCurrentPaneId: () => currentPaneId,
  openByPath: async (path, entry) => {
    // Directory views aren't file-opened by suffix — they're built
    // from a directory path. The session restore loop calls openByPath
    // for every persisted file-backed-or-directory view, so we
    // dispatch on `entry.kind` here.
    if (entry && entry.kind === 'directory-tree') {
      return ensureDirectoryTreeViewForPath(path);
    }
    if (entry && entry.kind === 'directory-columns') {
      return ensureDirectoryColumnsViewForPath(path);
    }
    // forceDuplicate: true so each blob in session.json gets its own
    // View handle. If two tablines stored the same path, restoring
    // them as one shared View handle meant close-X on either tabline
    // killed the View globally and yanked it out of *both* tablines —
    // the bug in before.png/after.png.
    const view = await openFileByPath(path, { switch: false, forceDuplicate: true });
    if (view === null) return null;
    // A pdf blob is only persisted when its view was flagged `persist`
    // (the latexed-output case). Re-mark the restored view so it persists
    // again next session — `openFileByPath` minted it with the default
    // (which is *pdf-restore-default*, transient unless the user opted in
    // globally), but this one was explicitly saved as persistent.
    if (view.kind === 'pdf' && entry && entry.kind === 'pdf') {
      view.persist = true;
    }
    // Only text views carry point/mark; image/audio/video/pdf views don't.
    const buffer = view.buffer;
    if (view.kind === 'text' && buffer) {
      // Clamp the persisted point/mark to the restored buffer's length.
      // A file-backed buffer re-reads its content from disk on restore, so
      // that content can be SHORTER than when the session was saved — an
      // unsaved/new-file buffer (find-file on a missing path) re-reads
      // empty, or the file shrank between runs. `buffer.moveTo`/`setMark`
      // already clamp, but `view.point` was stored raw, and a stale offset
      // poisons the cursor / mode-selection path (`positionAt` out of
      // range → "mode selection failed: offset N out of range [0, 0]").
      const len = typeof buffer.length === 'number' ? buffer.length : 0;
      const clampOffset = (n) => (n < 0 ? 0 : n > len ? len : n);
      const point = clampOffset(Number.isFinite(entry.point) ? entry.point : 0);
      const mark = Number.isFinite(entry.mark) ? clampOffset(entry.mark) : null;
      view.point = point;
      view.mark = mark;
      if (typeof buffer.moveTo === 'function') buffer.moveTo(point);
      if (mark !== null && typeof buffer.setMark === 'function') {
        buffer.setMark(mark);
      }
    }
    return view;
  },
  installRootPane: (rootBlob, savedCurrentPaneId, handlesByBlob) => {
    const runtimeRoot = buildRestoredPaneTree(rootBlob, handlesByBlob);
    if (runtimeRoot) installRootPane(runtimeRoot, savedCurrentPaneId);
  },
};

// The global "home" session controller, writing <userData>/session.json.
// When a project is open, saves route to a per-project controller instead
// (see `activeSession`); the global one captures the home state at the
// moment a project is opened, and is restored when the project is closed.
const sessionController = createSession({ ...sessionOptions, host: window.host });

// --- Projects -----------------------------------------------------------
// A project is a directory opened as a workspace: a 3-column layout
// (directory-tree | editing tabline | bookmark outline) whose open files
// are saved to <root>/.godot/project.json and restored on reopen. The
// model is *additive* — the global session is the "home" state; opening a
// project switches into it (saving home first) and closing returns to it.
// Boot always lands on home (see the restore at the bottom of this file).

// `activeProjectPath` / `projectSession` are declared near the top of the
// module (the pane-focus machinery reads activeProjectPath during the
// initial paint); they're assigned by openProject / closeProject below.

/** A host shim that routes a session controller's reads/writes to ROOT's
 *  per-project state file instead of the global session.json. */
function projectStateHost(root) {
  return {
    readSession: () => window.host.readProject(root),
    writeSession: (data) => window.host.writeProject(root, data),
  };
}

/** An inert session controller used in server mode. Model B makes the SERVER
 *  the owner of buffers + the session: the in-renderer `views[]` holds only the
 *  welcome seed (the real buffers live server-side), so letting the in-renderer
 *  session persist would overwrite the user's real (flag-off) session.json with
 *  a near-empty one. Every save/flush/restore therefore routes here and no-ops.
 *  (Server-side session restore arrives in a later increment.) */
const NULL_SESSION = {
  save() {},
  flush: async () => {},
  restore: async () => {},
};

/** The session controller saves should target right now: the open
 *  project's, or the global home one. All debounced saves and the
 *  pagehide flush go through this so the right file gets written. In server
 *  mode it is inert (see NULL_SESSION) so the server owns the session alone. */
function activeSession() {
  if (window.host && window.host.serverMode) return NULL_SESSION;
  return projectSession ?? sessionController;
}

// Project layout ratios. Left sidebar takes ~18% of the window; within
// the remaining 82%, the editing tabline takes ~78% and the bookmark
// outline ~22% — so the two sidebars end up roughly symmetric (~18% each)
// with a ~64% editing pane between them.
const PROJECT_SIDEBAR_RATIO = 0.18;
const PROJECT_MIDDLE_RATIO = 0.78;

/** Build the canonical 3-column project layout — directory-tree (left) |
 *  editing tabline (middle) | bookmark outline (right) — rooted at ROOT,
 *  and install it. Used on a project's FIRST open (no saved state yet);
 *  later opens restore the saved tree instead, which may carry extra
 *  splits the user made inside. The middle tabline starts on a fresh
 *  *scratch* so the editing pane is never empty. */
function buildCanonicalProjectLayout(root) {
  const dirTree = ensureDirectoryTreeViewForPath(root);
  const bookmarks = ensureBookmarkView();
  const scratch = freshScratchView();
  views.push(scratch);
  const tabline = createView({
    kind: 'tabline',
    extras: { tabs: [scratch], active: 0, edge: 'top' },
  });
  const leftLeaf = createLeafPane({ view: dirTree });
  const middleLeaf = createLeafPane({ view: tabline });
  const rightLeaf = createLeafPane({ view: bookmarks });
  const innerSplit = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: PROJECT_MIDDLE_RATIO,
    first: middleLeaf,
    second: rightLeaf,
  });
  const newRoot = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: PROJECT_SIDEBAR_RATIO,
    first: leftLeaf,
    second: innerSplit,
  });
  installRootPane(newRoot, middleLeaf.id);
  // Point the bookmark outline at the editing pane's buffer so the right
  // panel isn't blank; it auto-follows focus from here on.
  retargetBookmarkView(scratch.buffer);
}

/** Install a minimal single-tabline scratch workspace. The fallback for
 *  closing a project when the home session has no saved tree (rare — the
 *  home state is captured on project open, so it normally exists). */
function buildScratchWorkspace() {
  const scratch = freshScratchView();
  views.push(scratch);
  const tabline = createView({
    kind: 'tabline',
    extras: { tabs: [scratch], active: 0, edge: 'top' },
  });
  const leaf = createLeafPane({ view: tabline });
  installRootPane(leaf, leaf.id);
}

/** Restore the controller CTRL's saved tree, returning whether it
 *  installed one (detected, as the boot path does, by a change of
 *  rootPane identity). Suppresses session saves during the restore. */
async function restoreInto(ctrl) {
  const before = rootPane;
  restoring = true;
  try {
    await ctrl.restore();
  } finally {
    restoring = false;
  }
  return rootPane !== before;
}

/** Read the central project index → array of `{path, name, thumbnail?}`
 *  entries (most-recently-opened first). Best-effort: returns [] on error. */
async function readProjectList() {
  let index = null;
  try {
    index = await window.host.readProjectIndex();
  } catch {
    index = null;
  }
  return index && Array.isArray(index.projects) ? index.projects : [];
}

/** Write LIST back to the central project index. Best-effort: a write
 *  failure is non-fatal (the index is a convenience catalogue). */
async function writeProjectList(list) {
  try {
    await window.host.writeProjectIndex({ projects: list });
  } catch {
    // The index is a convenience catalogue for the chooser; a write
    // failure must not break opening a project.
  }
}

/** Record ROOT at the front of the central project index (most-recently
 *  opened first). Best-effort. */
async function rememberProject(root) {
  const list = await readProjectList();
  await writeProjectList(upsertProject(list, root, projectNameFromRoot(root)));
}

/** Open the Project Chooser launcher modal — read the known projects, then
 *  show the grid. All of the chooser's side effects (open / add / set
 *  thumbnail / remove / read a thumbnail image) are wired to the host here;
 *  `list` is the shared, mutable catalogue the actions return updated. */
function showProjectChooser() {
  const reportErr = (error) =>
    repl.appendError(error.lispMessage ?? error.message ?? String(error));
  readProjectList()
    .then((initial) => {
      let list = initial;
      openProjectChooser({
        getProjects: () => list,
        openProject: (path) => {
          openProject(path).catch(reportErr);
        },
        // Pick a folder and open it immediately (the chooser closes first).
        openFolder: () => {
          window.host
            .openDirectory()
            .then((path) => (path ? openProject(path) : undefined))
            .catch(reportErr);
        },
        // Pick a folder and add it to the catalogue WITHOUT opening.
        addProject: async () => {
          const path = await window.host.openDirectory();
          if (!path) return null;
          list = upsertProject(list, path);
          await writeProjectList(list);
          return list;
        },
        // Choose a custom thumbnail image for a project tile.
        pickThumbnail: async (root) => {
          const img = await window.host.pickProjectImage();
          if (!img) return null;
          list = setProjectThumbnail(list, root, img);
          await writeProjectList(list);
          return list;
        },
        // Drop a project from the catalogue (does not touch its files).
        removeProject: async (root) => {
          list = list.filter((p) => p && p.path !== root);
          await writeProjectList(list);
          return list;
        },
        loadThumbnail: (imagePath) => window.host.readProjectThumbnail(imagePath),
        // Drag-and-drop an image file onto a tile to set its thumbnail.
        getPathForFile: (file) => window.host.getPathForFile(file),
        dropThumbnail: async (root, imagePath) => {
          // Validate by actually reading it as a thumbnail (the single source
          // of truth for "displayable image"); only store the path if so.
          const dataUrl = await window.host.readProjectThumbnail(imagePath);
          if (!dataUrl) return null;
          list = setProjectThumbnail(list, root, imagePath);
          await writeProjectList(list);
          return list;
        },
      });
    })
    .catch(reportErr);
}

/** Open ROOT as a project workspace. Saves the current workspace (home or
 *  another project) first, then either restores ROOT's saved layout or
 *  builds the canonical 3-column one. A no-op when ROOT is already the
 *  open project. */
async function openProject(root) {
  const cleanRoot = expandTilde(String(root ?? '')).replace(/\/+$/, '');
  if (cleanRoot === '') return;
  if (cleanRoot === activeProjectPath) return;
  // The native picker always yields a directory, but the minibuffer route
  // (find-project) and open-project-at! can hand us a file or a missing
  // path — rooting a project there would fail messily (the .godot/ mkdir
  // lands under a file). listDirectorySync returns an array for a
  // directory (even an empty one), null otherwise.
  if (!Array.isArray(window.host.listDirectorySync(cleanRoot))) {
    minibuffer.setStatus(`Not a directory: ${cleanRoot}`);
    return;
  }
  // Persist whatever workspace is live now before switching away from it.
  try {
    await activeSession().flush();
  } catch {
    // A flush failure shouldn't block the switch; the prior state's last
    // debounced save is the fallback.
  }
  activeProjectPath = cleanRoot;
  projectSession = createSession({
    ...sessionOptions,
    host: projectStateHost(cleanRoot),
  });
  const installed = await restoreInto(projectSession);
  if (!installed) buildCanonicalProjectLayout(cleanRoot);
  // Wire the project's dir-tree to open files into the editing tabline (by
  // leaf id) — bulletproof against focus / sidebar passivity, and re-derived
  // here for both the freshly-built and the restored layout.
  reapplyProjectDirTreeTarget();
  rememberProject(cleanRoot);
  // Persist the freshly-installed project layout to its own state file.
  activeSession().save();
}

/** The directory-tree view shown in the current layout, or null. (A project
 *  has exactly one; a standalone M-x directory-tree may add another.) */
function projectDirTreeView() {
  const leaf = leafPanes(rootPane).find((l) => {
    const v = peelTabline(l.view);
    return !!(v && v.kind === 'directory-tree');
  });
  return leaf ? peelTabline(leaf.view) : null;
}

/** Wire the project's dir-tree to open files into the editing tabline's leaf,
 *  computed deterministically (the non-sidebar tabline — the middle column).
 *  Stored as `openTargetPaneId` on the dir-tree view; honoured first by
 *  openFileFromTree. A no-op when there's no dir-tree. */
function reapplyProjectDirTreeTarget() {
  const treeView = projectDirTreeView();
  if (!treeView) return;
  const leaves = leafPanes(rootPane);
  const descriptors = leaves.map((leaf) => {
    const peeled = peelTabline(leaf.view);
    return {
      id: leaf.id,
      kind: peeled ? peeled.kind : null,
      isTabline: isTablineView(leaf.view),
    };
  });
  const targetId = pickEditingLeaf(descriptors, null, 'editing-pane');
  if (targetId) treeView.openTargetPaneId = targetId;
}

/** Close the open project and return to the home session. A no-op when no
 *  project is open. */
async function closeProject() {
  if (projectSession === null) return;
  try {
    await projectSession.flush();
  } catch {
    // Non-fatal — the project's last debounced save stands.
  }
  projectSession = null;
  activeProjectPath = null;
  const installed = await restoreInto(sessionController);
  if (!installed) buildScratchWorkspace();
  activeSession().save();
}

// Wire the change hook: every list / index change refreshes every
// per-pane tabline strip and queues a session save. `restoring` is
// set while the restore loop runs so the inner view-add doesn't race
// the save — the save fires once at the end of restore, with the
// final list. No strips exist until `wrapRootInTabline()` runs below;
// the helper is a no-op until then.
let restoring = false;
onViewsChanged = () => {
  refreshPaneTabStrips();
  // Keep the *View List* table live: opening, killing, renaming or
  // switching a view changes what the list should show.
  viewListView.refresh();
  if (!restoring) activeSession().save();
};

// Flush the session synchronously-ish on page unload. The pagehide
// event fires when the renderer is about to be torn down (quit, reload,
// navigation); ipcRenderer.invoke returns a Promise the host will
// process even after pagehide returns.
window.addEventListener('pagehide', () => {
  activeSession().flush();
  // Capture the latest unsaved edits before a reload/navigation teardown.
  // Skip it on a clean quit — quitInteractive already cleared the
  // snapshots, and re-writing them here would resurrect discarded work.
  if (!quitting) recovery.flush();
});

// Snapshot dirty buffers when the window loses focus or is hidden — a
// cheap, frequent safety net between debounced edit-time writes (and the
// moment a user is most likely to wander off and leave unsaved work, or
// the app is about to be backgrounded/torn down). visibilitychange also
// fires when the window is minimised/hidden, which blur does not always
// cover.
window.addEventListener('blur', () => {
  if (!quitting) recovery.flush();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && !quitting) recovery.flush();
});

// Restore: re-open the files the previous session left open and the
// pane tree the user left behind, then land on the previously-current
// pane. The restore is awaited so the buffers + tree are present
// before the user starts interacting. When a session was restored
// `installRootPane` already wired the root tabline; otherwise (first
// launch, missing session.json) fall back to the boot wrap so the
// editor still comes up with a strip on the welcome/scratch starters.
restoring = true;
const rootPaneBeforeRestore = rootPane;
try {
  // Server mode: the SERVER owns buffers + the session, and the leaf-flip
  // hands the focused leaf to the server's SNAPSHOT. Skip the in-renderer
  // restore entirely so it can't re-open files into the leaf and compete
  // with the server (the boot-time clobber the overlay used to mask).
  // (Restore-through-the-server is a later increment.)
  if (!(window.host && window.host.serverMode)) {
    await sessionController.restore();
  }
} finally {
  restoring = false;
}
const sessionInstalledTree = rootPane !== rootPaneBeforeRestore;

if (sessionInstalledTree) {
  // A saved session is now the authoritative view list. Drop the
  // welcome.txt / scratch.lisp seeds — they were only meant for the
  // very first launch (no session.json yet) and would otherwise sit
  // at the head of `views` invisibly, discoverable via `C-x b` but
  // never appearing in any tabline (the restored tabline doesn't
  // contain them).
  //
  // Each splice shifts every higher index down by one. `currentViewIndex`
  // was set by `installRootPane` against the pre-splice list, so any
  // seed at a lower index leaves the active pointer one past where it
  // belongs. Without the shift the modeline ends up showing a count
  // like "9/7" — buffer name still resolves through `currentTextBuffer`
  // (separately cached), but `views[currentViewIndex]` is now out of
  // range. Browser-views amplify this because they're ephemeral: the
  // focused view at save time is often a browser-view, the next-best
  // text view picks up focus on restore, `installRootPane` sets a
  // valid index against it, and the seed-removal here then drops the
  // index past the end.
  for (const seed of initialSeedViews) {
    const idx = views.indexOf(seed);
    if (idx >= 0) {
      views.splice(idx, 1);
      if (currentViewIndex > idx) currentViewIndex -= 1;
    }
  }
  // Defensive clamp in case currentViewIndex was already past the end
  // before the splice (e.g. the focused view wasn't in `views` at all,
  // installRootPane left it at the previous initial value).
  if (currentViewIndex >= views.length) {
    currentViewIndex = Math.max(0, views.length - 1);
  }
} else if (!(window.host && window.host.serverMode)) {
  // Phase 3b commit 3: wrap the root pane's view in a tabline-view
  // that contains every restored view (or the welcome / scratch
  // seeds when there was no session). The wrap runs *after* restore
  // so the tabs list is final; the helper is idempotent only by
  // caller discipline (this is the one call site).
  //
  // Skipped in server mode: the leaf-flip hands the bare focused leaf to
  // the server's SNAPSHOT (one live view), so an in-renderer tabline would
  // just compete. Server-driven tabs arrive with the BUFFER_LIST increment.
  wrapRootInTabline();
}
// One trip through the per-pane strip refresh + a session save so the
// freshly-wrapped tabline renders on first paint and the new pane-tree
// shape lands in the on-disk session under schema v2.
refreshPaneTabStrips();
activeSession().save();

// Offer back any crash-recovery snapshots a previous run left behind.
// Session restore only reopens files from disk — it can't bring back
// unsaved edits — so this is the path that recovers work lost to a
// crash. Best-effort: a scan failure must never stop the editor coming
// up. The *Recover* view opens on top of the restored session only when
// there is something worth recovering.
//
// Skipped in server mode: the SERVER runs its own crash recovery (mwb
// autosave), so the in-renderer scan would only surface stale in-renderer
// snapshots and pop a spurious *Recover* over the server-driven leaf.
if (!(window.host && window.host.serverMode)) {
  try {
    if ((await scanForRecovery()) > 0) openRecoverView();
  } catch {
    // Recovery is best-effort; never block startup on it.
  }
}

// Boot reached the end successfully — stand the boot error boundary down
// (boot-guard.js). Any error after this is the app's normal nets' job, not
// a fatal-startup overlay.
try {
  window.__bootGuard?.markBooted();
} catch {
  /* the guard is best-effort */
}


