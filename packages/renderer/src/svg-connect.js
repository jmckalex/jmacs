/**
 * @file Pure connector geometry for the SVG editor — TikZ-style node
 * attachment.
 *
 * A connector endpoint lands ON the border of a node (or plain shape):
 * either at a named compass anchor (`n`, `ne`, …, TikZ's `.north east`)
 * or at the `auto` anchor — the intersection of the border with the ray
 * from the shape's centre toward the path's next point (TikZ's default
 * edge behaviour). All functions are DOM-free and unit-tested; specs are
 * the `{tag, attrs}` shape descriptions that `fitNodeBorder`
 * (svg-node.js) produces, or the equivalents read off plain <rect> /
 * <ellipse> / <circle> elements.
 *
 * Every spec is interpreted in ABSOLUTE document coordinates; use
 * {@link translateSpec} to shift a node-local (centred) border spec by
 * the node's translate.
 */

/** The compass anchor names, clockwise from north. */
export const COMPASS_ANCHORS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

/** Parse a polygon `points` attribute into `{x,y}` vertices. */
export function parsePolyPoints(points) {
  const nums = String(points ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (Number.isFinite(nums[i]) && Number.isFinite(nums[i + 1])) {
      out.push({ x: nums[i], y: nums[i + 1] });
    }
  }
  return out;
}

/** Serialise vertices back to a polygon `points` attribute. */
function polyPointsAttr(pts) {
  return pts.map((p) => `${p.x},${p.y}`).join(' ');
}

/** The centre of a border spec. */
export function specCenter(spec) {
  const a = spec.attrs;
  switch (spec.tag) {
    case 'rect':
      return { x: Number(a.x) + Number(a.width) / 2, y: Number(a.y) + Number(a.height) / 2 };
    case 'circle':
    case 'ellipse':
      return { x: Number(a.cx ?? 0), y: Number(a.cy ?? 0) };
    case 'polygon': {
      const pts = parsePolyPoints(a.points);
      if (pts.length === 0) return { x: 0, y: 0 };
      const s = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
      return { x: s.x / pts.length, y: s.y / pts.length };
    }
    default:
      return { x: 0, y: 0 };
  }
}

/** Shift a spec by (dx, dy) — e.g. node-local border → document coords. */
export function translateSpec(spec, dx, dy) {
  const a = { ...spec.attrs };
  switch (spec.tag) {
    case 'rect':
      a.x = Number(a.x) + dx;
      a.y = Number(a.y) + dy;
      break;
    case 'circle':
    case 'ellipse':
      a.cx = Number(a.cx ?? 0) + dx;
      a.cy = Number(a.cy ?? 0) + dy;
      break;
    case 'polygon':
      a.points = polyPointsAttr(parsePolyPoints(a.points).map((p) => ({ x: p.x + dx, y: p.y + dy })));
      break;
    default:
      break;
  }
  return { tag: spec.tag, attrs: a };
}

/**
 * The named compass anchor point on a border spec (TikZ's `.north`,
 * `.north east`, …). Rect corners are the true corners; ellipse diagonal
 * anchors are the 45° parameter points; diamond cardinals are the
 * vertices and diagonals the edge midpoints (TikZ's diamond shape).
 * @param {{tag:string, attrs:object}} spec
 * @param {string} name - one of COMPASS_ANCHORS or 'center'.
 * @returns {{x:number,y:number}|null}
 */
export function borderAnchorPoint(spec, name) {
  const c = specCenter(spec);
  if (name === 'center') return c;
  if (!COMPASS_ANCHORS.includes(name)) return null;
  const a = spec.attrs;
  switch (spec.tag) {
    case 'rect': {
      const hw = Number(a.width) / 2;
      const hh = Number(a.height) / 2;
      const dx = name.includes('e') ? hw : name.includes('w') ? -hw : 0;
      const dy = name.includes('s') ? hh : name.includes('n') ? -hh : 0;
      return { x: c.x + dx, y: c.y + dy };
    }
    case 'circle': {
      const r = Number(a.r);
      const d = COMPASS_DIRS[name];
      return { x: c.x + r * d.x, y: c.y + r * d.y };
    }
    case 'ellipse': {
      const rx = Number(a.rx);
      const ry = Number(a.ry);
      const d = COMPASS_DIRS[name];
      return { x: c.x + rx * d.x, y: c.y + ry * d.y };
    }
    case 'polygon': {
      // Diamond: vertices at N/E/S/W, edge midpoints at the diagonals.
      const pts = parsePolyPoints(a.points);
      if (pts.length !== 4) return borderPointToward(spec, {
        x: c.x + COMPASS_DIRS[name].x,
        y: c.y + COMPASS_DIRS[name].y,
      });
      const [n, e, s, w] = pts; // fitNodeBorder emits N, E, S, W order
      const named = {
        n,
        e,
        s,
        w,
        ne: mid(n, e),
        se: mid(s, e),
        sw: mid(s, w),
        nw: mid(n, w),
      };
      return named[name] ?? null;
    }
    default:
      return null;
  }
}

