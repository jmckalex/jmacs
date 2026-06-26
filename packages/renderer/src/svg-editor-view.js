/**
 * @file `<svg-editor-view>` — an Inkscape-like vector-drawing view.
 *
 * The element owns a live inline `<svg>` (the document model: the DOM IS
 * the model, per plans/SVG-EDITOR.md), a tool palette, a separate overlay
 * `<svg>` for selection handles / marquee, and pointer handling. Saving
 * serialises the document SVG and strips editor-only `data-godot-*`
 * attributes.
 *
 * The math heavy lifting lives in pure, unit-tested modules:
 *  - svg-geometry.js  — bbox, hit-test, resize, screen<->user transforms
 *  - svg-document.js  — shape markup, id allocation, clean-save strip
 *  - svg-mathjax-ids.js — per-box MathJax defs id de-collision
 *
 * The DOM-touching class itself is exercised live in Electron (the
 * renderer test suite runs under Node without a DOM); the pure helpers
 * carry the test coverage.
 *
 * MVP tools: select (move + resize), rect, ellipse, line, text, and the
 * headline LaTeX math box. Pan/zoom and clean save round out the slice.
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
  unionBbox,
  snapToGrid,
  distToSegment,
} from './svg-geometry.js';
import {
  SVG_NS,
  blankDocument,
  nextId,
  rectMarkup,
  ellipseMarkup,
  lineMarkup,
  textMarkup,
  stripGodotAttributes,
  withXmlProlog,
} from './svg-document.js';
import { namespaceMathBox } from './svg-mathjax-ids.js';
import { typesetMath, whenMathJaxReady } from './typeset-math.js';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** The drawing tools, in palette order. Each is `{ id, label, key }`. */
export const TOOLS = [
  { id: 'select', label: 'Select', key: 's' },
  { id: 'rect', label: 'Rectangle', key: 'r' },
  { id: 'ellipse', label: 'Ellipse', key: 'e' },
  { id: 'line', label: 'Line', key: 'l' },
  { id: 'text', label: 'Text', key: 't' },
  { id: 'math', label: 'Math', key: 'm' },
];

/** Map a single-character key to a tool id (for keyboard tool switching). */
export function toolForKey(key) {
  const t = TOOLS.find((tool) => tool.key === key);
  return t ? t.id : null;
}

/**
 * @typedef {object} SvgEditorOptions
 * @property {(svgText: string) => void} [onSave] - called with the clean
 *   serialised SVG when the user saves (host writes it to the file).
 * @property {(key: string) => boolean} [onKey] - fallback key dispatcher
 *   for keys the editor doesn't consume.
 * @property {() => void} [onChange] - called after any document mutation
 *   so the host can mark the buffer dirty.
 */

export class SvgEditorView extends ViewElement {
  constructor() {
    super();
    /** @type {SvgEditorOptions|null} */
    this._options = null;
    /** The buffer descriptor (name + initial svg text), or null. */
    this._buffer = null;
    /** Initial SVG text to load on mount (overrides blank). */
    this._pendingSvg = null;
    this._mounted = false;

    // DOM refs (built on connect)
    this._palette = null;
    this._stage = null; // positioned wrapper holding both svgs
    /** @type {SVGSVGElement|null} the document model */
    this._doc = null;
    /** @type {SVGSVGElement|null} the overlay (handles/marquee) */
    this._overlay = null;
    /** @type {SVGGElement|null} the main layer */
    this._layer = null;

    // interaction state
    this._tool = 'select';
    /** @type {SVGElement|null} the selected element */
    this._selection = null;
    this._drag = null; // { mode, startUser, ... }
    this._mathCounter = 0;
  }

