/**
 * @file Persistent session — serialise the editor's pane tree (with
 * its tabline-view membership) and restore it on next startup, so a
 * quit-and-relaunch lands the user back where they left off, with the
 * same splits, the same tabs in each tabline-view, and the same active
 * tab + focused pane.
 *
 * Schema v2 (plans/PANES-PHASE-3B.md, commit 6). The on-disk shape:
 *
 *   {
 *     "version": 2,
 *     "rootPane": <pane-blob>,
 *     "currentPaneId": <string | null>
 *   }
 *
 * Pane-blob:
 *
 *   { "kind": "leaf",  "id": "...", "view": <view-blob | null> }
 *   { "kind": "split", "id": "...", "orientation": "horizontal" | "vertical",
 *     "ratio": <number>, "first": <pane-blob>, "second": <pane-blob> }
 *
 * View-blob (one per leaf, or one per tab inside a tabline-view):
 *
 *   { "kind": "text",    "path": "/abs/path", "point": <int>, "mark": <int|null> }
 *   { "kind": "tabline", "edge": "top"|"right"|"bottom"|"left",
 *     "active": <int>, "tabs": [<view-blob>, ...] }
 *
 * Non-text leaf views (image, audio, video, shell, customize, doc,
 * directory-*) are ephemeral — they don't survive a relaunch. The
 * serialiser emits `null` for them; on restore the owning pane falls
 * back to `*scratch*` per the brief's "Non-text views stay ephemeral"
 * rule.
 *
 * Backwards compatibility. The reader recognises the older v1 shape
 *
 *   { "buffers": [...], "currentPath": "..." }
 *
 * and transparently migrates it into v2: a single root leaf-pane
 * (id `pane-leaf-restored`) holding a top-edge tabline-view whose tabs
 * are the v1 buffer entries, with `active` derived from `currentPath`.
 * Writers always emit v2 — the v1 shape is read-only.
 *
 * Pane ids. Persisted ids are restored verbatim. The runtime id source
 * monotonically increases from 1 each launch; the chance of a collision
 * between a restored id and a freshly-minted one only matters if the
 * user creates splits during the same session whose ids overlap the
 * persisted ones. The freshId source skips ahead to one past any seen
 * id at install time to keep this safe.
 */

import { viewFilePath } from '@editor/view';

/**
 * @typedef {Object} SerialisedTextView
 * @property {'text'} kind
 * @property {string} path
 * @property {number} point
 * @property {number | null} mark
 *
 * @typedef {Object} SerialisedTablineView
 * @property {'tabline'} kind
 * @property {'top'|'right'|'bottom'|'left'} edge
 * @property {number} active
 * @property {SerialisedView[]} tabs
 *
 * @typedef {SerialisedTextView | SerialisedTablineView} SerialisedView
 *
 * @typedef {Object} SerialisedLeafPane
 * @property {'leaf'} kind
 * @property {string} id
 * @property {SerialisedView | null} view
 *
 * @typedef {Object} SerialisedSplitPane
 * @property {'split'} kind
 * @property {string} id
 * @property {'horizontal'|'vertical'} orientation
 * @property {number} ratio
 * @property {SerialisedPane} first
 * @property {SerialisedPane} second
 *
 * @typedef {SerialisedLeafPane | SerialisedSplitPane} SerialisedPane
 *
 * @typedef {Object} SerialisedSessionV2
 * @property {2} version
 * @property {SerialisedPane | null} rootPane
 * @property {string | null} currentPaneId
 *
 * @typedef {Object} SerialisedBufferV1
 * @property {string} path
 * @property {number} point
 * @property {number | null} mark
 *
 * @typedef {Object} SerialisedSessionV1
 * @property {SerialisedBufferV1[]} buffers
 * @property {string | null} currentPath
 */

