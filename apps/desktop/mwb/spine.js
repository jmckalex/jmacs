/**
 * @file Model-B command spine — the server-side command surface.
 *
 * This is the next slice after render-from-mirror (architect-notes.md
 * 2026-06-22 11:00): make the prototype a genuinely usable single-window
 * editor *through the server*. The render half was proven a drop-in (zero
 * view.js changes); the cost was said to live in the **model/command
 * half**. This module pays down the thinnest real slice of that half.
 *
 * What it does: stands up the REAL command machinery server-side —
 *   - a REAL L2 buffer (@editor/buffer) wrapped in a REAL view
 *     (@editor/view), gathered into a `session` whose `currentView` is
 *     that view (the exact shape `createBufferPrimitives` expects);
 *   - the REAL buffer primitives (`createBufferPrimitives` from
 *     @editor/stdlib) — `insert!`, `delete-backward!`, `cursor-*!`,
 *     `point`, `mark`, `goto!`, `set-mark!`, … unchanged from production;
 *   - the REAL command system + editing commands, loaded verbatim from
 *     disk: `commands.lisp` (`defcommand`/`run-command`/the interactive
 *     gatherer + minibuffer continuation) and `editing.lisp` (motion +
 *     editing commands written against those primitives);
 *   - a focused keymap + `handle-key` dispatch in the same shape as the
 *     production `keymap.lisp` (prefix chords, self-insert fallthrough),
 *     wired to the real `run-command`;
 *   - the host primitives the spine needs that would otherwise be
 *     renderer/pixel concerns — `show-status!`, `clear-status!`,
 *     `open-minibuffer!`, `recenter!`, `goto-line!`, `replace-all!` — each
 *     turned into a server-side effect that the caller surfaces to the
 *     client as a view-update (the modeline/status/minibuffer state) or a
 *     down-channel scroll request.
 *
 * It is DOM-free and Electron-free: it takes plain callbacks for its
 * outward effects (status changes, minibuffer prompts, scroll requests),
 * so it is unit-testable under `node --test` with no harness (see
 * spine.test.js). `server.js` wires those callbacks to the wire.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, NIL, listToArray, arrayToList } from '@editor/lisp';
import { createBuffer } from '@editor/buffer';
import { createView } from '@editor/view';
import { createBufferPrimitives } from '@editor/stdlib';

import { renderModeline } from './protocol.js';
import { createBufferRegistry } from './buffer-registry.js';
import { createPaneModel } from './pane-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const STDLIB_DIR = join(here, '..', '..', '..', 'packages', 'stdlib', 'lisp');

/** The bare name of a Lisp symbol/keyword/string argument (a Sym and a
 *  Keyword both carry a `.name`), with any leading `:` stripped, or null when
 *  ARG isn't symbol-like. The pane primitives read their orientation/side/
 *  direction args this way (mirrors app.js's `symbolNameOf`). */
function symName(arg) {
  let name = null;
  if (typeof arg === 'string') name = arg;
  else if (arg && typeof arg === 'object' && typeof arg.name === 'string') {
    name = arg.name;
  }
  if (name === null) return null;
  return name.startsWith(':') ? name.slice(1) : name;
}

/**
 * The standard-library files the spine loads, in dependency order.
 *
 * Beyond the original command core (`commands.lisp` + `editing.lisp`),
 * this is the **model-heavy slice** the primitive-split proves out (see
 * `mwb/PRIMITIVE-SPLIT.md`): the customisation registry, indent settings,
 * the mode machinery, the kill ring / yank, line operations, the search
 * command stubs, and a real major mode (Markdown). Every file here is
 * loaded **verbatim from disk** — the same source the production editor
 * runs — and depends only on model-side primitives (provided directly
 * below) plus a handful of render-side primitives that the spine
 * routes to a view-update or stubs.
 *
 * NOT yet loaded: the pane/tabline/faces/themes/languages/preview files,
 * which pull in renderer-only primitives (the pane tree, DOM measurement,
 * MathJax, element views) that are render-side slices of their own. See
 * PRIMITIVE-SPLIT.md for the full categorisation.
 *
 * Order matches the relevant prefix of the production STDLIB_FILES:
 * commands → editing → custom → indent → modes → math-preview →
 * kill → yank-pop → line-ops → search → markdown. (`modes.lisp` must
 * precede the mode files; `custom.lisp` must precede `defcustom` users;
 * `math-preview.lisp` defines `math-preview-mode` before `markdown.lisp`
 * references it.)
 */
const SPINE_STDLIB = Object.freeze([
  'commands.lisp',
  'editing.lisp',
  'custom.lisp',
  'indent.lisp',
  'modes.lisp',
  'math-preview.lisp',
  'kill.lisp',
  'yank-pop.lisp',
  'line-ops.lisp',
  // expand-region.lisp (pure Lisp; defines expand-region-word-bounds) must
  // precede multi-cursor.lisp, which uses it to find the word at point.
  'expand-region.lisp',
  // multi-cursor.lisp — the C-c d / C-c D word-select-and-add commands,
  // written against the model-side multi-cursor primitives (add-selection!,
  // selections, collapse-to-primary!). It rebinds keyboard-quit, so a
  // minimal keyboard-quit is defined in the spine prelude before it loads.
  'multi-cursor.lisp',
  'search.lisp',
  'markdown.lisp',
  // panes.lisp — the interactive split/other/delete-window commands (C-x 2 /
  // 3 / 0 / 1 / o). Loaded VERBATIM: the same source the production editor
  // runs. Its commands wrap host primitives (split-horizontal!, delete-pane!,
  // other-pane!, current-pane, …) that the spine provides server-side against
  // the active client's LOGICAL pane tree (pane-model.js) — no DOM, no pixels.
  // This is the G0a proof: the pane commands graduate with zero Lisp change;
  // only the host primitives differ. Needs custom.lisp (defgroup/defcustom)
  // and commands.lisp (defcommand), both already loaded above.
  'panes.lisp',
]);

/**
 * The keymap: a key-string → command-name table, in the same spirit as
 * production `keymap.lisp` but pared to what the spine exercises. The
 * server's `handle-key` resolves a key here, runs the bound command
 * through the REAL `run-command`, or self-inserts a bare printable.
 *
 * `keyEventToString` names (see reference_key_names): arrows are
 * `left/right/up/down`; `enter`, `backspace`; Meta is Command (`M-…`).
 */
const KEYMAP = Object.freeze({
  // motion
  left: 'backward-char',
  right: 'forward-char',
  up: 'previous-line',
  down: 'next-line',
  'C-a': 'move-beginning-of-line',
  'C-e': 'move-end-of-line',
  'C-f': 'forward-char',
  'C-b': 'backward-char',
  'C-n': 'next-line',
  'C-p': 'previous-line',
  'M-f': 'forward-word',
  'M-b': 'backward-word',
  'M-less': 'beginning-of-buffer',
  'M-greater': 'end-of-buffer',
  // editing
  enter: 'newline',
  backspace: 'delete-backward',
  'C-d': 'delete-forward',
  'C-l': 'recenter',
  // --- undo / redo (editing.lisp `undo`/`redo` → `undo!`/`redo!`) -----
  // The L2 undo stack lives with the canonical buffer, so undo through the
  // server reverts the buffer BOTH windows on it see (the Model-B payoff).
  // C-/ is the Emacs undo key; on a US layout `event.code` is `Slash`, so it
  // normalises to `C-slash` (and Emacs's literal C-_ is Shift+Minus →
  // `C-S-minus`). C-x u (the other classic undo binding) is in CX_MAP.
  // Redo: C-S-/ (`C-S-slash`) + M-S-z (`M-S-z`), mirroring keymap.lisp.
  'C-slash': 'undo',
  'C-S-minus': 'undo',
  'C-S-slash': 'redo',
  'M-S-z': 'redo',
  // selection
  'C-space': 'set-mark-command',
  'C-g': 'keyboard-quit',
  // --- kill ring / yank (kill.lisp + yank-pop.lisp) ------------------
  'C-w': 'kill-region',
  'M-w': 'copy-region',
  'C-k': 'kill-line',
  'C-y': 'yank',
  'M-y': 'yank-pop',
  'M-d': 'kill-word',
  'M-backspace': 'backward-kill-word',
  // --- line operations (line-ops.lisp) ------------------------------
  'M-up': 'move-line-up',
  'M-down': 'move-line-down',
  'M-bracketright': 'indent-region', // M-]
  'M-bracketleft': 'outdent-region', // M-[
  // --- search (search.lisp — commands resolve; loop is a host stub) -
  'C-s': 'isearch-forward',
  'C-r': 'isearch-backward',
  // --- highlight all matches (a REAL overlay feature, server-side) ---
  // M-s h highlights every occurrence of the word at point / region as
  // overlays the renderer draws via getDecorations(); M-s u clears them.
  // (Emacs binds highlight-symbol-at-point under M-s h …; we keep the
  // mnemonic.) These prove overlay sync end-to-end.
  'M-s': { h: 'highlight-matches', u: 'unhighlight-all' },
  // command spine entry points
  'M-x': 'execute-extended-command',
});

/**
 * The global `C-c` prefix the spine offers when no MAJOR mode claims it.
 * In a Markdown buffer the mode-keymap chain catches `C-c` first (its
 * `C-c b` etc.), so these only fire in a plain buffer — exactly where
 * production's global `c-c-keymap` holds `C-c d` / `C-c D` (multi-cursor).
 */
const CC_MAP = Object.freeze({
  d: 'add-cursor-next', // multi-cursor.lisp — word-select + add next match
  D: 'select-all-matches', // multi-cursor.lisp — a cursor at every match
});

/**
 * A keymap whose values are themselves keymaps make a key a *prefix*. The
 * `C-x` prefix carries the file + buffer commands. (Production resolves
 * this through nested maps in keymap.lisp; the spine inlines the one
 * prefix it needs.)
 */
