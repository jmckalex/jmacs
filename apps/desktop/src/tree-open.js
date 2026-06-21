/**
 * @file Pure helper for routing a directory-tree file-open to the right
 * pane. A directory tree-view used as a sidebar (e.g. a project's left
 * pane) shouldn't open double-clicked files in its OWN pane — it should
 * open them in the main editing area. Given a description of the pane
 * tree's leaves, this picks the target leaf per the configured
 * `*directory-tree-open-target*`. Kept dependency-free so it can be
 * unit-tested directly; the host maps live panes to descriptors.
 *
 * Note the directory-tree (and other sidebars) are excluded as targets *by
 * kind*, so there's no need to special-case "the pane that was clicked":
 * in a project the tree is non-focusable, so the click leaves focus on the
 * editing tabline — which is exactly where the file should go, and which
 * the `currentId`-preference below selects.
 */

/** Pane kinds that are sidebars/companions — never an editing target. */
const SIDEBAR_KINDS = new Set([
  'directory-tree',
  'directory-columns',
  'bookmark',
  'minimap',
]);

/** Is LEAF a usable editing target? Judged by `kind` — the pane's *shown*
 *  content kind (the host peels a tabline to its active child first), so a
 *  tabline that's wrapping a directory-tree counts as the sidebar it shows,
 *  not as an editing tabline. `isTabline` is only the prefer-a-tabline
 *  tiebreak below. */
function isEditable(leaf) {
  return (
    !!leaf && typeof leaf.kind === 'string' && !SIDEBAR_KINDS.has(leaf.kind)
  );
}

/**
 * Choose the leaf id a directory-tree file-open should land in.
 *
 * @param {Array<{id: string, kind: string|null, isTabline: boolean}>} leaves
 *   The pane tree's leaves in document order. `kind` is the pane's *shown*
 *   content kind — the host peels a tabline to its active child — so a
 *   tabline wrapping a directory-tree has kind 'directory-tree'. `isTabline`
 *   marks a structural tabline leaf (the prefer-a-tabline tiebreak).
 * @param {string|null} currentId - The currently-focused leaf id. For
 *   `editing-pane` the file opens here when it's an editing pane (so it lands
 *   where the user is working); in a project that's the middle tabline (the
 *   tree sidebar is non-focusable, so focus stays on the tabline).
 * @param {string} target - The `*directory-tree-open-target*` value:
 *   'editing-pane' (default — the main editing area, preferring the current
 *   pane), or 'other-pane' (the next editing leaf after the current one).
 *   'this-pane' is handled by the caller and never reaches here.
 * @returns {string|null} The target leaf id, or null when there is no
 *   suitable editing leaf (the caller falls back to a split).
 */
export function pickEditingLeaf(leaves, currentId, target) {
  const list = Array.isArray(leaves) ? leaves : [];
  const editable = list.filter(isEditable);
  if (editable.length === 0) return null;

  if (target === 'other-pane') {
    const idx = list.findIndex((l) => l && l.id === currentId);
    const start = idx < 0 ? 0 : idx;
    for (let i = 1; i <= list.length; i += 1) {
      const cand = list[(start + i) % list.length];
      if (isEditable(cand) && cand.id !== currentId) return cand.id;
    }
    return editable[0].id;
  }

  // 'editing-pane' (and any unknown value): open in the current pane when
  // it's an editing pane (where the user is working — e.g. a project's
  // middle tabline), else prefer a tabline, else the first editable leaf.
  const current = editable.find((l) => l.id === currentId);
  if (current) return current.id;
  const tabline = editable.find((l) => l.isTabline === true);
  return (tabline ?? editable[0]).id;
}
