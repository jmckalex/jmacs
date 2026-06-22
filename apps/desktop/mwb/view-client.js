/**
 * @file Model-B command-spine slice — the REAL-VIEW client.
 *
 * Mounts the production renderer (`createEditorView`) and drives it from a
 * `ClientBuffer` MIRROR fed by server deltas — AND routes the full command
 * surface to the server. Every keystroke becomes an intent the server's
 * command spine dispatches (real keymap → real commands → buffer deltas +
 * a view-update). The client renders the result: the buffer via the mirror,
 * the cursor/modeline/status/minibuffer via VIEW messages.
 *
 * The split (plan §4, §5):
 *   - input capture + normalisation (→ key-string) is client-side;
 *   - local echo for self-insert is client-side (instant typing), the
 *     server confirms via a delta;
 *   - everything else (which command a key runs, motion, M-x, find-file,
 *     the minibuffer state machine) is server-side; the client just renders
 *     the view-state the server sends down.
 */

import { createEditorView } from '../../../packages/renderer/src/view.js';
import { createTreeSitterHighlighter } from '../../../packages/renderer/src/treesitter.js';
import { loadLanguageHighlighters } from '../../../packages/renderer/src/language-registry.js';
import { createHighlightOverrideStore } from '../../../packages/renderer/src/highlight-overrides.js';
import { keyEventToString } from '../../../packages/renderer/src/keymap.js';

import { MSG, INTENT } from './protocol.js';
import { createClientBuffer } from './client-buffer.js';

const editorEl = document.getElementById('editor');
const linkEl = document.getElementById('link');
const statusEl = document.getElementById('status');
const modelineEl = document.getElementById('modeline');
const mbPromptEl = document.getElementById('mb-prompt');
const mbInputEl = document.getElementById('mb-input');
const mbEchoEl = document.getElementById('mb-echo');
const mbHintEl = document.getElementById('mb-hint');

/** @type {MessagePort | null} */
let port = null;
/** @type {ReturnType<typeof createClientBuffer> | null} */
let mirror = null;
/** @type {ReturnType<typeof createEditorView> | null} */
let view = null;
let highlighters = {};
let foldCaptures = {};
let nextIntentId = 1;

/** Whether the minibuffer is currently prompting (input focused). */
let minibufferActive = false;

/** This client's index in the server (0 = the first/typer client). Set from
 *  the snapshot; used by the same-buffer self-test to pick typer vs observer. */
let clientIndex = 0;

/** Instrumentation: keydown→server-delta round-trip. */
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
// The view's `onKey` replaces its built-in keymap. We forward the
// normalised key string to the server, which runs the REAL keymap dispatch.
// A bare printable AND Enter/Backspace get LOCAL ECHO (the mirror predicts
// the edit immediately, instant typing) plus the intent UP; everything else
// (motion, chords, M-x) is a pure KEY intent the server resolves, with the
// result coming back as a delta / cursor / view message.

/** True when the key is a bare single character (a printable to insert). */
function isBarePrintable(keyString) {
  return [...keyString].length === 1;
}

function dispatchKey(keyString) {
  if (!mirror || !port) return false;
  if (isBarePrintable(keyString)) {
    // The 99% path: a bare printable self-inserts. Local echo (predict on
    // the mirror immediately) + a SELF_INSERT intent; the server confirms
    // via a delta. Typing never waits on the round-trip (plan §4 tactic 1).
    echoSelfInsert(keyString);
    return true;
  }
  // Every other key — Enter, Backspace, motion, chords, M-x, C-x C-f, … —
  // is a real command. We do NOT predict it (a command may do more than a
  // naive guess: `newline` auto-indents, `delete-backward` may unindent).
  // Send a pure KEY intent; the server's delta / cursor / view drives the
  // mirror. The round-trip is sub-ms (Phase 0), so this is imperceptible.
  sendKey(keyString);
  return true;
}

/** Local-echo a self-insert: predict on the mirror, send a SELF_INSERT
 *  intent (the 99% fast path the server applies without keymap work). */
