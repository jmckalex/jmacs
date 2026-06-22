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

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { MSG, INTENT, MINIBUFFER_IDLE } from './protocol.js';
import { createSpine } from './spine.js';
// The crash-safe atomic writer (temp file + fsync + rename) and the
// recovery-snapshot pure helpers are standalone production modules; the
// server is a Node child, so it does file I/O DIRECTLY (no IPC), reusing
// these without touching production app.js/main.js/view.js.
import { atomicWriteSync } from './atomic-write-sync.js';
import { createAutosave } from './autosave.js';

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

/** Resolve a user-typed find-file/write-file path to an absolute path,
 *  relative to the server's seed-file directory (its working "cwd"). */
function resolvePath(path) {
  return resolve(dirname(filePath), path);
}

/** Read a file off disk for find-file (the openFile spine effect). Returns
 *  the text, name, AND the resolved absolute path (so the buffer knows where
 *  C-x C-s writes back). */
function readFileForVisit(path) {
  try {
    const abs = resolvePath(path);
    return { text: readFileSync(abs, 'utf8'), name: basename(abs), path: abs };
  } catch (error) {
    console.error(`[mwb-server] find-file: ${error.message}`);
    return null;
  }
}

/** Write a buffer to disk ATOMICALLY (temp file + fsync + rename), the
 *  saveFile spine effect for save-buffer / write-file. The path is resolved
 *  relative to the seed-file dir (an absolute path passes through). Returns
 *  `{ ok }` or `{ ok:false, error }` — never throws (the spine reports the
 *  failure; an uncaught throw here would risk the server). */
