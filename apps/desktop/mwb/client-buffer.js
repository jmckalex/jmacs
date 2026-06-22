/**
 * @file Model-B render-from-mirror slice — the CLIENT BUFFER MIRROR.
 *
 * This is the answer to the decisive bake-off question (plans/
 * MULTI-WINDOW-MODEL-B.md §5b): *how expensive is it to drive the real
 * `view.js` rendering stack from a replicated buffer mirror + server
 * deltas, instead of the live buffer?*
 *
 * `ClientBuffer` presents the SAME read interface the renderer's
 * `createEditorView` / `view.js` consume off an L2 buffer, but its
 * contents are driven by applying server **deltas**
 * (`{ start, removed, inserted }` — the Layer-1 change shape, which IS
 * the wire delta) instead of by local editing commands. The point of
 * this slice is to render the real editor from a mirror with the SMALLEST
 * possible seam in `view.js`.
 *
 * The cost finding, stated up front (and validated by the running slice):
 *
 *   `view.js` did NOT have to change at all. Its buffer-read surface is
 *   small, synchronous, and cleanly separable from editing:
 *     - read text/lines/positions: `text`, `name`, `lineCount`, `slice`,
 *       `lineAt`, `positionAt`, `offsetAt`  — pure functions of the text;
 *     - read the cursor: `point`, `mark` (window-state, per client);
 *     - observe changes: `onChange(cb)` -> unsubscribe;
 *     - mutate: `insert`, `deleteBackward`, `moveTo`, `moveBufferEnd`, …
 *   The mirror REUSES the real Layer-1 storage (`@editor/storage`) for the
 *   entire read surface verbatim — `lineAt`/`positionAt`/`offsetAt`/`slice`
 *   are the subtle, easy-to-get-wrong methods, and we get them for free —
 *   and only re-homes two things: (1) the cursor becomes per-client
 *   *window-state* this object owns, and (2) the mutators become
 *   intent-emitters that locally-echo a prediction and send the edit
 *   UP to the server, where the canonical buffer applies it and a delta
 *   comes back. A delta is applied to the mirror's storage with the same
 *   `{start,removed,inserted}` machinery the real buffer uses.
 *
 * Because the read surface is a pure function of the text, the
 * highlighter and the folder (tree-sitter) run UNCHANGED on the mirror
 * text — they never knew the difference between a live buffer and a
 * replicated one. That is the crux of why the replicated-client approach
 * (plan §4) is tractable: don't rewrite rendering, replicate state.
 *
 * This module is DOM-free and Electron-free, so it is unit-testable under
 * `node --test` (see client-buffer.test.js).
 */

import { createBuffer as createStorage } from '@editor/storage';

/**
 * @callback IntentSink
 * @param {object} intent - An edit/motion intent to send to the server.
 * @returns {void}
 */

/**
 * Create a client-side buffer mirror.
 *
 * @param {object} [options]
 * @param {string} [options.initialText=''] - Seed text (a SNAPSHOT from
 *   the server; later deltas drive it).
 * @param {string} [options.name='mirror'] - The buffer name (the
 *   renderer reads this to pick the tree-sitter language — so a real file
 *   name like `app.js` highlights as JavaScript).
 * @param {number} [options.point=0] - The initial cursor offset.
 * @param {IntentSink} [options.sendIntent] - Where to route edit/motion
 *   intents (the wire up to the server). Defaults to a no-op, which makes
 *   the mirror a pure local buffer (used in tests of the read surface).
 * @param {boolean} [options.localEcho=true] - Whether a mutator predicts
 *   its result on the mirror immediately (instant typing) before the
 *   server confirms. With it off, the mirror only changes when a server
 *   delta lands (useful to prove the pure server-driven path).
 * @returns {ClientBuffer}
 */
