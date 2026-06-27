/**
 * @file Model-B Phase-0 spike — the client↔server wire protocol.
 *
 * THIS IS FEASIBILITY-SPIKE CODE, not production. It is deliberately
 * isolated from app.js / view.js so the real editor and its test suite
 * are untouched. The goal of the spike is to measure typing latency
 * through a central Lisp server (an Electron `utilityProcess`) with a
 * replicated client mirror + local-echo (plans/MULTI-WINDOW-MODEL-B.md
 * §4, §9 Phase 0).
 *
 * The protocol carries TWO streams (plan §4):
 *   - up   (client → server): key/edit INTENTS, never edits.
 *   - down (server → client): buffer DELTAS + cursor state.
 *
 * A delta reuses Layer 1's existing change shape verbatim
 * (`{ start, removed, inserted }`, see packages/storage/src/buffer.js):
 * the server's L1 buffer emits exactly these on every mutation, so the
 * "delta" is just that event forwarded over the wire. The client applies
 * it to its local string mirror. This module holds the message
 * constructors and the pure delta-apply helper, with no Electron / DOM
 * dependency, so it is unit-testable under `node --test`.
 */

/** Message type tags. Up = client→server, Down = server→client. */
export const MSG = Object.freeze({
  // up
  HELLO: 'hello', // client announces itself, asks for an initial snapshot
  INTENT: 'intent', // a key/edit intent (see INTENT below)
  // up: a pane/window structural request (split/focus/delete/resize). Carries
  // a `{ op, paneId?, ratio? }` (see PANE_INTENT). The server mutates the
  // window's logical pane tree and replies with a fresh PANE_TREE.
  PANE: 'pane',
  // up: the client's editor-area pixel rectangle (a VIEWPORT-style report).
  // ONLY spatial pane navigation (focus-pane-left/right/up/down) needs it; the
  // server keeps the latest per window to compute adjacency. `{ width, height }`.
  PANE_VIEWPORT: 'pane-viewport',
  // up: the client's visible LINE count for the focused server-view (plan §5d,
  // the measurement conversation's hard direction — only the client knows how
  // many text lines fit). Sent on mount + on resize. The server stores it per
  // client and uses it for screenful scroll (C-v/M-v) + recenter. `{ lines }`.
  VIEWPORT: 'viewport',
  // up: a TAB-completion request for the open minibuffer prompt. The client
  // sends the current input `{ value }`; the server (which owns the prompt +
  // the filesystem) computes the completion and replies with
  // MINIBUFFER_COMPLETIONS. Used for find-file path completion (case-insensitive).
  MINIBUFFER_COMPLETE: 'minibuffer-complete',
  // down
  SNAPSHOT: 'snapshot', // full buffer text + cursor (initial sync / resync)
  DELTA: 'delta', // an applied buffer change + resulting cursor
  CURSOR: 'cursor', // a point/mark update with no text change (motion)
  // The command-spine view-update channel (server → client): the non-text
  // render state a command can change without editing the buffer — the
  // cursor, the modeline string, the echo-area status, and the minibuffer
  // prompt state. Sent after any intent that changed view-state. (plan §4:
  // "Down: cursor/selection, modeline, minibuffer state, status messages".)
  VIEW: 'view',
  // The overlay + multi-cursor sync channel (server → client). These carry
  // the buffer's OVERLAYS (ranges with a face — search highlights, snippet
  // fields, secondary-cursor decorations) and a client's full CURSOR SET
  // (the primary + every secondary cursor). The real `view.js` renders both
  // from the synced mirror — overlays via its `getDecorations()` option and
  // multi-cursor via its `getCursors()` option — with no view.js change.
  OVERLAYS: 'overlays', // the buffer's overlay list (shared across clients)
  CURSORS: 'cursors', // a client's full cursor set (per-client window-state)
  // A whole-buffer RESYNC: the text + this client's cursor set, sent when a
  // single forwarded DELTA cannot faithfully replicate the edit. The L2
  // buffer applies a MULTI-CURSOR insert/delete as SEVERAL low-level L1
  // edits but emits only ONE change event (the last sub-edit), so the
  // single-delta path would diverge the mirror. For a multi-cursor edit the
  // server therefore sends a RESYNC instead — correct and simple; the fast
  // single-cursor delta path is untouched (no typing-latency regression).
  RESYNC: 'resync',
  // The buffer-list channel (server → client): a plain-data record per
  // server-held buffer (id, name, lineCount, modified, current), sent when
  // a client runs list-buffers (C-x C-b). The client renders the buffer
  // list. This is the multi-buffer counterpart of the production
  // *View List* — the server holds the buffers, so it owns the records.
  BUFFER_LIST: 'buffer-list',
  // --- the pane/window structural channel (G0a) ----------------------
  // The server owns each window's LOGICAL pane tree (the binary split
  // structure + which buffer + view-state per leaf + which leaf is
  // focused). The client owns the PIXELS (how wide each split is, where
  // the splitter handle sits). PANE_TREE is the server pushing the
  // window's current layout DOWN; the client renders nested split
  // containers and mounts one real view.js per leaf. Sent on HELLO and
  // whenever the layout or focus changes (split / delete / other-window).
  // The wire shape is a plain serialisation of the tree — no pixels, only
  // the structure + ratios (the *intended* relative sizes; the client may
  // honour them or impose its own and echo a resize back). See
  // serializePaneTree below for the exact node shape.
  PANE_TREE: 'pane-tree',
  // down: the reply to MINIBUFFER_COMPLETE — `{ value, items, directory }`. The
  // client sets the minibuffer to the completed `value` (the longest common
  // prefix, or a unique full match) and shows `items` (the candidate display
  // names, directories with a trailing '/') in the completions panel; `directory`
  // is the typed path prefix the items are relative to (for click-to-complete).
  MINIBUFFER_COMPLETIONS: 'minibuffer-completions',
  // --- window lifecycle (G4) -----------------------------------------
  // The server asks the ACTIVE client to open another window onto the shared
  // server — the effect of the `new-window` command (the C-x 5 2 chord, which
  // the server's keymap resolves). The server can't open an OS window; it
  // emits this and the client asks its host (host.newWindow() → main), which
  // creates the window + attaches it as a new client. Window lifecycle is the
  // client/host's half of the split (cf. C-x C-c quit), command-triggered.
  WINDOW_NEW: 'window-new',
  // Session restore (slice B2) — window geometry. The client reports its window
  // frame + the display it is on (WINDOW_BOUNDS, up) so the server can record it
  // in the session snapshot; on restore the server hands a saved frame back down
  // (SET_WINDOW_BOUNDS) for window 1, and threads it into WINDOW_NEW for spawned
  // windows. Main reconciles the saved frame against the CURRENT displays
  // (window-geometry.js) before applying — it owns `screen`, the client doesn't.
  WINDOW_BOUNDS: 'window-bounds',
  SET_WINDOW_BOUNDS: 'set-window-bounds',
  // Workspace manager (slice C2). The client asks the server to SAVE the live
  // multi-window arrangement under a label (the quit "Remember this workspace?"
  // prompt), or to DELETE a named workspace (from the chooser). Saves the
  // ARRANGEMENT — panes/files/cursors/geometry — never document content.
  SESSION_SAVE: 'session-save',
  SESSION_DELETE: 'session-delete',
  // Per-window REPL / utility-dock visibility (part of the workspace, but it's
  // renderer CHROME, not in the pane tree). The client reports it (WINDOW_DOCK,
  // up) so the session records it; on restore the server sends it back down
  // (SET_DOCK) and the client re-shows/hides the dock. `{ visible }`.
  WINDOW_DOCK: 'window-dock',
  SET_DOCK: 'set-dock',
  // --- the generic render-side picker channel (G0b) ------------------
  // A server command SUSPENDS and asks the client to pick a row from a
  // list — the buffer list, *Recover*, completions, RefTeX select, cite:
  // all the same shape (the server holds rows of data; the client renders
  // an interactive list; one selection comes back up). This is the SINGLE
  // reusable channel that collapses five bespoke picker slices into one
  // mechanism + five row-providers (plan §2.2.3). It is modelled on the
  // minibuffer round-trip — a Lisp continuation suspends, the host shows
  // the UI, a choice resumes it (commands.lisp `picker-read`/
  // `picker-delivered`). PICKER is the server pushing the request DOWN;
  // PICKER_CHOOSE / PICKER_CANCEL come back UP (see INTENT). The wire shape
  // is `{ id, title, rows: [{ label, ...rowData }], options }` — see
  // normalisePickerRequest below. The client owns ALL of the picker's
  // interaction (type-to-narrow, keyboard nav, click) and sends back only
  // the chosen row's `value` (or a cancel).
  PICKER: 'picker',
  // --- client-owned commands + element-views (renderer-driven views) ---
  // up: the client announces the command names the RENDERER owns — commands
  // that must run client-side because their spec is computed there (the
  // element-view commands from `define-element-view`, including user-defined
  // ones in init.lisp). Sent once after connect. The server merges them into
  // its M-x command set and routes them back DOWN via RUN_CLIENT_COMMAND.
  CLIENT_COMMANDS: 'client-commands',
  // down: the server asks the active client to RUN one of its own (renderer)
  // commands by name — the M-x dispatch of a client-owned command. The client
  // runs it in the renderer interpreter (where the spec is computed).
  RUN_CLIENT_COMMAND: 'run-client-command',
  // up: the renderer's `open-element-view!` asks the server to create an
  // `element` DATA-SOURCE from a computed spec ({ tag, moduleUrl, attrs, fit,
  // keyboard, noFocus, name }). The server holds it like any data-source (a
  // pane slot + restore); the client mounts <element-view> from the spec.
  OPEN_ELEMENT_SOURCE: 'open-element-source',
  // down: a customize setting changed in ONE window — re-apply it in every OTHER
  // window so theme / faces / variables stay consistent across windows. Carries
  // the change `{ op, name?, value?, face?, attr? }`; the server relays it (it
  // doesn't render). The originating window already applied it locally; the
  // receivers update their interpreter + re-apply theme + face styles.
  CUSTOMIZE_SYNC: 'customize-sync',
  // down: the result of a JS notebook cell evaluated in the spine's Node context
  // (the renderer can't eval — CSP forbids unsafe-eval). Carries `{ reqId,
  // result }` where result is a SERIALIZABLE { state, descriptor, logs, error };
  // the client matches reqId to the pending run and materializes the descriptor.
  NOTEBOOK_RESULT: 'notebook-result',
});

