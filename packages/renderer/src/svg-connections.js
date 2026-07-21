/**
 * @file Connector plumbing for the SVG editor — the DOM-facing half of
 * the TikZ-style attachment model (the pure geometry lives in
 * svg-connect.js).
 *
 * A connector is a normal `data-godot-shape="path"` element carrying
 * attachment attributes:
 *
 *   data-godot-from / data-godot-to               — the shape's id
 *   data-godot-from-anchor / data-godot-to-anchor — 'auto' or a compass name
 *
 * Its interior anchors are the user's (fully node-editable); the two END
 * anchors are computed — the exact border point of the attached shape —
 * and recomputed ("rerouted") whenever an attached shape moves, resizes,
 * or rebuilds. The arrowhead marker's tip sits exactly on the path
 * endpoint, i.e. exactly on the border.
 *
 * Connectable shapes: nodes (their fitted border), plain rects and
 * ellipses (their own geometry).
 */

import {
  connectorEndpoint,
  borderPointToward,
  translateSpec,
  specCenter,
} from './svg-connect.js';
import { fitNodeBorder, NODE_DEFAULT_PADDING } from './svg-node.js';
import {
  parsePathData,
  pathDataFromModel,
  movePathAnchor,
} from './svg-path-model.js';

export class SvgConnections {
  /** @param {object} view - the hosting svg-editor-view. */
  constructor(view) {
    this._view = view;
  }

  /**
   * The connectable description of an element, or null: its border spec
   * in DOCUMENT coordinates plus its centre.
   * @param {Element} el
   * @returns {{el: Element, id: string, center: {x:number,y:number},
   *   spec: {tag:string, attrs:object}}|null}
   */
  connectableOf(el) {
    if (!el || !el.id) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const shape = el.getAttribute('data-godot-shape') || tag;
    if (shape === 'node') {
      const local = this._nodeBorderSpec(el);
      if (!local) return null;
      const t = this._view._transformOf(el) || { x: 0, y: 0 };
      const spec = translateSpec(local, t.x, t.y);
      return { el, id: el.id, center: specCenter(spec), spec };
    }
    if (shape === 'rect' || tag === 'rect') {
      const spec = {
        tag: 'rect',
        attrs: {
          x: Number(el.getAttribute('x')),
          y: Number(el.getAttribute('y')),
          width: Number(el.getAttribute('width')),
          height: Number(el.getAttribute('height')),
        },
      };
      return { el, id: el.id, center: specCenter(spec), spec };
    }
    if (shape === 'ellipse' || tag === 'ellipse' || tag === 'circle') {
      const spec =
        tag === 'circle'
          ? {
              tag: 'circle',
              attrs: {
                cx: Number(el.getAttribute('cx')),
                cy: Number(el.getAttribute('cy')),
                r: Number(el.getAttribute('r')),
              },
            }
          : {
              tag: 'ellipse',
              attrs: {
                cx: Number(el.getAttribute('cx')),
                cy: Number(el.getAttribute('cy')),
                rx: Number(el.getAttribute('rx')),
                ry: Number(el.getAttribute('ry')),
              },
            };
      return { el, id: el.id, center: specCenter(spec), spec };
    }
    return null;
  }