export function createClientBuffer(options = {}) {
  const storage = createStorage(options.initialText ?? '');
  let name = options.name ?? 'mirror';
  const sendIntent = typeof options.sendIntent === 'function'
    ? options.sendIntent
    : () => {};
  const localEcho = options.localEcho !== false;

  // The cursor is WINDOW STATE: per-client, owned here, not shared. Two
  // windows over one buffer share the storage but each keep their own
  // point/mark (plan §4 "per-window vs per-buffer state"). We keep the
  // same `cursors[]`-with-aliases shape a real view/buffer uses, so the
  // renderer's multi-cursor reads (`getCursors`) work unchanged — though
  // this slice drives only the primary cursor.
  const cursors = [{ point: clampPoint(options.point ?? 0), mark: null }];

  /** @type {Set<(event: BufferEvent) => void>} */
  const listeners = new Set();

  /** The last server sequence number we've applied (gap detection). */
  let lastSeq = 0;

  function clampPoint(p) {
    if (!Number.isFinite(p)) return 0;
    if (p < 0) return 0;
    if (p > storage.length) return storage.length;
    return Math.floor(p);
  }

  /** Notify renderer listeners. The renderer's listener doesn't read the
   *  event payload (it just marks dirty + re-renders, then reads point via
   *  getPoint), but we emit the same `{change, point, mark}` shape the real
   *  L2 buffer does so the contract is identical. */
  function emit(change) {
    const c = cursors[0];
    const event = { change, point: c.point, mark: c.mark };
    for (const listener of listeners) listener(event);
  }

  /**
   * Apply a delta to the mirror's storage. This is the DOWN path: the
   * server's canonical buffer produced this L1 change; we replay it on the
   * mirror. `storage.replace` emits the same change shape, which we forward
   * to the renderer.
   *
   * @param {Delta} delta - `{ start, removed, inserted, point, seq, echoId }`.
   * @param {object} [opts]
   * @param {boolean} [opts.echoed=false] - True when this delta confirms an
   *   edit we already optimistically applied (local echo); then we only
   *   move the cursor + bump seq, not re-edit the text (it already matches).
   * @returns {boolean} Whether the text was changed.
   */
  function applyDelta(delta, opts = {}) {
    if (typeof delta.seq === 'number') lastSeq = delta.seq;
    if (opts.echoed) {
      // The prediction already mutated the storage to the right text AND
      // advanced the cursor to the correct optimistic offset. We do NOT
      // adopt the server's `delta.point`: under rapid typing several
      // predictions are in flight, so the server's point for THIS delta
      // lags the client's optimistic point (it reflects only the inserts
      // the server has processed so far). Adopting it would rewind the
      // cursor and the next predicted char would insert at the wrong offset
      // — the marker comes out scrambled ("MWBxyz" → "MWByz x"). The local
      // prediction is authoritative for point during echo; the server's
      // point matters only for command-driven (non-echoed) moves below.
      return false;
    }
    const start = delta.start;
    const end = start + (delta.removed ? delta.removed.length : 0);
    storage.replace(start, end, delta.inserted ?? '');
    if (typeof delta.point === 'number') cursors[0].point = clampPoint(delta.point);
    else cursors[0].point = clampPoint(start + (delta.inserted ?? '').length);
    cursors[0].mark = null;
    emit(lastLowLevelChange);
    return true;
  }

  // Capture the most recent L1 change so emit() can forward exactly what
  // the renderer expects (a real L2 buffer forwards `lastChange` likewise).
  /** @type {BufferChange | null} */
  let lastLowLevelChange = null;
  storage.onChange((change) => {
    lastLowLevelChange = change;
  });

  /**
   * Replace the whole mirror from a server SNAPSHOT (initial sync /
   * resync after a detected gap). Resets the cursor to the snapshot's.
   *
   * @param {object} snapshot - `{ text, point, seq, name? }`.
   */
  function applySnapshot(snapshot) {
    storage.replace(0, storage.length, String(snapshot.text ?? ''));
    if (typeof snapshot.name === 'string') name = snapshot.name;
    cursors.length = 1;
    cursors[0].point = clampPoint(snapshot.point ?? 0);
    cursors[0].mark = null;
    lastSeq = typeof snapshot.seq === 'number' ? snapshot.seq : 0;
    emit(lastLowLevelChange);
  }

  // --- local-echo predictions ------------------------------------------
  //
  // The mutators the renderer/IME call. Each predicts its result on the
  // mirror immediately (so typing is instant) and sends the intent UP.
  // The server's confirming delta arrives with echoId set and is applied
  // via applyDelta({echoed:true}), which only adopts the authoritative
  // cursor (the text already matches the prediction).

  function predictInsert(text) {
    if (!localEcho) return;
    const at = cursors[0].point;
    storage.insert(at, text);
    cursors[0].point = at + text.length;
    cursors[0].mark = null;
    emit(lastLowLevelChange);
  }

  function predictDeleteBackward(count) {
    if (!localEcho) return;
    const to = cursors[0].point;
    const from = storage.stepBackward(to, count);
    if (from === to) return;
    storage.delete(from, to);
    cursors[0].point = from;
    cursors[0].mark = null;
    emit(lastLowLevelChange);
  }

  /** @type {ClientBuffer} */
  const buffer = {
    // --- identity / read surface (delegated to L1 verbatim) ------------
    get name() { return name; },
    set name(v) { name = String(v); },

    get text() { return storage.toString(); },
    toString() { return storage.toString(); },
    get length() { return storage.length; },
    get lineCount() { return storage.lineCount; },
    slice(start, end) { return storage.slice(start, end); },
    lineAt(position) { return storage.lineAt(position); },
    positionAt(offset) { return storage.positionAt(offset); },
    offsetAt(line, column) { return storage.offsetAt(line, column); },

    // The mirror has no markers/overlays in this slice; the renderer
    // tolerates their absence (it only creates markers for snippets/
    // bookmarks, which this slice does not exercise). createMarker is
    // provided so a stray call doesn't crash — it returns a static marker.
    createMarker(offset) {
      const pos = clampPoint(offset);
      return { get offset() { return pos; }, remove() {} };
    },

    // --- cursor (window-state) -----------------------------------------
    get cursors() { return cursors; },
    get point() { return cursors[0].point; },
    get mark() { return cursors[0].mark; },
    get cursorCount() { return cursors.length; },

    // --- mutators (intent-emitting) ------------------------------------
    // These are what `view.js` (and the IME path) call. Instead of
    // mutating a canonical buffer, they locally-echo + send an intent.

    insert(text) {
      const str = String(text);
      predictInsert(str);
      sendIntent({ kind: 'self-insert', text: str });
    },

    deleteBackward(count = 1) {
      predictDeleteBackward(count);
      sendIntent({ kind: 'delete-backward', count });
      return true;
    },

    /** Cursor placement (mouse click, programmatic motion). Point is
     *  window-state, so this is applied LOCALLY and the server is told so
     *  it can keep this client's per-window point in sync (needed once the
     *  server owns scroll/centering decisions — plan §5d). With an
     *  `extend` option it stretches the selection (shift-click / select). */
    moveTo(offset, opts = {}) {
      const target = clampPoint(offset);
      if (opts.extend) {
        if (cursors[0].mark === null) cursors[0].mark = cursors[0].point;
      } else {
        cursors[0].mark = null;
      }
      cursors[0].point = target;
      sendIntent({ kind: 'point', point: target, mark: cursors[0].mark });
      emit(null); // cursor-only move: no text delta
    },

    moveBufferEnd(opts = {}) {
      this.moveTo(storage.length, opts);
    },

    // --- observing -----------------------------------------------------
    onChange(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('listener must be a function');
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // --- wire surface (used by the client transport, not the renderer) -
    applyDelta,
    applySnapshot,
    get lastSeq() { return lastSeq; },
  };

  return buffer;
}

/**
 * @typedef {ReturnType<typeof createClientBuffer>} ClientBuffer
 */
