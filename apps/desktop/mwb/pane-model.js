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

  // Resolve a leaf's id to a non-text DATA-SOURCE descriptor (image/audio/video/
  // pdf), or null for a text buffer. When non-null, the snapshot renders the leaf
  // as that element-view (carrying `viewKind`/`filePath`/`state`) instead of text
  // — media has no cursor/text, so point/mark/scroll are omitted. Injected from
  // the spine (which owns the data-source registry); absent in structural tests.
  const mediaForBuffer = typeof hooks.mediaForBuffer === 'function'
    ? hooks.mediaForBuffer
    : () => null;

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

  // Minimap companions: target leaf id → its minimap leaf id. A minimap leaf is
  // a NON-FOCUSABLE companion (no buffer) held in a split beside its target; the
  // client binds its <minimap-view> to the target leaf's <text-view>. The server
  // owns only the structure (so it rides the PANE_TREE + survives a reconcile).
  /** @type {Map<string, string>} */
  const minimapByTarget = new Map();

  /** Whether LEAF is a minimap companion (its state carries a target leaf id). */
  function isMinimapLeaf(leaf) {
    const s = leaf ? stateById.get(leaf.id) : null;
    return !!(s && s.minimapTarget != null);
  }

  /** The leaves the keyboard can focus — every leaf except minimap companions. */
  function focusableLeaves() {
    return leafPanes(rootPane).filter((l) => !isMinimapLeaf(l));
  }

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
    // fall back to the first FOCUSABLE leaf so the model is never focus-less
    // (and never lands the keyboard on a minimap companion).
    const first = focusableLeaves()[0] ?? leafPanes(rootPane)[0] ?? null;
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
    // Drop minimap tracking whose target or minimap leaf is gone (e.g. C-x 1).
    for (const [targetId, mmId] of [...minimapByTarget]) {
      if (!live.has(targetId) || !live.has(mmId)) minimapByTarget.delete(targetId);
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
    // If the focused leaf carries a minimap companion, the node to remove is the
    // whole [target, minimap] split — so we never promote or strand the minimap.
    // When that split is the root, the target is the sole editing pane → no-op.
    let toRemove = target;
    if (minimapByTarget.has(target.id)) {
      const mmLeaf = leafPanes(rootPane).find((l) => l.id === minimapByTarget.get(target.id));
      const mmParent = mmLeaf ? parentOf(rootPane, mmLeaf) : null;
      if (mmParent) toRemove = mmParent;
    }
    const parent = parentOf(rootPane, toRemove);
    if (!parent) return false; // the root — nothing to collapse into.
    const sibling = siblingOf(rootPane, toRemove);
    if (!sibling) return false;
    rootPane = replacePane(rootPane, parent, sibling);
    // Focus a real editing leaf in the surviving subtree (never a minimap).
    const survivor = leafPanes(sibling).find((l) => !isMinimapLeaf(l))
      ?? leafPanes(sibling)[0] ?? leafPanes(rootPane)[0] ?? null;
    if (survivor) focusedId = survivor.id;
    minimapByTarget.delete(target.id);
    pruneOrphanState();
    onChange();
    return true;
  }

  // --- minimap companion (a non-focusable pane beside its target) -------

  /** Mint a non-focusable MINIMAP companion leaf for TARGETID on SIDE. It holds
   *  no buffer; the client binds its <minimap-view> to the target's <text-view>. */
  function makeMinimapLeaf(targetId, side) {
    const state = {
      bufferId: null,
      viewKey: freshViewKey(),
      view: null,
      tabline: false,
      tabs: null,
      point: 0,
      mark: null,
      scrollLine: 0,
      minimapTarget: targetId,
      minimapSide: side === 'left' ? 'left' : 'right',
    };
    const leaf = createLeafPane({ view: { kind: 'minimap' } });
    stateById.set(leaf.id, state);
    return leaf;
  }

  /** Remove TARGETID's minimap companion — collapse its [target, minimap] split
   *  back to the target. Caller fires onChange. Returns whether one was removed. */
  function removeMinimapFor(targetId) {
    const mmId = minimapByTarget.get(targetId);
    if (mmId == null) return false;
    minimapByTarget.delete(targetId);
    const mmLeaf = leafPanes(rootPane).find((l) => l.id === mmId);
    if (mmLeaf) {
      const parent = parentOf(rootPane, mmLeaf);
      const sibling = siblingOf(rootPane, mmLeaf);
      if (parent && sibling) rootPane = replacePane(rootPane, parent, sibling);
    }
    if (focusedId === mmId) focusedId = targetId;
    stateById.delete(mmId);
    return true;
  }

  /**
   * Toggle a MINIMAP companion beside the focused leaf. SIDE is 'left'|'right';
   * WIDTHFRACTION the minimap's share of the split (clamped 0.05–0.45). Attaching
   * wraps the focused leaf in a horizontal split with a non-focusable minimap leaf
   * — focus STAYS on the editor. A second call removes it. No-op on a minimap leaf
   * itself or a leaf that already has one being re-added. Returns whether the
   * minimap is now PRESENT.
   *
   * @param {'left'|'right'} side
   * @param {number} [widthFraction]
   * @returns {boolean}
   */
  function toggleFocusedMinimap(side, widthFraction) {
    const target = focusedLeaf();
    if (!target || isMinimapLeaf(target)) return false;
    if (minimapByTarget.has(target.id)) {
      removeMinimapFor(target.id);
      onChange();
      return false;
    }
    rootPane = replacePane(rootPane, target, makeMinimapSplit(target, side, widthFraction));
    onChange();
    return true;
  }

  /** Build a [target, minimap] split — the minimap on SIDE, FRACTION wide (its
   *  share of the split, clamped 0.05–0.45) — and register the companion. Returns
   *  the split node (the caller installs it in the tree). Shared by the toggle +
   *  session restore (loadLayout). */
  function makeMinimapSplit(targetLeaf, side, fraction) {
    const onLeft = side === 'left';
    const f = typeof fraction === 'number' && Number.isFinite(fraction)
      ? Math.min(0.45, Math.max(0.05, fraction))
      : 0.16;
    const mmLeaf = makeMinimapLeaf(targetLeaf.id, onLeft ? 'left' : 'right');
    const splitNode = onLeft
      ? createSplitPane({ orientation: SPLIT_HORIZONTAL, ratio: f, first: mmLeaf, second: targetLeaf })
      : createSplitPane({ orientation: SPLIT_HORIZONTAL, ratio: 1 - f, first: targetLeaf, second: mmLeaf });
    minimapByTarget.set(targetLeaf.id, mmLeaf.id);
    return splitNode;
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
    const leaves = focusableLeaves();
    if (leaves.length <= 1) return focusedLeaf();
    const i = leaves.findIndex((l) => l.id === focusedId);
    const next = leaves[(Math.max(0, i) + 1) % leaves.length];
    focusedId = next.id;
    onChange();
    return next;
  }

  /** Focus a specific leaf by id (a client click). Returns true on success.
   *  A minimap companion is never focusable (clicks on it navigate the editor). */
  function focusPane(id) {
    const leaf = leafPanes(rootPane).find((l) => l.id === id);
    if (!leaf || isMinimapLeaf(leaf)) return false;
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
    return ordered.filter((l) => !isMinimapLeaf(l)); // minimaps don't get a badge
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

  /** Seed the FOCUSED leaf as a tabline with a GIVEN curated tab set (the unify:
   *  window 1's restored session becomes a tabline leaf whose tabs are its open
   *  files, so it renders through the same pane pipeline as every other window).
   *  BUFFERIDS is the ordered tab list; ACTIVEID the active tab (defaults to the
   *  first). The active leaf's cursor is preserved when ACTIVEID already matches
   *  the leaf's buffer (the common restore case). No-op (returns false) on an
   *  empty list. Returns true when seeded. */
  function seedFocusedTabline(bufferIds, activeId) {
    const ids = Array.isArray(bufferIds) ? [...new Set(bufferIds.filter((id) => id != null))] : [];
    if (ids.length === 0) return false;
    const state = focusedState();
    state.tabline = true;
    state.tabs = ids;
    const active = ids.includes(activeId) ? activeId : ids[0];
    if (active !== state.bufferId) {
      state.bufferId = active;
      if (makeView) {
        state.view = makeView(active, state.viewKey);
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
      // A MINIMAP companion is structural only — no buffer/cursor. The client
      // mounts a <minimap-view> and binds it to its target leaf's <text-view>.
      if (s.minimapTarget != null) {
        return {
          viewKind: 'minimap',
          minimapTarget: s.minimapTarget,
          minimapSide: s.minimapSide ?? 'right',
        };
      }
      const data = {
        bufferId: s.bufferId,
        name: nameForBuffer(s.bufferId),
        point: statePoint(s),
        mark: stateMark(s),
        scrollLine: s.scrollLine,
      };
      if (s.tabline) {
        // Step 3c: render as a tabline-view of EXACTLY this leaf's curated tabs.
        // Carry each tab's display metadata (name / dirty flag / path / kind) so
        // the client builds the strip without a separate buffer-list round-trip.
        data.tabline = true;
        data.tabs = (s.tabs ?? []).map((id) => {
          const meta = tabMeta(id) || {};
          const tab = {
            bufferId: id,
            name: typeof meta.name === 'string' ? meta.name : nameForBuffer(id),
            modified: !!meta.modified,
            filePath: meta.filePath ?? null,
          };
          // A non-text (data-source) tab carries its kind so the client mounts
          // the right element-view / icons the tab.
          if (typeof meta.viewKind === 'string') tab.viewKind = meta.viewKind;
          return tab;
        });
      }
      // A non-text DATA-SOURCE leaf (image/audio/video/pdf): carry its descriptor
      // (viewKind + filePath + shared state) so the client mounts the matching
      // element-view and loads the bytes itself. Media has no text/cursor, so the
      // text/point payload below is skipped for it.
      const media = mediaForBuffer(s.bufferId);
      if (media) {
        data.viewKind = media.viewKind;
        data.filePath = media.filePath ?? null;
        if (media.state && Object.keys(media.state).length > 0) data.state = media.state;
      } else if (s.bufferId != null && s.bufferId !== focusedBufferId) {
        // Carry the TEXT only for a leaf showing a DIFFERENT buffer than the
        // focused one (Step 3b): the client renders those as static panes. A
        // same-buffer (or the focused) leaf uses the live shared mirror, so its
        // text would be redundant payload — omit it.
        const text = textForBuffer(s.bufferId);
        if (typeof text === 'string') data.text = text;
      }
      return data;
    });
  }

  // --- session persistence (serialise / restore the whole layout) -------
  //
  // Distinct from the wire `snapshot()` (which keys leaves by the process-local
  // `bufferId` the client mounts live): persistence keys every leaf by its
  // buffer's FILE PATH, the only identity that survives a relaunch. The focused
  // leaf is marked in-tree (`focused: true`) rather than by id — a reload mints
  // fresh leaf ids, so the old id is meaningless on the way back in.

  /** Serialise a leaf's view-state to a view-blob, or null when it can't be
   *  reopened (a path-less *scratch*, or every tab unresolved → the owning leaf
   *  restores to a fresh scratch). RESOLVESOURCE maps a buffer id to a
   *  `{ kind, path, pinned? }` descriptor (or null): `kind:'text'` for a text
   *  buffer; the DATA-SOURCE kind ('bookmark' / 'image' / 'pdf' / 'directory-*')
   *  for a non-text leaf — so restore reopens the right VIEW, not a text copy of
   *  the path. Only text carries a cursor; a bookmark carries its `pinned` flag. */
  function serialiseLeafView(state, resolveSource) {
    if (!state) return null;
    const blobFor = (id, withCursor) => {
      const src = resolveSource(id);
      if (!src || typeof src.path !== 'string' || src.path === '') return null;
      if (src.kind !== 'text') {
        const b = { kind: src.kind, path: src.path };
        if (typeof src.pinned === 'boolean') b.pinned = src.pinned; // bookmark pin
        return b;
      }
      // Only the ACTIVE buffer carries a live cursor; others restore at 0.
      return {
        kind: 'text',
        path: src.path,
        point: withCursor ? statePoint(state) : 0,
        mark: withCursor ? stateMark(state) : null,
      };
    };
    if (state.tabline && Array.isArray(state.tabs)) {
      const tabs = [];
      let active = 0;
      for (const id of state.tabs) {
        const isActive = id === state.bufferId;
        const blob = blobFor(id, isActive);
        if (!blob) continue; // drop unresolvable tabs
        if (isActive) active = tabs.length;
        tabs.push(blob);
      }
      if (tabs.length === 0) return null;
      return { kind: 'tabline', active, tabs };
    }
    const blob = blobFor(state.bufferId, true);
    if (blob && blob.kind === 'text') blob.scrollLine = state.scrollLine;
    return blob;
  }

  /**
   * Serialise the whole pane tree to a persistence blob (the session's
   * per-window `rootPane`). Splits carry `orientation` + `ratio`; leaves carry a
   * path-keyed view-blob (or null → a scratch on restore); the focused leaf is
   * tagged `focused: true`. Pure given RESOLVESOURCE (`bufferId -> { kind, path,
   * pinned? } | null` — see serialiseLeafView).
   *
   * @param {(bufferId: string|null) => ({kind: string, path: string, pinned?: boolean}|null)} resolveSource
   * @returns {object|null} The root pane-blob, or null for an empty tree.
   */
  function serialiseLayout(resolveSource) {
    const resolve = typeof resolveSource === 'function' ? resolveSource : () => null;
    function paneBlob(node) {
      if (!node || typeof node !== 'object') return null;
      if (node.kind === 'split') {
        // A [target, minimap] companion split: persist the minimap as a `minimap`
        // flag (side + fraction) on the TARGET leaf's blob — not a phantom,
        // path-less leaf — so restore re-attaches the companion (loadLayout's
        // buildPane). The companion split node itself isn't persisted.
        const mmFirst = isMinimapLeaf(node.first);
        const mmSecond = isMinimapLeaf(node.second);
        if (mmFirst || mmSecond) {
          const targetNode = mmFirst ? node.second : node.first;
          const mmNode = mmFirst ? node.first : node.second;
          const blob = paneBlob(targetNode);
          if (blob) {
            const ratio = typeof node.ratio === 'number' ? node.ratio : 0.16;
            blob.minimap = {
              side: stateById.get(mmNode.id)?.minimapSide ?? (mmFirst ? 'left' : 'right'),
              fraction: mmFirst ? ratio : 1 - ratio, // the minimap's own share
            };
          }
          return blob;
        }
        return {
          kind: 'split',
          orientation: node.orientation,
          ratio: typeof node.ratio === 'number' ? node.ratio : 0.5,
          first: paneBlob(node.first),
          second: paneBlob(node.second),
        };
      }
      const blob = { kind: 'leaf', view: serialiseLeafView(stateById.get(node.id), resolve) };
      if (node.id === focusedId) blob.focused = true;
      return blob;
    }
    return paneBlob(rootPane);
  }

  /**
   * Rebuild the window's pane tree from a persistence blob (the restore mirror
   * of `serialiseLayout`). Mints fresh leaves + states; resolves each leaf's
   * view-blob back to a live buffer/data-source id via RESOLVEID (which dispatches
   * on the blob's `kind` — a 'bookmark' blob creates/finds the outline, a text
   * blob resolves its path); a null/unresolved view becomes a *scratch* leaf.
   * Focus follows the `focused: true` tag (else the first leaf). Replaces the
   * current tree wholesale and prunes the orphaned states. Returns true when a
   * tree was installed.
   *
   * @param {object} blob - A root pane-blob from `serialiseLayout`.
   * @param {(viewBlob: object) => string|null} resolveId
   * @returns {boolean}
   */
  function loadLayout(blob, resolveId) {
    const resolve = typeof resolveId === 'function' ? resolveId : () => null;
    let nextFocusId = null;

    function buildLeaf(leafBlob) {
      const view = leafBlob && leafBlob.view;
      let bufferId = null;
      let tabline = false;
      let tabs = null;
      let point = 0;
      let mark = null;
      let scrollLine = 0;
      if (view && view.kind === 'text') {
        bufferId = resolve(view);
        point = Number.isFinite(view.point) ? view.point : 0;
        mark = view.mark == null ? null : (Number.isFinite(view.mark) ? view.mark : null);
        scrollLine = Number.isFinite(view.scrollLine) ? view.scrollLine : 0;
      } else if (view && view.kind === 'tabline' && Array.isArray(view.tabs)) {
        const ids = [];
        let activeId = null;
        view.tabs.forEach((tab, i) => {
          if (!tab) return;
          const id = resolve(tab);
          if (id == null) return;
          ids.push(id);
          if (i === view.active) {
            activeId = id;
            if (tab.kind === 'text') {
              point = Number.isFinite(tab.point) ? tab.point : 0;
              mark = tab.mark == null ? null : (Number.isFinite(tab.mark) ? tab.mark : null);
            }
          }
        });
        if (ids.length > 0) {
          tabline = true;
          tabs = ids;
          bufferId = activeId ?? ids[0];
        }
      } else if (view) {
        // A non-text single view (bookmark / media / directory): resolve the blob
        // to its data-source id; no cursor.
        bufferId = resolve(view);
      }
      const state = freshState(bufferId);
      state.tabline = tabline;
      state.tabs = tabs;
      state.scrollLine = scrollLine;
      if (state.view) {
        state.view.point = point;
        state.view.mark = mark;
      } else {
        state.point = point;
        state.mark = mark;
      }
      const leaf = makeLeaf(bufferId, state);
      if (leafBlob && leafBlob.focused) nextFocusId = leaf.id;
      return leaf;
    }

    function buildPane(node) {
      if (!node || typeof node !== 'object') return null;
      if (node.kind === 'split') {
        const first = buildPane(node.first);
        const second = buildPane(node.second);
        if (!first || !second) return first || second; // defensive: collapse a half-empty split
        const r = typeof node.ratio === 'number' && node.ratio > 0 && node.ratio < 1 ? node.ratio : 0.5;
        const orientation = node.orientation === SPLIT_VERTICAL ? SPLIT_VERTICAL : SPLIT_HORIZONTAL;
        return createSplitPane({ orientation, ratio: r, first, second });
      }
      if (node.kind === 'leaf') {
        const leaf = buildLeaf(node);
        // A persisted minimap companion: re-attach it to this restored target leaf.
        if (leaf && node.minimap && typeof node.minimap === 'object') {
          return makeMinimapSplit(leaf, node.minimap.side, node.minimap.fraction);
        }
        return leaf;
      }
      return null;
    }

    const newRoot = buildPane(blob);
    if (!newRoot) return false;
    rootPane = newRoot;
    focusedId = nextFocusId ?? (leafPanes(rootPane)[0]?.id ?? null);
    pruneOrphanState(); // drop the states of the leaves we replaced
    onChange();
    return true;
  }

  /** @typedef {object} PaneModel */
  return {
    // structural ops (the model half of panes.lisp)
    split,
    deletePane,
    deleteOtherPanes,
    otherPane,
    focusPane,
    toggleFocusedMinimap,
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
    seedFocusedTabline,
    // introspection (for tests + the server)
    leaves: () => leafPanes(rootPane),
    leafCount: () => leafPanes(rootPane).length,
    get root() { return rootPane; },
    snapshot,
    // session persistence (serialise the layout by path; restore it back)
    serialiseLayout,
    loadLayout,
    // expose the state map for a leaf (tests / server)
    stateOf: (id) => stateById.get(id) ?? null,
  };
}