/** Intent kinds the client sends up. The client sends WHAT IT WANTS,
 *  the server decides and replies with deltas (plan §4). */
export const INTENT = Object.freeze({
  SELF_INSERT: 'self-insert', // insert a printable string at point
  DELETE_BACKWARD: 'delete-backward', // backspace
  POINT: 'point', // set the cursor offset (window-state)
  KEY: 'key', // a named key string routed through the Lisp keymap
  // Minibuffer round-trip (the command spine). When a server-side command
  // prompts (e.g. M-x, find-file), the server sends a VIEW message whose
  // `minibuffer` is active; the client shows the prompt and the user's
  // input/submit/cancel come back up as these intents. The server resumes
  // the suspended command's continuation (`minibuffer-delivered`).
  MINIBUFFER_CHANGE: 'minibuffer-change', // the value being typed changed
  MINIBUFFER_SUBMIT: 'minibuffer-submit', // RET — deliver the value
  MINIBUFFER_CANCEL: 'minibuffer-cancel', // C-g / Esc — cancel the prompt
  // Multi-buffer: a client asks to switch its window to another buffer,
  // directly (clicking a buffer-list row) rather than via the C-x b
  // minibuffer prompt. The server switches this client and re-snapshots it
  // onto the target buffer. `bufferId` or `bufferName` identifies the target.
  SWITCH_BUFFER: 'switch-buffer',
  // A file opened by PATH directly (no minibuffer) — a file clicked in a
  // directory-view (directory-tree / directory-columns). The server runs the
  // same `visitFile` find-file opens use; `path` is the absolute file path.
  VISIT_FILE: 'visit-file',
  // Generic picker round-trip (the command spine, G0b). When a server-side
  // command suspends on a PICKER (open-picker! → a PICKER down-message),
  // the client renders the interactive list and the user's choice/cancel
  // comes back up as these. The server resumes the suspended command's
  // continuation (commands.lisp `picker-delivered`). PICKER_CHOOSE carries
  // the chosen row's `value` (the opaque token the row-provider attached);
  // PICKER_CANCEL resumes with nil (the command does nothing). Both carry
  // the picker `pickerId` so a stale reply (the picker was superseded) is
  // dropped. This is the exact parallel of MINIBUFFER_SUBMIT/CANCEL — one
  // round-trip, rows-in / choice-out.
  PICKER_CHOOSE: 'picker-choose', // Enter / click — deliver the chosen value
  PICKER_CANCEL: 'picker-cancel', // Escape / C-g — cancel the picker
  PICKER_DELETE: 'picker-delete', // ⌫ on a deletable row — remove it (workspace mgmt)
  // An outline edit from the bookmark VIEW (a mutable 'bookmark' data-source).
  // The view sends a semantic op `{ sourceId, op, id?, name? }` — jump / rename
  // / delete / indent / outdent / toggle — and the server applies it to the
  // source buffer's records (authoritative), persists the sidecar, and fans the
  // fresh outline back out (setState → PANE_TREE). `jump` also moves the
  // document's point + re-syncs the client. The view never mutates its own copy;
  // it re-renders from the fanned-out state, exactly as it forwards key intents.
  BOOKMARK_OP: 'bookmark-op',
  // Sub-navigation from the customize VIEW (a 'customize' data-source). The
  // view's model + value/face edits run client-side (the client's interpreter
  // holds the defcustom/face registry it renders from); only opening another
  // SCOPE — a subgroup / variable / face — needs the server, which owns the
  // leaf. The view sends `{ scope }` ({group|variable|face}); the server
  // find-or-creates that scope's customize leaf and switches this client to it
  // (mirror of openScope flag-off). Like BOOKMARK_OP: the view never owns the
  // pane structure, it just requests it.
  CUSTOMIZE_OP: 'customize-op',
  // A customize SETTING changed (Apply / Save / Reset / face edit) in this
  // window. The server relays it to the OTHER windows (MSG.CUSTOMIZE_SYNC) so
  // global rendering state (theme / faces / line-height) stays consistent across
  // windows. Carries `{ op, name?, value?, face?, attr? }`. The originating
  // window already applied it locally (immediate); this just propagates outward.
  CUSTOMIZE_CHANGED: 'customize-changed',
  // A JS notebook cell wants to run. The renderer can't eval (CSP forbids
  // unsafe-eval), so the source is sent to the spine, which evaluates it in its
  // Node context and replies with MSG.NOTEBOOK_RESULT. Carries `{ reqId, source }`
  // — reqId pairs the async reply to the awaiting cell.
  NOTEBOOK_EVAL: 'notebook-eval',
});