const CX_MAP = Object.freeze({
  'C-f': 'find-file',
  'C-s': 'save-buffer',
  'C-w': 'write-file', // save-as: write the buffer to a new path (prompts)
  'C-d': 'duplicate-line', // line-ops.lisp (production binds C-x C-d here)
  'C-j': 'join-line', // line-ops.lisp
  // Multi-buffer (production keymap.lisp): C-x b switches buffer (a
  // minibuffer name read, host-completed), C-x C-b lists buffers, C-x k
  // kills the current buffer.
  b: 'switch-to-buffer',
  'C-b': 'list-buffers',
  k: 'kill-buffer',
  u: 'undo', // C-x u — the classic Emacs undo binding (alongside C-/)
  // --- pane/window splits (panes.lisp — the Emacs C-x map) -----------
  // C-x 2 / 3 / 0 / 1 / o drive the REAL panes.lisp commands against the
  // active window's LOGICAL pane tree (pane-model.js). So a key routed
  // through handleKey splits/cycles/deletes panes server-side, the same as
  // a PANE_INTENT does — both paths run the same commands.
  2: 'split-vertical', // C-x 2 — split top/bottom
  3: 'split-horizontal', // C-x 3 — split side-by-side
  0: 'delete-pane', // C-x 0 — delete the focused pane
  1: 'delete-other-panes', // C-x 1 — the focused pane fills the window
  o: 'other-pane', // C-x o — cycle focus to the next pane
});

/**
 * Create the command spine.
 *
 * @param {object} options
 * @param {string} options.initialText - The buffer's seed text.
 * @param {string} options.name - The buffer/view name (drives the mode/
 *   language client-side and the modeline label).
 * @param {object} effects - Outward effects, wired to the wire by the
 *   server. All optional; default to no-ops.
 * @param {(text: string) => void} [effects.onStatus] - Echo-area message
 *   set (`show-status!`) or cleared (`clear-status!` → '').
 * @param {(prompt: string) => void} [effects.onMinibufferOpen] - A command
 *   asked to read from the minibuffer. The server should show the prompt;
 *   the user's submit/cancel comes back via `deliverMinibuffer`.
 * @param {() => void} [effects.onMinibufferClose] - The minibuffer prompt
 *   resolved (submit or cancel); the client should hide it.
 * @param {(req: object) => void} [effects.onScroll] - A scroll/centering
 *   request the client must execute in pixels (e.g. recenter). The server
 *   decides the line; the client does the pixels (plan §5d).
 * @param {(path: string) => { text: string, name: string, path?: string } | null} [effects.openFile]
 *   - Read a file off disk for find-file. Returns the text + name (+ the
 *   resolved absolute path, so the buffer knows where to save back), or null
 *   on failure. (The server is a Node child, so file I/O is direct —
 *   plan §3 (i).)
 * @param {(req: { path: string, text: string }) => { ok: boolean, error?: string }} [effects.saveFile]
 *   - Write a buffer's text to disk ATOMICALLY (temp file + rename), for
 *   save-buffer / write-file. Returns `{ ok }` or `{ ok:false, error }`. The
 *   spine re-baselines the saved text on success (the dirty flag clears).
 * @returns {Spine}
 */
