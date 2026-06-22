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

import { createInterpreter, NIL, listToArray } from '@editor/lisp';
import { createBuffer } from '@editor/buffer';
import { createView } from '@editor/view';
import { createBufferPrimitives } from '@editor/stdlib';

import { renderModeline } from './protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const STDLIB_DIR = join(here, '..', '..', '..', 'packages', 'stdlib', 'lisp');

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
  'search.lisp',
  'markdown.lisp',
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
  // command spine entry points
  'M-x': 'execute-extended-command',
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
  'C-d': 'duplicate-line', // line-ops.lisp (production binds C-x C-d here)
  'C-j': 'join-line', // line-ops.lisp
  k: 'kill-this-buffer-noop',
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
 * @param {(path: string) => { text: string, name: string } | null} [effects.openFile]
 *   - Read a file off disk for find-file. Returns the text + name, or null
 *   on failure. (The server is a Node child, so file I/O is direct —
 *   plan §3 (i).)
 * @returns {Spine}
 */
export function createSpine(options, effects = {}) {
  const onStatus = effects.onStatus ?? (() => {});
  const onMinibufferOpen = effects.onMinibufferOpen ?? (() => {});
  const onMinibufferClose = effects.onMinibufferClose ?? (() => {});
  const onScroll = effects.onScroll ?? (() => {});
  const openFile = effects.openFile ?? (() => null);

  // The canonical buffer + a real view over it. The view owns point/mark
  // (per-client window-state); the buffer owns the text. `bindCursor` (run
  // inside the buffer primitives) routes the buffer's point/mark through
  // the view's cursors. This is exactly production's session shape.
  let buffer = createBuffer(options.initialText ?? '', {
    name: options.name ?? 'mwb-scratch',
  });
  let view = createView({ kind: 'text', buffer, name: buffer.name });
  buffer.bindCursor(view);
  view.point = 0;

  // Every client's view over the SHARED buffer. Index 0 is the default
  // (single-client) view. Two windows on one buffer share the text but each
  // keep their own point/mark (plan §4 "per-window vs per-buffer state").
  // `bindCursor` swaps which view's cursors the buffer reads/writes, so
  // before processing a client's intent the server makes that client's view
  // active (setActiveClientView), and motion/edits land on its cursor.
  const clientViews = [view];

  /** The session the buffer primitives operate against. A getter for
   *  `currentView` so a find-file can swap the buffer/view underneath and a
   *  multi-client server can swap the active client's view. */
  const session = {
    get currentView() {
      return view;
    },
  };

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

  // --- the modeline modified flag --------------------------------------
  // The buffer's text differs from what was last loaded/saved.
  let savedText = options.initialText ?? '';

  // --- the server-local clipboard (kill.lisp's interprogram edge) ------
  // STUB: an in-memory clipboard, so the kill ring round-trips fully
  // without an OS clipboard (which a headless Node child lacks). See
  // PRIMITIVE-SPLIT.md "Kill ring".
  let clipboardText = '';


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
  `);

  // Load the real command system + editing commands + the model-heavy
  // slice (see SPINE_STDLIB) verbatim from disk — the same source the
  // production editor runs.
  for (const file of SPINE_STDLIB) {
    const source = readFileSync(join(STDLIB_DIR, file), 'utf8');
    interpreter.evaluate(source);
  }

  // A couple of spine-level commands defined in Lisp on top of the real
  // command system: the M-x entry point and a minimal find-file. These run
  // through the same `run-command`/`defcommand` machinery as everything
  // else — they are real commands, not host shims.
  interpreter.evaluate(`
    ;; M-x — prompt for a command name, then run it. The host completes
    ;; the prompt (it has the command list); on submit the host calls
    ;; (run-command (quote NAME)) directly, so this command's body just
    ;; opens the prompt with a marker the host recognises.
    (defcommand execute-extended-command ()
      "Read a command name in the minibuffer and run it (M-x)."
      (interactive (string "M-x "))
      ;; The argument IS the chosen command name (the host resolved it).
      (lambda (name) name))

    ;; A no-op so the C-x k binding resolves without a real buffer-kill.
    (defcommand kill-this-buffer-noop ()
      "Placeholder for C-x k in the spine (no buffer list yet).")

    ;; save-buffer: the spine has no file path wired for the scratch
    ;; buffer; report it rather than silently doing nothing.
    (defcommand save-buffer ()
      "Save the current buffer (spine stub: reports, does not write)."
      (show-status! "save-buffer: (spine stub — no path)"))

    ;; set-mark-command: start a selection at point.
    (defcommand set-mark-command ()
      "Set the mark at point, starting a selection (C-space)."
      (set-mark!)
      (show-status! "Mark set"))
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
   * Visit a file: read it (via the openFile effect) and swap the canonical
   * buffer + view to it. The server fans a fresh SNAPSHOT to the client
   * after this. Returns true on success.
   *
   * @param {string} path - An absolute path.
   * @returns {boolean}
   */
  function visitFile(path) {
    const result = openFile(path);
    if (!result) {
      statusText = `find-file: cannot open ${path}`;
      onStatus(statusText);
      return false;
    }
    buffer = createBuffer(result.text, { name: result.name });
    // Rebuild every client's view over the new shared buffer, preserving the
    // number of clients (each keeps its own cursor, reset to start).
    const n = clientViews.length;
    clientViews.length = 0;
    for (let i = 0; i < n; i += 1) {
      const v = createView({ kind: 'text', buffer, name: buffer.name });
      v.point = 0;
      clientViews.push(v);
    }
    view = clientViews[0];
    buffer.bindCursor(view);
    // Re-derive the major mode for the new buffer's name (so a visited
    // .md gets markdown-mode, etc., and its mode keymap dispatches).
    interpreter.call('-spine-choose-major-mode');
    savedText = result.text;
    statusText = '';
    onStatus('');
    return true;
  }

  // --- multi-client window-state (the Model-B payoff) -------------------
  //
  // Each client gets its OWN view over the shared buffer (its own
  // point/mark/selection); the buffer text is shared. Before processing a
  // client's intent the server makes that client's view active, so motion
  // and edits land on its cursor while every viewer sees the shared text.

  /** Register a new client view over the shared buffer. Returns its index,
   *  used by the server as a client handle. */
  function addClientView() {
    const v = createView({ kind: 'text', buffer, name: buffer.name });
    v.point = 0;
    clientViews.push(v);
    return clientViews.length - 1;
  }

  /** Make client INDEX's view the active one: the buffer's cursor now reads
   *  and writes that client's point/mark. Subsequent handleKey/runCommand
   *  operate on this client's window-state. */
  function setActiveClient(index) {
    if (index < 0 || index >= clientViews.length) return;
    view = clientViews[index];
    buffer.bindCursor(view);
  }

  /** The current buffer's major-mode display name (e.g. "Markdown"),
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

  /** The view-state of a specific client (its own point/mark over the
   *  shared buffer text). */
  function viewStateOf(index) {
    const v = clientViews[index] ?? view;
    const { line, column } = buffer.positionAt(v.point);
    const modified = buffer.text !== savedText;
    return {
      point: v.point,
      mark: v.mark,
      name: buffer.name,
      modeline: renderModeline({
        name: buffer.name, modified, line: line + 1, column,
        mode: majorModeName(),
      }),
      status: statusText,
      modified,
    };
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

  /** Run a command by name through the REAL run-command. A name that needs
   *  interactive args (a minibuffer prompt) suspends inside run-command;
   *  the prompt is delivered later via deliverMinibuffer. */
  function runCommand(name) {
    interpreter.evaluate(`(run-command (quote ${name}))`);
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

  // --- view-state snapshot ---------------------------------------------
  /** The current point's 1-based line and 0-based column. */
  function pointPosition() {
    const { line, column } = buffer.positionAt(buffer.point);
    return { line: line + 1, column };
  }

  /** A fresh view-state object (protocol ViewState) for the client. The
   *  modeline is rendered by the shared pure helper in protocol.js, so the
   *  server and any future client agree on its shape. */
  function viewState() {
    const { line, column } = pointPosition();
    const modified = buffer.text !== savedText;
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
    commandNames,
    deliverMinibuffer,
    abortMinibuffer,
    visitFile,
    viewState,
    pointPosition,
    // multi-client window-state (shared buffer, per-client cursor)
    addClientView,
    setActiveClient,
    viewStateOf,
    get clientCount() {
      return clientViews.length;
    },
    /** The active minibuffer prompt label, or null. */
    get activePrompt() {
      return activePrompt;
    },
    get statusText() {
      return statusText;
    },
  };
}
