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

import { createInterpreter, NIL } from '@editor/lisp';
import { createBuffer } from '@editor/buffer';

import { MSG, INTENT } from './protocol.js';

// --- the authoritative model -------------------------------------------

// One buffer, seeded with a little text so the client has something to
// render and a cursor that isn't at 0.
const buffer = createBuffer('Type here. The server owns this buffer.\n', {
  name: 'mwb-scratch',
});
buffer.moveBufferEnd();

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
      (else #f)))
`);

// --- intent handling ----------------------------------------------------

/** Apply one client intent. Each intent runs through the real
 *  interpreter / buffer; the resulting L1 change fans out as a delta via
 *  the buffer.onChange subscription above. */
function applyIntent(intent) {
  currentEchoId = intent.id;
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
}

/** Send the client a full snapshot (initial sync / resync). */
function sendSnapshot() {
  if (clientPort === null) return;
  clientPort.postMessage({
    type: MSG.SNAPSHOT,
    text: buffer.text,
    point: buffer.point,
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