/**
 * Is VIEW ephemeral — something the session should not save?
 * Ephemerals are: any non-text view (image, audio, video, shell,
 * jukebox, customize, doc, directory-tree, directory-columns), and
 * text views whose name marks them out as transient (`*scratch*`,
 * `*Buffer List*`, `*Jukebox: …*`, `*Eval log*`, `*Doc: …*`,
 * `*Customize: …*`, `*Occur: …*`).
 *
 * Tabline-views are structural — they're never "ephemeral"; the
 * serialiser visits their tabs.
 *
 * @param {{kind?: string, name?: string, buffer?: {filePath?: string}} | null | undefined} view
 * @returns {boolean}
 */
export function isEphemeral(view) {
  if (!view) return true;
  // Non-text views are always ephemeral — they hold their own state
  // (a directory path, a track list, a shell session id, ...) and
  // don't survive a relaunch.
  if (view.kind && view.kind !== 'text') return true;
  // A text view with no file path can't be reopened; nothing to save.
  const filePath = viewFilePath(view);
  if (typeof filePath !== 'string' || filePath === '') return true;
  // Names like *…* are by convention transient utility buffers.
  const name = view.name ?? '';
  if (name.startsWith('*') && name.endsWith('*')) return true;
  return false;
}

/**
 * Serialise a single view handle. Text views become text view-blobs;
 * tabline-views recurse into their `tabs`; everything else (non-text
 * leaf views) returns null so the caller can decide what to do (the
 * owning leaf falls back to `*scratch*` on restore).
 *
 * @param {*} view
 * @returns {SerialisedView | null}
 */
function serialiseView(view) {
  if (!view || typeof view !== 'object') return null;
  if (view.kind === 'tabline' && Array.isArray(view.tabs)) {
    const tabs = view.tabs.map(serialiseView).filter((t) => t !== null);
    const rawActive = typeof view.active === 'number' ? view.active : 0;
    // Clamp `active` against the surviving tabs — a non-text tab being
    // dropped from the serialised list mustn't leave `active` dangling.
    const active = tabs.length === 0
      ? 0
      : Math.max(0, Math.min(rawActive, tabs.length - 1));
    const blob = {
      kind: 'tabline',
      edge: typeof view.edge === 'string' ? view.edge : 'top',
      active,
      tabs,
    };
    if (typeof view.width === 'number' && Number.isFinite(view.width)) {
      blob.width = view.width;
    }
    return blob;
  }
  if (view.kind === 'text') {
    if (isEphemeral(view)) return null;
    const buffer = view.buffer;
    const point =
      typeof view.point === 'number'
        ? view.point
        : buffer && typeof buffer.point === 'number'
          ? buffer.point
          : 0;
    const mark =
      typeof view.mark === 'number'
        ? view.mark
        : buffer && typeof buffer.mark === 'number'
          ? buffer.mark
          : null;
    return { kind: 'text', path: viewFilePath(view), point, mark };
  }
  // File-backed media views persist their path; restore opens the path
  // through the same `openFileByPath` the dialog uses, which re-routes
  // to the matching kind. Audio/video/image are the file-opened set;
  // jukebox / shell / customize / doc stay ephemeral.
  if (view.kind === 'image' || view.kind === 'audio' || view.kind === 'video') {
    const path = typeof view.filePath === 'string' ? view.filePath : null;
    if (!path) return null;
    return { kind: view.kind, path };
  }
  // Directory views persist their rootPath. Restore goes through
  // `openByPath` (which dispatches on `kind` for directory-* and calls
  // `ensureDirectoryTreeViewForPath` / `ensureDirectoryColumnsViewForPath`
  // — same path the open primitive uses). Only the rootPath is
  // persisted; per-view interaction state (expanded folders, the
  // active column / preview path) is ephemeral and reset on restore.
  if (view.kind === 'directory-tree' || view.kind === 'directory-columns') {
    const path = typeof view.rootPath === 'string' ? view.rootPath : null;
    if (!path) return null;
    return { kind: view.kind, path };
  }
  // Other non-text views (jukebox/shell/customize/doc).
  return null;
}

/**
 * Serialise a pane node. Leaves get their view serialised (or null
 * when ephemeral); splits recurse into their children.
 *
 * @param {*} pane
 * @returns {SerialisedPane | null}
 */
