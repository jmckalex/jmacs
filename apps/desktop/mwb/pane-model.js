/**
 * @file Model-B pane/window model — the server-side LOGICAL pane tree (G0a).
 *
 * This is the structural piece the graduation plan flags as the one
 * remaining UNBOUNDED cost (`plans/MWB-GRADUATION.md` §0, §8.1, §12): the
 * pane/window geometry negotiation. Everything proven so far has been *one
 * view in one window*; the real app interleaves the logical pane tree and
 * the pixel layout across ~1000 lines of app.js (`:653-1610`). G0a separates
 * the two: the SERVER owns the logical tree (which buffer shows in which
 * leaf, the split structure, the focused leaf), and the CLIENT owns the
 * pixels (how wide each split is, where the splitter sits).
 *
 * What this module is: a per-window pane tree built from the REAL
 * `@editor/pane` package (the binary split tree — copy-on-write
 * `replacePane`, `parentOf`/`siblingOf`, `insertAtRootBorder`, the pure
 * `computeRects` layout math), wrapped in the host PRIMITIVES the real
 * `panes.lisp` commands call: `split-horizontal!`, `split-vertical!`,
 * `delete-pane!`, `delete-other-panes!`, `other-pane!`, `current-pane`,
 * `current-view`, `balance-panes!`, `swap-panes!`, `panes-in-spiral-order`,
 * `focus-pane-direction!`. Because the commands are loaded VERBATIM from
 * disk (the same `panes.lisp` the production editor runs), this proves the
 * split/other/delete commands graduate with no Lisp change — only the host
 * primitives differ (no DOM, no pixels).
 *
 * The hard-won finding (see architect-notes.md "geometry-cost"): the leaf
 * holds a tiny VIEW-STATE record — `{ bufferId, point, mark, scrollLine }`
 * — NOT a renderer view. The buffer text lives once in the registry; a leaf
 * only references it by id and keeps its own cursor/scroll. Two leaves can
 * show the SAME buffer (shared text, independent point), exactly the
 * same-buffer-two-windows case but within one window. A SPLIT carries a
 * `ratio` (a fraction, the *intended* relative size); NO pixels live here.
 *
 * DOM-free, Electron-free, interpreter-free: it takes the focused buffer id
 * from the spine and emits plain-data snapshots, so it is unit-testable
 * under `node --test` (pane-model.test.js).
 */

import {
  createLeafPane,
  createSplitPane,
  leafPanes,
  replacePane,
  parentOf,
  siblingOf,
  insertAtRootBorder,
  swapLeaves,
  spiralOrder,
  computeRects,
  SPLIT_HORIZONTAL,
  SPLIT_VERTICAL,
} from '@editor/pane';

import { paneInDirection } from '../../../packages/pane/src/navigation.js';
import { serializePaneTree } from './protocol.js';

/**
 * The per-leaf view-state a pane holds. The buffer's TEXT is not here — only
 * a reference (`bufferId`) plus this pane's own cursor + scroll over it. So
 * two leaves on the same buffer share text and diverge in point/scroll.
 *
 * @typedef {object} LeafState
 * @property {string|null} bufferId - The registry buffer this leaf shows.
 * @property {object|null} view - The real per-leaf view (an @editor/view) the
 *   buffer's cursor binds to, so this pane keeps its own point/mark over the
 *   shared text. Minted by the injected `makeView` factory; null in pure
 *   structural tests (which only assert tree shape). The leaf's point/mark
 *   read through `view.point`/`view.mark` when a view is present, else the
 *   plain `point`/`mark` fields below.
 * @property {number} point - This pane's cursor offset (used when no view is
 *   bound — the structural-only test path).
 * @property {number|null} mark - This pane's selection anchor, or null.
 * @property {number} scrollLine - This pane's first-visible line (saved scroll).
 */

