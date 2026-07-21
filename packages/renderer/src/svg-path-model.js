/**
 * @file Pure Bezier path model for the SVG editor's pen / node-edit tools.
 *
 * Everything here is side-effect free and DOM-free so it can be unit
 * tested in Node. The live `<svg-editor-view>` parses a `<path d="…">`
 * into this model, edits it (drag an anchor, adjust a control handle,
 * insert / delete an anchor), and serialises it back to a `d` string.
 *
 * The model:
 *
 *   { closed: boolean, anchors: Anchor[] }
 *   Anchor: { x, y, hIn: {x,y}|null, hOut: {x,y}|null }
 *
 * `hIn` / `hOut` are the ABSOLUTE positions of the Bezier control points
 * entering / leaving the anchor (null = no handle, i.e. a corner joined
 * by straight segments). Segment i runs from anchor i to anchor i+1
 * (wrapping for a closed path); it is a straight line when both facing
 * handles are null, else a cubic with c1 = a[i].hOut ?? a[i] and
 * c2 = a[i+1].hIn ?? a[i+1].
 *
 * Parsing supports the subset the editor emits plus the common absolute /
 * relative commands of hand-authored diagram paths: M L H V C S Q T Z.
 * Arcs (`A`) and multi-subpath (`M … M …`) paths return null — the editor
 * treats those as opaque (selectable / movable, not node-editable).
 */

/** Round to 2 decimals for clean serialised output. */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** A fresh anchor. */
export function makeAnchor(x, y, hIn = null, hOut = null) {
  return {
    x,
    y,
    hIn: hIn ? { x: hIn.x, y: hIn.y } : null,
    hOut: hOut ? { x: hOut.x, y: hOut.y } : null,
  };
}

/** Deep-copy a model (the edit ops are immutable — they return copies). */
export function clonePath(model) {
  return {
    closed: !!model.closed,
    anchors: model.anchors.map((a) => makeAnchor(a.x, a.y, a.hIn, a.hOut)),
  };
}

// --- parsing -------------------------------------------------------------

/** Tokenise a `d` attribute into command letters and numbers. */
function tokenizePathData(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) out.push(m[1]);
    else out.push(Number(m[2]));
  }
  return out;
}

/**
 * Parse a `d` string into a path model, or return `null` for anything
 * outside the supported subset (arcs, multiple subpaths, malformed data).
 * @param {string} d
 * @returns {{closed:boolean, anchors:Array<object>}|null}
 */
