/**
 * @file Pure geometry helpers for the SVG editor view.
 *
 * Everything here is side-effect free and DOM-free so it can be unit
 * tested in Node without a browser. The `<svg-editor-view>` element
 * (`svg-editor-view.js`) imports these for hit-testing, selection
 * handles, coordinate transforms between screen and SVG user space, and
 * resizing.
 *
 * Conventions:
 * - A "rect" is `{ x, y, width, height }` in SVG user space, with
 *   `width`/`height` non-negative after normalisation.
 * - A "point" is `{ x, y }` in SVG user space unless named `screen*`.
 * - Resize handles are named by compass direction:
 *   `nw n ne e se s sw w` (8 handles around a bbox).
 */

/** The eight resize-handle names, clockwise from top-left. */
export const HANDLE_NAMES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Clamp a number to `[lo, hi]`.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Normalise a rect so width/height are non-negative, moving the origin
 * to the top-left corner. Useful after a drag where the pointer can go
 * "backwards" past the anchor.
 * @param {{x:number,y:number,width:number,height:number}} r
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function normalizeRect(r) {
  let { x, y, width, height } = r;
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  return { x, y, width, height };
}

/**
 * Build a normalised rect from two corner points (e.g. drag start/end).
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function rectFromPoints(a, b) {
  return normalizeRect({
    x: a.x,
    y: a.y,
    width: b.x - a.x,
    height: b.y - a.y,
  });
}

/**
 * Whether a point lies inside (or on the border of) a rect.
 * @param {{x:number,y:number}} pt
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @returns {boolean}
 */
export function pointInRect(pt, rect) {
  const r = normalizeRect(rect);
  return (
    pt.x >= r.x &&
    pt.x <= r.x + r.width &&
    pt.y >= r.y &&
    pt.y <= r.y + r.height
  );
}

/**
 * Whether two rects intersect (share any area, edges touching counts).
 * @param {{x:number,y:number,width:number,height:number}} a
 * @param {{x:number,y:number,width:number,height:number}} b
 * @returns {boolean}
 */
export function rectsIntersect(a, b) {
  const ra = normalizeRect(a);
  const rb = normalizeRect(b);
  return !(
    ra.x + ra.width < rb.x ||
    rb.x + rb.width < ra.x ||
    ra.y + ra.height < rb.y ||
    rb.y + rb.height < ra.y
  );
}

/**
 * Whether rect `inner` is fully contained within rect `outer`.
 * @param {{x:number,y:number,width:number,height:number}} inner
 * @param {{x:number,y:number,width:number,height:number}} outer
 * @returns {boolean}
 */
export function rectContains(outer, inner) {
  const o = normalizeRect(outer);
  const i = normalizeRect(inner);
  return (
    i.x >= o.x &&
    i.y >= o.y &&
    i.x + i.width <= o.x + o.width &&
    i.y + i.height <= o.y + o.height
  );
}

/**
 * The eight resize-handle centre points for a bbox, keyed by handle name.
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @returns {Record<string,{x:number,y:number}>}
 */
export function handlePositions(rect) {
  const r = normalizeRect(rect);
  const { x, y, width: w, height: h } = r;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    nw: { x, y },
    n: { x: cx, y },
    ne: { x: x + w, y },
    e: { x: x + w, y: cy },
    se: { x: x + w, y: y + h },
    s: { x: cx, y: y + h },
    sw: { x, y: y + h },
    w: { x, y: cy },
  };
}

/**
 * Hit-test a point against the resize handles of a bbox. Returns the
 * handle name if the point is within `tolerance` (user-space units) of a
 * handle centre, else `null`. Closest handle wins on ties.
 * @param {{x:number,y:number}} pt
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {number} [tolerance=6]
 * @returns {string|null}
 */