/**
 * Pane intents the client sends UP. The server owns the logical pane tree;
 * the client requests a structural change (split / focus / delete) and the
 * server mutates the tree and replies with a fresh `PANE_TREE`. The client
 * never edits the tree itself — it only renders the latest one and forwards
 * intents, exactly as it forwards key/edit intents (never edits).
 *
 * The `op` distinguishes the structural operation; a `ratio` (for resize) or
 * a `paneId` (to target a specific leaf rather than the focused one) ride as
 * needed. Most map 1:1 onto the real `panes.lisp` commands run server-side.
 */
export const PANE_INTENT = Object.freeze({
  SPLIT_BELOW: 'split-below', // C-x 2 — split the focused leaf top/bottom
  SPLIT_RIGHT: 'split-right', // C-x 3 — split the focused leaf left/right
  OTHER_WINDOW: 'other-window', // C-x o — cycle focus to the next leaf
  DELETE_WINDOW: 'delete-window', // C-x 0 — delete the focused leaf
  DELETE_OTHER_WINDOWS: 'delete-other-windows', // C-x 1 — focused fills all
  FOCUS_PANE: 'focus-pane', // click — focus a specific leaf by id
  // A resize the client chose by dragging a splitter. The client owns the
  // pixels; it echoes the new ratio UP so the server's logical tree (and the
  // session it persists) records the user's chosen split. paneId names the
  // SPLIT node whose ratio changed; ratio is the first child's new fraction.
  RESIZE: 'resize',
});