function echoSelfInsert(str) {
  const t0 = performance.now();
  const id = nextIntentId++;
  pending.set(id, { t0, predicted: true });
  pendingIntentId = id;
  pendingIntentKind = INTENT.SELF_INSERT;
  mirror.insert(str); // predicts + emits via sendIntent
  pendingIntentId = null;
  requestAnimationFrame(() => record('localEcho', performance.now() - t0));
}

/** Send a pure KEY intent (no local echo — the server decides the effect). */
function sendKey(key) {
  const id = nextIntentId++;
  pending.set(id, { t0: performance.now(), predicted: false });
  port.postMessage({ type: MSG.INTENT, intent: { id, kind: INTENT.KEY, key } });
}

// The mirror's sendIntent stamps the current id + kind (set just before a
// mutator call) so the server's echoed delta matches the pending entry.
let pendingIntentId = null;
let pendingIntentKind = null;
function sendIntent(intent) {
  if (!port) return;
  const kind = pendingIntentKind ?? intent.kind;
  port.postMessage({
    type: MSG.INTENT,
    intent: { id: pendingIntentId ?? nextIntentId++, ...intent, kind },
  });
  pendingIntentKind = null;
}

// --- the minibuffer (client-rendered, server-driven) ------------------
//
// The server owns the prompt state; the client renders it + captures input.
// On a prompt the input is shown + focused; typing fires MINIBUFFER_CHANGE,
// Enter fires MINIBUFFER_SUBMIT, Escape/C-g fires MINIBUFFER_CANCEL.

function openMinibuffer(prompt, value) {
  minibufferActive = true;
  mbPromptEl.textContent = prompt;
  mbInputEl.classList.remove('hidden');
  mbInputEl.value = value ?? '';
  mbEchoEl.textContent = '';
  mbInputEl.focus();
}

function closeMinibuffer() {
  minibufferActive = false;
  mbPromptEl.textContent = '';
  mbInputEl.value = '';
  mbInputEl.classList.add('hidden');
  mbHintEl.textContent = '';
  if (view) view.focus();
}

mbInputEl.addEventListener('input', () => {
  if (!port) return;
  port.postMessage({
    type: MSG.INTENT,
    intent: { id: nextIntentId++, kind: INTENT.MINIBUFFER_CHANGE, value: mbInputEl.value },
  });
});

mbInputEl.addEventListener('keydown', (event) => {
  if (!port) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    port.postMessage({
      type: MSG.INTENT,
      intent: { id: nextIntentId++, kind: INTENT.MINIBUFFER_SUBMIT, value: mbInputEl.value },
    });
  } else if (event.key === 'Escape' || (event.ctrlKey && event.key === 'g')) {
    event.preventDefault();
    port.postMessage({
      type: MSG.INTENT,
      intent: { id: nextIntentId++, kind: INTENT.MINIBUFFER_CANCEL },
    });
  }
});

// --- server messages ---------------------------------------------------

function onSnapshot(msg) {
  if (typeof msg.clientIndex === 'number') clientIndex = msg.clientIndex;
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
    // Multi-cursor: the renderer paints a caret for every entry. The mirror
    // holds the full set synced from the server (the CURSORS message), so a
    // server-side add-cursor-next shows every secondary caret here.
    getCursors: () => mirror.cursors,
    // Overlays: the renderer draws each as a styled box behind the text.
    // The mirror's `decorations` are the synced overlays in the renderer's
    // { start, end, face } shape, so a server-side highlight-matches paints
    // here with zero view.js change (the existing getDecorations seam).
    getDecorations: () => mirror.decorations,
    getMajorModeName: () => null,
    onRenderError: (e) => console.error('[mwb-view] render error:', e),
  });
  view.focus();
  console.error(
    `[mwb-view] mounted real view on '${msg.name}' ` +
    `(${msg.text.length} chars, ${mirror.lineCount} lines)`
  );
  showStatus('(command spine: keys → server commands → deltas + view-updates)');
}

