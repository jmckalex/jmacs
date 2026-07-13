/**
 * @file The SVG editor's pen tool — click to place corner anchors,
 * click-drag to pull out symmetric Bezier handles, Enter / double-click
 * to commit an open path, click on the first anchor to close, Escape to
 * cancel, Backspace to remove the last anchor. Preview rides the
 * overlay; the committed `<path>` carries `data-godot-shape="path"`.
 *
 * TikZ-style connectors: clicking a connectable shape (a node, rect or
 * ellipse) STARTS a connector from its border — near a compass anchor
 * pins that anchor, elsewhere uses `auto` (border-toward-next, live).
 * Clicking a shape while drawing TERMINATES the path at its border and
 * commits with an arrowhead whose tip sits exactly on the border. The
 * endpoints stay attached (`data-godot-from`/`-to`) and re-route when
 * the shapes move. Shift-click bypasses the snapping for a plain path.
 *
 * The tool holds a path model (svg-path-model.js) under construction and
 * only touches the document on commit. The hosting `<svg-editor-view>`
 * routes pointer / key events here while the `pen` tool is active.
 */

import {
  makeAnchor,
  pathDataFromModel,
  setPathHandle,
} from './svg-path-model.js';
import {
  connectorEndpoint,
  borderAnchorPoint,
  nearestCompassAnchor,
  COMPASS_ANCHORS,
} from './svg-connect.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class SvgPenTool {
  /** @param {object} view - the hosting svg-editor-view. */
  constructor(view) {
    this._view = view;
    this._anchors = [];
    this._drag = null; // { index } while pulling out a handle
    this._hover = null;
    this._from = null; // { id, anchor } when the path starts on a shape
    this._hoverConn = null; // connectable under the cursor (affordance)
    this._active = false;
  }

  /** Whether a path is under construction. */
  get drawing() {
    return this._active && (this._anchors.length > 0 || this._from !== null);
  }

  activate() {
    this._active = true;
    this._reset();
  }

  deactivate() {
    // Commit whatever is in progress rather than silently dropping it —
    // switching tools mid-path is a "done drawing" gesture.
    if (this._anchors.length >= 2 || (this._from && this._anchors.length >= 1)) {
      this.commit(false);
    }
    this._active = false;
    this._reset();
  }

  _reset() {
    this._anchors = [];
    this._drag = null;
    this._hover = null;
    this._from = null;
    this._hoverConn = null;
    this._view.clearOverlayExtras('pen');
  }

  /** The model under construction (open). */
  _model() {
    return { closed: false, anchors: this._anchors };
  }

  /**
   * The attachment for a click on a connectable: a compass anchor when
   * the click clearly aims at one — near it AND nearer to it than to the
   * shape's centre (so a centre click on a small node stays `auto`).
   */
  _pickAnchor(conn, p) {
    const near = nearestCompassAnchor(conn.spec, p);
    const toCenter = Math.hypot(p.x - conn.center.x, p.y - conn.center.y);
    const anchor =
      near && near.dist <= this._view.handleTolerance() * 1.5 && near.dist < toCenter
        ? near.name
        : 'auto';
    return { id: conn.id, anchor };
  }

  /** The live from-endpoint, aimed at `aim` (auto follows the aim). */
  _fromPoint(aim) {
    if (!this._from) return null;
    const conn = this._view.connections.connectableById(this._from.id);
    if (!conn) return null;
    return connectorEndpoint(conn.spec, this._from.anchor, aim);
  }

  pointerDown(p, event) {
    if (!this._active) return;

    // Connectable shapes: start a connector, or terminate into one.
    // Near-border clicks count — the compass dots straddle the border.
    const conn = event && event.shiftKey
      ? null
      : this._view.connections.connectableNear(p, this._view.handleTolerance() * 2);
    if (conn) {
      const started = this._from !== null || this._anchors.length > 0;
      if (!started) {
        this._from = this._pickAnchor(conn, p);
        this._preview();
        return;
      }
      // Ignore a degenerate self-edge (re-click on the start shape with
      // nothing drawn in between).
      if (!(this._from && this._from.id === conn.id && this._anchors.length === 0)) {
        this._commitConnector(this._pickAnchor(conn, p));
      }
      return;
    }

    // Clicking the first anchor with ≥ 3 anchors closes the path.
    if (!this._from && this._anchors.length >= 3) {
      const first = this._anchors[0];
      if (Math.hypot(p.x - first.x, p.y - first.y) <= this._view.handleTolerance() * 1.5) {
        this.commit(true);
        return;
      }
    }
    this._anchors.push(makeAnchor(p.x, p.y));
    this._drag = { index: this._anchors.length - 1, from: p, moved: false };
    this._preview();
  }

  pointerMove(p, event) {
    if (!this._active) return;
    if (this._drag) {
      const { index, from } = this._drag;
      if (!this._drag.moved && Math.hypot(p.x - from.x, p.y - from.y) > this._view.handleTolerance() / 2) {
        this._drag.moved = true;
      }
      if (this._drag.moved) {
        // Pull out symmetric handles from the just-placed anchor.
        const next = setPathHandle(this._model(), index, 'out', p, 'symmetric');
        // setPathHandle mirrors onto hIn only when present; force smooth:
        const a = next.anchors[index];
        a.hIn = { x: 2 * a.x - p.x, y: 2 * a.y - p.y };
        this._anchors = next.anchors;
      }
    } else {
      this._hover = p;
      this._hoverConn = event && event.shiftKey
        ? null
        : this._view.connections.connectableNear(p, this._view.handleTolerance() * 2);
    }
    this._preview();
  }

  pointerUp() {
    if (!this._active) return;
    this._drag = null;
    this._preview();
  }

  /** Enter / double-click. */
  commit(closed) {
    if (this._from) {
      // A from-attached open path needs at least one drawn anchor; the
      // from endpoint aims at it. (Closing an attached path makes no
      // sense — treat as open.)
      if (this._anchors.length < 1) {
        this.cancel();
        return;
      }
      const fromPt = this._fromPoint(this._anchors[0]);
      if (!fromPt) {
        this.cancel();
        return;
      }
      const anchors = [makeAnchor(fromPt.x, fromPt.y), ...this._anchors];
      this._buildPath(anchors, { from: this._from, to: null });
      return;
    }
    if (this._anchors.length < 2) {
      this.cancel();
      return;
    }
    // The first anchor of a closed smooth path keeps its pulled handle
    // pair; nothing special to do — pathDataFromModel emits the closing
    // segment from the anchors as they stand.
    this._buildPath(this._anchors, { closed: !!closed });
  }

  /** Terminate the path on a shape: compute both endpoints and commit. */
  _commitConnector(to) {
    const view = this._view;
    const toC = view.connections.connectableById(to.id);
    if (!toC) {
      this.commit(false);
      return;
    }
    const interior = this._anchors;
    const fromC = this._from ? view.connections.connectableById(this._from.id) : null;
    if (!fromC && interior.length === 0) {
      this.cancel();
      return;
    }
    const toAim = interior.length ? interior[interior.length - 1] : fromC.center;
    const toPt = connectorEndpoint(toC.spec, to.anchor, toAim);
    const anchors = [];
    if (fromC) {
      const fromAim = interior.length ? interior[0] : toC.center;
      const fromPt = connectorEndpoint(fromC.spec, this._from.anchor, fromAim);
      anchors.push(makeAnchor(fromPt.x, fromPt.y));
    }
    anchors.push(...interior);
    anchors.push(makeAnchor(toPt.x, toPt.y));
    this._buildPath(anchors, { from: fromC ? this._from : null, to });
  }

  /** Append the committed path element with attachment attrs + arrow. */
  _buildPath(anchors, opts = {}) {
    const view = this._view;
    const d = pathDataFromModel({ closed: !!opts.closed, anchors });
    const stroke = '#222222';
    view.pushUndo();
    const el = view.appendMarkup(
      `<path id="${view.allocId()}" data-godot-shape="path" d="${d}" ` +
        `fill="none" stroke="${stroke}" stroke-width="2"/>`
    );
    if (opts.from) {
      el.setAttribute('data-godot-from', opts.from.id);
      el.setAttribute('data-godot-from-anchor', opts.from.anchor);
    }
    if (opts.to) {
      el.setAttribute('data-godot-to', opts.to.id);
      el.setAttribute('data-godot-to-anchor', opts.to.anchor);
      // A connector is an edge: it gets an arrowhead by default (toggle
      // it off in the properties panel).
      el.setAttribute('marker-end', view.markerRef(stroke));
    }
    this._reset();
    view.setTool('select');
    view.selectOnly(el);
    view.notifyChange();
  }

  cancel() {
    this._reset();
    this._view.setTool('select');
  }

  /** Backspace: drop the last-placed anchor. */
  removeLastAnchor() {
    if (this._anchors.length === 0) return;
    this._anchors.pop();
    this._preview();
  }

  keyDown(event) {
    if (!this._active) return false;
    if (event.key === 'Enter') {
      this.commit(false);
      return true;
    }
    if (event.key === 'Escape') {
      this.cancel();
      return true;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      if (this._anchors.length > 0) {
        this.removeLastAnchor();
        return true;
      }
      if (this._from) {
        this._from = null;
        this._preview();
        return true;
      }
    }
    return false;
  }

  /**
   * Draw the in-progress path (including the live from-endpoint), the
   * rubber segment, handle stems, anchor dots, and the compass anchor
   * affordance on the hovered connectable.
   */
  _preview() {
    const view = this._view;
    const layer = view.overlayExtrasLayer('pen');
    layer.replaceChildren();
    const doc = layer.ownerDocument;

    // Compass dots on the shape under the cursor (aim assistance); the
    // one a click would pin is highlighted — same rule as _pickAnchor.
    if (this._hoverConn && !this._drag) {
      const pick = this._hover ? this._pickAnchor(this._hoverConn, this._hover) : null;
      for (const name of COMPASS_ANCHORS) {
        const pt = borderAnchorPoint(this._hoverConn.spec, name);
        if (!pt) continue;
        const dot = this._dot(doc, pt.x, pt.y, 'circle');
        dot.classList.add('svg-editor-anchor-target');
        if (pick && pick.anchor === name) {
          dot.classList.add('svg-editor-close-target');
        }
        layer.append(dot);
      }
    }

    // The from-endpoint, live: auto anchors track the aim point.
    let fromPt = null;
    if (this._from) {
      const aim = this._anchors[0] ?? this._hover;
      if (aim || this._from.anchor !== 'auto') {
        fromPt = this._fromPoint(aim ?? { x: 0, y: 0 });
      }
      if (fromPt) {
        const dot = this._dot(doc, fromPt.x, fromPt.y, 'circle');
        dot.classList.add('svg-editor-close-target');
        layer.append(dot);
      }
    }

    const pts = [
      ...(fromPt ? [makeAnchor(fromPt.x, fromPt.y)] : []),
      ...this._anchors,
    ];
    if (pts.length === 0) return;

    if (pts.length >= 2) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', pathDataFromModel({ closed: false, anchors: pts }));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      layer.append(path);
    }
    // Rubber segment from the last point to the hover point.
    const last = pts[pts.length - 1];
    if (this._hover && !this._drag) {
      const rubber = doc.createElementNS(SVG_NS, 'path');
      const c1 = last.hOut ?? last;
      rubber.setAttribute(
        'd',
        `M ${last.x} ${last.y} C ${c1.x} ${c1.y} ${this._hover.x} ${this._hover.y} ` +
          `${this._hover.x} ${this._hover.y}`
      );
      rubber.setAttribute('fill', 'none');
      rubber.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
      rubber.setAttribute('stroke-dasharray', '4 3');
      rubber.setAttribute('vector-effect', 'non-scaling-stroke');
      layer.append(rubber);
    }
    // Handle stems + dots while pulling out a handle.
    if (this._drag && this._anchors[this._drag.index]) {
      const a = this._anchors[this._drag.index];
      for (const h of [a.hIn, a.hOut]) {
        if (!h) continue;
        const stem = doc.createElementNS(SVG_NS, 'line');
        stem.setAttribute('x1', a.x);
        stem.setAttribute('y1', a.y);
        stem.setAttribute('x2', h.x);
        stem.setAttribute('y2', h.y);
        stem.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
        stem.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.append(stem);
        layer.append(this._dot(doc, h.x, h.y, 'circle'));
      }
    }
    // Anchor squares; the first anchor is highlighted when closing is
    // possible (≥ 3 anchors, plain paths only).
    this._anchors.forEach((a, i) => {
      const dot = this._dot(doc, a.x, a.y, 'rect');
      if (!this._from && i === 0 && this._anchors.length >= 3) {
        dot.classList.add('svg-editor-close-target');
      }
      layer.append(dot);
    });
  }

  _dot(doc, x, y, kind) {
    const r = this._view.handleTolerance() * 0.7;
    let el;
    if (kind === 'circle') {
      el = doc.createElementNS(SVG_NS, 'circle');
      el.setAttribute('cx', x);
      el.setAttribute('cy', y);
      el.setAttribute('r', r);
    } else {
      el = doc.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', x - r);
      el.setAttribute('y', y - r);
      el.setAttribute('width', 2 * r);
      el.setAttribute('height', 2 * r);
    }
    el.setAttribute('class', 'svg-editor-pen-dot');
    el.setAttribute('fill', '#ffffff');
    el.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
    return el;
  }
}
