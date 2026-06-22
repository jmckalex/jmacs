/**
 * @file Model-B command-spine SERVER, run in an Electron `utilityProcess`
 * (a Node child; plan §3 (i)). Authoritative for the interpreter + buffer
 * model + the whole command surface; clients keep a replicated mirror and
 * render locally (plan §4).
 *
 * This server runs the REAL command machinery — see spine.js — so a single
 * window is a genuinely usable editor *through the server*: self-insert,
 * motion, editing, M-x, find-file and the minibuffer all dispatch
 * server-side and render client-side.
 *
 * It also serves N clients on the SAME shared buffer (the Model-B payoff):
 * each client gets its own view (its own point/mark) over one shared text;
 * a text delta fans out to every client (they all see the edit), while a
 * cursor move touches only the client that made it. (plan §4 "per-window vs
 * per-buffer state"; §6 "one buffer in N windows".)
 *
 * The two wire streams (plan §4):
 *   - up   (client → server): key/edit + minibuffer INTENTS, never edits.
 *   - down (server → client): buffer DELTAs (the L1 change shape), plus
 *     VIEW messages for the per-client non-text render state (cursor,
 *     modeline, status, minibuffer) and SNAPSHOTs on a buffer swap.
 *
 * Lifecycle: main forks this module, then transfers MessageChannelMain
 * ports over `process.parentPort` — one per client window.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MSG, INTENT, MINIBUFFER_IDLE } from './protocol.js';
import { createSpine } from './spine.js';

// --- the canonical model: a real file in the command spine -------------

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(
  here, '..', '..', '..', 'packages', 'renderer', 'src', 'view.js'
);
const filePath = process.env.MWB_FILE || DEFAULT_FILE;

let initialText;
let bufferName;
try {
  initialText = readFileSync(filePath, 'utf8');
  bufferName = basename(filePath);
} catch (error) {
  console.error(`[mwb-server] could not read ${filePath}: ${error.message}`);
  initialText = '; could not load file — type here.\n';
  bufferName = 'mwb-scratch.lisp';
}

// A monotonic delta sequence number, so a client can order deltas and
// detect gaps (plan §4 — correctness of replication).
let seq = 0;

// The id of the intent currently being applied, so the delta we emit can
// echo it back to the originating client.
let currentEchoId;

// The minibuffer is global (one prompt at a time, shared model). The
// originating client's id, so its VIEW carries the active prompt.
let minibufferState = MINIBUFFER_IDLE;
let minibufferClient = null;

/** Read a file off disk for find-file (the openFile spine effect). */
function readFileForVisit(path) {
  try {
    const abs = resolve(dirname(filePath), path);
    return { text: readFileSync(abs, 'utf8'), name: basename(abs) };
  } catch (error) {
    console.error(`[mwb-server] find-file: ${error.message}`);
    return null;
  }
}

// --- the command spine ------------------------------------------------

const spine = createSpine(
  { initialText, name: bufferName },
  {
    // Effects are raised while a specific client's view is active (see
    // applyIntent → setActiveClient), so they refresh that client. We refresh
    // ALL clients' view-state after each intent in applyIntent anyway; these
    // hooks cover the minibuffer/status/scroll specifics.
    onStatus: () => broadcastView(),
    onMinibufferOpen: (prompt) => openMinibuffer(prompt),
    onMinibufferClose: () => closeMinibuffer(),
    onScroll: (req) => sendScrollToActive(req),
    // Overlays are PER-BUFFER, SHARED state: a highlight added on one window
    // appears in every window viewing the SAME buffer. Broadcast the active
    // buffer's fresh snapshot to all clients on that buffer when it changes.
    onOverlays: () => broadcastOverlaysForActiveBuffer(),
    // A text change on a buffer (tagged with its id): fan the delta only to
    // the clients viewing THAT buffer (multi-buffer — not a broadcast).
    onBufferChange: (id, event) => fanDelta(id, event),
    // A kill-buffer switched a client to a new buffer: re-snapshot every
    // client now viewing the active buffer (the kill re-homed them).
    onBufferSwitched: () => onKillReHome(),
    // list-buffers (C-x C-b): send the active client its buffer-list records.
    onBufferList: () => { if (activeClient) sendBufferListTo(activeClient); },
    openFile: readFileForVisit,
  }
);

// --- the client registry ----------------------------------------------
//
// Each client is { port, index }, where `index` is the client's view index
// in the spine (its own cursor over the shared buffer). The default view
// (spine index 0) belongs to the first client; further clients get a fresh
// view via spine.addClientView().

/** @type {{ port: import('electron').MessagePortMain, index: number }[]} */
const clients = [];

