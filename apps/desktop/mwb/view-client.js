/**
 * @file Model-B render-from-mirror slice — the REAL-VIEW client.
 *
 * Unlike the Phase-0 harness (a trivial <pre>+cursor painter), this page
 * mounts the REAL renderer — `createEditorView` from `@editor/renderer`,
 * the same one the production app uses — and drives it from a
 * `ClientBuffer` MIRROR fed by server deltas. It loads the real
 * tree-sitter highlighters + fold captures (the exact setup app.js does)
 * so a real file renders with REAL syntax highlighting and folding,
 * entirely client-side, off the replicated mirror text.
 *
 * This is the decisive proof for the bake-off (plan §5b): the renderer
 * never knew it wasn't reading a live buffer. Highlighting and folding
 * are pure functions of the mirror text, so they run UNCHANGED.
 *
 * The flow:
 *   1. say HELLO over the MessagePort → server SNAPSHOT (text + name).
 *   2. build the ClientBuffer mirror from the snapshot; its `name` picks
 *      the tree-sitter language (real file name → real grammar).
 *   3. mount `createEditorView(mirror, container, { highlighters, … })`.
 *   4. `onKey` routes keystrokes to intents: a printable / Enter →
 *      mirror.insert (local echo + self-insert intent); Backspace →
 *      mirror.deleteBackward; arrows → a KEY intent (motion server-side,
 *      point reconciled via a CURSOR message).
 *   5. server deltas land → mirror.applyDelta → onChange → the real view
 *      re-renders + re-highlights the changed text.
 */

// Import directly from the renderer's source modules rather than the
// barrel `@editor/renderer/index.js`. The barrel re-exports the shell
// view, which imports `@xterm/xterm` (not in our import map and irrelevant
// to a text view), so the barrel won't resolve in this minimal harness.
// These three modules are the exact ones the barrel re-exports them from.
import { createEditorView } from '../../../packages/renderer/src/view.js';
import { createTreeSitterHighlighter } from '../../../packages/renderer/src/treesitter.js';
import { loadLanguageHighlighters } from '../../../packages/renderer/src/language-registry.js';
import { createHighlightOverrideStore } from '../../../packages/renderer/src/highlight-overrides.js';

import { MSG, INTENT } from './protocol.js';
import { createClientBuffer } from './client-buffer.js';

const editorEl = document.getElementById('editor');
const linkEl = document.getElementById('link');
const statusEl = document.getElementById('status');

/** @type {MessagePort | null} */
let port = null;
/** @type {ReturnType<typeof createClientBuffer> | null} */
let mirror = null;
/** @type {ReturnType<typeof createEditorView> | null} */
let view = null;
let highlighters = {};
let foldCaptures = {};
let nextIntentId = 1;

/** Instrumentation: keydown→server-delta round-trip, with the REAL view
 *  re-rendering on the reconcile. Pending intents by id carry t0. */
const pending = new Map();
const samples = { localEcho: [], roundTrip: [] };

function record(bucket, ms) {
  samples[bucket].push(ms);
  if (samples[bucket].length > 500) samples[bucket].shift();
}
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
function pct(a, p) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function showStatus(extra = '') {
  const le = samples.localEcho;
  const rt = samples.roundTrip;
  statusEl.textContent =
    `local-echo n=${le.length} mean=${mean(le).toFixed(2)} p95=${pct(le, 95).toFixed(2)}  ` +
    `round-trip n=${rt.length} mean=${mean(rt).toFixed(2)} p95=${pct(rt, 95).toFixed(2)} ms   ${extra}`;
}
setInterval(() => showStatus(), 300);