function onDelta(delta) {
  const p = delta.echoId != null ? pending.get(delta.echoId) : undefined;
  if (p) {
    record('roundTrip', performance.now() - p.t0);
    pending.delete(delta.echoId);
  }
  mirror.applyDelta(delta, { echoed: !!(p && p.predicted) });
}

function onCursor(msg) {
  if (!mirror) return;
  if (msg.echoId != null && pending.has(msg.echoId)) {
    record('roundTrip', performance.now() - pending.get(msg.echoId).t0);
    pending.delete(msg.echoId);
  }
  mirror.cursors[0].point = msg.point;
  mirror.cursors[0].mark = msg.mark ?? null;
  if (view) view.setView({ buffer: mirror });
}

/** A CURSORS message: this client's full cursor set (primary + every
 *  secondary). The renderer's getCursors() reads mirror.cursors, so
 *  adopting the set makes every secondary caret appear. We skip the adopt
 *  while a predicted self-insert is in flight (the local echo is
 *  authoritative for the primary point during rapid typing — the same
 *  guard onView uses); a single-cursor set from the server would otherwise
 *  rewind the optimistic primary. Multi-cursor edits come via RESYNC, which
 *  carries the cursor set itself, so this guard never drops a real update. */
function onCursors(cursors) {
  if (!mirror || !Array.isArray(cursors)) return;
  const predictionsInFlight = [...pending.values()].some((p) => p.predicted);
  if (predictionsInFlight && cursors.length <= 1) return;
  mirror.applyCursors(cursors);
  if (view) view.setView({ buffer: mirror });
}

/** An OVERLAYS message: the buffer's overlay set (shared across clients).
 *  The renderer draws them via getDecorations(); applyOverlays fires the
 *  mirror's onChange so the view repaints. A highlight created in another
 *  window arrives here and renders — the two-window overlay proof. */
function onOverlays(overlays) {
  if (!mirror) return;
  mirror.applyOverlays(overlays);
  if (view) view.setView({ buffer: mirror });
}

/** A RESYNC message: the canonical text + this client's cursor set, sent
 *  when a single delta can't replicate the edit (a multi-cursor edit). We
 *  clear any in-flight predictions (the resync is authoritative) and adopt
 *  the whole buffer + cursor set. */
function onResync(msg) {
  if (!mirror) return;
  // A resync supersedes any optimistic predictions still pending.
  for (const [id, p] of pending) {
    if (p.predicted) {
      record('roundTrip', performance.now() - p.t0);
      pending.delete(id);
    }
  }
  mirror.applyResync(msg);
  if (view) view.setView({ buffer: mirror });
}

/** A VIEW message: the non-text render state. Update the modeline, the echo
 *  area, and the minibuffer prompt; reconcile the cursor; handle scroll. */
function onView(v) {
  // A scroll-only VIEW (recenter etc.): execute the pixel scroll the server
  // asked for. The server decided the line; we do the pixels (plan §5d).
  if (v.scroll) {
    applyScroll(v.scroll);
    return;
  }
  if (typeof v.modeline === 'string') modelineEl.textContent = v.modeline;
  // Reconcile the cursor/mark (a command may have moved point) — but ONLY
  // when no predicted self-insert is still in flight. During rapid typing
  // the local echo is authoritative for point (the server confirms via the
  // delta's echoed point); a VIEW carrying an OLDER point must not rewind
  // the cursor, or the next predicted char inserts at the wrong offset and
  // the marker comes out scrambled (the "MWxyzB" bug). When the queue is
  // empty the VIEW point is the latest server truth and is safe to adopt.
  const predictionsInFlight = [...pending.values()].some((p) => p.predicted);
  if (mirror && typeof v.point === 'number' && !predictionsInFlight) {
    mirror.cursors[0].point = v.point;
    mirror.cursors[0].mark = v.mark ?? null;
    if (view) view.setView({ buffer: mirror });
  }
  // The minibuffer prompt state.
  if (v.minibuffer) {
    if (v.minibuffer.active && !minibufferActive) {
      openMinibuffer(v.minibuffer.prompt, v.minibuffer.value);
    } else if (!v.minibuffer.active && minibufferActive) {
      closeMinibuffer();
    }
  }
  // The echo area (status). When the minibuffer is prompting its input owns
  // the line; otherwise show the server's status.
  if (!minibufferActive && typeof v.status === 'string') {
    mbEchoEl.textContent = v.status;
  }
}

