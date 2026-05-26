/**
 * @file Pane — public entry point.
 *
 * A pane is a rectangular tile in the editor area. The pane tree is
 * binary: split nodes have an orientation + a ratio in `[0, 1]`; leaves
 * hold one view each. The DOM mirrors only the leaves, flat under the
 * editor host, each absolute-positioned from the tree's layout.
 *
 * Phase 2 of `plans/PANES.md` exposes the leaf case in production (the
 * editor area becomes one leaf). The split kind exists in the data
 * model so phase 3's split commands land on it without touching the
 * constructors.
 */

export {
  createLeafPane,
  createSplitPane,
  isPane,
  isLeafPane,
  isSplitPane,
  PANE_KIND_LEAF,
  PANE_KIND_SPLIT,
  SPLIT_HORIZONTAL,
  SPLIT_VERTICAL,
} from './pane.js';

export {
  leafPanes,
  findPane,
  findPaneById,
  findLeafByViewId,
  replacePane,
  containsPane,
  leafCount,
} from './tree.js';

export {
  computeRects,
  splitRect,
} from './layout.js';
