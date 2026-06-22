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
 * @property {number} point - This pane's cursor offset (per-pane window-state).
 * @property {number|null} mark - This pane's selection anchor, or null.
 * @property {number} scrollLine - This pane's first-visible line (saved scroll).
 */

/** Build a fresh leaf-state record over BUFFERID. */
function freshState(bufferId) {
  return { bufferId: bufferId ?? null, point: 0, mark: null, scrollLine: 0 };
}

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
    const newState = freshState(srcState ? srcState.bufferId : null);
    if (srcState) {
      newState.point = srcState.point;
      newState.scrollLine = srcState.scrollLine;
    }
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

  /** Point the focused leaf at BUFFERID (a buffer switch in this pane). */
  function setFocusedBuffer(bufferId) {
    const state = focusedState();
    if (state.bufferId === bufferId) return;
    state.bufferId = bufferId ?? null;
    state.point = 0;
    state.mark = null;
    state.scrollLine = 0;
    onChange();
  }

  /** Read the focused leaf's view-state (point/mark/scroll). */
  function focusedViewState() {
    const s = focusedState();
    return { bufferId: s.bufferId, point: s.point, mark: s.mark, scrollLine: s.scrollLine };
  }

  /** Write the focused leaf's point/mark (after an edit/motion on it). */
  function setFocusedPoint(point, mark) {
    const s = focusedState();
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
    return serializePaneTree(rootPane, focusedId, (leaf) => {
      const s = stateById.get(leaf.id) ?? freshState(null);
      return {
        bufferId: s.bufferId,
        name: nameForBuffer(s.bufferId),
        point: s.point,
        mark: s.mark,
        scrollLine: s.scrollLine,
      };
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
    setFocusedPoint,
    setFocusedScroll,
    // introspection (for tests + the server)
    leaves: () => leafPanes(rootPane),
    leafCount: () => leafPanes(rootPane).length,
    get root() { return rootPane; },
    snapshot,
    // expose the state map for a leaf (tests / server)
    stateOf: (id) => stateById.get(id) ?? null,
  };
}