/** Execute a server scroll request in client pixels. recenter scrolls so
 *  the target line is centred; the client owns the measurement (plan §5d). */
function applyScroll(req) {
  if (!view) return;
  if (req.kind === 'recenter' && typeof view.recenter === 'function') {
    view.recenter();
  }
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
      else if (msg.type === MSG.VIEW) onView(msg.view);
      else if (msg.type === MSG.OVERLAYS) onOverlays(msg.overlays);
      else if (msg.type === MSG.CURSORS) onCursors(msg.cursors);
      else if (msg.type === MSG.RESYNC) onResync(msg);
    };
    port.start();
    linkEl.textContent = 'connected ✓';
    linkEl.className = 'good';
    loadHighlighters().then(() => {
      port.postMessage({ type: MSG.HELLO });
      if (window.mwb && window.mwb.selftest) {
        setTimeout(runSelfTest, 600);
      }
      if (window.mwb && window.mwb.sameBuffer) {
        setTimeout(runSameBufferTest, 800);
      }
      if (window.mwb && window.mwb.commandsSelftest) {
        setTimeout(runCommandsSelfTest, 700);
      }
      if (window.mwb && window.mwb.overlaySelftest) {
        setTimeout(runOverlaySelfTest, 700);
      }
    });
  }
});

// --- headless self-test (MWB_VIEW_SELFTEST=1) -------------------------
//
// Drives the command spine with no screen: types a marker (self-insert
// through the keymap), runs a motion command (M-> end-of-buffer), and
// exercises the minibuffer round-trip (goto-line via the prompt). Verifies
// the buffer changed, the server confirmed, the real view re-rendered, and
// the modeline updated. Logs a PASS/FAIL line launch.js reads.
async function runSelfTest() {
  try {
    if (!mirror || !view) {
      console.error('[mwb-view-selftest] FAIL: view not mounted');
      return finishSelfTest(false);
    }
    const startLen = mirror.text.length;
    const startLine0 = mirror.lineAt(0).text;
    let renders = 0;
    const off = mirror.onChange(() => { renders += 1; });

    // 1) Self-insert a marker at buffer start, each char through the keymap.
    sendKey('M-less'); // beginning-of-buffer (a real command, server-side)
    await frame();
    const marker = 'MWBxyz ';
    for (const ch of marker) {
      dispatchKey(ch);
      // eslint-disable-next-line no-await-in-loop -- pace like real typing
      await frame();
    }
    await sleep(300);

    const grew = mirror.text.length === startLen + marker.length;
    const line0Changed = mirror.lineAt(0).text.startsWith(marker);
    const serverConfirmed = samples.roundTrip.length >= 1;
    const reRendered = renders >= marker.length;

    // 2) A motion command moves point to buffer end (server-side, no text).
    const beforeEnd = mirror.point;
    sendKey('M-greater'); // end-of-buffer
    await sleep(150);
    const pointMovedByCommand = mirror.point > beforeEnd;

    // 3) The modeline reflects the server-rendered state.
    const modelineOk = modelineEl.textContent.includes(mirror.name);

    // 4) The minibuffer round-trip: run goto-line via M-x, supply "1".
    sendKey('M-less');
    await sleep(80);
    runCommandViaServer('goto-line');
    await sleep(150);
    const promptShown = minibufferActive && mbPromptEl.textContent === 'Goto line: ';
    if (promptShown) {
      mbInputEl.value = '2';
      submitMinibuffer();
      await sleep(180);
    }
    const minibufferWorks = promptShown && !minibufferActive;

    off();
    const ok =
      grew && line0Changed && serverConfirmed && reRendered &&
      pointMovedByCommand && modelineOk && minibufferWorks;

    console.error(
      `[mwb-view-selftest] grew=${grew} line0Changed=${line0Changed} ` +
      `serverConfirmed=${serverConfirmed}(${samples.roundTrip.length}) ` +
      `reRendered=${reRendered}(${renders}) ` +
      `pointMovedByCommand=${pointMovedByCommand} ` +
      `modeline='${modelineEl.textContent.slice(0, 40)}' ` +
      `minibufferWorks=${minibufferWorks} ` +
      `roundTrip(mean=${mean(samples.roundTrip).toFixed(2)}ms) ` +
      `line0After='${mirror.lineAt(0).text.slice(0, 24)}'`
    );
    finishSelfTest(ok);
  } catch (error) {
    console.error('[mwb-view-selftest] FAIL: threw', error && error.message);
    finishSelfTest(false);
  }
}