export function parsePathData(d) {
  if (typeof d !== 'string' || d.trim() === '') return null;
  const toks = tokenizePathData(d);
  if (toks.length === 0 || typeof toks[0] !== 'string') return null;

  /** @type {Array<object>} */
  const anchors = [];
  let closed = false;
  let sawMove = false;
  let cur = { x: 0, y: 0 };
  let prevCubicC2 = null; // for S/s reflection
  let prevQuadC = null; // for T/t reflection
  let i = 0;

  const takeNums = (n) => {
    if (i + n > toks.length) return null;
    const nums = toks.slice(i, i + n);
    if (!nums.every((t) => typeof t === 'number')) return null;
    i += n;
    return nums;
  };

  const lastAnchor = () => anchors[anchors.length - 1];

  /** Append a straight segment to (x, y). */
  const lineTo = (x, y) => {
    anchors.push(makeAnchor(x, y));
    cur = { x, y };
    prevCubicC2 = null;
    prevQuadC = null;
  };

  /**
   * Append a cubic segment with absolute control points. A control point
   * that coincides with its anchor is a zero-length handle — canonicalise
   * it to null (a corner), or an invisible "phantom handle" would sit on
   * the anchor and shadow it during node editing.
   */
  const cubicTo = (c1x, c1y, c2x, c2y, x, y) => {
    const from = lastAnchor();
    from.hOut =
      Math.abs(c1x - from.x) < 1e-9 && Math.abs(c1y - from.y) < 1e-9
        ? null
        : { x: c1x, y: c1y };
    const hIn =
      Math.abs(c2x - x) < 1e-9 && Math.abs(c2y - y) < 1e-9 ? null : { x: c2x, y: c2y };
    anchors.push(makeAnchor(x, y, hIn));
    cur = { x, y };
    prevCubicC2 = { x: c2x, y: c2y };
    prevQuadC = null;
  };

  /** Append a quadratic segment (exact cubic promotion). */
  const quadTo = (qx, qy, x, y) => {
    const c1x = cur.x + (2 / 3) * (qx - cur.x);
    const c1y = cur.y + (2 / 3) * (qy - cur.y);
    const c2x = x + (2 / 3) * (qx - x);
    const c2y = y + (2 / 3) * (qy - y);
    cubicTo(c1x, c1y, c2x, c2y, x, y);
    prevQuadC = { x: qx, y: qy };
  };

  let cmd = null;
  while (i < toks.length) {
    const tok = toks[i];
    if (typeof tok === 'string') {
      cmd = tok;
      i += 1;
      if (cmd === 'Z' || cmd === 'z') {
        closed = true;
        // A Z followed by anything but the end (a second subpath, or more
        // drawing on the closed path) is outside the subset.
        if (i < toks.length) return null;
        break;
      }
    } else if (cmd === null) {
      return null; // numbers before any command
    }
    // Implicit repetition: a command letter followed by extra coordinate
    // sets repeats (M repeats as L, per the spec).
    const rel = cmd === cmd.toLowerCase();
    const abs = (dx, dy) => (rel ? { x: cur.x + dx, y: cur.y + dy } : { x: dx, y: dy });

    switch (cmd.toUpperCase()) {
      case 'M': {
        const nums = takeNums(2);
        if (!nums) return null;
        if (sawMove) return null; // multi-subpath → opaque
        const p = abs(nums[0], nums[1]);
        anchors.push(makeAnchor(p.x, p.y));
        cur = p;
        sawMove = true;
        cmd = rel ? 'l' : 'L'; // implicit lineto on repeat
        break;
      }
      case 'L': {
        const nums = takeNums(2);
        if (!nums) return null;
        const p = abs(nums[0], nums[1]);
        lineTo(p.x, p.y);
        break;
      }
      case 'H': {
        const nums = takeNums(1);
        if (!nums) return null;
        const x = rel ? cur.x + nums[0] : nums[0];
        lineTo(x, cur.y);
        break;
      }
      case 'V': {
        const nums = takeNums(1);
        if (!nums) return null;
        const y = rel ? cur.y + nums[0] : nums[0];
        lineTo(cur.x, y);
        break;
      }
      case 'C': {
        const nums = takeNums(6);
        if (!nums) return null;
        const c1 = abs(nums[0], nums[1]);
        const c2 = abs(nums[2], nums[3]);
        const p = abs(nums[4], nums[5]);
        cubicTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
        break;
      }
      case 'S': {
        const nums = takeNums(4);
        if (!nums) return null;
        const c2 = abs(nums[0], nums[1]);
        const p = abs(nums[2], nums[3]);
        const c1 = prevCubicC2
          ? { x: 2 * cur.x - prevCubicC2.x, y: 2 * cur.y - prevCubicC2.y }
          : { x: cur.x, y: cur.y };
        cubicTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
        break;
      }
      case 'Q': {
        const nums = takeNums(4);
        if (!nums) return null;
        const q = abs(nums[0], nums[1]);
        const p = abs(nums[2], nums[3]);
        quadTo(q.x, q.y, p.x, p.y);
        break;
      }
      case 'T': {
        const nums = takeNums(2);
        if (!nums) return null;
        const p = abs(nums[0], nums[1]);
        const q = prevQuadC
          ? { x: 2 * cur.x - prevQuadC.x, y: 2 * cur.y - prevQuadC.y }
          : { x: cur.x, y: cur.y };
        quadTo(q.x, q.y, p.x, p.y);
        break;
      }
      default:
        return null; // A/a (arcs) or anything unrecognised
    }
    if (!sawMove) return null; // drawing before M
  }

  // A bare M (single point) isn't an editable path.
  if (!sawMove || anchors.length < 2) return null;

  // For a closed path whose last anchor coincides with the first, fold the
  // duplicate: `M 0 0 … L 0 0 Z` and `M 0 0 … Z` mean the same outline, and
  // one canonical form keeps editing sane.
  if (closed && anchors.length > 2) {
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
      first.hIn = last.hIn;
      anchors.pop();
    }
  }

  return { closed, anchors };
}

// --- serialisation -------------------------------------------------------

/**
 * Move a degenerate control point a hair off its anchor, along the
 * tangent toward the segment's other control point (≤ 2 user units — a
 * sub-pixel shape change).
 */
function nudgeControl(anchor, toward) {
  const dx = toward.x - anchor.x;
  const dy = toward.y - anchor.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: anchor.x, y: anchor.y };
  const k = Math.min(0.02, 2 / len);
  return { x: anchor.x + dx * k, y: anchor.y + dy * k };
}

/**
 * Serialise a model back to a `d` string (absolute commands, straight
 * segments as `L`, curved as `C`, 2-decimal precision).
 *
 * A one-sided cubic (a smooth anchor into a corner, or vice versa) never
 * emits its control point exactly ON the endpoint: that zero-length end
 * tangent makes `orient="auto"` marker rotation renderer-dependent —
 * Chromium uses the limit tangent, WebKit falls back to 0° and draws the
 * arrowhead sideways. The control point is nudged a hair along the true
 * tangent instead (found live: exported connectors opened in Gapplin).
 * @param {{closed:boolean, anchors:Array<object>}} model
 * @returns {string}
 */