export function createSpine(options, effects = {}) {
  const onStatus = effects.onStatus ?? (() => {});
  const onMinibufferOpen = effects.onMinibufferOpen ?? (() => {});
  const onMinibufferClose = effects.onMinibufferClose ?? (() => {});
  const onScroll = effects.onScroll ?? (() => {});
  const openFile = effects.openFile ?? (() => null);
  // Write a buffer to disk (atomic). Default to a failure so a save with no
  // host wired reports cleanly rather than silently claiming success.
  const saveFile = effects.saveFile
    ?? (() => ({ ok: false, error: 'no save handler wired' }));
  // Raised whenever the overlay set changes (a command added/cleared a
  // highlight). The server broadcasts the fresh snapshot to every client
  // sharing the buffer (overlays are shared state). Called with no args;
  // the server reads `spine.overlaySnapshot()`.
  const onOverlays = effects.onOverlays ?? (() => {});
  // Raised when the active client runs list-buffers (C-x C-b). The server
  // sends that client the buffer-list records (`spine.bufferListRecords`).
  const onBufferList = effects.onBufferList ?? (() => {});
  // Raised when a command opens a generic PICKER (open-picker! — the G0b
  // channel). The server sends the active client a PICKER down-message with
  // the request `{ id, title, rows, options }`; the client renders the
  // interactive list and the user's choice/cancel comes back up, resolved
  // via `deliverPicker`. Mirrors onMinibufferOpen.
  const onPicker = effects.onPicker ?? (() => {});
  // Raised when a kill-buffer switched the active client to a different
  // buffer (the killed buffer is gone). The server re-snapshots that client
  // onto its new buffer. Called with the active client's new bufferId.
  const onBufferSwitched = effects.onBufferSwitched ?? (() => {});
  // Raised for every text change on ANY held buffer, tagged with its id.
  // The server fans a delta only to the clients viewing THAT buffer (a delta
  // is no longer a broadcast — different windows hold different buffers).
  // Signature: (bufferId, { change, point }, buffer).
  const onBufferChange = effects.onBufferChange ?? (() => {});

  // --- the buffer registry (multi-buffer) ------------------------------
  //
  // The server holds MANY buffers at once (a buffer list, keyed by id). Each
  // registry entry owns its text, its per-client views (each window keeps
  // its own point/mark over the shared text — the per-window vs per-buffer
  // split, plan §4), and its overlay state. find-file ADDS a buffer rather
  // than replacing the current one; a client switches between them.
  const registry = createBufferRegistry({
    createBuffer,
    createView,
    onBufferChange: (id, event) => onBufferChange(id, event),
  });

  // The seed buffer (the file the server booted with). Every client starts
  // viewing it; further buffers join via find-file.
  const initialEntry = registry.add(options.initialText ?? '', options.name ?? 'mwb-scratch');

  // --- per-window pane trees (G0a) -------------------------------------
  //
  // Each client/window owns its OWN logical pane tree (pane-model.js). A
  // leaf shows a buffer from the registry + its own per-pane view-state
  // (point/scroll); two leaves can show the SAME buffer (shared text,
  // independent point) — the same-buffer-two-windows case, but within one
  // window. The buffer the active client EDITS is its pane model's FOCUSED
  // leaf's buffer (setActiveClient binds it). A single-pane window behaves
  // exactly like the pre-pane spine: one leaf, one focused buffer.
  //
  // The leaf's view is a REAL @editor/view, minted per leaf (keyed by leaf
  // id) so the buffer's cursor binds to this pane's own point/mark. The
  // factory routes through the registry so a leaf's view participates in the
  // same multi-cursor / overlay machinery as everything else.
  /** Mint/reuse a real view over BUFFERID for the leaf with stable VIEWKEY,
   *  keyed by (viewKey, bufferId) so each (pane, buffer) pair keeps its OWN
   *  persistent point/mark — and so switching a pane away from a buffer and
   *  back restores that pane's cursor in it. Two panes on the SAME buffer have
   *  different view keys, so their cursors are independent (the same-buffer-
   *  two-windows case within one window). */
  function makeLeafView(bufferId, viewKey) {
    const id = bufferId ?? initialEntry.id;
    const key = `${viewKey}:${id}`;
    return registry.viewFor(id, key) ?? registry.viewFor(initialEntry.id, key);
  }

  /** @type {Map<number, import('./pane-model.js').PaneModel>} index → pane tree. */
  const paneModels = new Map();

  /** Raised when a client's pane layout/focus changed (a split / delete /
   *  other-window). The server re-pushes that client's PANE_TREE. Signature:
   *  (clientIndex). */
  const onPaneTree = effects.onPaneTree ?? (() => {});

  /** Create (and remember) the pane model for client INDEX, seeded on the
   *  client's starting buffer. */
  function makePaneModel(index, startBufferId) {
    const model = createPaneModel(
      { initialBufferId: startBufferId },
      {
        onChange: () => onPaneTree(index),
        nameForBuffer: (id) => {
          const e = id ? registry.get(id) : null;
          return e ? e.buffer.name : 'scratch';
        },
        // Namespace the leaf view key by the WINDOW (client index) too, so two
        // windows' leaves — whose per-window viewKey counters both start at 0 —
        // get distinct registry views (independent cursors per window). Within
        // a window the viewKey is stable per leaf (cursor survives a buffer
        // switch away and back).
        makeView: (bufferId, viewKey) => makeLeafView(bufferId, `c${index}-${viewKey}`),
      }
    );
    paneModels.set(index, model);
    return model;
  }

  // Client 0's pane tree starts as a single leaf on the seed buffer.
  makePaneModel(0, initialEntry.id);

  /** The pane model of the active client (what the pane primitives mutate). */
  function currentPaneModel() {
    return paneModels.get(activeClientIndex) ?? paneModels.get(0);
  }

  // The set of known client indices (so a buffer-wide refresh / a kill can
  // re-home every client). Index 0 is always present (the default view).
  const clientIndices = new Set([0]);

  // The ACTIVE (buffer, view) the interpreter operates against right now —
  // resolved from the active client by setActiveClient before each intent.
  // `bindCursor` (run inside the buffer primitives) routes the active
  // buffer's point/mark through the active view's cursors; the session's
  // `currentView` getter returns the active view. This is exactly
  // production's session shape, but the active buffer/view now varies with
  // which client (and which of its buffers) the server is serving.
  let activeEntry = initialEntry;
  // The initial active view is client 0's FOCUSED leaf view (its pane model
  // was created above with one leaf on the seed buffer). A single-pane window
  // thus behaves exactly like the pre-pane spine: one focused leaf, one view.
  let view = paneModels.get(0).focusedView() ?? registry.viewFor(initialEntry.id, 0);
  let buffer = initialEntry.buffer;
  buffer.bindCursor(view);

  /** The session the buffer primitives operate against. A getter for
   *  `currentView` so a buffer/client switch swaps the active view
   *  underneath without re-creating the primitives. */
  const session = {
    get currentView() {
      return view;
    },
  };

  /**
   * Make (the active client's view of) buffer ENTRY active: the interpreter's
   * `buffer`, `view`, and `session.currentView` now point at it, and the
   * buffer's cursor reads/writes the given view's point/mark. Every command
   * dispatch + overlay primitive runs against whatever this last set.
   *
   * @param {object} entry - A registry buffer entry.
   * @param {object} v - That entry's view for the active client.
   */
  function bindActive(entry, v) {
    activeEntry = entry;
    buffer = entry.buffer;
    view = v;
    buffer.bindCursor(view);
  }

  /**
   * Rebind the interpreter to the ACTIVE client's FOCUSED leaf — its buffer +
   * that leaf's view — and re-derive the major mode. Called after any pane op
   * that moves focus (split / other-pane / delete / focus-direction / swap),
   * so a following command and the next keystroke edit the right pane. This is
   * just `setActiveClient(activeClientIndex)`, named for intent. (A function
   * declaration so it's hoisted above the primitive bodies that call it.) */
  function rebindFocusedPane() {
    setActiveClient(activeClientIndex);
  }

  // --- the echo area (status line) -------------------------------------
  let statusText = '';

  // --- the active minibuffer prompt ------------------------------------
  // The prompt label of an open minibuffer read, or null. The server reads
  // this on submit to decide HOW to resolve: an ordinary argument prompt
  // (goto-line, replace-string) resumes the suspended command via
  // `deliverMinibuffer`; the M-x / find-file prompts are special — their
  // command body is a no-op and the host runs the chosen command / visits
  // the file itself (see server.js).
  let activePrompt = null;

  // --- the active picker request (G0b) ---------------------------------
  // The wire request `{ id, title, rows, options }` of the currently-open
  // generic picker, or null. The server reads it on a PICKER_CHOOSE/CANCEL
  // to match the reply to the suspended command (a reply whose pickerId no
  // longer matches the active picker is stale and dropped). A fresh id is
  // minted per open so a superseded picker can't resume the wrong command.
  let activePicker = null;
  let pickerSeq = 0;

  // --- the modeline modified flag --------------------------------------
  // The "last saved" baseline is now per-buffer (registry entry.savedText),
  // so a buffer is modified when its text differs from ITS own baseline.

  // --- the server-local clipboard (kill.lisp's interprogram edge) ------
  // STUB: an in-memory clipboard, so the kill ring round-trips fully
  // without an OS clipboard (which a headless Node child lacks). See
  // PRIMITIVE-SPLIT.md "Kill ring".
  let clipboardText = '';

  // --- overlays (shared buffer state) ----------------------------------
  //
  // An overlay is a face-tagged range on the CANONICAL buffer — a search
  // highlight, a snippet field, a secondary-cursor decoration. They are
  // MODEL state (shared: every client viewing the buffer sees the same
  // set, so they live here, not per-client), and they must ride edits, so
  // each overlay's endpoints are real L2 MARKERS (which shift correctly
  // under inserts/deletes — packages/buffer createMarker). The server reads
  // their live offsets (`overlaySnapshot`) and broadcasts the set to every
  // client, whose mirror renders them via the renderer's getDecorations().
  //
  // This is the model-side half of the search/snippet/decoration features
  // PRIMITIVE-SPLIT.md flagged as render-message slices: the OVERLAY STATE
  // is model-side (shared, edit-tracked); only the PIXELS are client-side
  // (the renderer already draws getDecorations()). So an overlay needs no
  // new render protocol — just the offsets on the wire.
  //
  // Overlays now live ON THE BUFFER ENTRY (registry), not in the spine: a
  // highlight is a property of a buffer, so switching buffers must show that
  // buffer's overlays. These helpers operate on the ACTIVE entry (the
  // commands run against whatever client the server is serving). The wire
  // snapshot for a SPECIFIC buffer is `overlaySnapshotOf(id)` (used to send
  // a switching client its new buffer's overlays).

  /** Drop the active buffer's overlays (releasing markers), or only KIND. */
  function clearOverlays(kind) {
    registry.clearOverlays(activeEntry, kind);
  }

  /** A wire snapshot of the ACTIVE buffer's overlays at their current
   *  (edit-tracked) offsets. Drops overlays a deletion has collapsed. */
  function overlaySnapshot() {
    return registry.overlaySnapshot(activeEntry);
  }

  /** A wire snapshot of a SPECIFIC buffer's overlays (for a switch). */
  function overlaySnapshotOf(id) {
    const entry = registry.get(id);
    return entry ? registry.overlaySnapshot(entry) : [];
  }


  // --- the interpreter --------------------------------------------------
  const interpreter = createInterpreter({
    write: () => {}, // discard print output in the spine
    primitives: {
      // The real buffer primitives — the entire editing/motion surface the
      // stdlib commands are written against, operating on `session`.
      ...createBufferPrimitives(session),

      // --- echo area (the minibuffer's status line) ---------------------
      // keymap.lisp calls these; the spine routes them to the client's
      // echo area via the onStatus effect.
      'show-status!': (args) => {
        statusText = String(args[0] ?? '');
        onStatus(statusText);
        return NIL;
      },
      'clear-status!': () => {
        statusText = '';
        onStatus('');
        return NIL;
      },

      // --- the minibuffer prompt ----------------------------------------
      // `open-minibuffer!` is called by the interactive gatherer
      // (commands.lisp `minibuffer-read`) to prompt for an argument. The
      // server shows the prompt; the user's input resolves via
      // `minibuffer-delivered` (called from deliverMinibuffer below).
      'open-minibuffer!': (args) => {
        activePrompt = String(args[0] ?? '');
        onMinibufferOpen(activePrompt);
        return NIL;
      },

      // --- the generic picker (G0b) -------------------------------------
      // `open-picker!` is the render half of the picker channel: a command
      // (via picker-read, defined below) calls it to open an interactive
      // list client-side. ARGS are (title rows options?): TITLE is the
      // header label; ROWS is an opaque JS array of `{ label, value, ...
      // meta }` (the host row-provider built it — Lisp passes it through
      // verbatim, never inspecting it, exactly as it passes a pane handle);
      // OPTIONS is an optional opaque JS options bag. The spine mints a
      // fresh picker id, records the request, and raises onPicker so the
      // server sends a PICKER message. The user's choice resolves via
      // `deliverPicker` (→ picker-delivered), the minibuffer's twin.
      'open-picker!': (args) => {
        const title = String(args[0] ?? '');
        const rows = Array.isArray(args[1]) ? args[1] : [];
        const options = args[2] && typeof args[2] === 'object' && !Array.isArray(args[2])
          ? args[2] : {};
        pickerSeq += 1;
        const id = `picker-${pickerSeq}`;
        activePicker = { id, title, rows, options };
        onPicker(activePicker);
        return NIL;
      },
      // `buffer-list-rows` is the buffer-list ROW-PROVIDER: it returns the
      // open buffers as picker rows (an opaque JS array) for the active
      // client — each row's label is the buffer name, its value the buffer
      // id (what an on-choose switch needs), with line-count + a ●/– flag as
      // meta and the current buffer pre-marked. This is the one concrete
      // provider G0b builds; every other picker (completions, *Recover*,
      // RefTeX) is the SAME open-picker! call with a different provider.
      'buffer-list-rows': () => bufferListRows(),

      // --- scroll / measurement (plan §5d) ------------------------------
      // recenter! is a Lisp command whose *effect* is a client-pixel
      // scroll. The server decides the target line (it knows point); the
      // client executes the pixels. Down-channel request, the easy
      // direction of the measurement conversation.
      'recenter!': () => {
        const { line } = buffer.positionAt(buffer.point);
        onScroll({ kind: 'recenter', line });
        return NIL;
      },

      // --- editing commands' host helpers (mirrors of app.js) -----------
      'goto-line!': (args) => {
        const n = Number(args[0]);
        if (Number.isInteger(n) && n >= 1) {
          buffer.moveTo(buffer.offsetAt(Math.min(n, buffer.lineCount) - 1, 0));
        }
        return NIL;
      },
      'replace-all!': (args) => {
        const search = String(args[0]);
        const replacement = String(args[1]);
        if (search !== '') {
          const text = buffer.text;
          const count = text.split(search).length - 1;
          if (count > 0) buffer.setText(text.split(search).join(replacement));
          statusText =
            count > 0
              ? `replaced ${count} occurrence(s) of "${search}"`
              : `"${search}" not found`;
          onStatus(statusText);
        }
        return NIL;
      },

      // --- the pane tree (G0a — panes.lisp's host primitives) ----------
      //
      // panes.lisp (loaded verbatim) wraps these. They mutate the ACTIVE
      // client's LOGICAL pane tree (pane-model.js) — no DOM, no pixels. This
      // is the whole point of G0a: the split/other/delete commands graduate
      // with zero Lisp change; only these host primitives differ from the
      // renderer's (which interleave ~1000 lines of pixel plumbing). Each
      // returns nil (interactive callers ignore the return) and the model's
      // onChange raises onPaneTree so the server re-pushes PANE_TREE.

      // Every focus-changing pane op must REBIND the interpreter to the newly-
      // focused leaf's buffer + view, so a following command (and the next
      // keystroke / intent) edits the right pane. A split moves focus to the
      // new pane; other-pane / delete / focus-direction move it too. Without
      // this, an edit would land in the previously-bound pane.

      // (split-horizontal! ratio side) — split the focused pane side-by-side.
      // SIDE is the symbol 'after (new pane right, default) or 'before (left).
      'split-horizontal!': (args) => {
        currentPaneModel().split('horizontal', Number(args[0]) || 0.5, symName(args[1]) === 'before' ? 'before' : 'after');
        rebindFocusedPane();
        return NIL;
      },
      // (split-vertical! ratio side) — split the focused pane top/bottom.
      'split-vertical!': (args) => {
        currentPaneModel().split('vertical', Number(args[0]) || 0.5, symName(args[1]) === 'before' ? 'before' : 'after');
        rebindFocusedPane();
        return NIL;
      },
      // (delete-pane!) — collapse the focused pane into its sibling (C-x 0).
      'delete-pane!': () => { currentPaneModel().deletePane(); rebindFocusedPane(); return NIL; },
      // (delete-other-panes!) — the focused pane fills the window (C-x 1).
      'delete-other-panes!': () => { currentPaneModel().deleteOtherPanes(); rebindFocusedPane(); return NIL; },
      // (other-pane!) — cycle focus to the next pane in display order (C-x o).
      'other-pane!': () => {
        currentPaneModel().otherPane();
        rebindFocusedPane(); // rebind to the new focused leaf
        return NIL;
      },
      // (balance-panes!) — reset every split ratio to 0.5.
      'balance-panes!': () => { currentPaneModel().balancePanes(); return NIL; },
      // (focus-pane-direction! dir) — spatial focus move (the one geometry-
      // coupled command; uses the client's reported host rect). DIR is a
      // symbol 'left/'right/'up/'down. Rebinds after a successful move.
      'focus-pane-direction!': (args) => {
        const moved = currentPaneModel().focusPaneDirection(symName(args[0]));
        if (moved) rebindFocusedPane();
        return NIL;
      },
      // (current-pane) — the focused leaf pane handle (panes.lisp reads its
      // id via other helpers; here it's the @editor/pane leaf object).
      'current-pane': () => currentPaneModel().focusedLeaf(),
      // (current-view) — the focused leaf's view handle. Production routes
      // current-view through current-pane; the spine returns the leaf's view.
      'current-view': () => currentPaneModel().focusedView() ?? NIL,
      // (swap-panes! a b) — swap which buffer two panes show (frames stay).
      'swap-panes!': (args) => {
        const a = args[0];
        const b = args[1];
        if (a && b && typeof a === 'object' && typeof b === 'object') {
          currentPaneModel().swapPanes(a, b);
          rebindFocusedPane();
        }
        return NIL;
      },
      // (panes-in-spiral-order) — the leaves in clockwise-badge order, as a
      // Lisp list (swap-views/permute-views read its length). Geometry-derived.
      'panes-in-spiral-order': () => arrayToList(currentPaneModel().panesInSpiralOrder()),

      // --- system clipboard (kill.lisp) — STUB (server-local) ----------
      // The kill ring's *internal* state is real shared interpreter state
      // (the `*kill-ring*` list); the clipboard mirror is the system-
      // integration edge. The server is a headless Node child with no
      // Electron `clipboard`, so it keeps an IN-MEMORY clipboard: the ring
      // works fully + round-trips (copy here, yank here), but true
      // cross-application paste is deferred (a future clipboard
      // render-message both ways). See PRIMITIVE-SPLIT.md "Kill ring".
      'clipboard-set-text!': (args) => {
        clipboardText = String(args[0] ?? '');
        return NIL;
      },
      'clipboard-text': () => clipboardText,

      // --- overlays (model state, edit-tracked via L2 markers) ---------
      // The model-side surface for face-tagged ranges. `add-overlay!`
      // pins two markers (so the range rides edits) and returns an id;
      // `clear-overlays!` drops all overlays or only those of a kind. The
      // server broadcasts the resulting set (overlaySnapshot) to clients,
      // whose renderer draws them via getDecorations(). This is what makes
      // search-match HIGHLIGHTING (every match, not just the selected one)
      // work over the wire — a real overlay feature proving the sync.
      // (start end face [kind]) -> id-string
      'add-overlay!': (args) => {
        const start = Math.max(0, Math.floor(Number(args[0]) || 0));
        const end = Math.max(0, Math.floor(Number(args[1]) || 0));
        const face = String(args[2] ?? 'overlay');
        const kind = args.length > 3 && args[3] !== NIL ? String(args[3]) : 'overlay';
        const id = registry.addOverlay(activeEntry, start, end, face, kind);
        onOverlays();
        return id;
      },
      // (clear-overlays! [kind]) -> nil. No kind clears all.
      'clear-overlays!': (args) => {
        const kind = args.length > 0 && args[0] !== NIL ? String(args[0]) : undefined;
        const removed = registry.clearOverlays(activeEntry, kind);
        if (removed > 0) onOverlays();
        return NIL;
      },
      // (overlay-count) -> integer (the live, non-collapsed count).
      'overlay-count': () => overlaySnapshot().length,

      // --- multi-buffer host helpers -----------------------------------
      // open-buffer-list! signals the host to send the active client the
      // buffer-list records (C-x C-b). The host (server.js) owns the
      // registry, so it packs + sends the list; this just raises the effect.
      'open-buffer-list!': () => { onBufferList(); return NIL; },
      // switch-to-buffer-id! switches the ACTIVE client's window to buffer ID
      // (the on-choose action of the C-x C-b picker). Re-points the focused
      // leaf onto the buffer and raises onBufferSwitched so the server re-syncs
      // the client onto its new buffer. (id) -> #t on success, #f if no such id.
      'switch-to-buffer-id!': (args) => {
        const id = String(args[0] ?? '');
        return switchClientToBuffer(activeClientIndex, id);
      },
      // kill-current-buffer! removes the active client's current buffer and
      // switches that client to another (the registry refuses to drop the
      // last buffer). The host performs the kill + re-snapshot (killBuffer).
      'kill-current-buffer!': () => { killActiveBuffer(); return NIL; },

      // --- save (real file I/O, atomic) --------------------------------
      // save-buffer! writes the ACTIVE buffer's text to its file path
      // (atomic temp-file + rename, via the saveFile effect) and re-baselines
      // the saved text so the ● dirty flag clears. A path-less buffer can't
      // save here: the primitive returns 'no-path so the command opens a
      // write-file prompt instead (host-completed, like find-file). Returns
      // a status STRING the command branches on: "ok" | "no-path" | "error".
      'save-buffer!': () => saveActiveBuffer(),
      // write-file! writes the active buffer to PATH, rebinds the buffer's
      // path to it (subsequent C-x C-s saves there), and re-baselines.
      // (path) -> "ok" | "error".
      'write-file!': (args) => writeActiveBufferTo(String(args[0] ?? '')),

      // --- customisation openers (custom.lisp) — STUB ------------------
      // These open a render-side customize view. The `customize` command
      // resolves; the panel itself is a render-side slice, deferred. None
      // is called at load time, so loading custom.lisp is unaffected.
      'open-customize!': () => NIL,
      'open-customize-group!': () => NIL,
      'open-customize-variable!': () => NIL,
      'write-custom-file!': () => NIL,

      // --- search (search.lisp) — STUB (the isearch loop is host-owned) -
      // `isearch-forward`/`isearch-backward` just BEGIN an incremental
      // search; the per-keystroke match + highlight + minibuffer loop
      // lives in the host. Server-side that is a render-message slice of
      // its own (a server search state machine + a client overlay). For
      // now the commands resolve and surface a status so the wiring is
      // visible, then no-op. See PRIMITIVE-SPLIT.md "Search".
      'start-search!': () => {
        statusText = 'I-search: (spine stub — interactive loop is host-side)';
        onStatus(statusText);
        return NIL;
      },
      'start-search-backward!': () => {
        statusText = 'I-search backward: (spine stub — interactive loop is host-side)';
        onStatus(statusText);
        return NIL;
      },

      // --- live preview (markdown.lisp) — STUB -------------------------
      // markdown-preview! / math-preview! drive render-side iframes /
      // MathJax. The toggle commands resolve; the visual effect is a
      // render-message to build later. See PRIMITIVE-SPLIT.md "preview".
      'markdown-preview!': () => {
        statusText = 'markdown-preview: (spine stub — preview pane is render-side)';
        onStatus(statusText);
        return NIL;
      },
      'math-preview!': () => NIL,

      // --- register-mode-menu! consumes (math-preview/modes) -----------
      // `register-mode-menu!` is defined in menus.lisp (not loaded), but
      // markdown.lisp calls it at load to register its grouped menu. The
      // registry it writes is shared model state; the *rendering* of the
      // menu is render-side. Provide a model-side recorder so the load
      // succeeds and the registration is queryable, without pulling in
      // the whole of menus.lisp (which is render-heavy). See
      // PRIMITIVE-SPLIT.md "Modes".
      // (No host primitive needed — register-mode-menu! is pure Lisp; we
      // define a minimal version in the spine prelude below.)

      // `string-repeat` is in the prelude? No — it's a stdlib helper used
      // by `insert-tab`. Provide it so insert-tab works. (Pure; mirrors
      // the stdlib's own definition closely enough for the spine.)
      'string-repeat': (args) => String(args[0] ?? '').repeat(Math.max(0, Number(args[1]) || 0)),
    },
  });

  // --- spine prelude: model-side shims for two procedures that live in
  // render-heavy files we deliberately DON'T load (menus.lisp) but that a
  // loaded file references at load time. Both are pure model state (a
  // registry); only the RENDERING of what they record is render-side, and
  // that's deferred. Defining them here as pure Lisp lets markdown.lisp
  // load verbatim without pulling in menus.lisp. See PRIMITIVE-SPLIT.md.
  interpreter.evaluate(`
    ;; register-mode-menu! — the structured-menu registry (menus.lisp).
    ;; markdown.lisp calls this at load. The registry is shared model
    ;; state; the menu's rendering is render-side (deferred).
    (define *mode-menu-sections* {})
    (define (register-mode-menu! mode-name sections)
      (set! *mode-menu-sections*
            (assoc *mode-menu-sections* mode-name sections))
      sections)
    (define (mode-menu-sections-for mode-name)
      (get *mode-menu-sections* mode-name nil))

    ;; *prefix-arg* — the C-u universal-argument state (keymap.lisp owns it in
    ;; production; that file is render-heavy and not loaded). panes.lisp reads
    ;; it to decide a split's side ('after with no prefix, 'before with C-u).
    ;; The spine has no C-u path yet, so it stays nil → splits default 'after.
    (define *prefix-arg* nil)
  `);

  // Load the real command system + editing commands + the model-heavy
  // slice (see SPINE_STDLIB) verbatim from disk — the same source the
  // production editor runs. Just before multi-cursor.lisp (which rebinds
  // keyboard-quit), define a minimal model-side keyboard-quit: production's
  // (keymap.lisp, render-heavy, not loaded) also resets the keymap + prefix
  // arg, but the spine owns chord state in JS (resetChord), so the model
  // half is just clearing the mark. `defcommand` exists once commands.lisp
  // (first in the list) has loaded, so this must run mid-loop, not in the
  // early prelude above.
  for (const file of SPINE_STDLIB) {
    if (file === 'multi-cursor.lisp') {
      interpreter.evaluate(`
        (defcommand keyboard-quit ()
          "Abort a partial key sequence and clear the selection (C-g)."
          (clear-mark!))
      `);
    }
    const source = readFileSync(join(STDLIB_DIR, file), 'utf8');
    interpreter.evaluate(source);
  }

  // A couple of spine-level commands defined in Lisp on top of the real
  // command system: the M-x entry point and a minimal find-file. These run
  // through the same `run-command`/`defcommand` machinery as everything
  // else — they are real commands, not host shims.
  interpreter.evaluate(`
    ;; --- the generic picker round-trip (G0b) ----------------------------
    ;; The SAME suspend/resume shape as the minibuffer (commands.lisp's
    ;; minibuffer-read / minibuffer-delivered), for a render-side PICKER: a
    ;; command opens an interactive list (open-picker!), SUSPENDS, and resumes
    ;; in a callback when the user picks a row (or cancels). The buffer list,
    ;; *Recover*, completions, RefTeX select + cite are ALL this one shape —
    ;; rows in, one choice out — so they share this one mechanism + a per-
    ;; picker row-provider. This lives in the spine (not production
    ;; commands.lisp) so the channel stays inside the mwb slice.
    (define *picker-reader* nil)

    (define (picker-read title rows callback)
      "Open a render-side picker titled TITLE over ROWS (the host's opaque
       row array); CALLBACK receives the chosen row's value, or nil on cancel."
      (set! *picker-reader* callback)
      (open-picker! title rows))

    (define (picker-delivered result)
      "Called by the host when an open picker resolves. RESULT is the chosen
       row's value, or nil on cancel. Resumes the suspended continuation."
      (let ((reader *picker-reader*))
        (set! *picker-reader* nil)
        (if (not (nil? reader)) (reader result))))

    ;; M-x — prompt for a command name, then run it. The host completes
    ;; the prompt (it has the command list); on submit the host calls
    ;; (run-command (quote NAME)) directly, so this command's body just
    ;; opens the prompt with a marker the host recognises.
    (defcommand execute-extended-command ()
      "Read a command name in the minibuffer and run it (M-x)."
      (interactive (string "M-x "))
      ;; The argument IS the chosen command name (the host resolved it).
      (lambda (name) name))

    ;; --- multi-buffer commands (C-x b / C-x C-b / C-x k) -------------
    ;; switch-to-buffer prompts for a buffer name; the host completes
    ;; against the live buffer list and, on submit, switches the active
    ;; client to that buffer (sending it the new buffer's snapshot +
    ;; overlays). Like M-x/find-file, the body is a host-fulfilled
    ;; placeholder — the host acts on submit (server.js).
    (defcommand switch-to-buffer ()
      "Switch the current window to another buffer by name (C-x b)."
      (interactive (string "Switch to buffer: "))
      (lambda (name) name))

    ;; list-buffers (C-x C-b) — the FIRST consumer of the generic picker
    ;; (G0b). It opens an interactive PICKER over the open buffers (rows from
    ;; the host's buffer-list-rows provider) and, on a choice, switches this
    ;; window to the chosen buffer. This is the round-trip in miniature: the
    ;; command suspends in picker-read; the client renders the list, narrows,
    ;; navigates, picks; the host resumes the continuation with the chosen
    ;; buffer's id; the body switches to it. switch-to-buffer-id! is host-side
    ;; (it re-syncs the client onto the new buffer). A cancel resumes with nil
    ;; → the cond's else does nothing (the window stays put).
    (defcommand list-buffers ()
      "Pick a buffer to switch to (C-x C-b)."
      (picker-read "Buffer list"
                   (buffer-list-rows)
                   (lambda (id)
                     (cond
                       ((nil? id) nil)            ;; cancelled — stay put
                       (else (switch-to-buffer-id! id))))))

    ;; kill-buffer removes the current buffer from the registry and
    ;; switches the window to another (the registry refuses to drop the
    ;; last buffer). The host performs the kill + re-snapshot on dispatch.
    (defcommand kill-buffer ()
      "Kill the current buffer and switch to another (C-x k)."
      (kill-current-buffer!))

    ;; save-buffer (C-x C-s): write the current buffer to its file path
    ;; (atomic, host-side). The host primitive returns a status string:
    ;;   "ok"      — saved; show a confirmation.
    ;;   "no-path" — a path-less buffer; fall back to write-file (prompt for
    ;;               a path), exactly like Emacs's C-x C-s on a new buffer.
    ;;   "error"   — the disk write failed; surface it.
    (defcommand save-buffer ()
      "Save the current buffer to its file (C-x C-s)."
      (let ((result (save-buffer!)))
        (cond
          ((equal? result "ok") (show-status! "Saved"))
          ((equal? result "no-path") (run-command 'write-file))
          (else (show-status! "save-buffer: write failed")))))

    ;; write-file / save-as (C-x C-w): prompt for a path, write the buffer
    ;; there, and rebind the buffer's path to it. The host fulfils the prompt
    ;; (like find-file): on submit server.js calls write-file! with the path.
    (defcommand write-file ()
      "Write the current buffer to a named file (C-x C-w)."
      (interactive (string "Write file: "))
      (lambda (path) path))

    ;; set-mark-command: start a selection at point.
    (defcommand set-mark-command ()
      "Set the mark at point, starting a selection (C-space)."
      (set-mark!)
      (show-status! "Mark set"))

    ;; --- highlight-matches: a REAL overlay feature, server-side -------
    ;; Highlight EVERY occurrence of the word at point (or the active
    ;; region's text) as overlays. Unlike the host's interactive isearch
    ;; (which selects one match at a time), this paints all matches at
    ;; once — the natural proof that overlays sync to the client and the
    ;; real view.js draws them via getDecorations(). The overlays ride
    ;; edits (their endpoints are L2 markers) and are shared across every
    ;; window viewing the buffer.
    (define (-highlight-bounds)
      "The (start . end) to highlight: the active region, else the word
       at point. nil when there is neither."
      (cond
        ((region-active?)
         (let ((m (mark)) (p (point)))
           (cons (min m p) (max m p))))
        (else (expand-region-word-bounds (buffer-text) (point)))))

    (define (-add-match-overlays text needle n from)
      "Add a search overlay at every occurrence of NEEDLE (length N) in
       TEXT at or after FROM. Tail-recursive."
      (let ((found (string-index-of text needle from)))
        (cond
          ((< found 0) nil)
          (else
            (add-overlay! found (+ found n) "search-match" "search")
            (-add-match-overlays text needle n (+ found n))))))

    (defcommand highlight-matches ()
      "Highlight every occurrence of the word at point (or the region)
       with search overlays (M-s h)."
      (clear-overlays! "search")
      (let ((bounds (-highlight-bounds)))
        (when (not (nil? bounds))
          (let* ((start (car bounds))
                 (end (cdr bounds))
                 (text (buffer-text))
                 (needle (substring text start end))
                 (n (string-length needle)))
            (when (> n 0)
              (-add-match-overlays text needle n 0)
              (show-status!
                (string-append "Highlighted "
                               (number->string (overlay-count))
                               " match(es) of \\"" needle "\\"")))))))

    (defcommand unhighlight-all ()
      "Remove all search-match highlight overlays (M-s u)."
      (clear-overlays! "search")
      (show-status! "Highlights cleared"))
  `);

  // --- the mode-keymap resolver (the meaningful spine extension) -------
  //
  // For a mode's bindings (Markdown's C-c b, the math-symbol minor mode's
  // \`) to dispatch server-side, handleKey must consult the active
  // buffer's mode-keymap chain — exactly what production keymap.lisp does
  // via `lookup-in-chain (keymap-chain)`. modes.lisp (now loaded) provides
  // `minor-mode-keymaps` + `major-mode-keymap`; this resolver reuses them.
  //
  // It is written in Lisp (so it walks the real Lisp hash-maps) but is
  // STATELESS toward JS: it returns a tagged plain value JS can branch on
  // without holding a Lisp object —
  //   - a command name (string)  → JS runs it through run-command;
  //   - the symbol 'prefix       → JS knows a chord started (the resolver
  //                                stashed the map in `-spine-chord-map`);
  //   - nil                      → not bound in the mode chain (JS falls
  //                                through to its own global KEYMAP).
  // The chord state lives in `-spine-chord-map`; a follow-up key resolves
  // against it. resetMode() clears it (C-g, an unbound mid-chord key).
  interpreter.evaluate(`
    (define -spine-chord-map nil)

    (define (-spine-mode-chain)
      "The mode keymaps for the current buffer, highest precedence first:
       minor-mode maps, then the major-mode map. (No global map — the JS
       KEYMAP is the spine's global layer.)"
      (append (minor-mode-keymaps) (list (major-mode-keymap))))

    (define (-spine-lookup key maps)
      "First non-nil binding of KEY among MAPS (skipping nil maps)."
      (cond
        ((nil? maps) nil)
        ((nil? (car maps)) (-spine-lookup key (cdr maps)))
        (else (let ((b (get (car maps) key nil)))
                (if (nil? b) (-spine-lookup key (cdr maps)) b)))))

    (define (-spine-resolve key)
      "Resolve KEY through the mode chain (or the active chord map). Returns
       a command name (string), 'prefix (a chord began — map stashed), or
       nil (unbound in the mode chain)."
      (let ((b (if (nil? -spine-chord-map)
                   (-spine-lookup key (-spine-mode-chain))
                   (get -spine-chord-map key nil))))
        (cond
          ((nil? b) (set! -spine-chord-map nil) nil)
          ((map? b) (set! -spine-chord-map b) 'prefix)
          ((symbol? b) (set! -spine-chord-map nil) (symbol->string b))
          (else (set! -spine-chord-map nil) nil))))

    (define (-spine-reset-chord) (set! -spine-chord-map nil))
    (define (-spine-chord-active?) (not (nil? -spine-chord-map)))

    ;; Choose the major mode from the current view's name (modes.lisp's
    ;; choose-major-mode! turns on default minor modes too — none here yet).
    (define (-spine-choose-major-mode) (choose-major-mode!) nil)

    ;; read-next-key support: route the next keystroke to a callback
    ;; instead of the keymaps (keymap.lisp's mechanism; the math-symbol
    ;; minor mode's \` uses it). Defined here because keymap.lisp (which
    ;; owns the production version) is render-heavy and not loaded.
    (define *spine-key-reader* nil)
    (define (read-next-key callback) (set! *spine-key-reader* callback) nil)
    (define (-spine-key-reader-pending?) (not (nil? *spine-key-reader*)))
    (define (-spine-take-key-reader key)
      "If a key-reader is pending, consume it with KEY and return #t."
      (if (nil? *spine-key-reader*)
          #f
          (let ((reader *spine-key-reader*))
            (set! *spine-key-reader* nil)
            (reader key)
            #t)))
  `);

  // --- M-x: a real command-name read --------------------------------
  // execute-extended-command's interactive (string "M-x ") opens the
  // minibuffer; the host (server) completes against the real command
  // registry and, on submit, runs the chosen command. We expose the
  // command names + a runner for the server to use.

  /** Every registered command name, as strings (from the REAL registry). */
  function commandNames() {
    return listToArray(interpreter.call('registered-command-names')).map(String);
  }

  // --- find-file (a real command, host-completed path) ------------------
  // find-file prompts for a path; on submit the host reads the file (Node,
  // direct I/O) and swaps the canonical buffer. We model it as a command
  // whose prompt the host fulfils, then the host calls `visitFile`.
  interpreter.evaluate(`
    (defcommand find-file ()
      "Visit a file (C-x C-f). The host reads the path and swaps buffers."
      (interactive (string "Find file: "))
      (lambda (path) path))
  `);

  // Now that the stdlib + the mode machinery are loaded, choose the major
  // mode for the initial buffer from its name (e.g. a `.md` file gets
  // markdown-mode, so Markdown's C-c bindings dispatch). bindCursor is
  // already in place, so choose-major-mode! operates on the live view.
  interpreter.call('-spine-choose-major-mode');

  /**
   * Visit a file: read it (via the openFile effect) and ADD it as a NEW
   * buffer in the registry (multi-buffer: find-file no longer replaces the
   * current buffer), then switch the ACTIVE client to it. Returns the new
   * buffer's id on success, or null on failure. The server re-snapshots the
   * active client onto the new buffer after this.
   *
   * @param {string} path - An absolute path.
   * @returns {string | null} The new buffer id, or null.
   */
  function visitFile(path) {
    const result = openFile(path);
    if (!result) {
      statusText = `find-file: cannot open ${path}`;
      onStatus(statusText);
      return null;
    }
    // Record the resolved absolute path so save-buffer (C-x C-s) writes back
    // to the right file. openFile returns it; fall back to the typed path.
    const absPath = typeof result.path === 'string' && result.path !== ''
      ? result.path
      : path;
    const entry = registry.add(result.text, result.name, absPath);
    entry.savedText = result.text;
    // Switch the active client to the new buffer (mints its view, derives
    // the major mode, leaves the buffer's own overlays — none yet — intact).
    switchClientToBuffer(activeClientIndex, entry.id);
    statusText = '';
    onStatus('');
    return entry.id;
  }

  /**
   * Load a CRASH-RECOVERED buffer into the registry (recover-on-startup).
   * The recovered text is the buffer's unsaved state at crash time; it must
   * present as DIRTY relative to disk so the user knows it needs saving — so
   * the saved-text baseline is set to the on-disk content (the recovered text
   * differs from it by exactly the lost edits), via the optional
   * `diskBaseline`. When the on-disk content is unknown, the baseline is left
   * differing (empty) so the buffer is conservatively marked modified. Does
   * NOT switch any client; the server lists/surfaces recovered buffers. Returns
   * the new buffer id.
   *
   * @param {{ name?: string, filePath?: string|null, text: string, diskBaseline?: string }} rec
   * @returns {string}
   */
  function recoverBuffer(rec) {
    const text = String(rec.text ?? '');
    const name = rec.name || 'recovered';
    const filePath = typeof rec.filePath === 'string' && rec.filePath !== ''
      ? rec.filePath
      : null;
    const entry = registry.add(text, name, filePath);
    // Baseline = on-disk content when known, else a value that differs from
    // the recovered text (so the buffer reads as modified / shows ●).
    if (typeof rec.diskBaseline === 'string') {
      entry.savedText = rec.diskBaseline;
    } else {
      entry.savedText = text === '' ? ' ' : '';
    }
    return entry.id;
  }

  // --- save (real disk write, atomic) -----------------------------------
  //
  // save-buffer writes the ACTIVE buffer's text to its file path via the
  // saveFile effect (the server does the atomic temp-file + rename); on
  // success the saved-text baseline is re-set so the ● dirty flag clears.

  /**
   * Save the active buffer to its file path. Returns a status string the
   * Lisp command branches on:
   *   - "no-path" — the buffer has no path (a new/scratch buffer); the
   *     command falls back to write-file (prompt for a path).
   *   - "ok"      — the bytes were written and the baseline re-set (clean).
   *   - "error"   — the disk write failed (the error is surfaced as status).
   *
   * @returns {"ok" | "no-path" | "error"}
   */
  function saveActiveBuffer() {
    if (!activeEntry.filePath) return 'no-path';
    return writeActiveBufferTo(activeEntry.filePath);
  }

  /**
   * Write the active buffer's text to PATH (atomic), rebind the buffer's
   * file path to it, and re-baseline the saved text. Used by save-buffer
   * (to the existing path) and write-file / save-as (to a new path).
   *
   * @param {string} path - The destination path.
   * @returns {"ok" | "error"}
   */
  function writeActiveBufferTo(path) {
    const target = String(path ?? '').trim();
    if (target === '') {
      statusText = 'write-file: no path given';
      onStatus(statusText);
      return 'error';
    }
    const text = buffer.text;
    let result;
    try {
      result = saveFile({ path: target, text });
    } catch (error) {
      result = { ok: false, error: error && error.message };
    }
    if (!result || !result.ok) {
      statusText = `Save failed: ${(result && result.error) || 'unknown error'}`;
      onStatus(statusText);
      return 'error';
    }
    // The disk now matches the buffer: bind the path + re-baseline so the
    // dirty flag clears, mirroring the real app's saved-baseline reset.
    registry.setFilePath(activeEntry, target);
    registry.markSaved(activeEntry);
    statusText = `Wrote ${activeEntry.buffer.name}`;
    onStatus(statusText);
    return 'ok';
  }

  // --- multi-buffer / multi-window window-state (the Model-B payoff) ----
  //
  // The server holds N buffers and serves N clients/windows. Each window owns
  // a PANE TREE (paneModels); the buffer a window currently edits is its
  // FOCUSED leaf's buffer. A leaf keeps its OWN view (point/mark/scroll) over
  // the buffer, so two leaves on the same buffer have independent cursors —
  // and so do two windows. Before processing a client's intent the server
  // makes that client active (setActiveClient), which binds the interpreter
  // to the client's focused leaf's buffer + that leaf's view.

  /** The client index the server is currently serving (so a command's effect
   *  — kill-buffer, list-buffers, split-window — targets the right window). */
  let activeClientIndex = 0;

  /** Register a new client/window. Its pane tree starts as a single leaf on
   *  the SAME buffer client 0 booted on (the seed buffer). Returns its index. */
  function addClientView() {
    const index = clientIndices.size; // next free index (0,1,2,…)
    clientIndices.add(index);
    const startId = paneModels.get(0)?.focusedBufferId() ?? initialEntry.id;
    makePaneModel(index, startId);
    return index;
  }

  /** The buffer entry the FOCUSED leaf of client INDEX shows (defaults to the
   *  seed buffer if somehow unset). */
  function entryForClient(index) {
    const id = paneModels.get(index)?.focusedBufferId() ?? initialEntry.id;
    return registry.get(id) ?? initialEntry;
  }

  /** Make client INDEX active: bind the interpreter to its FOCUSED leaf's
   *  buffer + that leaf's view. Subsequent handleKey/runCommand/overlay/pane
   *  primitives operate on this window's focused pane + buffer. */
  function setActiveClient(index) {
    if (!clientIndices.has(index)) return;
    activeClientIndex = index;
    const model = paneModels.get(index);
    const entry = entryForClient(index);
    // Bind the FOCUSED leaf's own view (its per-pane cursor over the buffer).
    const v = (model && model.focusedView()) || registry.viewFor(entry.id, index);
    bindActive(entry, v);
    // The major mode is a property of the buffer; re-derive it so the
    // mode-keymap chain resolves against THIS buffer's mode (a markdown
    // buffer's C-c, a .js buffer's global C-c, …).
    interpreter.call('-spine-choose-major-mode');
  }

  /**
   * Switch a client's FOCUSED pane to buffer ID. Re-points the focused leaf
   * (minting its view over the new buffer), binds the interpreter (if this is
   * the active client), re-derives the major mode, and raises onBufferSwitched
   * so the server re-snapshots the client onto its new buffer. Returns true on
   * success.
   *
   * @param {number} index - The client to switch.
   * @param {string} id - The target buffer id.
   * @returns {boolean}
   */
  function switchClientToBuffer(index, id) {
    if (!registry.has(id)) return false;
    const model = paneModels.get(index);
    if (model) {
      // Point the focused leaf at the new buffer (re-mints its leaf view).
      const wasActive = index === activeClientIndex;
      if (!wasActive) activeClientIndex = index; // setFocusedBuffer affects the focused leaf
      model.setFocusedBuffer(id);
      activeClientIndex = wasActive ? index : activeClientIndex;
    }
    if (index === activeClientIndex) {
      const entry = registry.get(id);
      const v = (model && model.focusedView()) || registry.viewFor(id, index);
      bindActive(entry, v);
      interpreter.call('-spine-choose-major-mode');
    }
    onBufferSwitched(id);
    return true;
  }

  /** Resolve a buffer NAME to its id (the C-x b switch path), or null. */
  function bufferIdByName(name) {
    const entry = registry.findByName(name);
    return entry ? entry.id : null;
  }

  /** The buffer id the FOCUSED leaf of client INDEX shows. */
  function currentBufferIdOf(index) {
    return paneModels.get(index)?.focusedBufferId() ?? initialEntry.id;
  }

  /** The buffer-list ROW-PROVIDER for the generic picker (G0b): the open
   *  buffers as picker rows for the ACTIVE client. Each row's `value` is the
   *  buffer id (what an on-choose switch needs); `label` the name; `meta` a
   *  "Nl ●/–" line-count + dirty flag; `current` marks the window's buffer.
   *  Pure data, no L2 objects — the wire shape `normalisePickerRequest` wants. */
  function bufferListRows() {
    const currentId = currentBufferIdOf(activeClientIndex);
    return registry.listRecords().map((r) => ({
      label: r.name,
      value: r.id,
      meta: `${r.lineCount}L ${r.modified ? '●' : '–'}`,
      current: r.id === currentId,
    }));
  }

  /** Every buffer id any leaf of client INDEX shows (a window may have several
   *  panes on different buffers). Used by the kill-buffer re-home: a window is
   *  "affected" if ANY of its panes shows the killed buffer. */
  function buffersShownByClient(index) {
    const model = paneModels.get(index);
    if (!model) return [];
    return model.leaves()
      .map((l) => model.stateOf(l.id)?.bufferId)
      .filter((id) => id != null);
  }

  /** Kill the ACTIVE client's focused buffer, switching every pane (in any
   *  window) showing it to another buffer. Refuses to kill the last buffer
   *  (the registry guard). Called by the kill-current-buffer! primitive. */
  function killActiveBuffer() {
    const index = activeClientIndex;
    const killedId = currentBufferIdOf(index);
    if (registry.count() <= 1) {
      statusText = 'kill-buffer: refusing to kill the only buffer';
      onStatus(statusText);
      return;
    }
    // Pick a survivor buffer (any other than the one being killed).
    const survivor = registry.list().find((e) => e.id !== killedId);
    if (!survivor) return;
    registry.remove(killedId);
    // Re-home EVERY pane (across all windows) showing the killed buffer onto
    // the survivor. A window is affected if its focused pane showed it (the
    // simple, tested re-home path: re-point the focused leaf + re-sync).
    for (const [ci, model] of paneModels) {
      for (const leaf of model.leaves()) {
        if (model.stateOf(leaf.id)?.bufferId === killedId) {
          model.focusPane(leaf.id);
          switchClientToBuffer(ci, survivor.id);
        }
      }
    }
    statusText = `Killed buffer; switched to ${survivor.buffer.name}`;
    onStatus(statusText);
  }

  /** The current (active) buffer's major-mode display name (e.g. "Markdown"),
   *  for the modeline. Model-side: the server chose the mode from the
   *  buffer name (choose-major-mode!), so it owns this. */
  function majorModeName() {
    try {
      const name = interpreter.call('major-mode-name');
      return typeof name === 'string' ? name : '';
    } catch {
      return '';
    }
  }

  /** The major-mode display name a SPECIFIC buffer entry would show. The
   *  major mode is a property of the buffer (derived from its name), but the
   *  interpreter only knows the mode of the ACTIVE view — so we briefly bind
   *  the entry, derive its mode, read the name, then restore the active
   *  binding. Read-only (no buffer text touched), so the round-trip is safe.
   *  This keeps a window's modeline mode correct even when another window on
   *  a different buffer is the active one. */
  function majorModeNameFor(entry, v) {
    if (entry === activeEntry) return majorModeName();
    const savedEntry = activeEntry;
    const savedView = view;
    bindActive(entry, v);
    try {
      interpreter.call('-spine-choose-major-mode');
      return majorModeName();
    } catch {
      return '';
    } finally {
      bindActive(savedEntry, savedView);
      interpreter.call('-spine-choose-major-mode');
    }
  }

  /** The FOCUSED leaf's view of client INDEX — the view its keyboard edits
   *  (the per-pane cursor over the focused buffer). Falls back to the
   *  registry/active view if a pane model is somehow missing. */
  function focusedViewOf(index) {
    const model = paneModels.get(index);
    if (model) {
      const v = model.focusedView();
      if (v) return v;
    }
    const entry = entryForClient(index);
    return registry.viewFor(entry.id, index) ?? view;
  }

  /** The view-state of a specific client (the point/mark of its FOCUSED pane
   *  over that pane's buffer). Reads the focused leaf's buffer + view, so two
   *  windows — or two panes — on different buffers report different
   *  modelines. */
  function viewStateOf(index) {
    const entry = entryForClient(index);
    const buf = entry.buffer;
    const v = focusedViewOf(index);
    const { line, column } = buf.positionAt(v.point);
    const modified = buf.text !== entry.savedText;
    return {
      point: v.point,
      mark: v.mark,
      name: buf.name,
      modeline: renderModeline({
        name: buf.name, modified, line: line + 1, column,
        mode: majorModeNameFor(entry, v),
      }),
      status: statusText,
      modified,
    };
  }

  /** A client's FULL cursor set (the primary + every secondary) for its
   *  FOCUSED pane, as plain `[{point, mark}]` — the shape the renderer's
   *  getCursors() returns. The multi-cursor commands build the set on the
   *  active client's view; this surfaces it for the CURSORS message so the
   *  renderer paints every caret. */
  function cursorsOf(index) {
    const v = focusedViewOf(index);
    const cs = Array.isArray(v.cursors) && v.cursors.length
      ? v.cursors
      : [{ point: v.point, mark: v.mark ?? null }];
    return cs.map((c) => ({ point: c.point, mark: c.mark ?? null }));
  }

  /** How many cursors the active client's view has (≥1). The server uses
   *  this to decide a single delta vs a RESYNC after an edit: a
   *  multi-cursor edit makes several L1 edits but emits one change event,
   *  so it needs a whole-buffer resync to replicate faithfully. */
  function activeCursorCount() {
    return Array.isArray(view.cursors) ? view.cursors.length : 1;
  }

  // --- the keymap dispatch ---------------------------------------------
  //
  // A pared `handle-key` in the server's host (JS), in the SAME shape as
  // production keymap.lisp's `handle-key`: resolve the key in the active
  // map (a prefix stack) or the global map; a nested map starts a chord; a
  // command name runs through the REAL run-command; a bare printable
  // self-inserts. The minibuffer steals keys while a prompt is open (the
  // client handles minibuffer input itself, so the server only sees the
  // resolved submit/cancel — handle-key is not called during a prompt).

  /** The active JS prefix map (a global chord is in progress), or null. */
  let activeMap = null;
  let chordPrefix = '';

  function resetChord() {
    activeMap = null;
    chordPrefix = '';
    if (statusText.endsWith('-')) {
      statusText = '';
      onStatus('');
    }
  }

  /** Is a Lisp key-reader pending (read-next-key, e.g. the math-symbol `)? */
  function keyReaderPending() {
    return interpreter.call('-spine-key-reader-pending?') === true;
  }

  /** Resolve a key through the mode chain (or the active mode-chord). One
   *  of: a command name (string), the boolean-ish marker 'prefix', or
   *  false/nil. Re-entry while a mode-chord is active resolves against it. */
  function resolveMode(key) {
    const result = interpreter.call('-spine-resolve', key);
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && result.name === 'prefix') {
      return 'prefix';
    }
    return null; // nil / unbound
  }

  /** Is a mode-chord (e.g. after C-c) in progress? */
  function modeChordActive() {
    return interpreter.call('-spine-chord-active?') === true;
  }

  /**
   * Dispatch a key. Returns true when the key was handled. Mirrors
   * keymap.lisp's resolution order: a pending key-reader first, then the
   * active chord (mode or global), then — at rest — the buffer's
   * mode-keymap chain, then the spine's global KEYMAP; a bare printable
   * self-inserts.
   *
   * @param {string} key - A normalised key string (keyEventToString name).
   * @returns {boolean}
   */
  function handleKey(key) {
    // 1. A pending key-reader (read-next-key) steals the key.
    if (keyReaderPending()) {
      interpreter.call('-spine-take-key-reader', key);
      return true;
    }

    // 2. Mid mode-chord (e.g. C-c then b): resolve against the stashed map.
    if (modeChordActive()) {
      const r = resolveMode(key);
      if (r === 'prefix') {
        chordPrefix = `${chordPrefix} ${key}`;
        statusText = `${chordPrefix}-`;
        onStatus(statusText);
        return true;
      }
      // Either a command or unbound — the chord ends.
      if (statusText.endsWith('-')) { statusText = ''; onStatus(''); }
      chordPrefix = '';
      if (typeof r === 'string') runCommand(r);
      return true;
    }

    // 3. Mid global chord (e.g. C-x then C-f).
    if (activeMap !== null) {
      const binding = activeMap[key];
      if (binding && typeof binding === 'object') {
        activeMap = binding;
        chordPrefix = `${chordPrefix} ${key}`;
        statusText = `${chordPrefix}-`;
        onStatus(statusText);
        return true;
      }
      if (typeof binding === 'string') {
        resetChord();
        runCommand(binding);
        return true;
      }
      resetChord(); // unbound mid-chord: abort cleanly
      return true;
    }

    // 4. At rest — try the buffer's mode-keymap chain first (so a mode's
    //    bindings, e.g. Markdown C-c b, win over the global table).
    const modeResult = resolveMode(key);
    if (modeResult === 'prefix') {
      chordPrefix = key;
      statusText = `${chordPrefix}-`;
      onStatus(statusText);
      return true;
    }
    if (typeof modeResult === 'string') {
      runCommand(modeResult);
      return true;
    }

    // 5. The spine's global KEYMAP (motion / editing / kill-yank / …).
    let binding = KEYMAP[key];
    if (key === 'C-x') binding = CX_MAP;
    // The global C-c prefix (multi-cursor) — only reached when no major
    // mode claimed C-c above (step 4). In Markdown, the mode map wins.
    if (key === 'C-c') binding = CC_MAP;
    if (binding && typeof binding === 'object') {
      activeMap = binding;
      chordPrefix = key;
      statusText = `${chordPrefix}-`;
      onStatus(statusText);
      return true;
    }
    if (typeof binding === 'string') {
      runCommand(binding);
      return true;
    }

    // 6. At rest, unbound: self-insert a bare printable. Route the
    //    *last-command* update through it too (the yank-pop subtlety —
    //    see PRIMITIVE-SPLIT.md): typing must invalidate a pending yank.
    if (typeof key === 'string' && [...key].length === 1) {
      interpreter.evaluate("(set! *last-command* 'self-insert)");
      buffer.insert(key);
      return true;
    }
    return false;
  }

  // Did the last dispatched command perform an undo or redo? A change-group
  // undo emits SEVERAL L1 edits but only ONE L2 change event, so the single
  // forwarded delta can't replicate it on the client mirror (proven: it
  // desyncs). The server therefore RESYNCs (full text + cursors) after an
  // undo/redo, exactly as it does for a multi-cursor edit. This flag tells it
  // an undo/redo just ran; the server reads-and-clears it via consumeHistoryOp.
  let lastWasHistoryOp = false;

  /** Run a command by name through the REAL run-command. A name that needs
   *  interactive args (a minibuffer prompt) suspends inside run-command;
   *  the prompt is delivered later via deliverMinibuffer. */
  function runCommand(name) {
    if (name === 'undo' || name === 'redo') lastWasHistoryOp = true;
    interpreter.evaluate(`(run-command (quote ${name}))`);
  }

  /**
   * Apply a PANE_INTENT from a client: a structural request (split / focus /
   * delete / resize). Most map 1:1 onto the REAL panes.lisp commands run
   * through `run-command` against the active window's logical tree — the same
   * commands C-x 2 / 3 / o / 0 / 1 dispatch — so the wire intent and the key
   * path share one implementation. FOCUS_PANE / RESIZE are direct model ops
   * (no Lisp command exists for "focus this exact leaf by id" / "the user
   * dragged this splitter"). The intent runs against client INDEX's window;
   * the active client is set first so the pane primitives target it.
   *
   * @param {number} index - The client/window the intent targets.
   * @param {{ op: string, paneId?: string, ratio?: number }} intent
   * @returns {boolean} Whether the op was recognised.
   */
  function applyPaneIntent(index, intent) {
    if (!intent || typeof intent !== 'object') return false;
    if (!paneModels.has(index)) return false;
    setActiveClient(index); // the pane primitives mutate the active window
    const model = paneModels.get(index);
    switch (intent.op) {
      case 'split-below':
        runCommand('split-vertical');
        return true;
      case 'split-right':
        runCommand('split-horizontal');
        return true;
      case 'other-window':
        runCommand('other-pane');
        return true;
      case 'delete-window':
        runCommand('delete-pane');
        return true;
      case 'delete-other-windows':
        runCommand('delete-other-panes');
        return true;
      case 'focus-pane':
        // A client click: focus a specific leaf by id, then rebind so the
        // next edit lands in it.
        if (model.focusPane(String(intent.paneId ?? ''))) {
          setActiveClient(index);
          return true;
        }
        return false;
      case 'resize':
        // The client owns the pixels; it echoes the new ratio up so the
        // logical tree records the user's chosen split.
        return model.setSplitRatio(String(intent.paneId ?? ''), Number(intent.ratio));
      default:
        return false;
    }
  }

  /** Read-and-clear the "last dispatch was an undo/redo" flag. The server
   *  calls this after each intent to decide whether to RESYNC (a change-group
   *  undo's single delta is insufficient — see lastWasHistoryOp). */
  function consumeHistoryOp() {
    const was = lastWasHistoryOp;
    lastWasHistoryOp = false;
    return was;
  }

  /** Deliver a minibuffer result to the suspended command (commands.lisp's
   *  `minibuffer-delivered`). Pass null to cancel. Resumes the command's
   *  continuation, which may itself open the next prompt (a chained
   *  interactive spec, e.g. replace-string). */
  function deliverMinibuffer(value) {
    activePrompt = null;
    onMinibufferClose();
    if (value === null) {
      interpreter.evaluate('(minibuffer-delivered nil)');
    } else {
      interpreter.evaluate(
        `(minibuffer-delivered ${JSON.stringify(String(value))})`
      );
    }
  }

  /** Abort the suspended command WITHOUT resuming its body, and close the
   *  prompt. Used when the host fulfils the prompt itself (M-x, find-file):
   *  the command's body is a no-op placeholder, so we drop the
   *  continuation and let the host act. */
  function abortMinibuffer() {
    activePrompt = null;
    onMinibufferClose();
    // Drop the pending continuation in the interpreter so a later
    // (minibuffer-delivered …) can't accidentally resume it.
    interpreter.evaluate('(set! *minibuffer-reader* nil)');
  }

  /** Deliver a generic-picker choice to the suspended command (the spine's
   *  `picker-delivered`, defined in Lisp above), the minibuffer's twin. VALUE
   *  is the chosen row's value (a string/number/boolean — a buffer id, a
   *  command name, a recovery key, …); pass null to CANCEL (the continuation
   *  resumes with nil, so the command does nothing). PICKERID guards against a
   *  stale reply: a choice whose id no longer matches the open picker is
   *  dropped (the picker was superseded by another). Returns whether the reply
   *  was applied. */
  function deliverPicker(value, pickerId) {
    // A reply for a picker that is no longer open (or a different one) is
    // stale — ignore it so it can't resume the wrong command.
    if (!activePicker) return false;
    if (pickerId != null && pickerId !== activePicker.id) return false;
    activePicker = null;
    if (value === null || value === undefined) {
      interpreter.evaluate('(picker-delivered nil)');
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      interpreter.evaluate(`(picker-delivered ${JSON.stringify(value)})`);
    } else {
      interpreter.evaluate(`(picker-delivered ${JSON.stringify(String(value))})`);
    }
    return true;
  }

  /** Cancel the open picker WITHOUT a choice: resume the suspended command's
   *  continuation with nil (so it does nothing) and clear the active picker.
   *  The Escape / C-g path. PICKERID guards against a stale cancel. */
  function cancelPicker(pickerId) {
    return deliverPicker(null, pickerId);
  }

  // --- view-state snapshot ---------------------------------------------
  /** The current point's 1-based line and 0-based column. */
  function pointPosition() {
    const { line, column } = buffer.positionAt(buffer.point);
    return { line: line + 1, column };
  }

  /** A fresh view-state object (protocol ViewState) for the active client.
   *  The modeline is rendered by the shared pure helper in protocol.js, so
   *  the server and any future client agree on its shape. */
  function viewState() {
    const { line, column } = pointPosition();
    const modified = buffer.text !== activeEntry.savedText;
    return {
      point: buffer.point,
      mark: buffer.mark,
      name: buffer.name,
      modeline: renderModeline({
        name: buffer.name, modified, line, column, mode: majorModeName(),
      }),
      status: statusText,
      modified,
    };
  }

  /** @typedef {object} Spine */
  return {
    /** The canonical L2 buffer (read-only access for the server). */
    get buffer() {
      return buffer;
    },
    /** The current view (window-state owner). */
    get view() {
      return view;
    },
    get interpreter() {
      return interpreter;
    },
    handleKey,
    runCommand,
    consumeHistoryOp,
    commandNames,
    deliverMinibuffer,
    abortMinibuffer,
    // the generic picker round-trip (G0b): resolve / cancel the open picker.
    deliverPicker,
    cancelPicker,
    visitFile,
    recoverBuffer,
    // save (real disk write) — the server wires saveFile to atomicWrite.
    saveActiveBuffer,
    writeActiveBufferTo,
    /** The active buffer's file path (where C-x C-s writes), or null. */
    get activeFilePath() {
      return activeEntry.filePath;
    },
    /** Whether the active buffer has unsaved edits (drives the ● flag). */
    get activeModified() {
      return registry.isModified(activeEntry);
    },
    /** Plain snapshots of every buffer with unsaved edits, for autosave:
     *  `[{ id, name, filePath, text }]`. Pure data (no L2 objects), so the
     *  server can write each to a recovery file without holding the buffer. */
    dirtyBufferSnapshots() {
      return registry.dirtyEntries().map((e) => ({
        id: e.id,
        name: e.buffer.name,
        filePath: e.filePath,
        text: e.buffer.text,
      }));
    },
    viewState,
    pointPosition,
    // multi-client window-state (per-client buffer + cursor)
    addClientView,
    setActiveClient,
    viewStateOf,
    // --- the pane tree (G0a) -------------------------------------------
    /** The PANE_TREE wire snapshot of client INDEX's window layout (the split
     *  structure + per-leaf buffer/view-state + the focused leaf; no pixels).
     *  The server pushes this on HELLO + whenever a window's layout changes. */
    paneSnapshot(index) {
      const model = paneModels.get(index);
      return model ? model.snapshot() : null;
    },
    /** The pane model of client INDEX (introspection: tests + the server). */
    paneModelOf(index) {
      return paneModels.get(index) ?? null;
    },
    /** Record client INDEX's editor-area pixel rectangle (a VIEWPORT-style
     *  report). Only spatial pane navigation needs it; everything else is
     *  pixel-free. `{ width, height }`. */
    setPaneHostRect(index, rect) {
      const model = paneModels.get(index);
      if (model) model.setHostRect(rect);
    },
    /** Apply a PANE_INTENT from client INDEX: a structural request (split /
     *  focus / delete / resize) the server fulfils by running the REAL
     *  panes.lisp command (or a model op) against that window's tree. Returns
     *  true when the intent was recognised. The model's onChange raises
     *  onPaneTree, so the server re-pushes the fresh PANE_TREE. */
    applyPaneIntent(index, intent) {
      return applyPaneIntent(index, intent);
    },
    /** Save the focused leaf's first-visible line for client INDEX (a scroll
     *  report). Per-pane scroll is window-state the leaf owns. */
    setPaneScroll(index, line) {
      const model = paneModels.get(index);
      if (model) {
        const wasActive = activeClientIndex;
        activeClientIndex = index;
        model.setFocusedScroll(line);
        activeClientIndex = wasActive;
      }
    },
    // multi-buffer registry surface
    switchClientToBuffer,
    bufferIdByName,
    currentBufferIdOf,
    killActiveBuffer,
    /** Plain-data buffer-list records (C-x C-b), each tagged with whether
     *  it is the CURRENT buffer of the given client. */
    bufferListRecords(clientIndex) {
      const currentId = currentBufferIdOf(clientIndex);
      return registry.listRecords().map((r) => ({ ...r, current: r.id === currentId }));
    },
    get bufferCount() {
      return registry.count();
    },
    // overlays + multi-cursor over the wire
    cursorsOf,
    activeCursorCount,
    overlaySnapshot,
    overlaySnapshotOf,
    get clientCount() {
      return clientIndices.size;
    },
    /** The active minibuffer prompt label, or null. */
    get activePrompt() {
      return activePrompt;
    },
    /** The open generic-picker request `{ id, title, rows, options }`, or null.
     *  The server reads it on a PICKER_CHOOSE/CANCEL to match the reply (the
     *  pickerId) and to know which client owns the picker. */
    get activePicker() {
      return activePicker;
    },
    get statusText() {
      return statusText;
    },
  };
}