/** The client currently being served (whose intent we're applying), so an
 *  effect (status/minibuffer/scroll) targets the right window. */
let activeClient = null;

function registerClient(port) {
  // Client 0 reuses the spine's default view; later clients get their own.
  const index = clients.length === 0 ? 0 : spine.addClientView();
  const client = { port, index };
  clients.push(client);
  port.on('message', (event) => onClientMessage(client, event));
  port.start();
  // The client asks for its snapshot itself via HELLO once its page +
  // highlighters are ready (onClientMessage), so we don't snapshot here —
  // a pre-load snapshot would race the page and be discarded.
  console.error(
    `[mwb-server] client ${index} attached (${clients.length} total)`
  );
}

// --- delta fan-out (per-buffer) ----------------------------------------
//
// A text change on a buffer fans out only to the clients VIEWING that
// buffer (multi-buffer: different windows hold different buffers, so a
// delta is no longer a broadcast). The registry tags each change with the
// buffer's id (onBufferChange → fanDelta); we match clients by their
// current buffer.

/** Fan a buffer's text change to the clients viewing that buffer. */
function fanDelta(bufferId, event) {
  seq += 1;
  const delta = {
    start: event.change.start,
    removed: event.change.removed,
    inserted: event.change.inserted,
    point: event.point,
    seq,
  };
  for (const c of clients) {
    if (spine.currentBufferIdOf(c.index) !== bufferId) continue;
    // Only the originating client gets the echoId (to reconcile its
    // optimistic edit); the others apply the delta fresh to their mirror.
    const echoId = c === activeClient ? currentEchoId : undefined;
    c.port.postMessage({ type: MSG.DELTA, delta: { ...delta, echoId } });
  }
}

// --- down-channel senders ---------------------------------------------

/** Send a VIEW message to one client with ITS OWN view-state (its cursor
 *  over the shared text + the shared modeline/status + minibuffer if it
 *  owns the prompt). */
function sendViewTo(client) {
  const vs = spine.viewStateOf(client.index);
  const minibuffer = client === minibufferClient ? minibufferState : MINIBUFFER_IDLE;
  client.port.postMessage({
    type: MSG.VIEW,
    view: { ...vs, minibuffer, seq },
  });
}

/** Refresh every client's view-state (after an edit/motion: their cursors
 *  may have shifted under an insert, the modeline changed, etc.). */
function broadcastView() {
  for (const c of clients) sendViewTo(c);
}

/** Send a client its FULL cursor set (primary + every secondary), so the
 *  renderer paints each caret. Cursors are PER-CLIENT window-state (a
 *  secondary cursor on client 0 is not on client 1), so this targets one
 *  client with its own set. */
function sendCursorsTo(client) {
  client.port.postMessage({
    type: MSG.CURSORS,
    cursors: spine.cursorsOf(client.index),
    seq,
  });
}

/** Broadcast the ACTIVE buffer's overlay set to the clients viewing THAT
 *  buffer. Overlays are per-buffer shared state, so a highlight added in one
 *  window shows in every window on the same buffer — but NOT in a window
 *  viewing a different buffer. */
function broadcastOverlaysForActiveBuffer() {
  const activeId = activeClient
    ? spine.currentBufferIdOf(activeClient.index)
    : spine.currentBufferIdOf(0);
  const overlays = spine.overlaySnapshotOf(activeId);
  for (const c of clients) {
    if (spine.currentBufferIdOf(c.index) !== activeId) continue;
    c.port.postMessage({ type: MSG.OVERLAYS, overlays, seq });
  }
}

/** Send one client its current buffer's overlay set (on a switch / HELLO). */
function sendOverlaysTo(client) {
  client.port.postMessage({
    type: MSG.OVERLAYS,
    overlays: spine.overlaySnapshotOf(spine.currentBufferIdOf(client.index)),
    seq,
  });
}

/** Send a client the buffer-list records (C-x C-b), each flagged with
 *  whether it is that client's current buffer. */
function sendBufferListTo(client) {
  client.port.postMessage({
    type: MSG.BUFFER_LIST,
    buffers: spine.bufferListRecords(client.index),
    seq,
  });
}

/** Open the minibuffer for the active client (the one that ran the
 *  command). One prompt at a time in the shared model. */
function openMinibuffer(prompt) {
  minibufferClient = activeClient;
  minibufferState = { active: true, prompt, value: '' };
  if (minibufferClient) sendViewTo(minibufferClient);
}

function closeMinibuffer() {
  const was = minibufferClient;
  minibufferState = MINIBUFFER_IDLE;
  minibufferClient = null;
  if (was) sendViewTo(was);
}

