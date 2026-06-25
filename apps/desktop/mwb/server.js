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

import { readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

import {
  MSG, INTENT, MINIBUFFER_IDLE, PANE_INTENT, normalisePickerRequest,
} from './protocol.js';
import { resolveUserPath } from './path-resolve.js';
import { mediaKindForName } from './media-kinds.js';
import { completePath } from './path-complete.js';
import { createSpine } from './spine.js';
import { createSessionStore, flatToWindowSession } from './session-store.js';
// The crash-safe atomic writer (temp file + fsync + rename) and the
// recovery-snapshot pure helpers are standalone production modules; the
// server is a Node child, so it does file I/O DIRECTLY (no IPC), reusing
// these without touching production app.js/main.js/view.js.
import { atomicWriteSync } from './atomic-write-sync.js';
import { createAutosave } from './autosave.js';
// Per-file companion-metadata helpers (the `.godot-metadata` sidecar path
// scheme + emptiness rule), shared verbatim with files.js's metadata:read /
// metadata:write IPC — so a sidecar written server-side is byte-identical to
// one the in-renderer app writes. Bookmarks (+ sticky notes) persist through it.
import {
  metadataPath, legacyMetadataPath, isEmptyMetadata, METADATA_VERSION,
} from '../src/metadata.js';

// --- the canonical model: a real file in the command spine -------------

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(
  here, '..', '..', '..', 'packages', 'renderer', 'src', 'view.js'
);
const filePath = process.env.MWB_FILE || DEFAULT_FILE;

// Where the server persists its OWN sessions. Defined here, before the spine, so
// the store below (and the seed via sessionBootInfo) can read it; the
// persistence functions further down share this const.
const SESSION_STORE = process.env.MWB_SESSION_STORE
  || join(tmpdir(), 'godot-mw-b-session.json');

// The named-session store (v3): the user's labelled sessions + the always-on
// `__last__` auto-snapshot, each holding the full multi-window pane structure.
// load() migrates an existing FLAT { files, active } file into `__last__`, so a
// returning user's session carries over unchanged. On a brand-new install (no
// store file AND no named sessions), seed `__last__` once from the renderer's
// session.json (MWB_SESSION_SEED) — preserving the flag-off → server hand-off.
const sessionStore = createSessionStore({
  read: () => readFileSync(SESSION_STORE, 'utf8'),
  write: (text) => atomicWriteSync(SESSION_STORE, text),
});
if (!sessionStore.get('__last__') && sessionStore.list().sessions.length === 0) {
  const seed = readSessionSeed();
  const win = seed ? flatToWindowSession(seed) : null;
  if (win) sessionStore.writeLast(win);
}

// The spine's seed buffer. When a saved session exists (sessionBootInfo reads
// the store's `__last__` snapshot), boot on its focused-leaf ACTIVE file so
// there is NO stray demo tab; the rest of the layout is rebuilt at the first
// HELLO (restoreSession, which reuses the already-open seed buffer). Otherwise
// fall back to DEFAULT_FILE (view.js).
let initialText;
let bufferName;
let initialPath = null;
if (hasRestorableWorkspaces()) {
  // A workspace CHOOSER is shown on the first HELLO (there's something to
  // restore). Until the user picks — or starts fresh — the window is just a
  // blank *scratch* backdrop; don't pre-load the last session, since they may
  // choose a different workspace (or none).
  initialText = '';
  bufferName = '*scratch*';
} else {
  const bootSession = sessionBootInfo();
  if (bootSession && bootSession.active) {
    // The active file is the natural seed — UNLESS it is MEDIA (image/video/
    // audio/pdf), which must NOT be read as UTF-8 (the garbled-PNG bug). The seed
    // is fundamentally TEXT, so the active file seeds it only when it is a
    // readable text file — not media and not a DIRECTORY (EISDIR). When the
    // active is media/a directory, seed from the first text file instead;
    // restoreSession then opens the active as its DATA-SOURCE (via visitFile).
    const isTextSeed = (p) => !mediaKindForName(p) && !isDirectoryPath(p);
    const seedCandidates = isTextSeed(bootSession.active)
      ? [bootSession.active]
      : (bootSession.files || []).filter(isTextSeed);
    for (const p of seedCandidates) {
      try {
        initialText = readFileSync(p, 'utf8');
        bufferName = basename(p);
        initialPath = p;
        break;
      } catch { /* try the next candidate */ }
    }
  }
  if (initialText === undefined) {
    try {
      initialText = readFileSync(filePath, 'utf8');
      bufferName = basename(filePath);
      initialPath = filePath;
    } catch (error) {
      console.error(`[mwb-server] could not read ${filePath}: ${error.message}`);
      initialText = '; could not load file — type here.\n';
      bufferName = 'mwb-scratch.lisp';
      initialPath = null;
    }
  }
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

/** Resolve a user-typed find-file/write-file path to an absolute path: a
 *  leading `~`/`~/…` expands to the home directory, an absolute path passes
 *  through, and a relative path resolves against the seed-file directory (its
 *  working "cwd"). See path-resolve.js. */
function resolvePath(path) {
  return resolveUserPath(path, dirname(filePath), homedir());
}

/** Read a file off disk for find-file (the openFile spine effect). A MEDIA file
 *  (image/audio/video/pdf, by suffix) is NOT read as bytes here — the server
 *  only resolves its path + kind into a data-source descriptor; the client loads
 *  the bytes via the main process's `openFilePath`. A text file returns its
 *  UTF-8 text + name + resolved absolute path (so the buffer knows where C-x C-s
 *  writes back). Returns `{ media:true, kind, name, path }` or `{ text, name,
 *  path }`, or null on a read error. */
function readFileForVisit(path) {
  try {
    const abs = resolvePath(path);
    // A DIRECTORY routes to a directory-view DATA-SOURCE (directory-tree by
    // default — the explicit `directory-columns` command overrides the kind via
    // visitDirectory). The client mounts the matching element-view, which lists
    // the directory itself; the server only records the path + kind.
    if (isDirectoryPath(abs)) {
      return { directory: true, kind: 'directory-tree', name: basename(abs), path: abs };
    }
    const kind = mediaKindForName(abs);
    if (kind) return { media: true, kind, name: basename(abs), path: abs };
    return { text: readFileSync(abs, 'utf8'), name: basename(abs), path: abs };
  } catch (error) {
    console.error(`[mwb-server] find-file: ${error.message}`);
    return null;
  }
}

/** Whether PATH names a directory on disk. Tolerant — a stat failure (no such
 *  path, permission) is treated as "not a directory" so callers fall through. */
function isDirectoryPath(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether PATH names an existing file on disk (tolerant). */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Album-art filenames a jukebox directory may carry (case-insensitive),
 *  mirroring jukebox-view's ART_FILENAMES. */
const JUKEBOX_ART = [
  'cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp',
  'folder.jpg', 'folder.png', 'album.jpg', 'album.png',
];

/** Scan DIRPATH for a jukebox listing: its audio files (by suffix, sorted) and
 *  an album-art filename. Returns `{ dir, tracks, art, name }` (what the jukebox
 *  data-source holds), or null when the path isn't a readable directory. The
 *  client resolves dir+track / dir+art to media:// URLs for playback + art. */
function scanJukeboxDir(dirPath) {
  try {
    const abs = resolvePath(dirPath);
    if (!isDirectoryPath(abs)) return null;
    const entries = readdirSync(abs);
    const tracks = entries.filter((n) => mediaKindForName(n) === 'audio').sort();
    const art = entries.find((n) => JUKEBOX_ART.includes(n.toLowerCase())) ?? null;
    return { dir: abs, tracks, art, name: `*Jukebox: ${abs}*` };
  } catch {
    return null;
  }
}

/** Find a bibliography DECLARATION in document TEXT: a markdown/jmarkdown
 *  `Bibliography: path` metadata header (first ~60 lines), or a LaTeX
 *  `\addbibresource{…}` / `\bibliography{…}` (the first entry, `.bib` appended).
 *  Returns the declared (possibly relative) path, or null. Mirrors the renderer
 *  bib-search detection so server mode finds the same bib. */
function detectBibDeclaration(text) {
  if (typeof text !== 'string' || text === '') return null;
  const lines = text.split('\n');
  const cap = Math.min(lines.length, 60);
  for (let i = 0; i < cap; i += 1) {
    const m = /^\s*bibliography:\s*(.+?)\s*$/i.exec(lines[i]);
    if (m && m[1]) return m[1];
  }
  const add = /\\addbibresource\s*\{([^}]+)\}/.exec(text);
  if (add && add[1]) return add[1].trim();
  const bib = /\\bibliography\s*\{([^}]+)\}/.exec(text);
  if (bib && bib[1]) {
    const first = bib[1].split(',')[0].trim();
    if (first) return /\.bib$/i.test(first) ? first : `${first}.bib`;
  }
  return null;
}

/** The active document's bibliography ABSOLUTE path for CLIENT INDEX, or null —
 *  the server is authoritative for the active doc (it owns the buffer text +
 *  file path), so it resolves the bibliography the renderer's inert session
 *  can't. Detects a bib declaration in the active buffer's text, resolves it
 *  against the document's directory, and verifies it exists on disk. */
function activeDocumentBibPath(index) {
  try {
    const cur = spine.bufferListRecords(index).find((r) => r.current);
    // Only a TEXT document has a bibliography (a data-source record carries a
    // viewKind); it must be file-backed to resolve a relative bib path.
    if (!cur || cur.viewKind || !cur.filePath) return null;
    const text = spine.buffer && typeof spine.buffer.text === 'string'
      ? spine.buffer.text : '';
    const decl = detectBibDeclaration(text);
    if (!decl) return null;
    const abs = decl.startsWith('/') ? decl : join(dirname(cur.filePath), decl);
    return isFile(abs) ? abs : null;
  } catch {
    return null;
  }
}

/** Case-insensitive find-file path completion (the TAB-completion handler). The
 *  pure completePath does the matching; this wires the directory read, resolving
 *  the typed dir prefix the same way find-file resolves a path (~, relative to
 *  the seed-file dir, absolute). `{ value, items, directory }`. */
function completeFindFilePath(value) {
  return completePath(value, (dirPrefix) => {
    const absDir = dirPrefix === '' ? dirname(filePath) : resolvePath(dirPrefix);
    try {
      return readdirSync(absDir, { withFileTypes: true })
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      return null;
    }
  });
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

// --- companion-metadata (sidecar) I/O: the bookmarks/notes persistence ---
//
// The spine's bookmark engine reads a freshly-visited file's metadata to
// restore positions and writes it back when a bookmark changes. The server
// owns the filesystem, so it does this directly (no IPC), mirroring files.js's
// metadata:read / metadata:write so flag-on and flag-off produce identical
// sidecars.

/** Read ABSPATH's companion metadata for the spine (the readMetadata effect):
 *  the hidden `.NAME.godot-metadata`, else the legacy visible sidecar. Returns
 *  parsed JSON, or null when neither exists / is readable. */
function readMetadataForVisit(absPath) {
  if (typeof absPath !== 'string' || absPath === '') return null;
  for (const target of [metadataPath(absPath), legacyMetadataPath(absPath)]) {
    try {
      return JSON.parse(readFileSync(target, 'utf8'));
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Pending debounced sidecar writes (mirrors the renderer's scheduleMetadataWrite
 *  — a bookmark op shouldn't fsync on every keystroke). Two maps keyed by file
 *  path: the live timer, and the LATEST data to write (so a shutdown flush can
 *  complete a still-pending write synchronously). */
const metadataWriteTimers = new Map();
const pendingMetadata = new Map();

/** Write ABSPATH's pending companion metadata (the buffer's whole metadata
 *  object: bookmarks + notes). Empty data removes the sidecar rather than
 *  leaving a husk; otherwise the versioned JSON is atomic-written and the legacy
 *  sidecar retired — exactly files.js's metadata:write, but sync (the server's
 *  fs is direct). Throws are swallowed (a sidecar write must never crash). */
function writeMetadataNow(absPath) {
  clearTimeout(metadataWriteTimers.get(absPath));
  metadataWriteTimers.delete(absPath);
  if (!pendingMetadata.has(absPath)) return;
  const data = pendingMetadata.get(absPath);
  pendingMetadata.delete(absPath);
  try {
    const target = metadataPath(absPath);
    const legacy = legacyMetadataPath(absPath);
    const payload = data && typeof data === 'object' ? data : {};
    if (isEmptyMetadata(payload)) {
      rmSync(target, { force: true });
      rmSync(legacy, { force: true });
      return;
    }
    atomicWriteSync(target, JSON.stringify({ version: METADATA_VERSION, ...payload }, null, 2));
    rmSync(legacy, { force: true });
  } catch (error) {
    console.error(`[mwb-server] metadata write failed: ${error.message}`);
  }
}

/** Schedule a debounced sidecar write for ABSPATH (the writeMetadata effect).
 *  A later change to the same path coalesces — it replaces the pending data and
 *  resets the timer. */
function scheduleMetadataWrite(absPath, data) {
  if (typeof absPath !== 'string' || absPath === '') return;
  pendingMetadata.set(absPath, data);
  clearTimeout(metadataWriteTimers.get(absPath));
  metadataWriteTimers.set(absPath, setTimeout(() => writeMetadataNow(absPath), 500));
}

/** Flush EVERY pending sidecar write synchronously — the server's equivalent of
 *  the renderer's flushAllMetadata-on-quit. Without it a debounced bookmark
 *  write is lost when the app quits (will-quit → bridge dispose() SIGTERMs this
 *  child before the 500ms timer fires). Registered on SIGTERM/SIGINT/exit. */
function flushPendingMetadataWrites() {
  for (const absPath of [...pendingMetadata.keys()]) writeMetadataNow(absPath);
}

// --- the command spine ------------------------------------------------

const spine = createSpine(
  { initialText, name: bufferName, initialPath },
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
    onBufferSwitched: () => { bufferSwitchEffectFired = true; onKillReHome(); },
    // list-buffers (C-x C-b): send the active client its buffer-list records.
    onBufferList: () => { if (activeClient) sendBufferListTo(activeClient); },
    // A command opened a generic PICKER (G0b): send the active client the
    // request `{ id, title, rows, options }`. The client renders the
    // interactive list; the choice/cancel comes back as a PICKER intent.
    onPicker: (req) => { if (activeClient) sendPickerTo(activeClient, req); },
    // A window's pane layout/focus changed (split / other-window / delete):
    // push that client a fresh PANE_TREE (the structure + per-leaf buffer/
    // view-state + the focused leaf; no pixels).
    onPaneTree: (index) => sendPaneTreeToIndex(index),
    // new-window (C-x 5 2): the server can't open an OS window, so it asks the
    // active client to (host.newWindow() → main creates + attaches it as a new
    // client on this shared server).
    onNewWindow: () => sendWindowNewToActiveClient(),
    openFile: readFileForVisit,
    // save-buffer / write-file: atomic disk write (temp + fsync + rename).
    saveFile: writeFileForSave,
    // Bookmarks: restore a visited file's `.godot-metadata` sidecar, and
    // persist it back (debounced + atomic) when a bookmark changes.
    readMetadata: readMetadataForVisit,
    writeMetadata: scheduleMetadataWrite,
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

/** Whether the `onBufferSwitched` effect fired during the current intent (a
 *  switch-to-buffer / find-file / kill re-homed the client, which re-syncs it).
 *  Step 3b: a focus change (C-x o) onto a pane showing a DIFFERENT buffer also
 *  changes the client's active buffer, but does NOT go through that effect — so
 *  applyIntent re-syncs the originator itself when this stayed false. */
let bufferSwitchEffectFired = false;

// The bootstrap spine view (index 0) is claimed by the FIRST client ever; every
// client after that gets a fresh view via addClientView(). Crucially this is a
// ONE-SHOT, not `clients.length === 0`: a window can detach and re-home the
// count to 0 while the server lives on (macOS), and index 0's pane model is
// gone once that first client detached — so a reopened window must NOT reclaim
// 0, it gets a fresh monotonic index.
let bootstrapClaimed = false;

function registerClient(port) {
  // The FIRST window claims the bootstrap view (index 0) — it carries the
  // welcome / restored session. Every later window (G4 Step 1) is a FRESH
  // window: its own empty *scratch* buffer. EVERY window now renders as a
  // composable pane layout from its PANE_TREE (the unify): window 1 is seeded
  // as a TABLINE leaf of its restored files (in the HELLO handler), fresh
  // windows as a single scratch pane — one render path, different seeds.
  const isFresh = bootstrapClaimed;
  const index = isFresh ? spine.addClientView({ freshScratch: true }) : 0;
  bootstrapClaimed = true;
  const client = { port, index, windowKind: 'single' };
  clients.push(client);
  port.on('message', (event) => onClientMessage(client, event));
  // G4: when the window closes, its renderer's port is closed/GC'd and the
  // server's end fires 'close'. Reap the client so broadcasts don't post to a
  // dead port and the spine drops its window-state (the buffers outlive it).
  port.on('close', () => detachClient(client));
  port.start();
  // The client asks for its snapshot itself via HELLO once its page +
  // highlighters are ready (onClientMessage), so we don't snapshot here —
  // a pre-load snapshot would race the page and be discarded.
  console.error(
    `[mwb-server] client ${index} attached (${clients.length} total)`
  );
}

/** A client window closed (G4): drop it from the fan-out set, release any
 *  transient ownership it held (a send to a dead port would otherwise throw /
 *  no-op), and tell the spine to drop its window-state. Idempotent. The shared
 *  buffers — and any unsaved edits in them — live on in the server. */
function detachClient(client) {
  const i = clients.indexOf(client);
  if (i === -1) return; // already detached
  clients.splice(i, 1);
  // A command suspended on this client's prompt/picker is simply orphaned (a
  // closure that never resumes); clear the ownership so no later send targets
  // the dead port.
  if (activeClient === client) activeClient = null;
  if (minibufferClient === client) {
    minibufferState = MINIBUFFER_IDLE;
    minibufferClient = null;
  }
  if (pickerClient === client) pickerClient = null;
  spine.removeClientView(client.index);
  console.error(
    `[mwb-server] client ${client.index} detached (${clients.length} left)`
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

/** The client that owns the open generic picker, or null. One picker at a
 *  time in the shared model (the minibuffer's twin) — the choice/cancel comes
 *  back from this client and resumes the suspended command. */
let pickerClient = null;

/** The last PICKER request the server sent (the wire shape), for the self-test
 *  to inspect headlessly. Production ignores it. */
let lastPickerSent = null;

/** Send a client a generic PICKER request (the G0b channel): the wire shape
 *  `{ id, title, rows, options }`, normalised so a malformed row can't crash
 *  the render. The client renders the interactive list and replies with a
 *  PICKER_CHOOSE (the chosen row's value) or PICKER_CANCEL. */
function sendPickerTo(client, req) {
  pickerClient = client;
  const picker = normalisePickerRequest(req);
  lastPickerSent = picker;
  if (client && client.port) client.port.postMessage({ type: MSG.PICKER, picker, seq });
}

/** Send a client its window's PANE_TREE (the layout: split structure +
 *  per-leaf buffer/view-state + the focused leaf; NO pixels — the client
 *  derives those). Sent on HELLO and whenever the layout/focus changes. */
function sendPaneTreeTo(client) {
  const tree = spine.paneSnapshot(client.index);
  if (tree) client.port.postMessage({ type: MSG.PANE_TREE, tree, seq });
}

/** Push a fresh PANE_TREE to the client at INDEX (the onPaneTree effect). */
function sendPaneTreeToIndex(index) {
  const client = clients.find((c) => c.index === index);
  if (client) sendPaneTreeTo(client);
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

/** Ask the active client (the window that ran `new-window` via C-x 5 2) to
 *  open another window onto this shared server. The client calls
 *  host.newWindow(); main creates the window + attaches it as a new client. */
function sendWindowNewToActiveClient() {
  if (activeClient && activeClient.port) {
    activeClient.port.postMessage({ type: MSG.WINDOW_NEW, seq });
  }
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
    // G4 Step 1: how this window presents its root — 'tabline' (window 1, the
    // welcome/restored session) or 'single' (a fresh window: one composable
    // pane on its own *scratch*, no forced tabline). Stable per window.
    windowKind: client.windowKind,
    seq,
  });
}

/** Fully re-sync a client onto its current buffer: snapshot + view-state +
 *  its own cursor set + that buffer's overlays. Used after a buffer switch
 *  (the client must tear down its old mirror and build a fresh one). */
function resyncClientToCurrentBuffer(client) {
  spine.setActiveClient(client.index);
  // A non-text (data-source) focused leaf — a bookmark outline, media, directory,
  // jukebox, element — renders from the PANE_TREE, not a text snapshot. Sending a
  // SNAPSHOT here would carry the data-source id with the (stale) active document
  // text, and onSnapshot DESTROYS + RE-MOUNTS the mirror at that point — which
  // visibly rebuilds + scrolls a document shown in a SIBLING pane (the bug: focus
  // the bookmark outline beside a doc → the doc scrolled). Skip the snapshot; the
  // PANE_TREE (already pushed) is all a data-source leaf needs.
  if (!spine.isDataSource(spine.currentBufferIdOf(client.index))) {
    sendSnapshot(client);
  }
  sendViewTo(client);
  sendCursorsTo(client);
  sendOverlaysTo(client);
  // Push the open-buffer set too: a switch/visit/kill changed which buffers
  // exist or which is current, so the client's tabs + active marker must
  // follow. (The on-demand C-x C-b path still works; this keeps the tabs live
  // without a user request.)
  sendBufferListTo(client);
  // Remember the live multi-window pane layout across restarts (the `__last__`
  // snapshot). Fires on every buffer-set change (open / switch / kill).
  persistLastSession();
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
  bufferSwitchEffectFired = false; // set by onBufferSwitched if a switch re-homes
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
      case INTENT.PICKER_CHOOSE:
        // Slice C1: the boot workspace chooser is a SERVER-driven picker (no Lisp
        // command suspended on it), so intercept its choice by pickerId and route
        // it to the restore, rather than delivering it to the spine.
        if (intent.pickerId === 'workspace-chooser') {
          pickerClient = null;
          activeClient = client;
          spine.setActiveClient(client.index);
          handleWorkspaceChoice(client, intent.value);
          activeClient = null;
          return;
        }
        // A generic-picker choice (G0b): resume the suspended command with the
        // chosen row's value, guarded by the pickerId (a stale reply is
        // dropped). The continuation may switch the buffer (the buffer-list
        // picker does), which re-syncs the client via onBufferSwitched; close
        // the picker tracking and refresh the other clients' view-state.
        pickerClient = null;
        spine.deliverPicker(intent.value, intent.pickerId);
        broadcastView();
        activeClient = null;
        return;
      case INTENT.PICKER_CANCEL:
        // Slice C1: cancelling the boot chooser (Esc / C-g) starts fresh.
        if (intent.pickerId === 'workspace-chooser') {
          pickerClient = null;
          activeClient = client;
          spine.setActiveClient(client.index);
          handleWorkspaceChoice(client, '__fresh__');
          activeClient = null;
          return;
        }
        // Escape / C-g: resume the command with nil (it does nothing) + close.
        pickerClient = null;
        spine.cancelPicker(intent.pickerId);
        sendViewTo(client);
        activeClient = null;
        return;
      case INTENT.PICKER_DELETE:
        // ⌫ on a workspace-chooser row: delete that named workspace from the
        // store. The picker stays OPEN (the client already removed the row);
        // there's nothing to send back. A no-op for any other picker.
        if (intent.pickerId === 'workspace-chooser' && typeof intent.value === 'string') {
          sessionStore.remove(intent.value);
        }
        activeClient = null;
        return;
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
      case INTENT.VISIT_FILE: {
        // Open a file by path directly (no minibuffer) — a file clicked in a
        // directory-view. Like find-file: visitFile ADDS/switches the active
        // client onto it and fully re-syncs, so skip the edit path.
        const path = String(intent.path ?? '');
        if (path !== '') {
          const id = spine.visitFile(path);
          if (id) resyncClientToCurrentBuffer(client);
          activeClient = null;
          return;
        }
        break;
      }
      case INTENT.BOOKMARK_OP: {
        // An outline edit from a bookmark VIEW (mutable 'bookmark' data-source):
        // apply it to the source buffer's records. EDIT ops persist + fan the
        // fresh outline out via the data-source seam (onPaneTree), so nothing
        // else is needed here; JUMP moves the document's point + focuses its
        // pane and returns true, so we re-sync this client onto the document.
        const jumped = spine.applyBookmarkOp(String(intent.sourceId ?? ''), intent.op || {});
        if (jumped) resyncClientToCurrentBuffer(client);
        activeClient = null;
        return;
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
    // A switch-to-buffer / find-file / kill re-synced the originator via
    // onBufferSwitched. A FOCUS change onto a different-buffer pane (C-x o,
    // Step 3b) ALSO changed the active buffer but did NOT — so re-sync the
    // originator here onto its now-focused buffer (its live mirror must follow).
    if (!bufferSwitchEffectFired) resyncClientToCurrentBuffer(client);
    // Refresh the other clients' view-state (cheap; keeps everyone consistent).
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
    if (chosen && clientCommandNames.has(chosen)) {
      // A renderer-owned command (an element-view): the client runs it (it
      // computes the spec) and calls back with OPEN_ELEMENT_SOURCE.
      sendRunClientCommand(activeClient, chosen);
    } else if (chosen) {
      spine.runCommand(chosen);
    } else {
      // No server (or known client) command matched. Forward the raw name to
      // the client as a fallback: the renderer may own it even if its
      // CLIENT_COMMANDS announcement hadn't arrived yet (boot race) or it was
      // registered live (a define-element-view eval'd after connect). The
      // renderer's run-command surfaces an error if it's a genuine typo.
      const raw = value.trim();
      if (raw !== '') sendRunClientCommand(activeClient, raw);
    }
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
  if (prompt === 'Directory tree: ' || prompt === 'Directory columns: ') {
    spine.abortMinibuffer();
    // Open the chosen directory as a directory-view DATA-SOURCE of the kind the
    // command picked (tree vs columns). Switches the active client onto it.
    const kind = prompt === 'Directory columns: ' ? 'directory-columns' : 'directory-tree';
    const newId = spine.visitDirectory(value, kind);
    if (newId && activeClient) resyncClientToCurrentBuffer(activeClient);
    return;
  }
  if (prompt === 'Jukebox directory: ') {
    spine.abortMinibuffer();
    // Scan the chosen directory + open it as a jukebox DATA-SOURCE; the client
    // mounts <jukebox-view> and plays the tracks.
    const listing = scanJukeboxDir(value);
    if (listing) {
      const id = spine.openJukebox(listing);
      if (id && activeClient) resyncClientToCurrentBuffer(activeClient);
    } else if (activeClient) {
      sendStatusTo(activeClient, `Jukebox: cannot read directory ${value}`);
    }
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

// Command names the RENDERER owns (the element-view commands from
// define-element-view, incl. user-defined ones in init.lisp). Announced once
// per client via MSG.CLIENT_COMMANDS; merged into M-x so they complete + match,
// and routed back DOWN via RUN_CLIENT_COMMAND (the renderer computes the spec).
const clientCommandNames = new Set();

/** Ask CLIENT to run one of its own (renderer) commands by NAME — the M-x
 *  dispatch of a client-owned command. The renderer runs it (computing the
 *  spec) and may call back with OPEN_ELEMENT_SOURCE. For bib-search we also
 *  send the active document's bibliography path (the server resolves it; the
 *  renderer's inert session can't), so the panel loads the real .bib. */
function sendRunClientCommand(client, name) {
  if (!client) return;
  const bibPath = name === 'bib-search' ? activeDocumentBibPath(client.index) : null;
  client.port.postMessage({ type: MSG.RUN_CLIENT_COMMAND, name, bibPath });
}

function bestCommandMatch(value) {
  const v = value.trim();
  if (v === '') return null;
  // Match against the server's commands AND the client-owned (renderer) ones,
  // so M-x finds an element-view command exactly like a server command.
  const names = [...spine.commandNames(), ...clientCommandNames];
  if (names.includes(v)) return v;
  const sub = names.filter((n) => n.includes(v)).sort((a, b) => a.length - b.length);
  return sub[0] ?? null;
}

function onClientMessage(client, event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case MSG.HELLO: {
      let openChooserAfterPaint = false;
      spine.setActiveClient(client.index);
      // Restore the server's session (the user's open files) onto the FIRST
      // client to connect — before the snapshot, so it lands on the active file
      // with every tab present. Once per process; an active client now exists,
      // so visitFile works. Persist immediately so a session SEEDED from the
      // renderer's session.json becomes the server's own going forward.
      if (!sessionRestored) {
        sessionRestored = true;
        if (hasRestorableWorkspaces()) {
          // Slice C1: ask the user which workspace to restore (or start fresh)
          // via the chooser, instead of auto-restoring. DEFER the open until AFTER
          // the snapshot/pane-tree are painted below — else that view render steals
          // keyboard focus from the just-mounted (no-input) picker, killing nav.
          // The restore happens on the choice (handleWorkspaceChoice); the scratch
          // backdrop shows behind the chooser until then.
          openChooserAfterPaint = true;
        } else {
          // Nothing to restore — present the boot buffer as a 1-tab tabline
          // (today's first-run look).
          restoreSession(client);
          persistLastSession();
        }
      } else if (awaitingRestoreWindow && pendingRestore.length > 0) {
        // A just-spawned restore window: hand it the next saved layout BEFORE the
        // snapshot below, so it paints its restored tree (not the fresh scratch).
        applyNextRestoreWindow(client);
      }
      sendSnapshot(client);
      sendViewTo(client);
      // A late-joining client needs its current buffer's overlays + its own
      // cursor set (a window can attach while another already has highlights
      // or multi-cursor active on the same buffer).
      sendOverlaysTo(client);
      sendCursorsTo(client);
      // The full open-buffer set, so the client renders its tabs + active
      // marker from the first paint (a reconnect may already have several
      // buffers open). Re-pushed on every later buffer-set change via resync.
      sendBufferListTo(client);
      // The window's pane layout (a single leaf on first connect, or its
      // restored split tree on reconnect).
      sendPaneTreeTo(client);
      // The view is now painted — open the workspace chooser LAST so its picker
      // grabs (and, via picker-panel's next-frame re-assert, keeps) focus.
      if (openChooserAfterPaint) openWorkspaceChooser(client);
      break;
    }
    case MSG.INTENT:
      applyIntent(client, msg.intent);
      break;
    case MSG.PANE: {
      // A pane structural request: mutate this window's logical tree via the
      // REAL panes.lisp command (the model's onChange pushes the fresh
      // PANE_TREE). A split/other/delete may move which buffer the focused
      // pane edits, so re-sync this client onto its focused buffer too.
      activeClient = client;
      const before = spine.currentBufferIdOf(client.index);
      spine.applyPaneIntent(client.index, msg.intent || {});
      const after = spine.currentBufferIdOf(client.index);
      if (after !== before) {
        resyncClientToCurrentBuffer(client); // re-syncs + persists the session
      } else {
        sendViewTo(client);
        sendCursorsTo(client);
        // A pane intent can change the layout without moving the focused buffer
        // (e.g. closing a NON-active tab, a split, a resize) — re-persist so the
        // change is captured in the `__last__` snapshot.
        persistLastSession();
      }
      activeClient = null;
      break;
    }
    case MSG.PANE_VIEWPORT:
      // The client's editor-area pixel rectangle, for spatial pane nav. The
      // ONLY pixel report the pane model needs (everything else is pixel-free).
      spine.setPaneHostRect(client.index, msg.rect || {});
      break;
    case MSG.VIEWPORT:
      // The client's visible text-LINE count for its server-view (plan §5d).
      // Stored per client; screenful scroll (C-v/M-v via `page-lines`) reads
      // it. Sent on mount + resize; a stale/zero report is ignored by the
      // spine (keeps the last good value).
      spine.setViewport(client.index, msg.lines);
      break;
    case MSG.WINDOW_BOUNDS:
      // B2: the client reported its window frame + display (on connect + every
      // move/resize). Stored on the client so the session snapshot records this
      // window's geometry; main reconciles it against the live displays on
      // restore. A malformed report is ignored (keeps the last good value).
      if (msg.bounds && typeof msg.bounds === 'object') {
        client.bounds = msg.bounds;
        client.display = msg.display ?? null;
      }
      break;
    case MSG.WINDOW_DOCK:
      // The client reported its REPL / utility-dock visibility (renderer chrome,
      // not in the pane tree — so the workspace records it separately).
      if (msg.dock && typeof msg.dock === 'object') client.dock = msg.dock;
      break;
    case MSG.SESSION_SAVE: {
      // C2: remember the live multi-window arrangement under a label (the quit
      // "Remember this workspace?" prompt). Captures the ARRANGEMENT (panes /
      // files / cursors / geometry), NOT document content. The write is a
      // synchronous atomicWriteSync, and the client posts this just before it
      // quits (every window still live), so it lands before the server is killed.
      const label = typeof msg.label === 'string' ? msg.label : '';
      const windows = collectSessionWindows();
      if (windows.length > 0) {
        const id = sessionStore.save({ label, windows, activeWindow: activeWindowIndex() });
        console.error(`[mwb-session] saved workspace "${label}" (${id}, ${windows.length} window(s))`);
      }
      break;
    }
    case MSG.SESSION_DELETE:
      // Remove a named workspace (from the chooser). The `__last__` snapshot
      // can't be deleted this way (it's the live auto-snapshot).
      if (typeof msg.id === 'string' && msg.id !== '__last__') sessionStore.remove(msg.id);
      break;
    case MSG.MINIBUFFER_COMPLETE: {
      // TAB in the minibuffer. Find-file gets CASE-INSENSITIVE path completion;
      // the client sent its current input. Other prompts (M-x, switch-to-buffer)
      // have their own completion — not wired yet. A read-only query (no edit),
      // so it replies directly rather than going through applyIntent.
      if (spine.activePrompt === 'Find file: '
          || spine.activePrompt === 'Directory tree: '
          || spine.activePrompt === 'Directory columns: '
          || spine.activePrompt === 'Jukebox directory: ') {
        const r = completeFindFilePath(String(msg.value ?? ''));
        client.port.postMessage({
          type: MSG.MINIBUFFER_COMPLETIONS,
          value: r.value, items: r.items, directory: r.directory,
        });
      }
      break;
    }
    case MSG.CLIENT_COMMANDS:
      // The client announces the renderer-owned command names (element-views).
      // Merge them so M-x completes/matches them and routes them back down.
      if (Array.isArray(msg.names)) {
        for (const n of msg.names) {
          if (typeof n === 'string' && n !== '') clientCommandNames.add(n);
        }
      }
      break;
    case MSG.OPEN_ELEMENT_SOURCE: {
      // The renderer computed an element-view spec and asks the server to hold
      // it as a data-source + switch this client's focused leaf to it (like a
      // find-file). The PANE_TREE then carries the spec for the client to mount.
      activeClient = client;
      const id = spine.openElementSource(msg.spec || {});
      if (id) resyncClientToCurrentBuffer(client);
      activeClient = null;
      break;
    }
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

// --- session persistence (server-owned) -------------------------------
//
// The server remembers the user's OPEN FILES across restarts: a flat list of
// file paths + which is active, written on every buffer-set change and restored
// when the first client connects. Distinct from crash-RECOVERY (which preserves
// UNSAVED edits): graduating Godot onto the server means the SERVER, not the
// renderer, owns the session. On the FIRST server boot there is no server
// session yet — MWB_SESSION_SEED (the renderer's session.json, passed by main)
// seeds the file list once, then the server owns it (Increment 3 step 2).
// (SESSION_STORE is declared up by the seed setup, which reads it too.)

/** Whether the server has restored its session yet (once per process, on the
 *  first client's HELLO — when an active client exists for visitFile). */
let sessionRestored = false;

/** Every file path referenced by a window-blob's pane tree (text leaves + the
 *  text tabs of tabline leaves), de-duped in encounter order. Used both to pick
 *  the boot seed and to open the files before rebuilding a layout. */
function pathsInWindowBlob(rootPane) {
  const out = [];
  const add = (p) => { if (typeof p === 'string' && p !== '' && !out.includes(p)) out.push(p); };
  const walkView = (v) => {
    if (!v) return;
    if (v.kind === 'tabline' && Array.isArray(v.tabs)) {
      v.tabs.forEach((t) => { if (t && typeof t.path === 'string') add(t.path); });
    } else if (typeof v.path === 'string') {
      // Every leaf kind's file is opened up front: text → buffer, media/dir →
      // data-source (visitFile routes by suffix), a BOOKMARK's path is its SOURCE
      // file (opened as text; restoreBookmarkOutline then builds the outline).
      add(v.path);
    }
  };
  const walkPane = (p) => {
    if (!p) return;
    if (p.kind === 'leaf') walkView(p.view);
    else if (p.kind === 'split') { walkPane(p.first); walkPane(p.second); }
  };
  walkPane(rootPane);
  return out;
}

/** The boot SEED hint `{ files, active }` from the store's `__last__` snapshot:
 *  the candidate files for the initial TEXT buffer + the focused leaf's active
 *  file (so the seed buffer is the one the user last had focused). Null when
 *  there is no saved layout. Reads the active window's blob. */
function sessionBootInfo() {
  const last = sessionStore.get('__last__');
  const windows = last && Array.isArray(last.windows) ? last.windows : [];
  if (windows.length === 0) return null;
  const win = windows[last.activeWindow] ?? windows[0];
  if (!win || !win.rootPane) return null;
  const files = pathsInWindowBlob(win.rootPane);
  if (files.length === 0) return null;
  // The focused leaf's active path is the best seed; else the first file.
  let active = null;
  const walkPane = (p) => {
    if (!p || active) return;
    if (p.kind === 'leaf') {
      if (!p.focused || !p.view) return;
      if (p.view.kind === 'text') active = p.view.path;
      else if (p.view.kind === 'tabline' && Array.isArray(p.view.tabs)) {
        const t = p.view.tabs[p.view.active];
        if (t && t.kind === 'text') active = t.path;
      }
    } else if (p.kind === 'split') { walkPane(p.first); walkPane(p.second); }
  };
  walkPane(win.rootPane);
  return { files, active: active ?? files[0] };
}

/** Snapshot every LIVE window's pane layout (by path) for the session store, in
 *  stable order (ascending client index). Each window carries the geometry the
 *  client last reported (WINDOW_BOUNDS) — null until it has reported, in which
 *  case restore default-places it. */
function collectSessionWindows() {
  const out = [];
  const ordered = [...clients].sort((a, b) => a.index - b.index);
  for (const c of ordered) {
    const rootPane = spine.serializeWindow(c.index);
    if (!rootPane) continue;
    out.push({
      rootPane, bounds: c.bounds ?? null, display: c.display ?? null,
      dock: c.dock ?? null,
    });
  }
  return out;
}

/** The index (into the stable window order) of the active window, for the
 *  session's `activeWindow`. Defaults to 0. */
function activeWindowIndex() {
  if (!activeClient) return 0;
  const ordered = [...clients].sort((a, b) => a.index - b.index);
  const i = ordered.findIndex((c) => c.index === activeClient.index);
  return i < 0 ? 0 : i;
}

/** Write the `__last__` auto-snapshot — the full multi-window pane structure of
 *  the live session. Replaces the old flat persist; called on every buffer-set /
 *  pane-layout change. Tolerant: a write failure must never disturb editing. */
function persistLastSession() {
  // Skip mid-restore: only window-1 is live until the spawned windows connect,
  // so persisting now would clobber the multi-window snapshot we're restoring
  // FROM. applyNextRestoreWindow persists once the last window has landed.
  if (restoreInProgress) return;
  try {
    const windows = collectSessionWindows();
    if (windows.length === 0) return;
    sessionStore.writeLast({ windows, activeWindow: activeWindowIndex() });
  } catch (error) {
    console.error(`[mwb-session] persist failed: ${error.message}`);
  }
}

// --- the workspace chooser (slice C1) ---------------------------------
//
// On the first HELLO, if there is anything to restore, the server opens a
// server-driven generic PICKER (reusing the client's picker-panel) listing the
// saved workspaces + a "start fresh" row, INSTEAD of auto-restoring. The choice
// is intercepted by pickerId in the PICKER_CHOOSE handler (no Lisp command is
// suspended on it) and routed to handleWorkspaceChoice.

/** Whether the store holds anything to restore (the `__last__` auto-snapshot or
 *  any named workspace) — i.e. whether to show the chooser at boot. */
function hasRestorableWorkspaces() {
  return !!sessionStore.get('__last__') || sessionStore.list().sessions.length > 0;
}

/** A short, human relative time for a workspace's `savedAt`. */
function relativeTime(ts) {
  if (!Number.isFinite(ts)) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  try { return new Date(ts).toLocaleDateString(); } catch { return ''; }
}

/** The chooser's picker rows: the `__last__` snapshot first (if any), then the
 *  named workspaces (most-recent first), then a "start fresh" row. Each row's
 *  `value` is the session id to restore (or the `__fresh__` sentinel). */
function workspaceChooserRows() {
  const rows = [];
  const winLabel = (n) => `${n} window${n === 1 ? '' : 's'}`;
  const last = sessionStore.get('__last__');
  if (last) {
    rows.push({
      label: '⚨  Last workspace',
      value: '__last__',
      meta: winLabel(Array.isArray(last.windows) ? last.windows.length : 0),
      detail: relativeTime(last.savedAt),
    });
  }
  const { sessions } = sessionStore.list();
  for (const s of [...sessions].sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))) {
    rows.push({
      label: s.label && s.label !== '' ? s.label : '(unnamed workspace)',
      value: s.id,
      meta: winLabel(s.windowCount),
      detail: relativeTime(s.savedAt),
      deletable: true, // ⌫ removes it ("Last workspace" / "Start fresh" are not)
    });
  }
  rows.push({ label: '✨  Start fresh', value: '__fresh__' });
  return rows;
}

/** Open the workspace chooser on CLIENT (the first window). The choice is
 *  intercepted by pickerId in the PICKER_CHOOSE handler. */
function openWorkspaceChooser(client) {
  sendPickerTo(client, {
    id: 'workspace-chooser',
    title: 'Restore workspace',
    rows: workspaceChooserRows(),
    // A no-filter MENU (a short list), so bare n/p navigate (+ arrows, + C-n/C-p).
    options: {
      placeholder: 'Choose a workspace to restore…', kind: 'workspace', filter: false,
      hint: '↵ restore    ⌫ delete    n/p move    esc start fresh',
    },
  });
}

/** Resolve a workspace-chooser choice: restore the chosen workspace by id, or
 *  start fresh (`__fresh__`, an empty value, or a cancel). Re-syncs the window
 *  onto its new content (spawned restore windows sync on their own HELLO). */
function handleWorkspaceChoice(client, value) {
  if (value === '__fresh__' || value == null || value === '') {
    seedWindow1Tabline(client); // the scratch backdrop becomes a 1-tab tabline
  } else {
    restoreSession(client, value);
    // The restored layout becomes `__last__`; self-guards mid multi-window
    // restore (applyNextRestoreWindow persists once every window has landed).
    persistLastSession();
  }
  sendSnapshot(client);
  sendViewTo(client);
  sendOverlaysTo(client);
  sendCursorsTo(client);
  sendBufferListTo(client);
  sendPaneTreeTo(client);
}

// --- multi-window restore orchestration (slice B) ---------------------
//
// The saved session can hold several windows. window[0] lands on the bootstrap
// client; the rest are spawned ONE AT A TIME — we ask main for the next window
// only after the current one has connected, so a HELLO is never ambiguous (no
// out-of-order race, no per-window tagging). `pendingRestore` is the queue of
// not-yet-restored window-blobs; `awaitingRestoreWindow` marks that the next
// non-bootstrap HELLO should take the head of the queue; `restoreInProgress`
// suspends the `__last__` writer until every window is live.
let pendingRestore = [];
let awaitingRestoreWindow = false;
let restoreInProgress = false;

/** The saved geometry `{ bounds, display }` of a window-blob, or null. */
function windowGeometry(w) {
  return w && w.bounds ? { bounds: w.bounds, display: w.display ?? null } : null;
}

/** Send CLIENT its saved REPL / utility-dock visibility (on restore), and keep
 *  the server's record in sync with what we just restored (so a later save of an
 *  un-toggled, un-quit window still records the restored state). */
function sendDockTo(client, dock) {
  if (dock && client && client.port) {
    client.dock = dock;
    client.port.postMessage({ type: MSG.SET_DOCK, dock });
  }
}

/** Ask a live client to spawn another OS window (main creates it + attaches it
 *  as a new client, at GEOMETRY's reconciled bounds when given). Targets the
 *  active client, else the bootstrap (clients[0]) — both are connected during a
 *  restore, unlike `activeClient`, which may be null between intents. */
function requestSpawnWindow(geometry) {
  const target = activeClient ?? clients[0];
  if (target && target.port) {
    target.port.postMessage({ type: MSG.WINDOW_NEW, seq, geometry: geometry ?? null });
  }
}

/** Flag that we're awaiting the next restore window, then ask for it (carrying
 *  that window's saved geometry so main can size/place it as it spawns). */
function spawnNextRestoreWindow() {
  if (pendingRestore.length === 0) return;
  awaitingRestoreWindow = true;
  requestSpawnWindow(windowGeometry(pendingRestore[0]));
}

/** Restore the saved session (`__last__`) at boot. Opens every file across ALL
 *  its windows once into the shared registry (a file in two windows is one
 *  buffer with independent per-window views), rebuilds window[0] onto the
 *  bootstrap client, then queues the remaining windows and spawns the first (the
 *  rest cascade in via applyNextRestoreWindow as each connects). Falls back to a
 *  1-tab tabline when there is no saved layout. Called once, from the first
 *  HELLO. Tolerant. */
function restoreSession(client, id = '__last__') {
  restoreInProgress = true;
  const last = sessionStore.get(id);
  const windows = last && Array.isArray(last.windows) ? last.windows : [];
  const win0 = windows[0];
  if (!win0 || !win0.rootPane) {
    restoreInProgress = false;
    seedWindow1Tabline(client);
    return;
  }
  try {
    // Open every file the WHOLE session references, once (spawned windows then
    // resolve their paths from the shared registry).
    const opened = new Set();
    for (const w of windows) {
      if (!w || !w.rootPane) continue;
      for (const p of pathsInWindowBlob(w.rootPane)) {
        if (opened.has(p)) continue;
        opened.add(p);
        spine.visitFile(p);
      }
    }
    if (!spine.loadWindowLayout(client.index, win0.rootPane)) seedWindow1Tabline(client);
    // B2: restore window 1's geometry. Window 1 pre-exists at default bounds (it
    // booted before the restore), so we send it down for main to reconcile +
    // resize; spawned windows are instead born at their reconciled bounds via the
    // WINDOW_NEW payload.
    const geom0 = windowGeometry(win0);
    if (geom0 && client.port) {
      client.port.postMessage({ type: MSG.SET_WINDOW_BOUNDS, geometry: geom0 });
    }
    sendDockTo(client, win0.dock);
    console.error(`[mwb-session] restoring ${windows.length} window(s)`);
    pendingRestore = windows.slice(1).filter((w) => w && w.rootPane);
    if (pendingRestore.length > 0) spawnNextRestoreWindow();
    else restoreInProgress = false; // single window — restore complete
  } catch (error) {
    restoreInProgress = false;
    console.error(`[mwb-session] restore failed: ${error.message}`);
    seedWindow1Tabline(client);
  }
}

/** Apply the next queued window layout to a freshly-spawned restore window (its
 *  files are already open from restoreSession), then spawn the next — until the
 *  queue drains, at which point the restore is complete and we persist the full
 *  multi-window snapshot. Called from a non-bootstrap HELLO while awaiting one. */
function applyNextRestoreWindow(client) {
  awaitingRestoreWindow = false;
  const blob = pendingRestore.shift();
  if (blob && blob.rootPane) spine.loadWindowLayout(client.index, blob.rootPane);
  sendDockTo(client, blob && blob.dock); // restore this window's REPL/dock state
  if (pendingRestore.length > 0) {
    spawnNextRestoreWindow();
  } else {
    restoreInProgress = false;
    persistLastSession(); // every window is live — capture the full snapshot
  }
}

/** Seed window 1 (the bootstrap client) as a TABLINE leaf of its open files (the
 *  unify): its restored session presents as curated tabs in a composable pane,
 *  rendered through the same PANE_TREE pipeline as every window. Called once,
 *  right after the session restore. The open-set always holds ≥1 buffer (the boot
 *  buffer), so a session-less first boot still gets a 1-tab tabline (matching the
 *  pre-unify look). The model's onChange re-pushes the PANE_TREE. */
function seedWindow1Tabline(client) {
  const recs = spine.bufferListRecords(client.index);
  const ids = recs.map((r) => r.id);
  if (ids.length === 0) return;
  const activeId = (recs.find((r) => r.current) ?? recs[0]).id;
  spine.seedClientTabline(client.index, ids, activeId);
}

/** Parse the renderer's session.json (its path passed as MWB_SESSION_SEED by
 *  the main process) for its open TEXT-file paths + the active one, used ONLY to
 *  seed the server's session on the first boot. The schema is session.js's
 *  pane-tree blob: `{ rootPane }` where a pane is `{kind:'leaf', view}` or
 *  `{kind:'split', first, second}`, and a view is `{kind:'text', path}` or
 *  `{kind:'tabline', tabs:[...]}`. Returns `{ files, active }` or null. */
function readSessionSeed() {
  const seedPath = process.env.MWB_SESSION_SEED;
  if (!seedPath) return null;
  let blob;
  try {
    blob = JSON.parse(readFileSync(seedPath, 'utf8'));
  } catch {
    return null; // no session.json yet, or unreadable
  }
  const files = [];
  const addPath = (p) => {
    if (typeof p === 'string' && p !== '' && !files.includes(p)) files.push(p);
  };
  const walkView = (view) => {
    if (!view || typeof view !== 'object') return;
    if (view.kind === 'text') addPath(view.path);
    else if (view.kind === 'tabline' && Array.isArray(view.tabs)) view.tabs.forEach(walkView);
    // Other view kinds (browser / pdf / bookmark) aren't text files — skip.
  };
  const walkPane = (pane) => {
    if (!pane || typeof pane !== 'object') return;
    if (pane.kind === 'leaf') walkView(pane.view);
    else if (pane.kind === 'split') { walkPane(pane.first); walkPane(pane.second); }
  };
  walkPane(blob.rootPane);
  if (files.length === 0) return null;
  return { files, active: files[files.length - 1] };
}

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
  // Snapshots accumulate across crashes (esp. force-quits), and the buffer-name
  // uniquifier compounds near-duplicate copies of the SAME logical buffer
  // (view.js<2><2>…) because a path-less seed keys snapshots by an ephemeral
  // buffer id. Collapse to the MOST RECENT snapshot per base name (strip the
  // <n> suffixes) so recovery surfaces ONE buffer per logical file, not a pile.
  const baseName = (n) => String(n || '').replace(/(<\d+>)+$/, '');
  const latest = new Map();
  for (const r of recoverable) {
    const key = baseName(r.name) || r.key;
    const prev = latest.get(key);
    if (!prev || (r.savedAt ?? 0) > (prev.savedAt ?? 0)) latest.set(key, r);
  }
  const deduped = [...latest.values()];
  console.error(
    `[mwb-server] crash recovery: ${recoverable.length} snapshot(s) → ${deduped.length} buffer(s):`
  );
  for (const r of deduped) {
    console.error(`  - ${baseName(r.name) || r.key} (saved ${new Date(r.savedAt).toISOString()})`);
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
      // Load the recovered text as a buffer (path bound if it had one), named by
      // its BASE name so it doesn't carry a compounded <n> suffix. It is DIRTY
      // relative to disk by construction (why it was recovered), so its ● shows.
      spine.recoverBuffer({ name: baseName(r.name) || r.name, filePath: r.path, text: r.text, diskBaseline });
    } catch (error) {
      console.error(`[mwb-server] could not load recovered buffer: ${error.message}`);
    }
  }
  // The snapshots are now loaded into buffers — CONSUME them so they don't
  // re-recover and pile up next launch (the runaway-accumulation root). Going
  // forward, autosave re-snapshots only the live dirty buffers.
  autosave.clear();
}

recoverOnStartup();
autosave.start();

// Flush pending sidecar writes on shutdown so a debounced bookmark / sticky-note
// write survives quit. On quit, main's will-quit calls the bridge's dispose(),
// which SIGTERMs this child; the handler flushes synchronously (atomic writes)
// before exiting. `exit` is the backstop for any other graceful teardown. Both
// are idempotent — flushPendingMetadataWrites empties the pending map.
function shutdownFlushMetadata() {
  try { flushPendingMetadataWrites(); } catch { /* best effort on the way out */ }
}
process.on('SIGTERM', () => { shutdownFlushMetadata(); process.exit(0); });
process.on('SIGINT', () => { shutdownFlushMetadata(); process.exit(0); });
process.on('exit', shutdownFlushMetadata);

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

// --- headless pane/window self-test (MWB_PANES_SELFTEST=1) -------------
//
// Drives the REAL panes.lisp commands through the spine — split (C-x 2),
// other-window (C-x o), delete-window (C-x 0) — and asserts the LOGICAL pane
// tree, which leaf/buffer is focused, and the load-bearing claim: an edit
// lands in the focused pane's buffer while a second pane on the SAME buffer
// reflects the text with its own point. The verification of record is
// node --test (spine-panes.test.js, 19 cases); this is the architect-facing
// in-electron mirror. PASS/FAIL on stderr + parentPort; wrapped so a failure
// can never crash the main process (the guardrail).
function runPanesSelfTest() {
  const checks = {};
  let detail = '';
  try {
    const idx = 0;
    spine.setActiveClient(idx);
    // Start: a single leaf.
    checks.oneLeaf = (spine.paneSnapshot(idx) || {}).kind === 'leaf';

    // C-x 2 → a vertical split of two leaves, focus on the new one.
    spine.handleKey('C-x');
    spine.handleKey('2');
    const snap = spine.paneSnapshot(idx);
    checks.split = snap.kind === 'split' && snap.orientation === 'vertical';
    const leaves = []; (function walk(n) {
      if (!n) return; if (n.kind === 'leaf') leaves.push(n);
      else { walk(n.first); walk(n.second); }
    })(snap);
    checks.twoLeaves = leaves.length === 2;
    const paneA = snap.first; const paneB = snap.second;
    checks.focusOnNew = paneB.focused === true;
    checks.sameBuffer = paneA.bufferId === paneB.bufferId && !!paneA.bufferId;

    // Type in the focused pane (paneB); the shared buffer changes, paneB's
    // point advances, paneA (same buffer) keeps its own point.
    const before = spine.buffer.text;
    for (const ch of 'PANES') spine.handleKey(ch);
    checks.edited = spine.buffer.text === `${before}PANES` || spine.buffer.text.includes('PANES');
    const snap2 = spine.paneSnapshot(idx);
    const b2 = []; (function walk(n) {
      if (!n) return; if (n.kind === 'leaf') b2.push(n);
      else { walk(n.first); walk(n.second); }
    })(snap2);
    const fa = b2.find((l) => l.id === paneA.id);
    const fb = b2.find((l) => l.id === paneB.id);
    checks.focusedPaneMoved = fb && fb.point > 0;
    checks.otherPaneIndependent = fa && fa.point === 0;

    // C-x o → focus the other pane.
    spine.handleKey('C-x');
    spine.handleKey('o');
    checks.otherWindow = (function () {
      const s = spine.paneSnapshot(idx);
      const ls = []; (function walk(n) {
        if (!n) return; if (n.kind === 'leaf') ls.push(n); else { walk(n.first); walk(n.second); }
      })(s);
      const f = ls.find((l) => l.focused);
      return f && f.id === paneA.id;
    })();

    // C-x 0 → collapse back to one leaf.
    spine.handleKey('C-x');
    spine.handleKey('0');
    checks.deleteWindow = (spine.paneSnapshot(idx) || {}).kind === 'leaf';

    detail = `text=${JSON.stringify(spine.buffer.text.slice(0, 30))}`;
  } catch (error) {
    detail += `threw=${error && error.message}`;
  }
  const ok = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
  console.error(
    `[mwb-panes-selftest] ${Object.entries(checks).map(([k, v]) => `${k}=${v}`).join(' ')} ${detail}`
  );
  console.error(`[mwb-panes-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
  try {
    process.parentPort.postMessage({ type: 'panes-selftest-done', ok });
  } catch {
    // No parent (a bare node run): the stderr line is the result.
  }
}

if (process.env.MWB_PANES_SELFTEST === '1') {
  setTimeout(runPanesSelfTest, 300);
}

// --- headless generic-picker self-test (MWB_PICKER_SELFTEST=1) ---------
//
// Drives the WHOLE G0b round-trip through the REAL server intent path: open a
// second buffer, run list-buffers (C-x C-b) so the command SUSPENDS on a
// PICKER, assert the server emitted a PICKER request carrying the buffer rows,
// then feed a PICKER_CHOOSE intent (the client's reply) through applyIntent —
// the production reply path — and assert the suspended command resumed and the
// window switched to the chosen buffer. Also checks the cancel path leaves the
// window put and a stale pickerId is dropped. The verification of record is
// node --test (spine.test.js: 6 picker cases + protocol.test.js: 11 helper
// cases); this is the architect-facing in-electron mirror. PASS/FAIL on stderr
// + parentPort, wrapped so a failure can never crash the main process.
function runPickerSelfTest() {
  const checks = {};
  let detail = '';
  try {
    // A stub client so the onPicker/onBufferSwitched effects have a target +
    // capture the messages the server would post to a real window.
    const posted = [];
    const stub = { on() {}, start() {}, postMessage: (m) => posted.push(m) };
    registerClient(stub);
    const client = clients.find((c) => c.port === stub);
    activeClient = client;
    spine.setActiveClient(client.index);

    // Open a SECOND buffer (a /tmp scratch file) so the list has >1 row.
    const target = join(tmpdir(), `mwb-picker-${process.pid}.txt`);
    writeFileSync(target, 'SECOND BUFFER BODY\n');
    const seedName = spine.buffer.name;
    spine.visitFile(target); // the active client switches to it
    checks.twoBuffers = spine.bufferCount === 2;
    checks.onSecond = spine.buffer.name !== seedName;
    const seedId = spine.bufferIdByName(seedName);

    // C-x C-b → list-buffers suspends on a PICKER. Drive it as KEY intents
    // through applyIntent (the real wire path), not a direct call.
    lastPickerSent = null;
    applyIntent(client, { id: 1, kind: INTENT.KEY, key: 'C-x' });
    applyIntent(client, { id: 2, kind: INTENT.KEY, key: 'C-b' });
    checks.pickerEmitted = !!lastPickerSent && lastPickerSent.title === 'Buffer list';
    checks.pickerHasRows = !!lastPickerSent && lastPickerSent.rows.length === 2;
    checks.commandSuspended = !!spine.activePicker; // still open, awaiting a choice
    const pickerId = lastPickerSent ? lastPickerSent.id : null;
    const seedRow = lastPickerSent
      ? lastPickerSent.rows.find((r) => r.value === seedId)
      : null;
    checks.seedRowPresent = !!seedRow;

    // A STALE reply (wrong pickerId) must be dropped — the window must not move.
    applyIntent(client, {
      id: 3, kind: INTENT.PICKER_CHOOSE, value: seedId, pickerId: 'picker-stale',
    });
    checks.staleDropped = spine.buffer.name !== seedName && !!spine.activePicker;

    // The real reply: PICKER_CHOOSE the seed buffer → the command resumes and
    // the window switches back to it.
    applyIntent(client, {
      id: 4, kind: INTENT.PICKER_CHOOSE, value: seedId, pickerId,
    });
    checks.switchedOnChoose = spine.buffer.name === seedName;
    checks.pickerClosed = spine.activePicker === null;
    checks.clientResynced = posted.some((m) => m.type === MSG.SNAPSHOT);

    // The cancel path: open the picker again, cancel it (Escape), and assert
    // the window stays on whatever buffer it was on (a cancel does nothing).
    activeClient = client;
    spine.setActiveClient(client.index);
    const beforeCancel = spine.buffer.name;
    applyIntent(client, { id: 5, kind: INTENT.KEY, key: 'C-x' });
    applyIntent(client, { id: 6, kind: INTENT.KEY, key: 'C-b' });
    const cancelId = lastPickerSent ? lastPickerSent.id : null;
    applyIntent(client, { id: 7, kind: INTENT.PICKER_CANCEL, pickerId: cancelId });
    checks.cancelStaysPut = spine.buffer.name === beforeCancel;
    checks.cancelClosed = spine.activePicker === null;

    detail = `buffer=${JSON.stringify(spine.buffer.name)}`;
  } catch (error) {
    detail += `threw=${error && error.message}`;
  }
  const ok = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
  console.error(
    `[mwb-picker-selftest] ${Object.entries(checks).map(([k, v]) => `${k}=${v}`).join(' ')} ${detail}`
  );
  console.error(`[mwb-picker-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
  try {
    process.parentPort.postMessage({ type: 'picker-selftest-done', ok });
  } catch {
    // No parent (a bare node run): the stderr line is the result.
  }
}

if (process.env.MWB_PICKER_SELFTEST === '1') {
  setTimeout(runPickerSelfTest, 300);
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