  /**
   * A node's border spec in NODE-LOCAL (centred) coordinates. With a
   * visible border, read the live border element (exact); with border
   * 'none', anchor on the padded content box, TikZ-style.
   */
  _nodeBorderSpec(g) {
    const border = g.querySelector('[data-godot-role="border"]');
    if (border) {
      const tag = border.tagName.toLowerCase();
      const attrs = {};
      for (const name of ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'points']) {
        const v = border.getAttribute(name);
        if (v != null) attrs[name] = v;
      }
      return { tag, attrs };
    }
    const content = g.querySelector('[data-godot-role="content"]');
    if (!content) return null;
    let box;
    try {
      box = content.getBBox();
    } catch {
      return null;
    }
    const padding = Number(g.getAttribute('data-godot-padding'));
    return fitNodeBorder(
      { width: box.width, height: box.height },
      { shape: 'rect', padding: Number.isFinite(padding) ? padding : NODE_DEFAULT_PADDING }
    );
  }

  /** The connectable under a user-space point (topmost first). */
  connectableAt(p) {
    const el = this._view._hitTest(p);
    return el ? this.connectableOf(el) : null;
  }

  /**
   * The connectable under OR NEAR a point: containment first, else the
   * shape whose border passes within `tol` of the point. The pen's
   * compass-anchor dots straddle the border, so a click on a dot's outer
   * half lands OUTSIDE the shape — a pure containment test silently
   * dropped the attachment (found live: a connector's start didn't
   * follow its node because it had never attached).
   * @param {{x:number,y:number}} p
   * @param {number} tol - user-space slack around the border.
   */
  connectableNear(p, tol) {
    const hit = this.connectableAt(p);
    if (hit) return hit;
    const layer = this._view._layer;
    if (!layer) return null;
    let best = null;
    for (const el of Array.from(layer.children)) {
      const conn = this.connectableOf(el);
      if (!conn) continue;
      const bp = borderPointToward(conn.spec, p);
      const dist = Math.hypot(p.x - bp.x, p.y - bp.y);
      if (dist <= tol && (!best || dist < best.dist)) {
        best = { conn, dist };
      }
    }
    return best ? best.conn : null;
  }

  /** Resolve an id to a live connectable, or null. */
  connectableById(id) {
    if (!id) return null;
    const layer = this._view._layer;
    if (!layer) return null;
    let el = null;
    try {
      el = layer.querySelector(`#${CSS.escape(id)}`);
    } catch {
      return null;
    }
    return el ? this.connectableOf(el) : null;
  }

  /**
   * Recompute the attached endpoint(s) of one connector path from the
   * live geometry of its referenced shapes. A dangling reference (the
   * shape was deleted) detaches that end.
   * @param {Element} pathEl
   */
  reroute(pathEl) {
    const model = parsePathData(pathEl.getAttribute('d') || '');
    if (!model || model.anchors.length < 2) return;
    const n = model.anchors.length;
    const from = this._endTarget(pathEl, 'from');
    const to = this._endTarget(pathEl, 'to');
    let next = model;

    const place = (endIdx, target, anchorName, aim) => {
      const pt = connectorEndpoint(target.spec, anchorName, aim);
      const a = next.anchors[endIdx];
      next = movePathAnchor(next, endIdx, pt.x - a.x, pt.y - a.y);
    };

    if (from) {
      const aim =
        n > 2 ? next.anchors[1] : to ? to.target.center : next.anchors[1];
      place(0, from.target, from.anchor, aim);
    }
    if (to) {
      const aim =
        n > 2 ? next.anchors[n - 2] : from ? from.target.center : next.anchors[n - 2];
      place(n - 1, to.target, to.anchor, aim);
    }
    pathEl.setAttribute('d', pathDataFromModel(next));
  }

  /** One end's live target + anchor, detaching a dangling reference. */
  _endTarget(pathEl, end) {
    const ref = pathEl.getAttribute(`data-godot-${end}`);
    if (!ref) return null;
    const target = this.connectableById(ref);
    if (!target) {
      pathEl.removeAttribute(`data-godot-${end}`);
      pathEl.removeAttribute(`data-godot-${end}-anchor`);
      return null;
    }
    return {
      target,
      anchor: pathEl.getAttribute(`data-godot-${end}-anchor`) || 'auto',
    };
  }

  /** Every connector path element in the layer. */
  connectors() {
    const layer = this._view._layer;
    if (!layer) return [];
    return Array.from(
      layer.querySelectorAll('path[data-godot-from], path[data-godot-to]')
    );
  }

  /**
   * Reroute every connector affected by a change to the given ids (or
   * that is itself in the moved set — moving a connector wholesale must
   * keep its attached ends pinned to the borders).
   * @param {Set<string>|null} ids - null reroutes everything.
   */
  rerouteFor(ids = null) {
    for (const pathEl of this.connectors()) {
      if (
        ids === null ||
        ids.has(pathEl.getAttribute('data-godot-from')) ||
        ids.has(pathEl.getAttribute('data-godot-to')) ||
        ids.has(pathEl.id)
      ) {
        this.reroute(pathEl);
      }
    }
  }

  /** Detach any connector ends referencing the given (deleted) ids. */
  detachReferences(ids) {
    for (const pathEl of this.connectors()) {
      for (const end of ['from', 'to']) {
        const ref = pathEl.getAttribute(`data-godot-${end}`);
        if (ref && ids.has(ref)) {
          pathEl.removeAttribute(`data-godot-${end}`);
          pathEl.removeAttribute(`data-godot-${end}-anchor`);
        }
      }
    }
  }

  /**
   * Remap connector references among freshly duplicated clones: a clone
   * whose from/to points at an ORIGINAL that was cloned in the same
   * gesture re-attaches to the clone instead.
   * @param {Map<string,string>} idMap - original id → clone id.
   * @param {Element[]} clones
   */
  remapClones(idMap, clones) {
    for (const el of clones) {
      const paths = [];
      if (el.tagName && el.tagName.toLowerCase() === 'path') paths.push(el);
      paths.push(...el.querySelectorAll('path[data-godot-from], path[data-godot-to]'));
      for (const p of paths) {
        for (const end of ['from', 'to']) {
          const ref = p.getAttribute(`data-godot-${end}`);
          if (ref && idMap.has(ref)) {
            p.setAttribute(`data-godot-${end}`, idMap.get(ref));
          }
        }
      }
    }
  }
}