/** A scroll/centering request the active client must execute in pixels. */
function sendScrollToActive(req) {
  if (activeClient) activeClient.port.postMessage({ type: MSG.VIEW, view: { scroll: req } });
}

/** Send one client a full snapshot of ITS CURRENT buffer (initial sync /
 *  a buffer switch). The snapshot carries the buffer id so the client knows
 *  which buffer it is now mirroring. */
function sendSnapshot(client) {
  spine.setActiveClient(client.index);
  client.port.postMessage({
    type: MSG.SNAPSHOT,
    text: spine.buffer.text,
    point: spine.viewStateOf(client.index).point,
    name: spine.buffer.name,
    bufferId: spine.currentBufferIdOf(client.index),
    clientIndex: client.index, // so a client knows whether it's the typer
    seq,
  });
}

/** Fully re-sync a client onto its current buffer: snapshot + view-state +
 *  its own cursor set + that buffer's overlays. Used after a buffer switch
 *  (the client must tear down its old mirror and build a fresh one). */
function resyncClientToCurrentBuffer(client) {
  spine.setActiveClient(client.index);
  sendSnapshot(client);
  sendViewTo(client);
  sendCursorsTo(client);
  sendOverlaysTo(client);
}

/** Switch a client to a buffer (by id) and re-sync it onto the new buffer.
 *  The other clients are untouched (multi-buffer: switching one window's
 *  buffer must not disturb another window). Returns true on success. */
function switchClientToBuffer(client, bufferId) {
  if (!bufferId) return false;
  const ok = spine.switchClientToBuffer(client.index, bufferId);
  if (ok) resyncClientToCurrentBuffer(client);
  return ok;
}

/** After a kill-buffer re-homed clients onto a survivor buffer, re-sync
 *  every client whose current buffer is now the active client's buffer (the
 *  ones the kill moved). Simpler + safe: re-sync ALL clients — a no-op for a
 *  client whose buffer didn't change is just an extra snapshot. */
function onKillReHome() {
  for (const c of clients) resyncClientToCurrentBuffer(c);
  // Restore the active client binding (the loop left it on the last client).
  if (activeClient) spine.setActiveClient(activeClient.index);
}

// --- intent handling ----------------------------------------------------

