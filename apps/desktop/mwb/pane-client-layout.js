/**
 * @file Model-B multi-pane CLIENT layout (G0a) — the pixel half.
 *
 * This is the client's side of the pane separation: given a PANE_TREE wire
 * snapshot (structure + ratios + per-leaf buffer/view-state + focus; NO
 * pixels) and the client's own editor-area rectangle, compute the per-leaf
 * pixel rects + the splitter handle rects, and the mount/unmount/keep diff a
 * renderer applies to its set of `createEditorView` instances.
 *
 * The headline of the geometry finding lives here: the client derives EVERY
 * pixel from (a) the wire ratios and (b) its OWN host rectangle, using the
 * SAME pure `computeRects` / `computeSplitterEdges` math `@editor/pane`
 * already exposes (and that production app.js already runs). Nothing pixel
 * crosses the wire. So a multi-pane client is: parse the tree → computeRects
 * → diff the leaf set → mount one view.js per new leaf on its buffer mirror
 * (with the leaf's view-state) → position each leaf's element at its rect →
 * focus the focused leaf. The hard part the plan feared (logical tree vs
 * pixel layout interleaved across ~1000 lines of app.js) separates cleanly:
 * the server holds the tree, the client holds these two functions.
 *
 * DOM-free + Electron-free (it returns plain rects + a diff; the harness does
 * the actual element positioning), so it is unit-testable under `node --test`
 * (pane-client-layout.test.js) — the verification of record with no screen.
 */

import { computeRects, computeSplitterEdges } from '@editor/pane';
import { wireLeaves } from './protocol.js';

/**
 * Rebuild a minimal `@editor/pane`-shaped tree from a PANE_TREE wire node, so
 * the pure `computeRects` / `computeSplitterEdges` (which read
 * kind/id/orientation/ratio/first/second) run on it directly. The client
 * never holds a server pane object — only this wire shape — so it
 * reconstructs the structure it needs for layout. Pure.
 *
 * @param {import('./protocol.js').WirePaneNode} node
 * @returns {object} A pane-shaped tree (the layout math's input).
 */
export function wireTreeToLayoutTree(node) {
  if (!node || typeof node !== 'object') {
    return { kind: 'leaf', id: 'pane-empty' };
  }
  if (node.kind === 'split') {
    return {
      kind: 'split',
      id: node.id,
      orientation: node.orientation,
      ratio: node.ratio,
      first: wireTreeToLayoutTree(node.first),
      second: wireTreeToLayoutTree(node.second),
    };
  }
  return { kind: 'leaf', id: node.id };
}

/**
 * Compute the full client-side layout of a PANE_TREE within the client's host
 * rectangle: the per-leaf pixel rects, the splitter handle rects, and the
 * focused leaf id. Pure — a function of the wire tree + the client's own
 * pixels only.
 *
 * @param {import('./protocol.js').WirePaneNode} tree - The PANE_TREE snapshot.
 * @param {{ width: number, height: number, left?: number, top?: number }} hostRect
 *   The client's editor-area rectangle (its OWN pixels).
 * @returns {{
 *   leafRects: Map<string, { left:number, top:number, width:number, height:number }>,
 *   splitters: Array<object>,
 *   focusedId: string|null,
 *   leaves: import('./protocol.js').WirePaneNode[],
 * }}
 */
export function layoutPaneTree(tree, hostRect) {
  const layoutTree = wireTreeToLayoutTree(tree);
  const rect = {
    left: Number(hostRect && hostRect.left) || 0,
    top: Number(hostRect && hostRect.top) || 0,
    width: Math.max(0, Number(hostRect && hostRect.width) || 0),
    height: Math.max(0, Number(hostRect && hostRect.height) || 0),
  };
  const leafRects = computeRects(layoutTree, rect);
  const splitters = computeSplitterEdges(layoutTree, rect);
  const leaves = wireLeaves(tree);
  const focusedId = (leaves.find((l) => l.focused) || {}).id ?? null;
  return { leafRects, splitters, focusedId, leaves };
}

/**
 * Diff the leaves of a fresh PANE_TREE against the set of leaf ids the client
 * currently has mounted, yielding which view instances to MOUNT (new leaves),
 * UNMOUNT (leaves that vanished — a delete / delete-others), and KEEP (still
 * present). The renderer mounts one `createEditorView` per `mount`, disposes
 * the `unmount` ones, and re-uses the `keep` ones (repositioning them to their
 * new rects). Pure.
 *
 * Each `mount` entry carries the leaf's buffer + view-state so the renderer
 * mounts the view on the right buffer mirror at the right point/scroll.
 *
 * @param {import('./protocol.js').WirePaneNode} tree - The new PANE_TREE.
 * @param {Iterable<string>} mountedIds - The leaf ids currently mounted.
 * @returns {{
 *   mount: import('./protocol.js').WirePaneNode[],
 *   unmount: string[],
 *   keep: import('./protocol.js').WirePaneNode[],
 * }}
 */
export function diffPaneLeaves(tree, mountedIds) {
  const have = new Set(mountedIds);
  const leaves = wireLeaves(tree);
  const wantIds = new Set(leaves.map((l) => l.id));
  const mount = [];
  const keep = [];
  for (const leaf of leaves) {
    if (have.has(leaf.id)) keep.push(leaf);
    else mount.push(leaf);
  }
  const unmount = [...have].filter((id) => !wantIds.has(id));
  return { mount, unmount, keep };
}
