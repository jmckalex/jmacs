/**
 * @file Pane primitives — the Lisp surface for addressing panes.
 *
 * Phase 2 of plans/PANES.md introduces the pane abstraction: a
 * rectangular tile in the editor area that holds one view. Phase 3a
 * (this file's expanded surface) adds the split / delete / navigate
 * constructors so users can carve the editor area into multiple panes.
 *
 * Phase 3b adds tabline-view primitives: a tabline-view is a
 * structural view that wraps several leaf-kind views into a tab
 * strip + content area inside a pane (see plans/PANES-PHASE-3B.md).
 *
 * The host (the desktop app) supplies a `paneHost` shape with:
 *
 *   - `currentPane()` — the focused pane handle (a leaf), or null.
 *   - `splitHorizontal(pane, ratio)` — replaces PANE with a horizontal
 *     split node; returns `{ first, second }` — both leaves.
 *   - `splitVertical(pane, ratio)` — likewise, vertical orientation.
 *   - `deletePane(pane)` — collapses PANE's parent split into PANE's
 *     sibling. No-op when PANE is the root.
 *   - `deleteOtherPanes(pane)` — makes PANE fill the whole editor area.
 *   - `otherPane()` — cycle focus to the next leaf in display order;
 *     returns the new current pane handle.
 *   - `focusPaneDirection(direction)` — focus the leaf adjacent to the
 *     current one in DIRECTION (`'left'`/`'right'`/`'up'`/`'down'`).
 *     Returns the new current pane handle, or `null` when no
 *     neighbour exists.
 *   - `balancePanes()` — reset every split node's ratio to 0.5.
 *   - `setSplitRatio(pane, ratio)` — set PANE's ratio (PANE must be a
 *     split node). Clamped to `[0.05, 0.95]`.
 *   - `currentTabline()` — the tabline-view in the focused pane, or
 *     null when the pane holds a plain-leaf view.
 *   - `promoteToTabline(pane)` — wrap PANE's view in a fresh
 *     tabline-view (no-op when it's already a tabline-view; returns
 *     the existing tabline in that case). Returns the tabline-view.
 *   - `demoteTabline(tlv)` — replace TLV (which must be installed on
 *     a leaf) with its active child's view. Returns the surviving
 *     view.
 *   - `addTab(tlv, view, index)` — splice VIEW into TLV's `tabs` at
 *     INDEX (default: end). Returns the tabline-view.
 *   - `removeTab(tlv, index)` — remove the tab at INDEX from TLV.
 *     Adjusts `active`. Returns the tabline-view. Does *not* kill
 *     the removed view from the global view list — that's
 *     `kill-view!`'s job.
 *   - `activateTab(tlv, index)` — make INDEX the active tab. Returns
 *     the tabline-view.
 *   - `setTablineEdge(tlv, edge)` — change which pane edge TLV's
 *     strip renders on (`'top'` / `'bottom'` / `'left'` / `'right'`).
 *     Returns the tabline-view.
 *
 * `(current-view)`, defined in view-primitives.js, resolves through
 * `(current-pane)` → `pane.view`, peeling through any tabline-view
 * to its active child (the phase-3b focus-resolution shift).
 *
 * Per Q15, pane-creating commands return handles. The split
 * constructors return `(first-handle second-handle)` so a Lisp caller
 * can immediately compose against either leaf.
 */

import { cons, NIL, keyword } from '@editor/lisp';
import { createView, isTablineView } from '@editor/view';

/** The ratio range a split is clamped to so both children stay visible. */
const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;

/** Default ratio for a fresh split (50/50). */
const DEFAULT_RATIO = 0.5;

/** Clamp RATIO to `[MIN_RATIO, MAX_RATIO]`. Anything non-numeric or NaN
 *  falls back to `DEFAULT_RATIO`. */
function clampRatio(ratio) {
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) return DEFAULT_RATIO;
  if (ratio < MIN_RATIO) return MIN_RATIO;
  if (ratio > MAX_RATIO) return MAX_RATIO;
  return ratio;
}

/** Pull an explicit ratio from a primitive's args, or the default. */
function ratioFromArgs(args) {
  if (args.length === 0) return DEFAULT_RATIO;
  const raw = args[0];
  if (raw === NIL || raw === null || raw === undefined) return DEFAULT_RATIO;
  return clampRatio(Number(raw));
}