export function pathDataFromModel(model) {
  const { anchors, closed } = model;
  if (!anchors || anchors.length === 0) return '';
  const parts = [`M ${round2(anchors[0].x)} ${round2(anchors[0].y)}`];
  const segs = segmentCount(model);
  for (let s = 0; s < segs; s += 1) {
    const from = anchors[s];
    const to = anchors[(s + 1) % anchors.length];
    if (!from.hOut && !to.hIn) {
      if (s === segs - 1 && closed) break; // plain Z draws this line
      parts.push(`L ${round2(to.x)} ${round2(to.y)}`);
    } else {
      let c1 = from.hOut ?? from;
      let c2 = to.hIn ?? to;
      if (!from.hOut && to.hIn) c1 = nudgeControl(from, c2);
      if (!to.hIn && from.hOut) c2 = nudgeControl(to, c1);
      parts.push(
        `C ${round2(c1.x)} ${round2(c1.y)} ${round2(c2.x)} ${round2(c2.y)} ` +
          `${round2(to.x)} ${round2(to.y)}`
      );
    }
  }
  if (closed) parts.push('Z');
  return parts.join(' ');
}

// --- structure -----------------------------------------------------------

/** The number of segments (edges) in the path. */
export function segmentCount(model) {
  const n = model.anchors.length;
  if (n < 2) return 0;
  return model.closed ? n : n - 1;
}

/**
 * The four control points of segment `s` plus whether it is straight.
 * @returns {{p0:object,c1:object,c2:object,p1:object,isLine:boolean}}
 */
export function segmentPoints(model, s) {
  const from = model.anchors[s];
  const to = model.anchors[(s + 1) % model.anchors.length];
  const isLine = !from.hOut && !to.hIn;
  return {
    p0: { x: from.x, y: from.y },
    c1: from.hOut ? { ...from.hOut } : { x: from.x, y: from.y },
    c2: to.hIn ? { ...to.hIn } : { x: to.x, y: to.y },
    p1: { x: to.x, y: to.y },
    isLine,
  };
}

/**
 * Evaluate segment `s` at parameter `t` in [0,1]. Straight segments
 * interpolate linearly (uniform speed — a degenerate cubic with its
 * controls on the endpoints traces the same line at non-uniform speed,
 * which would skew `t`-based anchor insertion).
 */
export function pointOnSegment(model, s, t) {
  const { p0, c1, c2, p1, isLine } = segmentPoints(model, s);
  if (isLine) {
    return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
  }
  const u = 1 - t;
  const x =
    u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x;
  const y =
    u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y;
  return { x, y };
}

// --- edit operations (immutable) -----------------------------------------

/** Move anchor `i` (and its handles) by (dx, dy). Returns a new model. */
export function movePathAnchor(model, i, dx, dy) {
  const next = clonePath(model);
  const a = next.anchors[i];
  if (!a) return next;
  a.x += dx;
  a.y += dy;
  if (a.hIn) {
    a.hIn.x += dx;
    a.hIn.y += dy;
  }
  if (a.hOut) {
    a.hOut.x += dx;
    a.hOut.y += dy;
  }
  return next;
}

/**
 * Set anchor `i`'s handle (`'in'` or `'out'`) to the absolute point `pt`.
 * `mode`:
 *   - `'symmetric'` — the opposite handle mirrors `pt` about the anchor
 *     (equal length, opposite direction) — the smooth default.
 *   - `'free'` — only the named handle moves (Alt-drag breaks symmetry).
 * Returns a new model.
 */
export function setPathHandle(model, i, side, pt, mode = 'symmetric') {
  const next = clonePath(model);
  const a = next.anchors[i];
  if (!a) return next;
  const h = { x: pt.x, y: pt.y };
  if (side === 'in') a.hIn = h;
  else a.hOut = h;
  if (mode === 'symmetric') {
    const mirror = { x: 2 * a.x - h.x, y: 2 * a.y - h.y };
    if (side === 'in') {
      if (a.hOut) a.hOut = mirror;
    } else if (a.hIn) {
      a.hIn = mirror;
    }
  }
  return next;
}