function applyIntent(client, intent) {
  activeClient = client;
  spine.setActiveClient(client.index); // this client's cursor is now active
  currentEchoId = intent.id;
  const buffer = spine.buffer;
  const pointBefore = buffer.point;
  const wasSeq = seq;
  // A multi-cursor edit makes SEVERAL L1 edits but emits ONE change event,
  // so the single-delta fan-out can't replicate it; we RESYNC instead. The
  // edit may also COLLAPSE the cursor set (e.g. typing collapses overlapping
  // carets), so we check the count BEFORE and AFTER and resync if either is
  // multi.
  const multiBefore = spine.activeCursorCount() > 1;
  try {
    switch (intent.kind) {
      case INTENT.SELF_INSERT:
        buffer.insert(String(intent.text ?? ''));
        break;
      case INTENT.DELETE_BACKWARD:
        spine.handleKey('backspace');
        break;
      case INTENT.KEY:
        spine.handleKey(String(intent.key ?? ''));
        break;
      case INTENT.POINT:
        buffer.moveTo(Number(intent.point) || 0);
        break;
      case INTENT.MINIBUFFER_SUBMIT:
        handleMinibufferSubmit(String(intent.value ?? ''));
        break;
      case INTENT.MINIBUFFER_CANCEL:
        spine.deliverMinibuffer(null);
        break;
      case INTENT.MINIBUFFER_CHANGE:
        if (minibufferState.active) {
          minibufferState = { ...minibufferState, value: String(intent.value ?? '') };
        }
        break;
      case INTENT.SWITCH_BUFFER: {
        // A direct buffer switch (clicking a buffer-list row): resolve by id
        // or name, switch this client, and re-sync it onto the new buffer.
        const id = intent.bufferId
          || (intent.bufferName ? spine.bufferIdByName(String(intent.bufferName)) : null);
        if (id) {
          switchClientToBuffer(client, id);
          activeClient = null;
          return; // the switch fully re-synced the client; skip the edit path
        }
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.error(`[mwb-server] intent error: ${error.message}`);
  } finally {
    currentEchoId = undefined;
  }

  const emittedDelta = seq !== wasSeq;
  const multiAfter = spine.activeCursorCount() > 1;
  const wasMultiCursorEdit = emittedDelta && (multiBefore || multiAfter);

  if (wasMultiCursorEdit) {
    // The single forwarded delta is unreliable for a multi-cursor edit;
    // RESYNC the clients ON THIS BUFFER with the canonical text + their own
    // cursor set. A client viewing a DIFFERENT buffer must not be resynced
    // with this buffer's text — that would corrupt its mirror.
    const editedBufferId = spine.currentBufferIdOf(client.index);
    for (const c of clients) {
      if (spine.currentBufferIdOf(c.index) !== editedBufferId) continue;
      c.port.postMessage({
        type: MSG.RESYNC,
        text: spine.buffer.text,
        cursors: spine.cursorsOf(c.index),
        seq,
      });
    }
  } else if (!emittedDelta && buffer.point !== pointBefore) {
    // A motion / point-only intent emits no text delta; reconcile the
    // originating client's window-state with a CURSOR message.
    client.port.postMessage({
      type: MSG.CURSOR,
      point: buffer.point,
      mark: buffer.mark,
      echoId: intent.id,
    });
  }

  // Always refresh the originating client's full cursor set: a command
  // (add-cursor-next, collapse via C-g) may have changed the secondary
  // carets without a text edit. Other clients' cursor sets are their own
  // and only their own intents change them, so this targets the originator.
  sendCursorsTo(client);

  // Refresh non-text state for every client. A text edit shifts the OTHER
  // clients' cursors (marker semantics under an insert), so they too need a
  // fresh VIEW, not only the originator.
  broadcastView();
  activeClient = null;
}

function handleMinibufferSubmit(value) {
  const prompt = spine.activePrompt;
  if (prompt === 'M-x ') {
    const chosen = bestCommandMatch(value);
    spine.abortMinibuffer();
    if (chosen) spine.runCommand(chosen);
    return;
  }
  if (prompt === 'Find file: ') {
    spine.abortMinibuffer();
    // Multi-buffer: visitFile ADDS a buffer and switches the ACTIVE client
    // onto it (other clients stay on their own buffers). Re-sync only the
    // active client onto the new buffer; the others are undisturbed.
    const newId = spine.visitFile(value);
    if (newId && activeClient) resyncClientToCurrentBuffer(activeClient);
    return;
  }
  if (prompt === 'Switch to buffer: ') {
    spine.abortMinibuffer();
    // Resolve the name (exact, then a substring prefix-match) and switch the
    // active client to it. Only that window changes buffer.
    const id = resolveBufferName(value);
    if (id && activeClient) {
      switchClientToBuffer(activeClient, id);
    } else if (activeClient) {
      // No match: surface a status so the user sees the miss.
      sendStatusTo(activeClient, `No buffer named "${value.trim()}"`);
    }
    return;
  }
  spine.deliverMinibuffer(value);
}

/** Resolve a buffer NAME the user typed at the C-x b prompt to a buffer id:
 *  an exact name match first, else the shortest buffer name containing the
 *  typed text (a lenient substring complete, like the command completer). */
function resolveBufferName(value) {
  const v = value.trim();
  if (v === '') return null;
  const exact = spine.bufferIdByName(v);
  if (exact) return exact;
  const matches = spine.bufferListRecords(activeClient ? activeClient.index : 0)
    .filter((r) => r.name.includes(v))
    .sort((a, b) => a.name.length - b.name.length);
  return matches.length ? matches[0].id : null;
}

/** Surface a one-off echo-area status on a client (no command involved). */
function sendStatusTo(client, status) {
  const vs = spine.viewStateOf(client.index);
  client.port.postMessage({ type: MSG.VIEW, view: { ...vs, status, seq } });
}

function bestCommandMatch(value) {
  const v = value.trim();
  if (v === '') return null;
  const names = spine.commandNames();
  if (names.includes(v)) return v;
  const sub = names.filter((n) => n.includes(v)).sort((a, b) => a.length - b.length);
  return sub[0] ?? null;
}

function onClientMessage(client, event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case MSG.HELLO:
      spine.setActiveClient(client.index);
      sendSnapshot(client);
      sendViewTo(client);
      // A late-joining client needs its current buffer's overlays + its own
      // cursor set (a window can attach while another already has highlights
      // or multi-cursor active on the same buffer).
      sendOverlaysTo(client);
      sendCursorsTo(client);
      break;
    case MSG.INTENT:
      applyIntent(client, msg.intent);
      break;
    default:
      break;
  }
}

// --- port wiring --------------------------------------------------------
//
// main posts one MessagePortMain per client window over parentPort. The
// first establishes client 0; each further message adds another client to
// the SAME shared buffer.

process.parentPort.on('message', (event) => {
  const [port] = event.ports;
  if (!port) return;
  registerClient(port);
  // Tell main we're ready after the first client attaches.
  if (clients.length === 1) {
    process.parentPort.postMessage({ type: 'server-ready' });
  }
});
