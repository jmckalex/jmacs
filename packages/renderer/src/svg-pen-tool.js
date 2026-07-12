/**
 * @file The SVG editor's pen tool — click to place corner anchors,
 * click-drag to pull out symmetric Bezier handles, Enter / double-click
 * to commit an open path, click on the first anchor to close, Escape to
 * cancel, Backspace to remove the last anchor. Preview rides the
 * overlay; the committed `<path>` carries `data-godot-shape="path"`.
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

const SVG_NS = 'http://www.w3.org/2000/svg';

export class SvgPenTool {
  /** @param {object} view - the hosting svg-editor-view. */
  constructor(view) {
    this._view = view;
    this._anchors = [];
    this._drag = null; // { index } while pulling out a handle
    this._hover = null;
    this._active = false;
  }

  /** Whether a path is under construction. */
  get drawing() {
    return this._active && this._anchors.length > 0;
  }

  activate() {
    this._active = true;
    this._reset();
  }

  deactivate() {
    // Commit whatever is in progress rather than silently dropping it —
    // switching tools mid-path is a "done drawing" gesture.
    if (this._anchors.length >= 2) this.commit(false);
    this._active = false;
    this._reset();
  }

  _reset() {
    this._anchors = [];
    this._drag = null;
    this._hover = null;
    this._view.clearOverlayExtras('pen');
  }

  /** The model under construction (open). */
  _model() {
    return { closed: false, anchors: this._anchors };
  }

  pointerDown(p) {
    if (!this._active) return;
    // Clicking the first anchor with ≥ 3 anchors closes the path.
    if (this._anchors.length >= 3) {
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

  pointerMove(p) {
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
    if (this._anchors.length < 2) {
      this.cancel();
      return;
    }
    const model = { closed: !!closed, anchors: this._anchors };
    // The first anchor of a closed smooth path keeps its pulled handle
    // pair; nothing special to do — pathDataFromModel emits the closing
    // segment from the anchors as they stand.
    const d = pathDataFromModel(model);
    const view = this._view;
    view.pushUndo();
    const el = view.appendMarkup(
      `<path id="${view.allocId()}" data-godot-shape="path" d="${d}" ` +
        `fill="none" stroke="#222222" stroke-width="2"/>`
    );
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
    }
    return false;
  }

  /** Draw the in-progress path + rubber segment + anchor dots. */
  _preview() {
    const view = this._view;
    const layer = view.overlayExtrasLayer('pen');
    layer.replaceChildren();
    if (this._anchors.length === 0) return;
    const doc = layer.ownerDocument;

    const model = this._model();
    if (this._anchors.length >= 2) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', pathDataFromModel(model));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      layer.append(path);
    }
    // Rubber segment from the last anchor to the hover point.
    const last = this._anchors[this._anchors.length - 1];
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
    // possible (≥ 3 anchors).
    this._anchors.forEach((a, i) => {
      const dot = this._dot(doc, a.x, a.y, 'rect');
      if (i === 0 && this._anchors.length >= 3) dot.classList.add('svg-editor-close-target');
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