/** Resolve PANE_OR_NIL to a pane handle: when nil/missing, fall back to
 *  the focused pane. Returns null when nothing is current. */
function resolvePaneArg(args, paneHost) {
  const raw = args[0];
  if (raw === undefined || raw === null || raw === NIL) {
    return paneHost.currentPane();
  }
  if (typeof raw === 'object' && raw !== null && typeof raw.kind === 'string') {
    return raw;
  }
  return null;
}

/**
 * Build the pane primitives for a pane-host.
 *
 * @param {PaneHost} paneHost
 * @returns {Record<string, (args: *[]) => *>}
 */
export function createPanePrimitives(paneHost) {
  return {
    // `(current-pane)` — the focused leaf pane's handle. `nil` when no
    // pane has focus (vanishingly rare; the editor area always has at
    // least one leaf).
    'current-pane': () => {
      const pane = paneHost.currentPane();
      return pane ?? NIL;
    },
    // `(pane-kind pane)` — the pane's kind as a string. Either `"leaf"`
    // or `"split"` for a well-formed handle.
    'pane-kind': (args) => {
      const pane = args[0];
      if (pane === null || pane === undefined || pane === NIL) return NIL;
      if (typeof pane !== 'object') return NIL;
      return typeof pane.kind === 'string' ? pane.kind : NIL;
    },
    // `(pane-view pane)` — the view a leaf pane holds, or `nil` for a
    // split pane (which holds no view directly) or a malformed handle.
    'pane-view': (args) => {
      const pane = args[0];
      if (pane === null || pane === undefined || pane === NIL) return NIL;
      if (typeof pane !== 'object') return NIL;
      if (pane.kind !== 'leaf') return NIL;
      return pane.view ?? NIL;
    },

    // --- split / delete / navigate -------------------------------------
    // Phase 3a: the user-facing pane surface.

    // `(split-horizontal! [ratio])` — replace the current leaf with a
    // horizontal split node (side-by-side). The originating leaf stays
    // focused as the *first* child (left), the new leaf becomes the
    // *second* (right). Returns `(left-handle . right-handle)` as a
    // proper list `(left right)` per Q15.
    'split-horizontal!': (args) => {
      const pane = paneHost.currentPane();
      if (pane === null) return NIL;
      const ratio = ratioFromArgs(args);
      const result = paneHost.splitHorizontal(pane, ratio);
      if (!result) return NIL;
      return cons(result.first, cons(result.second, NIL));
    },
    // `(split-vertical! [ratio])` — likewise, vertical orientation
    // (top-and-bottom). Originating leaf is the *first* (top) child.
    'split-vertical!': (args) => {
      const pane = paneHost.currentPane();
      if (pane === null) return NIL;
      const ratio = ratioFromArgs(args);
      const result = paneHost.splitVertical(pane, ratio);
      if (!result) return NIL;
      return cons(result.first, cons(result.second, NIL));
    },
    // `(delete-pane! [pane])` — collapse PANE's parent split into PANE's
    // sibling. No-op on the root-only-leaf case. PANE defaults to
    // `(current-pane)`. Returns nil.
    'delete-pane!': (args) => {
      const pane = resolvePaneArg(args, paneHost);
      if (pane === null) return NIL;
      paneHost.deletePane(pane);
      return NIL;
    },
    // `(delete-other-panes! [pane])` — make PANE fill the whole editor
    // area, disposing every other leaf. PANE defaults to `(current-pane)`.
    // Returns nil.
    'delete-other-panes!': (args) => {
      const pane = resolvePaneArg(args, paneHost);
      if (pane === null) return NIL;
      paneHost.deleteOtherPanes(pane);
      return NIL;
    },
    // `(other-pane!)` — cycle focus to the next leaf in display order
    // (depth-first). Returns the new current pane handle, or nil when
    // there's only one pane. The bang follows the side-effecting
    // convention used by `next-view!` etc.; the Lisp `(defcommand
    // other-pane …)` in panes.lisp wraps it as the interactive
    // command bound to `C-x o`.
    'other-pane!': () => {
      const pane = paneHost.otherPane();
      return pane ?? NIL;
    },
    // `(focus-pane-direction! direction)` — focus the leaf adjacent to
    // the current one in DIRECTION (a symbol or string: 'left', 'right',
    // 'up', 'down'). Returns the new current pane handle, or nil when
    // there's no neighbour in that direction.
    'focus-pane-direction!': (args) => {
      const raw = args[0];
      let direction;
      if (typeof raw === 'string') direction = raw;
      else if (raw && typeof raw === 'object' && typeof raw.name === 'string') {
        direction = raw.name; // a Sym
      } else direction = null;
      if (
        direction !== 'left' &&
        direction !== 'right' &&
        direction !== 'up' &&
        direction !== 'down'
      ) {
        return NIL;
      }
      const pane = paneHost.focusPaneDirection(direction);
      return pane ?? NIL;
    },
    // `(balance-panes!)` — reset every split node's ratio to 0.5.
    // Returns nil.
    'balance-panes!': () => {
      paneHost.balancePanes();
      return NIL;
    },
    // `(set-split-ratio! pane ratio)` — set PANE's ratio (PANE must be
    // a split node). The value is clamped to `[0.05, 0.95]`. Returns
    // nil.
    'set-split-ratio!': (args) => {
      const pane = args[0];
      const ratio = args[1];
      if (
        pane === null || pane === undefined || pane === NIL ||
        typeof pane !== 'object' || pane.kind !== 'split'
      ) {
        return NIL;
      }
      paneHost.setSplitRatio(pane, clampRatio(Number(ratio)));
      return NIL;
    },

    // --- tabline-view primitives ----------------------------------------
    // Phase 3b: see plans/PANES-PHASE-3B.md.

    // `(current-tabline)` — the tabline-view in the focused pane, or
    // nil when the pane's view is a plain leaf-kind view. Symmetric
    // with `(current-pane)`.
    'current-tabline': () => {
      if (typeof paneHost.currentTabline !== 'function') return NIL;
      const tlv = paneHost.currentTabline();
      return tlv ?? NIL;
    },
    // `(promote-to-tabline! [pane])` — wrap PANE's view in a fresh
    // tabline-view (the view becomes the sole tab; the tabline becomes
    // PANE's new view). When PANE is omitted, defaults to the focused
    // pane. Returns the tabline-view handle; nil when promotion isn't
    // possible (no pane, host lacks the method).
    'promote-to-tabline!': (args) => {
      if (typeof paneHost.promoteToTabline !== 'function') return NIL;
      const pane = resolvePaneArg(args, paneHost);
      if (pane === null) return NIL;
      const tlv = paneHost.promoteToTabline(pane);
      return tlv ?? NIL;
    },
    // `(demote-tabline! [tlv])` — replace the tabline-view with its
    // active child's view on whatever leaf it sits in. When TLV is
    // omitted, defaults to `(current-tabline)`. Returns the surviving
    // view (the active child), or nil when demotion isn't possible.
    'demote-tabline!': (args) => {
      if (typeof paneHost.demoteTabline !== 'function') return NIL;
      let tlv = args[0];
      if (tlv === undefined || tlv === null || tlv === NIL) {
        tlv = typeof paneHost.currentTabline === 'function'
          ? paneHost.currentTabline()
          : null;
      }
      if (!isTablineView(tlv)) return NIL;
      const survivor = paneHost.demoteTabline(tlv);
      return survivor ?? NIL;
    },
    // `(make-tabline-view tabs edge)` — construct a fresh tabline-view
    // *handle* without attaching it to any pane. The caller passes
    // TABS as a Lisp list of view handles and EDGE as a symbol or
    // string (`'top`, `'bottom`, `'left`, `'right` — anything else
    // defaults to `'top`). Active is 0. The result is a view handle
    // suitable for passing to `(add-tab!)` etc., or for assigning to
    // a pane via host code.
    'make-tabline-view': (args) => {
      const tabsArg = args[0];
      const edgeArg = args[1];
      // Accept either a Lisp list (cons-cell chain ending in NIL) or
      // a JS array — Lisp callers will pass lists; host-side callers
      // (and tests) may pass arrays for convenience.
      let tabs;
      if (Array.isArray(tabsArg)) {
        tabs = tabsArg.slice();
      } else if (tabsArg === NIL || tabsArg === null || tabsArg === undefined) {
        tabs = [];
      } else if (
        typeof tabsArg === 'object' && tabsArg !== null && 'head' in tabsArg
      ) {
        tabs = [];
        let node = tabsArg;
        while (node && node !== NIL && 'head' in node) {
          tabs.push(node.head);
          node = node.tail;
        }
      } else {
        tabs = [];
      }
      const edge = coerceEdge(edgeArg) ?? 'top';
      return createView({
        kind: 'tabline',
        extras: { tabs, active: 0, edge },
      });
    },
    // `(add-tab! tlv view [index])` — splice VIEW into TLV's tabs at
    // INDEX (default: end). Returns TLV. Errors silently (returns
    // nil) when TLV isn't a tabline-view.
    'add-tab!': (args) => {
      const tlv = args[0];
      const view = args[1];
      const indexRaw = args[2];
      if (!isTablineView(tlv) || !view) return NIL;
      const index =
        typeof indexRaw === 'number' && Number.isFinite(indexRaw)
          ? indexRaw
          : undefined;
      if (typeof paneHost.addTab !== 'function') return NIL;
      paneHost.addTab(tlv, view, index);
      return tlv;
    },
    // `(remove-tab! tlv index)` — remove the tab at INDEX from TLV.
    // Adjusts active. Does *not* kill the removed view from the
    // global view list (that's `kill-view!`). Returns TLV.
    'remove-tab!': (args) => {
      const tlv = args[0];
      const indexRaw = args[1];
      if (!isTablineView(tlv)) return NIL;
      if (typeof indexRaw !== 'number' || !Number.isFinite(indexRaw)) return tlv;
      if (typeof paneHost.removeTab !== 'function') return tlv;
      paneHost.removeTab(tlv, indexRaw);
      return tlv;
    },
    // `(activate-tab! tlv index)` — make INDEX the active tab.
    // Returns TLV.
    'activate-tab!': (args) => {
      const tlv = args[0];
      const indexRaw = args[1];
      if (!isTablineView(tlv)) return NIL;
      if (typeof indexRaw !== 'number' || !Number.isFinite(indexRaw)) return tlv;
      if (typeof paneHost.activateTab !== 'function') return tlv;
      paneHost.activateTab(tlv, indexRaw);
      return tlv;
    },
    // `(move-tab! src-tlv src-idx dst-tlv [dst-idx])` — splice the tab
    // at SRC-IDX in SRC-TLV out and into DST-TLV at DST-IDX (defaults
    // to the end). The moved view becomes the destination's active
    // tab. SRC and DST may be the same tabline (collapses to a
    // reorder). The view is NOT killed from the global list — it just
    // changes which strip it belongs to. Returns DST-TLV.
    'move-tab!': (args) => {
      const srcTlv = args[0];
      const srcIdxRaw = args[1];
      const dstTlv = args[2];
      const dstIdxRaw = args[3];
      if (!isTablineView(srcTlv) || !isTablineView(dstTlv)) return NIL;
      if (typeof srcIdxRaw !== 'number' || !Number.isFinite(srcIdxRaw)) return dstTlv;
      const dstIdx =
        typeof dstIdxRaw === 'number' && Number.isFinite(dstIdxRaw)
          ? dstIdxRaw
          : undefined;
      if (typeof paneHost.moveTab !== 'function') return dstTlv;
      paneHost.moveTab(srcTlv, srcIdxRaw, dstTlv, dstIdx);
      return dstTlv;
    },
    // `(swap-panes! pane-a pane-b)` — exchange the views that PANE-A
    // and PANE-B show. Both must be leaf-pane handles. A tabline-view
    // moves as a whole (tabs and all). Returns #t when the swap
    // happened, #f for a no-op (same pane, missing handle, or a
    // non-leaf passed in).
    'swap-panes!': (args) => {
      const a = args[0];
      const b = args[1];
      if (typeof paneHost.swapPanes !== 'function') return false;
      return paneHost.swapPanes(a, b) === true;
    },
    // `(tabline-active tlv)` — the active tab's index, or nil when
    // TLV isn't a tabline-view (or is empty).
    'tabline-active': (args) => {
      const tlv = args[0];
      if (!isTablineView(tlv)) return NIL;
      if (!Array.isArray(tlv.tabs) || tlv.tabs.length === 0) return NIL;
      return typeof tlv.active === 'number' ? tlv.active : 0;
    },
    // `(tabline-tabs tlv)` — TLV's tabs as a Lisp list of view
    // handles, or nil when TLV isn't a tabline-view.
    'tabline-tabs': (args) => {
      const tlv = args[0];
      if (!isTablineView(tlv)) return NIL;
      const list = Array.isArray(tlv.tabs) ? tlv.tabs : [];
      // Build a Lisp list from the JS array.
      let acc = NIL;
      for (let i = list.length - 1; i >= 0; i -= 1) acc = cons(list[i], acc);
      return acc;
    },
    // `(tabline-edge tlv)` — return TLV's edge as a keyword
    // (`:top`/`:bottom`/`:left`/`:right`), or nil when TLV isn't a
    // tabline-view.
    'tabline-edge': (args) => {
      const tlv = args[0];
      if (!isTablineView(tlv)) return NIL;
      const edge = typeof tlv.edge === 'string' ? tlv.edge : 'top';
      return keyword(edge);
    },
    // `(set-tabline-edge! tlv edge)` — change TLV's edge.
    // EDGE is a symbol/string/keyword; anything other than one of the
    // four valid values is silently ignored (TLV is returned
    // unchanged). Returns TLV.
    'set-tabline-edge!': (args) => {
      const tlv = args[0];
      const edgeArg = args[1];
      if (!isTablineView(tlv)) return NIL;
      const edge = coerceEdge(edgeArg);
      if (edge === null) return tlv;
      if (typeof paneHost.setTablineEdge !== 'function') return tlv;
      paneHost.setTablineEdge(tlv, edge);
      return tlv;
    },
  };
}