/**
 * Create a per-window pane model.
 *
 * @param {object} options
 * @param {string|null} options.initialBufferId - The buffer the window's
 *   single leaf starts on.
 * @param {object} [hooks]
 * @param {() => void} [hooks.onChange] - Called whenever the tree or focus
 *   changes (a split / delete / focus move / swap), so the server can push a
 *   fresh PANE_TREE. Debounce-free; the server coalesces if it wants.
 * @param {(bufferId: string|null) => string} [hooks.nameForBuffer] - Resolve
 *   a buffer id to its display name (the leaf's modeline label in the wire
 *   snapshot). Defaults to the id.
 * @returns {PaneModel}
 */
export function createPaneModel(options = {}, hooks = {}) {
  const onChange = typeof hooks.onChange === 'function' ? hooks.onChange : () => {};
  const nameForBuffer = typeof hooks.nameForBuffer === 'function'
    ? hooks.nameForBuffer
    : (id) => (id == null ? 'scratch' : String(id));
  // The per-leaf view factory: mint a real @editor/view over BUFFERID so the
  // buffer's cursor can bind to it (this leaf's own point/mark over shared
  // text). Injected so the structural-only tests can omit it (and assert tree
  // shape with the plain point/mark fields). When present, a leaf's point/mark
  // route through `view.point`/`view.mark`.
  const makeView = typeof hooks.makeView === 'function' ? hooks.makeView : null;

  // G4 Step 3b: read a buffer's TEXT (for the wire snapshot). A pane showing a
  // DIFFERENT buffer than the focused one is rendered by the client as a static
  // pane from this text (same-buffer panes use the live shared mirror). Injected
  // from the spine (which owns the registry); absent in structural-only tests.
  const textForBuffer = typeof hooks.textForBuffer === 'function'
    ? hooks.textForBuffer
    : () => null;

  // G4 Step 3c: per-buffer TAB metadata for a tabline leaf's curated tab strip
  // (the client renders one tab per id with its name + dirty flag + path).
  // Injected from the spine (the registry); a structural-only test falls back to
  // the name resolver, no dirty/path.
  const tabMeta = typeof hooks.tabMeta === 'function'
    ? hooks.tabMeta
    : (id) => ({ name: nameForBuffer(id), modified: false, filePath: null });

  // A monotonically-increasing STABLE per-leaf view key. A leaf keeps the
  // same key for its whole life, so when it switches buffers and switches
  // back, the view factory can return the SAME view (cursor preserved in that
  // pane for that buffer — the "switch away and back keeps the cursor" case).
  let nextViewKey = 0;
  function freshViewKey() {
    const k = `vk-${nextViewKey}`;
    nextViewKey += 1;
    return k;
  }

  /** Build a fresh leaf-state over BUFFERID (minting its view if a factory is
   *  wired). SEED copies point/scroll from a source state (a split). The leaf
   *  gets a stable `viewKey` the factory keys its view by. */
  function freshState(bufferId, seed) {
    const viewKey = freshViewKey();
    const view = makeView ? makeView(bufferId ?? null, viewKey) : null;
    const state = {
      bufferId: bufferId ?? null,
      viewKey,
      view,
      // Step 3c: whether this leaf presents as a TABLINE — a container of
      // EXPLICITLY-CURATED tabs (like a flag-off tabline-view's `tabs` array),
      // NOT "the window's buffer set". A tab joins only because it was restored
      // here or the user put it here (toggle-tabline seeds one tab = bufferId;
      // a switch while the leaf is focused adds one). `tabs` is the ordered list
      // of tab buffer ids (the active one is this leaf's `bufferId`); null when
      // the leaf is a single view. The client renders a tabline leaf as a
      // tabline-view of exactly these tabs.
      tabline: false,
      tabs: null,
      point: 0,
      mark: null,
      scrollLine: 0,
    };
    if (seed) {
      state.scrollLine = seed.scrollLine ?? 0;
      const p = seed.view ? seed.view.point : seed.point;
      if (view) { view.point = p ?? 0; } else { state.point = p ?? 0; }
    }
    return state;
  }

  /** Read a leaf-state's point (through its view when bound). */
  function statePoint(s) {
    return s.view ? s.view.point : s.point;
  }

  /** Read a leaf-state's mark (through its view when bound). */
  function stateMark(s) {
    return s.view ? (s.view.mark ?? null) : s.mark;
  }

  // The leaf-state map: leaf pane id → LeafState. Kept beside the tree (not
  // on the leaf node) so the @editor/pane structural ops — which re-create
  // split nodes on the copy-on-write path but reuse LEAF nodes by reference —
  // don't have to carry our payload. A leaf node's `.view` field DOES point
  // at its state too (so `current-view` can return a stable handle), but the
  // map is the source of truth keyed by id (survives a tree rebuild).
  /** @type {Map<string, LeafState>} */
  const stateById = new Map();

  /** Mint a leaf pane over BUFFERID with a fresh state, registered in the map.
   *  The leaf's `.view` is a thin handle the Lisp `current-view` returns. */
  function makeLeaf(bufferId, seedState) {
    const state = seedState ?? freshState(bufferId);
    const leaf = createLeafPane({ view: { kind: 'text', get bufferId() { return state.bufferId; } } });
    state.bufferId = bufferId ?? state.bufferId ?? null;
    stateById.set(leaf.id, state);
    return leaf;
  }

  // The window's root pane (a binary split tree). Starts as one leaf.
  let rootPane = makeLeaf(options.initialBufferId ?? null);
  /** The focused leaf's id (which pane the keyboard drives). */
  let focusedId = rootPane.id;

  /** The focused leaf pane object, or null (defends against a stale id). */
  function focusedLeaf() {
    for (const leaf of leafPanes(rootPane)) {
      if (leaf.id === focusedId) return leaf;
    }
    // Focus drifted (a delete removed the focused leaf without re-homing):
    // fall back to the first leaf so the model is never focus-less.
    const first = leafPanes(rootPane)[0] ?? null;
    if (first) focusedId = first.id;
    return first;
  }

  /** The LeafState of the focused leaf (the cursor/scroll the active client
   *  edits). Always defined — the model always has at least one leaf. */
  function focusedState() {
    const leaf = focusedLeaf();
    return leaf ? stateById.get(leaf.id) : freshState(null);
  }

  /** Drop state records for any leaf no longer in the tree (after a delete /
   *  delete-others). Keeps `stateById` from leaking. */
  function pruneOrphanState() {
    const live = new Set(leafPanes(rootPane).map((l) => l.id));
    for (const id of [...stateById.keys()]) {
      if (!live.has(id)) stateById.delete(id);
    }
  }

  // --- the structural operations (the model half of panes.lisp) --------

  /**
   * Split the focused leaf along ORIENTATION. The new leaf becomes the
   * sibling and shows the SAME buffer as the originating leaf (Emacs's
   * `split-window` semantics: the new window shows the same buffer; its
   * point is seeded from the originating pane's). Focus MOVES to the new
   * leaf (matching production `splitPaneAtLeaf`). With SIDE='after' (default)
   * the new leaf is the second child (right/below); 'before' makes it first.
   *
   * @param {'horizontal'|'vertical'} orientation
   * @param {number} ratio - The split ratio (first child's fraction).
   * @param {'after'|'before'} [side='after']
   * @returns {object|null} The new leaf pane, or null on a bad arg.
   */
  function split(orientation, ratio, side = 'after') {
    if (orientation !== SPLIT_HORIZONTAL && orientation !== SPLIT_VERTICAL) {
      return null;
    }
    const target = focusedLeaf();
    if (!target) return null;
    const srcState = stateById.get(target.id);
    // The new leaf shows the same buffer; seed its point/scroll from the
    // source so the split "looks the same" until the user moves (Emacs).
    const newState = freshState(srcState ? srcState.bufferId : null, srcState ?? undefined);
    const newLeaf = makeLeaf(newState.bufferId, newState);
    const r = typeof ratio === 'number' && ratio > 0 && ratio < 1 ? ratio : 0.5;
    const splitNode = side === 'before'
      ? createSplitPane({ orientation, ratio: 1 - r, first: newLeaf, second: target })
      : createSplitPane({ orientation, ratio: r, first: target, second: newLeaf });
    rootPane = replacePane(rootPane, target, splitNode);
    focusedId = newLeaf.id; // focus moves to the new pane
    onChange();
    return newLeaf;
  }

  /**
   * Delete the focused leaf — collapse its parent split into its sibling.
   * No-op when the focused leaf is the root (the only pane). Focus follows:
   * if the deleted leaf held focus, the sibling subtree's first leaf takes
   * over. Mirrors production `deletePaneInTree` (logical half only).
   *
   * @returns {boolean} Whether a pane was deleted.
   */
  function deletePane() {
    const target = focusedLeaf();
    if (!target) return false;
    const parent = parentOf(rootPane, target);
    if (!parent) return false; // the root leaf — nothing to collapse into.
    const sibling = siblingOf(rootPane, target);
    if (!sibling) return false;
    rootPane = replacePane(rootPane, parent, sibling);
    // Focus the sibling subtree's first leaf (the deleted leaf is gone).
    const survivor = leafPanes(sibling)[0] ?? leafPanes(rootPane)[0] ?? null;
    if (survivor) focusedId = survivor.id;
    pruneOrphanState();
    onChange();
    return true;
  }

  /**
   * Make the focused leaf fill the whole window — drop every other leaf.
   * No-op when the focused leaf is already the root. Mirrors production
   * `deleteOtherPanesInTree`.
   *
   * @returns {boolean} Whether the layout collapsed to a single pane.
   */
  function deleteOtherPanes() {
    const target = focusedLeaf();
    if (!target || rootPane === target) return false;
    rootPane = target;
    focusedId = target.id;
    pruneOrphanState();
    onChange();
    return true;
  }

  /**
   * Cycle focus to the next leaf in display order (Emacs `other-window`,
   * C-x o). No-op (returns the current leaf) with a single pane. Returns the
   * newly-focused leaf.
   *
   * @returns {object} The focused leaf after cycling.
   */
  function otherPane() {
    const leaves = leafPanes(rootPane);
    if (leaves.length <= 1) return focusedLeaf();
    const i = leaves.findIndex((l) => l.id === focusedId);
    const next = leaves[(Math.max(0, i) + 1) % leaves.length];
    focusedId = next.id;
    onChange();
    return next;
  }

  /** Focus a specific leaf by id (a client click). Returns true on success. */
  function focusPane(id) {
    const leaf = leafPanes(rootPane).find((l) => l.id === id);
    if (!leaf) return false;
    if (focusedId === leaf.id) return true;
    focusedId = leaf.id;
    onChange();
    return true;
  }

  /**
   * Reset every split node's ratio to 0.5 (Emacs `balance-windows`). The
   * tree is structurally shared; ratios are mutable fields, so we walk and
   * write in place (matching production `balancePanesInTree`).
   */
  function balancePanes() {
    walkBalance(rootPane);
    onChange();
  }

  function walkBalance(node) {
    if (!node || node.kind !== 'split') return;
    node.ratio = 0.5;
    walkBalance(node.first);
    walkBalance(node.second);
  }

  /**
   * Swap which buffer two panes show (the views trade places, the frames
   * stay). The panes keep their ids/sizes; only their LeafStates exchange.
   * Used by `swap-panes!` (swap-with-other-pane / swap-views). Pass leaf
   * pane objects (the `current-pane` / other-pane handles).
   *
   * @param {object} leafA
   * @param {object} leafB
   * @returns {boolean}
   */
  function swapPanes(leafA, leafB) {
    if (!leafA || !leafB || leafA.id === leafB.id) return false;
    const a = stateById.get(leafA.id);
    const b = stateById.get(leafB.id);
    if (!a || !b) return false;
    // Exchange the state records (and re-point the leaf `.view` handles).
    stateById.set(leafA.id, b);
    stateById.set(leafB.id, a);
    onChange();
    return true;
  }

  /**
   * Set a split node's ratio in place (a client splitter drag echoed up). The
   * client owns the pixels; this records the user's chosen fraction so the
   * logical tree (and the session) stays in sync. Clamped to a sane band.
   *
   * @param {string} splitId - The split node's id.
   * @param {number} ratio - The first child's new fraction.
   * @returns {boolean}
   */
  function setSplitRatio(splitId, ratio) {
    const node = findSplitById(rootPane, splitId);
    if (!node) return false;
    const r = typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 0.5;
    node.ratio = Math.min(0.95, Math.max(0.05, r));
    onChange();
    return true;
  }

  function findSplitById(node, id) {
    if (!node || node.kind !== 'split') return null;
    if (node.id === id) return node;
    return findSplitById(node.first, id) ?? findSplitById(node.second, id);
  }

  // --- spatial navigation (needs the client's host rectangle) ----------
  //
  // This is the ONE operation whose decision genuinely needs client pixels:
  // "the pane to the left of the focused one" depends on where the panes ARE
  // on screen, which depends on the split ratios AND the window size. The
  // server computes adjacency from `computeRects` over a host rectangle the
  // CLIENT reports (the geometry finding's crux). With no reported rectangle
  // we fall back to a unit square (correct topology for non-degenerate
  // layouts; only ties on a square viewport differ from the live pixels).

  /** The last host rectangle a client reported, for spatial navigation. */
  let hostRect = { left: 0, top: 0, width: 1000, height: 1000 };

  /** Record the client's editor-area pixel rectangle (a VIEWPORT-style report,
   *  the measurement conversation's hard direction for panes). */
  function setHostRect(rect) {
    if (!rect || typeof rect !== 'object') return;
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (Number.isFinite(width) && width > 0) hostRect.width = width;
    if (Number.isFinite(height) && height > 0) hostRect.height = height;
    hostRect.left = Number.isFinite(rect.left) ? rect.left : 0;
    hostRect.top = Number.isFinite(rect.top) ? rect.top : 0;
  }

  /**
   * Focus the leaf adjacent to the focused one in DIRECTION
   * ('left'/'right'/'up'/'down'), computed from the reported host rectangle.
   * No-op (returns false) when there's no neighbour on that side. Mirrors
   * production `focusPaneByDirection` — the one geometry-coupled command.
   *
   * @param {'left'|'right'|'up'|'down'} direction
   * @returns {boolean}
   */
  function focusPaneDirection(direction) {
    const rects = computeRects(rootPane, {
      left: 0, top: 0, width: hostRect.width, height: hostRect.height,
    });
    const targetId = paneInDirection(rects, focusedId, direction);
    if (targetId === null) return false;
    return focusPane(targetId);
  }

  /** The leaves in clockwise-spiral badge order (for swap-views/permute-views;
   *  panes-in-spiral-order). Geometry-derived, so it uses the host rect. */
  function panesInSpiralOrder() {
    const { ordered } = spiralOrder(rootPane, {
      left: 0, top: 0, width: hostRect.width, height: hostRect.height,
    });
    return ordered;
  }

  // --- per-leaf view-state (the active client edits the focused leaf) ---

  /** The focused leaf's buffer id (which buffer the keyboard edits). */
  function focusedBufferId() {
    return focusedState().bufferId;
  }

  /** Point the focused leaf at BUFFERID (a buffer switch in this pane). Re-mints
   *  the leaf's view over the new buffer (so its cursor binds to fresh text). */
  function setFocusedBuffer(bufferId) {
    const state = focusedState();
    if (state.bufferId === bufferId) return;
    state.bufferId = bufferId ?? null;
    // Step 3c: a switch WHILE the focused leaf is a tabline ADDS a tab to THAT
    // tabline (and makes it active) — it doesn't replace the leaf's only view.
    // A find-file in a single-view pane just replaces what it shows (tabs null).
    if (state.tabline && Array.isArray(state.tabs) && state.bufferId != null
        && !state.tabs.includes(state.bufferId)) {
      state.tabs.push(state.bufferId);
    }
    if (makeView) {
      // Reuse the leaf's STABLE view key so the registry returns the SAME view
      // this pane last had on this buffer (cursor preserved across a switch
      // away and back); a never-before-shown buffer gets a fresh view at 0.
      state.view = makeView(state.bufferId, state.viewKey);
    } else {
      state.point = 0;
      state.mark = null;
    }
    state.scrollLine = 0;
    onChange();
  }

  /** Toggle (or set) whether the FOCUSED leaf presents as a tabline (Step 3c).
   *  Turning ON seeds the curated tab set with EXACTLY the leaf's current buffer
   *  (one tab); turning OFF drops the tab set (back to a single view on the same
   *  buffer). Returns the new state. */
  function toggleFocusedTabline(on) {
    const state = focusedState();
    state.tabline = on === undefined ? !state.tabline : !!on;
    if (state.tabline) {
      state.tabs = state.bufferId != null ? [state.bufferId] : [];
    } else {
      state.tabs = null;
    }
    onChange();
    return state.tabline;
  }

  /** Close a tab in the FOCUSED tabline leaf — remove BUFFERID from its curated
   *  tab set (the buffer itself lives on in the pool; this un-curates it from
   *  THIS tabline only). Closing the active tab re-points the leaf to a
   *  neighbour (re-minting its view). Refuses to empty the tabline (a pane must
   *  always show something), and is a no-op on a non-tabline leaf or an absent
   *  tab. Returns whether a tab was removed. */
  function closeFocusedTab(bufferId) {
    const state = focusedState();
    if (!state.tabline || !Array.isArray(state.tabs)) return false;
    const idx = state.tabs.indexOf(bufferId);
    if (idx < 0) return false;
    if (state.tabs.length <= 1) return false; // never empty a tabline
    state.tabs.splice(idx, 1);
    if (state.bufferId === bufferId) {
      // The active tab went away — activate the previous tab (or the first).
      state.bufferId = state.tabs[Math.max(0, idx - 1)] ?? null;
      if (makeView) {
        state.view = makeView(state.bufferId, state.viewKey);
      } else {
        state.point = 0;
        state.mark = null;
      }
      state.scrollLine = 0;
    }
    onChange();
    return true;
  }

  /** Reorder a tab in the FOCUSED tabline leaf — move the tab at FROM to TO
   *  (drag-reorder). The ACTIVE tab is tracked by buffer id (not index), so its
   *  identity is unchanged; only the curated order shifts. No-op on a non-tabline
   *  leaf or out-of-range / equal indices. Returns whether the order changed. */
  function reorderFocusedTab(from, to) {
    const state = focusedState();
    if (!state.tabline || !Array.isArray(state.tabs)) return false;
    const n = state.tabs.length;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
    const [moved] = state.tabs.splice(from, 1);
    state.tabs.splice(to, 0, moved);
    onChange();
    return true;
  }

  /** Read the focused leaf's view-state (point/mark/scroll). */
  function focusedViewState() {
    const s = focusedState();
    return {
      bufferId: s.bufferId,
      view: s.view,
      point: statePoint(s),
      mark: stateMark(s),
      scrollLine: s.scrollLine,
    };
  }

  /** The focused leaf's bound view (the @editor/view the buffer's cursor binds
   *  to), or null when no view factory is wired (the structural-test path). */
  function focusedView() {
    return focusedState().view;
  }

  /** Write the focused leaf's point/mark (after an edit/motion on it). Routes
   *  through the bound view when present. */
  function setFocusedPoint(point, mark) {
    const s = focusedState();
    if (s.view) {
      if (Number.isFinite(point)) s.view.point = Math.max(0, Math.floor(point));
      if (mark === null || Number.isFinite(mark)) {
        s.view.mark = mark === null ? null : Math.max(0, Math.floor(mark));
      }
      return;
    }
    if (Number.isFinite(point)) s.point = Math.max(0, Math.floor(point));
    if (mark === null || Number.isFinite(mark)) {
      s.mark = mark === null ? null : Math.max(0, Math.floor(mark));
    }
  }

  /** Save the focused leaf's first-visible line (a scroll-settle report). */
  function setFocusedScroll(line) {
    const s = focusedState();
    if (Number.isFinite(line)) s.scrollLine = Math.max(0, Math.floor(line));
  }

  // --- the wire snapshot ------------------------------------------------

  /**
   * Serialise the window's pane tree to the PANE_TREE wire shape (structure +
   * per-leaf buffer/view-state + the focused leaf). No pixels — the client
   * derives those. The leaf-data resolver reads each leaf's LeafState.
   *
   * @returns {import('./protocol.js').WirePaneNode}
   */
  function snapshot() {
    const focusedBufferId = stateById.get(focusedId)?.bufferId ?? null;
    return serializePaneTree(rootPane, focusedId, (leaf) => {
      const s = stateById.get(leaf.id);
      if (!s) return { bufferId: null };
      const data = {
        bufferId: s.bufferId,
        name: nameForBuffer(s.bufferId),
        point: statePoint(s),
        mark: stateMark(s),
        scrollLine: s.scrollLine,
      };
      if (s.tabline) {
        // Step 3c: render as a tabline-view of EXACTLY this leaf's curated tabs.
        // Carry each tab's display metadata (name / dirty flag / path) so the
        // client builds the strip without a separate buffer-list round-trip.
        data.tabline = true;
        data.tabs = (s.tabs ?? []).map((id) => {
          const meta = tabMeta(id) || {};
          return {
            bufferId: id,
            name: typeof meta.name === 'string' ? meta.name : nameForBuffer(id),
            modified: !!meta.modified,
            filePath: meta.filePath ?? null,
          };
        });
      }
      // Carry the TEXT only for a leaf showing a DIFFERENT buffer than the
      // focused one (Step 3b): the client renders those as static panes. A
      // same-buffer (or the focused) leaf uses the live shared mirror, so its
      // text would be redundant payload — omit it.
      if (s.bufferId != null && s.bufferId !== focusedBufferId) {
        const text = textForBuffer(s.bufferId);
        if (typeof text === 'string') data.text = text;
      }
      return data;
    });
  }

  /** @typedef {object} PaneModel */
  return {
    // structural ops (the model half of panes.lisp)
    split,
    deletePane,
    deleteOtherPanes,
    otherPane,
    focusPane,
    balancePanes,
    swapPanes,
    setSplitRatio,
    focusPaneDirection,
    panesInSpiralOrder,
    // geometry input (the one place client pixels reach the model)
    setHostRect,
    // focused-leaf accessors
    focusedLeaf,
    get focusedId() { return focusedId; },
    focusedBufferId,
    setFocusedBuffer,
    focusedViewState,
    focusedView,
    setFocusedPoint,
    setFocusedScroll,
    toggleFocusedTabline,
    closeFocusedTab,
    reorderFocusedTab,
    // introspection (for tests + the server)
    leaves: () => leafPanes(rootPane),
    leafCount: () => leafPanes(rootPane).length,
    get root() { return rootPane; },
    snapshot,
    // expose the state map for a leaf (tests / server)
    stateOf: (id) => stateById.get(id) ?? null,
  };
}
