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
 * The standard-library files the spine loads. A deliberately small subset
 * of the full STDLIB_FILES: just the command system and the editing
 * commands. The full stdlib pulls in panes/tabline/faces/themes/languages
 * + dozens of renderer-only primitives the server has no business owning
 * yet (those are later phases). This subset is enough to prove the command
 * surface runs server-side against the real machinery.
 */
const SPINE_STDLIB = Object.freeze(['commands.lisp', 'editing.lisp']);

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

  /** The session the buffer primitives operate against. A getter for
   *  `currentView` so a find-file can swap the buffer/view underneath. */
  const session = {
    get currentView() {
      return view;
    },
  };

  // --- the echo area (status line) -------------------------------------
  let statusText = '';

  // --- the modeline modified flag --------------------------------------
  // The buffer's text differs from what was last loaded/saved.
  let savedText = options.initialText ?? '';

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
        onMinibufferOpen(String(args[0] ?? ''));
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

      // `string-repeat` is in the prelude? No — it's a stdlib helper used
      // by `insert-tab`. Provide it so insert-tab works. (Pure; mirrors
      // the stdlib's own definition closely enough for the spine.)
      'string-repeat': (args) => String(args[0] ?? '').repeat(Math.max(0, Number(args[1]) || 0)),
    },
  });

  // Load the real command system + editing commands verbatim.
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
    view = createView({ kind: 'text', buffer, name: buffer.name });
    buffer.bindCursor(view);
    view.point = 0;
    savedText = result.text;
    statusText = '';
    onStatus('');
    return true;
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

  /** The active prefix map (a chord is in progress), or null. */
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

  /**
   * Dispatch a key. Returns true when the key was handled. Mirrors
   * keymap.lisp: prefix → start a chord; command → run it; bare char →
   * self-insert; unbound mid-chord → reset.
   *
   * @param {string} key - A normalised key string (keyEventToString name).
   * @returns {boolean}
   */
  function handleKey(key) {
    const map = activeMap ?? KEYMAP;
    let binding = map[key];
    // C-x is the one prefix the spine knows.
    if (activeMap === null && key === 'C-x') binding = CX_MAP;

    if (binding && typeof binding === 'object') {
      // A prefix: start / extend the chord.
      activeMap = binding;
      chordPrefix = chordPrefix ? `${chordPrefix} ${key}` : key;
      statusText = `${chordPrefix}-`;
      onStatus(statusText);
      return true;
    }
    if (typeof binding === 'string') {
      resetChord();
      runCommand(binding);
      return true;
    }
    if (activeMap !== null) {
      // Mid-chord, nothing bound: abort the sequence.
      resetChord();
      return true;
    }
    // At rest: self-insert a bare printable.
    if (typeof key === 'string' && [...key].length === 1) {
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
   *  `minibuffer-delivered`). Pass null to cancel. */
  function deliverMinibuffer(value) {
    onMinibufferClose();
    if (value === null) {
      interpreter.evaluate('(minibuffer-delivered nil)');
    } else {
      interpreter.evaluate(
        `(minibuffer-delivered ${JSON.stringify(String(value))})`
      );
    }
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
      modeline: renderModeline({ name: buffer.name, modified, line, column }),
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
    visitFile,
    viewState,
    pointPosition,
    get statusText() {
      return statusText;
    },
  };
}
