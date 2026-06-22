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

// --- delta fan-out -----------------------------------------------------
//
// A text change fans out to EVERY client (shared buffer). The buffer can be
// swapped by find-file, so we re-subscribe on a swap.

let subscribedBuffer = null;
let unsubscribe = null;

function subscribeToBuffer() {
  const buf = spine.buffer;
  if (buf === subscribedBuffer) return;
  if (typeof unsubscribe === 'function') unsubscribe();
  subscribedBuffer = buf;
  unsubscribe = buf.onChange((event) => {
    if (event.change === null) return; // cursor-only move: no text delta
    seq += 1;
    const delta = {
      start: event.change.start,
      removed: event.change.removed,
      inserted: event.change.inserted,
      point: event.point,
      seq,
    };
    // Fan the text delta to every client. Only the originating client gets
    // the echoId (so it reconciles its optimistic edit); the others apply
    // the delta fresh to their mirror (they didn't predict it).
    for (const c of clients) {
      const echoId = c === activeClient ? currentEchoId : undefined;
      c.port.postMessage({ type: MSG.DELTA, delta: { ...delta, echoId } });
    }
  });
}
subscribeToBuffer();

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

/** Send one client a full snapshot (initial sync / a buffer swap). */
function sendSnapshot(client) {
  spine.setActiveClient(client.index);
  client.port.postMessage({
    type: MSG.SNAPSHOT,
    text: spine.buffer.text,
    point: spine.viewStateOf(client.index).point,
    name: spine.buffer.name,
    clientIndex: client.index, // so a client knows whether it's the typer
    seq,
  });
}

// --- intent handling ----------------------------------------------------

function applyIntent(client, intent) {
  activeClient = client;
  spine.setActiveClient(client.index); // this client's cursor is now active
  currentEchoId = intent.id;
  const buffer = spine.buffer;
  const pointBefore = buffer.point;
  const wasSeq = seq;
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
      default:
        break;
    }
  } catch (error) {
    console.error(`[mwb-server] intent error: ${error.message}`);
  } finally {
    currentEchoId = undefined;
  }

  const emittedDelta = seq !== wasSeq;
  // A motion / point-only intent emits no text delta; reconcile the
  // originating client's window-state with a CURSOR message.
  if (!emittedDelta && buffer.point !== pointBefore) {
    client.port.postMessage({
      type: MSG.CURSOR,
      point: buffer.point,
      mark: buffer.mark,
      echoId: intent.id,
    });
  }
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
    const ok = spine.visitFile(value);
    if (ok) {
      subscribeToBuffer();
      // Re-snapshot every client onto the new shared buffer.
      for (const c of clients) {
        spine.setActiveClient(c.index);
        sendSnapshot(c);
        sendViewTo(c);
      }
    }
    return;
  }
  spine.deliverMinibuffer(value);
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
