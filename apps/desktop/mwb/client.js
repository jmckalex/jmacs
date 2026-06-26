/**
 * @file Model-B Phase-0 spike — the client (renderer) logic.
 *
 * Holds a LOCAL STRING MIRROR of the server's authoritative buffer and
 * renders it with a trivial DOM painter (NOT the real view.js). On a
 * keystroke it:
 *   1. (local echo) applies the predicted edit to the mirror immediately
 *      and repaints — so typing never waits on the wire (plan §4 tactic 1);
 *   2. sends the intent up to the server over the MessagePort;
 *   3. when the server's authoritative delta returns, reconciles: if the
 *      delta matches what we predicted (the 99% self-insert path) the
 *      mirror is already correct and we only record the round-trip time;
 *      otherwise we re-sync.
 *
 * Instrumentation (the whole point):
 *   - localEcho[]  : keydown -> next animation frame (paint) latency.
 *   - roundTrip[]  : keydown -> matching server delta received latency.
 *   - baseline[]   : same as localEcho but with the server path OFF, i.e.
 *                    today's all-local model, for comparison.
 */

import {
  MSG,
  INTENT,
  applyDelta,
  predictSelfInsert,
  predictDeleteBackward,
} from './protocol.js';

// --- DOM --------------------------------------------------------------
const editorEl = document.getElementById('editor');
const statsEl = document.getElementById('stats');
const linkEl = document.getElementById('link');
const modeServerEl = document.getElementById('mode-server');
const echoEl = document.getElementById('echo');
const benchEl = document.getElementById('bench');
const resetEl = document.getElementById('reset-stats');

// --- client state -----------------------------------------------------
/** The replicated mirror of the server's buffer. */
let mirror = '';
/** The cursor offset in the mirror. */
let point = 0;
/** The last server sequence number we've applied. */
let lastSeq = 0;
/** Whether we have a live channel to the server. */
let connected = false;
/** @type {MessagePort | null} */
let port = null;

/** Pending intents we sent and are awaiting confirmation for, keyed by id,
 *  each carrying the keydown timestamp so we can time the round trip. */
const pending = new Map();
let nextIntentId = 1;

// --- latency samples --------------------------------------------------
const samples = { localEcho: [], roundTrip: [], baseline: [] };

function record(bucket, ms) {
  samples[bucket].push(ms);
  // Keep the last 500 so long sessions don't grow unbounded.
  if (samples[bucket].length > 500) samples[bucket].shift();
}

function pct(arr, p) {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}
function fmt(n) {
  return Number.isNaN(n) ? '   —  ' : n.toFixed(2).padStart(6);
}

function renderStats() {
  const line = (name, arr) =>
    `${name.padEnd(12)} n=${String(arr.length).padStart(4)}  ` +
    `mean=${fmt(mean(arr))}  p50=${fmt(pct(arr, 50))}  ` +
    `p95=${fmt(pct(arr, 95))}  p99=${fmt(pct(arr, 99))}  max=${fmt(Math.max(...arr, NaN))} ms`;
  statsEl.textContent =
    line('local-echo', samples.localEcho) +
    '\n' +
    line('round-trip', samples.roundTrip) +
    '\n' +
    line('baseline', samples.baseline) +
    '\n\n' +
    'local-echo = keydown→paint (Model B, optimistic).  ' +
    'round-trip = keydown→server delta (the decisive number).  ' +
    'baseline = keydown→paint with server OFF (today’s model).';
}

// --- the trivial painter ----------------------------------------------
//
// Renders the mirror as text with a visible cursor span at `point`. This
// is intentionally dumb — it is NOT the editor's renderer. Its cost is a
// lower bound on real rendering, so the latency numbers are optimistic on
// the render side and conservative on the protocol side (which is what we
// want to isolate: the PROTOCOL is what Model B adds).
function paint() {
  const before = document.createTextNode(mirror.slice(0, point));
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  const after = document.createTextNode(mirror.slice(point));
  editorEl.replaceChildren(before, cursor, after);
}

/** Apply a predicted/confirmed delta to the mirror + point, then paint. */
function applyLocal(delta) {
  mirror = applyDelta(mirror, delta);
  point = delta.point;
  paint();
}