/**
 * The view-state a `VIEW` message carries — everything the renderer needs
 * that is NOT buffer text. Pure data, no behaviour; the server computes it
 * after applying an intent and the client renders it.
 *
 * @typedef {object} ViewState
 * @property {number} point - The primary cursor offset.
 * @property {number | null} mark - The selection anchor, or null.
 * @property {string} name - The view/buffer name (the modeline label).
 * @property {string} [majorModeName] - The buffer's major-mode display name
 *   (e.g. "Markdown", "LaTeX"); the client uses it to pick the math-preview
 *   scanner provider. Empty for a data-source leaf.
 * @property {boolean} [mathPreviewActive] - Whether `math-preview-mode` is on
 *   for this buffer; the client typesets math only when true (its own
 *   interpreter is inert under GODOT_SERVER=1, so this state is server-owned).
 * @property {string} modeline - The fully-rendered modeline string.
 * @property {string} status - The echo-area message (show-status!), or ''.
 * @property {MinibufferState} minibuffer - The minibuffer prompt state.
 * @property {number} [seq] - The buffer seq this view-state reflects, so a
 *   client can tell whether a VIEW predates a DELTA it has not yet applied.
 */

/**
 * The minibuffer's state, sent down so the client can render the prompt.
 *
 * @typedef {object} MinibufferState
 * @property {boolean} active - Whether a prompt is open.
 * @property {string} prompt - The prompt label (e.g. "M-x ", "Find file: ").
 * @property {string} value - The server's authoritative value (usually the
 *   client echoes its own; the server may seed/override it, e.g. find-file's
 *   default directory).
 */

/** An inactive minibuffer — the common case. */
export const MINIBUFFER_IDLE = Object.freeze({
  active: false,
  prompt: '',
  value: '',
});

/**
 * Render a modeline string from view-state, the way Emacs's default
 * mode-line-format does in miniature: a modified flag, the buffer name, the
 * line:column, and the major mode. Pure — a function of its inputs only, so
 * it is unit-testable and identical on server and (if needed) client.
 *
 * The "modified" flag is a single `●` (a filled bullet) when the buffer has
 * unsaved edits and a `–` (en-dash) when it is clean — the dirty indicator the
 * client paints in the modeline. `save-buffer` clears it (re-baselines the
 * saved text); an edit sets it (the buffer's text diverges from its baseline).
 *
 * @param {object} parts
 * @param {string} parts.name - The buffer/view name.
 * @param {boolean} [parts.modified=false] - Unsaved changes?
 * @param {number} [parts.line=1] - 1-based line of point.
 * @param {number} [parts.column=0] - 0-based column of point.
 * @param {string} [parts.mode=''] - The major-mode label.
 * @returns {string} The modeline string.
 */
export function renderModeline(parts) {
  // A single-glyph dirty indicator: ● = unsaved edits, – = saved/clean.
  const flag = parts.modified ? '●' : '–';
  const name = parts.name || 'untitled';
  // A view with no text cursor (an element / media data-source — e.g. the
  // notebook) passes `noPosition: true` so the modeline doesn't show a frozen,
  // meaningless `L1:C0`.
  let pos = '';
  if (parts.noPosition !== true) {
    const line = Number.isFinite(parts.line) ? parts.line : 1;
    const column = Number.isFinite(parts.column) ? parts.column : 0;
    pos = `L${line}:C${column}`;
  }
  const mode = parts.mode ? `(${parts.mode})` : '';
  const tail = [pos, mode].filter(Boolean).join('  ');
  return `${flag}  ${name}${tail ? `   ${tail}` : ''}`;
}

/**
 * A buffer delta: a single Layer-1 change plus the cursor after it.
 *
 * @typedef {object} Delta
 * @property {number} start - Offset where the change begins.
 * @property {string} removed - Text removed at `start`.
 * @property {string} inserted - Text inserted at `start`.
 * @property {number} point - The cursor offset after the change.
 * @property {number} seq - Server-assigned monotonic sequence number.
 * @property {number} [echoId] - Echoes the intent's id, so the client
 *   can match a delta to the optimistic edit it already applied.
 */