  configure(options) {
    if (this._mounted) {
      throw new Error('SvgEditorView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'svg-editor';
  }

  /**
   * Load a buffer. `buffer.svgText` (if present) is the file content;
   * otherwise we start from a blank document.
   * @param {{name?:string, svgText?:string}|null} buffer
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
    this._selection = null;
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

    this._palette = doc.createElement('div');
    this._palette.className = 'svg-editor-palette';
    for (const tool of TOOLS) {
      const btn = doc.createElement('button');
      btn.className = 'svg-editor-tool';
      btn.dataset.tool = tool.id;
      btn.textContent = tool.label;
      btn.title = `${tool.label} (${tool.key})`;
      btn.addEventListener('click', () => this.setTool(tool.id));
      this._palette.append(btn);
    }
    const saveBtn = doc.createElement('button');
    saveBtn.className = 'svg-editor-save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => this.save());
    this._palette.append(saveBtn);

    this._stage = doc.createElement('div');
    this._stage.className = 'svg-editor-stage';
    this._stage.tabIndex = 0;

    this.append(this._palette, this._stage);

    this._stage.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this._stage.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this._stage.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this._stage.addEventListener('keydown', (e) => this._onKeyDown(e));
    this._stage.addEventListener('dblclick', (e) => this._onDblClick(e));

    this._reflectActiveTool();
  }

  _loadDocument() {
    if (!this._stage) return;
    // Tear down any previous document/overlay.
    this._stage.replaceChildren();
    this._selection = null;

    const markup = this._pendingSvg || blankDocument();
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    let root = parsed.documentElement;
    // Guard against a parsererror document.
    if (!root || root.nodeName.toLowerCase() === 'parsererror') {
      root = new DOMParser().parseFromString(blankDocument(), 'image/svg+xml')
        .documentElement;
    }
    // Import into our document so it's live & styleable.
    this._doc = /** @type {SVGSVGElement} */ (
      this.ownerDocument.importNode(root, true)
    );
    this._doc.classList.add('svg-editor-document');
    this._doc.style.position = 'absolute';
    this._doc.style.inset = '0';

    // Find (or create) the main layer.
    this._layer =
      this._doc.querySelector('g[data-godot-layer="main"]') ||
      this._ensureMainLayer();

    // Build the overlay svg sharing the same viewBox.
    this._overlay = this.ownerDocument.createElementNS(SVG_NS, 'svg');
    this._overlay.classList.add('svg-editor-overlay');
    this._overlay.setAttribute(
      'viewBox',
      this._doc.getAttribute('viewBox') || '0 0 800 600'
    );
    this._overlay.style.position = 'absolute';
    this._overlay.style.inset = '0';
    this._overlay.style.pointerEvents = 'none';

    this._stage.append(this._doc, this._overlay);
    this._redrawSelection();
  }

  _ensureMainLayer() {
    const g = this.ownerDocument.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'layer');
    g.setAttribute('data-godot-layer', 'main');
    this._doc.append(g);
    return g;
  }

  // --- tools -----------------------------------------------------------

  /** Switch the active tool. */
  setTool(toolId) {
    if (!TOOLS.some((t) => t.id === toolId)) return;
    this._tool = toolId;
    this._reflectActiveTool();
  }

  get tool() {
    return this._tool;
  }

