/**
 * @file Pure helper for routing a directory-tree file-open to the right
 * pane. A directory tree-view used as a sidebar (e.g. a project's left
 * pane) shouldn't open double-clicked files in its OWN pane — it should
 * open them in the main editing area. Given a description of the pane
 * tree's leaves, this picks the target leaf per the configured
 * `*directory-tree-open-target*`. Kept dependency-free so it can be
 * unit-tested directly; the host maps live panes to descriptors.
 */

/** Pane kinds that are sidebars/companions — never an editing target. */
const SIDEBAR_KINDS = new Set([
  'directory-tree',
  'directory-columns',
  'bookmark',
  'minimap',
]);

/** Is LEAF a usable editing target (not the source, not a sidebar)? */
function isEditable(leaf, sourceId) {
  return (
    !!leaf &&
    leaf.id !== sourceId &&
    (leaf.isTabline === true ||
      (typeof leaf.kind === 'string' && !SIDEBAR_KINDS.has(leaf.kind)))
  );
}

/**
 * Choose the leaf id a directory-tree file-open should land in.
 *
 * @param {Array<{id: string, kind: string|null, isTabline: boolean}>} leaves
 *   The pane tree's leaves in document order. `kind` is the leaf view's kind
 *   (null when empty); `isTabline` marks a tabline leaf (an editing area).
 * @param {string|null} sourceId - The directory-tree's own leaf id (excluded
 *   as a target).
 * @param {string} target - The `*directory-tree-open-target*` value:
 *   'editing-pane' (default — the main editing area), or 'other-pane' (the
 *   next editing leaf after the source). 'this-pane' is handled by the caller
 *   and never reaches here.
 * @returns {string|null} The target leaf id, or null when there is no suitable
 *   editing leaf (the caller falls back to a split).
 */
export function pickEditingLeaf(leaves, sourceId, target) {
  const list = Array.isArray(leaves) ? leaves : [];
  const editable = list.filter((l) => isEditable(l, sourceId));
  if (editable.length === 0) return null;

  if (target === 'other-pane') {
    const idx = list.findIndex((l) => l && l.id === sourceId);
    const start = idx < 0 ? 0 : idx;
    for (let i = 1; i <= list.length; i += 1) {
      const cand = list[(start + i) % list.length];
      if (isEditable(cand, sourceId)) return cand.id;
    }
    return editable[0].id;
  }

  // 'editing-pane' (and any unknown value): prefer a tabline — the main
  // editing surface — else the first editable leaf in document order.
  const tabline = editable.find((l) => l.isTabline === true);
  return (tabline ?? editable[0]).id;
}
