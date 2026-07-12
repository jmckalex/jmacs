/**
 * @file The SVG editor's node-edit tool — direct editing of a path's
 * anchors and Bezier control handles (and a line's endpoints).
 *
 * Attach it to a `<path>` whose `d` parses (svg-path-model.js) or a
 * `<line>`. It then draws the anchor squares on the overlay; clicking an
 * anchor makes it active (revealing its control handles), dragging moves
 * anchors / handles (Alt breaks handle symmetry), double-clicking the
 * outline inserts an anchor, double-clicking an anchor toggles it
 * corner ⇄ smooth, and Delete removes the active anchor. Paths whose
 * `d` doesn't parse (arcs, multi-subpath) are not editable — the view
 * leaves them select-only.
 */

import {
  parsePathData,
  pathDataFromModel,
  movePathAnchor,
  setPathHandle,
  nearestPointOnPath,
  insertAnchor,
  removeAnchor,
} from './svg-path-model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class SvgNodeEditTool {
  /** @param {object} view - the hosting svg-editor-view. */
  constructor(view) {
    this._view = view;
    this._target = null; // the <path> or <line> being edited
    this._mode = null; // 'path' | 'line'
    this._model = null; // path model when mode === 'path'
    this._activeAnchor = null; // index (path) or 0|1 (line endpoints)
    this._drag = null;
    this._active = false;
  }

  get target() {
    return this._target;
  }

  get activeAnchorIndex() {
    return this._activeAnchor;
  }

  activate() {
    this._active = true;
    // Auto-attach to the current single selection when editable.
    const sel = this._view.selectionList();
    if (sel.length === 1) this.attach(sel[0]);
    this._draw();
  }

  deactivate() {
    this._active = false;
    this.detach();
  }

  /**
   * Try to attach to an element. Returns true when it is node-editable.
   * @param {Element} el
   */
  attach(el) {
    this.detach();
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'line') {
      this._target = el;
      this._mode = 'line';
      this._draw();
      return true;
    }
    if (tag === 'path') {
      const model = parsePathData(el.getAttribute('d') || '');
      if (model) {
        this._target = el;
        this._mode = 'path';
        this._model = model;
        this._draw();
        return true;
      }
    }
    this._draw();
    return false;
  }

  detach() {
    this._target = null;
    this._mode = null;
    this._model = null;
    this._activeAnchor = null;
    this._drag = null;
    if (this._view) this._view.clearOverlayExtras('node-edit');
  }

  /** The anchor positions for hit-testing / drawing. */
  _anchorPoints() {
    if (this._mode === 'line') {
      const el = this._target;
      return [
        { x: Number(el.getAttribute('x1')), y: Number(el.getAttribute('y1')) },
        { x: Number(el.getAttribute('x2')), y: Number(el.getAttribute('y2')) },
      ];
    }
    if (this._mode === 'path') return this._model.anchors.map((a) => ({ x: a.x, y: a.y }));
    return [];
  }

  /**
   * Pointer down in node-edit mode. Returns true when the event was
   * consumed (a handle / anchor / outline grab), false to let the view
   * hit-test a new attach target.
   */
  pointerDown(p, event) {
    if (!this._active || !this._target) return false;
    const tol = this._view.handleTolerance() * 1.4;

    // 1. The active anchor's control handles (path mode only). A handle
    // sitting on its anchor (zero-length) is not grabbable — the anchor
    // wins.
    if (this._mode === 'path' && this._activeAnchor != null) {
      const a = this._model.anchors[this._activeAnchor];
      for (const side of ['in', 'out']) {
        const h = side === 'in' ? a.hIn : a.hOut;
        if (!h || Math.hypot(h.x - a.x, h.y - a.y) < 1e-6) continue;
        if (Math.hypot(p.x - h.x, p.y - h.y) <= tol) {
          this._view.pushUndo();
          this._drag = { type: 'handle', side, index: this._activeAnchor, free: event.altKey };
          return true;
        }
      }
    }

    // 2. Anchors.
    const anchors = this._anchorPoints();
    for (let i = anchors.length - 1; i >= 0; i -= 1) {
      if (Math.hypot(p.x - anchors[i].x, p.y - anchors[i].y) <= tol) {
        this._activeAnchor = i;
        this._view.pushUndo();
        this._drag = { type: 'anchor', index: i, last: p };
        this._draw();
        return true;
      }
    }

    // 3. The outline: grab to keep editing this target (prevents an
    // accidental re-attach while aiming for a segment double-click).
    if (this._mode === 'path' && this._model) {
      const near = nearestPointOnPath(this._model, p);
      if (near && near.dist <= tol) {
        this._activeAnchor = null;
        this._draw();
        return true;
      }
    }
    return false;
  }

  pointerMove(p, event) {
    if (!this._drag || !this._target) return;
    if (this._mode === 'line') {
      const el = this._target;
      const n = this._drag.index === 0 ? ['x1', 'y1'] : ['x2', 'y2'];
      el.setAttribute(n[0], String(Math.round(p.x * 100) / 100));
      el.setAttribute(n[1], String(Math.round(p.y * 100) / 100));
      this._view.refreshAttachedMarkers(el);
    } else if (this._drag.type === 'anchor') {
      const dx = p.x - this._drag.last.x;
      const dy = p.y - this._drag.last.y;
      this._drag.last = p;
      this._model = movePathAnchor(this._model, this._drag.index, dx, dy);
      this._writeModel();
    } else if (this._drag.type === 'handle') {
      const mode = this._drag.free || event.altKey ? 'free' : 'symmetric';
      this._model = setPathHandle(this._model, this._drag.index, this._drag.side, p, mode);
      this._writeModel();
    }
    this._draw();
    this._view.redrawSelection();
  }

  pointerUp() {
    if (!this._drag) return;
    this._drag = null;
    this._view.notifyChange();
  }

  /**
   * Double-click: on the outline → insert an anchor there; on an anchor →
   * toggle corner ⇄ smooth. Returns true when consumed.
   */
  dblClick(p) {
    if (!this._active || !this._target || this._mode !== 'path') return false;
    const tol = this._view.handleTolerance() * 1.4;
    const anchors = this._anchorPoints();
    for (let i = 0; i < anchors.length; i += 1) {
      if (Math.hypot(p.x - anchors[i].x, p.y - anchors[i].y) <= tol) {
        this._view.pushUndo();
        this._toggleSmooth(i);
        this._writeModel();
        this._draw();
        this._view.notifyChange();
        return true;
      }
    }
    const near = nearestPointOnPath(this._model, p);
    if (near && near.dist <= tol) {
      this._view.pushUndo();
      this._model = insertAnchor(this._model, near.seg, Math.max(0.05, Math.min(0.95, near.t)));
      this._activeAnchor = near.seg + 1;
      this._writeModel();
      this._draw();
      this._view.notifyChange();
      return true;
    }
    return false;
  }

  /** Corner (no handles) ⇄ smooth (auto handles along the tangent). */
  _toggleSmooth(i) {
    const a = this._model.anchors[i];
    if (a.hIn || a.hOut) {
      a.hIn = null;
      a.hOut = null;
      this._activeAnchor = i;
      return;
    }
    // Grow handles along the neighbour direction, a third of each way.
    const n = this._model.anchors.length;
    const prev = this._model.anchors[(i - 1 + n) % n];
    const next = this._model.anchors[(i + 1) % n];
    const dir = { x: next.x - prev.x, y: next.y - prev.y };
    const len = Math.hypot(dir.x, dir.y) || 1;
    const ux = dir.x / len;
    const uy = dir.y / len;
    const reach = Math.min(len / 3, 40);
    a.hIn = { x: a.x - ux * reach, y: a.y - uy * reach };
    a.hOut = { x: a.x + ux * reach, y: a.y + uy * reach };
    this._activeAnchor = i;
  }

  /**
   * Delete the active anchor. Returns true when consumed (even if the
   * removal was refused because the path would degenerate).
   */
  deleteActiveAnchor() {
    if (this._mode !== 'path' || this._activeAnchor == null) return false;
    const next = removeAnchor(this._model, this._activeAnchor);
    if (next) {
      this._view.pushUndo();
      this._model = next;
      this._activeAnchor = null;
      this._writeModel();
      this._draw();
      this._view.notifyChange();
    }
    return true;
  }

  keyDown(event) {
    if (!this._active || !this._target) return false;
    if ((event.key === 'Delete' || event.key === 'Backspace') && this._activeAnchor != null) {
      return this.deleteActiveAnchor();
    }
    if (event.key === 'Escape' && this._activeAnchor != null) {
      this._activeAnchor = null;
      this._draw();
      return true;
    }
    return false;
  }

  _writeModel() {
    if (this._mode !== 'path' || !this._target) return;
    this._target.setAttribute('d', pathDataFromModel(this._model));
  }

  /** Redraw the anchor / handle overlay. */
  _draw() {
    const view = this._view;
    if (!view) return;
    const layer = view.overlayExtrasLayer('node-edit');
    layer.replaceChildren();
    if (!this._active || !this._target) return;
    const doc = layer.ownerDocument;
    const r = view.handleTolerance() * 0.8;

    // Control cage + handles for the active path anchor.
    if (this._mode === 'path' && this._activeAnchor != null) {
      const a = this._model.anchors[this._activeAnchor];
      for (const h of [a.hIn, a.hOut]) {
        if (!h) continue;
        const stem = doc.createElementNS(SVG_NS, 'line');
        stem.setAttribute('x1', a.x);
        stem.setAttribute('y1', a.y);
        stem.setAttribute('x2', h.x);
        stem.setAttribute('y2', h.y);
        stem.setAttribute('class', 'svg-editor-handle-stem');
        stem.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
        stem.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.append(stem);
        const dot = doc.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', h.x);
        dot.setAttribute('cy', h.y);
        dot.setAttribute('r', r * 0.9);
        dot.setAttribute('class', 'svg-editor-ctrl-dot');
        dot.setAttribute('fill', '#ffffff');
        dot.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
        dot.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.append(dot);
      }
    }

    // Anchor squares (active one filled).
    this._anchorPoints().forEach((pt, i) => {
      const dot = doc.createElementNS(SVG_NS, 'rect');
      dot.setAttribute('x', pt.x - r);
      dot.setAttribute('y', pt.y - r);
      dot.setAttribute('width', 2 * r);
      dot.setAttribute('height', 2 * r);
      dot.setAttribute('class', 'svg-editor-anchor-dot');
      dot.setAttribute(
        'fill',
        i === this._activeAnchor ? 'var(--svg-editor-accent, #2d8cf0)' : '#ffffff'
      );
      dot.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
      dot.setAttribute('vector-effect', 'non-scaling-stroke');
      layer.append(dot);
    });
  }

  /** Re-sync the model after an external change to the target's `d`. */
  resync() {
    if (this._mode === 'path' && this._target) {
      const model = parsePathData(this._target.getAttribute('d') || '');
      if (model) this._model = model;
    }
    this._draw();
  }
}
