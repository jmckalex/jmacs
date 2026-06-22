/**
 * @file Model-B command-spine SERVER, run in an Electron `utilityProcess`
 * (a Node child; plan §3 (i)). Authoritative for the interpreter + buffer
 * model + the whole command surface; the client keeps a replicated mirror
 * and renders locally (plan §4).
 *
 * This is the command-spine slice (architect-notes.md 2026-06-22). The
 * Phase-0 spike measured latency; the render slice proved view.js renders
 * from a mirror with zero changes. This server now runs the REAL command
 * machinery — see spine.js — so a single window is a genuinely usable
 * editor *through the server*: self-insert, motion, editing, M-x, find-file
 * and the minibuffer all dispatch server-side and render client-side.
 *
 * The two wire streams (plan §4):
 *   - up   (client → server): key/edit + minibuffer INTENTS, never edits.
 *   - down (server → client): buffer DELTAs (the L1 change shape), plus
 *     VIEW messages for the non-text render state (cursor, modeline,
 *     status, minibuffer) and SNAPSHOTs on a buffer swap.
 *
 * Lifecycle: main forks this module, then transfers one end of a
 * MessageChannelMain over `process.parentPort`. We serve one client on it
 * (Phase 0 = one client; multi-client is a later phase).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MSG, INTENT, MINIBUFFER_IDLE } from './protocol.js';
import { createSpine } from './spine.js';

// --- the canonical model: a real file in the command spine -------------
//
// The server loads a REAL file so the client renders real source with real
// tree-sitter highlighting + folding off its mirror. MWB_FILE (an absolute
// path) overrides; the default is view.js — a large, real, heavily-
// highlighted JavaScript file. The server is a Node child, so file I/O is
// direct (plan §3 (i)).

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

/** @type {import('electron').MessagePortMain | null} */
let clientPort = null;

// A monotonic delta sequence number, so the client can order deltas and
// detect gaps (plan §4 — correctness of replication).
let seq = 0;

// The id of the intent currently being applied, so the delta / view-update
// we emit can echo it back for the client to match against its optimistic
// edit / reconcile its round-trip timing.
let currentEchoId;

/** Read a file off disk for find-file (the openFile spine effect). A Node
 *  child does this directly. Resolves relative paths against the loaded
 *  file's directory, like a real editor's default-directory. */
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
//
// All the editor's behaviour lives here now: the real buffer, the real
// commands, the real keymap, the minibuffer state machine. The spine's
// outward effects (status, minibuffer open/close, scroll) become wire
// messages to the client.

const spine = createSpine(
  { initialText, name: bufferName },
  {
    onStatus: () => sendView(),
    onMinibufferOpen: (prompt) => sendMinibuffer(prompt),
    onMinibufferClose: () => sendMinibuffer(null),
    onScroll: (req) => sendScroll(req),
    openFile: readFileForVisit,
  }
);

// --- delta fan-out -----------------------------------------------------
//
// The buffer's onChange hands us the raw L1 change ({start,removed,inserted})
// plus the resulting point — that IS the delta (plan §4). The buffer can be
// swapped by find-file, so we (re)subscribe whenever the current buffer
// changes; subscribeToBuffer tracks which buffer we're on.

let subscribedBuffer = null;
let unsubscribe = null;

function subscribeToBuffer() {
  const buf = spine.buffer;
  if (buf === subscribedBuffer) return;
  if (typeof unsubscribe === 'function') unsubscribe();
  subscribedBuffer = buf;
  unsubscribe = buf.onChange((event) => {
    if (event.change === null) return; // cursor-only move: no text delta
    if (clientPort === null) return;
    seq += 1;
    clientPort.postMessage({
      type: MSG.DELTA,
      delta: {
        start: event.change.start,
        removed: event.change.removed,
        inserted: event.change.inserted,
        point: event.point,
        seq,
        echoId: currentEchoId,
      },
    });
  });
}
subscribeToBuffer();

// --- down-channel senders ---------------------------------------------

/** The current minibuffer state to ship in a VIEW message. */
let minibufferState = MINIBUFFER_IDLE;

/** Send a VIEW message carrying the current non-text render state. */
function sendView() {
  if (clientPort === null) return;
  const vs = spine.viewState();
  clientPort.postMessage({
    type: MSG.VIEW,
    view: { ...vs, minibuffer: minibufferState, seq },
  });
}

/** Update the minibuffer state + push a VIEW. `prompt` null closes it. */
function sendMinibuffer(prompt) {
  minibufferState =
    prompt === null
      ? MINIBUFFER_IDLE
      : { active: true, prompt, value: '' };
  sendView();
}

/** A scroll/centering request the client must execute in pixels (plan
 *  §5d). The server decided the target line; the client does the scroll. */