function writeFileForSave({ path, text }) {
  try {
    const abs = resolvePath(String(path ?? ''));
    atomicWriteSync(abs, String(text ?? ''));
    console.error(`[mwb-server] wrote ${abs} (${String(text ?? '').length} bytes)`);
    return { ok: true, path: abs };
  } catch (error) {
    console.error(`[mwb-server] save failed: ${error.message}`);
    return { ok: false, error: error.message };
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
    // save-buffer / write-file: atomic disk write (temp + fsync + rename).
    saveFile: writeFileForSave,
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
  // The buffer this client is on BEFORE the intent. If the intent switches
  // its buffer (find-file, switch-to-buffer via the minibuffer), the
  // switch handler fully re-syncs the client onto the new buffer, so the
  // stale-`buffer`-based reconciliation below must be skipped.
  const bufferIdBefore = spine.currentBufferIdOf(client.index);
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

  // A buffer switch during the intent (find-file / switch-to-buffer through
  // the minibuffer) already re-synced this client onto its NEW buffer; the
  // `buffer`/`pointBefore` captured above refer to the OLD buffer, so skip
  // the reconciliation below (it would message stale state). Still refresh
  // the other clients' view-state.
  const switchedBuffer = spine.currentBufferIdOf(client.index) !== bufferIdBefore;
  const emittedDelta = seq !== wasSeq;
  const multiAfter = spine.activeCursorCount() > 1;
  // Always read-and-clear the history flag so a no-op undo (bottom of the
  // stack) doesn't leak it into the next intent. A change-group undo emits
  // several L1 edits but only ONE L2 change event, so the single forwarded
  // delta desyncs the mirror — treat undo/redo like a multi-cursor edit and
  // RESYNC the canonical text instead.
  const wasHistoryOp = spine.consumeHistoryOp();
  const needsResync =
    !switchedBuffer && emittedDelta && (multiBefore || multiAfter || wasHistoryOp);

  if (switchedBuffer) {
    // The switch handler re-synced the originating client; just refresh the
    // others' view-state (their cursors/modeline are unaffected, but a fresh
    // VIEW is cheap and keeps everyone consistent).
    for (const c of clients) {
      if (c !== client) sendViewTo(c);
    }
    activeClient = null;
    return;
  }

  if (needsResync) {
    // The single forwarded delta is unreliable for a multi-cursor edit or an
    // undo/redo (a change-group undo emits one L2 delta for several edits);
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
  if (prompt === 'Write file: ') {
    spine.abortMinibuffer();
    // write-file / save-as: write the active buffer to the typed path
    // (atomic), rebind its path, and clear the dirty flag. Refresh the
    // modeline so the ● indicator drops on every window on that buffer.
    spine.writeActiveBufferTo(value);
    broadcastView();
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

// --- server-side autosave + crash recovery ----------------------------
//
// The buffers' unsaved state lives in THIS process's memory (the registry),
// shared by every window. A server crash must not lose it — so we snapshot
// every DIRTY buffer to a recovery directory on disk on a timer, and scan
// that directory on startup for snapshots worth recovering (data-safety for
// the shared model; plan §7.1). Mirrors the real app's autosave / *Recover*.
//
// The recovery dir is MWB_RECOVERY_DIR, else a stable per-app temp dir. The
// self-test points it at a /tmp scratch dir so it can assert a snapshot hit
// disk without touching the repo or the user's data.
const RECOVERY_DIR = process.env.MWB_RECOVERY_DIR
  || join(tmpdir(), 'godot-mw-b-recovery');

const autosave = createAutosave({
  dir: RECOVERY_DIR,
  getDirty: () => spine.dirtyBufferSnapshots(),
  intervalMs: Number(process.env.MWB_AUTOSAVE_INTERVAL_MS) || 4000,
  log: (msg) => console.error(msg),
});

// Recover-on-startup: scan for snapshots whose on-disk file is older than the
// snapshot (unsaved edits were lost) or that have no on-disk file (path-less /
// deleted). For the prototype we LOG the recoverable set + load each as a
// recovered buffer in the registry (the survivable floor — a server respawn
// surfaces the unsaved work as buffers). The full *Recover* picker UX (a
// render-side view + per-snapshot recover/discard) is deferred; the data is
// here and the wire to render it is the same buffer-list slice. Never throws.
function recoverOnStartup() {
  let recoverable;
  try {
    recoverable = autosave.scanRecoverable();
  } catch (error) {
    console.error(`[mwb-server] recovery scan failed: ${error.message}`);
    return;
  }
  if (!recoverable || recoverable.length === 0) return;
  console.error(`[mwb-server] crash recovery: ${recoverable.length} snapshot(s) to recover:`);
  for (const r of recoverable) {
    console.error(`  - ${r.name || r.key} (saved ${new Date(r.savedAt).toISOString()})`);
    try {
      // The on-disk content (if the file still exists) is the recovered
      // buffer's baseline, so its dirty diff is exactly the lost edits.
      let diskBaseline;
      if (r.path) {
        try {
          diskBaseline = readFileSync(r.path, 'utf8');
        } catch {
          diskBaseline = undefined; // file gone — leave it conservatively dirty.
        }
      }
      // Load the recovered text as a buffer (path bound if it had one) so the
      // unsaved work is reachable. It is DIRTY relative to disk by
      // construction (that's why it was recovered), so its ● flag shows.
      spine.recoverBuffer({ name: r.name, filePath: r.path, text: r.text, diskBaseline });
    } catch (error) {
      console.error(`[mwb-server] could not load recovered buffer: ${error.message}`);
    }
  }
}

recoverOnStartup();
autosave.start();

// --- headless save + data-safety self-test (MWB_SAVE_SELFTEST=1) -------
//
// Proves the WHOLE save story server-side, with direct fs access (the only
// place that can read the bytes back): find-file a /tmp scratch file, edit it,
// assert it is dirty (the ● modeline indicator), save it through the REAL
// save-buffer command, READ THE FILE BACK and assert the edited bytes hit
// disk, assert the buffer is clean again; then edit once more, force an
// autosave pass, and assert a recovery snapshot landed on disk. Posts a
// PASS/FAIL result to main (launch.js exits on it). Writes only to /tmp; the
// repo and user data are never touched. Wrapped so a failure can never crash
// the server (the guardrail).
function runSaveSelfTest() {
  const target = process.env.MWB_SAVE_TARGET;
  const checks = {};
  let detail = '';
  try {
    if (!target) throw new Error('MWB_SAVE_TARGET not set');
    // Seed the scratch file on disk so find-file can open it.
    writeFileSync(target, 'seed line\n', 'utf8');

    // 1) find-file the scratch file → it becomes the active buffer with a path.
    const id = spine.visitFile(target);
    checks.opened = !!id && spine.activeFilePath === target;

    // 2) Edit it (self-insert) → dirty + the ● modeline indicator.
    const MARK = 'EDITED ';
    spine.handleKey('M-greater'); // end of buffer
    for (const ch of MARK) spine.handleKey(ch);
    checks.dirty = spine.activeModified === true;
    checks.bullet = spine.viewState().modeline.startsWith('●');
    const expectedText = spine.buffer.text;

    // 3) Save through the REAL command → atomic write to disk.
    spine.handleKey('C-x');
    spine.handleKey('C-s');

    // 4) READ THE FILE BACK: the edited bytes must be on disk.
    const onDisk = readFileSync(target, 'utf8');
    checks.bytesOnDisk = onDisk === expectedText && onDisk.includes(MARK);
    detail += `disk=${JSON.stringify(onDisk.slice(0, 40))} `;

    // 5) The buffer is clean again (baseline re-set; ● gone).
    checks.cleanAfterSave = spine.activeModified === false;
    checks.bulletGone = spine.viewState().modeline.startsWith('–');

    // 6) Autosave: edit again (dirty), force a snapshot pass, assert a
    //    recovery snapshot exists on disk for this file.
    for (const ch of 'MORE ') spine.handleKey(ch);
    checks.dirtyAgain = spine.activeModified === true;
    const written = autosave.snapshotOnce();
    checks.snapshotWritten = written >= 1;
    const recoverable = autosave.scanRecoverable();
    // The snapshot is NEWER than the on-disk file (we just saved, then edited
    // + snapshotted), so it is offered, and its text holds the unsaved edit.
    checks.snapshotRecoverable =
      recoverable.some((r) => r.path === target && r.text.includes('MORE'));
    detail += `recoverable=${recoverable.length}`;
  } catch (error) {
    detail += `threw=${error && error.message}`;
  }

  const ok = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
  console.error(
    `[mwb-save-selftest] ${Object.entries(checks).map(([k, v]) => `${k}=${v}`).join(' ')} ${detail}`
  );
  console.error(`[mwb-save-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
  try {
    process.parentPort.postMessage({ type: 'save-selftest-done', ok });
  } catch {
    // No parent (e.g. a bare node run): the stderr line is the result.
  }
}

if (process.env.MWB_SAVE_SELFTEST === '1') {
  // Run after a beat so the interpreter + stdlib are fully loaded.
  setTimeout(runSaveSelfTest, 300);
}

// --- headless undo/redo self-test (MWB_UNDO_SELFTEST=1) ----------------
//
// Drives undo/redo through the REAL spine + commands (editing.lisp's
// undo/redo), asserting: an edit goes dirty (●), undo reverts the text AND
// restores point AND (back at the saved baseline) clears the dirty flag; redo
// reapplies + re-sets dirty; C-x u also undoes; the server flags an undo/redo
// for the cross-window resync (consumeHistoryOp). PASS/FAIL on stderr +
// parentPort; launch.js exits on it. Never crashes the main process (wrapped).
function runUndoSelfTest() {
  const checks = {};
  let detail = '';
  try {
    spine.setActiveClient(0);
    const baseline = spine.buffer.text;
    // Edit → dirty (●).
    spine.handleKey('M-greater'); // end of buffer
    for (const ch of 'XY') spine.handleKey(ch);
    checks.edited = spine.buffer.text === `${baseline}XY`;
    checks.dirty = spine.activeModified === true
      && spine.viewState().modeline.startsWith('●');
    const pointAfterEdit = spine.buffer.point;

    // C-/ undo → text reverts one step + point restored to the changed region.
    spine.handleKey('C-slash');
    checks.undoText = spine.buffer.text === `${baseline}X`;
    checks.undoPoint = spine.buffer.point === pointAfterEdit - 1;
    checks.undoFlagged = spine.consumeHistoryOp() === true;

    // Undo again → back to the saved baseline → CLEAN (● clears).
    spine.handleKey('C-slash');
    checks.undoToBaseline = spine.buffer.text === baseline;
    checks.cleanAtBaseline = spine.activeModified === false
      && spine.viewState().modeline.startsWith('–');

    // Redo (C-S-/) → reapplies + dirty again.
    spine.handleKey('C-S-slash');
    checks.redoText = spine.buffer.text === `${baseline}X`;
    checks.dirtyAfterRedo = spine.activeModified === true;
    checks.redoFlagged = spine.consumeHistoryOp() === true;

    // C-x u also undoes.
    spine.handleKey('C-x');
    spine.handleKey('u');
    checks.cxuUndoes = spine.buffer.text === baseline;

    detail = `text=${JSON.stringify(spine.buffer.text)}`;
  } catch (error) {
    detail += `threw=${error && error.message}`;
  }
  const ok = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
  console.error(
    `[mwb-undo-selftest] ${Object.entries(checks).map(([k, v]) => `${k}=${v}`).join(' ')} ${detail}`
  );
  console.error(`[mwb-undo-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
  try {
    process.parentPort.postMessage({ type: 'undo-selftest-done', ok });
  } catch {
    // No parent (a bare node run): the stderr line is the result.
  }
}

if (process.env.MWB_UNDO_SELFTEST === '1') {
  setTimeout(runUndoSelfTest, 300);
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
