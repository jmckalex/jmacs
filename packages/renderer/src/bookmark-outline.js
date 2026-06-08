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
 * Reorder RECORDS so that, at every level of the hierarchy, siblings sit
 * in ascending document position — with each subtree kept contiguous
 * beneath its parent. `offsetOf` reads a record's document offset
 * (default: its `anchor`).
 *
 * Pure: returns a new array referencing the same record objects, only
 * reordered. The depth/hierarchy is preserved — a child never leaves its
 * parent's subtree, even when an edit has moved it before the parent in
 * the text. For a flat list (all depth 0) this is a plain sort by offset,
 * which is what makes a bookmark set mid-document appear in the middle
 * rather than tacked onto the end.
 *
 * @param {Array<{anchor?: number, depth?: number}>} records
 * @param {(record: object) => number} [offsetOf]
 * @returns {Array<object>}
 */
export function sortByDocumentPosition(
  records,
  offsetOf = (r) => (typeof r.anchor === 'number' ? r.anchor : 0)
) {
  function parse(start, end) {
    const nodes = [];
    let i = start;
    while (i < end) {
      const subEnd = subtreeEnd(records, i);
      nodes.push({ record: records[i], children: parse(i + 1, subEnd) });
      i = subEnd;
    }
    // Array.prototype.sort is stable (ES2019+): equal offsets keep their
    // existing relative order, so re-sorting an unchanged list is a no-op.
    nodes.sort((a, b) => offsetOf(a.record) - offsetOf(b.record));
    return nodes;
  }
  const out = [];
  (function flatten(nodes) {
    for (const node of nodes) {
      out.push(node.record);
      flatten(node.children);
    }
  })(parse(0, records.length));
  return out;
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