function serialisePane(pane) {
  if (!pane || typeof pane !== 'object') return null;
  if (pane.kind === 'leaf') {
    return {
      kind: 'leaf',
      id: typeof pane.id === 'string' ? pane.id : 'pane-leaf',
      view: serialiseView(pane.view),
    };
  }
  if (pane.kind === 'split') {
    return {
      kind: 'split',
      id: typeof pane.id === 'string' ? pane.id : 'pane-split',
      orientation: pane.orientation === 'vertical' ? 'vertical' : 'horizontal',
      ratio: typeof pane.ratio === 'number' ? pane.ratio : 0.5,
      first: serialisePane(pane.first),
      second: serialisePane(pane.second),
    };
  }
  return null;
}

/**
 * Build the v2 session payload from the live pane tree.
 *
 * @param {*} rootPane
 * @param {string | null} currentPaneId
 * @returns {SerialisedSessionV2}
 */
export function serialiseTree(rootPane, currentPaneId) {
  return {
    version: 2,
    rootPane: serialisePane(rootPane),
    currentPaneId:
      typeof currentPaneId === 'string' && currentPaneId !== ''
        ? currentPaneId
        : null,
  };
}

/**
 * Legacy v1 serialiser — kept for the file-backed-text flat-view tests
 * that still exercise the "open buffer list" projection. Production
 * code paths emit v2 via `serialiseTree`.
 *
 * @param {import('@editor/view').View[]} views
 * @param {number} currentIndex
 * @returns {SerialisedSessionV1}
 */
export function serialise(views, currentIndex) {
  const keep = views.filter((view) => !isEphemeral(view));
  const serialised = keep.map((view) => {
    const buffer = view.buffer;
    const point =
      typeof view.point === 'number'
        ? view.point
        : buffer && typeof buffer.point === 'number'
          ? buffer.point
          : 0;
    const mark =
      typeof view.mark === 'number'
        ? view.mark
        : buffer && typeof buffer.mark === 'number'
          ? buffer.mark
          : null;
    return { path: viewFilePath(view), point, mark };
  });
  const current = views[currentIndex];
  const currentPath =
    current && !isEphemeral(current) ? viewFilePath(current) : null;
  return { buffers: serialised, currentPath };
}

/**
 * Parse a parsed-JSON session payload. Always returns a v2-shaped
 * object; a v1 input is migrated transparently (the flat buffer list
 * becomes a top-edge tabline-view on a single restored root leaf). A
 * missing / malformed input yields an empty v2 session with no
 * rootPane — the caller should treat that as "no session to restore"
 * and fall back to the default startup path.
 *
 * @param {unknown} raw
 * @returns {SerialisedSessionV2}
 */
export function deserialise(raw) {
  const empty = { version: 2, rootPane: null, currentPaneId: null };
  if (raw === null || typeof raw !== 'object') return empty;
  if (raw.version === 2) return parseV2(raw);
  // v1 detection: an object with a `buffers` array. (Earlier ad-hoc
  // payloads with neither shape collapse to the empty session — the
  // editor should never refuse to start because of a stray file.)
  if (Array.isArray(raw.buffers)) return migrateV1(raw);
  return empty;
}

/**
 * Migrate a v1 session blob into a v2 session: wrap the flat buffer
 * list into a top-edge tabline-view on a single root leaf, with
 * `active` set from the buffer index that matches v1's `currentPath`.
 * An empty buffer list yields an empty v2 session (so the caller falls
 * back to the same default-startup path as a missing session.json).
 *
 * @param {*} raw
 * @returns {SerialisedSessionV2}
 */
function migrateV1(raw) {
  const buffers = Array.isArray(raw.buffers) ? raw.buffers : [];
  const tabs = buffers
    .filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.path === 'string' &&
        entry.path !== ''
    )
    .map((entry) => ({
      kind: /** @type {'text'} */ ('text'),
      path: entry.path,
      point: Number.isFinite(entry.point) ? Number(entry.point) : 0,
      mark: Number.isFinite(entry.mark) ? Number(entry.mark) : null,
    }));
  if (tabs.length === 0) {
    return { version: 2, rootPane: null, currentPaneId: null };
  }
  const currentPath =
    typeof raw.currentPath === 'string' && raw.currentPath !== ''
      ? raw.currentPath
      : null;
  const activeIdx = currentPath === null
    ? 0
    : Math.max(0, tabs.findIndex((t) => t.path === currentPath));
  return {
    version: 2,
    rootPane: {
      kind: 'leaf',
      id: 'pane-leaf-restored',
      view: {
        kind: 'tabline',
        edge: 'top',
        active: activeIdx,
        tabs,
      },
    },
    currentPaneId: 'pane-leaf-restored',
  };
}