/**
 * Apply a delta (or any L1-shaped change) to a plain-string mirror.
 * Pure: returns the new string, does not mutate.
 *
 * @param {string} text - The current mirror text.
 * @param {{ start: number, removed: string, inserted: string }} change
 * @returns {string} The mirror text after the change.
 */
export function applyDelta(text, change) {
  const { start, removed, inserted } = change;
  return (
    text.slice(0, start) + inserted + text.slice(start + removed.length)
  );
}

/**
 * The client-side optimistic prediction for a self-insert: what the
 * mirror + point become if we apply the keystroke locally, immediately,
 * before the server confirms (plan §4 "local echo"). Returns the same
 * delta shape the server would emit, so the same `applyDelta` path runs
 * for both the optimistic and the confirmed edit.
 *
 * @param {string} text - Current mirror text.
 * @param {number} point - Current cursor offset.
 * @param {string} insert - The printable string being inserted.
 * @returns {Delta} The predicted delta (no `seq` yet — local only).
 */
export function predictSelfInsert(text, point, insert) {
  return {
    start: point,
    removed: '',
    inserted: insert,
    point: point + insert.length,
  };
}

/**
 * The client-side optimistic prediction for a backspace. A no-op at the
 * start of the buffer. Steps back by one UTF-16 code unit — the spike
 * does not chase surrogate pairs (the server is canonical and will
 * reconcile); production would use storage.stepBackward.
 *
 * @param {string} text - Current mirror text.
 * @param {number} point - Current cursor offset.
 * @returns {Delta | null} The predicted delta, or null at buffer start.
 */
export function predictDeleteBackward(text, point) {
  if (point <= 0) return null;
  const removed = text.slice(point - 1, point);
  return { start: point - 1, removed, inserted: '', point: point - 1 };
}

// --- overlays + multi-cursor over the wire ----------------------------
//
// Overlays and the multi-cursor set are the next replication layer
// (architect-notes 2026-06-22 11:50 "markers/overlays/multi-cursor over
// the wire" — the gap). They are PURE DATA on the wire, so the helpers
// that normalise them live here, DOM- and Electron-free.

/**
 * An overlay as it travels the wire and as the renderer consumes it: a
 * face-tagged buffer range. This is exactly the renderer's `DecorationRange`
 * shape (`{ start, end, face }`, see packages/renderer/src/projection.js),
 * so a synced overlay drops straight into `view.js`'s `getDecorations()`
 * with no translation. An `id` lets the server target one overlay for
 * removal/update; the renderer ignores it.
 *
 * @typedef {object} WireOverlay
 * @property {number} start - Absolute offset where the overlay opens.
 * @property {number} end - Absolute offset where the overlay closes.
 * @property {string} face - The face name (a CSS `tok-<face>` class).
 * @property {string} [kind] - A grouping tag (e.g. "search"), so a feature
 *   can replace its own overlays without disturbing another's.
 * @property {string} [id] - A stable id for one overlay (server-assigned).
 */

/**
 * Normalise an overlay to the `{ start, end, face }` the renderer's
 * `decorationRects` needs, with `start <= end` and integer offsets. Drops
 * malformed overlays (returns null) so a bad one can't crash the render
 * pass. Pure.
 *
 * @param {object} o - A candidate overlay.
 * @returns {WireOverlay | null}
 */
