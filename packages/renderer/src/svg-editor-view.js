/**
 * @file `<svg-editor-view>` — an Inkscape-like vector-drawing view.
 *
 * The element owns a live inline `<svg>` (the document model: the DOM IS
 * the model, per plans/SVG-EDITOR.md) plus a same-viewBox overlay `<svg>`
 * for selection handles / previews, both inside a `.svg-editor-canvas`
 * wrapper that carries the zoom / pan CSS transform (so viewport state is
 * never written into the document). A tool palette and action strip sit
 * across the top; a properties sidebar reflects the selection.
 *
 * Tools: select (multi-select, move, resize, line endpoints), rect,
 * ellipse, line, pen (Bezier paths), node (TikZ-style text / math labels
 * with fitted borders), and node-edit (anchors + control handles).
 * Snapshot undo / redo, duplicate, z-order, wheel zoom, space-drag pan,
 * and host-backed file save / open round it out.
 *
 * The logic-heavy parts live in pure, unit-tested modules:
 *  - svg-geometry.js    — bbox, hit-test, resize, screen<->user transforms
 *  - svg-document.js    — shape markup, id allocation, markers, save strip
 *  - svg-mathjax-ids.js — per-box MathJax defs id de-collision
 *  - svg-path-model.js  — the Bezier path model (pen / node-edit)
 *  - svg-node.js        — TikZ node classification + border fitting
 *  - svg-properties.js  — the properties-panel descriptor schema
 *
 * The DOM-touching class itself is exercised live in Electron (the
 * renderer test suite runs under Node without a DOM); the pure helpers
 * carry the test coverage.
 */

import { defineViewElement, ViewElement } from './view-elements.js';
import {
  normalizeRect,
  rectFromPoints,
  pointInRect,
  rectsIntersect,
  handlePositions,
  handleAtPoint,
  resizeRect,
  screenToUser,
  distToSegment,
} from './svg-geometry.js';
import {
  SVG_NS,
  blankDocument,
  nextId,
  rectMarkup,
  ellipseMarkup,
  lineMarkup,
  stripGodotAttributes,
  withXmlProlog,
  arrowMarkerId,
  arrowMarkerMarkup,
} from './svg-document.js';
import { namespaceMathBox } from './svg-mathjax-ids.js';
import { typesetMath, whenMathJaxReady, isMathJaxReady } from './typeset-math.js';
import {
  parsePathData,
  pathDataFromModel,
  translatePath,
  resizePath,
  hitTestPath,
} from './svg-path-model.js';
import {
  NODE_DEFAULT_PADDING,
  texForNodeContent,
  fitNodeBorder,
  parseExLength,
  mathSvgPlacement,
  wrapNodeText,
} from './svg-node.js';
import { NODE_REBUILD_KEYS } from './svg-properties.js';
import { SvgPenTool } from './svg-pen-tool.js';
import { SvgNodeEditTool } from './svg-node-edit.js';
import { SvgInlineEditor } from './svg-inline-editor.js';
import { SvgPropertiesPanel } from './svg-properties-panel.js';
import { SvgConnections } from './svg-connections.js';

/** The drawing tools, in palette order. Each is `{ id, label, key }`. */
export const TOOLS = [
  { id: 'select', label: 'Select', key: 's' },
  { id: 'rect', label: 'Rect', key: 'r' },
  { id: 'ellipse', label: 'Ellipse', key: 'e' },
  { id: 'line', label: 'Line', key: 'l' },
  { id: 'pen', label: 'Pen', key: 'p' },
  { id: 'node', label: 'Node', key: 't' },
  { id: 'node-edit', label: 'Edit Pts', key: 'n' },
];

/** Map a single-character key to a tool id (for keyboard tool switching). */
export function toolForKey(key) {
  const t = TOOLS.find((tool) => tool.key === key);
  return t ? t.id : null;
}

const UNDO_LIMIT = 100;

export class SvgEditorView extends ViewElement {
  constructor() {
    super();
    this._buffer = null;
    this._pendingSvg = null;
    this._mounted = false;

    // DOM refs (built on connect)
    this._chrome = null;
    this._stage = null;
    this._canvas = null; // the zoom/pan wrapper
    this._doc = null; // the document <svg>
    this._overlay = null; // the overlay <svg>
    this._layer = null; // the main layer <g>
    this._propsEl = null;
    this._statusEl = null;
    this._fileLabel = null;

    // viewport
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._docSize = { width: 800, height: 600 };
    this._fitted = false;
    this._spacePan = false;

    // interaction state
    this._tool = 'select';
    /** @type {Set<Element>} */
    this._selection = new Set();
    this._drag = null;

    // document state
    this._undoStack = [];
    this._redoStack = [];
    this._dirty = false;
    this._filePath = null;
    this._forceNextSave = false;

    // controllers (built on mount)
    this._pen = null;
    this._nodeEdit = null;
    this._inline = null;
    this._panel = null;
  }

  get kind() {
    return 'svg-editor';
  }

  /**
   * Load a buffer. `buffer.svgText` (if present) is the file content;
   * otherwise we start from a blank document. (The element-view host
   * doesn't call this — it exists for direct embedding and tests.)
   */
  setBuffer(buffer) {
    this._buffer = buffer;
    this._pendingSvg =
      buffer && typeof buffer.svgText === 'string' ? buffer.svgText : null;
    if (this._mounted) this._loadDocument();
  }

  get buffer() {
    return this._buffer;
  }

  // --- lifecycle -------------------------------------------------------

  connectedCallback() {
    if (this._mounted) return;
    this._mount();
    this._loadDocument();
    this._mounted = true;
  }

  disconnectedCallback() {
    /* hide-not-kill: a move and a destroy look the same here */
  }

  destroy() {
    this._selection.clear();
    this._drag = null;
    this._buffer = null;
  }

  focus() {
    if (this._stage) this._stage.focus();
    else super.focus();
  }

  // --- mounting --------------------------------------------------------