/** Translate the whole path by (dx, dy). Returns a new model. */
export function translatePath(model, dx, dy) {
  return transformPath(model, (p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Map every point (anchors + handles) through `fn`. Returns a new model. */
export function transformPath(model, fn) {
  const next = clonePath(model);
  for (const a of next.anchors) {
    const p = fn({ x: a.x, y: a.y });
    a.x = p.x;
    a.y = p.y;
    if (a.hIn) a.hIn = fn(a.hIn);
    if (a.hOut) a.hOut = fn(a.hOut);
  }
  return next;
}

/**
 * Affinely map the path from one bbox to another (the resize-drag op:
 * `from` is the path's bbox when the drag began, `to` is the dragged
 * bbox). Zero-size source axes translate without scaling.
 */
export function resizePath(model, from, to) {
  const sx = from.width ? to.width / from.width : 1;
  const sy = from.height ? to.height / from.height : 1;
  return transformPath(model, (p) => ({
    x: to.x + (p.x - from.x) * sx,
    y: to.y + (p.y - from.y) * sy,
  }));
}

// --- hit-testing ---------------------------------------------------------

/**
 * Flatten the path into a polyline: an array of points per segment
 * (`samples` subdivisions each, straight segments just two points).
 * @returns {Array<{x:number,y:number}>}
 */
export function flattenPath(model, samples = 16) {
  const pts = [];
  const segs = segmentCount(model);
  for (let s = 0; s < segs; s += 1) {
    const { p0, p1, isLine } = segmentPoints(model, s);
    if (s === 0) pts.push(p0);
    if (isLine) {
      pts.push(p1);
    } else {
      for (let k = 1; k <= samples; k += 1) {
        pts.push(pointOnSegment(model, s, k / samples));
      }
    }
  }
  return pts;
}

/**
 * Nearest point on segment ab to `pt`, with its projection parameter.
 * (Local copy to stay dependency-free.)
 */
function nearestOnSeg(pt, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  return { t, dist: Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy)) };
}

/**
 * The nearest point on the path to `pt`, by sampled subdivision (the
 * winning sample interval is refined by the chord projection, so the
 * returned `t` is accurate enough to place an inserted anchor under the
 * pointer).
 * @returns {{seg:number, t:number, point:{x:number,y:number}, dist:number}|null}
 */
export function nearestPointOnPath(model, pt, samples = 24) {
  const segs = segmentCount(model);
  if (segs === 0) return null;
  let best = null;
  for (let s = 0; s < segs; s += 1) {
    const { isLine } = segmentPoints(model, s);
    const n = isLine ? 1 : samples;
    let prev = pointOnSegment(model, s, 0);
    for (let k = 1; k <= n; k += 1) {
      const p = pointOnSegment(model, s, k / n);
      const { t: local, dist } = nearestOnSeg(pt, prev, p);
      if (!best || dist < best.dist) {
        best = { seg: s, t: (k - 1 + local) / n, point: null, dist };
      }
      prev = p;
    }
  }
  if (best) best.point = pointOnSegment(model, best.seg, best.t);
  return best;
}

/** Whether `pt` lies within `tol` of the path outline. */
export function hitTestPath(model, pt, tol = 6, samples = 24) {
  const near = nearestPointOnPath(model, pt, samples);
  return !!near && near.dist <= tol;
}

// --- anchor insertion / removal ------------------------------------------

/**
 * Insert an anchor on segment `s` at parameter `t` (de Casteljau split:
 * the outline is unchanged). Returns a new model with one more anchor at
 * index `s + 1`.
 */
export function insertAnchor(model, s, t) {
  const next = clonePath(model);
  const n = next.anchors.length;
  const from = next.anchors[s];
  const to = next.anchors[(s + 1) % n];
  const { p0, c1, c2, p1, isLine } = segmentPoints(model, s);

  if (isLine) {
    const mid = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
    next.anchors.splice(s + 1, 0, makeAnchor(mid.x, mid.y));
    return next;
  }

  // de Casteljau at t.
  const lerp = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const q0 = lerp(p0, c1);
  const q1 = lerp(c1, c2);
  const q2 = lerp(c2, p1);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const sp = lerp(r0, r1); // the split point, on the curve

  from.hOut = from.hOut ? q0 : null;
  to.hIn = to.hIn ? q2 : null;
  next.anchors.splice(s + 1, 0, makeAnchor(sp.x, sp.y, r0, r1));
  return next;
}

/**
 * Remove anchor `i`. Returns a new model, or `null` when removal would
 * leave too few anchors (open < 2, closed < 3) — the caller should treat
 * that as "delete the whole path".
 */
export function removeAnchor(model, i) {
  const n = model.anchors.length;
  if (model.closed ? n <= 3 : n <= 2) return null;
  const next = clonePath(model);
  next.anchors.splice(i, 1);
  return next;
}

/** The bbox of the flattened outline (control-polygon-tight enough). */
export function pathOutlineBbox(model, samples = 16) {
  const pts = flattenPath(model, samples);
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