// --- the hot path: a keystroke ----------------------------------------

/** Handle a self-insert of STR. Times local echo and (in server mode) the
 *  round trip. */
function selfInsert(str, t0) {
  const useServer = modeServerEl.checked && connected;
  const useEcho = echoEl.checked;

  if (!useServer) {
    // Baseline / today's model: mutate locally, no wire.
    const delta = predictSelfInsert(mirror, point, str);
    applyLocal(delta);
    requestAnimationFrame(() => record('baseline', performance.now() - t0));
    return;
  }

  if (useEcho) {
    // Local echo: predict + paint immediately, don't wait for the server.
    const delta = predictSelfInsert(mirror, point, str);
    applyLocal(delta);
    requestAnimationFrame(() => record('localEcho', performance.now() - t0));
  }

  // Send the intent up; time the round trip against the server's delta.
  const id = nextIntentId++;
  pending.set(id, { t0, kind: INTENT.SELF_INSERT, predictedEcho: useEcho });
  port.postMessage({
    type: MSG.INTENT,
    intent: { id, kind: INTENT.SELF_INSERT, text: str },
  });
}

function deleteBackward(t0) {
  const useServer = modeServerEl.checked && connected;
  const useEcho = echoEl.checked;

  if (!useServer) {
    const delta = predictDeleteBackward(mirror, point);
    if (delta) applyLocal(delta);
    requestAnimationFrame(() => record('baseline', performance.now() - t0));
    return;
  }
  if (useEcho) {
    const delta = predictDeleteBackward(mirror, point);
    if (delta) applyLocal(delta);
    requestAnimationFrame(() => record('localEcho', performance.now() - t0));
  }
  const id = nextIntentId++;
  pending.set(id, { t0, kind: INTENT.DELETE_BACKWARD, predictedEcho: useEcho });
  port.postMessage({
    type: MSG.INTENT,
    intent: { id, kind: INTENT.DELETE_BACKWARD },
  });
}

// --- reconciliation: a delta arrives from the server ------------------

function onDelta(delta) {
  // Match it to a pending intent by echoId; record the round trip.
  const p = delta.echoId != null ? pending.get(delta.echoId) : undefined;
  if (p) {
    record('roundTrip', performance.now() - p.t0);
    pending.delete(delta.echoId);
  }

  if (p && p.predictedEcho) {
    // We already optimistically applied this exact edit during local echo.
    // The server is authoritative; verify the prediction held. For the
    // self-insert path it always does, so this is just a seq bump. If it
    // ever diverged (a hook rewrote the text), we'd re-sync — but the
    // spike's server has no such hooks, so a mismatch would be a real bug.
    lastSeq = delta.seq;
    // (No repaint needed: mirror already reflects this edit.)
    return;
  }

  // No local echo for this one (echo off, or a server-originated change):
  // apply it now. Detect a sequence gap and request a resync if so.
  if (delta.seq !== lastSeq + 1 && lastSeq !== 0) {
    requestSnapshot();
    return;
  }
  lastSeq = delta.seq;
  applyLocal(delta);
  // When echo was off but we were in server mode, this paint IS the
  // visible update — its latency is the round trip already recorded above.
}

function onSnapshot(msg) {
  mirror = msg.text;
  point = msg.point;
  lastSeq = msg.seq;
  pending.clear();
  paint();
}

function requestSnapshot() {
  if (port) port.postMessage({ type: MSG.HELLO });
}

// --- input ------------------------------------------------------------

editorEl.addEventListener('keydown', (event) => {
  // Time from the hardware event. event.timeStamp is the same clock as
  // performance.now() (DOMHighResTimeStamp), so keydown→now is the true
  // input-to-handler+paint latency including any event-loop queueing.
  const t0 = event.timeStamp;

  if (event.key === 'Backspace') {
    event.preventDefault();
    deleteBackward(t0);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    selfInsert('\n', t0);
    return;
  }
  // A single printable character (ignore modifiers/chords for the spike).
  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    selfInsert(event.key, t0);
  }
});