  _mount() {
    const doc = this.ownerDocument;
    this.classList.add('svg-editor-view');

    // ── top chrome: tools, then actions ─────────────────────────────
    this._chrome = doc.createElement('div');
    this._chrome.className = 'svg-editor-palette';
    for (const tool of TOOLS) {
      const btn = doc.createElement('button');
      btn.className = 'svg-editor-tool';
      btn.dataset.tool = tool.id;
      btn.textContent = tool.label;
      btn.title = `${tool.label} (${tool.key})`;
      btn.addEventListener('click', () => this.setTool(tool.id));
      this._chrome.append(btn);
    }

    const spacer = doc.createElement('span');
    spacer.className = 'svg-editor-spacer';
    this._chrome.append(spacer);

    this._statusEl = doc.createElement('span');
    this._statusEl.className = 'svg-editor-status';
    this._chrome.append(this._statusEl);

    this._fileLabel = doc.createElement('span');
    this._fileLabel.className = 'svg-editor-file';
    this._chrome.append(this._fileLabel);

    const actions = [
      ['Undo', 'M-z', () => this.undo()],
      ['Redo', 'M-S-z', () => this.redo()],
      ['−', 'zoom out', () => this.zoomBy(1 / 1.25)],
      ['⌖', 'zoom to fit', () => this.zoomToFit()],
      ['+', 'zoom in', () => this.zoomBy(1.25)],
      ['Open…', 'open a .svg file', () => this.openDialog()],
      ['Save', 'M-s', () => this.save(false)],
      ['Save As…', 'M-S-s', () => this.save(true)],
      ['Export…', 'clean SVG without editor metadata', () => this.exportClean()],
    ];
    for (const [label, title, fn] of actions) {
      const btn = doc.createElement('button');
      btn.className = 'svg-editor-action';
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', fn);
      this._chrome.append(btn);
    }

    // ── body: stage + properties sidebar ────────────────────────────
    const body = doc.createElement('div');
    body.className = 'svg-editor-body';

    this._stage = doc.createElement('div');
    this._stage.className = 'svg-editor-stage';
    this._stage.tabIndex = 0;

    this._propsEl = doc.createElement('div');
    this._propsEl.className = 'svg-editor-props';

    body.append(this._stage, this._propsEl);
    this.append(this._chrome, body);

    this._stage.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this._stage.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this._stage.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this._stage.addEventListener('keydown', (e) => this._onKeyDown(e));
    this._stage.addEventListener('keyup', (e) => this._onKeyUp(e));
    this._stage.addEventListener('dblclick', (e) => this._onDblClick(e));
    this._stage.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    this._connections = new SvgConnections(this);
    this._pen = new SvgPenTool(this);
    this._nodeEdit = new SvgNodeEditTool(this);
    this._inline = new SvgInlineEditor(this._stage);
    this._panel = new SvgPropertiesPanel(this._propsEl, this);

    // Fit once the stage has a real size.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (!this._fitted && this._stage.clientWidth > 0) this.zoomToFit();
      });
      ro.observe(this._stage);
    }

    this._reflectActiveTool();
    this._refreshChrome();
  }

  _loadDocument(opts = {}) {
    if (!this._stage) return;
    this._selection.clear();
    if (this._nodeEdit) this._nodeEdit.detach();
    if (this._inline) this._inline.close();

    const markup = this._pendingSvg || blankDocument();
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    let root = parsed.documentElement;
    if (!root || root.nodeName.toLowerCase() === 'parsererror') {
      this._status('Could not parse SVG — starting blank');
      root = new DOMParser().parseFromString(blankDocument(), 'image/svg+xml')
        .documentElement;
    }
    this._doc = /** @type {SVGSVGElement} */ (
      this.ownerDocument.importNode(root, true)
    );
    this._doc.classList.add('svg-editor-document');

    // Establish the document's user-space size: viewBox wins, else the
    // width/height attributes, else the default.
    const vb = (this._doc.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
      this._docSize = { width: vb[2], height: vb[3] };
    } else {
      const w = parseFloat(this._doc.getAttribute('width')) || 800;
      const h = parseFloat(this._doc.getAttribute('height')) || 600;
      this._docSize = { width: w, height: h };
      this._doc.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }

    this._layer =
      this._doc.querySelector('g[data-godot-layer="main"]') || this._ensureMainLayer();

    this._overlay = this.ownerDocument.createElementNS(SVG_NS, 'svg');
    this._overlay.classList.add('svg-editor-overlay');
    this._overlay.setAttribute('viewBox', this._doc.getAttribute('viewBox'));

    this._canvas = this.ownerDocument.createElement('div');
    this._canvas.className = 'svg-editor-canvas';
    this._canvas.style.width = `${this._docSize.width}px`;
    this._canvas.style.height = `${this._docSize.height}px`;
    this._canvas.append(this._doc, this._overlay);

    this._stage.replaceChildren(this._canvas);

    if (!opts.preserveView) {
      this._fitted = false;
      this.zoomToFit();
    } else {
      this._applyViewTransform();
    }
    this._redrawSelection();
    if (this._panel) this._panel.refresh();

    // Nodes whose math hasn't been typeset yet (a freshly opened file)
    // render once MathJax is up.
    this._rerenderPendingMath();
  }

  _ensureMainLayer() {
    const g = this.ownerDocument.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'layer');
    g.setAttribute('data-godot-layer', 'main');
    this._doc.append(g);
    return g;
  }

  /** Re-typeset every math-bearing group that has no rendered content. */
  _rerenderPendingMath() {
    if (!this._layer) return;
    const pending = Array.from(
      this._layer.querySelectorAll('[data-godot-latex]')
    ).filter((g) => g.getAttribute('data-godot-shape') === 'node' && !g.querySelector('[data-godot-role="content"]'));
    if (pending.length === 0) return;
    const rerender = () => {
      for (const g of pending) this._rebuildNodeContent(g);
      this._redrawSelection();
    };
    if (isMathJaxReady()) rerender();
    else whenMathJaxReady(rerender);
  }

  // --- viewport --------------------------------------------------------

  _applyViewTransform() {
    if (!this._canvas) return;
    this._canvas.style.transform =
      `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
  }

  /** Zoom about the stage centre (buttons) or a given stage point. */
  zoomBy(factor, at = null) {
    const stage = this._stage.getBoundingClientRect();
    const cx = at ? at.x : stage.width / 2;
    const cy = at ? at.y : stage.height / 2;
    const next = Math.min(16, Math.max(0.05, this._zoom * factor));
    const real = next / this._zoom;
    // Keep the point under (cx, cy) fixed.
    this._panX = cx - real * (cx - this._panX);
    this._panY = cy - real * (cy - this._panY);
    this._zoom = next;
    this._applyViewTransform();
    this._redrawSelection();
  }

  zoomToFit() {
    if (!this._stage || this._stage.clientWidth === 0) return;
    const sw = this._stage.clientWidth;
    const sh = this._stage.clientHeight;
    const { width: w, height: h } = this._docSize;
    const zoom = Math.min(sw / w, sh / h) * 0.94;
    this._zoom = Math.min(2, Math.max(0.05, zoom));
    this._panX = (sw - w * this._zoom) / 2;
    this._panY = (sh - h * this._zoom) / 2;
    this._fitted = true;
    this._applyViewTransform();
    this._redrawSelection();
  }

  _onWheel(event) {
    event.preventDefault();
    const rect = this._stage.getBoundingClientRect();
    if (event.metaKey || event.ctrlKey) {
      const factor = Math.exp(-event.deltaY * 0.01);
      this.zoomBy(factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else {
      this._panX -= event.deltaX;
      this._panY -= event.deltaY;
      this._applyViewTransform();
    }
  }

  // --- tools -----------------------------------------------------------

  setTool(toolId) {
    if (!TOOLS.some((t) => t.id === toolId)) return;
    if (this._tool === toolId) return;
    if (this._tool === 'pen') this._pen.deactivate();
    if (this._tool === 'node-edit') this._nodeEdit.deactivate();
    this._tool = toolId;
    if (toolId === 'pen') this._pen.activate();
    if (toolId === 'node-edit') this._nodeEdit.activate();
    this._reflectActiveTool();
  }

  get tool() {
    return this._tool;
  }

  _reflectActiveTool() {
    if (!this._chrome) return;
    for (const btn of this._chrome.querySelectorAll('.svg-editor-tool')) {
      btn.classList.toggle('active', btn.dataset.tool === this._tool);
    }
    if (this._stage) {
      this._stage.dataset.tool = this._tool;
    }
  }

  // --- coordinate helpers ---------------------------------------------

  /** Screen (clientX/Y) → SVG user space, via the document's CTM. */
  _toUser(clientX, clientY) {
    if (!this._doc) return { x: 0, y: 0 };
    const ctm = this._doc.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = screenToUser(
      { x: clientX, y: clientY },
      { a: ctm.a, b: ctm.b, c: ctm.c, d: ctm.d, e: ctm.e, f: ctm.f }
    );
    return pt || { x: 0, y: 0 };
  }

  /** User space → screen (clientX/Y). */
  _toScreen(pt) {
    const ctm = this._doc ? this._doc.getScreenCTM() : null;
    if (!ctm) return { x: 0, y: 0 };
    return { x: ctm.a * pt.x + ctm.c * pt.y + ctm.e, y: ctm.b * pt.x + ctm.d * pt.y + ctm.f };
  }

  handleTolerance() {
    if (!this._doc) return 6;
    const ctm = this._doc.getScreenCTM();
    const scale = ctm ? Math.hypot(ctm.a, ctm.b) || 1 : 1;
    return 6 / scale;
  }

  // --- selection API (used by controllers + panel) ----------------------

  /** The connector plumbing (pen + reroute use it). */
  get connections() {
    return this._connections;
  }

  /** Public face of the find-or-create arrow marker (pen commit). */
  markerRef(color) {
    return this._markerRef(color);
  }

  selectionList() {
    return Array.from(this._selection);
  }

  selectOnly(el) {
    this._selection.clear();
    if (el) this._selection.add(el);
    this._selectionChanged();
  }

  toggleSelect(el) {
    if (!el) return;
    if (this._selection.has(el)) this._selection.delete(el);
    else this._selection.add(el);
    this._selectionChanged();
  }

  clearSelection() {
    if (this._selection.size === 0) return;
    this._selection.clear();
    this._selectionChanged();
  }

  _selectionChanged() {
    this._redrawSelection();
    if (this._panel) this._panel.refresh();
  }

  // --- overlay layers ----------------------------------------------------

  /** A named `<g>` inside the overlay (selection / gesture / pen / …). */
  overlayExtrasLayer(name) {
    if (!this._overlay) return null;
    let g = this._overlay.querySelector(`g[data-extras="${name}"]`);
    if (!g) {
      g = this.ownerDocument.createElementNS(SVG_NS, 'g');
      g.setAttribute('data-extras', name);
      this._overlay.append(g);
    }
    return g;
  }

  clearOverlayExtras(name) {
    const g = this._overlay
      ? this._overlay.querySelector(`g[data-extras="${name}"]`)
      : null;
    if (g) g.replaceChildren();
  }

  // --- pointer handling ------------------------------------------------

  _onPointerDown(event) {
    if (this._inline && this._inline.active) {
      // Click-away commits explicitly — the blur handler can't tell a
      // deliberate canvas click from a stray focus steal, but we can.
      this._inline.commitNow();
      return;
    }
    const isPan = this._spacePan || event.button === 1;
    if (event.button !== 0 && !isPan) return;
    this._stage.focus();

    if (isPan) {
      this._drag = {
        mode: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        panX: this._panX,
        panY: this._panY,
        pointerId: event.pointerId,
      };
      this._stage.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    const p = this._toUser(event.clientX, event.clientY);

    if (this._tool === 'pen') {
      this._pen.pointerDown(p, event);
      this._drag = { mode: 'pen', pointerId: event.pointerId };
      this._stage.setPointerCapture(event.pointerId);
      return;
    }

    if (this._tool === 'node-edit') {
      if (this._nodeEdit.pointerDown(p, event)) {
        this._drag = { mode: 'node-edit', pointerId: event.pointerId };
        this._stage.setPointerCapture(event.pointerId);
        return;
      }
      // Not on a handle: try to attach to whatever was clicked.
      const hit = this._hitTest(p);
      if (hit && this._nodeEdit.attach(hit)) {
        this.selectOnly(hit);
      } else {
        this.selectOnly(hit);
      }
      return;
    }

    if (this._tool === 'select') {
      this._beginSelectGesture(p, event);
      return;
    }

    if (this._tool === 'node') {
      // Cancel the pointerdown's default action, or the browser focuses
      // the stage AFTER our handlers run and blurs the just-opened inline
      // editor shut (a flash the synthetic-event tests can't see).
      event.preventDefault();
      this._placeNode(p, event);
      return;
    }

    // Creation tools rubber-band.
    this._drag = {
      mode: 'create',
      tool: this._tool,
      startUser: p,
      curUser: p,
      pointerId: event.pointerId,
    };
    this._stage.setPointerCapture(event.pointerId);
  }

  _beginSelectGesture(p, event) {
    const single = this._selection.size === 1 ? this.selectionList()[0] : null;

    // Line endpoint handles (single selected line).
    if (single && single.tagName && single.tagName.toLowerCase() === 'line') {
      const tol = this.handleTolerance() * 1.4;
      const p1 = { x: Number(single.getAttribute('x1')), y: Number(single.getAttribute('y1')) };
      const p2 = { x: Number(single.getAttribute('x2')), y: Number(single.getAttribute('y2')) };
      const which = Math.hypot(p.x - p1.x, p.y - p1.y) <= tol ? 1
        : Math.hypot(p.x - p2.x, p.y - p2.y) <= tol ? 2 : 0;
      if (which) {
        this.pushUndo();
        this._drag = { mode: 'line-end', which, el: single, pointerId: event.pointerId };
        this._stage.setPointerCapture(event.pointerId);
        return;
      }
    }

    // Resize handles (single selection).
    if (single) {
      const bbox = this._bboxOf(single);
      if (bbox) {
        const handle = handleAtPoint(p, bbox, this.handleTolerance() * 1.4);
        if (handle) {
          this.pushUndo();
          this._drag = {
            mode: 'resize',
            handle,
            el: single,
            origBbox: bbox,
            pathModel: this._pathModelOf(single),
            origFontSize: this._fontSizeOf(single),
            origPadding: this._paddingOf(single),
            startUser: p,
            pointerId: event.pointerId,
          };
          this._stage.setPointerCapture(event.pointerId);
          return;
        }
      }
    }

    const hit = this._hitTest(p);
    if (hit) {
      if (event.shiftKey) {
        this.toggleSelect(hit);
      } else if (!this._selection.has(hit)) {
        this.selectOnly(hit);
      }
      if (this._selection.has(hit)) {
        this.pushUndo();
        this._drag = {
          mode: 'move',
          startUser: p,
          lastUser: p,
          moved: false,
          pathModels: this._capturePathModels(),
          transforms: this._captureForeignTransforms(),
          totals: { x: 0, y: 0 },
          pointerId: event.pointerId,
        };
        this._stage.setPointerCapture(event.pointerId);
      }
    } else {
      if (!event.shiftKey) this.clearSelection();
      this._drag = {
        mode: 'marquee',
        additive: event.shiftKey,
        startUser: p,
        curUser: p,
        pointerId: event.pointerId,
      };
      this._stage.setPointerCapture(event.pointerId);
    }
  }

  _onPointerMove(event) {
    if (!this._drag) {
      if (this._tool === 'pen') {
        this._pen.pointerMove(this._toUser(event.clientX, event.clientY), event);
      }
      return;
    }
    const drag = this._drag;
    if (drag.mode === 'pan') {
      this._panX = drag.panX + (event.clientX - drag.startX);
      this._panY = drag.panY + (event.clientY - drag.startY);
      this._applyViewTransform();
      return;
    }
    const p = this._toUser(event.clientX, event.clientY);
    switch (drag.mode) {
      case 'pen':
        this._pen.pointerMove(p, event);
        break;
      case 'node-edit':
        this._nodeEdit.pointerMove(p, event);
        break;
      case 'create':
        drag.curUser = p;
        this._previewCreate();
        break;
      case 'move': {
        drag.totals.x += p.x - drag.lastUser.x;
        drag.totals.y += p.y - drag.lastUser.y;
        const dx = p.x - drag.lastUser.x;
        const dy = p.y - drag.lastUser.y;
        drag.lastUser = p;
        drag.moved = true;
        this._moveSelection(dx, dy, drag);
        break;
      }
      case 'resize':
        this._resizeSelection(p, drag);
        break;
      case 'line-end': {
        const n = drag.which === 1 ? ['x1', 'y1'] : ['x2', 'y2'];
        this._setNum(drag.el, n[0], p.x);
        this._setNum(drag.el, n[1], p.y);
        this._redrawSelection();
        break;
      }
      case 'marquee':
        drag.curUser = p;
        this._previewMarquee();
        break;
      default:
        break;
    }
  }

  _onPointerUp(event) {
    if (!this._drag) return;
    const drag = this._drag;
    const p = this._toUser(event.clientX, event.clientY);
    try {
      this._stage.releasePointerCapture(event.pointerId);
    } catch {
      /* not captured */
    }
    this._drag = null;
    if (drag.mode === 'pen') {
      this._pen.pointerUp(p, event);
      return;
    }
    if (drag.mode === 'node-edit') {
      this._nodeEdit.pointerUp(p, event);
      return;
    }
    if (drag.mode === 'pan') return;
    if (drag.mode === 'create') {
      this._commitCreate(drag.startUser, p, drag.tool);
    } else if (drag.mode === 'marquee') {
      this._commitMarquee(drag.startUser, p, drag.additive);
    } else if (drag.mode === 'move') {
      if (drag.moved) this.notifyChange();
      else this._dropUnusedUndo();
    } else if (drag.mode === 'resize' || drag.mode === 'line-end') {
      this.notifyChange();
      // A resize can change panel-visible values (font size, padding).
      if (this._panel) this._panel.refresh();
    }
    this.clearOverlayExtras('gesture');
    this._redrawSelection();
  }

  // --- shape creation --------------------------------------------------

  _commitCreate(a, b, tool) {
    const rect = normalizeRect(rectFromPoints(a, b));
    if (tool !== 'line' && rect.width < 2 && rect.height < 2) return;
    if (tool === 'line' && Math.hypot(b.x - a.x, b.y - a.y) < 2) return;
    const id = this.allocId();
    let markup = null;
    if (tool === 'rect') {
      markup = rectMarkup({ id, ...rect });
    } else if (tool === 'ellipse') {
      markup = ellipseMarkup({ id, ...rect });
    } else if (tool === 'line') {
      markup = lineMarkup({ id, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    if (!markup) return;
    this.pushUndo();
    const el = this.appendMarkup(markup);
    this.setTool('select');
    this.selectOnly(el);
    this.notifyChange();
  }

  // --- TikZ-style nodes ---------------------------------------------------

  /** Click with the node tool: author a label in place. */
  _placeNode(p) {
    const screen = this._toScreen(p);
    this._inline.open({
      screenX: screen.x,
      screenY: screen.y,
      value: '',
      placeholder: 'text or $math$',
      onCommit: (value) => {
        this.pushUndo();
        const el = this._createNode(p, value);
        this.setTool('select');
        this.selectOnly(el);
        this.notifyChange();
        this._stage.focus();
      },
      onCancel: () => {
        this.setTool('select');
        this._stage.focus();
      },
    });
  }

  /**
   * Create a node group: centred content (text or typeset math) plus a
   * fitted border, at centre `p`.
   */
  _createNode(p, source) {
    const g = this.ownerDocument.createElementNS(SVG_NS, 'g');
    g.setAttribute('id', this.allocId());
    g.setAttribute('class', 'godot-node');
    g.setAttribute('data-godot-shape', 'node');
    g.setAttribute('data-godot-latex', source);
    g.setAttribute('data-godot-node-shape', 'rect');
    g.setAttribute('data-godot-padding', String(NODE_DEFAULT_PADDING));
    g.setAttribute('data-godot-font-size', '16');
    g.setAttribute('transform', `translate(${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100})`);
    this._layer.append(g);
    this._rebuildNodeContent(g);
    return g;
  }

  /**
   * (Re)build a node's content + border from its data attributes. Keeps
   * the border's paint attributes across rebuilds.
   */
  _rebuildNodeContent(g) {
    const source = g.getAttribute('data-godot-latex') ?? '';
    const fontSize = Number(g.getAttribute('data-godot-font-size')) || 16;
    const oldBorder = g.querySelector('[data-godot-role="border"]');
    const oldContent = g.querySelector('[data-godot-role="content"]');
    const contentFill = oldContent ? oldContent.getAttribute('fill') : null;
    const borderPaint = {};
    if (oldBorder) {
      for (const a of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray']) {
        const v = oldBorder.getAttribute(a);
        if (v != null) borderPaint[a] = v;
      }
    }
    if (oldBorder) oldBorder.remove();
    if (oldContent) oldContent.remove();

    const family = g.getAttribute('data-godot-font') || 'sans-serif';
    const wrapWidth = Number(g.getAttribute('data-godot-wrap-width')) || 0;
    const tex = texForNodeContent(source);
    let content = null;
    if (tex === null) {
      content = this._buildTextContent(source, fontSize, family, wrapWidth);
    } else {
      content = this._buildMathContent(g.id, tex, fontSize);
      if (!content) {
        // MathJax not ready, or a TeX error: show the raw source, flagged.
        content = this._buildTextContent(source, fontSize, family, wrapWidth);
        content.classList.add('svg-editor-math-invalid');
        if (!isMathJaxReady()) {
          whenMathJaxReady(() => {
            if (g.isConnected) {
              this._rebuildNodeContent(g);
              this._redrawSelection();
            }
          });
        }
      }
    }
    content.setAttribute('data-godot-role', 'content');
    if (contentFill) content.setAttribute('fill', contentFill);
    g.append(content);

    // Centre plain-text content vertically (math placement is already
    // centred via mathSvgPlacement).
    if (content.tagName.toLowerCase() === 'text') {
      try {
        const b = content.getBBox();
        const dy = -(b.y + b.height / 2);
        content.setAttribute('transform', `translate(0 ${Math.round(dy * 100) / 100})`);
      } catch {
        /* not laid out yet */
      }
    }

    this._refitNodeBorder(g, borderPaint);
  }

  /** Measure text with canvas metrics (matches the SVG text engine). */
  _measureText(text, fontSize, family) {
    if (!this._measureCtx) {
      this._measureCtx = this.ownerDocument.createElement('canvas').getContext('2d');
    }
    this._measureCtx.font = `${fontSize}px ${family}`;
    return this._measureCtx.measureText(text).width;
  }

  /**
   * Flowed `<text>` content: native typesetting in the node's font,
   * word-wrapped to the wrap width (0 = natural), centred per line —
   * a plain div's behaviour, in portable SVG tspans.
   */
  _buildTextContent(source, fontSize, family = 'sans-serif', wrapWidth = 0) {
    const doc = this.ownerDocument;
    const text = doc.createElementNS(SVG_NS, 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', String(fontSize));
    text.setAttribute('font-family', family);
    text.setAttribute('fill', '#222222');
    text.setAttribute('x', '0');
    text.setAttribute('y', '0');
    const lines = wrapNodeText(source, wrapWidth, (s) =>
      this._measureText(s, fontSize, family)
    );
    if (lines.length === 1) {
      text.textContent = lines[0];
    } else {
      lines.forEach((line, i) => {
        const tspan = doc.createElementNS(SVG_NS, 'tspan');
        tspan.setAttribute('x', '0');
        tspan.setAttribute('dy', i === 0 ? '0' : '1.25em');
        tspan.textContent = line || ' ';
        text.append(tspan);
      });
    }
    return text;
  }

  /**
   * Typeset `tex` and wrap MathJax's inner `<svg>` as an absolutely-sized
   * island centred at the origin (its glyph/defs ids namespaced per node).
   * Returns the content `<g>`, or null when MathJax isn't ready / errors.
   */
  _buildMathContent(nodeId, tex, fontSize) {
    const container = typesetMath(tex, { display: false });
    if (!container) return null;
    const inner = container.querySelector ? container.querySelector('svg') : null;
    if (!inner) return null;
    // MathJax marks TeX errors inside the output rather than returning
    // null; treat those as failures so the raw source stays visible.
    if (inner.querySelector('[data-mjx-error], merror')) return null;

    const exW = inner.getAttribute('width');
    const exH = inner.getAttribute('height');
    const namespaced = namespaceMathBox(inner.outerHTML, nodeId);
    const frag = new DOMParser().parseFromString(
      `<svg xmlns="${SVG_NS}">${namespaced}</svg>`,
      'image/svg+xml'
    ).documentElement;
    const island = this.ownerDocument.importNode(frag.firstElementChild, true);

    const place = mathSvgPlacement(exW, exH, fontSize);
    if (place) {
      island.setAttribute('width', String(Math.round(place.width * 100) / 100));
      island.setAttribute('height', String(Math.round(place.height * 100) / 100));
      island.setAttribute('x', String(Math.round(place.x * 100) / 100));
      island.setAttribute('y', String(Math.round(place.y * 100) / 100));
      // Remember the intrinsic ex size so font-size changes re-place
      // without re-typesetting.
      island.setAttribute('data-godot-ex-width', String(parseExLength(exW)));
      island.setAttribute('data-godot-ex-height', String(parseExLength(exH)));
    }
    island.removeAttribute('style'); // MathJax's vertical-align is for HTML flow

    const wrap = this.ownerDocument.createElementNS(SVG_NS, 'g');
    wrap.setAttribute('fill', '#222222');
    wrap.setAttribute('color', '#222222'); // MathJax paints via currentColor
    wrap.append(island);
    return wrap;
  }

  /** Re-place a node's math island for a new font size (no re-typeset). */
  _replaceMathIsland(g, fontSize) {
    const island = g.querySelector('[data-godot-role="content"] svg');
    if (!island) return false;
    const exW = Number(island.getAttribute('data-godot-ex-width'));
    const exH = Number(island.getAttribute('data-godot-ex-height'));
    if (!Number.isFinite(exW) || !Number.isFinite(exH)) return false;
    const place = mathSvgPlacement(`${exW}ex`, `${exH}ex`, fontSize);
    if (!place) return false;
    island.setAttribute('width', String(Math.round(place.width * 100) / 100));
    island.setAttribute('height', String(Math.round(place.height * 100) / 100));
    island.setAttribute('x', String(Math.round(place.x * 100) / 100));
    island.setAttribute('y', String(Math.round(place.y * 100) / 100));
    return true;
  }

  /**
   * Fit (or refit) a node's border to its content, keeping paint attrs;
   * attached connectors re-route to the new border afterwards.
   */
  _refitNodeBorder(g, keepPaint = null) {
    this._refitNodeBorderCore(g, keepPaint);
    if (this._connections && g.id) {
      this._connections.rerouteFor(new Set([g.id]));
    }
  }

  _refitNodeBorderCore(g, keepPaint = null) {
    const shape = g.getAttribute('data-godot-node-shape') || 'rect';
    const padding = Number(g.getAttribute('data-godot-padding'));
    const old = g.querySelector('[data-godot-role="border"]');
    const paint = keepPaint ?? {};
    if (old && keepPaint === null) {
      for (const a of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray']) {
        const v = old.getAttribute(a);
        if (v != null) paint[a] = v;
      }
    }
    if (old) old.remove();

    const content = g.querySelector('[data-godot-role="content"]');
    if (!content || shape === 'none') return;
    let box;
    try {
      box = content.getBBox();
    } catch {
      return;
    }
    // The content is centred about the group origin; include any centring
    // transform in the measured size (bbox is pre-transform, but only a
    // translate is ever applied — the size is what the border needs).
    const spec = fitNodeBorder(
      { width: box.width, height: box.height },
      { padding: Number.isFinite(padding) ? padding : NODE_DEFAULT_PADDING, shape }
    );
    if (!spec) return;
    const border = this.ownerDocument.createElementNS(SVG_NS, spec.tag);
    for (const [k, v] of Object.entries(spec.attrs)) {
      border.setAttribute(k, String(v));
    }
    border.setAttribute('data-godot-role', 'border');
    border.setAttribute('fill', paint.fill ?? 'none');
    border.setAttribute('stroke', paint.stroke ?? '#222222');
    border.setAttribute('stroke-width', paint['stroke-width'] ?? '1');
    if (paint['stroke-dasharray']) {
      border.setAttribute('stroke-dasharray', paint['stroke-dasharray']);
    }
    g.prepend(border);
  }

  /** Open the inline editor on an existing label-bearing element. */
  openLabelEditor(el) {
    const shape = el.getAttribute('data-godot-shape');
    let value = '';
    if (shape === 'node' || shape === 'math') {
      value = el.getAttribute('data-godot-latex') ?? '';
    } else if (shape === 'text' || el.tagName.toLowerCase() === 'text') {
      value = el.textContent ?? '';
    }
    const bbox = this._bboxOf(el);
    const screen = bbox
      ? this._toScreen({ x: bbox.x, y: bbox.y + bbox.height })
      : { x: 40, y: 40 };
    this._inline.open({
      screenX: screen.x,
      screenY: screen.y,
      value,
      onCommit: (next) => {
        if (next === value) return;
        this.pushUndo();
        if (shape === 'node') {
          el.setAttribute('data-godot-latex', next);
          this._rebuildNodeContent(el);
        } else if (shape === 'math') {
          el.setAttribute('data-godot-latex', next);
          this._renderLegacyMathInto(el, next, el.id);
        } else {
          el.textContent = next;
        }
        this.notifyChange();
        this._redrawSelection();
        this._stage.focus();
      },
      onCancel: () => this._stage.focus(),
    });
  }

  /** Legacy `math` boxes (pre-node documents): re-render in place. */
  _renderLegacyMathInto(g, latex, id) {
    const paint = () => {
      const container = typesetMath(latex, { display: false });
      if (!container) return;
      const svg = container.querySelector ? container.querySelector('svg') : null;
      const source = svg ? svg.outerHTML : container.outerHTML || '';
      const namespaced = namespaceMathBox(source, id);
      const frag = new DOMParser().parseFromString(
        `<svg xmlns="${SVG_NS}">${namespaced}</svg>`,
        'image/svg+xml'
      ).documentElement;
      g.replaceChildren();
      for (const child of Array.from(frag.childNodes)) {
        g.append(this.ownerDocument.importNode(child, true));
      }
      this._redrawSelection();
    };
    if (typesetMath(latex, { display: false })) paint();
    else whenMathJaxReady(paint);
  }

  // --- shared helpers (controllers) ---------------------------------------

  appendMarkup(markup) {
    const frag = new DOMParser().parseFromString(
      `<svg xmlns="${SVG_NS}">${markup}</svg>`,
      'image/svg+xml'
    ).documentElement;
    const node = this.ownerDocument.importNode(frag.firstElementChild, true);
    this._layer.append(node);
    return node;
  }

  allocId() {
    const ids = new Set();
    if (this._doc) {
      for (const el of this._doc.querySelectorAll('[id]')) {
        ids.add(el.id);
      }
    }
    return nextId(ids);
  }

  // --- hit-testing ---------------------------------------------------------

  _hitTest(p) {
    if (!this._layer) return null;
    const kids = Array.from(this._layer.children);
    const tol = this.handleTolerance();
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const el = kids[i];
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const shape = el.getAttribute('data-godot-shape');
      if (shape === 'line' || tag === 'line') {
        const a = { x: Number(el.getAttribute('x1')), y: Number(el.getAttribute('y1')) };
        const b = { x: Number(el.getAttribute('x2')), y: Number(el.getAttribute('y2')) };
        if (distToSegment(p, a, b) <= tol * 1.5) return el;
        continue;
      }
      if (tag === 'path') {
        const model = parsePathData(el.getAttribute('d') || '');
        if (model) {
          const filled = (el.getAttribute('fill') || 'none') !== 'none';
          if (hitTestPath(model, p, tol * 1.5)) return el;
          if (filled) {
            const bbox = this._bboxOf(el);
            if (bbox && pointInRect(p, bbox)) return el;
          }
          continue;
        }
        // Unparseable path: bbox fallback below.
      }
      const bbox = this._bboxOf(el);
      if (bbox && pointInRect(p, bbox)) return el;
    }
    return null;
  }

  /** The bounding box of an element in layer space (transform-aware). */
  _bboxOf(el) {
    if (!el || typeof el.getBBox !== 'function') return null;
    let box;
    try {
      box = el.getBBox();
    } catch {
      return null;
    }
    let rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    const t = this._transformOf(el);
    if (t) {
      rect = {
        x: rect.x * t.scale + t.x,
        y: rect.y * t.scale + t.y,
        width: rect.width * t.scale,
        height: rect.height * t.scale,
      };
    }
    return rect;
  }

  /** Parse `translate(x y) [scale(s)]` transforms (ours). */
  _transformOf(el) {
    const tr = el.getAttribute && el.getAttribute('transform');
    if (!tr) return null;
    const m = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(tr);
    const s = /scale\(\s*(-?[\d.]+)\s*\)/.exec(tr);
    if (!m && !s) return null;
    return {
      x: m ? Number(m[1]) : 0,
      y: m ? Number(m[2]) : 0,
      scale: s ? Number(s[1]) : 1,
    };
  }

  // --- move / resize ---------------------------------------------------

  _fontSizeOf(el) {
    const shape = el.getAttribute('data-godot-shape');
    if (shape === 'node' || shape === 'math') {
      return Number(el.getAttribute('data-godot-font-size')) || 16;
    }
    if (shape === 'text' || (el.tagName && el.tagName.toLowerCase() === 'text')) {
      return Number(el.getAttribute('font-size')) || 16;
    }
    return null;
  }

  _paddingOf(el) {
    if (el.getAttribute('data-godot-shape') !== 'node') return null;
    const n = Number(el.getAttribute('data-godot-padding'));
    return Number.isFinite(n) ? n : NODE_DEFAULT_PADDING;
  }

  _pathModelOf(el) {
    if (!el.tagName || el.tagName.toLowerCase() !== 'path') return null;
    return parsePathData(el.getAttribute('d') || '');
  }

  /** Cache path models at move start so drags accumulate exactly. */
  _capturePathModels() {
    const map = new Map();
    for (const el of this._selection) {
      const model = this._pathModelOf(el);
      if (model) map.set(el, model);
    }
    return map;
  }

  /** Cache foreign elements' original transform strings at move start. */
  _captureForeignTransforms() {
    const map = new Map();
    for (const el of this._selection) {
      if (el.getAttribute('data-godot-shape')) continue;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (['line', 'path', 'rect', 'ellipse'].includes(tag)) continue; // attr-moved
      map.set(el, el.getAttribute('transform') || '');
    }
    return map;
  }

  _moveSelection(dx, dy, drag = null) {
    for (const el of this._selection) {
      this._moveElement(el, dx, dy, drag);
    }
    // Connectors attached to anything that moved (or moved themselves)
    // re-pin their endpoints to the borders.
    if (this._connections) {
      const ids = new Set();
      for (const el of this._selection) {
        if (el.id) ids.add(el.id);
      }
      if (ids.size > 0) this._connections.rerouteFor(ids);
    }
    if (this._nodeEdit && this._nodeEdit.target) this._nodeEdit.resync();
    this._redrawSelection();
  }

  _moveElement(el, dx, dy, drag) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const shape = el.getAttribute('data-godot-shape') || tag;
    if (shape === 'node' || shape === 'math' || (tag === 'g' && el.getAttribute('data-godot-shape'))) {
      const t = this._transformOf(el) || { x: 0, y: 0, scale: 1 };
      const scalePart = t.scale !== 1 ? ` scale(${t.scale})` : '';
      el.setAttribute('transform', `translate(${t.x + dx} ${t.y + dy})${scalePart}`);
      return;
    }
    if (tag === 'path') {
      const cached = drag && drag.pathModels ? drag.pathModels.get(el) : null;
      if (cached && drag) {
        const moved = translatePath(cached, drag.totals.x, drag.totals.y);
        el.setAttribute('d', pathDataFromModel(moved));
      } else {
        const model = this._pathModelOf(el);
        if (model) {
          el.setAttribute('d', pathDataFromModel(translatePath(model, dx, dy)));
        }
      }
      return;
    }
    if (shape === 'rect' || tag === 'rect') {
      this._setNum(el, 'x', Number(el.getAttribute('x')) + dx);
      this._setNum(el, 'y', Number(el.getAttribute('y')) + dy);
      return;
    }
    if (shape === 'ellipse' || tag === 'ellipse' || tag === 'circle') {
      this._setNum(el, 'cx', Number(el.getAttribute('cx')) + dx);
      this._setNum(el, 'cy', Number(el.getAttribute('cy')) + dy);
      return;
    }
    if (shape === 'line' || tag === 'line') {
      this._setNum(el, 'x1', Number(el.getAttribute('x1')) + dx);
      this._setNum(el, 'y1', Number(el.getAttribute('y1')) + dy);
      this._setNum(el, 'x2', Number(el.getAttribute('x2')) + dx);
      this._setNum(el, 'y2', Number(el.getAttribute('y2')) + dy);
      return;
    }
    if (shape === 'text' || tag === 'text') {
      this._setNum(el, 'x', Number(el.getAttribute('x')) + dx);
      this._setNum(el, 'y', Number(el.getAttribute('y')) + dy);
      for (const tspan of el.querySelectorAll('tspan[x]')) {
        this._setNum(tspan, 'x', Number(tspan.getAttribute('x')) + dx);
      }
      return;
    }
    // Foreign element: prepend a translate to its original transform.
    if (drag && drag.transforms && drag.transforms.has(el)) {
      const orig = drag.transforms.get(el);
      el.setAttribute(
        'transform',
        `translate(${drag.totals.x} ${drag.totals.y})${orig ? ` ${orig}` : ''}`
      );
    }
  }

  _resizeSelection(p, drag) {
    const el = drag.el;
    if (!el) return;
    const next = normalizeRect(resizeRect(drag.origBbox, drag.handle, p));
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const shape = el.getAttribute('data-godot-shape') || tag;

    if (shape === 'rect' || tag === 'rect') {
      this._setNum(el, 'x', next.x);
      this._setNum(el, 'y', next.y);
      this._setNum(el, 'width', Math.max(1, next.width));
      this._setNum(el, 'height', Math.max(1, next.height));
    } else if (shape === 'ellipse' || tag === 'ellipse') {
      this._setNum(el, 'cx', next.x + next.width / 2);
      this._setNum(el, 'cy', next.y + next.height / 2);
      this._setNum(el, 'rx', Math.max(1, next.width / 2));
      this._setNum(el, 'ry', Math.max(1, next.height / 2));
    } else if (tag === 'path' && drag.pathModel) {
      const resized = resizePath(drag.pathModel, drag.origBbox, next);
      el.setAttribute('d', pathDataFromModel(resized));
      if (this._nodeEdit && this._nodeEdit.target === el) this._nodeEdit.resync();
    } else if (shape === 'node') {
      const source = el.getAttribute('data-godot-latex') ?? '';
      if (texForNodeContent(source) === null) {
        // Flowed text: resizing sets the wrap width and reflows — a
        // div's behaviour. Type size stays put (it's a panel knob).
        const pad = this._paddingOf(el) ?? NODE_DEFAULT_PADDING;
        const w = Math.max(20, Math.round(next.width - 2 * pad));
        el.setAttribute('data-godot-wrap-width', String(w));
        this._rebuildNodeContent(el);
      } else {
        // Math: uniform scale of font size + padding, border refits.
        const s = this._uniformScale(drag.origBbox, next);
        const fs = Math.max(4, Math.round((drag.origFontSize ?? 16) * s * 10) / 10);
        const pad = Math.max(0, Math.round((drag.origPadding ?? NODE_DEFAULT_PADDING) * s * 10) / 10);
        el.setAttribute('data-godot-font-size', String(fs));
        el.setAttribute('data-godot-padding', String(pad));
        if (!this._replaceMathIsland(el, fs)) {
          const content = el.querySelector('text[data-godot-role="content"]');
          if (content) content.setAttribute('font-size', String(fs));
        }
        this._refitNodeBorder(el);
      }
    } else if (shape === 'math') {
      // Legacy math boxes scale via their transform.
      const s = this._uniformScale(drag.origBbox, next);
      const t = this._transformOf(el) || { x: 0, y: 0, scale: 1 };
      const origScale = drag.origScale ?? (drag.origScale = t.scale);
      const origX = drag.origX ?? (drag.origX = t.x);
      const origY = drag.origY ?? (drag.origY = t.y);
      el.setAttribute(
        'transform',
        `translate(${origX} ${origY}) scale(${Math.max(0.05, origScale * s)})`
      );
    } else if (shape === 'text' || tag === 'text') {
      const s = this._uniformScale(drag.origBbox, next);
      const fs = Math.max(4, Math.round((drag.origFontSize ?? 16) * s * 10) / 10);
      el.setAttribute('font-size', String(fs));
    }
    // A resized shape's attached connectors re-pin to the new border.
    if (this._connections && el.id) {
      this._connections.rerouteFor(new Set([el.id]));
    }
    this._redrawSelection();
  }

  _uniformScale(orig, next) {
    const sx = orig.width ? next.width / orig.width : 1;
    const sy = orig.height ? next.height / orig.height : 1;
    return Math.max(0.05, Math.min(sx, sy));
  }

  _setNum(el, attr, value) {
    el.setAttribute(attr, String(Math.round(value * 100) / 100));
  }

  // --- marquee ---------------------------------------------------------

  _commitMarquee(a, b, additive) {
    const marquee = normalizeRect(rectFromPoints(a, b));
    if (marquee.width < 2 && marquee.height < 2) {
      if (!additive) this.clearSelection();
      return;
    }
    if (!additive) this._selection.clear();
    for (const el of Array.from(this._layer.children)) {
      const bbox = this._bboxOf(el);
      if (bbox && rectsIntersect(bbox, marquee)) this._selection.add(el);
    }
    this._selectionChanged();
  }

  // --- overlay drawing -------------------------------------------------

  _redrawSelection() {
    if (!this._overlay) return;
    const layer = this.overlayExtrasLayer('selection');
    layer.replaceChildren();
    const els = this.selectionList();
    if (els.length === 0) return;
    const doc = this.ownerDocument;
    const r = this.handleTolerance();

    for (const el of els) {
      const bbox = this._bboxOf(el);
      if (!bbox) continue;
      const outline = doc.createElementNS(SVG_NS, 'rect');
      outline.setAttribute('x', bbox.x);
      outline.setAttribute('y', bbox.y);
      outline.setAttribute('width', Math.max(0, bbox.width));
      outline.setAttribute('height', Math.max(0, bbox.height));
      outline.setAttribute('class', 'svg-editor-sel-outline');
      outline.setAttribute('fill', 'none');
      outline.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
      outline.setAttribute('stroke-dasharray', '4 3');
      outline.setAttribute('vector-effect', 'non-scaling-stroke');
      layer.append(outline);
    }

    if (els.length !== 1) return;
    const el = els[0];
    const tag = el.tagName ? el.tagName.toLowerCase() : '';

    // A line gets endpoint handles rather than a resize box.
    if (tag === 'line') {
      for (const [x, y] of [
        [el.getAttribute('x1'), el.getAttribute('y1')],
        [el.getAttribute('x2'), el.getAttribute('y2')],
      ]) {
        const dot = doc.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', x);
        dot.setAttribute('cy', y);
        dot.setAttribute('r', r);
        dot.setAttribute('class', 'svg-editor-handle');
        dot.setAttribute('fill', '#ffffff');
        dot.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
        dot.setAttribute('vector-effect', 'non-scaling-stroke');
        layer.append(dot);
      }
      return;
    }

    // Resize handles when the tool is select.
    if (this._tool !== 'select') return;
    const bbox = this._bboxOf(el);
    if (!bbox) return;
    const handles = handlePositions(bbox);
    for (const name of Object.keys(handles)) {
      const h = handles[name];
      const dot = doc.createElementNS(SVG_NS, 'rect');
      dot.setAttribute('x', h.x - r);
      dot.setAttribute('y', h.y - r);
      dot.setAttribute('width', r * 2);
      dot.setAttribute('height', r * 2);
      dot.setAttribute('class', 'svg-editor-handle');
      dot.setAttribute('data-handle', name);
      dot.setAttribute('fill', '#ffffff');
      dot.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
      dot.setAttribute('vector-effect', 'non-scaling-stroke');
      layer.append(dot);
    }
  }

  redrawSelection() {
    this._redrawSelection();
  }

  _previewCreate() {
    const layer = this.overlayExtrasLayer('gesture');
    layer.replaceChildren();
    if (!this._drag) return;
    const { startUser: a, curUser: b, tool } = this._drag;
    const doc = this.ownerDocument;
    let el;
    if (tool === 'line') {
      el = doc.createElementNS(SVG_NS, 'line');
      el.setAttribute('x1', a.x);
      el.setAttribute('y1', a.y);
      el.setAttribute('x2', b.x);
      el.setAttribute('y2', b.y);
      el.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
    } else {
      const rect = normalizeRect(rectFromPoints(a, b));
      el = doc.createElementNS(SVG_NS, tool === 'ellipse' ? 'ellipse' : 'rect');
      if (tool === 'ellipse') {
        el.setAttribute('cx', rect.x + rect.width / 2);
        el.setAttribute('cy', rect.y + rect.height / 2);
        el.setAttribute('rx', rect.width / 2);
        el.setAttribute('ry', rect.height / 2);
      } else {
        el.setAttribute('x', rect.x);
        el.setAttribute('y', rect.y);
        el.setAttribute('width', rect.width);
        el.setAttribute('height', rect.height);
      }
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
    }
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
    layer.append(el);
  }

  _previewMarquee() {
    const layer = this.overlayExtrasLayer('gesture');
    layer.replaceChildren();
    if (!this._drag) return;
    const rect = normalizeRect(rectFromPoints(this._drag.startUser, this._drag.curUser));
    const el = this.ownerDocument.createElementNS(SVG_NS, 'rect');
    el.setAttribute('x', rect.x);
    el.setAttribute('y', rect.y);
    el.setAttribute('width', rect.width);
    el.setAttribute('height', rect.height);
    el.setAttribute('fill', 'rgba(45,140,240,0.1)');
    el.setAttribute('stroke', 'var(--svg-editor-accent, #2d8cf0)');
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
    layer.append(el);
  }

  // --- keyboard --------------------------------------------------------

  _onKeyDown(event) {
    if (this._inline && this._inline.active) return;
    const key = event.key;
    const meta = event.metaKey || event.ctrlKey;

    if (meta) {
      const k = key.toLowerCase();
      if (k === 's') {
        this.save(event.shiftKey);
      } else if (k === 'z') {
        if (event.shiftKey) this.redo();
        else this.undo();
      } else if (k === 'd') {
        this.duplicateSelection();
      } else {
        return; // other chords bubble to the editor router ('share')
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (key === ' ') {
      this._spacePan = true;
      this._stage.classList.add('svg-editor-panning');
      event.preventDefault();
      return;
    }

    if (this._tool === 'pen' && this._pen.keyDown(event)) {
      event.preventDefault();
      return;
    }
    if (this._tool === 'node-edit' && this._nodeEdit.keyDown(event)) {
      event.preventDefault();
      return;
    }

    if (!event.altKey && key.length === 1) {
      const tool = toolForKey(key.toLowerCase());
      if (tool) {
        this.setTool(tool);
        event.preventDefault();
        return;
      }
    }
    if (key === 'Escape') {
      this.clearSelection();
      this.setTool('select');
      event.preventDefault();
      return;
    }
    if ((key === 'Delete' || key === 'Backspace') && this._selection.size > 0) {
      this._deleteSelection();
      event.preventDefault();
      return;
    }
    if (this._selection.size > 0 && key.startsWith('Arrow')) {
      const step = event.shiftKey ? 10 : 1;
      const d = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }[key];
      if (d) {
        this.pushUndo();
        this._moveSelection(d[0], d[1]);
        this.notifyChange();
        event.preventDefault();
        return;
      }
    }
    if (this._selection.size > 0 && ['PageUp', 'PageDown', 'Home', 'End'].includes(key)) {
      this._reorderSelection(key);
      event.preventDefault();
    }
  }

  _onKeyUp(event) {
    if (event.key === ' ') {
      this._spacePan = false;
      this._stage.classList.remove('svg-editor-panning');
    }
  }

  _onDblClick(event) {
    const p = this._toUser(event.clientX, event.clientY);
    if (this._tool === 'pen') {
      this._pen.commit(false);
      return;
    }
    if (this._tool === 'node-edit') {
      if (this._nodeEdit.dblClick(p)) return;
    }
    const hit = this._hitTest(p);
    if (!hit) return;
    const shape = hit.getAttribute('data-godot-shape');
    const tag = hit.tagName ? hit.tagName.toLowerCase() : '';
    if (shape === 'node' || shape === 'math' || shape === 'text' || tag === 'text') {
      this.selectOnly(hit);
      this.openLabelEditor(hit);
      return;
    }
    if (tag === 'path' || tag === 'line') {
      // Double-click a path/line: jump into point editing.
      this.selectOnly(hit);
      this.setTool('node-edit');
      this._nodeEdit.attach(hit);
    }
  }

  // --- editing operations ------------------------------------------------

  _deleteSelection() {
    if (this._selection.size === 0) return;
    this.pushUndo();
    const deletedIds = new Set();
    for (const el of this._selection) {
      if (el.id) deletedIds.add(el.id);
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    // Connectors that referenced a deleted shape become plain paths.
    if (this._connections && deletedIds.size > 0) {
      this._connections.detachReferences(deletedIds);
    }
    if (this._nodeEdit && this._nodeEdit.target && !this._nodeEdit.target.isConnected) {
      this._nodeEdit.detach();
    }
    this._selection.clear();
    this._selectionChanged();
    this.notifyChange();
  }

  duplicateSelection() {
    if (this._selection.size === 0) return;
    this.pushUndo();
    const clones = [];
    const idMap = new Map();
    for (const el of this.selectionList()) {
      const clone = el.cloneNode(true);
      const newId = this.allocId();
      if (el.id) idMap.set(el.id, newId);
      clone.setAttribute('id', newId);
      this._layer.append(clone);
      // Re-namespace embedded math so ids stay unique.
      const shape = clone.getAttribute('data-godot-shape');
      if (shape === 'node') {
        this._rebuildNodeContent(clone);
      } else if (shape === 'math') {
        this._renderLegacyMathInto(clone, clone.getAttribute('data-godot-latex') || '', clone.id);
      }
      this._moveElement(clone, 12, 12, null);
      clones.push(clone);
    }
    // Cloned connectors re-attach to cloned shapes (not the originals),
    // and re-pin to their borders.
    if (this._connections) {
      this._connections.remapClones(idMap, clones);
      this._connections.rerouteFor(new Set(clones.map((c) => c.id)));
    }
    this._selection = new Set(clones);
    this._selectionChanged();
    this.notifyChange();
  }

  _reorderSelection(key) {
    this.pushUndo();
    const els = this.selectionList();
    for (const el of els) {
      if (key === 'Home') {
        this._layer.append(el); // paints last = front
      } else if (key === 'End') {
        this._layer.prepend(el);
      } else if (key === 'PageUp') {
        const next = el.nextElementSibling;
        if (next) this._layer.insertBefore(next, el);
      } else if (key === 'PageDown') {
        const prev = el.previousElementSibling;
        if (prev) this._layer.insertBefore(el, prev);
      }
    }
    this.notifyChange();
  }

  // --- properties ---------------------------------------------------------

  /**
   * Apply a property descriptor's patch to the selection element (panel
   * callback). Resolves arrow-marker sentinels, routes node rebuilds,
   * and keeps marker colours in step with stroke changes.
   */
  applyProperty(el, desc, value, opts = {}) {
    if (opts.takeUndo !== false) this.pushUndo();
    const target =
      desc.target === 'border'
        ? el.querySelector('[data-godot-role="border"]')
        : desc.target === 'content'
          ? el.querySelector('[data-godot-role="content"]')
          : el;
    if (!target) return;

    const patch = desc.set(value);
    for (const [attr, raw] of Object.entries(patch)) {
      let v = raw;
      if (v === 'auto' && (attr === 'marker-start' || attr === 'marker-end')) {
        v = this._markerRef(target.getAttribute('stroke') || '#222222');
      }
      if (v === null) target.removeAttribute(attr);
      else target.setAttribute(attr, String(v));
      // MathJax glyphs paint with fill="currentColor", so recolouring an
      // embedded-math wrapper needs the `color` property too.
      if (attr === 'fill' && v !== null && target.tagName.toLowerCase() === 'g') {
        target.setAttribute('color', String(v));
      }
    }

    if (desc.key === 'stroke') {
      this.refreshAttachedMarkers(target);
    }
    const shape = el.getAttribute('data-godot-shape');
    if (shape === 'node' && NODE_REBUILD_KEYS.has(desc.key)) {
      if (desc.key === 'border-shape' || desc.key === 'padding') {
        this._refitNodeBorder(el);
      } else if (
        desc.key === 'font-size' &&
        this._replaceMathIsland(el, Number(el.getAttribute('data-godot-font-size')) || 16)
      ) {
        // Math islands re-place without a re-typeset.
        this._refitNodeBorder(el);
      } else {
        // font / text-width / font-size on flowed text: re-wrap the lot.
        this._rebuildNodeContent(el);
      }
    }
    if (shape === 'math' && desc.key === 'font-size') {
      // Legacy boxes: font size rides the transform scale.
      const t = this._transformOf(el) || { x: 0, y: 0, scale: 1 };
      const fs = Number(el.getAttribute('data-godot-font-size')) || 16;
      el.setAttribute('transform', `translate(${t.x} ${t.y}) scale(${fs / 16})`);
    }
    this.notifyChange();
    this._redrawSelection();
  }

  /** `url(#…)` for the arrow marker of a stroke colour (find-or-create). */
  _markerRef(color) {
    const id = arrowMarkerId(color);
    if (!this._doc.querySelector(`#${CSS.escape(id)}`)) {
      let defs = this._doc.querySelector('defs');
      if (!defs) {
        defs = this.ownerDocument.createElementNS(SVG_NS, 'defs');
        this._doc.prepend(defs);
      }
      const frag = new DOMParser().parseFromString(
        `<svg xmlns="${SVG_NS}">${arrowMarkerMarkup(color)}</svg>`,
        'image/svg+xml'
      ).documentElement;
      defs.append(this.ownerDocument.importNode(frag.firstElementChild, true));
    }
    return `url(#${id})`;
  }

  /** Keep arrow markers colour-matched after a stroke change. */
  refreshAttachedMarkers(el) {
    for (const attr of ['marker-start', 'marker-end']) {
      const v = el.getAttribute(attr);
      if (v && /url\(#godot-arrow-/.test(v)) {
        el.setAttribute(attr, this._markerRef(el.getAttribute('stroke') || '#222222'));
      }
    }
  }

  // --- undo / redo -------------------------------------------------------

  _snapshot() {
    return this._doc ? new XMLSerializer().serializeToString(this._doc) : '';
  }

  pushUndo() {
    if (!this._doc) return;
    this._undoStack.push(this._snapshot());
    if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
    this._redoStack.length = 0;
  }

  /** A gesture that turned out to be a no-op returns its snapshot. */
  _dropUnusedUndo() {
    this._undoStack.pop();
  }

  undo() {
    if (this._undoStack.length === 0) {
      this._status('Nothing to undo');
      return;
    }
    this._redoStack.push(this._snapshot());
    this._restore(this._undoStack.pop());
  }

  redo() {
    if (this._redoStack.length === 0) {
      this._status('Nothing to redo');
      return;
    }
    this._undoStack.push(this._snapshot());
    this._restore(this._redoStack.pop());
  }

  _restore(markup) {
    const ids = this.selectionList()
      .map((el) => el.id)
      .filter(Boolean);
    const editTarget = this._nodeEdit && this._nodeEdit.target ? this._nodeEdit.target.id : null;
    this._pendingSvg = markup;
    this._loadDocument({ preserveView: true });
    this._pendingSvg = null;
    // Restore selection by id where the elements survived.
    for (const id of ids) {
      const el = this._layer ? this._layer.querySelector(`#${CSS.escape(id)}`) : null;
      if (el) this._selection.add(el);
    }
    if (editTarget && this._tool === 'node-edit') {
      const el = this._layer.querySelector(`#${CSS.escape(editTarget)}`);
      if (el) this._nodeEdit.attach(el);
    }
    this._dirty = true;
    this._selectionChanged();
    this._refreshChrome();
  }

  // --- save / open -------------------------------------------------------

  notifyChange() {
    this._dirty = true;
    this._refreshChrome();
  }

  /**
   * Serialise the document. Editing metadata (`data-godot-*`) is KEPT by
   * default — the saved file re-opens fully editable (the file IS the
   * document). `{ clean: true }` strips it for export.
   */
  serialize(opts = {}) {
    if (!this._doc) return '';
    const clone = this._doc.cloneNode(true);
    clone.removeAttribute('class');
    clone.removeAttribute('style');
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(this._docSize.width));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(this._docSize.height));
    for (const el of clone.querySelectorAll('.svg-editor-math-invalid')) {
      el.classList.remove('svg-editor-math-invalid');
      if (el.getAttribute('class') === '') el.removeAttribute('class');
    }
    let out = new XMLSerializer().serializeToString(clone);
    if (opts.clean) out = stripGodotAttributes(out, { stripLatex: true });
    return withXmlProlog(out);
  }

  async save(saveAs = false) {
    const svgText = this.serialize();
    const host = typeof window !== 'undefined' ? window.host : null;
    if (!host || typeof host.saveFile !== 'function') {
      this._downloadSvg(svgText);
      return;
    }
    const path = saveAs ? null : this._filePath;
    try {
      const res = await host.saveFile(path, svgText, { force: this._forceNextSave });
      this._forceNextSave = false;
      if (res && res.conflict) {
        this._forceNextSave = true;
        this._status('Changed on disk — Save again to overwrite');
        return;
      }
      if (res && res.path) {
        this._filePath = res.path;
        this._dirty = false;
        this._status(`Saved ${res.name || res.path}`);
      }
    } catch {
      this._status('Save failed');
    }
    this._refreshChrome();
  }

  async exportClean() {
    const svgText = this.serialize({ clean: true });
    const host = typeof window !== 'undefined' ? window.host : null;
    if (!host || typeof host.saveFile !== 'function') {
      this._downloadSvg(svgText);
      return;
    }
    try {
      const res = await host.saveFile(null, svgText, {});
      if (res && res.path) this._status(`Exported ${res.name || res.path}`);
    } catch {
      this._status('Export failed');
    }
  }

  async openDialog() {
    const host = typeof window !== 'undefined' ? window.host : null;
    if (!host || typeof host.openFile !== 'function') return;
    try {
      const res = await host.openFile();
      if (!res || !res.path) return;
      const text =
        typeof host.readFileTextSync === 'function' ? host.readFileTextSync(res.path) : null;
      if (typeof text !== 'string') {
        this._status('Could not read file as text');
        return;
      }
      this._filePath = res.path;
      this._pendingSvg = text;
      this._undoStack = [];
      this._redoStack = [];
      this._loadDocument();
      this._pendingSvg = null;
      this._dirty = false;
      this._refreshChrome();
    } catch {
      this._status('Open failed');
    }
  }

  _downloadSvg(svgText) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
    try {
      const blob = new Blob([svgText], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (this._buffer && this._buffer.name) || 'drawing.svg';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* download unavailable */
    }
  }

  // --- chrome ------------------------------------------------------------

  _refreshChrome() {
    if (!this._fileLabel) return;
    const name = this._filePath ? this._filePath.split('/').pop() : 'unsaved';
    this._fileLabel.textContent = `${this._dirty ? '● ' : ''}${name}`;
    this._fileLabel.title = this._filePath || 'not saved to a file yet';
  }

  _status(message) {
    if (!this._statusEl) return;
    this._statusEl.textContent = message;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      if (this._statusEl) this._statusEl.textContent = '';
    }, 4000);
  }
}

defineViewElement('svg-editor-view', SvgEditorView);