export function handleAtPoint(pt, rect, tolerance = 6) {
  const handles = handlePositions(rect);
  let best = null;
  let bestDist = tolerance;
  for (const name of HANDLE_NAMES) {
    const h = handles[name];
    const dist = Math.hypot(pt.x - h.x, pt.y - h.y);
    if (dist <= bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

/**
 * Apply a resize-handle drag to a bbox: given the handle being dragged
 * and the new pointer position, return the new (un-normalised) rect. The
 * opposite corner/edge stays fixed. Caller may `normalizeRect` the
 * result if it wants non-negative dimensions.
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {string} handle - one of HANDLE_NAMES
 * @param {{x:number,y:number}} pt - new pointer position in user space
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function resizeRect(rect, handle, pt) {
  const r = normalizeRect(rect);
  let { x, y, width: w, height: h } = r;
  const right = x + w;
  const bottom = y + h;
  const touchesW = handle.includes('w');
  const touchesE = handle.includes('e');
  const touchesN = handle.includes('n');
  const touchesS = handle.includes('s');

  if (touchesW) {
    x = pt.x;
    w = right - pt.x;
  } else if (touchesE) {
    w = pt.x - x;
  }
  if (touchesN) {
    y = pt.y;
    h = bottom - pt.y;
  } else if (touchesS) {
    h = pt.y - y;
  }
  return { x, y, width: w, height: h };
}

/**
 * Convert a screen-space point to SVG user-space using a 2D affine
 * transform expressed as the six numbers of an SVG matrix
 * `{ a, b, c, d, e, f }` mapping user→screen (the result of
 * `element.getScreenCTM()`). We invert it to go screen→user.
 *
 * This is the pure core of `screenToUser`; the live view obtains the CTM
 * from the DOM and hands it here so the math stays testable.
 * @param {{x:number,y:number}} screenPt
 * @param {{a:number,b:number,c:number,d:number,e:number,f:number}} ctm
 *   user→screen matrix
 * @returns {{x:number,y:number}|null} user-space point, or null if the
 *   matrix is non-invertible (zero determinant).
 */
export function screenToUser(screenPt, ctm) {
  const { a, b, c, d, e, f } = ctm;
  const det = a * d - b * c;
  if (det === 0) return null;
  const inv = 1 / det;
  // Inverse of [[a,c,e],[b,d,f],[0,0,1]] applied to (x,y,1).
  const dx = screenPt.x - e;
  const dy = screenPt.y - f;
  return {
    x: (d * dx - c * dy) * inv,
    y: (a * dy - b * dx) * inv,
  };
}

/**
 * Convert an SVG user-space point to screen-space using a user→screen
 * matrix `{ a, b, c, d, e, f }`.
 * @param {{x:number,y:number}} userPt
 * @param {{a:number,b:number,c:number,d:number,e:number,f:number}} ctm
 * @returns {{x:number,y:number}}
 */
export function userToScreen(userPt, ctm) {
  const { a, b, c, d, e, f } = ctm;
  return {
    x: a * userPt.x + c * userPt.y + e,
    y: b * userPt.x + d * userPt.y + f,
  };
}

/**
 * The bounding box of a list of points.
 * @param {Array<{x:number,y:number}>} points
 * @returns {{x:number,y:number,width:number,height:number}|null} null for
 *   an empty list.
 */
export function bboxOfPoints(points) {
  if (!points || points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The union bounding box of a list of rects.
 * @param {Array<{x:number,y:number,width:number,height:number}>} rects
 * @returns {{x:number,y:number,width:number,height:number}|null} null for
 *   an empty list.
 */
export function unionBbox(rects) {
  if (!rects || rects.length === 0) return null;
  const pts = [];
  for (const r of rects) {
    const n = normalizeRect(r);
    pts.push({ x: n.x, y: n.y });
    pts.push({ x: n.x + n.width, y: n.y + n.height });
  }
  return bboxOfPoints(pts);
}

/**
 * Snap a value to the nearest multiple of `step` (grid snapping). A
 * `step <= 0` is a no-op.
 * @param {number} v
 * @param {number} step
 * @returns {number}
 */
export function snapToGrid(v, step) {
  if (!(step > 0)) return v;
  return Math.round(v / step) * step;
}

/**
 * Distance from a point to a line segment, used to hit-test thin shapes
 * (lines, connectors) where a bbox test is too generous.
 * @param {{x:number,y:number}} pt
 * @param {{x:number,y:number}} a - segment start
 * @param {{x:number,y:number}} b - segment end
 * @returns {number}
 */
export function distToSegment(pt, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(pt.x - a.x, pt.y - a.y);
  let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq;
  t = clamp(t, 0, 1);
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return Math.hypot(pt.x - px, pt.y - py);
}

/** The alignment modes `alignDeltas` supports. */
export const ALIGN_MODES = ['left', 'centerX', 'right', 'top', 'centerY', 'bottom'];

/**
 * Per-rect movement deltas that align a set of bboxes: to the leftmost
 * edge, horizontal centre, rightmost edge, topmost edge, vertical
 * centre, or bottommost edge of the set.
 * @param {Array<{x:number,y:number,width:number,height:number}>} rects
 * @param {string} mode - one of ALIGN_MODES.
 * @returns {Array<{dx:number,dy:number}>}
 */
export function alignDeltas(rects, mode) {
  if (!rects || rects.length === 0) return [];
  const rs = rects.map(normalizeRect);
  const lefts = rs.map((r) => r.x);
  const rights = rs.map((r) => r.x + r.width);
  const tops = rs.map((r) => r.y);
  const bottoms = rs.map((r) => r.y + r.height);
  const minL = Math.min(...lefts);
  const maxR = Math.max(...rights);
  const minT = Math.min(...tops);
  const maxB = Math.max(...bottoms);
  const midX = (minL + maxR) / 2;
  const midY = (minT + maxB) / 2;
  return rs.map((r) => {
    switch (mode) {
      case 'left':
        return { dx: minL - r.x, dy: 0 };
      case 'centerX':
        return { dx: midX - (r.x + r.width / 2), dy: 0 };
      case 'right':
        return { dx: maxR - (r.x + r.width), dy: 0 };
      case 'top':
        return { dx: 0, dy: minT - r.y };
      case 'centerY':
        return { dx: 0, dy: midY - (r.y + r.height / 2) };
      case 'bottom':
        return { dx: 0, dy: maxB - (r.y + r.height) };
      default:
        return { dx: 0, dy: 0 };
    }
  });
}

/**
 * Per-rect deltas that distribute bbox centres evenly between the two
 * extreme centres along an axis (`'x'` or `'y'`). Under three rects is a
 * no-op. Returned in INPUT order.
 * @param {Array<{x:number,y:number,width:number,height:number}>} rects
 * @param {'x'|'y'} axis
 * @returns {Array<{dx:number,dy:number}>}
 */
export function distributeDeltas(rects, axis) {
  const n = rects ? rects.length : 0;
  if (n < 3) return (rects ?? []).map(() => ({ dx: 0, dy: 0 }));
  const rs = rects.map(normalizeRect);
  const centre = (r) => (axis === 'x' ? r.x + r.width / 2 : r.y + r.height / 2);
  const order = rs.map((r, i) => ({ c: centre(r), i })).sort((a, b) => a.c - b.c);
  const first = order[0].c;
  const step = (order[n - 1].c - first) / (n - 1);
  const out = rs.map(() => ({ dx: 0, dy: 0 }));
  order.forEach(({ c, i }, rank) => {
    const target = first + rank * step;
    if (axis === 'x') out[i] = { dx: target - c, dy: 0 };
    else out[i] = { dx: 0, dy: target - c };
  });
  return out;
}

/**
 * Anchor point on a bbox for a named side, used by connectors to attach
 * to a shape. Sides: `n e s w` (edge midpoints), `center`, and the four
 * corners `nw ne se sw`.
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {string} side
 * @returns {{x:number,y:number}}
 */
export function anchorPoint(rect, side) {
  const r = normalizeRect(rect);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  switch (side) {
    case 'n':
      return { x: cx, y: r.y };
    case 's':
      return { x: cx, y: r.y + r.height };
    case 'w':
      return { x: r.x, y: cy };
    case 'e':
      return { x: r.x + r.width, y: cy };
    case 'nw':
      return { x: r.x, y: r.y };
    case 'ne':
      return { x: r.x + r.width, y: r.y };
    case 'sw':
      return { x: r.x, y: r.y + r.height };
    case 'se':
      return { x: r.x + r.width, y: r.y + r.height };
    case 'center':
    default:
      return { x: cx, y: cy };
  }
}