/** Unit directions for the compass names (y grows downward). */
const COMPASS_DIRS = {
  n: { x: 0, y: -1 },
  ne: { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
  e: { x: 1, y: 0 },
  se: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
  s: { x: 0, y: 1 },
  sw: { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
  w: { x: -1, y: 0 },
  nw: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
};

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * The intersection of the border with the ray from the spec's centre
 * toward `target` — TikZ's automatic edge anchor. Falls back to the
 * centre for a degenerate (zero-length) direction.
 * @param {{tag:string, attrs:object}} spec
 * @param {{x:number,y:number}} target
 * @returns {{x:number,y:number}}
 */
export function borderPointToward(spec, target) {
  const c = specCenter(spec);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return c;
  const a = spec.attrs;
  switch (spec.tag) {
    case 'circle': {
      const r = Number(a.r);
      return { x: c.x + (r * dx) / len, y: c.y + (r * dy) / len };
    }
    case 'ellipse': {
      const rx = Number(a.rx);
      const ry = Number(a.ry);
      const k = 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
      return { x: c.x + k * dx, y: c.y + k * dy };
    }
    case 'rect': {
      const hw = Number(a.width) / 2;
      const hh = Number(a.height) / 2;
      const kx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
      const ky = dy !== 0 ? hh / Math.abs(dy) : Infinity;
      const k = Math.min(kx, ky);
      return { x: c.x + k * dx, y: c.y + k * dy };
    }
    case 'polygon': {
      const pts = parsePolyPoints(a.points);
      let best = null;
      for (let i = 0; i < pts.length; i += 1) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        const t = raySegment(c, { x: dx, y: dy }, p1, p2);
        if (t !== null && (best === null || t < best)) best = t;
      }
      if (best === null) return c;
      return { x: c.x + best * dx, y: c.y + best * dy };
    }
    default:
      return c;
  }
}

/**
 * Ray (origin o, direction d) vs segment p1→p2: the ray parameter t ≥ 0
 * of the intersection, or null.
 */
function raySegment(o, d, p1, p2) {
  const ex = p2.x - p1.x;
  const ey = p2.y - p1.y;
  const denom = d.x * ey - d.y * ex;
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const t = ((p1.x - o.x) * ey - (p1.y - o.y) * ex) / denom;
  const u = ((p1.x - o.x) * d.y - (p1.y - o.y) * d.x) / denom;
  if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9) return t;
  return null;
}

/**
 * Resolve a connector endpoint on a shape: a named compass anchor, or
 * `auto` — the border point toward `aim` (the neighbouring path point,
 * or the other shape's centre for a straight two-point edge).
 * @param {{tag:string, attrs:object}} spec - border spec in doc coords.
 * @param {string} anchor - 'auto', 'center', or a compass name.
 * @param {{x:number,y:number}} aim
 * @returns {{x:number,y:number}}
 */
export function connectorEndpoint(spec, anchor, aim) {
  if (anchor && anchor !== 'auto') {
    const named = borderAnchorPoint(spec, anchor);
    if (named) return named;
  }
  return borderPointToward(spec, aim);
}

/**
 * The compass anchor nearest to a point, with its distance — the pen
 * uses this to decide between a pinned anchor and `auto`.
 * @returns {{name:string, point:{x:number,y:number}, dist:number}|null}
 */
export function nearestCompassAnchor(spec, p) {
  let best = null;
  for (const name of COMPASS_ANCHORS) {
    const pt = borderAnchorPoint(spec, name);
    if (!pt) continue;
    const dist = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (!best || dist < best.dist) best = { name, point: pt, dist };
  }
  return best;
}