export function normaliseOverlay(o) {
  if (!o || typeof o !== 'object') return null;
  const start = Number(o.start);
  const end = Number(o.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const face = typeof o.face === 'string' && o.face !== '' ? o.face : 'overlay';
  const lo = Math.max(0, Math.floor(Math.min(start, end)));
  const hi = Math.max(0, Math.floor(Math.max(start, end)));
  const out = { start: lo, end: hi, face };
  if (typeof o.kind === 'string') out.kind = o.kind;
  if (typeof o.id === 'string') out.id = o.id;
  return out;
}

/**
 * The decoration list the renderer's `getDecorations()` should return,
 * derived from a wire overlay list: each normalised, malformed ones
 * dropped, zero-width ones kept (the renderer paints them as empty boxes,
 * which is fine for a caret-style marker). Pure.
 *
 * @param {WireOverlay[]} overlays
 * @returns {{ start: number, end: number, face: string }[]}
 */
export function overlaysToDecorations(overlays) {
  if (!Array.isArray(overlays)) return [];
  const out = [];
  for (const o of overlays) {
    const n = normaliseOverlay(o);
    if (n) out.push({ start: n.start, end: n.end, face: n.face });
  }
  return out;
}

/**
 * Normalise a cursor set to the `[{ point, mark }]` shape the renderer's
 * `getCursors()` returns and `cursorPositions` consumes. Always yields a
 * non-empty array (a text view must have at least the primary cursor): an
 * empty/invalid input collapses to a single cursor at offset 0. Pure.
 *
 * @param {Array<{point:number, mark:number|null}>} cursors
 * @returns {Array<{point:number, mark:number|null}>}
 */
export function normaliseCursors(cursors) {
  if (!Array.isArray(cursors) || cursors.length === 0) {
    return [{ point: 0, mark: null }];
  }
  return cursors.map((c) => {
    const point = Number.isFinite(c && c.point) ? Math.floor(c.point) : 0;
    const mark = c && Number.isFinite(c.mark) ? Math.floor(c.mark) : null;
    return { point: Math.max(0, point), mark: mark === null ? null : Math.max(0, mark) };
  });
}

// --- the pane tree over the wire (G0a) --------------------------------
//
// The server owns each window's LOGICAL pane tree. To render it, the client
// needs ONLY its structure — never pixels. These pure helpers serialise the
// `@editor/pane` tree to a plain-data wire node and walk a wire node, so the
// PANE_TREE message is unit-testable + DOM-free and the client can rebuild
// the nesting without holding a real pane object.
//
// The deliberate omission is the headline of the geometry finding: a wire
// node carries the split orientation + ratio (the *intended* relative size,
// a fraction, NOT a pixel count) and, for a leaf, which buffer it shows + the
// per-pane view-state (point/scroll). It carries NO `left/top/width/height` —
// the client computes those from its own host rectangle (the same
// `computeRects` math `@editor/pane` already exposes). So the only thing that
// must cross the wire for layout is one float per split; everything pixel is
// derived client-side.

/**
 * A serialised pane-tree node, as it travels the wire.
 *
 * @typedef {object} WirePaneNode
 * @property {'leaf'|'split'} kind
 * @property {string} id - The pane's stable id (mirrors the @editor/pane id).
 * For a SPLIT:
 * @property {'horizontal'|'vertical'} [orientation]
 * @property {number} [ratio] - The first child's fraction in (0,1).
 * @property {WirePaneNode} [first]
 * @property {WirePaneNode} [second]
 * For a LEAF:
 * @property {string|null} [bufferId] - The buffer this leaf shows, or null.
 * @property {string} [name] - The buffer/view name (modeline label).
 * @property {number} [point] - The leaf's view-state point (per-pane cursor).
 * @property {number|null} [mark] - The leaf's view-state mark.
 * @property {number} [scrollLine] - The leaf's saved first-visible line.
 * @property {boolean} [focused] - Whether this leaf is the window's focus.
 * @property {boolean} [tabline] - Whether this leaf presents as a tabline-view
 *   (Step 3c) of its OWN curated tab set rather than a single view.
 * @property {{ bufferId: string, name: string, modified: boolean,
 *   filePath: string|null, viewKind?: string }[]} [tabs] - For a tabline leaf,
 *   its ordered curated tab set (the active tab is the leaf's `bufferId`); a
 *   non-text tab carries its `viewKind`.
 * @property {string} [viewKind] - For a non-text DATA-SOURCE leaf
 *   (image/audio/video/pdf), the element-view kind the client mounts. Also
 *   `'minimap'` for a minimap companion leaf (no buffer; see below).
 * @property {string|null} [filePath] - The data-source's file (the client loads
 *   its bytes via the main process).
 * @property {object} [state] - A mutable data-source's shared state (unused by
 *   immutable media).
 * @property {string} [minimapTarget] - For a `viewKind:'minimap'` leaf, the id
 *   of the target leaf it mirrors (the client binds its <minimap-view> to that
 *   leaf's <text-view>).
 * @property {'left'|'right'} [minimapSide] - Which side the minimap sits on.
 */

/**
 * Serialise a server pane tree to a wire node. The leaf-data resolver
 * (`leafData`) is injected so this helper stays free of the buffer registry:
 * the server passes a function turning a leaf pane into `{ bufferId, name,
 * point, mark, scrollLine }`. `focusedId` marks the focused leaf. Pure.
 *
 * @param {import('../../../packages/pane/src/pane.js').Pane} pane
 * @param {string|null} focusedId - The focused leaf's id.
 * @param {(leaf: object) => { bufferId: string|null, name?: string, point?: number, mark?: number|null, scrollLine?: number }} leafData
 * @returns {WirePaneNode}
 */
export function serializePaneTree(pane, focusedId, leafData) {
  if (!pane || typeof pane !== 'object') {
    return { kind: 'leaf', id: 'pane-empty', bufferId: null, focused: true };
  }
  if (pane.kind === 'split') {
    return {
      kind: 'split',
      id: pane.id,
      orientation: pane.orientation,
      ratio: pane.ratio,
      first: serializePaneTree(pane.first, focusedId, leafData),
      second: serializePaneTree(pane.second, focusedId, leafData),
    };
  }
  // A leaf: attach the buffer + view-state the client needs to mount a view.
  const data = (typeof leafData === 'function' ? leafData(pane) : null) || {};
  const node = {
    kind: 'leaf',
    id: pane.id,
    bufferId: data.bufferId ?? null,
    focused: pane.id === focusedId,
  };
  if (typeof data.name === 'string') node.name = data.name;
  // Step 3c: the leaf presents as a tabline of its OWN curated tab set; carry
  // the flag + the ordered tabs (each with display metadata) so the client
  // renders exactly this leaf's tabs.
  if (data.tabline === true) node.tabline = true;
  if (Array.isArray(data.tabs)) node.tabs = data.tabs;
  // A non-text DATA-SOURCE leaf (image/audio/video/pdf): the client mounts the
  // matching element-view from `viewKind` + `filePath` (it loads the bytes via
  // the main process); `state` carries a mutable source's shared state (unused by
  // media). No text/cursor for a media leaf.
  if (typeof data.viewKind === 'string') {
    node.viewKind = data.viewKind;
    node.filePath = data.filePath ?? null;
    if (data.state && typeof data.state === 'object') node.state = data.state;
    // A minimap companion leaf (`viewKind:'minimap'`) carries the id of the
    // target leaf it mirrors + which side it sits on; the client binds its
    // <minimap-view> to that leaf's <text-view>.
    if (data.minimapTarget != null) node.minimapTarget = data.minimapTarget;
    if (typeof data.minimapSide === 'string') node.minimapSide = data.minimapSide;
    return node;
  }
  // Step 3b: a different-buffer leaf carries its text so the client can render
  // it as a static pane (omitted for the focused / same-buffer leaves).
  if (typeof data.text === 'string') node.text = data.text;
  if (Number.isFinite(data.point)) node.point = Math.max(0, Math.floor(data.point));
  if (data.mark === null || Number.isFinite(data.mark)) {
    node.mark = data.mark === null ? null : Math.max(0, Math.floor(data.mark));
  }
  if (Number.isFinite(data.scrollLine)) {
    node.scrollLine = Math.max(0, Math.floor(data.scrollLine));
  }
  return node;
}

/**
 * Walk a wire pane node depth-first, yielding every LEAF in display order
 * (first-then-second), the same order `@editor/pane`'s `leafPanes` yields.
 * Lets the client iterate leaves to mount/diff views without re-implementing
 * the tree walk. Pure.
 *
 * @param {WirePaneNode} node
 * @returns {WirePaneNode[]} The leaf nodes, in display order.
 */
export function wireLeaves(node) {
  const out = [];
  walkWire(node, out);
  return out;
}

function walkWire(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.kind === 'leaf') {
    out.push(node);
    return;
  }
  if (node.kind === 'split') {
    walkWire(node.first, out);
    walkWire(node.second, out);
  }
}