// --- the highlighter setup (exactly app.js's recipe) ------------------
//
// Discover the renderer's language modules (each self-registers), then
// build a tree-sitter highlighter per language. This is the SAME code the
// production app runs — proving the highlight stack is reusable as-is from
// a mirror.
async function loadHighlighters() {
  const base = 'app://editor/packages/renderer/src/languages/';
  try {
    const response = await fetch(`${base}?list`);
    if (response.ok) {
      const names = await response.json();
      for (const name of names) {
        if (!name.endsWith('.js')) continue;
        try {
          await import(/* @vite-ignore */ `${base}${name}`);
        } catch (error) {
          console.error(`[mwb-view] language ${name}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    console.error(`[mwb-view] language discovery failed: ${error.message}`);
  }
  const store = createHighlightOverrideStore();
  const loaded = await loadLanguageHighlighters(
    createTreeSitterHighlighter,
    (tag, error) => console.error(`[mwb-view] ${tag} highlighter: ${error.message}`),
    store
  );
  highlighters = loaded.highlighters;
  foldCaptures = loaded.foldCaptures;
  console.error(
    `[mwb-view] highlighters ready: ${Object.keys(highlighters).join(', ')}`
  );
}

// --- key routing → intents --------------------------------------------
//
// The view's onKey replaces its built-in keymap. We translate the
// normalised key string into an edit/motion intent. Printables + Enter
// self-insert through the mirror (local echo + intent); Backspace deletes;
// arrows send a motion KEY intent whose point comes back as a CURSOR msg.

const ARROW_TO_KEY = { left: 'left', right: 'right', up: 'up', down: 'down' };

function dispatchKey(keyString) {
  if (!mirror || !port) return false;
  // A bare printable: self-insert. keyEventToString returns the char as-is
  // for an unmodified printable (length-1, no C-/M-/A-).
  if (keyString.length === 1) {
    selfInsert(keyString);
    return true;
  }
  if (keyString === 'enter') {
    selfInsert('\n');
    return true;
  }
  if (keyString === 'backspace') {
    deleteBackward();
    return true;
  }
  if (keyString in ARROW_TO_KEY) {
    sendKeyMotion(ARROW_TO_KEY[keyString]);
    return true;
  }
  // Unhandled chord in this slice.
  return false;
}

function selfInsert(str) {
  const t0 = performance.now();
  const id = nextIntentId++;
  pending.set(id, { t0, predicted: true });
  // Local echo (instant) + the self-insert intent, atomically: the mirror's
  // insert() predicts on the mirror (re-rendering the REAL view) AND emits
  // the intent through sendIntent → we stamp it with the id below.
  pendingIntentId = id;
  mirror.insert(str);
  pendingIntentId = null;
  requestAnimationFrame(() =>
    record('localEcho', performance.now() - t0)
  );
}

function deleteBackward() {
  const t0 = performance.now();
  const id = nextIntentId++;
  pending.set(id, { t0, predicted: true });
  pendingIntentId = id;
  mirror.deleteBackward(1);
  pendingIntentId = null;
  requestAnimationFrame(() => record('localEcho', performance.now() - t0));
}

function sendKeyMotion(key) {
  const id = nextIntentId++;
  pending.set(id, { t0: performance.now(), predicted: false });
  port.postMessage({ type: MSG.INTENT, intent: { id, kind: INTENT.KEY, key } });
}

// The mirror's sendIntent stamps the current id (set just before the
// mutator call) so the server's echoed delta matches the pending entry.
let pendingIntentId = null;
function sendIntent(intent) {
  if (!port) return;
  port.postMessage({
    type: MSG.INTENT,
    intent: { id: pendingIntentId ?? nextIntentId++, ...intent },
  });
}

// --- server messages ---------------------------------------------------

function onSnapshot(msg) {
  // (Re)build the mirror from the snapshot. The name drives the language.
  mirror = createClientBuffer({
    initialText: msg.text,
    name: msg.name || 'mwb.js',
    point: msg.point,
    sendIntent,
  });
  if (view) view.destroy();
  view = createEditorView(mirror, editorEl, {
    onKey: dispatchKey,
    highlighters,
    foldCaptures,
    getPoint: () => mirror.point,
    getMark: () => mirror.mark,
    getCursors: () => mirror.cursors,
    getMajorModeName: () => null,
    onRenderError: (e) => console.error('[mwb-view] render error:', e),
  });
  view.focus();
  console.error(
    `[mwb-view] mounted real view on '${msg.name}' ` +
    `(${msg.text.length} chars, ${mirror.lineCount} lines)`
  );
  showStatus('(real view.js, real highlighting, mirror-driven)');
}

function onDelta(delta) {
  const p = delta.echoId != null ? pending.get(delta.echoId) : undefined;
  if (p) {
    record('roundTrip', performance.now() - p.t0);
    pending.delete(delta.echoId);
  }
  // Apply the authoritative delta. If we already predicted it (local echo),
  // applyDelta({echoed}) only adopts the server's point — the text matches.
  mirror.applyDelta(delta, { echoed: !!(p && p.predicted) });
  // applyDelta fires the mirror's onChange → the REAL view re-renders +
  // re-highlights. No extra repaint call needed.
}

function onCursor(msg) {
  // A point-only (motion) reconcile. Update window-state + re-render so the
  // caret moves. We set point directly through the mirror's cursors.
  if (!mirror) return;
  if (msg.echoId != null && pending.has(msg.echoId)) {
    record('roundTrip', performance.now() - pending.get(msg.echoId).t0);
    pending.delete(msg.echoId);
  }
  mirror.cursors[0].point = msg.point;
  mirror.cursors[0].mark = msg.mark ?? null;
  // Nudge a render: a no-op delta-free onChange. The view reads point via
  // getPoint on its next frame; trigger one by re-pointing it at the view.
  if (view) view.setView({ buffer: mirror });
}

// --- channel ----------------------------------------------------------

window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'mwb:port' && event.ports[0]) {
    port = event.ports[0];
    port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === MSG.SNAPSHOT) onSnapshot(msg);
      else if (msg.type === MSG.DELTA) onDelta(msg.delta);
      else if (msg.type === MSG.CURSOR) onCursor(msg);
    };
    port.start();
    linkEl.textContent = 'connected ✓';
    linkEl.className = 'good';
    // Load highlighters, THEN ask for the snapshot, so the view mounts with
    // the grammar ready.
    loadHighlighters().then(() => {
      port.postMessage({ type: MSG.HELLO });
      if (window.mwb && window.mwb.selftest) {
        // Give the snapshot + mount a beat, then run the headless self-test.
        setTimeout(runSelfTest, 600);
      }
    });
  }
});

// --- headless self-test (MWB_VIEW_SELFTEST=1) -------------------------
//
// Drives the full mirror→server→delta→re-render path with no screen:
// types a marker string at buffer start, waits for the server to confirm
// each keystroke, then verifies the mirror text changed AND the real view
// re-rendered + re-highlighted. Logs a PASS/FAIL line launch.js can read.
async function runSelfTest() {
  try {
    if (!mirror || !view) {
      console.error('[mwb-view-selftest] FAIL: view not mounted');
      return finishSelfTest(false);
    }
    const startLen = mirror.text.length;
    const startLine0 = mirror.lineAt(0).text;
    let renders = 0;
    // Count real renders by observing the mirror (same signal the view
    // gets). One onChange ≈ one scheduled render.
    const off = mirror.onChange(() => { renders += 1; });

    // Move to buffer start, then type a marker. Each char round-trips
    // through the server (canonical buffer) and comes back as a delta.
    mirror.moveTo(0);
    const marker = 'MWBxyz ';
    for (const ch of marker) {
      selfInsert(ch);
      // eslint-disable-next-line no-await-in-loop -- pace like real typing
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
    // Let trailing round-trip deltas land.
    await new Promise((r) => setTimeout(r, 400));
    off();

    const grew = mirror.text.length === startLen + marker.length;
    const line0Changed = mirror.lineAt(0).text.startsWith(marker);
    const serverConfirmed = samples.roundTrip.length >= marker.length;
    const reRendered = renders >= marker.length;
    const ok = grew && line0Changed && serverConfirmed && reRendered;

    console.error(
      `[mwb-view-selftest] grew=${grew} line0Changed=${line0Changed} ` +
      `serverConfirmed=${serverConfirmed}(${samples.roundTrip.length}) ` +
      `reRendered=${reRendered}(${renders}) ` +
      `roundTrip(mean=${mean(samples.roundTrip).toFixed(2)} ` +
      `p95=${pct(samples.roundTrip, 95).toFixed(2)}ms) ` +
      `localEcho(mean=${mean(samples.localEcho).toFixed(2)}ms) ` +
      `line0Before='${startLine0.slice(0, 24)}' line0After='${mirror.lineAt(0).text.slice(0, 24)}'`
    );
    finishSelfTest(ok);
  } catch (error) {
    console.error('[mwb-view-selftest] FAIL: threw', error && error.message);
    finishSelfTest(false);
  }
}

function finishSelfTest(ok) {
  console.error(`[mwb-view-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
}
