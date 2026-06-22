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
 * @param {object} parts
 * @param {string} parts.name - The buffer/view name.
 * @param {boolean} [parts.modified=false] - Unsaved changes?
 * @param {number} [parts.line=1] - 1-based line of point.
 * @param {number} [parts.column=0] - 0-based column of point.
 * @param {string} [parts.mode=''] - The major-mode label.
 * @returns {string} The modeline string.
 */
export function renderModeline(parts) {
  const flag = parts.modified ? '**' : '--';
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