/**
 * The id of the focused leaf in a wire pane node, or null if none is marked.
 * Pure.
 *
 * @param {WirePaneNode} node
 * @returns {string|null}
 */
export function wireFocusedLeafId(node) {
  for (const leaf of wireLeaves(node)) {
    if (leaf.focused) return leaf.id;
  }
  return null;
}

// --- the generic picker channel (G0b) ---------------------------------
//
// A PICKER request is the wire shape EVERY render-side picker shares: a
// title, a list of rows (each a `{ label, value, ...meta }`), and a bag of
// display options. The server's row-PROVIDER is whatever produces the rows
// (the buffer registry for the buffer list, the recovery scan for
// *Recover*, the command registry for completions, the RefTeX DB for
// select/cite) — the channel itself is provider-agnostic. These helpers
// keep the request well-formed + DOM-free so both ends agree on its shape
// and the client's narrowing logic is unit-testable.

/**
 * A single picker row as it travels the wire and as the client renders it.
 *
 * @typedef {object} PickerRow
 * @property {string} label - The text the client shows + filters on.
 * @property {*} value - The opaque token the server gets back on a choice
 *   (a buffer id, a recovery key, a command name, a label name — whatever
 *   the row-provider's on-choose handler needs). The client never inspects
 *   it; it just echoes the chosen row's value up.
 * @property {string} [meta] - A secondary, dimmed label (line count,
 *   modified flag, a path, an age) shown after the main label.
 * @property {string} [detail] - A longer description shown on a second line
 *   (e.g. a command's docstring, a cite entry's author/year).
 * @property {string} [group] - A grouping key; the client may render rows
 *   under group headings (RefTeX groups labels by type).
 * @property {boolean} [current] - Whether this row is the "current" one
 *   (the buffer the window is on); the client may pre-select / mark it.
 */

/**
 * The display/behaviour options a PICKER request carries.
 *
 * @typedef {object} PickerOptions
 * @property {boolean} [filter=true] - Whether type-to-narrow is on (off for
 *   a small fixed list like a yes/no or a *Recover* with action keys).
 * @property {string} [placeholder] - Ghost text for the filter input.
 * @property {string} [kind] - A tag the client can use to choose a styling/
 *   layout variant ('buffer-list', 'completions', 'recover', 'reftex', …).
 *   Purely cosmetic; the channel treats every picker identically.
 */

/**
 * A picker request as it travels the wire (the PICKER down-message body).
 *
 * @typedef {object} PickerRequest
 * @property {string} id - The picker's id (the server matches a reply to
 *   the suspended command; a reply with a stale id is dropped).
 * @property {string} title - The header label ("Buffer list", "M-x", …).
 * @property {PickerRow[]} rows - The selectable rows.
 * @property {PickerOptions} options - Display/behaviour options.
 */

/**
 * Normalise a raw picker request to the wire shape the client renders, with
 * every row reduced to a safe `{ label, value, meta?, detail?, group?,
 * current? }` and the options defaulted. Drops malformed rows (so one bad
 * row can't crash the render pass) and never throws. Pure.
 *
 * @param {object} req - `{ id, title, rows, options }` (loosely shaped).
 * @returns {PickerRequest}
 */