/**
 * Validate a v2 session blob: re-shape it through the same schema the
 * writer emits, dropping unknown / malformed branches. Returns the
 * empty session when the root pane is missing.
 *
 * @param {*} raw
 * @returns {SerialisedSessionV2}
 */
function parseV2(raw) {
  const rootPane = parsePane(raw.rootPane);
  const currentPaneId =
    typeof raw.currentPaneId === 'string' && raw.currentPaneId !== ''
      ? raw.currentPaneId
      : null;
  return { version: 2, rootPane, currentPaneId };
}

/**
 * Recursively validate a pane blob. Returns null on shape failure (the
 * caller decides whether to fall back to the empty-session path).
 *
 * @param {*} raw
 * @returns {SerialisedPane | null}
 */
function parsePane(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'leaf') {
    return {
      kind: 'leaf',
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'pane-leaf',
      view: parseView(raw.view),
    };
  }
  if (raw.kind === 'split') {
    const first = parsePane(raw.first);
    const second = parsePane(raw.second);
    if (!first || !second) return null;
    const orientation =
      raw.orientation === 'vertical' ? 'vertical' : 'horizontal';
    const rawRatio = typeof raw.ratio === 'number' ? raw.ratio : 0.5;
    // Clamp ratio into (0, 1); createSplitPane would throw on the edges.
    const ratio = Math.max(0.05, Math.min(0.95, rawRatio));
    return {
      kind: 'split',
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'pane-split',
      orientation,
      ratio,
      first,
      second,
    };
  }
  return null;
}

/**
 * Validate a view blob recursively. Returns null when the shape is
 * unknown (the leaf's pane falls back to `*scratch*` on restore).
 *
 * @param {*} raw
 * @returns {SerialisedView | null}
 */
function parseView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'text') {
    if (typeof raw.path !== 'string' || raw.path === '') return null;
    return {
      kind: 'text',
      path: raw.path,
      point: Number.isFinite(raw.point) ? Number(raw.point) : 0,
      mark: Number.isFinite(raw.mark) ? Number(raw.mark) : null,
    };
  }
  if (raw.kind === 'image' || raw.kind === 'audio' || raw.kind === 'video') {
    if (typeof raw.path !== 'string' || raw.path === '') return null;
    return { kind: raw.kind, path: raw.path };
  }
  if (raw.kind === 'tabline') {
    const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : [];
    const tabs = rawTabs.map(parseView).filter((t) => t !== null);
    const edge =
      raw.edge === 'top' || raw.edge === 'right' ||
      raw.edge === 'bottom' || raw.edge === 'left'
        ? raw.edge
        : 'top';
    const rawActive = typeof raw.active === 'number' ? raw.active : 0;
    const active = tabs.length === 0
      ? 0
      : Math.max(0, Math.min(rawActive, tabs.length - 1));
    const result = { kind: 'tabline', edge, active, tabs };
    if (typeof raw.width === 'number' && Number.isFinite(raw.width) && raw.width > 0) {
      result.width = raw.width;
    }
    return result;
  }
  return null;
}

