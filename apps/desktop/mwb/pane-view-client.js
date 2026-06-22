/**
 * @file Model-B MULTI-PANE client (G0a) — renders a window's PANE_TREE as
 * several real `view.js` instances laid out by the client's own pixels.
 *
 * This is the client half of the pane separation, made concrete. The server
 * owns the LOGICAL pane tree; this client:
 *   1. receives a PANE_TREE (split structure + per-leaf buffer/view-state +
 *      focus; NO pixels),
 *   2. lays it out with the PURE `layoutPaneTree` (the same `computeRects`
 *      math the server + production app.js use), fed by THIS window's own
 *      editor-area rectangle,
 *   3. diffs the leaf set and mounts one `createEditorView` per leaf on a
 *      per-buffer ClientBuffer mirror (with the leaf's view-state),
 *   4. positions each leaf's element absolutely at its computed rect,
 *   5. routes keystrokes to the FOCUSED leaf (the server runs the command;
 *      the deltas come back per buffer and update every pane on that buffer),
 *   6. forwards split/other/delete intents (C-x 2/3/o/0/1) + a PANE_VIEWPORT
 *      report (its host rect, for spatial nav) UP.
 *
 * The geometry-cost proof in practice: this file is small because the hard
 * part (the tree + the commands) is the server's, and the pixels are pure
 * `computeRects` over the client's rect. Loaded only by pane-harness.html
 * behind the MWB pane harness — production is untouched. DOM code; the
 * verification of record is the pure layout module's node --test
 * (pane-client-layout.test.js) + the spine integration tests.
 */

import { createEditorView } from '../../../packages/renderer/src/view.js';
import { loadLanguageHighlighters } from '../../../packages/renderer/src/language-registry.js';
import { keyEventToString } from '../../../packages/renderer/src/keymap.js';

import { MSG, INTENT } from './protocol.js';
import { createClientBuffer } from './client-buffer.js';
import { layoutPaneTree, diffPaneLeaves } from './pane-client-layout.js';

const hostEl = document.getElementById('panes');
const statusEl = document.getElementById('status');
const linkEl = document.getElementById('link');

/** @type {MessagePort | null} */
let port = null;
let highlighters = {};
let foldCaptures = {};
let nextIntentId = 1;

/** The latest PANE_TREE from the server (this window's layout). */
let paneTree = null;
/** The focused leaf id (the pane the keyboard drives). */
let focusedLeafId = null;

/**
 * One mounted leaf: its DOM host, its real view, and the buffer id it shows.
 * Keyed by leaf id. Two leaves on the SAME buffer share a mirror (the server's
 * snapshot/delta is per buffer), but each has its OWN view (its own caret).
 * @type {Map<string, { el: HTMLElement, view: object, bufferId: string }>}
 */
const leafEls = new Map();

/**
 * One ClientBuffer mirror per buffer this window shows, keyed by buffer id.
 * Several panes on one buffer share the mirror (one synced text), each
 * rendering it through its own view. @type {Map<string, object>}
 */
const mirrors = new Map();

function setStatus(text) { if (statusEl) statusEl.textContent = text; }
function setLink(text, cls) {
  if (!linkEl) return;
  linkEl.textContent = text;
  linkEl.className = cls || '';
}

// --- input: keystrokes go to the FOCUSED leaf via a KEY intent ---------

/** This window's editor-area rectangle (the only pixels the server needs —
 *  for spatial pane navigation). Reported up on resize. */
function reportViewport() {
  if (!port || !hostEl) return;
  const r = hostEl.getBoundingClientRect();
  port.postMessage({ type: MSG.PANE_VIEWPORT, rect: { width: r.width, height: r.height } });
}

/** The C-x pane chords the client recognises locally only to give snappy
 *  feedback; they are ALSO forwarded as keys (the server's keymap is
 *  authoritative). We forward every key and let the server decide. */
function dispatchKey(key) {
  if (!port) return true;
  port.postMessage({ type: MSG.INTENT, intent: { id: nextIntentId++, kind: INTENT.KEY, key } });
  return true;
}

window.addEventListener('keydown', (event) => {
  // Let the focused leaf's view handle its own editing keys via its onKey
  // (which calls dispatchKey); this top-level listener only catches keys when
  // no view is focused (e.g. right after a layout change).
  const key = keyEventToString(event);
  if (!key) return;
  // The leaf views capture their own keydowns; this is the fallback path.
  if (document.activeElement && document.activeElement.closest('.mwb-pane')) return;
  event.preventDefault();
  dispatchKey(key);
});

window.addEventListener('resize', () => { reportViewport(); relayout(); });

// --- mirrors + leaf views ----------------------------------------------

/** Get/create the shared mirror for BUFFERID, seeded from a snapshot payload. */
function ensureMirror(bufferId, seed) {
  let mirror = mirrors.get(bufferId);
  if (!mirror && seed) {
    mirror = createClientBuffer({
      initialText: seed.text ?? '',
      name: seed.name || 'mwb',
      point: 0,
      sendIntent: (intent) => { if (port) port.postMessage({ type: MSG.INTENT, intent }); },
    });
    mirrors.set(bufferId, mirror);
  }
  return mirror;
}