  _reflectActiveTool() {
    if (!this._palette) return;
    for (const btn of this._palette.querySelectorAll('.svg-editor-tool')) {
      btn.classList.toggle('active', btn.dataset.tool === this._tool);
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

  // --- pointer handling ------------------------------------------------

  _onPointerDown(event) {
    if (event.button !== 0) return;
    this._stage.focus();
    const p = this._toUser(event.clientX, event.clientY);

    if (this._tool === 'select') {
      this._beginSelectGesture(p, event);
      return;
    }
    // Creation tools start a rubber-band drag.
    this._drag = {
      mode: 'create',
      tool: this._tool,
      startUser: p,
      curUser: p,
      pointerId: event.pointerId,
    };
    if (this._tool === 'text' || this._tool === 'math') {
      // Click-to-place for text/math: no rubber band, prompt immediately.
      this._drag = null;
      this._placeTextLike(this._tool, p);
      return;
    }
    this._stage.setPointerCapture(event.pointerId);
  }

  _beginSelectGesture(p, event) {
    // If clicking a handle of the current selection → resize.
    if (this._selection) {
      const bbox = this._selectionBbox();
      if (bbox) {
        const handle = handleAtPoint(p, bbox, this._handleTolerance());
        if (handle) {
          this._drag = {
            mode: 'resize',
            handle,
            origBbox: bbox,
            startUser: p,
            pointerId: event.pointerId,
          };
          this._stage.setPointerCapture(event.pointerId);
          return;
        }
      }
    }
    // Otherwise hit-test the document for a shape to select/move.
    const hit = this._hitTest(p);
    this._selectElement(hit);
    if (hit) {
      this._drag = {
        mode: 'move',
        startUser: p,
        lastUser: p,
        pointerId: event.pointerId,
      };
      this._stage.setPointerCapture(event.pointerId);
    } else {
      // Empty space → marquee select.
      this._drag = {
        mode: 'marquee',
        startUser: p,
        curUser: p,
        pointerId: event.pointerId,
      };
      this._stage.setPointerCapture(event.pointerId);
    }
  }

  _onPointerMove(event) {
    if (!this._drag) return;
    const p = this._toUser(event.clientX, event.clientY);
    switch (this._drag.mode) {
      case 'create':
        this._drag.curUser = p;
        this._previewCreate();
        break;
      case 'move': {
        const dx = p.x - this._drag.lastUser.x;
        const dy = p.y - this._drag.lastUser.y;
        this._drag.lastUser = p;
        this._moveSelection(dx, dy);
        break;
      }
      case 'resize':
        this._resizeSelection(p);
        break;
      case 'marquee':
        this._drag.curUser = p;
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
    if (drag.mode === 'create') {
      this._commitCreate(drag.startUser, p, drag.tool);
    } else if (drag.mode === 'marquee') {
      this._commitMarquee(drag.startUser, p);
    } else if (drag.mode === 'move' || drag.mode === 'resize') {
      this._notifyChange();
    }
    this._clearPreview();
    this._drag = null;
    this._redrawSelection();
  }

  // --- shape creation --------------------------------------------------

  _commitCreate(a, b, tool) {
    const rect = normalizeRect(rectFromPoints(a, b));
    // Ignore degenerate (click without drag) creations.
    if (tool !== 'line' && rect.width < 2 && rect.height < 2) return;
    const id = this._allocId();
    let markup = null;
    if (tool === 'rect') {
      markup = rectMarkup({ id, ...rect });
    } else if (tool === 'ellipse') {
      markup = ellipseMarkup({ id, ...rect });
    } else if (tool === 'line') {
      markup = lineMarkup({ id, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    if (!markup) return;
    const el = this._appendMarkup(markup);
    this._selectElement(el);
    this.setTool('select');
    this._notifyChange();
  }

  _placeTextLike(tool, p) {
    const value = this._promptText(
      tool === 'math' ? 'LaTeX:' : 'Text:',
      ''
    );
    if (value == null || value === '') {
      this.setTool('select');
      return;
    }
    const id = this._allocId();
    let el;
    if (tool === 'math') {
      el = this._createMathBox(id, value, p);
    } else {
      el = this._appendMarkup(
        textMarkup({ id, x: p.x, y: p.y, text: value })
      );
    }
    if (el) this._selectElement(el);
    this.setTool('select');
    this._notifyChange();
  }

  /**
   * Create a math box: a `<g class="godot-text">` holding the typeset
   * MathJax glyphs, with the LaTeX source kept in `data-godot-latex`. The
   * MathJax glyph/defs ids are de-collided per box via namespaceMathBox.
   */
  _createMathBox(id, latex, p) {
    const g = this.ownerDocument.createElementNS(SVG_NS, 'g');
    g.setAttribute('id', id);
    g.setAttribute('class', 'godot-text');
    g.setAttribute('data-godot-shape', 'math');
    g.setAttribute('data-godot-latex', latex);
    g.setAttribute('transform', `translate(${p.x} ${p.y})`);
    this._layer.append(g);
    this._renderMathInto(g, latex, id);
    return g;
  }

  /** (Re)render a math box's LaTeX into its `<g>`. */
  _renderMathInto(g, latex, id) {
    const paint = () => {
      const container = typesetMath(latex, { display: false });
      if (!container) return; // leave empty until MathJax ready / on error
      const svg = container.querySelector
        ? container.querySelector('svg')
        : null;
      const source = svg ? svg.outerHTML : container.outerHTML || '';
      const namespaced = namespaceMathBox(source, id);
      // Parse the namespaced markup back into nodes and insert.
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

  _appendMarkup(markup) {
    const frag = new DOMParser().parseFromString(
      `<svg xmlns="${SVG_NS}">${markup}</svg>`,
      'image/svg+xml'
    ).documentElement;
    const node = this.ownerDocument.importNode(frag.firstElementChild, true);
    this._layer.append(node);
    return node;
  }

  _allocId() {
    const ids = new Set();
    if (this._doc) {
      for (const el of this._doc.querySelectorAll('[id]')) {
        ids.add(el.id);
      }
    }
    return nextId(ids);
  }

  // --- selection -------------------------------------------------------

  _hitTest(p) {
    if (!this._layer) return null;
    // Walk children in reverse (topmost paints last) for a point hit.
    const kids = Array.from(this._layer.children);
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const el = kids[i];
      const shape = el.getAttribute('data-godot-shape');
      if (shape === 'line') {
        const a = {
          x: Number(el.getAttribute('x1')),
          y: Number(el.getAttribute('y1')),
        };
        const b = {
          x: Number(el.getAttribute('x2')),
          y: Number(el.getAttribute('y2')),
        };
        if (distToSegment(p, a, b) <= this._handleTolerance()) return el;
        continue;
      }
      const bbox = this._bboxOf(el);
      if (bbox && pointInRect(p, bbox)) return el;
    }
    return null;
  }

  _selectElement(el) {
    this._selection = el || null;
    this._redrawSelection();
  }

  /** The bounding box of an element in user space, via getBBox + transform. */
  _bboxOf(el) {
    if (!el || typeof el.getBBox !== 'function') return null;
    let box;
    try {
      box = el.getBBox();
    } catch {
      return null;
    }
    let rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    // Account for a translate() transform set on math/text groups.
    const t = this._translateOf(el);
    if (t) rect = { ...rect, x: rect.x + t.x, y: rect.y + t.y };
    return rect;
  }

  _translateOf(el) {
    const tr = el.getAttribute && el.getAttribute('transform');
    if (!tr) return null;
    const m = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/.exec(tr);
    if (!m) return null;
    return { x: Number(m[1]), y: Number(m[2]) };
  }

  _selectionBbox() {
    return this._selection ? this._bboxOf(this._selection) : null;
  }

  _handleTolerance() {
    // Scale the screen-space tolerance into user units via the CTM.
    if (!this._doc) return 6;
    const ctm = this._doc.getScreenCTM();
    const scale = ctm ? Math.hypot(ctm.a, ctm.b) || 1 : 1;
    return 6 / scale;
  }

  // --- move / resize ---------------------------------------------------

  _moveSelection(dx, dy) {
    const el = this._selection;
    if (!el) return;
    const shape = el.getAttribute('data-godot-shape');
    if (shape === 'math' || shape === 'text') {
      const t = this._translateOf(el) || { x: 0, y: 0 };
      if (shape === 'text') {
        // plain <text> uses x/y attributes
        this._setNum(el, 'x', Number(el.getAttribute('x')) + dx);
        this._setNum(el, 'y', Number(el.getAttribute('y')) + dy);
      } else {
        el.setAttribute('transform', `translate(${t.x + dx} ${t.y + dy})`);
      }
    } else if (shape === 'rect') {
      this._setNum(el, 'x', Number(el.getAttribute('x')) + dx);
      this._setNum(el, 'y', Number(el.getAttribute('y')) + dy);
    } else if (shape === 'ellipse') {
      this._setNum(el, 'cx', Number(el.getAttribute('cx')) + dx);
      this._setNum(el, 'cy', Number(el.getAttribute('cy')) + dy);
    } else if (shape === 'line') {
      this._setNum(el, 'x1', Number(el.getAttribute('x1')) + dx);
      this._setNum(el, 'y1', Number(el.getAttribute('y1')) + dy);
      this._setNum(el, 'x2', Number(el.getAttribute('x2')) + dx);
      this._setNum(el, 'y2', Number(el.getAttribute('y2')) + dy);
    }
    this._redrawSelection();
  }

  _resizeSelection(p) {
    const el = this._selection;
    const drag = this._drag;
    if (!el || !drag) return;
    const next = normalizeRect(resizeRect(drag.origBbox, drag.handle, p));
    const shape = el.getAttribute('data-godot-shape');
    if (shape === 'rect') {
      this._setNum(el, 'x', next.x);
      this._setNum(el, 'y', next.y);
      this._setNum(el, 'width', Math.max(1, next.width));
      this._setNum(el, 'height', Math.max(1, next.height));
    } else if (shape === 'ellipse') {
      this._setNum(el, 'cx', next.x + next.width / 2);
      this._setNum(el, 'cy', next.y + next.height / 2);
      this._setNum(el, 'rx', Math.max(1, next.width / 2));
      this._setNum(el, 'ry', Math.max(1, next.height / 2));
    } else if (shape === 'math' || shape === 'text') {
      // Scale-by-transform for groups; reposition origin to the new NW.
      const orig = drag.origBbox;
      const sx = orig.width ? next.width / orig.width : 1;
      const sy = orig.height ? next.height / orig.height : 1;
      const s = Math.max(0.05, Math.min(sx, sy)); // uniform scale
      el.setAttribute(
        'transform',
        `translate(${next.x} ${next.y}) scale(${s})`
      );
    }
    this._redrawSelection();
  }

  _setNum(el, attr, value) {
    el.setAttribute(attr, String(Math.round(value * 100) / 100));
  }

  // --- marquee ---------------------------------------------------------

  _commitMarquee(a, b) {
    const marquee = normalizeRect(rectFromPoints(a, b));
    if (marquee.width < 2 && marquee.height < 2) {
      this._selectElement(null);
      return;
    }
    // Select the first shape whose bbox intersects (MVP: single select).
    for (const el of Array.from(this._layer.children).reverse()) {
      const bbox = this._bboxOf(el);
      if (bbox && rectsIntersect(bbox, marquee)) {
        this._selectElement(el);
        return;
      }
    }
    this._selectElement(null);
  }

  // --- overlay drawing -------------------------------------------------

  _redrawSelection() {
    if (!this._overlay) return;
    this._overlay.replaceChildren();
    const bbox = this._selectionBbox();
    if (!bbox) return;
    const ns = SVG_NS;
    const outline = this.ownerDocument.createElementNS(ns, 'rect');
    outline.setAttribute('x', bbox.x);
    outline.setAttribute('y', bbox.y);
    outline.setAttribute('width', Math.max(0, bbox.width));
    outline.setAttribute('height', Math.max(0, bbox.height));
    outline.setAttribute('class', 'svg-editor-sel-outline');
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke', '#2d8cf0');
    outline.setAttribute('stroke-dasharray', '4 3');
    outline.setAttribute('vector-effect', 'non-scaling-stroke');
    this._overlay.append(outline);

    const handles = handlePositions(bbox);
    const r = this._handleTolerance();
    for (const name of Object.keys(handles)) {
      const h = handles[name];
      const dot = this.ownerDocument.createElementNS(ns, 'rect');
      dot.setAttribute('x', h.x - r);
      dot.setAttribute('y', h.y - r);
      dot.setAttribute('width', r * 2);
      dot.setAttribute('height', r * 2);
      dot.setAttribute('class', 'svg-editor-handle');
      dot.setAttribute('data-handle', name);
      dot.setAttribute('fill', '#fff');
      dot.setAttribute('stroke', '#2d8cf0');
      dot.setAttribute('vector-effect', 'non-scaling-stroke');
      this._overlay.append(dot);
    }
  }

  _previewCreate() {
    if (!this._overlay || !this._drag) return;
    this._overlay.replaceChildren();
    const { startUser: a, curUser: b, tool } = this._drag;
    const ns = SVG_NS;
    let el;
    if (tool === 'line') {
      el = this.ownerDocument.createElementNS(ns, 'line');
      el.setAttribute('x1', a.x);
      el.setAttribute('y1', a.y);
      el.setAttribute('x2', b.x);
      el.setAttribute('y2', b.y);
      el.setAttribute('stroke', '#2d8cf0');
    } else {
      const rect = normalizeRect(rectFromPoints(a, b));
      el = this.ownerDocument.createElementNS(
        ns,
        tool === 'ellipse' ? 'ellipse' : 'rect'
      );
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
      el.setAttribute('stroke', '#2d8cf0');
    }
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
    this._overlay.append(el);
  }

  _previewMarquee() {
    if (!this._overlay || !this._drag) return;
    this._overlay.replaceChildren();
    const rect = normalizeRect(
      rectFromPoints(this._drag.startUser, this._drag.curUser)
    );
    const el = this.ownerDocument.createElementNS(SVG_NS, 'rect');
    el.setAttribute('x', rect.x);
    el.setAttribute('y', rect.y);
    el.setAttribute('width', rect.width);
    el.setAttribute('height', rect.height);
    el.setAttribute('fill', 'rgba(45,140,240,0.1)');
    el.setAttribute('stroke', '#2d8cf0');
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
    this._overlay.append(el);
  }

  _clearPreview() {
    if (this._overlay) this._overlay.replaceChildren();
  }

  // --- keyboard --------------------------------------------------------

  _onKeyDown(event) {
    const key = event.key;
    // Tool switch via single letters when no modifier.
    if (!event.metaKey && !event.ctrlKey && !event.altKey && key.length === 1) {
      const tool = toolForKey(key.toLowerCase());
      if (tool) {
        this.setTool(tool);
        event.preventDefault();
        return;
      }
    }
    if (key === 'Escape') {
      this._selectElement(null);
      this.setTool('select');
      event.preventDefault();
      return;
    }
    if ((key === 'Delete' || key === 'Backspace') && this._selection) {
      this._deleteSelection();
      event.preventDefault();
      return;
    }
    if ((key === 's' || key === 'S') && (event.metaKey || event.ctrlKey)) {
      this.save();
      event.preventDefault();
      return;
    }
    // Arrow-key nudge.
    if (this._selection && key.startsWith('Arrow')) {
      const step = event.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
      if (d) {
        this._moveSelection(d[0], d[1]);
        this._notifyChange();
        event.preventDefault();
        return;
      }
    }
    // Fallback to the host dispatcher.
    const onKey = this._options && this._options.onKey;
    if (typeof onKey === 'function') onKey(key);
  }

  _onDblClick(event) {
    const p = this._toUser(event.clientX, event.clientY);
    const hit = this._hitTest(p);
    if (hit && hit.getAttribute('data-godot-shape') === 'math') {
      const cur = hit.getAttribute('data-godot-latex') || '';
      const next = this._promptText('LaTeX:', cur);
      if (next != null && next !== cur) {
        hit.setAttribute('data-godot-latex', next);
        this._renderMathInto(hit, next, hit.id);
        this._notifyChange();
      }
    }
  }

  _deleteSelection() {
    if (this._selection && this._selection.parentNode) {
      this._selection.parentNode.removeChild(this._selection);
    }
    this._selectElement(null);
    this._notifyChange();
  }

  // --- save ------------------------------------------------------------

  /** Serialise the document SVG, stripped of editor-only attributes. */
  serialize() {
    if (!this._doc) return '';
    const raw = new XMLSerializer().serializeToString(this._doc);
    const clean = stripGodotAttributes(raw);
    return withXmlProlog(clean);
  }

  save() {
    const onSave = this._options && this._options.onSave;
    if (typeof onSave === 'function') onSave(this.serialize());
  }

  _notifyChange() {
    const onChange = this._options && this._options.onChange;
    if (typeof onChange === 'function') onChange();
  }

  // --- prompting -------------------------------------------------------

  /**
   * Prompt for a text value. Uses the injected `onPrompt` option if the
   * host supplies one (so it can route to the editor's minibuffer);
   * falls back to `window.prompt`.
   */
  _promptText(label, initial) {
    const onPrompt = this._options && this._options.onPrompt;
    if (typeof onPrompt === 'function') return onPrompt(label, initial);
    if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
      return window.prompt(label, initial);
    }
    return null;
  }
}

defineViewElement('svg-editor-view', SvgEditorView);