export function normalisePickerRequest(req) {
  const r = req && typeof req === 'object' ? req : {};
  const id = typeof r.id === 'string' && r.id !== '' ? r.id : 'picker';
  const title = typeof r.title === 'string' ? r.title : '';
  const rawRows = Array.isArray(r.rows) ? r.rows : [];
  const rows = [];
  for (const row of rawRows) {
    const n = normalisePickerRow(row);
    if (n) rows.push(n);
  }
  const o = r.options && typeof r.options === 'object' ? r.options : {};
  const options = {
    filter: o.filter !== false, // default on
  };
  if (typeof o.placeholder === 'string') options.placeholder = o.placeholder;
  if (typeof o.kind === 'string') options.kind = o.kind;
  if (typeof o.hint === 'string') options.hint = o.hint; // a footer action hint
  return { id, title, rows, options };
}

/**
 * Normalise one picker row. A row MUST have a label (the thing the user
 * sees + filters on); its value defaults to the label when absent (a plain
 * string list). Returns null for a row with no usable label. Pure.
 *
 * @param {object} row
 * @returns {PickerRow | null}
 */
export function normalisePickerRow(row) {
  if (row == null) return null;
  // A bare string is a label-only row whose value is the string itself.
  if (typeof row === 'string') return { label: row, value: row };
  if (typeof row !== 'object') return null;
  const label = typeof row.label === 'string' ? row.label : '';
  if (label === '') return null;
  const out = { label, value: 'value' in row ? row.value : label };
  if (typeof row.meta === 'string') out.meta = row.meta;
  if (typeof row.detail === 'string') out.detail = row.detail;
  if (typeof row.group === 'string') out.group = row.group;
  if (row.current === true) out.current = true;
  if (row.deletable === true) out.deletable = true; // ⌫ removes it (workspace mgmt)
  return out;
}

/**
 * The type-to-narrow filter every client picker runs: keep the rows whose
 * label (or meta) contains the query, case-insensitively, preserving order.
 * An empty/blank query keeps everything. This is the SAME narrowing the real
 * pickers do (completions, RefTeX select), factored out so it is pure +
 * unit-tested and identical across every picker the channel serves.
 *
 * @param {PickerRow[]} rows
 * @param {string} query
 * @returns {PickerRow[]}
 */
export function filterPickerRows(rows, query) {
  if (!Array.isArray(rows)) return [];
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return rows.slice();
  return rows.filter((row) => {
    const label = (row && row.label ? String(row.label) : '').toLowerCase();
    if (label.includes(needle)) return true;
    const meta = row && row.meta ? String(row.meta).toLowerCase() : '';
    return meta.includes(needle);
  });
}

/**
 * The size of ONE screenful in text lines — the step `scroll-up`/`scroll-down`
 * (C-v / M-v) move point by. Mirrors Emacs: a screenful is the visible line
 * count minus a small overlap (`contextLines`, Emacs's
 * `next-screen-context-lines`, default 2) so the line at the screen edge stays
 * on screen and the eye keeps its place. The visible LINE count is supplied by
 * the client (only it knows how many lines fit — plan §5d).
 *
 * A non-positive or non-finite viewport (not measured yet, e.g. before the
 * first VIEWPORT report) falls back to a single-line step so the command is
 * never a silent no-op.
 *
 * @param {number} viewportLines - The number of text lines visible in the pane.
 * @param {number} [contextLines=2] - Lines of overlap kept across the scroll.
 * @returns {number} The screenful step, an integer >= 1.
 */
export function screenfulStep(viewportLines, contextLines = 2) {
  const usable = Math.floor(viewportLines) - Math.max(0, Math.floor(contextLines));
  return Number.isFinite(usable) && usable >= 1 ? usable : 1;
}

/**
 * The screenful-scroll math (C-v / M-v), pure so it is unit-testable and
 * identical wherever it runs. A page-down (`direction` +1) moves point DOWN by
 * one {@link screenfulStep}; a page-up (-1) moves it UP. The result is CLAMPED
 * to the buffer's line range. Operates on 0-based line numbers (what
 * `buffer.positionAt` returns); the caller maps line↔offset.
 *
 * @param {number} pointLine - The current 0-based line of point.
 * @param {number} lineCount - The buffer's total line count (>= 1).
 * @param {number} viewportLines - The number of text lines visible in the pane.
 * @param {1 | -1} direction - +1 for page-down (C-v), -1 for page-up (M-v).
 * @param {number} [contextLines=2] - Lines of overlap kept across the scroll.
 * @returns {number} The new 0-based line for point, clamped to [0, lineCount-1].
 */
export function screenfulScrollLine(
  pointLine,
  lineCount,
  viewportLines,
  direction,
  contextLines = 2
) {
  const lastLine = Math.max(0, Math.floor(lineCount) - 1);
  const here = Math.min(lastLine, Math.max(0, Math.floor(pointLine) || 0));
  const dir = direction < 0 ? -1 : 1;
  const target = here + dir * screenfulStep(viewportLines, contextLines);
  return Math.min(lastLine, Math.max(0, target));
}