function sendScroll(req) {
  if (clientPort === null) return;
  clientPort.postMessage({ type: MSG.VIEW, view: { scroll: req } });
}

/** Send the client a full snapshot (initial sync / a buffer swap). */
function sendSnapshot() {
  if (clientPort === null) return;
  clientPort.postMessage({
    type: MSG.SNAPSHOT,
    text: spine.buffer.text,
    point: spine.buffer.point,
    name: spine.buffer.name, // the client picks the tree-sitter language
    seq,
  });
}

// --- intent handling ----------------------------------------------------

/**
 * Apply one client intent. Edits route through the spine's keymap dispatch
 * / commands; the resulting L1 change fans out as a delta via the onChange
 * subscription, and a VIEW message carries the non-text state.
 */
function applyIntent(intent) {
  currentEchoId = intent.id;
  const pointBefore = spine.buffer.point;
  const wasSeq = seq;
  try {
    switch (intent.kind) {
      case INTENT.SELF_INSERT:
        // Local-echo fast path: the client already predicted this; route it
        // through self-insert so the canonical buffer agrees + the delta
        // confirms. (handleKey would also work, but this skips keymap
        // resolution for the 99% path — plan §4 latency tactic 3.)
        spine.buffer.insert(String(intent.text ?? ''));
        break;
      case INTENT.DELETE_BACKWARD:
        spine.handleKey('backspace');
        break;
      case INTENT.KEY:
        spine.handleKey(String(intent.key ?? ''));
        break;
      case INTENT.POINT:
        // Point is per-client window-state; the client moved its cursor and
        // tells us so a server-side command lands at the right place.
        spine.buffer.moveTo(Number(intent.point) || 0);
        break;
      case INTENT.MINIBUFFER_SUBMIT:
        handleMinibufferSubmit(String(intent.value ?? ''));
        break;
      case INTENT.MINIBUFFER_CANCEL:
        spine.deliverMinibuffer(null);
        break;
      case INTENT.MINIBUFFER_CHANGE:
        // The client owns the live value; the server tracks it for
        // completion hints, but does not need to round-trip on each char.
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
  // A motion / point-only intent emits no text delta. Reconcile the
  // client's window-state with a CURSOR message (cheap) AND a VIEW (so the
  // modeline position updates). A text edit already carried point in the
  // delta, but its non-text state (modeline position, modified flag) still
  // needs a VIEW.
  if (!emittedDelta && spine.buffer.point !== pointBefore && clientPort !== null) {
    clientPort.postMessage({
      type: MSG.CURSOR,
      point: spine.buffer.point,
      mark: spine.buffer.mark,
      echoId: intent.id,
    });
  }
  // Always refresh the non-text render state after an intent (modeline,
  // status, mark). Cheap; one small message per keystroke.
  sendView();
}

/**
 * Resolve a minibuffer submit. The M-x / find-file prompts are special: the
 * host completes the value (M-x against the real command registry; find-file
 * against the filesystem) and acts itself, aborting the placeholder command.
 * Every other prompt is an ordinary interactive argument — resume the
 * suspended command with the value.
 */
function handleMinibufferSubmit(value) {
  const prompt = spine.activePrompt;
  if (prompt === 'M-x ') {
    // Complete against the real registry: the chosen command is the first
    // fuzzy/prefix match, mirroring the renderer's startCommandPalette.
    const chosen = bestCommandMatch(value);
    spine.abortMinibuffer();
    if (chosen) spine.runCommand(chosen);
    else spine.handleKey(''); // no-op; status stays
    return;
  }
  if (prompt === 'Find file: ') {
    spine.abortMinibuffer();
    const ok = spine.visitFile(value);
    if (ok) {
      subscribeToBuffer();
      sendSnapshot();
      sendView();
    }
    return;
  }
  // Ordinary interactive argument: resume the command.
  spine.deliverMinibuffer(value);
}

/** The best command match for an M-x value: an exact name, else the first
 *  name that contains the typed text (substring), else null. */
function bestCommandMatch(value) {
  const v = value.trim();
  if (v === '') return null;
  const names = spine.commandNames();
  if (names.includes(v)) return v;
  const sub = names.filter((n) => n.includes(v)).sort((a, b) => a.length - b.length);
  return sub[0] ?? null;
}

function onClientMessage(event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case MSG.HELLO:
      sendSnapshot();
      sendView();
      break;
    case MSG.INTENT:
      applyIntent(msg.intent);
      break;
    default:
      break;
  }
}

// --- port wiring --------------------------------------------------------

process.parentPort.on('message', (event) => {
  const [port] = event.ports;
  if (!port) return;
  clientPort = port;
  port.on('message', onClientMessage);
  port.start();
  process.parentPort.postMessage({ type: 'server-ready' });
});
