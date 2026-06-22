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
  const line = Number.isFinite(parts.line) ? parts.line : 1;
  const column = Number.isFinite(parts.column) ? parts.column : 0;
  const pos = `L${line}:C${column}`;
  const mode = parts.mode ? `  (${parts.mode})` : '';
  return `${flag}  ${name}   ${pos}${mode}`;
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