/** Coerce EDGEARG (a string, a Sym, a Keyword) to a canonical edge
 *  string (`'top'` / `'bottom'` / `'left'` / `'right'`), or null when
 *  EDGEARG isn't recognisable as one of the four valid edges. */
function coerceEdge(edgeArg) {
  let raw = null;
  if (typeof edgeArg === 'string') raw = edgeArg;
  else if (
    edgeArg && typeof edgeArg === 'object' &&
    typeof edgeArg.name === 'string'
  ) {
    raw = edgeArg.name; // Sym or Keyword (both carry a .name)
  }
  if (raw === null) return null;
  // Strip a leading colon for keyword-like arguments.
  if (raw.startsWith(':')) raw = raw.slice(1);
  if (raw === 'top' || raw === 'bottom' || raw === 'left' || raw === 'right') {
    return raw;
  }
  return null;
}

/**
 * @typedef {import('@editor/pane').Pane} Pane
 * @typedef {import('@editor/view').View} View
 *
 * @typedef {object} PaneHost
 * @property {() => (Pane | null)} currentPane - The currently-focused
 *   pane handle (a leaf), or null.
 * @property {(pane: Pane, ratio: number) => ({first: Pane, second: Pane} | null)} [splitHorizontal]
 * @property {(pane: Pane, ratio: number) => ({first: Pane, second: Pane} | null)} [splitVertical]
 * @property {(pane: Pane) => void} [deletePane]
 * @property {(pane: Pane) => void} [deleteOtherPanes]
 * @property {() => (Pane | null)} [otherPane]
 * @property {(direction: 'left'|'right'|'up'|'down') => (Pane | null)} [focusPaneDirection]
 * @property {() => void} [balancePanes]
 * @property {(pane: Pane, ratio: number) => void} [setSplitRatio]
 * @property {() => (View | null)} [currentTabline]
 * @property {(pane: Pane) => (View | null)} [promoteToTabline]
 * @property {(tlv: View) => (View | null)} [demoteTabline]
 * @property {(tlv: View, view: View, index?: number) => View} [addTab]
 * @property {(tlv: View, index: number) => View} [removeTab]
 * @property {(tlv: View, index: number) => View} [activateTab]
 * @property {(tlv: View, edge: 'top'|'bottom'|'left'|'right') => View} [setTablineEdge]
 */
