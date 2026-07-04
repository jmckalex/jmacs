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

import { normaliseCursors, overlaysToDecorations } from './protocol.js';

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
 *   intents (the wire up to the server). Called as `sendIntent(intent,
 *   meta)` where `meta.predicted` says whether the mutator locally
 *   predicted the edit (localEcho) — the transport uses it to register a
 *   predicted pending entry so the echoed DELTA doesn't double-apply.
 *   Defaults to a no-op, which makes the mirror a pure local buffer
 *   (used in tests of the read surface).
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

  // The cursor SET is WINDOW STATE: per-client, owned here, not shared.
  // Two windows over one buffer share the storage but each keep their own
  // point/mark (plan §4 "per-window vs per-buffer state"). We keep the same
  // `cursors[]`-with-aliases shape a real view/buffer uses, so the
  // renderer's multi-cursor reads (`getCursors`) work unchanged. Index 0 is
  // the primary; secondaries (1+) are synced from the server's per-client
  // cursor set (the `CURSORS` message) so the renderer paints every caret.
  const cursors = [{ point: clampPoint(options.point ?? 0), mark: null }];

  // The buffer's OVERLAYS — face-tagged ranges (search highlights, snippet
  // fields, …). Unlike cursors, overlays are SHARED buffer state: they live
  // on the canonical buffer, so every client viewing it sees the same set
  // (the `OVERLAYS` message broadcasts them). The renderer reads them via
  // `getDecorations()` (see the `decorations` accessor below).
  /** @type {import('./protocol.js').WireOverlay[]} */
  let overlays = [];

  // Server-pushed mode state (the VIEW message). These are SERVER-owned: under
  // GODOT_SERVER=1 the renderer's interpreter is inert, so it cannot read this
  // buffer's major mode or minor-mode list itself. The math-preview host reads
  // `majorModeName` to choose the scanner provider and `mathPreviewActive` to
  // decide whether to typeset. They default to off so a flag-off mirror (and a
  // fresh mirror before its first VIEW) simply never previews.
  let majorModeName = '';
  let mathPreviewActive = false;
  // The MAJOR MODE's highlight grammar tag (e.g. 'jmarkdown'), server-owned like
  // the fields above. The editor view highlights by this when set, so a file
  // whose extension was re-registered to another mode (.md -> jmarkdown-mode) is
  // highlighted by the mode, not its filename. '' = fall back to the filename.
  let highlightLang = '';

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
   * resync after a detected gap). Resets the cursor to the snapshot's and
   * clears overlays (a fresh buffer re-broadcasts its own overlays).
   *
   * @param {object} snapshot - `{ text, point, seq, name? }`.
   */
  function applySnapshot(snapshot) {
    storage.replace(0, storage.length, String(snapshot.text ?? ''));
    if (typeof snapshot.name === 'string') name = snapshot.name;
    cursors.length = 1;
    cursors[0].point = clampPoint(snapshot.point ?? 0);
    cursors[0].mark = null;
    overlays = [];
    lastSeq = typeof snapshot.seq === 'number' ? snapshot.seq : 0;
    emit(lastLowLevelChange);
  }

  /**
   * Apply a whole-buffer RESYNC: the canonical text plus this client's full
   * cursor set. Used when a single forwarded delta cannot faithfully
   * replicate the edit — chiefly a MULTI-CURSOR insert/delete, which the L2
   * buffer applies as several L1 edits but reports as one change (see
   * protocol.js `MSG.RESYNC`). Replacing the whole text + adopting the
   * server's cursor set is exact; the fast single-cursor delta path is
   * untouched. Overlays are NOT cleared (a resync is a text/cursor event;
   * overlays arrive on their own channel and ride the edit server-side).
   *
   * @param {object} resync - `{ text, cursors, seq }`.
   * @returns {boolean} Whether the text changed.
   */
  function applyResync(resync) {
    if (typeof resync.seq === 'number') lastSeq = resync.seq;
    const before = storage.toString();
    const next = String(resync.text ?? '');
    if (next !== before) storage.replace(0, storage.length, next);
    adoptCursors(resync.cursors);
    emit(next !== before ? lastLowLevelChange : null);
    return next !== before;
  }

  /**
   * Adopt a full cursor set from the server (the `CURSORS` message or a
   * resync). Rebuilds the `cursors` array IN PLACE so any reference the
   * renderer holds (it reads `mirror.cursors` each render) stays live and
   * index 0 remains the primary. Clamps every offset to the current text.
   *
   * @param {Array<{point:number, mark:number|null}>} next
   */
  function adoptCursors(next) {
    const norm = normaliseCursors(next).map((c) => ({
      point: clampPoint(c.point),
      mark: c.mark === null ? null : clampPoint(c.mark),
    }));
    cursors.length = 0;
    for (const c of norm) cursors.push(c);
  }

  /**
   * Replace the buffer's overlay set from the server (the `OVERLAYS`
   * message). Overlays are shared buffer state, so every client viewing
   * this buffer receives the same list. Stored normalised; the renderer
   * reads them via the `decorations` accessor. Emits a cursor-only change
   * so the view re-renders and repaints the decoration layer.
   *
   * @param {import('./protocol.js').WireOverlay[]} next
   */
  function applyOverlays(next) {
    overlays = Array.isArray(next) ? next.slice() : [];
    emit(null);
  }

  /**
   * Adopt the major-mode name + math-preview-active flag from a server VIEW's
   * view-state. These ride the VIEW message (not a buffer delta) because they
   * are server-owned (see the field declarations above). Pure state-set, no
   * emit — the caller (onView) decides whether to re-render, and already does
   * when the cursor reconciles; this returns whether either value CHANGED so a
   * mode toggle that moved no cursor can still force one render.
   *
   * @param {{ majorModeName?: string, mathPreviewActive?: boolean,
   *   highlightLang?: string }} v
   * @returns {boolean} Whether majorModeName, mathPreviewActive or highlightLang
   *   changed (a highlightLang change must force a re-render so the editor
   *   re-highlights with the mode's grammar).
   */
  function applyViewMode(v) {
    const nextName = typeof v.majorModeName === 'string' ? v.majorModeName : '';
    const nextActive = v.mathPreviewActive === true;
    const nextHighlight = typeof v.highlightLang === 'string' ? v.highlightLang : '';
    const changed = nextName !== majorModeName
      || nextActive !== mathPreviewActive
      || nextHighlight !== highlightLang;
    majorModeName = nextName;
    mathPreviewActive = nextActive;
    highlightLang = nextHighlight;
    return changed;
  }

  // --- local-echo predictions ------------------------------------------
  //
  // The mutators the renderer/IME call. Each predicts its result on the
  // mirror immediately (so typing is instant) and sends the intent UP.
  // The server's confirming delta arrives with echoId set and is applied
  // via applyDelta({echoed:true}), which only adopts the authoritative
  // cursor (the text already matches the prediction).

  // Each predictor returns whether it actually mutated the mirror — the
  // mutators forward that as the intent's `predicted` meta, so the
  // transport only marks an echo as reconcile-only when a prediction
  // really landed (a no-op prediction, e.g. delete at buffer start, must
  // let the server's delta apply fresh).
  function predictInsert(text) {
    if (!localEcho || text.length === 0) return false;
    const at = cursors[0].point;
    storage.insert(at, text);
    cursors[0].point = at + text.length;
    cursors[0].mark = null;
    emit(lastLowLevelChange);
    return true;
  }

  function predictDeleteBackward(count) {
    if (!localEcho) return false;
    const to = cursors[0].point;
    const from = storage.stepBackward(to, count);
    if (from === to) return false;
    storage.delete(from, to);
    cursors[0].point = from;
    cursors[0].mark = null;
    emit(lastLowLevelChange);
    return true;
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

    // A marker on the mirror is a STATIC read of an offset. Live markers
    // (positions that ride edits) are owned by the canonical buffer on the
    // server — the mirror never needs them, because everything that USES a
    // marker (an overlay endpoint, a snippet field) is computed server-side
    // and synced down as a concrete offset (an overlay's `start`/`end`, a
    // cursor's `point`). So `createMarker` returns a fixed-offset stub: it
    // keeps any stray renderer call safe without re-implementing gravity.
    createMarker(offset) {
      const pos = clampPoint(offset);
      return { get offset() { return pos; }, remove() {} };
    },

    // --- cursor set (window-state) -------------------------------------
    // The renderer's getCursors() reads `cursors` each render and paints a
    // caret for each — so a synced multi-cursor set draws every secondary.
    get cursors() { return cursors; },
    get point() { return cursors[0].point; },
    get mark() { return cursors[0].mark; },
    get cursorCount() { return cursors.length; },

    // --- overlays (shared buffer state) --------------------------------
    /** The current overlay list (face-tagged ranges), normalised. */
    get overlays() { return overlays; },
    /** The renderer's `getDecorations()` shape: `{ start, end, face }[]`.
     *  The view paints each as `<div class="editor-decoration tok-FACE">`. */
    get decorations() { return overlaysToDecorations(overlays); },

    // --- server-pushed mode state (VIEW message) -----------------------
    /** The buffer's major-mode display name (e.g. "Markdown"), server-pushed.
     *  The math-preview host reads it to pick the scanner provider. '' when
     *  unknown (flag-off, or before the first VIEW). */
    get majorModeName() { return majorModeName; },
    /** Whether `math-preview-mode` is on for this buffer (server-pushed). */
    get mathPreviewActive() { return mathPreviewActive; },
    /** The major mode's highlight grammar tag (e.g. 'jmarkdown'), server-pushed;
     *  '' before the first VIEW. The editor view highlights by this when set. */
    get highlightLang() { return highlightLang; },

    // --- mutators (intent-emitting) ------------------------------------
    // These are what `view.js` (and the IME path) call. Instead of
    // mutating a canonical buffer, they locally-echo + send an intent.

    insert(text) {
      const str = String(text);
      // Tell the transport whether this edit was locally predicted: it
      // must register a PREDICTED pending entry so the server's echoed
      // DELTA reconciles (cursor/seq only) instead of re-applying the
      // text on top of the prediction — the accent-commit path doubled
      // its é exactly because this flag didn't exist.
      const predicted = predictInsert(str);
      sendIntent({ kind: 'self-insert', text: str }, { predicted });
    },

    deleteBackward(count = 1) {
      const predicted = predictDeleteBackward(count);
      sendIntent({ kind: 'delete-backward', count }, { predicted });
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
    applyResync,
    applyCursors: adoptCursors,
    applyOverlays,
    applyViewMode,
    get lastSeq() { return lastSeq; },
  };

  return buffer;
}

/**
 * @typedef {ReturnType<typeof createClientBuffer>} ClientBuffer
 */
