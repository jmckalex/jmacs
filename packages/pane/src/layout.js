/**
 * @file Pane layout math.
 *
 * Walks the pane tree and computes a rectangle for every leaf. Split
 * nodes don't appear in the result (they have no DOM); their job is to
 * carve the parent rect into the two child rects.
 *
 * Each rect is `{ left, top, width, height }` in integer pixels.
 * Rounding is done at split time so adjacent leaves are pixel-perfect
 * neighbours (the right child's `left` is the left child's `left +
 * width`, not the floating-point `left + ratio*width`).
 */

import {
  isLeafPane,
  isSplitPane,
  SPLIT_HORIZONTAL,
  SPLIT_VERTICAL,
} from './pane.js';

/**
 * Compute the rect for every leaf in PANE within HOST_RECT.
 *
 * @param {import('./pane.js').Pane} pane
 * @param {{left?: number, top?: number, width: number, height: number}} hostRect
 *   The pane tree's bounding rectangle. The `left`/`top` default to 0
 *   so callers can pass just `{width, height}` when the host is the
 *   origin of its own coordinate space.
 * @returns {Map<string, {left: number, top: number, width: number, height: number}>}
 *   Map from each leaf's `pane.id` to its rect.
 */
export function computeRects(pane, hostRect) {
  const rects = new Map();
  const left = Math.round(hostRect.left ?? 0);
  const top = Math.round(hostRect.top ?? 0);
  const width = Math.max(0, Math.round(hostRect.width ?? 0));
  const height = Math.max(0, Math.round(hostRect.height ?? 0));
  walk(pane, { left, top, width, height }, rects);
  return rects;
}

function walk(pane, rect, rects) {
  if (isLeafPane(pane)) {
    rects.set(pane.id, rect);
    return;
  }
  if (!isSplitPane(pane)) return;

  const [firstRect, secondRect] = splitRect(rect, pane.orientation, pane.ratio);
  walk(pane.first, firstRect, rects);
  walk(pane.second, secondRect, rects);
}

/**
 * Split RECT along ORIENTATION at RATIO. Returns the two child rects
 * in [first, second] order. Pixel-perfect: the boundary between the
 * two is integer-rounded; the second child fills the rest so the pair
 * sums exactly to the parent.
 *
 * @param {{left: number, top: number, width: number, height: number}} rect
 * @param {'horizontal' | 'vertical'} orientation
 * @param {number} ratio
 * @returns {[
 *   {left: number, top: number, width: number, height: number},
 *   {left: number, top: number, width: number, height: number}
 * ]}
 */
export function splitRect(rect, orientation, ratio) {
  if (orientation === SPLIT_HORIZONTAL) {
    // First on the left, second on the right.
    const firstWidth = Math.max(0, Math.round(rect.width * ratio));
    const secondWidth = Math.max(0, rect.width - firstWidth);
    return [
      { left: rect.left, top: rect.top, width: firstWidth, height: rect.height },
      {
        left: rect.left + firstWidth,
        top: rect.top,
        width: secondWidth,
        height: rect.height,
      },
    ];
  }
  // Vertical: first on top, second on the bottom.
  const firstHeight = Math.max(0, Math.round(rect.height * ratio));
  const secondHeight = Math.max(0, rect.height - firstHeight);
  return [
    { left: rect.left, top: rect.top, width: rect.width, height: firstHeight },
    {
      left: rect.left,
      top: rect.top + firstHeight,
      width: rect.width,
      height: secondHeight,
    },
  ];
}

/**
 * Compute one edge record per split node, describing where its splitter
 * handle sits and which split node's ratio it edits. Returns an empty
 * array for a single-leaf tree.
 *
 * Each record's rect is the **handle**'s rect (a thin 4 px-wide rectangle
 * lying along the shared edge of the split's two children). The handle
 * straddles the boundary, two pixels into each child, so it's easy to
 * grab without being a visible barrier.
 *
 * @param {import('./pane.js').Pane} pane
 * @param {{left?: number, top?: number, width: number, height: number}} hostRect
 * @param {object} [options]
 * @param {number} [options.thickness=4] - The handle's thickness, in
 *   pixels. The handle is centred on the boundary.
 * @returns {Array<{
 *   splitId: string,
 *   orientation: 'horizontal' | 'vertical',
 *   left: number, top: number, width: number, height: number,
 *   parentRect: { left: number, top: number, width: number, height: number },
 *   ratio: number,
 * }>}
 *   One entry per split node, in depth-first order.
 */
export function computeSplitterEdges(pane, hostRect, options = {}) {
  const edges = [];
  const thickness = Math.max(1, Math.round(options.thickness ?? 4));
  const left = Math.round(hostRect.left ?? 0);
  const top = Math.round(hostRect.top ?? 0);
  const width = Math.max(0, Math.round(hostRect.width ?? 0));
  const height = Math.max(0, Math.round(hostRect.height ?? 0));
  walkEdges(pane, { left, top, width, height }, edges, thickness);
  return edges;
}

function walkEdges(pane, rect, edges, thickness) {
  if (isLeafPane(pane)) return;
  if (!isSplitPane(pane)) return;

  const [firstRect, secondRect] = splitRect(rect, pane.orientation, pane.ratio);
  const half = Math.floor(thickness / 2);
  if (pane.orientation === SPLIT_HORIZONTAL) {
    // The shared edge is vertical at x = firstRect.left + firstRect.width.
    const edgeX = firstRect.left + firstRect.width;
    edges.push({
      splitId: pane.id,
      orientation: SPLIT_HORIZONTAL,
      left: edgeX - half,
      top: rect.top,
      width: thickness,
      height: rect.height,
      parentRect: rect,
      ratio: pane.ratio,
    });
  } else if (pane.orientation === SPLIT_VERTICAL) {
    // The shared edge is horizontal at y = firstRect.top + firstRect.height.
    const edgeY = firstRect.top + firstRect.height;
    edges.push({
      splitId: pane.id,
      orientation: SPLIT_VERTICAL,
      left: rect.left,
      top: edgeY - half,
      width: rect.width,
      height: thickness,
      parentRect: rect,
      ratio: pane.ratio,
    });
  }

  walkEdges(pane.first, firstRect, edges, thickness);
  walkEdges(pane.second, secondRect, edges, thickness);
}