// --- richer-stdlib self-test (MWB_COMMANDS_SELFTEST=1) ----------------
//
// Proves the model-heavy server-side slice (PRIMITIVE-SPLIT.md) works
// end-to-end through the REAL server + protocol + view.js: kill-ring copy
// + yank, and a Markdown major-mode binding (C-c b) dispatching via the
// server's mode-keymap chain. Asserts the CLIENT MIRROR reflects each
// (the server mutated the canonical buffer; the delta re-rendered the
// real view). Run with MWB_FILE pointing at a .md file so markdown-mode
// is chosen server-side.
async function runCommandsSelfTest() {
  try {
    if (!mirror || !view) {
      console.error('[mwb-commands-selftest] FAIL: view not mounted');
      return finishCommandsTest(false);
    }

    // The modeline carries the server-chosen major mode; a .md file →
    // "Markdown". (renderModeline appends "  (Mode)" — see protocol.js.)
    const modelineMode = modelineEl.textContent;

    // 1) Type a known word at buffer start, select it, copy (M-w), then
    //    yank it (C-y) at end of buffer — the kill ring round-trip.
    sendKey('M-less');
    await frame();
    const word = 'YANKME';
    for (const ch of word) { dispatchKey(ch); await frame(); } // eslint-disable-line no-await-in-loop
    await sleep(200);
    // Select the word: mark at start, move right len times.
    sendKey('M-less');
    await sleep(60);
    sendKey('C-space');
    await sleep(40);
    for (let i = 0; i < word.length; i += 1) { sendKey('right'); await sleep(20); } // eslint-disable-line no-await-in-loop
    sendKey('M-w'); // copy-region
    await sleep(120);
    sendKey('M-greater'); // end of buffer
    await sleep(80);
    const beforeYank = mirror.text.length;
    sendKey('C-y'); // yank
    await sleep(200);
    const yankWorked =
      mirror.text.length === beforeYank + word.length &&
      mirror.text.endsWith(word);

    // 2) A Markdown mode binding: select the leading word again and bold
    //    it with C-c b (dispatches through the server's mode-keymap chain).
    sendKey('M-less');
    await sleep(60);
    sendKey('C-space');
    await sleep(40);
    for (let i = 0; i < word.length; i += 1) { sendKey('right'); await sleep(20); } // eslint-disable-line no-await-in-loop
    sendKey('C-c'); // markdown prefix (a mode-chord, server-side)
    await sleep(60);
    sendKey('b'); // markdown-bold
    await sleep(200);
    const boldWorked = mirror.text.startsWith(`*${word}*`);

    const modeOk = /Markdown/.test(modelineMode) || /Markdown/.test(modelineEl.textContent);
    const ok = yankWorked && boldWorked && modeOk;
    console.error(
      `[mwb-commands-selftest] modeOk=${modeOk} ` +
      `yankWorked=${yankWorked} boldWorked=${boldWorked} ` +
      `modeline='${modelineEl.textContent.slice(0, 36)}' ` +
      `line0='${mirror.lineAt(0).text.slice(0, 28)}'`
    );
    finishCommandsTest(ok);
  } catch (error) {
    console.error('[mwb-commands-selftest] FAIL: threw', error && error.message);
    finishCommandsTest(false);
  }
}

