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
 * The split (plan §4, §5):
 *   - input capture + normalisation (→ a key-string) is client-side;
 *   - EVERY key — a bare printable included — routes to the server as a KEY
 *     intent so the server's `handle-key`/keymap decides the effect (this is
 *     what makes auto-pair, electric keys, and prefix chords fire). The earlier
 *     local-echo short-circuit for a bare self-insert was dropped: it bypassed
 *     the keymap, and Phase-0 showed the round-trip isn't perceptibly slower.
 *   - the client renders the view-state the server sends down — the text mirror
 *     (DELTA/RESYNC), the cursor set (CURSOR/CURSORS), the overlays (OVERLAYS),
 *     and (in server-mode) the DOM chrome: the modeline / echo-area / pending
 *     prefix (VIEW), the minibuffer prompt (VIEW.minibuffer), and the generic
 *     picker (PICKER). The chrome hooks are injected (fakeable in tests).
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
 * @param {object} [deps.chrome]
 *   The DOM chrome the server drives in server-mode (injected so it is fakeable
 *   in tests; `app.js` passes the real modeline / echo-area / minibuffer /
 *   picker hosts). All optional — a missing hook is a no-op (the G2 cursor/text
 *   path is unaffected).
 * @param {(modeline: string, viewState: object) => void} [deps.chrome.setModeline]
 *   Render the server view's modeline string into the modeline DOM.
 * @param {(status: string) => void} [deps.chrome.setEcho]
 *   Render the echo-area / pending-prefix text (e.g. `C-x-`); '' clears it.
 * @param {(prompt: string, value: string, cbs: {
 *     onChange: (v: string) => void,
 *     onSubmit: (v: string) => void,
 *     onCancel: () => void,
 *   }) => void} [deps.chrome.openMinibuffer]
 *   Open the real minibuffer for a server-suspended read; the cbs route input
 *   back up as MINIBUFFER_CHANGE/SUBMIT/CANCEL intents.
 * @param {() => void} [deps.chrome.closeMinibuffer]
 *   Close the minibuffer (the server resolved/cancelled the read).
 * @param {(request: object, cbs: {
 *     onChoose: (value: *) => void, onCancel: () => void,
 *   }) => void} [deps.chrome.openPicker]
 *   Open the client picker panel for a PICKER request; the cbs route the
 *   choice/cancel back up as PICKER_CHOOSE/PICKER_CANCEL intents.
 * @param {() => void} [deps.chrome.closePicker]
 *   Tear down any open picker panel (a switch / teardown).
 * @param {(buffers: object[]) => void} [deps.chrome.setBufferList]
 *   Render the server's open-buffer set (a BUFFER_LIST push) as the in-renderer
 *   tabs + View List in server mode. Each record is `{ id, name, lineCount,
 *   modified, filePath, current }`.
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
  chrome = {},
  // Subscribe to viewport-size changes (the window/pane resizing). Called with
  // the report callback; returns an unsubscribe fn. Injected so the client is
  // unit-testable with no DOM — `app.js` wires it to the real `window` resize.
  // Default: a no-op subscription (tests drive `reportViewport` directly).
  subscribeResize = () => () => {},
  // Session restore (B2): the window's current frame + display, for the geometry
  // the session records. `getWindowBounds` is a one-shot pull (reported on
  // connect); `subscribeWindowBounds` fires on every window move/resize (returns
  // an unsubscribe). Both injected by app.js from the host; no-ops in tests.
  getWindowBounds = () => Promise.resolve(null),
  subscribeWindowBounds = () => () => {},
  // The REPL / utility-dock visibility `{ visible }`, for the workspace. Pulled
  // on connect; app.js also calls reportDock() after a manual toggle. No-op in
  // tests.
  getDockState = () => null,
  // The renderer-owned command names (element-views) announced to the server on
  // connect, so M-x routes them back down via RUN_CLIENT_COMMAND. A function so
  // it is read at connect time (the registry is populated as stdlib loads).
  clientCommandNames = () => [],
  // Run a renderer-owned command by name (RUN_CLIENT_COMMAND). Injected by
  // app.js to `(run-command (quote NAME))` in the renderer interpreter.
  runClientCommand = () => {},
  log = (msg) => console.info(msg),
}) {
  /** @type {ReturnType<typeof createClientBuffer> | null} */
  let mirror = null;
  /** @type {ReturnType<typeof mountView> | null} */
  let view = null;
  let connected = false;
  let currentBufferId = null;
  let nextIntentId = 1;

  // --- the server-driven DOM chrome (server-mode only) -----------------
  // Hooks the caller (app.js) supplies; each missing one is a no-op so the
  // unit tests + the core text path run without any chrome.
  const setModelineDom = chrome.setModeline ?? (() => {});
  const setEchoDom = chrome.setEcho ?? (() => {});
  const openMinibufferDom = chrome.openMinibuffer ?? (() => {});
  const closeMinibufferDom = chrome.closeMinibuffer ?? (() => {});
  const openPickerDom = chrome.openPicker ?? (() => {});
  const closePickerDom = chrome.closePicker ?? (() => {});
  // The server's open-buffer set (BUFFER_LIST): the host renders these as the
  // in-renderer tabs + View List in server mode. A no-op until the host wires
  // it (the core text path is unaffected).
  const setBufferListDom = chrome.setBufferList ?? (() => {});
  // Quit (C-x C-c): window-lifecycle, not buffer editing — the server can't
  // close the renderer window, so the client owns the quit chord and asks the
  // host to quit. A no-op until the host wires it.
  const requestQuitDom = chrome.requestQuit ?? (() => {});
  // New Window (G4): the server resolves C-x 5 2 → the new-window command and
  // sends WINDOW_NEW down; the client asks its host to open another window (a
  // new client on the shared server). Window lifecycle is the host's job, like
  // quit. A no-op until the host wires it.
  const requestNewWindowDom = chrome.requestNewWindow ?? (() => {});
  // Session restore (B2): apply a saved window frame to THIS window (SET_WINDOW_
  // BOUNDS, sent to window 1 on restore). The host reconciles + resizes; a no-op
  // until wired.
  const setWindowBoundsDom = chrome.setWindowBounds ?? (() => {});
  // Workspace restore: re-show/hide the REPL / utility dock to its saved state.
  const setDockDom = chrome.setDock ?? (() => {});
  // PANE_TREE (G4 Step 3): the server pushes this window's logical pane layout
  // (split structure + per-leaf buffer/view-state + the focused leaf; no
  // pixels). The host renders it — splits become visible. A no-op until wired.
  const setPaneTreeDom = chrome.setPaneTree ?? (() => {});
  // MINIBUFFER_COMPLETIONS: the server's reply to a TAB-completion request — the
  // completed value + the candidate list. The host fills the minibuffer + shows
  // the candidates (find-file). A no-op until wired.
  const showCompletionsDom = chrome.showCompletions ?? (() => {});

  // Whether a server minibuffer read is currently open in the DOM, and the
  // id of the picker the client is showing (so a stale reply is dropped and a
  // superseded picker is torn down). These mirror the server's active-prompt /
  // active-picker bookkeeping so the client opens/closes in lock-step.
  let minibufferActive = false;
  let activePickerId = null;
  // The last buffer-list the server pushed: `[{ id, name, lineCount, modified,
  // filePath, current }]`. The server re-sends it on every buffer-set change
  // (open / switch / kill) so the host's tabs stay in sync; cached here so a
  // late host wire (or a test) can read the current set.
  let lastBufferList = [];
  // G4 Step 1: how this window presents its root, from the snapshot. 'tabline'
  // (window 1 — welcome / restored session) or 'single' (a fresh window — one
  // composable pane on its own *scratch*, no forced tabline). Passed to mountView
  // so the host mounts the right root. Stable per window; defaults to 'tabline'.
  let windowKind = 'tabline';
  // The previous keystroke, tracked ONLY to catch the C-x C-c quit chord
  // client-side (the server leaves it unbound — quitting the window is a host
  // action). Any key between C-x and C-c resets it, so it never misfires.
  let lastDispatchedKey = null;

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

  /** Send a PANE intent (Step 3 — e.g. a click focusing a leaf by id, a split,
   *  a resize): the server mutates THIS window's logical pane tree and re-pushes
   *  PANE_TREE. Keeps the server's focused leaf in step with the client's UI so
   *  a server-side command (C-x 3, find-file) acts on the pane the user sees
   *  focused. */
  function sendPaneIntent(intent) {
    port.postMessage({ type: MSG.PANE, intent });
  }

  /** Send a pure KEY intent (no local echo — the server's `handle-key`/keymap
   *  decides the effect). Registers a pending entry (un-predicted) so the
   *  echoed DELTA reconciles through the mirror's delta path. */
  function sendKey(key) {
    const id = nextIntentId++;
    pending.set(id, { predicted: false });
    port.postMessage({ type: MSG.INTENT, intent: { id, kind: INTENT.KEY, key } });
  }

  /** Measure the mounted view's visible text-line count and report it UP as a
   *  VIEWPORT message, so the server can size a screenful (C-v/M-v scroll, plan
   *  §5d — only the client knows how many lines fit). Called on mount + on
   *  resize. A no-op until a view is mounted, or when the measurement is not a
   *  positive finite number (e.g. a 0-height view before its first layout) —
   *  the server keeps its last good value. */
  function reportViewport() {
    if (!view || typeof view.pageLines !== 'function') return;
    let lines;
    try { lines = view.pageLines(); } catch { return; }
    if (!Number.isFinite(lines) || lines <= 0) return;
    port.postMessage({ type: MSG.VIEWPORT, lines: Math.floor(lines) });
  }

  /** Report this window's frame + display to the server (B2 geometry). The
   *  descriptor is `{ bounds: {x,y,width,height}, display: {...} }` from the host;
   *  a null/incomplete descriptor is ignored (the server keeps its last value). */
  function reportBounds(descriptor) {
    if (!descriptor || !descriptor.bounds) return;
    port.postMessage({
      type: MSG.WINDOW_BOUNDS,
      bounds: descriptor.bounds,
      display: descriptor.display ?? null,
    });
  }

  /** Report the REPL / utility-dock visibility to the server (the workspace
   *  records it). Called on connect + by app.js after a manual toggle. */
  function reportDock() {
    const dock = getDockState();
    if (dock && typeof dock === 'object') port.postMessage({ type: MSG.WINDOW_DOCK, dock });
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
    // C-x C-c quits the window. The server keymap leaves this chord unbound
    // (quitting is a host action it can't perform), so the client resolves it:
    // `lastDispatchedKey` shadows the server's prefix state for this ONE chord.
    if (lastDispatchedKey === 'C-x' && keyString === 'C-c') {
      lastDispatchedKey = null;
      requestQuitDom();
      return true;
    }
    lastDispatchedKey = keyString;
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
      // G4 Step 1: how the host should mount this window's root — 'single' (one
      // composable pane, a fresh window) or 'tabline' (window 1). The harness /
      // tests ignore it; app.js's mountServerView branches on it.
      windowKind,
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

  // --- the server-driven chrome (modeline / echo / minibuffer) ----------
  //
  // Drive the real app's chrome DOM from the server's VIEW view-state. The
  // server bakes the modeline string (renderModeline), the echo-area / pending
  // prefix (`status`, e.g. "C-x-" mid-chord), and the minibuffer prompt state
  // into every VIEW message after an intent, so the client just paints them.

  /** Open the DOM minibuffer for a server-suspended read, routing the user's
   *  input back up as MINIBUFFER_* intents. Idempotent on re-open with the same
   *  prompt (the server re-sends the active prompt on each VIEW). */
  function openMinibufferPrompt(mb) {
    openMinibufferDom(mb.prompt ?? '', mb.value ?? '', {
      onChange: (v) => port.postMessage({
        type: MSG.INTENT,
        intent: { id: nextIntentId++, kind: INTENT.MINIBUFFER_CHANGE, value: v },
      }),
      onSubmit: (v) => port.postMessage({
        type: MSG.INTENT,
        intent: { id: nextIntentId++, kind: INTENT.MINIBUFFER_SUBMIT, value: v },
      }),
      onCancel: () => port.postMessage({
        type: MSG.INTENT,
        intent: { id: nextIntentId++, kind: INTENT.MINIBUFFER_CANCEL },
      }),
    });
  }

  /** Paint the modeline + echo area + minibuffer from a VIEW's view-state.
   *  A `scroll`-only VIEW (no view-state) is skipped by the caller. */
  function renderChrome(v) {
    if (typeof v.modeline === 'string') setModelineDom(v.modeline, v);
    // The echo area shows the server's status (a mid-chord prefix like "C-x-",
    // or a one-off message). Only paint it while no minibuffer prompt is open —
    // the prompt row owns the line then (the minibuffer component hides the
    // echo while a prompt is up; this avoids fighting it).
    const mb = v.minibuffer;
    const mbActive = !!(mb && mb.active);
    if (!mbActive && typeof v.status === 'string') setEchoDom(v.status);
    // Minibuffer open/close transitions, in lock-step with the server.
    if (mbActive && !minibufferActive) {
      minibufferActive = true;
      openMinibufferPrompt(mb);
    } else if (!mbActive && minibufferActive) {
      minibufferActive = false;
      closeMinibufferDom();
    }
  }

  /** A PICKER: the server opened a generic picker (buffer list, M-x, RefTeX,
   *  completions). Render the client picker panel and route the choice/cancel
   *  back up. A superseded picker (a new id) replaces the old one. */
  function onPicker(req) {
    if (!req || typeof req !== 'object') return;
    if (activePickerId && activePickerId !== req.id) closePickerDom();
    activePickerId = req.id;
    openPickerDom(req, {
      onChoose: (value) => {
        const id = activePickerId;
        activePickerId = null;
        port.postMessage({
          type: MSG.INTENT,
          intent: { id: nextIntentId++, kind: INTENT.PICKER_CHOOSE, value, pickerId: id },
        });
      },
      onCancel: () => {
        const id = activePickerId;
        activePickerId = null;
        port.postMessage({
          type: MSG.INTENT,
          intent: { id: nextIntentId++, kind: INTENT.PICKER_CANCEL, pickerId: id },
        });
      },
      // A deletable row was removed (⌫) — the panel stays OPEN, so keep
      // activePickerId; just tell the server to delete that workspace.
      onDelete: (value) => {
        port.postMessage({
          type: MSG.INTENT,
          intent: { id: nextIntentId++, kind: INTENT.PICKER_DELETE, value, pickerId: activePickerId },
        });
      },
    });
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
    if (typeof msg.windowKind === 'string') windowKind = msg.windowKind;
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
    // Report the freshly-mounted view's visible line count so screenful scroll
    // (C-v/M-v) is sized correctly from the first keystroke. A frame later the
    // real layout has settled, so re-measure then too (the first pageLines()
    // can read a transient 0-height before the reveal paints).
    reportViewport();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(reportViewport);
    }
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
   *  cursor reconcile / scroll). We reconcile the cursor (so a command's motion
   *  shows) when no predicted self-insert is in flight, AND drive the DOM chrome
   *  (modeline / echo-area / minibuffer) from the same view-state. A
   *  `scroll`-only VIEW carries no view-state and just recenters. */
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
    renderChrome(v);
  }

  /** A BUFFER_LIST: the server's full open-buffer set for THIS client, each
   *  record flagged `current` for the buffer this client is on. The server
   *  re-sends it on every buffer-set change (open / switch / kill), so the host
   *  renders the in-renderer tabs + View List from it (server mode). Cached so
   *  a late host wire can read the latest set. */
  function onBufferList(buffers) {
    if (!Array.isArray(buffers)) return;
    lastBufferList = buffers;
    setBufferListDom(buffers);
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
      case MSG.PICKER: onPicker(msg.picker); break;
      case MSG.BUFFER_LIST: onBufferList(msg.buffers); break;
      case MSG.WINDOW_NEW: requestNewWindowDom(msg.geometry); break;
      case MSG.SET_WINDOW_BOUNDS: setWindowBoundsDom(msg.geometry); break;
      case MSG.SET_DOCK: setDockDom(msg.dock); break;
      case MSG.RUN_CLIENT_COMMAND:
        // The server dispatched a renderer-owned command (an element-view): run
        // it in the renderer, where its spec is computed (it calls back via
        // openElementView → OPEN_ELEMENT_SOURCE). `bibPath` (when present) is the
        // active document's bibliography the server resolved for bib-search.
        if (typeof msg.name === 'string' && msg.name !== '') {
          try { runClientCommand(msg.name, msg.bibPath ?? null); } catch { /* surfaced by app.js */ }
        }
        break;
      case MSG.PANE_TREE: setPaneTreeDom(msg.tree); break;
      case MSG.MINIBUFFER_COMPLETIONS:
        showCompletionsDom({ value: msg.value, items: msg.items, directory: msg.directory });
        break;
      default: break; // PANE_TREE: not in this slice
    }
  }

  /** Drop the resize / window-bounds subscriptions, when active. */
  let unsubscribeResize = null;
  let unsubscribeBounds = null;

  /** Wire the port + say HELLO to pull the initial snapshot (which mounts the
   *  view). Idempotent-ish: calling twice re-says HELLO. */
  function connect() {
    port.onmessage = (e) => handleMessage(e.data);
    if (typeof port.start === 'function') port.start();
    connected = true;
    // Re-report the viewport when the window/pane resizes, so a screenful
    // tracks the live height. Injected (a no-op in tests).
    if (!unsubscribeResize) unsubscribeResize = subscribeResize(reportViewport);
    // B2: report this window's frame now (a one-shot pull) + on every later
    // move/resize, so the session snapshot records its geometry.
    try { Promise.resolve(getWindowBounds()).then(reportBounds).catch(() => {}); } catch { /* no host */ }
    if (!unsubscribeBounds) unsubscribeBounds = subscribeWindowBounds(reportBounds);
    reportDock(); // the REPL/dock visibility, for the workspace
    port.postMessage({ type: MSG.HELLO });
    // Announce the renderer-owned commands (element-views) so the server can
    // route them back down via RUN_CLIENT_COMMAND. Tolerant of a bad getter.
    try {
      const names = typeof clientCommandNames === 'function'
        ? clientCommandNames() : clientCommandNames;
      if (Array.isArray(names) && names.length > 0) {
        port.postMessage({ type: MSG.CLIENT_COMMANDS, names });
      }
    } catch { /* ignore — element-views just won't be M-x-routable */ }
    log('[godot-g2] connected to server; HELLO sent');
  }

  /** Tear down the mounted view + chrome + drop the port handler. */
  function destroy() {
    if (view) {
      try { view.destroy(); } catch { /* ignore */ }
      view = null;
    }
    if (minibufferActive) {
      minibufferActive = false;
      try { closeMinibufferDom(); } catch { /* ignore */ }
    }
    if (activePickerId) {
      activePickerId = null;
      try { closePickerDom(); } catch { /* ignore */ }
    }
    if (unsubscribeResize) {
      try { unsubscribeResize(); } catch { /* ignore */ }
      unsubscribeResize = null;
    }
    if (unsubscribeBounds) {
      try { unsubscribeBounds(); } catch { /* ignore */ }
      unsubscribeBounds = null;
    }
    mirror = null;
    connected = false;
    try { port.onmessage = null; } catch { /* ignore */ }
  }

  /** Ask the server to switch this client to buffer BUFFERID (a tab click or
   *  View-List select in server mode). The server switches + re-syncs us with a
   *  fresh SNAPSHOT (re-points the façade) and a fresh BUFFER_LIST (re-marks the
   *  active tab). A no-op for a falsy id. */
  function switchBuffer(bufferId) {
    if (!bufferId) return;
    port.postMessage({
      type: MSG.INTENT,
      intent: { id: nextIntentId++, kind: INTENT.SWITCH_BUFFER, bufferId },
    });
  }

  /** Ask the server to TAB-complete the open minibuffer prompt against VALUE (a
   *  read-only query — find-file path completion). The reply is a
   *  MINIBUFFER_COMPLETIONS the chrome renders (fill the input + show candidates). */
  function requestMinibufferComplete(value) {
    port.postMessage({ type: MSG.MINIBUFFER_COMPLETE, value: String(value ?? '') });
  }

  /** Ask the server to open the file at PATH directly (no minibuffer) — a file
   *  clicked in a directory-view. The server runs the same `visitFile` find-file
   *  uses, switching this client onto the opened buffer. A no-op for a falsy path. */
  function visitPath(path) {
    if (!path) return;
    port.postMessage({
      type: MSG.INTENT,
      intent: { id: nextIntentId++, kind: INTENT.VISIT_FILE, path: String(path) },
    });
  }

  /** Ask the server to hold a renderer-computed element-view SPEC as a
   *  data-source + switch this client's focused leaf to it (the renderer's
   *  `open-element-view!` in server mode). SPEC is plain JSON:
   *  `{ name, tag, moduleUrl, attrs, fit, keyboard, noFocus }`. */
  function openElementView(spec) {
    if (!spec || typeof spec !== 'object') return;
    port.postMessage({ type: MSG.OPEN_ELEMENT_SOURCE, spec });
  }

  /** Insert TEXT into the server's active buffer at point — the generic
   *  element-view `insert-text` channel in server mode (e.g. bib-search drops
   *  `\cite{…}` into the document, which keeps focus as a :no-focus panel). The
   *  server fans the resulting delta back, so the document updates. */
  function insertText(text) {
    if (typeof text !== 'string' || text === '') return;
    port.postMessage({
      type: MSG.INTENT,
      intent: { id: nextIntentId++, kind: INTENT.SELF_INSERT, text },
    });
  }

  /** Close (kill) the server buffer BUFFERID — a tab `×`. Switch this client to
   *  it (so it is current), then run the server's kill-buffer via its `C-x k`
   *  binding; the server re-homes the client onto a survivor buffer and
   *  re-pushes BUFFER_LIST, so the tab disappears. The server refuses to kill
   *  the only buffer (a status message). Reuses the existing switch + kill
   *  machinery — no new server intent. A no-op for a falsy id. */
  function closeBuffer(bufferId) {
    if (!bufferId) return;
    switchBuffer(bufferId);
    sendKey('C-x');
    sendKey('k');
  }

  /** Send an outline edit from the bookmark VIEW to the server (a mutable
   *  'bookmark' data-source): a semantic op `{ op, id?, name? }` — jump / rename
   *  / delete / indent / outdent / toggle — tagged with the SOURCEID it acts on.
   *  The server applies it (authoritative), persists the sidecar, and fans the
   *  fresh outline back; the view re-renders from that (it never mutates its own
   *  copy). A no-op for a falsy source id / op. */
  function bookmarkOp(sourceId, op) {
    if (!sourceId || !op || typeof op !== 'object') return;
    port.postMessage({
      type: MSG.INTENT,
      intent: { id: nextIntentId++, kind: INTENT.BOOKMARK_OP, sourceId: String(sourceId), op },
    });
  }

  return {
    connect,
    dispatchKey,
    sendPaneIntent,
    // Re-report the REPL/dock visibility (app.js calls this after a manual toggle
    // + before a workspace save, so the saved arrangement is current).
    reportDock,
    handleMessage,
    getMirror: () => mirror,
    getView: () => view,
    isConnected: () => connected,
    currentBufferId: () => currentBufferId,
    // The server's open-buffer set (the last BUFFER_LIST). The host reads this
    // to render the tabs + View List; exposed for tests too.
    getBufferList: () => lastBufferList,
    // Ask the server to switch this client's buffer (tab click / C-x b / View
    // List select). The re-sync re-points the façade + re-marks the active tab.
    switchBuffer,
    // Ask the server to TAB-complete the open minibuffer (find-file path).
    requestMinibufferComplete,
    // Open a file by absolute path (a directory-view file click).
    visitPath,
    // Hold a renderer-computed element-view spec as a server data-source.
    openElementView,
    // Insert text into the server's active buffer (element-view insert-text).
    insertText,
    // Send a bookmark-outline edit op (jump/rename/delete/indent/outdent/toggle).
    bookmarkOp,
    // Close (kill) a server buffer by id (a tab ×): switch-to + C-x k.
    closeBuffer,
    // Measure + report the visible line count UP (VIEWPORT). Exposed so the
    // unit tests can drive it directly (no DOM resize event needed) and so
    // app.js can re-report on demand.
    reportViewport,
    // Exposed so app.js can route a normalised keydown if it owns capture.
    keyEventToString,
    destroy,
  };
}