// Repaint stats a few times a second (cheap; keeps the hot path clean).
setInterval(renderStats, 250);

// --- benchmark: fire N synthetic self-inserts back-to-back ------------
//
// A human can't type fast enough to fill the percentile buckets, so this
// drives 200 self-inserts on a microtask cadence and lets the normal
// path + instrumentation handle them. Each uses performance.now() as t0
// (no real keydown), which measures handler+wire+paint exactly as a real
// keystroke would minus the hardware-event queueing (a small, constant
// difference).
async function runBenchmark(n = 200) {
  benchEl.disabled = true;
  benchEl.textContent = 'running…';
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    selfInsert('x', t0);
    // Yield so the rAF paint + any server reply can interleave, the way
    // real keystrokes (spaced by ms) do. A double-rAF wait approximates a
    // ~16ms keystroke spacing and lets round-trip deltas land.
    // eslint-disable-next-line no-await-in-loop -- intentional pacing
    await new Promise((r) => requestAnimationFrame(() => r()));
  }
  // Give late round-trip deltas a moment to land before reading stats.
  await new Promise((r) => setTimeout(r, 200));
  benchEl.disabled = false;
  benchEl.textContent = 'Run 200-keystroke benchmark';
  // Dump a machine-readable summary to stderr for the architect's notes.
  const summary = {
    localEcho: summarize(samples.localEcho),
    roundTrip: summarize(samples.roundTrip),
    baseline: summarize(samples.baseline),
  };
  console.log('[mwb-bench]', JSON.stringify(summary));
}

/**
 * Auto-bench: run the Model-B benchmark (server on) AND a baseline pass
 * (server off, today's all-local model) back to back, so a headless
 * launch produces both numbers to stderr with no human in the loop. Used
 * by launch.js when MWB_AUTOBENCH is set; it quits the app on the
 * `[mwb-autobench-done]` line.
 */
async function runAutoBench() {
  // Reset, then a server-on pass.
  samples.localEcho.length = 0;
  samples.roundTrip.length = 0;
  samples.baseline.length = 0;
  modeServerEl.checked = true;
  echoEl.checked = true;
  await runBenchmark(200);
  const serverPass = {
    localEcho: summarize(samples.localEcho),
    roundTrip: summarize(samples.roundTrip),
  };
  // Now a baseline pass with the server OFF — the "today's app" model.
  samples.baseline.length = 0;
  modeServerEl.checked = false;
  await runBenchmark(200);
  const baselinePass = { baseline: summarize(samples.baseline) };
  console.log(
    '[mwb-autobench-done]',
    JSON.stringify({ ...serverPass, ...baselinePass })
  );
}
function summarize(arr) {
  return {
    n: arr.length,
    mean: +mean(arr).toFixed(3),
    p50: +pct(arr, 50)?.toFixed?.(3),
    p95: +pct(arr, 95)?.toFixed?.(3),
    p99: +pct(arr, 99)?.toFixed?.(3),
    max: arr.length ? +Math.max(...arr).toFixed(3) : null,
  };
}

benchEl.addEventListener('click', () => runBenchmark(200));
resetEl.addEventListener('click', () => {
  samples.localEcho.length = 0;
  samples.roundTrip.length = 0;
  samples.baseline.length = 0;
  renderStats();
});

// --- channel setup ----------------------------------------------------
//
// The preload re-dispatches the transferred MessagePort to us as a window
// message. Wire it up, then say HELLO to pull the initial snapshot.
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'mwb:port' && event.ports[0]) {
    port = event.ports[0];
    port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === MSG.DELTA) onDelta(msg.delta);
      else if (msg.type === MSG.SNAPSHOT) onSnapshot(msg);
    };
    port.start();
    connected = true;
    linkEl.textContent = 'connected to server ✓';
    linkEl.className = 'good';
    requestSnapshot();
    editorEl.focus();
    // Headless auto-bench (launch.js sets window.mwb.autobench from an env
    // flag). Give the snapshot a beat to land, then run both passes.
    if (window.mwb && window.mwb.autobench) {
      setTimeout(runAutoBench, 300);
    }
  }
});

paint();
renderStats();