function finishCommandsTest(ok) {
  console.error(`[mwb-commands-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
}

// --- overlay + multi-cursor self-test (MWB_OVERLAY_SELFTEST=1) ---------
//
// Proves the overlay + multi-cursor sync end-to-end through the REAL
// server + protocol + view.js:
//   (a) a server-side select-all-matches (C-c D) syncs the full cursor SET
//       to this client's mirror, and highlight-matches (M-s h) syncs the
//       overlay SET; both reach mirror.cursors / mirror.decorations.
//   (b) the REAL view.js PAINTS them: a secondary caret per extra cursor
//       (.editor-cursor.is-secondary) and a decoration box per overlay
//       (.editor-decoration.tok-search-match).
//   (c) with MWB_CLIENTS=2 an overlay change PROPAGATES to the second
//       window: client 0 drives, client 1 (the observer) sees the overlays
//       appear on its OWN mirror + DOM, having highlighted nothing itself.
//
// A distinctive word with 3 occurrences is typed at buffer start so the
// test is deterministic regardless of the underlying file content. Run on
// the default file (view.js) or any buffer whose major mode does NOT bind
// the C-c prefix — in markdown-mode C-c is the Markdown chord, so C-c D
// would resolve there instead of the global multi-cursor map. The default
// MWB_FILE (a .js file, fundamental mode in the spine) leaves C-c as the
// global multi-cursor prefix and M-s as the search prefix, which is what
// this test drives. (Overlays + cursors are mode-independent once invoked;
// only the KEY BINDING used to invoke them depends on the mode.)
const OVERLAY_WORD = 'ztag';
const OVERLAY_LINE = `${OVERLAY_WORD} ${OVERLAY_WORD} ${OVERLAY_WORD} `; // 3 matches

/** Count painted secondary-cursor carets in the real view DOM. */
function paintedSecondaryCursors() {
  return editorEl.querySelectorAll('.editor-cursor.is-secondary').length;
}
/** Count painted search-match decoration boxes in the real view DOM. */
function paintedSearchDecorations() {
  return editorEl.querySelectorAll(
    '.editor-decoration.tok-search-match'
  ).length;
}

async function runOverlaySelfTest() {
  try {
    if (!mirror || !view) {
      // Only the run-ending client logs the done line (the observer in
      // 2-window mode, the sole client otherwise), so a non-mounted window
      // doesn't end the run early.
      const twoWindow = window.mwb && window.mwb.twoWindow === true;
      if ((twoWindow && clientIndex === 1) || !twoWindow) {
        console.error('[mwb-overlay-selftest-done] FAIL: view not mounted');
      }
      return;
    }

    // ----- the OBSERVER path (client 1, two-window mode) ----------------
    // It typed nothing and ran no command; it should SEE the overlays the
    // OTHER window created appear on its own mirror + get painted by its
    // own view.js. (Overlays are shared buffer state; multi-cursor is
    // per-client, so the observer does NOT get the driver's secondary
    // cursors — exactly the model-B per-window vs per-buffer split.)
    if (clientIndex === 1) {
      let mirrorOverlays = 0;
      let paintedDecos = 0;
      for (let i = 0; i < 80; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- polling for propagation
        await sleep(50);
        mirrorOverlays = mirror.decorations.length;
        paintedDecos = paintedSearchDecorations();
        if (mirrorOverlays >= 3 && paintedDecos >= 3) break;
      }
      const reachedMirror = mirrorOverlays >= 3;
      const painted = paintedDecos >= 3;
      // The observer must NOT have adopted the driver's secondary cursors
      // (those are per-client window state); its caret set stays primary-only.
      const noForeignCursors = mirror.cursors.length === 1;
      const ok = reachedMirror && painted && noForeignCursors;
      console.error(
        `[mwb-overlay-selftest] OBSERVER(client 1) ` +
        `overlaysReachedMirror=${reachedMirror}(${mirrorOverlays}) ` +
        `viewPainted=${painted}(${paintedDecos}) ` +
        `noForeignSecondaryCursors=${noForeignCursors}(${mirror.cursors.length})`
      );
      console.error(`[mwb-overlay-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
      return;
    }

    // ----- the DRIVER path (client 0; also the sole client in 1-window) -

    // 1) Type the repeated word at buffer start (3 occurrences of the word).
    sendKey('M-less'); // beginning-of-buffer
    await frame();
    for (const ch of OVERLAY_LINE) { dispatchKey(ch); await frame(); } // eslint-disable-line no-await-in-loop
    await sleep(250);
    const lineHasWord = mirror.lineAt(0).text.startsWith(OVERLAY_LINE);

    // 2) Multi-cursor: put point on the first occurrence, select all matches
    //    (C-c D → select-all-matches). The server builds a cursor at every
    //    match and syncs the full set to this client's mirror.
    sendKey('M-less'); // back to buffer start (on the first word)
    await sleep(80);
    sendKey('C-c'); // the global multi-cursor prefix (fundamental mode)
    await sleep(60);
    sendKey('D'); // select-all-matches
    await sleep(250);

    const mirrorCursorCount = mirror.cursors.length;
    const cursorsReachedMirror = mirrorCursorCount >= 3;
    // The renderer paints (count − 1) secondary carets for the extra cursors.
    const paintedSecondaries = paintedSecondaryCursors();
    const cursorsPainted = paintedSecondaries >= 2;

    // 3) Collapse the multi-cursor set (C-g → keyboard-quit) so the overlay
    //    phase starts from a single cursor (cleaner, and exercises collapse).
    sendKey('C-g');
    await sleep(150);
    const collapsed = mirror.cursors.length === 1;

    // 4) Overlays: highlight every occurrence of the word (M-s h →
    //    highlight-matches). The server creates a search overlay at each
    //    match (its endpoints are L2 markers) and broadcasts the set.
    sendKey('M-less'); // point on the first word again
    await sleep(80);
    sendKey('M-s'); // the search prefix
    await sleep(60);
    sendKey('h'); // highlight-matches
    await sleep(250);

    const mirrorOverlayCount = mirror.decorations.length;
    const overlaysReachedMirror = mirrorOverlayCount >= 3;
    // Every synced overlay is a { start, end, face: 'search-match' } decoration.
    const overlaysAreSearchMatch = mirror.decorations.every(
      (d) => d.face === 'search-match'
    );
    const paintedDecorations = paintedSearchDecorations();
    const overlaysPainted = paintedDecorations >= 3;

    // 5) Confirm overlays clear cleanly (M-s u → unhighlight-all), so the
    //    sync isn't a one-way write.
    sendKey('M-s');
    await sleep(60);
    sendKey('u'); // unhighlight-all
    await sleep(200);
    const overlaysCleared =
      mirror.decorations.length === 0 && paintedSearchDecorations() === 0;
    // Re-create them so a two-window observer (if any) has overlays to see,
    // and so the DOM ends in the highlighted state for an eyeballed run.
    sendKey('M-less');
    await sleep(60);
    sendKey('M-s');
    await sleep(60);
    sendKey('h');
    await sleep(250);

    const isTwoWindow = window.mwb && window.mwb.twoWindow === true;
    const ok =
      lineHasWord &&
      cursorsReachedMirror && cursorsPainted &&
      collapsed &&
      overlaysReachedMirror && overlaysAreSearchMatch && overlaysPainted &&
      overlaysCleared;

    console.error(
      `[mwb-overlay-selftest] DRIVER(client 0) ` +
      `lineHasWord=${lineHasWord} ` +
      `cursorsReachedMirror=${cursorsReachedMirror}(${mirrorCursorCount}) ` +
      `cursorsPainted=${cursorsPainted}(${paintedSecondaries} secondaries) ` +
      `collapsed=${collapsed} ` +
      `overlaysReachedMirror=${overlaysReachedMirror}(${mirrorOverlayCount}) ` +
      `overlaysAreSearchMatch=${overlaysAreSearchMatch} ` +
      `overlaysPainted=${overlaysPainted}(${paintedDecorations} boxes) ` +
      `overlaysCleared=${overlaysCleared}`
    );

    // In single-window mode the driver IS the run-ender. In two-window mode
    // the OBSERVER (client 1) ends the run after confirming propagation; the
    // driver only reports its own result (and must still PASS for the run to
    // be meaningful — its failure is logged, the observer would then FAIL too
    // since no overlays propagated).
    if (!isTwoWindow) {
      console.error(`[mwb-overlay-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
    } else if (!ok) {
      console.error('[mwb-overlay-selftest] DRIVER produced no overlays — observer will FAIL');
    }
  } catch (error) {
    console.error('[mwb-overlay-selftest] threw', error && error.message);
    // End the run on a throw so the harness doesn't hang.
    if (clientIndex === 1 || !(window.mwb && window.mwb.twoWindow === true)) {
      console.error('[mwb-overlay-selftest-done] FAIL: threw');
    }
  }
}

/** Drive an M-x command through the server (open M-x, type, submit). The
 *  self-test uses runCommand directly via a KEY shortcut: send M-x, fill
 *  the prompt, submit. */
function runCommandViaServer(name) {
  // Open M-x, then feed the name into the (now-open) minibuffer + submit.
  // For the self-test we shortcut: send a KEY for M-x to open the prompt,
  // then set the input + submit.
  sendKey('M-x');
  // Give the server a beat to open the prompt, then fill + submit.
  setTimeout(() => {
    if (minibufferActive) {
      mbInputEl.value = name;
      submitMinibuffer();
    }
  }, 60);
}

function submitMinibuffer() {
  if (!port) return;
  port.postMessage({
    type: MSG.INTENT,
    intent: { id: nextIntentId++, kind: INTENT.MINIBUFFER_SUBMIT, value: mbInputEl.value },
  });
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finishSelfTest(ok) {
  console.error(`[mwb-view-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
}

// --- same-buffer (two-client) self-test (MWB_SAME_BUFFER=1) -----------
//
// The Model-B payoff: one buffer in two windows. Client 0 (the typer) moves
// to buffer start and types a distinctive marker. Client 1 (the observer)
// watches its OWN mirror — it never typed, but should SEE the marker appear
// because the server fanned client 0's deltas to it. The observer logs the
// PASS/FAIL line that ends the headless run.
const SAME_BUFFER_MARKER = 'SHARED99 ';

async function runSameBufferTest() {
  try {
    if (!mirror || !view) {
      if (clientIndex === 1) console.error('[mwb-same-buffer-done] FAIL: not mounted');
      return;
    }
    if (clientIndex === 0) {
      // The typer. Move to buffer start and type the marker, paced.
      sendKey('M-less');
      await frame();
      for (const ch of SAME_BUFFER_MARKER) {
        dispatchKey(ch);
        // eslint-disable-next-line no-await-in-loop -- pace like real typing
        await frame();
      }
      console.error('[mwb-same-buffer] client 0 typed the marker');
      return;
    }
    // The observer (client 1). Poll its own mirror for the marker the OTHER
    // window typed; it should arrive as fanned-out deltas.
    const startText = mirror.text;
    let sawIt = false;
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- polling loop
      await sleep(50);
      if (mirror.text.startsWith(SAME_BUFFER_MARKER)) { sawIt = true; break; }
    }
    const changedFromShared = sawIt && startText !== mirror.text;
    console.error(
      `[mwb-same-buffer] observer(client 1) sawMarker=${sawIt} ` +
      `changed=${changedFromShared} ` +
      `line0='${mirror.lineAt(0).text.slice(0, 24)}'`
    );
    console.error(`[mwb-same-buffer-done] ${sawIt ? 'PASS' : 'FAIL'}`);
  } catch (error) {
    if (clientIndex === 1) {
      console.error('[mwb-same-buffer-done] FAIL: threw', error && error.message);
    }
  }
}
