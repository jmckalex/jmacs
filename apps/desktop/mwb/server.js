/**
 * @file Model-B Phase-0 spike — the SERVER, run in an Electron
 * `utilityProcess` (a Node child; plan §3 option (i), the recommended
 * home). It is authoritative for the interpreter + the buffer model;
 * clients keep a replicated mirror and render locally (plan §4).
 *
 * THIS IS SPIKE CODE. It exercises the REAL machinery — the real
 * `createInterpreter` from @editor/lisp and the real Layer-2 buffer from
 * @editor/buffer — to make the latency measurement honest: a keystroke
 * really does cross a process boundary, run through the real
 * interpreter, mutate the real buffer, and come back as an L1 change.
 *
 * Lifecycle (plan §8 "Boot/lifecycle"): main forks this module, then
 * transfers one end of a MessageChannelMain over `process.parentPort`.
 * We wait for that port, then serve one client on it. (Phase 0 = one
 * client; multi-client is Phase 2.)
 */

import { readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, NIL } from '@editor/lisp';
import { createBuffer } from '@editor/buffer';

import { MSG, INTENT } from './protocol.js';

// --- the authoritative model -------------------------------------------
//
// The server holds ONE canonical L2 buffer. In the render-from-mirror
// slice it loads a REAL FILE so the client renders real source with real
// tree-sitter highlighting + folding off its mirror. The file is chosen
// by MWB_FILE (an absolute path) or defaults to view.js — a large, real,
// heavily-highlighted JavaScript file, exactly the stress the render path
// should face. A utilityProcess is a Node child, so the server reads the
// file directly off disk (plan §3 (i): file I/O becomes direct server-side).

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

const buffer = createBuffer(initialText, { name: bufferName });
buffer.moveBufferStart();

// A monotonic delta sequence number, so the client can order deltas and
// detect gaps (plan §4 — correctness of replication).
let seq = 0;

// The id of the intent currently being applied, so the delta we emit
// can echo it back for the client to match against its optimistic edit.
let currentEchoId = undefined;

/** @type {import('electron').MessagePortMain | null} */
let clientPort = null;

/** Forward a buffer change to the client as a wire delta. The L2 buffer's
 *  onChange hands us the raw L1 change ({start,removed,inserted}) plus the
 *  resulting point — that IS the delta (plan §4). */
buffer.onChange((event) => {
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

// --- the interpreter ----------------------------------------------------
//
// The real interpreter, with a tiny primitive surface that drives the
// real buffer. In the full model the WHOLE defcommand/keymap surface
// moves here; for the latency spike we install just enough that a
// keystroke can route through Lisp and mutate the buffer — which is the
// path whose latency we're measuring.

const interpreter = createInterpreter({
  write: () => {}, // discard print output in the spike
  primitives: {
    // (self-insert! STR) — insert a printable string at point.
    'self-insert!': (args) => {
      buffer.insert(String(args[0] ?? ''));
      return NIL;
    },
    // (delete-backward!) — backspace.
    'delete-backward!': () => {
      buffer.deleteBackward(1);
      return NIL;
    },
    // (move-point! OFFSET) — set the canonical cursor (window-state sync).
    // Point is per-client window-state; the server tracks it so a
    // self-insert lands where the client's cursor is.
    'move-point!': (args) => {
      buffer.moveTo(Number(args[0]) || 0);
      return NIL;
    },
    // Named character/line motions (left/right/up/down), so a real arrow
    // key routes through the interpreter and the buffer, server-side.
    'move-left!': () => { buffer.moveLeft(); return NIL; },
    'move-right!': () => { buffer.moveRight(); return NIL; },
    'move-up!': () => { buffer.moveUp(); return NIL; },
    'move-down!': () => { buffer.moveDown(); return NIL; },
    'buffer-text': () => buffer.text,
    'buffer-point': () => buffer.point,
  },
});

// A minimal keymap in Lisp, so a named-key intent really does dispatch
// through the interpreter (the realistic per-keystroke server cost path).
interpreter.evaluate(`
  (define (handle-key key)
    (cond
      ((equal? key "backspace") (delete-backward!) #t)
      ((equal? key "left") (move-left!) #t)
      ((equal? key "right") (move-right!) #t)
      ((equal? key "up") (move-up!) #t)
      ((equal? key "down") (move-down!) #t)
      (else #f)))
`);

// --- intent handling ----------------------------------------------------

/** Apply one client intent. Each intent runs through the real
 *  interpreter / buffer; the resulting L1 change fans out as a delta via
 *  the buffer.onChange subscription above. A point/motion intent moves the
 *  canonical cursor (no text delta) and the server replies with a CURSOR
 *  message so the client's window-state can reconcile. */
function applyIntent(intent) {
  currentEchoId = intent.id;
  const pointBefore = buffer.point;
  let emittedDelta = false;
  // Track whether this intent produced a text change, so we know whether
  // to send a CURSOR follow-up (point-only) instead.
  const wasSeq = seq;
  try {
    switch (intent.kind) {
      case INTENT.SELF_INSERT:
        // Route through the interpreter — the realistic path: a keystroke
        // crosses into Lisp, which mutates the buffer.
        interpreter.call('self-insert!', String(intent.text ?? ''));
        break;
      case INTENT.DELETE_BACKWARD:
        interpreter.call('handle-key', 'backspace');
        break;
      case INTENT.POINT:
        // Point is per-client window-state; the server tracks it so a
        // self-insert lands at the client's cursor. No text delta.
        interpreter.call('move-point!', Number(intent.point) || 0);
        break;
      case INTENT.KEY:
        interpreter.call('handle-key', String(intent.key ?? ''));
        break;
      default:
        // Unknown intent — ignore in the spike.
        break;
    }
  } finally {
    currentEchoId = undefined;
  }
  emittedDelta = seq !== wasSeq;
  // If the intent moved the cursor but produced no text delta (a motion or
  // a point set), tell the client the authoritative point so it reconciles
  // its window-state. Self-insert/backspace already carry point in the delta.
  if (!emittedDelta && buffer.point !== pointBefore && clientPort !== null) {
    clientPort.postMessage({
      type: MSG.CURSOR,
      point: buffer.point,
      mark: buffer.mark,
      echoId: intent.id,
    });
  }
}

/** Send the client a full snapshot (initial sync / resync). */
function sendSnapshot() {
  if (clientPort === null) return;
  clientPort.postMessage({
    type: MSG.SNAPSHOT,
    text: buffer.text,
    point: buffer.point,
    name: buffer.name, // the client picks the tree-sitter language from this
    seq,
  });
}

function onClientMessage(event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case MSG.HELLO:
      sendSnapshot();
      break;
    case MSG.INTENT:
      applyIntent(msg.intent);
      break;
    default:
      break;
  }
}

// --- port wiring --------------------------------------------------------
//
// main forks us and posts the client's MessagePortMain over parentPort.
// We attach our message handler and start the port.

process.parentPort.on('message', (event) => {
  const [port] = event.ports;
  if (!port) return;
  clientPort = port;
  port.on('message', onClientMessage);
  port.start();
  // Tell main we're ready (lifecycle: a client launching against a
  // not-ready server is a real risk — plan §8).
  process.parentPort.postMessage({ type: 'server-ready' });
});