/** Mount a real view for a leaf over its buffer's mirror. */
function mountLeaf(leaf) {
  const el = document.createElement('div');
  el.className = 'mwb-pane';
  el.tabIndex = 0;
  el.style.position = 'absolute';
  hostEl.appendChild(el);
  const mirror = mirrors.get(leaf.bufferId);
  if (!mirror) {
    // No mirror yet — the server's per-buffer SNAPSHOT will arrive and we
    // re-mount; for now show an empty host so layout is correct.
    leafEls.set(leaf.id, { el, view: null, bufferId: leaf.bufferId });
    return;
  }
  const view = createEditorView(mirror, el, {
    onKey: dispatchKey,
    highlighters,
    foldCaptures,
    getPoint: () => (leaf.id === focusedLeafId ? mirror.point : (leaf.point ?? 0)),
    getMark: () => mirror.mark,
    getCursors: () => mirror.cursors,
    getDecorations: () => mirror.decorations,
    getMajorModeName: () => null,
    onRenderError: (e) => console.error('[mwb-pane] render error:', e),
  });
  leafEls.set(leaf.id, { el, view, bufferId: leaf.bufferId });
}

/** Tear down a leaf that vanished from the tree (a delete / delete-others). */
function unmountLeaf(id) {
  const entry = leafEls.get(id);
  if (!entry) return;
  try { if (entry.view) entry.view.destroy(); } catch { /* ignore */ }
  if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
  leafEls.delete(id);
}

/** Re-position every mounted leaf's element to its computed pixel rect, draw
 *  the focus border, and focus the focused leaf. The PURE layout drives it. */
function relayout() {
  if (!paneTree || !hostEl) return;
  const r = hostEl.getBoundingClientRect();
  const { leafRects, focusedId } = layoutPaneTree(paneTree, {
    width: r.width, height: r.height,
  });
  focusedLeafId = focusedId;
  for (const [id, entry] of leafEls) {
    const rect = leafRects.get(id);
    if (!rect) continue;
    entry.el.style.left = `${rect.left}px`;
    entry.el.style.top = `${rect.top}px`;
    entry.el.style.width = `${rect.width}px`;
    entry.el.style.height = `${rect.height}px`;
    entry.el.classList.toggle('mwb-pane--focused', id === focusedId);
    try { if (entry.view) entry.view.relayout && entry.view.relayout(); } catch { /* ignore */ }
  }
  // Put DOM focus in the focused leaf so its view captures keys.
  const focused = leafEls.get(focusedId);
  if (focused) {
    if (focused.view && focused.view.focus) focused.view.focus();
    else focused.el.focus();
  }
}

/** Apply a fresh PANE_TREE: diff the leaves, mount/unmount, then relayout.
 *  Mounting a leaf whose buffer mirror isn't synced yet defers to the
 *  per-buffer SNAPSHOT (onSnapshot re-mounts the placeholder). */
function onPaneTree(tree) {
  paneTree = tree;
  const { mount, unmount } = diffPaneLeaves(tree, leafEls.keys());
  for (const id of unmount) unmountLeaf(id);
  for (const leaf of mount) mountLeaf(leaf);
  // Request a snapshot of any buffer we don't have a mirror for yet.
  for (const leaf of mount) {
    if (!mirrors.has(leaf.bufferId) && port) {
      // The HELLO snapshot covers the initial buffer; for new buffers the
      // server sends a SNAPSHOT on switch. Nothing to request here — the
      // server pushes them. We just relayout once mirrors arrive.
    }
  }
  relayout();
}

// --- the wire ----------------------------------------------------------

function onSnapshot(msg) {
  const bufferId = msg.bufferId || 'b0';
  ensureMirror(bufferId, { text: msg.text, name: msg.name });
  const mirror = mirrors.get(bufferId);
  if (mirror && typeof msg.point === 'number') mirror.point = msg.point;
  // Re-mount any leaf on this buffer that was mounted without a mirror.
  if (paneTree) {
    for (const [id, entry] of [...leafEls]) {
      if (entry.bufferId === bufferId && !entry.view) {
        unmountLeaf(id);
        const leaf = findLeaf(paneTree, id);
        if (leaf) mountLeaf(leaf);
      }
    }
    relayout();
  }
  setStatus(`mounted ${leafEls.size} pane(s) over ${mirrors.size} buffer(s) — C-x 2 / 3 split, C-x o cycle, C-x 0 delete`);
}

function findLeaf(node, id) {
  if (!node) return null;
  if (node.kind === 'leaf') return node.id === id ? node : null;
  return findLeaf(node.first, id) || findLeaf(node.second, id);
}

/** A per-buffer delta from the server: apply it to that buffer's mirror; every
 *  pane on the buffer re-renders (they share the mirror). */
function onDelta(delta) {
  // The harness routes deltas to the mirror of the buffer the FOCUSED pane
  // edits (the server tags fan-out per buffer; in this single-window harness
  // the focused buffer is the edited one). A production client keys deltas by
  // the message's buffer id; the spike's DELTA omits it, so we use focus.
  const focused = leafEls.get(focusedLeafId);
  const mirror = focused ? mirrors.get(focused.bufferId) : null;
  if (mirror && typeof mirror.applyDelta === 'function') {
    mirror.applyDelta(delta, { echoed: false });
  }
}

function onMessage(event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case MSG.SNAPSHOT: onSnapshot(msg); break;
    case MSG.PANE_TREE: onPaneTree(msg.tree); break;
    case MSG.DELTA: onDelta(msg.delta); break;
    case MSG.VIEW: /* per-pane modeline render deferred in the harness */ break;
    default: break;
  }
}

// --- boot --------------------------------------------------------------

async function boot() {
  try {
    const loaded = await loadLanguageHighlighters();
    highlighters = loaded.highlighters || {};
    foldCaptures = loaded.foldCaptures || {};
  } catch (e) {
    console.error('[mwb-pane] highlighter load failed:', e);
  }
  setLink('connecting…', 'warn');
}

// The preload posts the server MessagePort over a window message (the same
// path view-client.js uses).
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'mwb:port' && event.ports[0]) {
    port = event.ports[0];
    port.onmessage = onMessage;
    port.start();
    port.postMessage({ type: MSG.HELLO });
    reportViewport();
    setLink('connected ✓', 'good');
  }
});

boot();
