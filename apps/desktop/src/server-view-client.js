/**
 * @file G2 — route ONE real renderer view through the Model-B server.
 *
 * Graduation plan §G2 (`plans/MWB-GRADUATION.md`): with `GODOT_SERVER=1`, make
 * a single REAL `view.js` editor a CLIENT of the server instead of the
 * in-renderer interpreter. This module is the testable core of that client.
 *
 * It is the production graduation of the proven prototype `mwb/view-client.js`
 * (see `architect-notes.md`, the render-from-mirror + command-spine slices),
 * adapted to:
 *   - run inside the real renderer's module graph (the real `createEditorView`
 *     via the real `<text-view>` element, the real highlighters, the real
 *     `keyEventToString`), and
 *   - take ALL of its Electron/DOM/view collaborators BY INJECTION, so the
 *     handshake → open-buffer → mirror → key-routing wiring is unit-testable
 *     under `node --test` with no Electron (see `server-view-client.test.js`).
 *
 * The split (plan §4, §5) is unchanged from the prototype:
 *   - input capture + normalisation (→ a key-string) is client-side;
 *   - local echo for a bare self-insert is client-side (instant typing);
 *   - everything else (which command a key runs, motion, M-x, the minibuffer)
 *     is server-side; the client renders the view-state the server sends down.
 *
 * ‼ THE IRONCLAD RULE (flag-off identical): nothing in this module runs unless
 * the caller constructs the client, and the caller in `app.js` only does so
 * behind `window.host.serverMode` (the G1 gate). With the flag off this file
 * is never imported's-worth-of-side-effect — it has no top-level effects, only
 * exported functions.
 */

import { MSG, INTENT } from '../mwb/protocol.js';
import { createClientBuffer } from '../mwb/client-buffer.js';

/**
 * True when KEYSTRING is a single bare printable character — the 99% path that
 * self-inserts and gets local echo. `[...s].length === 1` counts code points
 * (an astral char is one), matching the prototype.
 *
 * @param {string} keyString
 * @returns {boolean}
 */
export function isBarePrintable(keyString) {
  return typeof keyString === 'string' && [...keyString].length === 1;
}

/**
 * Create the G2 server-view client. Mounts ONE real editor view on a
 * `ClientBuffer` mirror fed by server deltas, and routes keystrokes to the
 * server as intents. Collaborators are injected so this is unit-testable with
 * fakes; `app.js` passes the real ones behind the server-mode flag.
 *
 * @param {object} deps
 * @param {MessagePort} deps.port
 *   The connected server port (G1's `godotServerPort`). The client `start()`s
 *   it and drives the whole conversation over it.
 * @param {(buffer: object, options: object) => {
 *     setView: (view: object) => void,
 *     focus: () => void,
 *     destroy: () => void,
 *     recenter?: () => void,
 *   }} deps.mountView
 *   Build + mount a real editor view bound to BUFFER (the mirror) with OPTIONS
 *   (onKey + the getPoint/getMark/getCursors/getDecorations closures). In
 *   `app.js` this constructs a real `<text-view>` and appends it; in tests it
 *   returns a fake recording the options.
 * @param {object} [deps.highlighters]   Tree-sitter highlighters (real app).
 * @param {object} [deps.foldCaptures]   Fold-capture extractors (real app).
 * @param {(event: KeyboardEvent) => string} [deps.keyEventToString]
 *   Normalise a keydown to a key-string (the real renderer's; injected so a
 *   test can drive synthetic events). Optional — only used if the client owns
 *   key capture (it does not in `app.js`, where the view's `onKey` feeds it).
 * @param {(msg: string) => void} [deps.log]
 * @returns {{
 *   connect: () => void,
 *   dispatchKey: (keyString: string) => boolean,
 *   handleMessage: (msg: object) => void,
 *   getMirror: () => object | null,
 *   getView: () => object | null,
 *   isConnected: () => boolean,
 *   currentBufferId: () => string | null,
 *   destroy: () => void,
 * }}
 */
