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
  leafPanes,
  parentOf,
  replacePane,
  siblingOf,
  spiralOrder,
  bumpIdCounterPast,
  SPLIT_HORIZONTAL,
  SPLIT_VERTICAL,
} from '@editor/pane';
import { keyword, writeString } from '@editor/lisp/values.js';
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
  createMinibuffer,
  createReplView,
  createUtilityDock,
  createOutputPanel,
  createCompletionsPanel,
  createDocPanel,
  ShellView,
  GnuplotView,
  ViewListView,
  RecoverView,
  PlaceholderView,
  cloneTargetForKind,
  isPlaceholderView,
  resolvePlaceholderAction,
  createSplitter,
  createTreeSitterHighlighter,
  VideoView,
  formBoundsAtPoint,
  formBoundsBeforePoint,
  highlightLine,
  keyEventToString,
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
  createMathTooltip,
  typesetMath,
  isMathErrorNode,
  isMathJaxReady,
  mathPreviewProviderForMode,
  TextView,
  TablineView,
  ElementView,
} from '@editor/renderer';
// path-resolve.js directly, NOT @editor/stdlib's index — its index re-exports
// createBufferPrimitives etc., which import @editor/lisp's interpreter; the
// subpath keeps the renderer's only Lisp dependency the pure value model (B7).
import { createAudioController } from './audio.js';
import { writeFaceStyleElement } from './face-styles.js';
import {
  resolveElementModuleUrl,
  normalizeFit,
  elementViewKinds,
  elementViewOpenPayload,
} from './element-spec.js';
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
import { shouldGlobalRouterDefer, shouldSwallowPreMount } from './server-router-gate.js';
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

/** B0 config cache (plans/B5-B7-TEARDOWN-AUDIT.md): the renderer-consumed
 *  defcustom values, kept as plain JS so the renderer reads config WITHOUT its
 *  (soon-to-be-deleted) interpreter. Seeded with the defcustom defaults, then
 *  refreshed by the spine's `config-snapshot` directive on connect (and on any
 *  chrome change), and by `config-apply` on a live customize edit. Declared
 *  high (before the readers below) so an early read never hits a TDZ. Until B7
 *  the interpreter still loads custom.lisp at boot — the same values, read here
 *  interpreter-free. */
const rendererConfig = {
  '*markdown-interpreter*': 'marked',
  '*pdf-restore-default*': true,
  '*autosave-recovery*': true,
  '*autosave-recovery-interval*': 1000,
  '*jukebox-track-format*': '"{title}", {artist}, {album}',
  '*directory-tree-open-target*': 'editing-pane',
  '*pane-focus-border*': 'auto',
  '*markdown-preview-follow-cursor*': true,
};

/** The autosave / crash-recovery controller: snapshots every dirty
 *  buffer to `<userData>/recovery/` (debounced on edit, immediate on
 *  blur), drops a buffer's snapshot when it is saved, and clears them
 *  all on a clean confirmed quit. A crash leaves the snapshots in place
 *  for the next launch to offer back. */
const recovery = createRecovery({
  getDirtyBuffers: () => dirtyBuffers,
  host: window.host,
  // Read the config cache (seeded with the safe defaults on/1000ms, refreshed by
  // the spine's config-snapshot/config-apply pushes) so a user can toggle
  // autosave or retune the interval from customize without a restart.
  isEnabled: () => rendererConfig['*autosave-recovery*'] !== false,
  getDebounceMs: () => {
    const v = rendererConfig['*autosave-recovery-interval*'];
    return typeof v === 'number' && v > 0 ? v : 1000;
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
      // The Markdown preview (when open) tracks the SAVED file via its own
      // `jmarkdown watch` server, so an edit needs no renderer-side refresh —
      // the preview updates on save (C-x C-s), not per keystroke.
      // (Snippet field reflow is server-side now — snippets.lisp runs in the
      // spine; the renderer interpreter holds no snippet state.)
    }
  });
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

/** The visual add-pane (`add-pane-mode.js`) / move-views (`move-view-mode.js`)
 *  overlays, when active. Held so a second entry toggles the overlay off, and a
 *  picked target / committed move can clear it. Null when no overlay is up.
 *  The overlays are renderer UI driven server-side: the `add-pane` /
 *  `swap-views` / `permute-views` commands emit an `enter-*-mode` directive; a
 *  pick sends a PANE_INTENT back that the server applies to the pane model. */
let addPaneModeHandle = null;
let moveViewsModeHandle = null;

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

// Module state read by the pane-focus machinery below. Hoisted here because the
// initial focus paint (further down) calls into `refreshPaneFocusIndicators` /
// `isNoFocusPane`, which read `activeProjectPath` — declaring it at its original
// (much later) position left it in the temporal dead zone at first paint,
// throwing a ReferenceError that aborted the whole boot. Reassigned later where
// it's used (openProject sets the project pointers).
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

/** The `*pane-focus-border*` setting ('auto | 'on | 'off), from the config
 *  cache (seeded 'auto, refreshed by the spine's config-snapshot push). */
function paneFocusBorderMode() {
  return rendererConfig['*pane-focus-border*'] || 'auto';
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
  // Run the typed command server-side — the placeholder's pane is focused, so a
  // view-opening command lands here. (The in-renderer run-command is gone with
  // the interpreter — B7. The server-mode placeholder chooser doesn't surface
  // today, so this is a defensive route, not a live path.)
  if (serverViewClient) serverViewClient.runCommand(text);
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
  // If the removed leaf was a minimap's target, the reconcile drops the now
  // orphaned minimap; otherwise it just rebinds survivors. Deferred, so it
  // runs after this deletion's tree surgery is complete.
  scheduleMinimapReconcile();
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
      // Server mode: report the final ratio so the server stores it. Otherwise the
      // drag is purely local, and the next reconcile (any PANE_TREE push — e.g. a
      // bookmark pin toggle) rebuilds the split from the server's stale ratio and
      // the resize snaps back. The server echoes the fresh PANE_TREE, which the
      // client rebuilds at this same ratio (a no-op visually).
      if (window.host && window.host.serverMode && serverViewClient) {
        serverViewClient.sendPaneIntent({ op: 'resize', paneId: splitId, ratio: splitNode.ratio });
      }
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
  hideInactiveProcViews();
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
      notifyViewsChanged();
    } else if (focused
               && focused.kind === 'leaf'
               && focused.view !== victim) {
      // Auto-collapsed: deletePaneInTree pointed focus at a sibling
      // and set currentViewIndex inside its branch. Just refresh.
      notifyViewsChanged();
    } else {
      const next = Math.min(target, views.length - 1);
      currentViewIndex = -1; // force switchToViewIndex to re-mount.
      switchToViewIndex(next);
    }
  } else if (target < currentViewIndex) {
    currentViewIndex -= 1;
    notifyViewsChanged();
  } else {
    notifyViewsChanged();
  }
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
  return rendererConfig['*pdf-restore-default*'] === true;
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
  await performShutdown();
}

/**
 * The shutdown ritual, separated from the unsaved-changes check so it can run
 * after EITHER path has decided to quit: the client-side `quitInteractive`
 * (its own dirty confirm) OR the server-driven `quit` directive (P2c — the
 * spine already walked the unsaved buffers across all windows, so it must NOT
 * be re-checked here). Offers the workspace-remember prompt, flushes metadata,
 * clears the recovery snapshots, and asks the host to quit.
 */