/**
 * Build the editor-side session controller.
 *
 * The controller wraps the IPC boundary and the debounce timer, so the
 * rest of the app can just call `save()` (debounced) or `flush()`
 * (immediate), and `restore()` on startup.
 *
 * @param {Object} options
 * @param {() => *} options.getRootPane - The live pane tree root.
 * @param {() => string | null} options.getCurrentPaneId - The id of
 *   the focused pane.
 * @param {(path: string, entry: {point: number, mark: number | null}) =>
 *     Promise<* | null>}
 *   options.openByPath - Open a file by absolute path; called once per
 *   serialised text view during restore. Returns the view handle that
 *   was opened (with point/mark applied), or null when the open failed.
 * @param {(rootPane: *, currentPaneId: string | null) => void}
 *   options.installRootPane - Atomically install the restored pane tree
 *   onto the running editor. Called once after every text view has been
 *   opened. The handler is responsible for re-mounting the kindRegistry
 *   and refreshing layout.
 * @param {Object} options.host - Bridge with `readSession`/
 *   `writeSession` methods. Usually `window.host`.
 * @param {number} [options.debounceMs=500] - Save debounce delay.
 * @returns {{
 *   save: () => void,
 *   flush: () => Promise<void>,
 *   restore: () => Promise<void>,
 *   snapshot: () => SerialisedSessionV2
 * }}
 */
export function createSession({
  getRootPane,
  getCurrentPaneId,
  openByPath,
  installRootPane,
  host,
  debounceMs = 500,
}) {
  let timer = null;

  function snapshot() {
    return serialiseTree(
      typeof getRootPane === 'function' ? getRootPane() : null,
      typeof getCurrentPaneId === 'function' ? getCurrentPaneId() : null
    );
  }

  async function writeNow() {
    timer = null;
    try {
      await host.writeSession(snapshot());
    } catch {
      // A session-write failure is non-fatal: the editor keeps running,
      // the next save will try again.
    }
  }

  function save() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(writeNow, debounceMs);
  }

  async function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await writeNow();
  }

  async function restore() {
    let raw;
    try {
      raw = await host.readSession();
    } catch {
      return;
    }
    const data = deserialise(raw);
    if (!data.rootPane) return;
    // Materialise every serialised text view first so the pane tree we
    // hand to `installRootPane` is fully populated. The mapping
    // `path → view handle` lets a future tabline-view tab share the
    // same view across the tree (commit 6 doesn't have multi-pane-same-
    // view in the persisted shape; this is forward-looking and harmless).
    const viewBlobs = collectTextViewBlobs(data.rootPane);
    const handlesByBlob = new Map();
    for (const blob of viewBlobs) {
      try {
        // Pass the full blob — `openByPath` dispatches on `entry.kind`
        // to route directory blobs through the directory primitives
        // rather than `openFileByPath` (which is suffix-keyed).
        const view = await openByPath(blob.path, blob);
        if (view) handlesByBlob.set(blob, view);
      } catch {
        // Skip a file that fails to open — it may have been deleted.
      }
    }
    // Build the runtime pane tree from the serialised tree, threading
    // each text view-blob's handle into place. Tabline-views are
    // constructed from their serialised tabs; non-text leaves and tabs
    // that failed to open are dropped (tablines reflow their `active`,
    // a leaf with no view falls back to a fresh *scratch* the caller
    // creates).
    installRootPane(data.rootPane, data.currentPaneId ?? null, handlesByBlob);
  }

  return { save, flush, restore, snapshot };
}

/**
 * Walk a serialised pane tree and collect every file-backed view-blob
 * (text/image/audio/video) in encounter order. Tablines' tabs are
 * included; nested tablines are walked too. The restore loop opens
 * each path through `openByPath` (which dispatches to the matching
 * kind in app.js) and maps the resulting handle back via the blob.
 *
 * @param {SerialisedPane | null} pane
 * @returns {object[]}
 */
function collectTextViewBlobs(pane) {
  const out = [];
  function visitPane(p) {
    if (!p) return;
    if (p.kind === 'leaf') {
      visitView(p.view);
    } else if (p.kind === 'split') {
      visitPane(p.first);
      visitPane(p.second);
    }
  }
  function visitView(v) {
    if (!v) return;
    if (
      v.kind === 'text' || v.kind === 'image' ||
      v.kind === 'audio' || v.kind === 'video' ||
      v.kind === 'directory-tree' || v.kind === 'directory-columns'
    ) {
      out.push(v);
    } else if (v.kind === 'tabline') {
      for (const tab of v.tabs) visitView(tab);
    }
  }
  visitPane(pane);
  return out;
}
