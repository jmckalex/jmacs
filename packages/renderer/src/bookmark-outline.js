/**
 * @file Bookmark outline — the pure hierarchy logic behind the bookmark
 * view. Bookmarks are a flat, ordered list; each carries a `depth`
 * (indent level, default 0). A bookmark's children are the following
 * entries with greater depth; Tab / Shift-Tab indent/outdent a bookmark
 * together with its whole subtree, and a `collapsed` bookmark hides its
 * descendants. Pure (no DOM, no buffer) so it is unit-tested directly.
 */

/** A record's indent depth (0 when unset or invalid). */
export function depthOf(record) {
  return typeof record.depth === 'number' && record.depth > 0 ? record.depth : 0;
}

/** Index just past the subtree rooted at I — the run of deeper entries. */
export function subtreeEnd(records, i) {
  const d = depthOf(records[i]);
  let j = i + 1;
  while (j < records.length && depthOf(records[j]) > d) j += 1;
  return j;
}

/** True when I has at least one child (the next entry is deeper). */
export function hasChildren(records, i) {
  return (
    i + 1 < records.length && depthOf(records[i + 1]) > depthOf(records[i])
  );
}

/** Whether I can be indented — it needs a same-or-shallower predecessor
 *  to become a child of (so a child is never deeper than parent + 1). */
export function canIndent(records, i) {
  return i > 0 && depthOf(records[i]) <= depthOf(records[i - 1]);
}

/** Whether I can be outdented (it is below the top level). */
export function canOutdent(records, i) {
  return depthOf(records[i]) > 0;
}

/** Indent I and its whole subtree one level. Mutates; returns true if moved. */
export function indent(records, i) {
  if (!canIndent(records, i)) return false;
  const end = subtreeEnd(records, i);
  for (let k = i; k < end; k += 1) records[k].depth = depthOf(records[k]) + 1;
  return true;
}

/** Outdent I and its whole subtree one level. Mutates; returns true if moved. */
export function outdent(records, i) {
  if (!canOutdent(records, i)) return false;
  const end = subtreeEnd(records, i);
  for (let k = i; k < end; k += 1) records[k].depth = depthOf(records[k]) - 1;
  return true;
}

/**
 * The rows to render given collapse state: every entry except those
 * hidden beneath a collapsed ancestor. Each row carries its index in
 * `records`, its depth, whether it has children, and whether it is
 * itself collapsed.
 *
 * @param {Array<{depth?: number, collapsed?: boolean}>} records
 * @returns {Array<{index: number, depth: number, hasChildren: boolean,
 *   collapsed: boolean}>}
 */
export function visibleRows(records) {
  const rows = [];
  let hideBelow = Infinity; // skip entries deeper than this
  for (let i = 0; i < records.length; i += 1) {
    const d = depthOf(records[i]);
    if (d > hideBelow) continue;
    hideBelow = Infinity;
    const kids = hasChildren(records, i);
    const collapsed = kids && records[i].collapsed === true;
    rows.push({ index: i, depth: d, hasChildren: kids, collapsed });
    if (collapsed) hideBelow = d;
  }
  return rows;
}