async function performShutdown() {
  // C2 (server mode): offer to REMEMBER this workspace — the ARRANGEMENT
  // (windows / panes / files / cursors / geometry), NOT the documents — before
  // quitting. Type a name to save a named workspace (it then shows in the launch
  // chooser); empty + Enter skips (the `__last__` auto-snapshot still preserves
  // the layout); C-g aborts the quit. Posted BEFORE the flushes below, which give
  // the server time to do its synchronous save before it's torn down.
  if (serverViewClient && godotServerPort) {
    const label = await new Promise((resolve) => {
      minibuffer.prompt('Remember this workspace as (empty = don’t): ', {
        onSubmit: (v) => resolve(String(v ?? '').trim()),
        onCancel: () => resolve(null),
      });
    });
    if (label === null) return; // cancelled → don't quit
    if (label !== '') {
      serverViewClient.reportDock(); // ensure this window's dock state is current
      godotServerPort.postMessage({ type: MSG.SESSION_SAVE, label });
    }
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


// --- incremental regexp search ----------------------------------------






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

// Reusable doc-panel tabs in the utility dock. describe-key (C-h k) /
// describe-command (C-h f) refill "Help"; apropos (C-h a) refills "Apropos".
// Both are server-driven (the show-help / show-apropos directives) and use the
// Completions-tab refill idiom so repeated lookups don't pile up tabs.
const HELP_TAB_ID = 'help-view';
const APROPOS_TAB_ID = 'apropos-view';

/** Open (or refill in place) a reusable doc-panel tab in the utility dock. BODY
 *  is rendered as Markdown and framed under HEADING in the doc-page shape the
 *  `<doc-view>` lifts; an empty body shows the EMPTY placeholder. The dock is
 *  revealed and the tab brought forward, but focus stays in the editor (click
 *  the panel to scroll / press `q` to dismiss).
 *
 *  @param {{id: string, title: string, icon: string, heading: string,
 *    body: string, empty?: string}} spec
 */
async function displayDocPanel({ id, title, icon, heading, body, empty }) {
  let rendered;
  try {
    rendered = await renderMarkdownHtml(
      typeof body === 'string' && body.length > 0 ? body : (empty ?? '_Nothing to show._')
    );
  } catch (error) {
    repl.appendError(`${title} render failed: ${error.message}`);
    return;
  }
  const html =
    `<article class="doc-page docstring-page" data-node-id="${escapeHtml(heading)}">` +
    `<h3 class="doc-name">${escapeHtml(heading)}</h3>\n` +
    `<div class="doc-docstring">${rendered}</div></article>`;
  const panel = utilityDock.hasTab(id) ? utilityDock.getPanel(id) : null;
  if (panel && typeof panel.setHtml === 'function') {
    panel.setHtml(html);
  } else {
    utilityDock.openUtilityPanel({
      id,
      title,
      icon,
      focus: false,
      makePanel: () => createDocPanel({
        html,
        title,
        icon,
        openDoc: openDocInPane,
        closeBuffer: () => utilityDock.closeUtilityTab(id),
      }),
    });
  }
  utilityDock.showUtilityDock();
  utilityDock.activateUtilityTab(id);
  // activateUtilityTab focuses the active tab's panel — but these help panels
  // are focus:false by design (you keep typing in the editor). The key router
  // only forwards keys while the editing surface is focused, so without this
  // the NEXT chord (another C-h k) is dropped until you click back into the
  // pane. Return focus to the editor next frame (after the dock's focus
  // settles), unless a minibuffer prompt is up (don't steal its focus). Same
  // shape as refocusServerView, which can't be reached from this scope.
  requestAnimationFrame(() => {
    if (minibuffer.isOpen()) return;
    const v = serverViewClient && serverViewClient.getView();
    if (v && typeof v.focus === 'function') {
      try { v.focus(); } catch { /* ignore */ }
    }
  });
}

/** Double-click in the completions panel = activate (file-browser idiom): a
 *  file OPENS (submit the prompt — drops the panel, delivers the path); a
 *  directory is ENTERED — re-running TAB completion so its contents list and
 *  the panel updates. */
function activateFromPanel(name) {
  const full = completionsDirectory + name;
  if (name.endsWith('/')) {
    // A directory: descend — fill the input and ask the SERVER to complete it
    // (the reply refreshes the panel via showCompletions), mirroring the
    // minibuffer TAB path. (Was a renderer `minibuffer-tab-complete` against the
    // idle interpreter — broken in server mode; this is the rehome.)
    minibuffer.setValue(full);
    if (serverViewClient) serverViewClient.requestMinibufferComplete(full);
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










// (Jukebox auto-advance was a renderer audio.onEnded → jukebox-track-ended call
// against the idle interpreter. The jukebox is a server data-source now; if
// playback should auto-advance in server mode, the spine drives it. Filed.)


/** Format a spine REPL eval error: its message + the source location of the
 *  offending form when the spine tagged one — mirrors formatLispError for the
 *  `{ text, location }` the spine's replEval sends back. */
function formatReplError(r) {
  const message = r?.text ?? 'eval error';
  const loc = r?.location;
  return loc ? `${message} (at line ${loc.line}:${loc.col})` : message;
}

function evaluateInRepl(source) {
  // L5: the REPL evaluates in the REAL spine world (the renderer interpreter is
  // inert under Model B), so a typed form drives the live editor and sees its
  // actual state. The result — the writeString'd value, or the error + location
  // — comes back async and appends to the dock.
  if (serverViewClient && typeof serverViewClient.replEval === 'function') {
    serverViewClient.replEval(source).then((r) => {
      if (r && r.ok) repl.appendResult(r.text);
      else repl.appendError(formatReplError(r));
    });
    return;
  }
  repl.appendError('REPL: not connected to the server yet');
}

// --- standard library ---------------------------------------------------



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


/** Things that want a callback when the editor theme changes. The
 *  shell view registers itself once it exists so xterm.js can
 *  rebuild its palette. Must sit above the first top-level
 *  `applyCurrentTheme()` call below — `applyCurrentTheme` is a
 *  function declaration (hoisted) but this is a `const` (in TDZ
 *  until evaluated), so the call would otherwise crash before the
 *  declaration runs. */
const themeListeners = new Set();


// B2.2b (plans/MODEL-B-DEFAULT.md): the CSS knobs (--tab-width / --line-height)
// are server-authoritative now, like theme + faces (B1.3). The spine pushes a
// `css-knobs` directive on connect (and re-pushes on change), applied in
// applyDirective above — so there is no local boot-time knob sync here, and the
// renderer's set-css-* are no-ops. The host-injected *tab-width* on-change moved
// to the spine.

// Kick off the doc manifest fetch — fire-and-forget. The
// `load-doc-manifest!` primitive returns the cached value once it
// arrives (so the Lisp side can stay synchronous); the very first
// caller before the fetch completes sees `nil` and the Lisp side
// re-queries on next access.
window.host
  .readDocManifest()
  .then((manifest) => {
    if (manifest === null) return;
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

// Bridge the loaded highlighters to embedded editors that mount their OWN
// <text-view> over a renderer-local buffer (the notebook-cells view), so they
// highlight without re-running loadLanguageHighlighters. Mirrors the
// window.__godotNotebookEval host→view bridge.
window.__godotHighlighters = { highlighters, foldCaptures };

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
  // The live-process sources (shell + gnuplot) still open in this window (fanned
  // per PANE_TREE). A cached process whose session leaves this set was closed →
  // reaped (child killed + element disposed) in the reconcile; a switch-away
  // keeps it here, so it survives.
  let serverLiveProcs = new Set();
  // The open browser sources in this window (fanned per PANE_TREE, the twin of
  // serverLiveProcs). A cached <browser-view> whose source leaves this set was
  // closed → its webview element is disposed in the reconcile; a switch-away
  // keeps it here, so its Chromium page survives.
  let serverLiveBrowsers = new Set();
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
  // The buffer each server-backed text element last rendered. Lets a reconcile
  // tell a FOCUS / split / re-layout (same buffer → keep the scroll exactly) from
  // a BUFFER SWITCH (new buffer → let it reveal its cursor) — so scroll never
  // changes on focus, even when the cursor sits off-screen. WeakMap: GC'd with
  // the element.
  const serverTextElLastBuffer = new WeakMap();
  // Non-text DATA-SOURCE views (image/audio/video/pdf), keyed by the server
  // source id. A media leaf/tab carries `viewKind` + `filePath` on the wire; the
  // client builds the matching element-view here and loads the bytes itself via
  // window.host.openFilePath (the server never reads them). Reused across
  // reconciles (the element survives a focus-only re-render); pruned when the
  // source is no longer shown.
  /** @type {Map<string, object>} sourceId -> element-view object. */
  const serverMediaViews = new Map();
  // Minimap companion views, keyed by the minimap LEAF id (stable across
  // reconciles). A minimap leaf has no buffer; after the reconcile mounts every
  // leaf, each minimap is bound to its TARGET leaf's <text-view> via the shared
  // minimap machinery (minimapByTargetLeafId / rebindMinimapForLeaf). Pruned when
  // the leaf leaves the PANE_TREE (toggle-off / target deleted).
  /** @type {Map<string, object>} minimapLeafId -> minimap view object. */
  const serverMinimapViews = new Map();

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
      const browserKind = w.viewKind === 'browser';
      const procViewKind = isProcViewKind(w.viewKind); // shell | gnuplot
      const customizeKind = w.viewKind === 'customize';
      const docKind = w.viewKind === 'doc'; // B4: docs are a server data-source now
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
          pinned: s.pinned === true,
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
      } else if (procViewKind) {
        // A LIVE-PROCESS data-source (shell / gnuplot). The server owns the
        // descriptor (sessionId + cwd, both server-minted); the renderer drives
        // the child in MAIN by `sessionId` via the existing shell:*/gnuplot:* IPC
        // (the server never touches the process). `spawned`/`ended` are
        // client-owned flags on the (persisted) view object — the view is exempt
        // from the switch-away prune (see reconcileServerPaneTree), so a
        // buffer-switch/split never respawns; the child is reaped only when the
        // data-source is closed. Per-instance, not a singleton: each owns its own
        // <shell-view>/<gnuplot-view> + child, so several render at once.
        const s = (w.state && typeof w.state === 'object') ? w.state : {};
        extras = {
          sessionId: typeof s.sessionId === 'string' ? s.sessionId : w.bufferId,
          cwd: typeof s.cwd === 'string' ? s.cwd : '',
          ended: false,
          spawned: false,
        };
      } else if (browserKind) {
        // A BROWSER data-source carries its url on the wire `state`; the
        // <browser-view> (Electron <webview>) reads `view.url` and navigates
        // there. The live page (history/scroll) is per-instance renderer state
        // — the server only owns the url, like a shell's cwd.
        const s = (w.state && typeof w.state === 'object') ? w.state : {};
        extras = { url: typeof s.url === 'string' && s.url !== '' ? s.url : 'about:blank' };
      } else if (directoryKind) {
        extras = { rootPath: w.filePath, expanded: new Set() };
      } else if (jukeboxKind) {
        // The server lists the directory's audio files + album art AND formats the
        // per-track labels (format-track via the standalone audio-metadata reader,
        // in spine.openJukebox — no renderer interpreter); the client plays tracks
        // via media:// URLs (jukebox-view).
        const s = (w.state && typeof w.state === 'object') ? w.state : {};
        const dir = typeof s.dir === 'string' ? s.dir : '';
        const tracks = Array.isArray(s.tracks) ? s.tracks : [];
        extras = {
          dir,
          tracks,
          art: typeof s.art === 'string' ? s.art : null,
          // Server-formatted labels ride the data-source state; bare filenames if absent.
          labels: Array.isArray(s.labels) ? s.labels : tracks,
          // refresh (g) re-reads the dir — deferred in server mode (v1 is
          // immutable; the mutable-source seam would re-scan + restate).
          refresh: () => {},
          // quit (q) stops playback; the pane itself closes via the tabline ×.
          quit: () => { try { audio.stop(); } catch { /* ignore */ } },
        };
      } else if (customizeKind) {
        // The customize view: the server leaf carries only the SCOPE
        // ({group|variable|face}); the (pre-configured singleton) view renders
        // the model + applies value/face edits from the CLIENT's interpreter,
        // which holds the same defcustom/face registry. Default = 'godot' group.
        const s = (w.state && typeof w.state === 'object') ? w.state : {};
        extras = {
          scope: (s.scope && typeof s.scope === 'object') ? s.scope : { group: 'godot' },
        };
      } else if (docKind) {
        // B4: a server 'doc' data-source carries the doc NAME (a manifest page /
        // nav node) or a live docstring's Markdown `source`. The HTML is filled
        // asynchronously below (read render-side via the host, or rendered from
        // the source); the <doc-view> renders from view.html + the nav manifest.
        const s = (w.state && typeof w.state === 'object') ? w.state : {};
        extras = {
          docName: typeof s.docName === 'string' ? s.docName : '',
          docSource: typeof s.source === 'string' ? s.source : null,
          html: '',
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
      // bookmark / shell / browser / doc render themselves from the spec / state.
      if (!directoryKind && !elementKind && !jukeboxKind && !bookmarkKind
          && !procViewKind && !customizeKind && !browserKind && !docKind) {
        loadServerMediaSrc(v, w.filePath);
      }
      // B4: the <doc-view> self-fetches its content from docName / docSource (see
      // configureDocView's readPage / renderMarkdown), so the reconcile only
      // refines the tab name from the nav tree — no host-side fill, no element
      // lookup (which differs by mount path).
      if (docKind) {
        const node = docNavTree && docNavTree.nodes ? docNavTree.nodes[v.docName] : null;
        if (node && typeof node.title === 'string') v.name = node.title;
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
      v.pinned = s.pinned === true; // drives the thumbtack (pinned vs following)
    }
    // The customize view is likewise mutable: refresh its scope AND its
    // server-computed model from the wire on every reconcile, so an openScope
    // (CUSTOMIZE_OP) navigation or a value/face edit (setState fan-out) re-renders
    // the (reused, pre-configured singleton) view from the pushed data. B2.3: the
    // model is computed server-side now; the renderer renders from state.model.
    if (w.viewKind === 'customize') {
      const s = (w.state && typeof w.state === 'object') ? w.state : {};
      v.scope = (s.scope && typeof s.scope === 'object') ? s.scope : { group: 'godot' };
      v.model = (s.model && typeof s.model === 'object') ? s.model : null;
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

  /** Re-point server-backed text element EL at VIEW during a reconcile,
   *  PRESERVING its scroll when the bound buffer is UNCHANGED (a focus / split /
   *  re-layout — not a buffer switch). `setView` forces followCursor (reveal the
   *  cursor), which is correct when the cursor MOVES or the buffer switches but
   *  wrong on a focus change: the scroll must stay put even if the cursor is
   *  off-screen. So for an unchanged buffer we capture + restore scrollTop around
   *  the re-point (setView renders synchronously, so the followCursor scroll has
   *  already happened by the time we restore). A changed buffer (a new mirror or
   *  static snapshot) re-points normally, so the new content reveals its cursor.
   *  Cursor MOVES don't come through here (they re-point via the focused-leaf
   *  adapter / buffer onChange), so reveal-on-move is unaffected. */
  function repointServerTextEl(el, view) {
    if (!el || typeof el.setView !== 'function') return;
    const nextBuffer = view ? view.buffer : null;
    const sameBuffer = nextBuffer != null && serverTextElLastBuffer.get(el) === nextBuffer;
    const scroller = sameBuffer ? el.scrollElement : null;
    const savedTop = scroller ? scroller.scrollTop : null;
    el.setView(view);
    if (scroller && savedTop != null) scroller.scrollTop = savedTop;
    serverTextElLastBuffer.set(el, nextBuffer);
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
          // Carry the tab's data-source state (scope / records / tracks): this
          // build REUSES the cached view, so omitting state let its mutable
          // refresh clobber the scope to the fallback (customize showed godot).
          state: t.state,
        });
      }
      // A text tab: the active one is the façade/static content; the rest proxies.
      if (t.bufferId === activeId) {
        // Stamp the wire's bufferId on the active view too (re-stamped on
        // every reconcile): the tab-close handler must resolve the id from
        // the SAME wire data the strip renders — the old fallback through
        // serverViewClient.currentBufferId() lags the server's re-points
        // (a close-active-tab sequence left it pointing at a killed buffer,
        // making the next active-tab × a silent no-op).
        activeTextView._serverBufferId = t.bufferId;
        return activeTextView;
      }
      return ensureServerProxy({
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
  /** Build (or reuse) the view object for a MINIMAP companion leaf. It has no
   *  buffer/bytes — the reconcile binds it to its target leaf's <text-view> via
   *  the shared minimap machinery. Keyed by the minimap leaf id so its
   *  <minimap-view> element survives reconciles. */
  function buildServerMinimapView(w) {
    let v = serverMinimapViews.get(w.id);
    if (!v) {
      v = createView({
        kind: 'minimap',
        name: 'Minimap',
        // :no-focus — clicking the minimap navigates the editor; it must never
        // become the active pane (and the server's pane model never focuses it).
        extras: { side: w.minimapSide === 'left' ? 'left' : 'right', noFocus: true },
      });
      v._serverMinimap = true;
      serverMinimapViews.set(w.id, v);
    }
    v._minimapTargetLeafId = w.minimapTarget ?? null;
    return v;
  }

  /** Reap a CLOSED live-process view (shell/gnuplot): kill its child + dispose
   *  its element wherever it lives (a bare-leaf element via procViewElementByView,
   *  or a tabline tab via the tabline's editorByChild) and drop it from the media
   *  cache. Called from the reconcile when the source has left the open-set. */
  function reapProcView(view, sourceId) {
    if (procViewElementByView.has(view)) {
      // Bare leaf: disposeProcViewElement kills the child + destroys the element.
      disposeProcViewElement(view);
    } else {
      // Tabline tab: the element lives in the tabline's editorByChild — kill the
      // child ourselves (the element's destroy() only tears down the view) then
      // dispose + un-register it. disposeKindView dispatches shellKill/gnuplotKill.
      try { disposeKindView(view); } catch { /* already gone */ }
      for (const st of tablineStateByView.values()) {
        const el = st.editorByChild.get(view);
        if (el) {
          try { el.destroy?.(); } catch { /* already gone */ }
          try { el.remove(); } catch { /* detached */ }
          st.editorByChild.delete(view);
          break;
        }
      }
    }
    serverMediaViews.delete(sourceId);
  }

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
    } else if (w.viewKind === 'minimap') {
      // A minimap companion: a non-focusable <minimap-view> bound (after the
      // reconcile) to its target leaf's <text-view>. Not a data-source.
      view = buildServerMinimapView(w);
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
    const shownMinimaps = new Set();
    forEachWireLeaf(serverPaneTreeWire, (lf) => {
      if (lf.tabline) tablineLeafIds.add(lf.id);
      // A minimap companion leaf is structural-only (no buffer); track it by leaf
      // id so a toggle-off / target-delete prunes its element below.
      if (lf.viewKind === 'minimap') { shownMinimaps.add(lf.id); return; }
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
    // A per-instance bookmark outline also disposes its own <bookmark-view>.
    for (const id of [...serverMediaViews.keys()]) {
      if (!shownMedia.has(id)) {
        const v = serverMediaViews.get(id);
        // A LIVE-PROCESS view (shell/gnuplot) is a running child: leaving the
        // visible tree (a buffer-switch, a C-x 0 that collapses its pane, a tab
        // change) must NOT reap it. Keep the cached view + its element/child alive
        // (hideInactiveProcViews hides the element); it is reaped only when its
        // data-source is actually closed (the reap loop below, driven by the
        // server's live-process set).
        if (v && isProcViewKind(v.kind)) continue;
        // A BROWSER is per-instance renderer state (a live Chromium <webview>):
        // like a proc view, a switch-away must NOT reap it — re-creating the
        // element would reset the page (history/scroll/url). Keep it cached +
        // mounted (hideInactiveBrowsers hides it); reaped only on a real close
        // (the browser reap loop below, driven by serverLiveBrowsers).
        if (v && v.kind === 'browser') continue;
        if (v && v.kind === 'bookmark') disposeBookmarkElementForView(v);
        serverMediaViews.delete(id);
      }
    }
    // Reap CLOSED live-process views: a shell/gnuplot whose source left the
    // server's open-set (serverLiveProcs) was killed (C-x k / tab ×) — kill its
    // child + dispose its element. A switch-away keeps the source open, so it's
    // still here and survives (the prune above already exempted it). Keyed by
    // source id, which is the sessionId.
    for (const [id, v] of [...serverMediaViews]) {
      if (v && isProcViewKind(v.kind) && !serverLiveProcs.has(id)) reapProcView(v, id);
    }
    // Reap CLOSED browser views: a <browser-view> whose source left the server's
    // open-set (serverLiveBrowsers) was closed (C-x k / tab ×) — dispose its
    // webview element + drop the cache. A switch-away keeps it open (exempted
    // above), so its page survives. Keyed by the data-source id.
    for (const [id, v] of [...serverMediaViews]) {
      if (v && v.kind === 'browser' && !serverLiveBrowsers.has(id)) {
        disposeBrowserElementForView(v);
        serverMediaViews.delete(id);
      }
    }
    // Drop minimap companions whose leaf left the tree (toggle-off / target
    // deleted): dispose the <minimap-view> element + clear its target binding.
    for (const [leafId, v] of [...serverMinimapViews]) {
      if (!shownMinimaps.has(leafId)) {
        const targetId = v._minimapTargetLeafId;
        if (targetId != null && minimapByTargetLeafId.get(targetId) === v) {
          minimapByTargetLeafId.delete(targetId);
        }
        disposeMinimapElementForView(v);
        serverMinimapViews.delete(leafId);
      }
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
            // Preserve scroll on a focus/relayout re-point (only reveal on a
            // genuine buffer switch) — never scroll the document on focus.
            try { repointServerTextEl(el, activeChild); } catch { /* ignore */ }
          } else if (el && typeof el.setBuffer === 'function' && !isProcViewKind(activeChild.kind)) {
            // Media (image/audio/video/pdf) re-binds via setBuffer so swapping one
            // media tab in over another re-points the element. A LIVE-PROCESS view
            // (shell/gnuplot) is NOT re-bound: its element is already bound 1:1 to
            // its child session (ensureTabElement set it once), and a redundant
            // setBuffer re-enters the view's async build — racing a SECOND instance
            // + double-spawn, which leaves the visible view blank even though the
            // child spawned and output arrives. This is the tabline-path twin of
            // the ensureProcViewElement guard; the bare-leaf path has no re-point.
            try { el.setBuffer(activeChild); } catch { /* ignore */ }
          }
        }
      } else if (leaf.view && leaf.view._serverMinimap) {
        // A minimap companion: mount its <minimap-view> element and remember its
        // target leaf so the deferred rebind below binds it to that leaf's
        // <text-view> (after every leaf's element exists + has laid out).
        const targetId = leaf.view._minimapTargetLeafId;
        if (targetId != null) minimapByTargetLeafId.set(targetId, leaf.view);
        ensureMinimapElementForView(leaf.view, paneElements.get(leaf.id));
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
        // focus off the document. A LIVE-PROCESS view (shell/gnuplot) follows the
        // same rule: with one in a split beside the document, an unrelated
        // reconcile must not yank the keyboard into it. Media keep always-focus.
        const focus = !(
          (leaf.view.kind === 'bookmark' || leaf.view.kind === 'browser'
            || isProcViewKind(leaf.view.kind))
          && leaf.id !== currentPaneId
        );
        mountKindView(leaf.view, { paneEl: paneElements.get(leaf.id), focus });
      } else if (leaf.view && leaf.view.kind === 'text') {
        const inst = ensureEditorViewForLeaf(leaf);
        // Preserve scroll on a focus/relayout re-point (a plain leaf reuses its
        // element, so only followCursor could move it); reveal only on a switch.
        if (inst) { try { repointServerTextEl(inst, leaf.view); } catch { /* ignore */ } }
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
    // Now that the server tree is applied and every leaf is mounted, (re)compute
    // the project dir-tree's editing-pane target so a file opened from the tree
    // lands in the middle tabline, not the tree's own pane. Under Model B the
    // pane tree is server-driven, so this must run on each reconcile (the old
    // renderer-driven project path did it once at open). A no-op with no tree.
    reapplyProjectDirTreeTarget();
    // Bind each minimap companion to its target leaf's <text-view> now that every
    // leaf has mounted + laid out (deferred a microtask; a no-op when none exist).
    scheduleMinimapReconcile();
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
      setView: (_requestedView, opts) => { const i = focusedInstance(); if (i) { try { i.setView(i.boundView ?? serverFacadeView, opts); } catch { /* ignore */ } } },
      focus: () => { const i = focusedInstance(); if (i) { try { i.focus(); } catch { /* ignore */ } } },
      recenter: () => { const i = focusedInstance(); if (i) { try { i.recenter(); } catch { /* ignore */ } } },
      pageLines: () => { const i = focusedInstance(); try { return i ? i.pageLines() : 0; } catch { return 0; } },
      destroy: () => { /* soft */ },
    };
  }

  /** A server PANE_TREE push: store it and render the new layout — splits appear
   *  / collapse, a tabline leaf re-renders. Every window renders from its
   *  PANE_TREE now (the unify); a push before the first mirror is just stored. */
  function applyServerPaneTree(tree, liveProcs, liveBrowsers) {
    serverPaneTreeWire = tree;
    // The live-process sources (shell + gnuplot) still open in this window
    // (server's open-set). A process whose session is NOT here was closed (C-x k /
    // tab ×) — reaped below. Only update when the server actually sent the field
    // (every PANE_TREE does), so a stray push without it can't wrongly reap all.
    if (Array.isArray(liveProcs)) serverLiveProcs = new Set(liveProcs);
    // The open browser sources (same seam, for <webview> elements).
    if (Array.isArray(liveBrowsers)) serverLiveBrowsers = new Set(liveBrowsers);
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
    setModeline: (modeline, v) => {
      nameEl.textContent = modeline;
      positionEl.textContent = '';
      document.title = `${modeline} — Godot`;
      // The server computes the focused buffer's mode menu (the client's own
      // interpreter is inert under GODOT_SERVER=1) and ships it in the view-state;
      // forward it to the macOS app menu so the menu follows the buffer's mode.
      if (v && 'modeMenu' in v) applyServerModeMenu(v.modeMenu);
      // Markdown-preview forward search: follow the cursor line in the preview.
      if (v && typeof v.cursorLine === 'number') previewScrollToCursor(v.cursorLine);
      // Live preview: on a text change, debounce a save-free refresh (the
      // guard inside skips cursor-only pushes and non-previewed buffers).
      schedulePreviewSync();
    },
    // The echo area: a mid-chord prefix (e.g. "C-x-") or a one-off status. The
    // minibuffer component reuses its row as the echo area when no prompt is up.
    setEcho: (status) => minibuffer.setStatus(status ?? ''),
    // The echo area as STYLED segments ([{ text, color, bold }]) — e.g. the
    // quit walk's red Save prompt with a bold filename. Plain setEcho otherwise.
    setEchoRich: (segments) => minibuffer.setStatusRich(segments),
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
        // ⌫ on a deletable row (workspace mgmt): the panel stays open.
        onDelete: typeof cbs.onDelete === 'function' ? cbs.onDelete : undefined,
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
    requestNewWindow: (geometry) => {
      if (window.host && typeof window.host.newWindow === 'function') {
        window.host.newWindow(geometry);
      }
    },
    // P2: a CLIENT_DIRECTIVE — the server told THIS window to perform a
    // renderer-side action. The server already chose the recipients (this /
    // other / all windows); we just apply it. `close-window` (C-x 5 0, or
    // C-x 5 1 from another window) closes this window via the host; the server
    // keeps the buffers. New directive names slot in as they're ported.
    applyDirective: (name, args) => {
      if (name === 'close-window') {
        if (window.host && typeof window.host.closeWindow === 'function') {
          window.host.closeWindow();
        }
      } else if (name === 'quit') {
        // P2c: the spine's quit-editor already walked the unsaved buffers
        // across all windows (save-some-buffers), so run the shutdown ritual
        // directly — no second dirty check.
        performShutdown();
      } else if (name === 'show-help') {
        // P3: describe-key (C-h k) / describe-command (C-h f) resolved a
        // command server-side and asked THIS window to surface its docstring.
        // args = [heading, docstring]; the dock owns one reusable Help tab.
        displayDocPanel({
          id: HELP_TAB_ID, title: 'Help', icon: 'fa-solid fa-circle-question',
          heading: String(args?.[0] ?? ''), body: String(args?.[1] ?? ''),
          empty: '_No documentation._',
        });
      } else if (name === 'show-apropos') {
        // P3: apropos (C-h a) matched commands server-side and asked THIS
        // window to list them. args = [heading, markdown-list].
        displayDocPanel({
          id: APROPOS_TAB_ID, title: 'Apropos', icon: 'fa-solid fa-list-ul',
          heading: String(args?.[0] ?? ''), body: String(args?.[1] ?? ''),
          empty: '_(none)_',
        });
      } else if (name === 'markdown-preview') {
        // P3: the JMarkdown live-preview toggle (C-c v / the Markdown/JMarkdown
        // mode menu). The server resolved the command and sent the active
        // buffer's saved path (args[0], '' when unsaved); toggle the preview
        // pane here, pointing it at the real `jmarkdown watch` server.
        toggleMarkdownPreview(String(args?.[0] ?? ''));
      } else if (name === 'recenter-current-line') {
        // SyncTeX inverse search: center the just-revealed line. Goes through the
        // ACTIVE editorView (correctly re-pointed at the source pane on mount) —
        // the server's onScroll/recenter path targets serverViewClient's own view,
        // which is the wrong object after a pane switch (line stuck at the edge).
        if (editorView && typeof editorView.recenter === 'function') {
          editorView.recenter();
        }
      } else if (name === 'flash-current-line') {
        // Inverse search (Markdown-preview ⌘-click): the server moved + centered
        // the cursor; flash its line so the user sees where the jump landed. The
        // view defers the flash to the next render, so it lands on the just-moved
        // line regardless of whether this arrives before or after the cursor view.
        if (editorView && typeof editorView.flashCurrentLine === 'function') {
          editorView.flashCurrentLine();
        }
      } else if (name === 'markdown-preview-sync') {
        // Explicit forward search (C-c C-v): scroll the preview to the cursor's
        // line (args[0], 1-based) and flash it, regardless of the follow setting.
        previewSyncToCursor(Number(args?.[0]));
      } else if (name === 'enter-add-pane-mode') {
        // The visual add-pane macro (C-x + / M-x add-pane): the server asked
        // THIS window to show the overlay over #editor-host. Re-entry toggles it
        // off. A picked splitter / border sends a PANE_INTENT the server applies
        // to this window's pane model (it re-pushes PANE_TREE with the new pane).
        // The overlay reads the server-synced `rootPane` (ids match the server).
        if (addPaneModeHandle && addPaneModeHandle.active) {
          addPaneModeHandle.exit();
          addPaneModeHandle = null;
        } else {
          const sendPane = (intent) => {
            if (serverViewClient && typeof serverViewClient.sendPaneIntent === 'function') {
              serverViewClient.sendPaneIntent(intent);
            }
          };
          addPaneModeHandle = enterAddPaneMode({
            host: editorHostEl,
            getRootPane: () => rootPane,
            onPickSplitter: (splitId) => {
              sendPane({ op: 'add-at-splitter', paneId: splitId });
              addPaneModeHandle = null;
            },
            onPickBorder: (side) => {
              sendPane({ op: 'add-at-border', side });
              addPaneModeHandle = null;
            },
          });
          // Escape tears the overlay down itself; drop our handle so a re-entry
          // doesn't try to exit() a dead overlay.
          if (addPaneModeHandle) {
            const original = addPaneModeHandle.exit;
            addPaneModeHandle.exit = () => { original(); addPaneModeHandle = null; };
          }
        }
      } else if (name === 'enter-move-views-mode') {
        // The visual swap-views / permute-views macro (args[0] = 'swap'|'permute'):
        // badge every pane, read the user's picks, then commit ONE structural
        // rearrangement. Re-entry toggles the overlay off. We translate the
        // overlay's badge-number assignments into leaf IDS — using the SAME
        // spiral order it badged — and send ONE move-views PANE_INTENT; the
        // server moves the leaves (a browser/pdf/shell guest rides along, not
        // recreated), keeping the geometry decision on the client.
        const moveMode = args?.[0] === 'permute' ? 'permute' : 'swap';
        if (moveViewsModeHandle && moveViewsModeHandle.active) {
          moveViewsModeHandle.exit();
          moveViewsModeHandle = null;
        } else {
          moveViewsModeHandle = enterMoveViewsMode({
            mode: moveMode,
            host: editorHostEl,
            getRootPane: () => rootPane,
            onCommit: (assignments) => {
              moveViewsModeHandle = null;
              if (!Array.isArray(assignments)) return;
              const rect = editorHostEl.getBoundingClientRect();
              const { ordered } = spiralOrder(rootPane, { width: rect.width, height: rect.height });
              const n = ordered.length;
              if (n === 0) return;
              // occupantBySlot[s] = the leaf whose content should land at slot s.
              const occupantBySlot = new Array(n);
              if (moveMode === 'swap') {
                for (let i = 0; i < n; i += 1) occupantBySlot[i] = ordered[i];
                const a = assignments[0] - 1;
                const b = assignments[1] - 1;
                if (a < 0 || b < 0 || a >= n || b >= n) return;
                const tmp = occupantBySlot[a];
                occupantBySlot[a] = occupantBySlot[b];
                occupantBySlot[b] = tmp;
              } else {
                if (assignments.length !== n) return;
                for (let k = 0; k < n; k += 1) {
                  const dest = assignments[k] - 1;
                  if (dest < 0 || dest >= n) return;
                  occupantBySlot[dest] = ordered[k];
                }
              }
              if (occupantBySlot.some((leaf) => !leaf)) return; // incomplete pick
              if (serverViewClient && typeof serverViewClient.sendPaneIntent === 'function') {
                serverViewClient.sendPaneIntent({
                  op: 'move-views',
                  slotOrder: ordered.map((l) => l.id),
                  occupants: occupantBySlot.map((l) => l.id),
                });
              }
            },
          });
          if (moveViewsModeHandle) {
            const original = moveViewsModeHandle.exit;
            moveViewsModeHandle.exit = () => { original(); moveViewsModeHandle = null; };
          }
        }
      } else if (name === 'theme-apply') {
        // B1.3 (plans/MODEL-B-DEFAULT.md): the spine pushed the theme's CSS
        // variables (JSON array of [--var, value]). Apply them to :root and
        // notify theme listeners (e.g. the shell's xterm palette). The server is
        // authoritative — the renderer no longer computes the theme itself.
        try {
          const pairs = JSON.parse(String(args?.[0] ?? '[]'));
          for (const [cssVar, value] of pairs) {
            if (typeof cssVar === 'string' && cssVar.startsWith('--') && value !== '') {
              document.documentElement.style.setProperty(cssVar, String(value));
            }
          }
          for (const listener of themeListeners) {
            try { listener(); } catch { /* listener bug — keep going */ }
          }
        } catch { /* malformed payload — keep the current theme */ }
      } else if (name === 'faces-apply') {
        // B1.3: the spine pushed the prebuilt face-overrides CSS string; inject it
        // into <style id="face-overrides"> (writeFaceStyleElement). No local
        // face-styles computation needed.
        writeFaceStyleElement(document, String(args?.[0] ?? ''));
      } else if (name === 'highlight-rules') {
        // B1.3: the spine pushed the user's highlight-rule records (JSON
        // {scope,key,pattern,face}). Replace the override store + re-highlight.
        try {
          const entries = JSON.parse(String(args?.[0] ?? '[]'));
          highlightOverrideStore.replaceAll(entries);
          rerenderAllEditors();
        } catch { /* malformed — keep current highlighting */ }
      } else if (name === 'css-knobs') {
        // B2.2b: the spine pushed the editor's CSS knobs ({tabWidth, lineHeight}).
        // Apply them to the document root's CSS vars — the renderer's set-css-*
        // primitives are no-ops now; the server drives these like theme/faces.
        // Clamp defensively (the old set-css-* primitives did the same).
        try {
          const { tabWidth, lineHeight } = JSON.parse(String(args?.[0] ?? '{}'));
          if (Number.isFinite(tabWidth) && tabWidth > 0) {
            const width = tabWidth | 0;
            document.documentElement.style.setProperty('--tab-width', String(width));
            currentTabWidth = width;
          }
          if (Number.isFinite(lineHeight) && lineHeight >= 1 && lineHeight <= 3) {
            document.documentElement.style.setProperty('--line-height', String(lineHeight));
          }
        } catch { /* malformed — keep the current knobs */ }
      } else if (name === 'config-snapshot') {
        // B0 (plans/B5-B7-TEARDOWN-AUDIT.md): the spine pushed the full set of
        // renderer-consumed defcustom values as plain JS (on connect, and on any
        // chrome change). Merge into the config cache so the renderer reads
        // config without its interpreter. Idempotent.
        try {
          const snap = JSON.parse(String(args?.[0] ?? '{}'));
          for (const [k, v] of Object.entries(snap)) rendererConfig[k] = v;
        } catch { /* malformed — keep the current cache */ }
      } else if (name === 'config-apply') {
        // L6 (plans/B5-B7-TEARDOWN-AUDIT.md): the spine pushed a renderer-consumed
        // customize setting that changed live, as [varName, valueJson] — the plain
        // JS value JSON-encoded (clone-safe, mirroring config-snapshot). Merge it
        // straight into the config cache; every live consumer (markdown preview,
        // autosave getters, the pdf-restore default) reads from rendererConfig. No
        // interpreter: the jukebox relabel — the only renderer reactive on-change —
        // is server-side (relabelJukeboxes), and refresh-jukebox-labels! is a
        // renderer no-op. (Was a custom-apply! re-eval; the last interpreter use in
        // this handler, gone for B7.)
        try {
          const varName = String(args?.[0] ?? '');
          if (varName) rendererConfig[varName] = JSON.parse(String(args?.[1] ?? 'null'));
        } catch { /* malformed — leave the current value */ }
      } else if (name === 'utility-panel-open') {
        // B4 (latex-compile.lisp): open/reuse a utility-dock tab. Mirrors the
        // renderer's old utility-panel-open! primitive — look up the factory and
        // open the tab without stealing focus. [factory, id, title].
        const factoryName = String(args?.[0] ?? '');
        const id = String(args?.[1] ?? factoryName);
        const title = String(args?.[2] ?? id);
        const factory = utilityPanelFactories.get(factoryName);
        if (factory) {
          utilityDock.openUtilityPanel({
            id, title,
            makePanel: (handle) => factory(handle, { title }),
            focus: false,
          });
        }
      } else if (name === 'utility-panel-set') {
        // Replace the named panel's content ([id, text]).
        const panel = utilityDock.getPanel(String(args?.[0] ?? ''));
        if (panel && typeof panel.setContent === 'function') panel.setContent(String(args?.[1] ?? ''));
      } else if (name === 'utility-panel-append') {
        // Append to the named panel's log ([id, text]).
        const panel = utilityDock.getPanel(String(args?.[0] ?? ''));
        if (panel && typeof panel.appendOutput === 'function') panel.appendOutput(String(args?.[1] ?? ''));
      } else if (name === 'utility-panel-activate') {
        // Bring the named tab forward ([id]).
        utilityDock.activateUtilityTab(String(args?.[0] ?? ''));
      } else if (name === 'pdf-reload') {
        // B4 (latex-compile.lisp): a recompile produced the same pdf path with
        // new bytes; reload the open pdf-view (bypassing its same-path load
        // guard). [path] — empty reloads the current pdf; a path reloads only
        // when the singleton shows that file. Mirrors the old pdf-reload!.
        const current = pdfView.buffer;
        if (current) {
          const wanted = String(args?.[0] ?? '');
          if (!(wanted !== '' && viewFilePath(current) !== wanted)
              && typeof pdfView.reload === 'function') {
            pdfView.reload();
          }
        }
      } else if (name === 'pdf-synctex-show') {
        // Forward SyncTeX (C-c C-v): the spine ran `synctex view` and asks THIS
        // window's PDF (when it shows args[0]) to scroll to the page + flash the
        // typeset box. [path, page, x, y, w, h] (PDF points; page 1-based).
        // Mirrors the old pdf-synctex-show! prim (the box anchor is x/y, so the
        // highlight covers the box: { h: x, v: y, w, h_: h }).
        const current = pdfView.buffer;
        const wanted = args?.[0] != null ? String(args[0]) : '';
        const page = Number(args?.[1]);
        const x = Number(args?.[2]);
        const y = Number(args?.[3]);
        if (current
            && !(wanted !== '' && viewFilePath(current) !== wanted)
            && Number.isFinite(page) && Number.isFinite(x) && Number.isFinite(y)
            && typeof pdfView.syncTexShow === 'function') {
          const w = Number(args?.[4]) || 0;
          const h = Number(args?.[5]) || 0;
          pdfView.syncTexShow(page, x, y, { h: x, v: y, w, h_: h });
        }
      } else if (name === 'open-project-dialog') {
        // B4 project Stage 3 (open-project): the spine asked this window to run the
        // native OS directory picker; the chosen dir goes back up as PROJECT_OPEN
        // (→ a new project window). The picker is a renderer/main concern.
        window.host
          .openDirectory()
          .then((path) => { if (path) requestOpenProject(path); })
          .catch((error) => repl.appendError(error.lispMessage ?? error.message ?? String(error)));
      } else if (name === 'remember-project') {
        // B4 project: record an opened project in the central index so the
        // chooser lists it. Under Model B the spine opens projects, so the old
        // in-place openProject's rememberProject call no longer runs.
        const root = String(args?.[0] ?? '');
        if (root) {
          rememberProject(root).catch((error) =>
            repl.appendError(error.lispMessage ?? error.message ?? String(error)));
        }
      } else if (name === 'open-project-chooser') {
        // B4 project Stage 3 (project-chooser): show the visual launcher; its
        // open/openFolder actions route the chosen path up as PROJECT_OPEN.
        showProjectChooser();
      } else if (name === 'tree-sitter-query') {
        // B4 face-info: the spine asked for the focused buffer's tree-sitter info
        // at a point (tree-sitter is WASM here). Compute the captures + node and
        // reply up as TREE_SITTER_INFO — the spine resumes the suspended C-h F /
        // C-h C-f command. Reuses the highlighter (same as the old in-renderer
        // tree-sitter-captures-for-buffer! / -node-at-point! primitives).
        const pt = Number(args?.[0] ?? 0);
        const payload = { lang: null, captures: [], node: null, colors: {} };
        try {
          const buf = currentTextBuffer;
          if (buf && typeof buf.text === 'string') {
            const language = languageForFilename(buf.name);
            const hl = language && highlighters[language];
            if (hl && typeof hl.captures === 'function') {
              payload.lang = language;
              payload.captures = hl.captures(buf.text).map((r) => [r.start, r.end, r.face]);
              // Resolve each distinct face's rendered colour from the live CSS
              // cascade (--tok-<face>); the spine can't (it has no styles.css /
              // theme CSS), so it reads these via face-color-for after the reply.
              const root = getComputedStyle(document.documentElement);
              for (const [, , face] of payload.captures) {
                if (face && !(face in payload.colors)) {
                  payload.colors[face] = root.getPropertyValue(`--tok-${face}`).trim();
                }
              }
              if (typeof hl.nodeAtPoint === 'function') {
                const info = hl.nodeAtPoint(buf.text, pt);
                if (info) {
                  payload.node = {
                    type: info.type, start: info.start, end: info.end,
                    ancestors: info.ancestors,
                  };
                }
              }
            }
          }
        } catch (error) {
          repl.appendError(`tree-sitter: ${error.lispMessage ?? error.message ?? String(error)}`);
        }
        if (godotServerPort) {
          godotServerPort.postMessage({ type: MSG.TREE_SITTER_INFO, ...payload });
        }
      } else if (name === 'fold-toggle') {
        // B4 (folding.lisp): fold a view concern — act on the focused editor.
        editorView.toggleFoldAtPoint();
      } else if (name === 'fold-all') {
        editorView.foldAll();
      } else if (name === 'unfold-all') {
        editorView.unfoldAll();
      } else if (name === 'toggle-repl') {
        // B4 (system.lisp): show/hide the REPL / utility dock, then tell the
        // server the new visibility so the workspace keeps it (mirrors the old
        // toggle-repl! primitive).
        utilityDock.toggleUtilityDock();
        if (serverViewClient) serverViewClient.reportDock();
      } else if (name === 'sticky-add') {
        // B4 (sticky-notes): the renderer does the whole op so no note id crosses
        // the wire. Create at the (server-synced) cursor + open it for editing.
        const id = stickyNotes.create();
        if (id != null) stickyNotes.edit(String(id));
      } else if (name === 'sticky-edit') {
        const id = stickyNotes.noteAtPoint();
        if (id != null) stickyNotes.edit(String(id));
        else minibuffer.setStatus('No sticky note near the cursor.');
      } else if (name === 'sticky-delete') {
        const id = stickyNotes.noteAtPoint();
        if (id != null) stickyNotes.remove(String(id));
        else minibuffer.setStatus('No sticky note near the cursor.');
      } else if (name === 'sticky-next') {
        stickyNotes.gotoNext();
      } else if (name === 'sticky-prev') {
        stickyNotes.gotoPrevious();
      } else if (name === 'sticky-toggle') {
        stickyNotes.toggle();
      } else if (name === 'inline-eval-result') {
        // B4 (inline-eval): the spine evaluated a form in its session and pushed
        // the result (end offset, label, ok). Show the pill beside the form.
        const end = Number(args?.[0]);
        const label = String(args?.[1] ?? '');
        const ok = args?.[2] === true;
        if (Number.isInteger(end)) {
          if (ok) inlineEval.showResult(end, label);
          else inlineEval.showError(end, `! ${label}`);
        }
      }
    },
    // B2: apply a saved window frame to THIS window (SET_WINDOW_BOUNDS, sent to
    // window 1 on restore). main reconciles it against the live displays.
    setWindowBounds: (geometry) => {
      if (window.host && typeof window.host.setWindowBounds === 'function') {
        window.host.setWindowBounds(geometry);
      }
    },
    // Workspace restore: re-show/hide the REPL / utility dock to its saved state.
    setDock: (dock) => {
      if (!dock) return;
      if (dock.visible === false) utilityDock.hideUtilityDock();
      else if (dock.visible === true) utilityDock.showUtilityDock();
    },
    // G4 Step 3: the server pushed this window's pane layout. Render it (splits
    // become visible). Only a 'single' (fresh / composable) window reflects the
    // server tree; window 1 keeps its tabline.
    setPaneTree: (tree, liveProcs, liveBrowsers) =>
      applyServerPaneTree(tree, liveProcs, liveBrowsers),
    // B4: a server buffer mirror mounted (SNAPSHOT). Point the sticky-notes
    // overlay manager at it so the buffer's notes (server-pushed onto
    // mirror.metadata.notes) render on this editor, and (re)bind the inline-eval
    // pill overlay. Guarded against the init-TDZ trap (stickyNotes / inlineEval
    // are declared later); a later snapshot re-wires if this fires too early.
    onServerBuffer: (mirror, serverView) => {
      // Point currentTextBuffer at the mirror so the overlay managers that read it
      // — inline-eval positions its pill via getBuffer→currentTextBuffer.positionAt,
      // and sticky-notes anchors a new note at currentTextBuffer.point — use the
      // RIGHT buffer (the editor's), not the stale boot scratch. A bare assignment
      // (not setCurrentTextBuffer): under Model B the SERVER owns dirty/autosave, so
      // the renderer dirty-watch is moot here.
      currentTextBuffer = mirror;
      try {
        const overlay = serverView && serverView.overlayLayer;
        if (overlay) {
          stickyNotes.setOverlayLayer(overlay);
          inlineEval.setOverlayLayer(overlay);
        }
        stickyNotes.setBuffer(mirror);
      } catch { /* declared later / mid-init — a later snapshot re-wires */ }
    },
  };

  bootServerViewClient = () => {
    if (serverViewClient || !godotServerPort) return;
    // The cell notebook (M-x notebook-cells) evaluates its cells in the spine's
    // Node context — the renderer can't (CSP forbids unsafe-eval). Expose the
    // round-trip as a renderer global the bundled <notebook-cells-view> reads;
    // lazy so it works regardless of when serverViewClient finishes connecting.
    // Flag-off this is never set, so the notebook view falls back to local eval
    // (which the CSP blocks — the notebook is a GODOT_SERVER=1 feature).
    window.__godotNotebookEval = (source, sessionId) =>
      serverViewClient && typeof serverViewClient.notebookEval === 'function'
        ? serverViewClient.notebookEval(source, sessionId)
        : Promise.reject(new Error('notebook eval needs the server (GODOT_SERVER=1)'));
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
      // B2: this window's frame + display, for the session's geometry. A one-shot
      // pull on connect + a subscription to every move/resize (main pushes
      // window:bounds). Both no-op if the host build lacks the methods.
      getWindowBounds: () =>
        (window.host && typeof window.host.getWindowBounds === 'function'
          ? window.host.getWindowBounds()
          : Promise.resolve(null)),
      subscribeWindowBounds: (report) => {
        if (window.host && typeof window.host.onWindowBounds === 'function') {
          return window.host.onWindowBounds(report);
        }
        return () => {};
      },
      // The REPL / utility-dock visibility, for the workspace (reported on connect
      // + after a manual toggle).
      getDockState: () => ({ visible: utilityDock.isUtilityVisible() }),
      // The renderer owns element-view commands (define-element-view, incl.
      // user config): announce their names so the server's M-x routes them
      // back down (RUN_CLIENT_COMMAND), and run them here when it does.
      clientCommandNames: elementViewKinds,
      runClientCommand: (name, bibPath) => {
        // L4 (plans/B5-B7-TEARDOWN-AUDIT.md): element-view dispatch is plain JS
        // now — the registry + payload come from element-spec.js, not the
        // renderer interpreter. SAFETY GATE unchanged: the server's M-x fallback
        // forwards ANY unmatched name here, so REFUSE anything that isn't a
        // current element-view (a typo, or a renderer command not yet ported to
        // Model B) — it would otherwise reach the inert session.
        if (!elementViewKinds().includes(name)) {
          minibuffer.message(`No command: ${name}`);
          return;
        }
        try {
          // bib-search can't see the active document in server mode (the inert
          // renderer session), so the server resolved its bibliography and sent
          // it as bibPath; fold it straight into the open payload (host-file-url
          // src + a bib-path attr), exactly as the old Lisp command did. The
          // payload is identical to what open-element-view! built.
          const payload = elementViewOpenPayload(name, {
            bibPath,
            hostFileUrl: vouchHostFileUrl,
          });
          if (payload && serverViewClient) {
            serverViewClient.openElementView(payload);
          }
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

// B1.3: highlight rules are server-authoritative too — the spine pushes
// highlight-rules on connect (and on change), applied in applyDirective above.
// No local install at boot. (installHighlightRules stays for reloadStdlib.)

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
  // No keymap-ready gate: before the server view mounts, `mounted` is false and
  // the swallow-pre-mount arm handles the key (B7 — keymapReady is gone with the
  // interpreter). The two arms self-gate on `mounted` (serverViewClient.getView()).
  const serverMode = !!(window.host && window.host.serverMode);
  const mounted = !!(serverViewClient && serverViewClient.getView());
  // Server-mode (Model B): once the server view is mounted it is the sole
  // dispatcher. A focused TEXT view routes its own keys (its onKey →
  // serverViewClient.dispatchKey), so the global router stands down for it — else
  // a key reaching <body> (focus drift) would be dispatched twice. BUT a focused
  // NON-TEXT view (a media / element data-source view) has no such onKey, so a
  // command CHORD would be lost and could trap the user on, e.g., a video. Route
  // just those held-modifier chords up to the server here; bare keys
  // (space=play/pause, arrows=seek) stay with the element.
  if (shouldGlobalRouterDefer(serverMode, mounted)) {
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
  // Pre-mount (Model B boot window): server-mode is on but the view has not
  // mounted yet (the SNAPSHOT/mount round-trip is still in flight). There is no
  // server dispatcher to route to, and the in-renderer interpreter is the idle
  // mirror the server supersedes (and which B7 deletes) — so SWALLOW command
  // chords here. Otherwise an early Cmd/Ctrl/Alt chord that reached <body> would
  // fall through to a native menu accelerator (Close/Open/…) during boot. Bare
  // keys are harmless — no view to receive them yet. Guards mirror the mounted
  // arm. (serverMode is permanently true in Model B, so the old flag-off
  // local-dispatch path that ran here is dead and has been removed.)
  if (shouldSwallowPreMount(serverMode, mounted)) {
    if (event.defaultPrevented) return;            // a deeper listener claimed it
    if (BARE_MODIFIER_KEYS.has(event.key)) return; // a bare modifier press
    if (targetOwnsKeys(event.target)) return;      // minibuffer / native input
    if (event.metaKey || event.ctrlKey || event.altKey) event.preventDefault();
  }
});

// Native paste action (right-click Paste, the Edit menu's Paste). In Model B
// this is a server-owned concern, so the global handler stands down — see below.
window.addEventListener('paste', () => {
  // Model B: paste is server-owned. Keyboard paste is the M-v binding (Cmd-V =
  // M-v → yank server-side). For a native `paste` event (right-click / Edit
  // menu) the in-renderer `yank` would mutate the idle mirror, not the server's
  // buffer, so the global handler stands down — mounted, the focused element /
  // server owns it; pre-mount there is nothing to paste into yet. (serverMode is
  // permanently true, so the old flag-off yank path is dead and has been removed;
  // routing a native paste event to the server is a possible follow-on.)
  if (window.host && window.host.serverMode) return;
});

// --- mode menu ----------------------------------------------------------
// The native menu shows the current buffer's mode commands. The SERVER owns the
// keymaps + the mode-menu registrations (menus.lisp/latex-menu.lisp/markdown.lisp
// + the language modes, all in SPINE_STDLIB), so the spine computes the menu —
// `{label, entries, sections}` — and pushes it in the view-state. The renderer
// just renders the pushed data (applyServerModeMenu) and ships it to the main
// process; a click comes back through onMenuCommand → the spine (RUN_COMMAND).

let lastModeMenuJson = null;

/** Render a SERVER-computed mode menu (carried in the view-state) into the macOS
 *  app menu. The focused buffer + its mode live on the server, so the spine
 *  computes `{label, entries, sections}` (the inert renderer interpreter can't);
 *  the renderer just builds the items + ships them. Dedup'd via lastModeMenuJson.
 *  Called on every view-state update (mode switch, pane/buffer switch). */
function applyServerModeMenu(data) {
  const menu = data
    ? { label: data.label, items: buildModeMenuItems(data.entries, data.sections) }
    : null;
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
  // Snippet fields are server-side now (snippets.lisp runs in the spine); the
  // renderer interpreter holds no snippet state, so there are no boxes to paint
  // from here. If snippet decorations should show in server mode, the spine
  // pushes them via the overlay channel (filed — verify in the matrix).
  return [];
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
/** The general `math-preview-mode` provider map came from the renderer
 *  interpreter. In Model B the buffer's server-pushed `mathPreviewActive`
 *  flag drives activation (`resolvedMathPreviewActive` checks it first) and
 *  the provider is resolved by mode NAME (`mathPreviewProviderForMode`), so
 *  the map is unused — return null. (Interpreter gone — B7.) */
function resolveMathPreviewMode() {
  return null;
}

/** The major-mode display name for BUFFER. Under GODOT_SERVER=1 the renderer's
 *  interpreter is inert and the mirror carries no Lisp major-mode map, so the
 *  server pushes the name onto the mirror (`buffer.majorModeName`); prefer that
 *  when present, else read the buffer's own major-mode map (the flag-off
 *  path). The math-preview host feeds the result to mathPreviewProviderForMode. */
function resolvedMajorModeName(buffer) {
  if (buffer && typeof buffer.majorModeName === 'string' && buffer.majorModeName) {
    return buffer.majorModeName;
  }
  return bufferMajorModeName(buffer, keyword);
}

/** Whether math-preview-mode is on for BUFFER. The mirror carries no
 *  minor-mode list, so in server mode the server pushes a boolean flag
 *  (`buffer.mathPreviewActive`); prefer it when present, else walk the
 *  buffer's own minor-mode list (the flag-off path). */
function resolvedMathPreviewActive(buffer, mode) {
  if (buffer && typeof buffer.mathPreviewActive === 'boolean') {
    return buffer.mathPreviewActive;
  }
  return isMathPreviewActive(buffer, mode);
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
  if (!buffer || !resolvedMathPreviewActive(buffer, mode)) {
    // Mode off (or no buffer): drop any idle controller and show source.
    disposeMathPreviewForLeaf(leaf);
    return [];
  }
  // Pick the scanner provider by the buffer's major mode. No provider
  // (a mode without math support) → show source, no controller.
  const provider = mathPreviewProviderForMode(resolvedMajorModeName(buffer));
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
        const p = mathPreviewProviderForMode(resolvedMajorModeName(buf));
        return p ? p.scan(text) : provider.scan(text);
      },
      // The buffer's own macro definitions (JMarkdown's `Math macros:`
      // header), prepended to every typeset segment. Resolved fresh per
      // update, like the scanner.
      preamble: (text) => {
        const v = peeledTextView();
        const buf = v ? v.buffer : null;
        const p = mathPreviewProviderForMode(resolvedMajorModeName(buf));
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
  // Live math tooltip: show/refresh/hide it for the construct under point.
  driveMathTooltip(leaf, controller, provider, view);
  return controller.ranges();
}

/** Drop the math-preview controller bound to LEAF, if any. Releases its
 *  typeset cache. Safe to call when none exists. */
function disposeMathPreviewForLeaf(leaf) {
  mathPreviewByPaneId.delete(leaf.id);
  hideMathTooltipForLeaf(leaf);
}

// --- the live math tooltip (math-preview-mode) -------------------------
// When the cursor sits inside a math construct, its source is revealed for
// editing; this floats a tooltip above the caret showing the live MathJax
// render of the body, refreshed on each render. A parse error keeps the last
// valid image plus an error badge; leaving the construct hides it. Renderer
// -only (MathJax + DOM); the typeset + caret rect are read one frame after
// the edit, so positioning reflects the just-painted caret.
let mathTooltip = null;
/** The leaf id whose construct-under-point currently drives the tooltip. */
let mathTooltipOwner = null;
/** The state captured for the next animation frame, or null. */
let mathTooltipPending = null;
let mathTooltipRaf = 0;

function ensureMathTooltip() {
  if (!mathTooltip) mathTooltip = createMathTooltip(editorHostEl);
  return mathTooltip;
}

function flushMathTooltip() {
  mathTooltipRaf = 0;
  const pending = mathTooltipPending;
  mathTooltipPending = null;
  if (!pending) return;
  const tip = ensureMathTooltip();
  if (pending.hide) {
    tip.hide();
    return;
  }
  // Typeset the current body now (synchronous). MathJax 3 renders a TeX
  // syntax error as an error node rather than throwing, so also treat an
  // error node (and the not-ready case) as "no new render" — the tooltip then
  // keeps the last valid image and flags the syntax error.
  const raw = isMathJaxReady()
    ? typesetMath(pending.tex, { display: pending.display })
    : null;
  const node = raw && !isMathErrorNode(raw) ? raw : null;
  // Anchor the tooltip INSIDE the editor's scrolling content so it rides the
  // native scroll (no JS-tracking lag), positioned in content coordinates
  // above the caret.
  const instance =
    typeof pending.instanceEl === 'function' ? pending.instanceEl() : null;
  const q = (sel) =>
    instance && typeof instance.querySelector === 'function'
      ? instance.querySelector(sel)
      : null;
  const contentEl = q('.editor-content');
  const caret = q('.editor-cursor');
  const caretRect =
    caret && typeof caret.getBoundingClientRect === 'function'
      ? caret.getBoundingClientRect()
      : null;
  const contentRect =
    contentEl && typeof contentEl.getBoundingClientRect === 'function'
      ? contentEl.getBoundingClientRect()
      : null;
  if (contentEl) tip.mount(contentEl);
  tip.update({
    node,
    key: pending.key,
    display: pending.display,
    scale: pending.scale,
    caretRect,
    contentRect,
  });
}

function scheduleMathTooltip(state) {
  mathTooltipPending = state;
  if (!mathTooltipRaf) mathTooltipRaf = requestAnimationFrame(flushMathTooltip);
}

/** Show/refresh/hide the live tooltip for LEAF from its controller's
 *  segment-under-point. Called from getMathReplacedRanges after update(). */
function driveMathTooltip(leaf, controller, provider, view) {
  const seg = controller.currentSegment();
  if (seg && view && view.buffer) {
    const text = view.buffer.text;
    let preamble = '';
    try {
      const harvest = provider && provider.preamble;
      preamble = typeof harvest === 'function' ? harvest(text) || '' : '';
    } catch {
      preamble = '';
    }
    const tex = preamble === '' ? seg.body : `${preamble}\n${seg.body}`;
    // *math-tooltip-scale* defcustom (pushed via the config snapshot).
    const scale = Number(rendererConfig['*math-tooltip-scale*']) || 1.5;
    mathTooltipOwner = leaf.id;
    scheduleMathTooltip({
      key: seg.start,
      tex,
      display: seg.kind === 'block',
      scale,
      instanceEl: () => leaf.element ?? editorViewByPaneId.get(leaf.id) ?? null,
    });
  } else if (mathTooltipOwner === leaf.id) {
    mathTooltipOwner = null;
    scheduleMathTooltip({ hide: true });
  }
}

/** Hide the tooltip if LEAF currently owns it (mode off / leaf gone). */
function hideMathTooltipForLeaf(leaf) {
  if (mathTooltipOwner === leaf.id) {
    mathTooltipOwner = null;
    if (mathTooltip) scheduleMathTooltip({ hide: true });
  }
}


/** The `onKey` configure option for a leaf's `<text-view>` (Model B). A
 *  per-keystroke router, because `TextView.configure()` cannot re-run after
 *  mount yet a leaf may become server-backed *after* its element was built. The
 *  closure decides live: a server-backed leaf sends the key to the server's
 *  keymap (auto-pair / chords / self-insert all resolve server-side); a
 *  non-server-backed leaf returns false so the key falls through to the global
 *  router (which routes it to the server too). The in-renderer dispatch the
 *  flag-off path used here is gone with the interpreter (B7). */
function serverViewKeyOption(instance) {
  return {
    onKey: (key) => {
      const v = peelTabline(instance._boundLeaf.view);
      return (isServerBackedView(v) && serverViewClient)
        ? serverViewClient.dispatchKey(key)
        : false;
    },
  };
}

/** The `onKey` for a NON-TEXT element-view (image/audio/video/pdf) that routes a
 *  chord (C-x C-f, M-x, C-x b…) typed while a media view is focused to the
 *  SERVER's keymap — else it would be swallowed before the window-level router
 *  sees it. serverViewClient is resolved at key-press time (it's null when the
 *  singletons are configured at boot). */
function serverMediaKeyOption() {
  return { onKey: (key) => (serverViewClient ? serverViewClient.dispatchKey(key) : false) };
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
      return resolvedMajorModeName(buf);
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
// The customize MODEL is computed server-side and pushed in the leaf state
// (B2.3 — the view renders from v.model); these functions only route the
// view's callbacks back to the spine (propagateCustomize -> CUSTOMIZE_CHANGED).

// applyCurrentTheme / applyCurrentFaceStyles were reload-stdlib-only (they read
// the theme/face maps from the renderer interpreter). The spine is authoritative
// for theme + faces now (the theme-apply / faces-apply directives drive :root +
// themeListeners), so they died with the interpreter — B7.

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

// B2.2b/B2.3 (plans/MODEL-B-DEFAULT.md): the spine is the SOLE applier + render
// driver + persister + MODEL computer for customize. Each edit below sends a
// CUSTOMIZE_CHANGED intent (propagateCustomize) and nothing else — the spine
// applies it to its interpreter, persists custom.lisp / faces.json, pushes the
// resulting chrome (theme / faces / highlight / css-knobs) to EVERY window, and
// re-pushes the refreshed customize MODEL so the panel re-renders. The renderer
// makes ZERO interpreter calls for customize now. Values ride as Lisp SOURCE
// strings (writeString): a :choice value is a string the spine re-symbolises by
// type (custom-apply! -> -coerce-for-type), so nothing raw-Lisp crosses the wire.

/** Apply a setting for the session. */
function applyCustomSetting(name, value) {
  propagateCustomize({ op: 'apply', name, valueSrc: writeString(value) });
}

/** Apply a setting and persist it (the spine persists). */
function saveCustomSetting(name, value) {
  propagateCustomize({ op: 'save', name, valueSrc: writeString(value) });
}

/** Reset a setting to its default value. */
function resetCustomSetting(name) {
  propagateCustomize({ op: 'reset', name });
}

/** Apply a face-attribute change from the customize view. The widget passes
 *  strings/booleans; the spine's set-face-attribute-by-strings coerces. */
function setFaceFromView(faceName, attr, value) {
  const valueSrc =
    typeof value === 'boolean'
      ? (value ? 'true' : 'false')
      : writeString(String(value));
  // `face` + `attr` are strings (set-face-attribute-by-STRINGS), so they ride the
  // wire fine; `valueSrc` is the already-built Lisp source (booleans → true/false).
  propagateCustomize({ op: 'set-face', face: faceName, attr, valueSrc });
}

/** Reset a face — drop the global override. */
function resetFaceFromView(faceName) {
  propagateCustomize({ op: 'reset-face', face: faceName });
}

/** Send a customize change to the spine (CUSTOMIZE_CHANGED). The spine applies +
 *  persists + pushes chrome to every window (see the block comment above). A
 *  no-op when no server is connected. */
function propagateCustomize(change) {
  if (serverViewClient && typeof serverViewClient.customizeChanged === 'function') {
    serverViewClient.customizeChanged(change);
  }
}

/** Open a customisation buffer for a scope — a subgroup, a variable,
 *  or a single face. */
function openCustomScope(scope) {
  // Server mode: the customize leaf is server-owned — ask the spine to open the
  // scope's leaf (CUSTOMIZE_OP); it switches this client + the view re-renders.
  if (serverViewClient) {
    serverViewClient.customizeOp(scope);
    return;
  }
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
    ...serverMediaKeyOption(),
    // B2.3: no getModel — the model is server-computed and pushed in the leaf
    // state (v.model); the view renders from it.
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
    ...serverMediaKeyOption(),
    // View-close is server-driven now (the in-renderer kill-view was inert).
    closeBuffer: () => {},
    // B4: the doc-view OWNS its content + navigation via these — it fetches a
    // built page (readPage) or renders a live docstring (renderMarkdown) and
    // setBuffers itself, regardless of how it was mounted (leaf vs tabline child).
    // So a TOC click / Next-Prev navigates in place, and the initial page fills
    // itself. `openDoc` stays only as a no-readPage fallback.
    readPage: (name) =>
      window.host.readDocPage(name).then((page) => (page ? page.html : null)),
    renderMarkdown: (src) => renderMarkdownHtml(src),
    openDoc: (name) => openDocInPane(name),
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
  if (!buffer || typeof buffer.filePath !== 'string') {
    return { ok: false, error: 'no audio buffer' };
  }
  const snapshot = audioView.pauseAndRelease();
  try {
    // Apply the tag edit directly via the host writer (it's pure host I/O — no
    // buffer state — so it works without the interpreter). `set` adds/updates
    // the field; `remove` deletes it. (Was dispatched through the idle renderer
    // interpreter; the set-/remove-audio-metadata! primitives are now dead and
    // drop with the primitive table in B7.)
    applyAudioMetadataEdit(buffer.filePath, (fields) => {
      if (primitiveName === 'remove-audio-metadata!') {
        delete fields[key];
      } else {
        fields[key] = value === undefined ? '' : String(value);
      }
    });
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
    // View-close is server-driven now (the in-renderer kill-view was inert).
    closeBuffer: () => {},
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
    // View-close is server-driven now (the in-renderer kill-view was inert).
    closeBuffer: () => {},
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
    // source. The pdf-view hands us the 1-based page, the clicked PDF point
    // (SyncTeX convention), and the clicked PDF's own path. The SPINE runs
    // `synctex edit` and reveals the resulting file:line in a source pane —
    // the renderer interpreter's pane model is idle in server mode, so the
    // old `interpreter.call('latex-synctex-inverse', …)` here no-op'd.
    onSyncTexClick: (page, x, y, filePath) => {
      if (serverViewClient) serverViewClient.synctexInverse(filePath, page, x, y);
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
    ...serverMediaKeyOption(),
    defaultUrl: 'about:blank',
    partition: 'persist:browser-views',
    // Page title updates flow through here so the modeline + tabline
    // pick up the page's <title> as the view's label.
    onTitleChanged: () => notifyViewsChanged(),
    // A navigation (link / URL bar / in-page route) reports the new URL UP so
    // the server's browser data-source tracks the current page (session-restore
    // reopens where the user browsed to, not the URL it was first opened at).
    onNavigate: (view, url) => {
      const id = view && view._serverBufferId;
      if (id && serverViewClient && typeof serverViewClient.browserNavigated === 'function') {
        serverViewClient.browserNavigated(id, url);
      }
    },
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
    // Drop the editor's cursor at the END of document LINE (a minimap CLICK —
    // the line the minimap highlights under the pointer). Server mode: the
    // mirror's moveTo echoes locally + sends a `point` intent so the server
    // moves the focused leaf's cursor; flag-off: it moves the buffer's cursor
    // directly. Tolerant of a missing read surface (a non-text view → no-op).
    moveCursorToLineEnd: (line) => {
      if (!buffer || typeof buffer.moveTo !== 'function'
          || typeof buffer.lineCount !== 'number') return;
      const n = Math.max(0, Math.min(buffer.lineCount - 1, Math.floor(line)));
      let end;
      try {
        const start = buffer.offsetAt(n, 0);
        const info = buffer.lineAt(start);
        end = info && typeof info.text === 'string' ? start + info.text.length : start;
      } catch { return; }
      buffer.moveTo(end);
    },
  };
}

/** The per-instance live-process element (`<gnuplot-view>` etc.) bound to CONTENT
 *  in LEAF — a bare-leaf element (procViewElementByView) or a tabline tab (the
 *  tabline's editorByChild). Null when none is mounted yet. */
function procViewElementFor(content, leaf) {
  if (procViewElementByView.has(content)) return procViewElementByView.get(content);
  if (isTablineView(leaf.view)) {
    const st = tablineStateByView.get(leaf.view);
    if (st && st.editorByChild) return st.editorByChild.get(content) ?? null;
  }
  return null;
}

/** Build a `kind:'plots'` minimap adapter over a live `<gnuplot-view>` element:
 *  the minimap reads its rendered plots, re-renders when a new one lands, and a
 *  thumbnail click jumps the gnuplot transcript to that plot. */
function buildGnuplotMinimapAdapter(gnuplotEl) {
  return {
    kind: 'plots',
    getPlots: () =>
      typeof gnuplotEl.getPlots === 'function' ? gnuplotEl.getPlots() : [],
    onChange: (cb) =>
      typeof gnuplotEl.onPlotsChange === 'function' ? gnuplotEl.onPlotsChange(cb) : () => {},
    scrollToPlot: (id) => {
      if (typeof gnuplotEl.scrollToPlot === 'function') gnuplotEl.scrollToPlot(id);
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
  // A GNUPLOT target: bind a plots adapter so the minimap shows a strip of plot
  // thumbnails (a click jumps the transcript to that plot). Falls back to "not
  // supported" until the gnuplot element is mounted.
  if (content && content.kind === 'gnuplot') {
    const gpEl = procViewElementFor(content, leaf);
    el.bindTarget(
      gpEl && typeof gpEl.getPlots === 'function'
        ? buildGnuplotMinimapAdapter(gpEl)
        : null
    );
    return;
  }
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
  // Server mode (Model B): the SERVER owns the pane layout — the minimap is a
  // companion leaf in the server pane model, toggled by the `toggle-minimap`
  // server command (M-x toggle-minimap / C-x m). Mutating the local rootPane here
  // would be clobbered by the next PANE_TREE reconcile (and blank the editor —
  // the original bug), so stand down and let the server path drive it.
  if (window.host && window.host.serverMode) return;
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



/** The command names the renderer owns by registering element-views
 *  (`define-element-view`) — the `element-views` registry's keys (built-ins +
 *  any in user config). Server mode announces these so M-x routes them back
 *  down (RUN_CLIENT_COMMAND). Tolerant: [] before the stdlib registers any. */
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
      // Route the insert to the SERVER's active buffer (the document); the server
      // fans the delta back so the document updates. (The in-renderer `(insert! …)`
      // path is gone with the interpreter — B7.)
      if (serverViewClient) serverViewClient.insertText(text);
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

// --- bookmark outline as a per-instance pane view (server mode) ----------
// In server mode each bookmark outline owns its OWN <bookmark-view> element
// (keyed by its source view object), so two outlines can render in one window —
// a vertical split with two files, each its own outline. The flag-off app keeps
// the single shared `bookmarkView` singleton (mounted via the singleton path in
// mountKindView); only `_serverMedia` bookmark views route to the per-instance
// path. Mirrors ensureElementHostForView / the browser + doc per-instance views.
const bookmarkElementByView = new Map();

/** The <bookmark-view> element for a SERVER-mode outline VIEW — created
 *  (configured + mounted in PANE-EL) on first use, then reused and re-pointed. */
function ensureBookmarkElementForView(view, paneEl) {
  let el = bookmarkElementByView.get(view);
  if (el) {
    if (paneEl && el.parentNode !== paneEl) paneEl.append(el);
    el.setBuffer(view); // re-render with the (possibly re-targeted) records
    return el;
  }
  el = /** @type {*} */ (document.createElement('bookmark-view'));
  el.configure(configureBookmarkView());
  el.setBuffer(view);
  if (paneEl) paneEl.append(el);
  bookmarkElementByView.set(view, el);
  return el;
}

/** Tear down the per-instance <bookmark-view> bound to VIEW (its source closed). */
function disposeBookmarkElementForView(view) {
  const el = bookmarkElementByView.get(view);
  if (!el) return;
  try { el.destroy(); } catch { /* already gone */ }
  el.remove();
  bookmarkElementByView.delete(view);
}

// --- live-process views (shell + gnuplot) as per-instance pane views (server) ---
// In server mode each live-process data-source (a shell or a gnuplot) owns its
// OWN element (<shell-view> / <gnuplot-view>) — its own child process + view — so
// several render in one window (a split, or a bottom tabline of process tabs).
// The flag-off app keeps the single shared singletons; only `_serverMedia` views
// route to this per-instance path. Mirrors ensureBookmarkElementForView / the
// browser + doc views. CRUCIAL: the element is hide-not-kill (a switch-away/split
// hides it, never destroys it) so the running process + view state survive; it is
// reaped only by disposeProcViewElement when the data-source is actually closed.
const PROC_VIEW_KINDS = new Set(['shell', 'gnuplot']);
const isProcViewKind = (kind) => PROC_VIEW_KINDS.has(kind);
const procViewElementByView = new Map();

/** The per-instance element for a SERVER-mode live-process VIEW (shell/gnuplot)
 *  — created (configured + mounted in PANE-EL) on first use, then reused and
 *  re-parented. The child spawns lazily on the element's first setBuffer (when
 *  `view.spawned` is false); a reused element with `view.spawned` already true
 *  just re-attaches to the still-running session. */
function ensureProcViewElement(view, paneEl) {
  let el = procViewElementByView.get(view);
  if (el) {
    // Reuse: re-parent only. Do NOT call setBuffer again — the element is already
    // bound and its child is live. In server mode a process leaf re-mounts on
    // EVERY reconcile, and a redundant setBuffer re-enters the view's async build
    // (e.g. shell-view's ensureTerminal, whose `if (term) return` guard can't hold
    // against calls racing before the first `await fonts.ready`) → a second
    // instance + a double-spawn, leaving the visible view orphaned. Re-parenting
    // (a DOM move) fires only the no-op disconnected/connected callbacks.
    if (paneEl && el.parentNode !== paneEl) paneEl.append(el);
    return el;
  }
  const factory = perKindConfigureFactory(view.kind); // configureShellView / configureGnuplotView
  el = /** @type {*} */ (document.createElement(`${view.kind}-view`));
  if (factory) el.configure(factory());
  el.setBuffer(view); // first bind: spawns the child lazily (view.spawned → true)
  if (paneEl) paneEl.append(el);
  procViewElementByView.set(view, el);
  return el;
}

/** Show leaf-direct process elements whose view is active; hide the rest (do NOT
 *  destroy — the child + view state stay alive). Tabline process tabs manage
 *  their own visibility via mountTablineActiveChild. Called from
 *  hideInactiveSingletons. */
function hideInactiveProcViews() {
  const active = new Set();
  for (const leaf of leafPanes(rootPane)) {
    if (!isTablineView(leaf.view) && leaf.view && isProcViewKind(leaf.view.kind)) {
      active.add(leaf.view);
    }
  }
  for (const [view, el] of procViewElementByView) {
    el.style.display = active.has(view) ? '' : 'none';
  }
}

/** Tear down the per-instance element bound to VIEW and reap its child (its
 *  data-source was closed). The element's destroy() does NOT kill the child;
 *  disposeKindView dispatches the right kill (shellKill / gnuplotKill). */
function disposeProcViewElement(view) {
  const el = procViewElementByView.get(view);
  if (!el) return;
  try { el.destroy(); } catch { /* already gone */ } // view dispose + IPC unsubscribe
  el.remove();
  procViewElementByView.delete(view);
  // Reap the child in MAIN (the renderer-side destroy() above does NOT kill it).
  try { disposeKindView(view); } catch { /* process already gone */ }
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
  return {
    // onKey routes chords to the server's keymap (so C-x C-f / M-x reach it).
    ...serverMediaKeyOption(),
    listDirectory: (path) => window.host.listDirectoryDetailedSync(path),
    // Colour file/folder icons from the vendored Material Icon Theme set.
    iconUrlFor: (name, isDirectory, expanded) =>
      materialIconUrlForEntry(name, isDirectory, expanded),
    openPath: (path, targetPaneId) => {
      // Open the file by path through the server's find-file (visitFile). The
      // dir-tree passes its wired `openTargetPaneId` (the project's editing
      // tabline, computed by reapplyProjectDirTreeTarget) so the file lands
      // THERE, not in the tree's own focused pane. Falls back to the focused
      // leaf when no target is wired (a standalone directory-tree).
      if (serverViewClient) serverViewClient.visitPath(path, targetPaneId);
    },
    closeBuffer: () => {
      // Closing a directory pane isn't wired server-side yet (follow-on); the
      // pane is replaced when a file is opened from it.
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
    ...serverMediaKeyOption(),
    // Server-owned: the renderer interpreter's chord state is always empty in
    // server mode (keys route to the spine), so a chord is never "in progress"
    // here.
    chordPending: () => false,
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
    ...serverMediaKeyOption(),
    // Server-owned: the renderer interpreter's chord state is always empty in
    // server mode (keys route to the spine), so a chord is never "in progress"
    // here.
    chordPending: () => false,
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
    ...serverMediaKeyOption(),
    cloneEnabled: !!origin(),
    cloneLabel: placeholderCloneLabel(origin()),
    defaultAction: () => {
      // `*placeholder-default-action*` was a renderer-interpreter customvar; the
      // server-mode placeholder chooser doesn't surface (a split shows the shared
      // buffer), so this resolves to the JS default. (Interpreter gone — B7.)
      return resolvePlaceholderAction(null);
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
  return {
    // onKey routes to the server's keymap.
    ...serverMediaKeyOption(),
    listDirectory: (path) => window.host.listDirectoryDetailedSync(path),
    getPreview: (path) => buildColumnPreview(path),
    // Same tree-sitter highlighter registry the editor uses, so the
    // preview pane colourises the file the same way as if it were open.
    highlighters,
    openPath: (path) => {
      // Open by path through the server's find-file (visitFile).
      if (serverViewClient) serverViewClient.visitPath(path);
    },
    onRevealInFolder: (path) => window.host.revealInFolder(path),
    onTrash: (path) => window.host.trashFile(path),
    onRename: (path, newName) => {
      const slash = path.lastIndexOf('/');
      const parent = slash >= 0 ? path.slice(0, slash) : '';
      const to = parent === '' ? newName : `${parent}/${newName}`;
      return window.host.renameFile(path, to);
    },
    // Closing a directory pane isn't wired server-side yet (the pane is
    // replaced when a file opens from it).
    closeBuffer: () => {},
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
    ...serverMediaKeyOption(),
    // While a chord is mid-flight (C-x just pressed) the outline must
    // forward the *next* key — even a plain one like the `0` of `C-x 0`
    // — to the keymap instead of swallowing it; otherwise focus is
    // trapped in the outline and prefix chords (C-x 0/1/2/b/p …) die.
    // Server-owned: the renderer interpreter's chord state is always empty in
    // server mode (keys route to the spine), so a chord is never "in progress"
    // here.
    chordPending: () => false,
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
    // Server-owned: the renderer interpreter's chord state is always empty in
    // server mode (keys route to the spine), so a chord is never "in progress"
    // here.
    chordPending: () => false,
    exportSvg: (svg, name) =>
      window.host && typeof window.host.gnuplotSaveSvg === 'function'
        ? window.host.gnuplotSaveSvg(svg, name)
        : Promise.resolve(null),
    setTheme: (sessionId, theme) =>
      window.host && typeof window.host.gnuplotSetTheme === 'function'
        ? window.host.gnuplotSetTheme(sessionId, theme)
        : Promise.resolve({ ok: false }),
    ...serverMediaKeyOption(),
  };
}
const gnuplotView = /** @type {*} */ (document.createElement('gnuplot-view'));
gnuplotView.configure(configureGnuplotView());
editorPaneElement().append(gnuplotView);
gnuplotView.style.display = 'none';
themeListeners.add(() => gnuplotView.applyTheme());

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
      // B4: wire the overlay managers to THIS server-backed editor so inline-eval
      // pills + sticky-note overlays render on it. The non-server branch below
      // does this, but server-backed views early-return — so under Model B the
      // overlays were never bound to any editor. Guarded: stickyNotes / inlineEval
      // are module-level consts declared LATER, so a mount during the initial
      // paint would hit their TDZ (the app.js init-TDZ trap); a later reconcile
      // re-mount wires them once they exist.
      if (instance.overlayLayer) {
        try {
          stickyNotes.setOverlayLayer(instance.overlayLayer);
          inlineEval.setOverlayLayer(instance.overlayLayer);
        } catch { /* declared later — a reconcile re-mount binds them */ }
      }
      // The hover-doc tooltip listens on the ACTIVE `<text-view>`; re-point it
      // here (same per-instance problem as inline-eval's overlay). Without this
      // the listeners stay on whatever element existed when createHoverDoc ran —
      // often NOT the server-mounted view — so hover never fires. TDZ-guarded:
      // hoverDoc is a module const declared later, bound by a reconcile re-mount.
      try { hoverDoc.setEditorEl(instance); } catch { /* declared later */ }
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
  if (editorView && typeof editorView.focus === 'function') editorView.focus();
  // The mode menu rides the server's VIEW push (applyServerModeMenu) on a buffer
  // switch — no local recompute.
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
    // Per-instance: mount THIS view's own browser element in its pane. Honor the
    // focus context — a non-focused browser re-mounting on a fan-out reconcile
    // must not yank the keyboard into its <webview> (same rule as proc/bookmark).
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    const paneEl = (context && context.paneEl) || (leaf ? paneElements.get(leaf.id) : null);
    const el = ensureBrowserElementForView(view, paneEl);
    el.style.display = '';
    if (!context || context.focus !== false) el.focus();
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
  if (view.kind === 'bookmark' && view._serverMedia) {
    // Per-instance in SERVER mode (the flag-off outline stays the singleton
    // below): each outline owns its own <bookmark-view>, so two can coexist in
    // one window. Honor the focus context — a non-focused outline re-mounting on
    // a fan-out must not steal focus from the document (same rule as the
    // singleton path; see the bare-media reconcile branch).
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    const paneEl = (context && context.paneEl) || (leaf ? paneElements.get(leaf.id) : null);
    const el = ensureBookmarkElementForView(view, paneEl);
    el.style.display = '';
    if (!context || context.focus !== false) el.focus();
    return;
  }
  if (isProcViewKind(view.kind) && view._serverMedia) {
    // Per-instance in SERVER mode (flag-off keeps the singleton below): each
    // live-process view (shell/gnuplot) owns its own element + child, so several
    // render at once (a split, or — via mountTablineActiveChild, which routes
    // here too — a bottom tabline of process tabs). Honor the focus context: a
    // re-mount on a reconcile must not steal focus from the document.
    const leaf = leafPanes(rootPane).find((l) => l.view === view);
    const paneEl = (context && context.paneEl) || (leaf ? paneElements.get(leaf.id) : null);
    const el = ensureProcViewElement(view, paneEl);
    el.style.display = '';
    if (!context || context.focus !== false) el.focus();
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
        // Every tab — the active façade included — carries the wire's
        // bufferId (stamped in buildServerLeafTabline); currentBufferId()
        // is only a fallback, since it can lag the server's re-points.
        const id = target._serverBufferId
          ?? (target === serverFacadeView ? serverViewClient.currentBufferId() : null);
        if (!id) return;
        serverViewClient.sendPaneIntent({ op: 'focus-pane', paneId: view._serverLeafId });
        serverViewClient.sendPaneIntent({ op: 'close-tab', paneId: view._serverLeafId, bufferId: id });
        return;
      }
      const target = view.tabs[i];
      if (!target) return;
      // In server mode a tab can back a SERVER buffer (a server text leaf shown
      // through a renderer tab strip, or the live façade) that is NOT in the
      // global `views` array — so `views.indexOf` is -1 and the renderer-only
      // `removeTabInTabline` below would drop the tab while the buffer lives on
      // in the spine (visible in C-x C-b). Kill it server-side instead (switch +
      // C-x k, which re-homes the client onto a survivor and re-pushes the list).
      if (serverViewClient) {
        const serverId = target === serverFacadeView
          ? serverViewClient.currentBufferId()
          : target._serverBufferId;
        if (serverId) { serverViewClient.closeBuffer(serverId); return; }
      }
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
    case 'customize':         return configureCustomizeView;
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
    // from the mirror; its major-mode name + math-preview-active flag are
    // server-pushed onto the mirror too (read via resolvedMajorModeName /
    // getMathReplacedRanges below). Every other tab keeps the in-renderer
    // wiring exactly as before.
    const serverBacked = isServerBackedView(child);
    el = /** @type {*} */ (document.createElement('text-view'));
    el.configure({
      ...(serverBacked
        ? { onKey: (key) => (serverViewClient ? serverViewClient.dispatchKey(key) : false) }
        : {}),
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
      // own element for the MathJax-startup re-render. getMathReplacedRanges
      // is server-aware: for a server-backed tab it reads the mode state
      // (major-mode name + active flag) the server pushed onto the mirror.
      getReplacedRanges: () => getMathReplacedRanges({ id: child, view: child, element: el }),
      getMajorModeName: () => resolvedMajorModeName(child.buffer ?? null),
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
    // Skip TEXT (its editor measures the container bounding box, which is zero
    // under display:none) AND LIVE-PROCESS views (shell's xterm measures its host
    // the same way at term.open; gnuplot likewise — eager creation in a hidden/
    // unsized content area leaves it mis-rendered even though the child spawns).
    // These are created LAZILY on activation below, when the content is sized.
    if (tab.kind !== 'text' && !isProcViewKind(tab.kind)) ensureTabElement(state, tab);
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
  //
  // A SHELL tab is created LAZILY here (it's excluded from the eager loop
  // above): ensureTabElement now, while the content area is visible + sized, so
  // the xterm's term.open() measures a real box. Set display:'' explicitly (the
  // display loop above only iterates already-created elements). Mirrors the text
  // branch. Other non-text kinds were created eagerly and already in the map.
  const activeEl = ensureTabElement(state, child);
  if (activeEl) activeEl.style.display = '';
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
  if (view.kind === 'bookmark' && bookmarkElementByView.has(view)) {
    return bookmarkElementByView.get(view);
  }
  return singletonElementForKind(view.kind);
}

/** Invoke a hosted-element callback (a plain JS function) with the given
 *  arguments; errors land in the REPL under PRIMNAME so an async result
 *  delivery can't crash the surrounding event. The Lisp-callback path (a
 *  Sym/procedure run through the renderer interpreter) is gone with the
 *  interpreter — B7; element on-ready callbacks are plain JS now, and a
 *  non-function callback is a no-op. */
function deliverLispCallback(callback, callArgs, primName) {
  if (typeof callback !== 'function') return;
  try {
    callback(...callArgs);
  } catch (error) {
    repl.appendError(`${primName} callback: ${error?.message ?? error}`);
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
  // Resolve the symbol + doc summary on the SPINE (docs.lisp, against the LIVE
  // active buffer) — the renderer interpreter's buffer is idle in server mode, so
  // the old `(symbol-at-offset (buffer-text) …)` there saw an empty buffer and the
  // tooltip never resolved. The Markdown preview is rendered here (the renderer
  // owns `renderMarkdown`); the spine returns the raw docstring source.
  resolveHover: async (offset) => {
    if (!serverViewClient) return null;
    const r = await serverViewClient.requestDocHover(offset);
    if (!r || typeof r.name !== 'string' || r.name === '') return null;
    if (r.kind === 'manifest') {
      return { symbol: r.name, summary: { kind: 'manifest', name: r.name } };
    }
    if (r.kind === 'live') {
      let preview = '';
      try {
        preview = renderMarkdown((r.source ?? '').slice(0, 320));
      } catch {
        preview = '';
      }
      return { symbol: r.name, summary: { kind: 'live', name: r.name, preview } };
    }
    return null;
  },
  openDoc: (name) => {
    if (serverViewClient) serverViewClient.docOpen(name);
  },
});

/** Inline-evaluation overlay — the pill that pops next to a Lisp
 *  form when the user evaluates it (`C-x C-e`, `C-RET`). */
const inlineEval = createInlineEval({
  overlayLayer: editorView.overlayLayer,
  getBuffer: () => currentTextBuffer,
});


// The Markdown renderer used for sticky notes and the live-docstring
// path in the doc-view. Driven by the `*markdown-interpreter*` Lisp
// variable: the magic value `"marked"` selects the bundled marked.js
// library; any other string is a shell command that reads Markdown
// on stdin and prints HTML on stdout.
const DEFAULT_MARKDOWN_INTERPRETER = 'marked';

/** The current `*markdown-interpreter*` setting, from the config cache,
 *  falling back to the default if the value is empty. */
function currentMarkdownInterpreter() {
  const value = rendererConfig['*markdown-interpreter*'];
  if (typeof value === 'string' && value.trim() !== '') return value;
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
  // B4: under Model B the server owns the file + its sidecar, so ship note changes
  // up (NOTES_CHANGED → spine.setBufferNotes → persist) instead of writing
  // render-side (the mirror has no filePath). Flag-off, the old renderer write.
  onChange: () => {
    if (serverViewClient && typeof serverViewClient.notesChanged === 'function') {
      serverViewClient.notesChanged(
        currentTextBuffer && currentTextBuffer.metadata
          ? currentTextBuffer.metadata.notes
          : []
      );
    } else {
      scheduleMetadataWrite(currentTextBuffer);
    }
  },
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
// A toggleable pane (markdown-preview, C-c v) that shows the current
// Markdown / JMarkdown FILE rendered by the real `jmarkdown watch` server
// (apps/desktop/src/jmarkdown-watch.js) inside an iframe — the same pipeline
// the book build uses, live-reloading (morphdom) on each save. The renderer
// owns only the pane + the iframe's `src`; the rendering, CSS, and MathJax all
// come from the watch server's output, so there is no in-app render path here.
// The preview tracks the SAVED file, so it refreshes when the buffer is saved
// (C-x C-s), not per keystroke; an unsaved / path-less buffer has nothing to
// watch.

/** Build an `app://editor/__host__/…` URL for an absolute file path —
 *  the renderer-side mirror of serve.js's `hostFileUrl` (keep in sync).
 *  Serves any local file same-origin (e.g. resolving a bibliography that
 *  lives outside an opened folder). */
function hostFileUrl(filePath) {
  return (
    'app://editor/__host__' +
    filePath.split('/').map(encodeURIComponent).join('/')
  );
}

/** Build the `__host__` URL for an absolute PATH *and* vouch for its directory
 *  in the serve allowlist — else the `app://editor/__host__` route 403s the
 *  fetch (e.g. a bib symlinked outside an opened folder). Mirrors the
 *  `host-file-url` primitive; shared by it and the plain-JS bib-search dispatch
 *  (L4), which must NOT skip the allowlisting the way the bare builder does. */
function vouchHostFileUrl(filePath) {
  try {
    if (window.host && typeof window.host.allowHostFile === 'function') {
      window.host.allowHostFile(filePath);
    }
  } catch { /* ignore — fall through to the URL */ }
  return hostFileUrl(filePath);
}

// The preview pane DOM: a header + an iframe inside #markdown-preview-host.
// The CSS classes (.markdown-preview / -header / -frame, and the
// body.markdown-preview-hidden toggle) are shared with the old in-app pane, so
// styles.css needs no change. The iframe's `src` points at the watch server.
const markdownPreviewPane = document.createElement('div');
markdownPreviewPane.className = 'markdown-preview';

// Header: a "PREVIEW" label + the file name on the left, action buttons (pop
// out, close) on the right.
const markdownPreviewHeader = document.createElement('div');
markdownPreviewHeader.className = 'markdown-preview-header';
const markdownPreviewTitle = document.createElement('span');
markdownPreviewTitle.className = 'markdown-preview-title';
markdownPreviewTitle.textContent = 'Preview';
const markdownPreviewFilename = document.createElement('span');
markdownPreviewFilename.className = 'markdown-preview-filename';
markdownPreviewTitle.append(' ', markdownPreviewFilename);

const markdownPreviewActions = document.createElement('span');
markdownPreviewActions.className = 'markdown-preview-actions';
const markdownPreviewPopoutBtn = document.createElement('button');
markdownPreviewPopoutBtn.className = 'markdown-preview-btn';
markdownPreviewPopoutBtn.title = 'Open the preview in its own window';
markdownPreviewPopoutBtn.setAttribute('aria-label', 'Pop out preview');
markdownPreviewPopoutBtn.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"></i>';
const markdownPreviewCloseBtn = document.createElement('button');
markdownPreviewCloseBtn.className = 'markdown-preview-btn markdown-preview-close';
markdownPreviewCloseBtn.title = 'Close the preview (stops the watch process)';
markdownPreviewCloseBtn.setAttribute('aria-label', 'Close preview');
markdownPreviewCloseBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
markdownPreviewActions.append(markdownPreviewPopoutBtn, markdownPreviewCloseBtn);
markdownPreviewHeader.append(markdownPreviewTitle, markdownPreviewActions);

const markdownPreviewFrame = document.createElement('iframe');
markdownPreviewFrame.className = 'markdown-preview-frame';
markdownPreviewPane.append(markdownPreviewHeader, markdownPreviewFrame);
document.getElementById('markdown-preview-host').append(markdownPreviewPane);

markdownPreviewPopoutBtn.addEventListener('click', () => {
  popOutMarkdownPreview();
  editorView.focus();
});
markdownPreviewCloseBtn.addEventListener('click', () => {
  hideMarkdownPreview();
  editorView.focus();
});

// The pane starts hidden; markdown-preview reveals it.
document.body.classList.add('markdown-preview-hidden');

/** The absolute path of the file the preview is currently watching, or null
 *  when the preview is off. Lets a buffer switch skip a respawn when the new
 *  buffer is backed by the same file. */
let previewWatchedPath = null;
/** The watch server's port while the preview is open (for the pop-out URL). */
let previewPort = null;
/** True while the preview lives in a popped-out window: forward search routes to
 *  it (via main) instead of the in-app iframe, and inverse search arrives back
 *  the same way. Cleared when the popped-out window closes or the in-app preview
 *  is reopened. */
let previewPoppedOut = false;

// --- debounced live preview (save-free refresh on a typing pause) -------
// While the preview is open (in-app OR popped out), edits to the previewed
// buffer are pushed to main after a pause, which rewrites the shadow the watch
// server reads — so the render updates without a save. See jmarkdown-watch.js
// and plans/JMD-LIVE-PREVIEW.md.
/** The real source path the preview was opened on — the sync key. Persists
 *  across a pop-out (unlike previewWatchedPath); null when no preview is live. */
let previewSourcePath = null;
/** The buffer the preview is showing — identified by its stable server buffer
 *  id (the mirror object is rebuilt on every switch, so identity is not stable;
 *  the id is). A sync only fires while this is the focused buffer, so editing a
 *  different buffer never rewrites this shadow. `previewBuffer` is the fallback
 *  identity when there is no server client (id unavailable). */
let previewBuffer = null;
let previewBufferId = null;
/** The pending debounce timer id, or null. */
let previewSyncTimer = null;
/** The text last pushed to the shadow — skips a rewrite when only the cursor
 *  moved (setModeline fires on cursor moves too, not just edits). */
let lastPreviewSyncedText = null;

// --- preview ⇄ source sync (forward / inverse search) ------------------
// The preview iframe is cross-origin (localhost vs app://), so source↔preview
// position sync goes through postMessage with the watch page's injected
// `sync.js` (contract: plans/JMARKDOWN-PREVIEW-SYNC.md). Forward search: when
// the server-pushed cursor line changes, ask the preview to scroll to it.
// Inverse search: a ⌘/Ctrl-click in the preview posts a source line back; we
// move the editor cursor there via a server GOTO_LINE intent (the renderer's
// own buffer mirror can't move the server cursor).
const PREVIEW_SYNC_SOURCE = 'jmarkdown-sync';
const PREVIEW_SYNC_VERSION = 1;
/** The most recent 1-based cursor line the server pushed (for replay on `ready`). */
let lastKnownCursorLine = null;
/** The last line we asked the preview to scroll to (de-dupes per-keystroke posts). */
let lastPostedPreviewLine = null;

/** Post a sync message to the preview iframe. No-op if it isn't mounted. */
function postToPreview(msg) {
  const win = markdownPreviewFrame && markdownPreviewFrame.contentWindow;
  if (!win) return;
  win.postMessage(
    { source: PREVIEW_SYNC_SOURCE, version: PREVIEW_SYNC_VERSION, ...msg },
    '*' // line numbers only; '*' avoids the localhost-port origin dance
  );
}

/** Whether forward search (preview-follows-cursor) is enabled. Reads the
 *  `*markdown-preview-follow-cursor*` value from the config cache (seeded on,
 *  refreshed by the spine's config-snapshot/config-apply pushes). */
function previewFollowCursorOn() {
  return rendererConfig['*markdown-preview-follow-cursor*'] !== false;
}

/** Scroll the preview to `line` — the in-app iframe, or (when detached) the
 *  popped-out window via main. `flash` requests the yellow location flash
 *  (reserved for the explicit C-c C-v sync; auto-follow scrolls silently).
 *  Returns whether a preview was targeted. */
function postPreviewScroll(line, flash) {
  const target = markdownPreviewVisible() ? 'inapp' : (previewPoppedOut ? 'popout' : null);
  if (!target) return false;
  if (target === 'popout') {
    if (window.host && typeof window.host.previewForward === 'function') {
      window.host.previewForward(line, !!flash);
    }
  } else {
    postToPreview({ type: 'scroll-to-line', line, behavior: 'smooth', flash: !!flash });
  }
  return true;
}

/** Auto-follow (preview-follows-cursor on): as the server-pushed cursor line
 *  changes, scroll the preview to it — SILENTLY (no flash). Skips when no
 *  preview is showing, the toggle is off, or the line is unchanged. */
function previewScrollToCursor(line) {
  if (typeof line !== 'number') return;
  lastKnownCursorLine = line;
  if (line === lastPostedPreviewLine) return;
  if (!previewFollowCursorOn()) return;
  lastPostedPreviewLine = line;
  postPreviewScroll(line, false);
}

/** Explicit forward search (C-c C-v): scroll the preview to `line` (or the last
 *  known cursor line) AND flash the spot — regardless of the follow-cursor
 *  toggle. A no-op when no preview is showing. */
function previewSyncToCursor(line) {
  const target = typeof line === 'number' ? line : lastKnownCursorLine;
  if (typeof target !== 'number') return;
  lastKnownCursorLine = target;
  if (postPreviewScroll(target, true)) lastPostedPreviewLine = target;
}

/** Debounce interval for the live preview (ms), from live config; floored so a
 *  misconfigured 0 can't busy-rewrite the shadow. */
function previewDebounceMs() {
  const ms = Number(rendererConfig['*markdown-preview-debounce-ms*']);
  return Number.isFinite(ms) && ms > 0 ? Math.max(50, ms) : 400;
}

/** Whether the previewed buffer is the one currently focused. Prefers the stable
 *  server buffer id; falls back to mirror identity when no client is present. */
function previewBufferIsActive() {
  if (
    previewBufferId !== null &&
    serverViewClient &&
    typeof serverViewClient.currentBufferId === 'function'
  ) {
    return serverViewClient.currentBufferId() === previewBufferId;
  }
  return currentTextBuffer !== null && currentTextBuffer === previewBuffer;
}

/** (Re)arm the debounced preview sync after an edit. Fires only while a preview
 *  is live for the focused buffer, and only when the text actually changed — the
 *  driving `setModeline` push also fires on cursor moves, which must not reset
 *  the edit debounce. Each real edit resets the timer. */
function schedulePreviewSync() {
  if (!previewSourcePath || !previewBufferIsActive()) return;
  if (!currentTextBuffer || currentTextBuffer.text === lastPreviewSyncedText) return;
  if (previewSyncTimer !== null) clearTimeout(previewSyncTimer);
  previewSyncTimer = setTimeout(flushPreviewSync, previewDebounceMs());
}

/** Push the current buffer text to main (which rewrites the preview shadow),
 *  unless nothing changed since the last push. */
function flushPreviewSync() {
  previewSyncTimer = null;
  if (!previewSourcePath || !currentTextBuffer || !previewBufferIsActive()) return;
  const text = currentTextBuffer.text;
  if (typeof text !== 'string' || text === lastPreviewSyncedText) return;
  lastPreviewSyncedText = text;
  if (typeof window.host?.syncJmarkdownWatch === 'function') {
    window.host.syncJmarkdownWatch(previewSourcePath, text);
  }
}

/** Begin live-syncing PATH's preview from the current buffer (called on open).
 *  Seeds `lastPreviewSyncedText` so the first edit — not the open — triggers a
 *  rewrite. Returns the seed text for the initial shadow. */
function beginPreviewSync(path) {
  previewSourcePath = path;
  previewBuffer = currentTextBuffer;
  previewBufferId =
    serverViewClient && typeof serverViewClient.currentBufferId === 'function'
      ? serverViewClient.currentBufferId()
      : null;
  lastPreviewSyncedText = currentTextBuffer ? currentTextBuffer.text : '';
  return lastPreviewSyncedText;
}

/** Stop live-syncing (in-app close or popped-out window closed). */
function clearPreviewSyncState() {
  if (previewSyncTimer !== null) { clearTimeout(previewSyncTimer); previewSyncTimer = null; }
  previewSourcePath = null;
  previewBuffer = null;
  previewBufferId = null;
  lastPreviewSyncedText = null;
}

// Relay from a popped-out preview window (via main): inverse-search clicks and
// the preview's `ready`. Registered once.
if (window.host && typeof window.host.onPreviewUp === 'function') {
  window.host.onPreviewUp((msg) => {
    if (!msg) return;
    if (msg.type === 'ready') {
      // The popped-out preview is up — replay the current cursor line.
      lastPostedPreviewLine = null;
      if (previewPoppedOut && typeof lastKnownCursorLine === 'number') {
        previewScrollToCursor(lastKnownCursorLine);
      }
    } else if (msg.type === 'source-line-click' && typeof msg.line === 'number') {
      if (serverViewClient && typeof serverViewClient.sendGotoLine === 'function') {
        serverViewClient.sendGotoLine(msg.line);
      }
    }
  });
}
if (window.host && typeof window.host.onPreviewPopoutClosed === 'function') {
  window.host.onPreviewPopoutClosed(() => {
    previewPoppedOut = false;
    lastPostedPreviewLine = null;
    clearPreviewSyncState(); // the popped-out preview is gone — stop live-sync
  });
}

// Inverse search + handshake from the preview's sync.js. Registered once;
// filters to the localhost preview origin and our protocol, ignores all else.
window.addEventListener('message', (event) => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(event.origin)) return;
  const d = event.data;
  if (!d || d.source !== PREVIEW_SYNC_SOURCE) return;
  if (d.type === 'ready') {
    // The preview (re)loaded its sync bridge — replay the current cursor line so
    // the view aligns immediately.
    lastPostedPreviewLine = null;
    if (typeof lastKnownCursorLine === 'number') previewScrollToCursor(lastKnownCursorLine);
  } else if (d.type === 'source-line-click' && typeof d.line === 'number') {
    if (serverViewClient && typeof serverViewClient.sendGotoLine === 'function') {
      serverViewClient.sendGotoLine(d.line);
    }
  }
});

/** Whether the preview pane is currently visible. */
function markdownPreviewVisible() {
  return !document.body.classList.contains('markdown-preview-hidden');
}

/** The trailing path segment (file name) of an absolute path. */
function previewBasename(path) {
  return String(path).split('/').pop() || String(path);
}

/** Reset the in-app preview pane chrome: hide it and clear its state. Shared by
 *  close (which also stops the watch) and pop-out (which hands the watch to the
 *  new window and so keeps it alive). */
function resetMarkdownPreviewPane() {
  document.body.classList.add('markdown-preview-hidden');
  previewWatchedPath = null;
  previewPort = null;
  lastPostedPreviewLine = null; // a re-open re-scrolls to the cursor
  markdownPreviewFrame.src = 'about:blank';
  markdownPreviewFilename.textContent = '';
}

/** Hide the preview pane and stop this window's watch subprocess. */
function hideMarkdownPreview() {
  resetMarkdownPreviewPane();
  clearPreviewSyncState(); // in-app close ends live-sync (pop-out keeps it)
  if (window.host && typeof window.host.stopJmarkdownWatch === 'function') {
    window.host.stopJmarkdownWatch();
  }
}

/** Pop the preview out into its own Godot window. Main moves the watch's
 *  ownership to the new window, so the in-app pane DETACHES (closes) without
 *  stopping the watch. A no-op until the watcher's port is known. */
async function popOutMarkdownPreview() {
  if (previewPort == null) return;
  // Pass the file name + the editor's resolved chrome colours so the popped-out
  // window's title bar matches the active theme.
  const cs = getComputedStyle(document.body);
  const opts = {
    name: previewBasename(previewWatchedPath || ''),
    bg: cs.getPropertyValue('--bg-chrome').trim(),
    fg: cs.getPropertyValue('--fg-dim').trim(),
  };
  let result;
  try {
    result = await window.host.popOutPreview(opts);
  } catch (error) {
    result = { error: String(error && error.message ? error.message : error) };
  }
  if (result && result.ok) {
    resetMarkdownPreviewPane(); // the popped-out window owns the watch now
    previewPoppedOut = true;    // forward search now routes to that window
  } else {
    repl.appendNote(`markdown-preview: ${result?.error ?? 'could not pop out the preview'}`);
  }
}

/** Reveal the pane and point the iframe at a `jmarkdown watch` server on
 *  `path`. Starting the watcher is async (the server builds before it serves);
 *  the header shows a "starting…" state until the port is ready. A failure
 *  re-hides the pane and reports the reason. */
async function showMarkdownPreview(path) {
  document.body.classList.remove('markdown-preview-hidden');
  previewPoppedOut = false; // reopening in-app takes over forwarding
  markdownPreviewFilename.textContent = `${previewBasename(path)} · starting…`;
  previewWatchedPath = path;
  // Begin live-syncing: seed the preview shadow with the current (even unsaved)
  // buffer, then debounce refreshes on edits.
  const seedText = beginPreviewSync(path);
  let result;
  try {
    result = await window.host.startJmarkdownWatch(path, seedText);
  } catch (error) {
    result = { error: String(error && error.message ? error.message : error) };
  }
  // A later toggle/switch may have moved on while we awaited; honour it.
  if (previewWatchedPath !== path) return;
  if (!result || result.error) {
    hideMarkdownPreview();
    repl.appendNote(`markdown-preview: ${result?.error ?? 'could not start preview'}`);
    return;
  }
  previewPort = result.port;
  markdownPreviewFilename.textContent = previewBasename(path);
  markdownPreviewFrame.src = `http://localhost:${result.port}/`;
}

/** Re-point the preview after a buffer switch. The server owns the buffer's
 *  mode AND file path: a server-backed buffer never updates the renderer's
 *  `currentTextBuffer`, and the pushed mirror carries no file path — so the
 *  renderer can't learn a newly-focused buffer's path. The preview therefore
 *  stays PINNED to the file it was opened on; re-open (C-c v) on another file
 *  to preview it instead. (Server-driven re-point is a follow-up; in server
 *  mode this isn't even reached — applyTextMountSideEffects returns first.) */
function syncMarkdownPreviewToBuffer() {
  // intentionally a no-op — see above.
}

/** Toggle the Markdown preview pane (C-c v). The server emits this directive
 *  only for a Markdown / JMarkdown buffer (it guards the mode) and sends the
 *  active buffer's saved `path` ('' when unsaved). So the renderer just
 *  toggles: open on a saved file, else report "save the file first". */
function toggleMarkdownPreview(path) {
  if (markdownPreviewVisible()) {
    hideMarkdownPreview();
    editorView.focus();
    return;
  }
  if (typeof path !== 'string' || path === '') {
    repl.appendNote('markdown-preview: save the file first');
    return;
  }
  showMarkdownPreview(path);
  editorView.focus();
}

watchCurrentBuffer();
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

// Native menus: run a command chosen from a menu. The mode menu itself is
// computed + pushed by the server (applyServerModeMenu), not built here.
window.host.onMenuCommand((command) => {
  editorView.focus();
  // Menu clicks dispatch through the SPINE (like keys), not the inert renderer
  // interpreter — the server routes server vs element-view commands and reports
  // errors via status. The mode menu refresh rides the server's next VIEW push.
  if (serverViewClient && typeof serverViewClient.runCommand === 'function') {
    serverViewClient.runCommand(command);
  }
});

// A native Quit (Cmd+Q / app-menu Quit) is intercepted in the main
// process and routed here, so it gets the same unsaved-changes confirm
// and metadata flush as C-x C-c (quitInteractive) instead of dropping
// edits silently. quitInteractive calls host.quit() to actually exit.
if (window.host && typeof window.host.onConfirmQuit === 'function') {
  window.host.onConfirmQuit(() => {
    quitInteractive();
  });
}

// (The renderer `(run-process! …)` exit channel was deleted with the interpreter
// — B7. Processes (latex compile, shell, gnuplot) run server-side now; the spine
// owns run-process! + its on-exit callbacks.)

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
  scheduleMinimapReconcile(); // promotion changed the leaf's view shape
  return tabline;
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

/** Ask the SERVER to open ROOT as a project (Model B Stage 3: each project opens
 *  in a NEW window). The native dialog / chooser run renderer-side, but the open
 *  itself is server-authoritative (spine.openProjectAt → a project window), so the
 *  chosen path goes UP as PROJECT_OPEN rather than the old in-renderer in-place
 *  `openProject`. */
function requestOpenProject(root) {
  const path = expandTilde(String(root ?? '')).replace(/\/+$/, '');
  if (path !== '' && godotServerPort) {
    godotServerPort.postMessage({ type: MSG.PROJECT_OPEN, path });
  }
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
        // Model B: opening a project is server-authoritative (a new window).
        openProject: (path) => requestOpenProject(path),
        // Pick a folder and open it immediately (the chooser closes first).
        openFolder: () => {
          window.host
            .openDirectory()
            .then((path) => { if (path) requestOpenProject(path); })
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