export function createServerViewClient({
  port,
  mountView,
  highlighters = {},
  foldCaptures = {},
  keyEventToString,
  log = (msg) => console.info(msg),
}) {
  /** @type {ReturnType<typeof createClientBuffer> | null} */
  let mirror = null;
  /** @type {ReturnType<typeof mountView> | null} */
  let view = null;
  let connected = false;
  let currentBufferId = null;
  let nextIntentId = 1;

  // Pending intents we sent + await confirmation for, keyed by id. `predicted`
  // is retained on the entry shape for the VIEW-reconcile guard (a stale VIEW
  // must not rewind the cursor mid-type), though the local-echo predict path is
  // gone now that every key routes through the server's keymap (see dispatchKey).
  const pending = new Map();

  /** The mirror's wire-out: post an intent the server applies. The mirror only
   *  calls this from its OWN mutators (a direct mirror edit); the typing path
   *  no longer mutates the mirror locally (every key goes up as a KEY intent and
   *  the server's echoed DELTA reconciles), so this is a thin pass-through kept
   *  to satisfy the ClientBuffer contract. */
  function sendIntent(intent) {
    port.postMessage({
      type: MSG.INTENT,
      intent: { id: nextIntentId++, ...intent },
    });
  }

  /** Send a pure KEY intent (no local echo — the server's `handle-key`/keymap
   *  decides the effect). Registers a pending entry (un-predicted) so the
   *  echoed DELTA reconciles through the mirror's delta path. */
  function sendKey(key) {
    const id = nextIntentId++;
    pending.set(id, { predicted: false });
    port.postMessage({ type: MSG.INTENT, intent: { id, kind: INTENT.KEY, key } });
  }

  /**
   * The view's `onKey` hook in server mode. EVERY keystroke — a bare printable
   * included — is sent up as a pure KEY intent so the server's `handle-key`
   * resolves it through the real keymap. That is what makes the electric keys
   * fire: `(`/`[`/`{`/`"` auto-pair, `C-x`/`C-c` start a prefix chord, and a
   * plain printable falls through `handle-key` to self-insert. Local echo is
   * deliberately NOT used: the SELF_INSERT short-circuit bypassed the keymap
   * (so auto-pair never ran and a printable after a prefix ate the chord), and
   * Phase-0 showed the round-trip (~0.3 ms) is not perceptibly slower — typing
   * is frame-gated either way. The mirror still reconciles via the echoed
   * DELTA (sendKey registers a pending entry). Returns true to claim the key
   * (always, in server mode — the server owns dispatch).
   *
   * @param {string} keyString
   * @returns {boolean}
   */
  function dispatchKey(keyString) {
    if (!mirror) return false;
    sendKey(keyString);
    return true;
  }

  // --- the view's per-view-state closures (read the mirror) ---------------
  // These mirror app.js's ensureEditorViewForLeaf closures, but read the
  // ClientBuffer mirror instead of a Lisp View handle. The renderer reads them
  // every render, so a server-pushed cursor/overlay set paints with no view.js
  // change (the proven render-from-mirror seam).
  function buildMountOptions() {
    return {
      onKey: dispatchKey,
      highlighters,
      foldCaptures,
      getPoint: () => (mirror ? mirror.point : 0),
      getMark: () => (mirror ? mirror.mark : null),
      getCursors: () => (mirror ? mirror.cursors : [{ point: 0, mark: null }]),
      getDecorations: () => (mirror ? mirror.decorations : []),
      getMajorModeName: () => null,
      onRenderError: (e) => log(`[godot-g2] render error: ${e && e.message}`),
    };
  }

  // --- server messages ----------------------------------------------------

  /** A SNAPSHOT: the (re)synced text + cursor for THIS client's current
   *  buffer. A snapshot with a NEW buffer id is a switch — tear down the old
   *  mirror + view and rebuild for the new buffer (the same path the initial
   *  sync, find-file, and a buffer switch all use). G2 expects ONE buffer, but
   *  the switch path is kept (cheap + correct) so a stray switch can't wedge. */
  function onSnapshot(msg) {
    const isSwitch = currentBufferId !== null && msg.bufferId !== currentBufferId;
    if (typeof msg.bufferId === 'string') currentBufferId = msg.bufferId;
    if (isSwitch) pending.clear();
    mirror = createClientBuffer({
      initialText: msg.text,
      name: msg.name || 'server-buffer',
      point: msg.point,
      sendIntent,
    });
    if (view) view.destroy();
    view = mountView(mirror, buildMountOptions());
    if (typeof view.focus === 'function') view.focus();
    log(
      `[godot-g2] mounted real view on '${msg.name}' ` +
      `(${(msg.text || '').length} chars) through the server`
    );
  }

  /** A DELTA: an applied buffer change. Reconcile a predicted echo (the text
   *  already matches — only bump seq/cursor) or apply a server-originated
   *  change fresh. */
  function onDelta(delta) {
    if (!mirror) return;
    const p = delta.echoId != null ? pending.get(delta.echoId) : undefined;
    if (p) pending.delete(delta.echoId);
    mirror.applyDelta(delta, { echoed: !!(p && p.predicted) });
  }

  /** A CURSOR: a point/mark update with no text change (motion). */
  function onCursor(msg) {
    if (!mirror) return;
    if (msg.echoId != null) pending.delete(msg.echoId);
    mirror.cursors[0].point = msg.point;
    mirror.cursors[0].mark = msg.mark ?? null;
    if (view) view.setView({ buffer: mirror });
  }

  /** A CURSORS message: this client's full cursor set (multi-cursor). Skip the
   *  adopt while a predicted self-insert is in flight (local echo is
   *  authoritative for the primary point during rapid typing) — the same guard
   *  the prototype uses; multi-cursor edits come via RESYNC which carries the
   *  set itself, so this never drops a real update. */
  function onCursors(cursors) {
    if (!mirror || !Array.isArray(cursors)) return;
    const predictionsInFlight = [...pending.values()].some((p) => p.predicted);
    if (predictionsInFlight && cursors.length <= 1) return;
    mirror.applyCursors(cursors);
    if (view) view.setView({ buffer: mirror });
  }

  /** An OVERLAYS message: the buffer's shared overlay set. */
  function onOverlays(overlays) {
    if (!mirror) return;
    mirror.applyOverlays(overlays);
    if (view) view.setView({ buffer: mirror });
  }

  /** A RESYNC: canonical text + this client's cursor set (a multi-cursor edit
   *  or a grouped undo). Supersedes in-flight predictions. */
  function onResync(msg) {
    if (!mirror) return;
    for (const [id, p] of pending) {
      if (p.predicted) pending.delete(id);
    }
    mirror.applyResync(msg);
    if (view) view.setView({ buffer: mirror });
  }

  /** A VIEW message: non-text render state (modeline / status / minibuffer /
   *  cursor reconcile / scroll). G2's minimal slice renders the cursor + the
   *  scroll request; the modeline/status/minibuffer DOM is a later slice (the
   *  in-renderer chrome is still present under the flag). We DO reconcile the
   *  cursor (so a command's motion shows) but only when no predicted
   *  self-insert is in flight (else an older point rewinds the caret). */
  function onView(v) {
    if (!v) return;
    if (v.scroll) {
      if (view && typeof view.recenter === 'function' && v.scroll.kind === 'recenter') {
        view.recenter();
      }
      return;
    }
    const predictionsInFlight = [...pending.values()].some((p) => p.predicted);
    if (mirror && typeof v.point === 'number' && !predictionsInFlight) {
      mirror.cursors[0].point = v.point;
      mirror.cursors[0].mark = v.mark ?? null;
      if (view) view.setView({ buffer: mirror });
    }
  }

  /** Route a single decoded server message. Exposed for the unit tests (they
   *  feed messages directly without a real port). */
  function handleMessage(msg) {
    if (!msg) return;
    switch (msg.type) {
      case MSG.SNAPSHOT: onSnapshot(msg); break;
      case MSG.DELTA: onDelta(msg.delta); break;
      case MSG.CURSOR: onCursor(msg); break;
      case MSG.VIEW: onView(msg.view); break;
      case MSG.OVERLAYS: onOverlays(msg.overlays); break;
      case MSG.CURSORS: onCursors(msg.cursors); break;
      case MSG.RESYNC: onResync(msg); break;
      default: break; // BUFFER_LIST / PICKER / PANE_TREE: not in the G2 slice
    }
  }

  /** Wire the port + say HELLO to pull the initial snapshot (which mounts the
   *  view). Idempotent-ish: calling twice re-says HELLO. */
  function connect() {
    port.onmessage = (e) => handleMessage(e.data);
    if (typeof port.start === 'function') port.start();
    connected = true;
    port.postMessage({ type: MSG.HELLO });
    log('[godot-g2] connected to server; HELLO sent');
  }

  /** Tear down the mounted view + drop the port handler. */
  function destroy() {
    if (view) {
      try { view.destroy(); } catch { /* ignore */ }
      view = null;
    }
    mirror = null;
    connected = false;
    try { port.onmessage = null; } catch { /* ignore */ }
  }

  return {
    connect,
    dispatchKey,
    handleMessage,
    getMirror: () => mirror,
    getView: () => view,
    isConnected: () => connected,
    currentBufferId: () => currentBufferId,
    // Exposed so app.js can route a normalised keydown if it owns capture.
    keyEventToString,
    destroy,
  };
}
