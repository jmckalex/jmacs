/**
 * @file `<pdf-view>` — the custom element a buffer of kind `pdf` is
 * shown through. Renders each page to a `<canvas>` plus an overlapping
 * text layer using PDF.js (Mozilla's PDF library, the same engine that
 * powers Firefox's built-in viewer). The chrome — toolbar with page
 * navigation, zoom controls, and find input — is ours, so it matches
 * the editor's theme and forwards chord keys through the keymap.
 *
 * Per-view-instance is the architectural shape; each pdf tab gets its
 * own `<pdf-view>` from the perKindConfigureFactory in app.js. The
 * `PDFDocumentProxy`, current page, and zoom live on the element so
 * tabbed PDFs survive a tab switch with their state intact.
 *
 * Suffix helpers (`isPdfName`, `mimeTypeForPdf`) live alongside the
 * class so the file-open dispatch can use them without pulling in the
 * whole element machinery — the renderer's test suite imports just
 * those helpers under Node.
 *
 * Background on the renderer choice and the Lisp-extension story (text
 * extraction primitives, citation extraction) lives in
 * `plans/PDF-VIEW.md`.
 */

import { keyEventToString } from './keymap.js';
import { defineViewElement, ViewElement } from './view-elements.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Base URL under `app://editor/` where pdfjs-dist's worker, cmaps, and
 *  standard-font assets are served from. The `app://` protocol resolves
 *  to the repository root, so `node_modules/pdfjs-dist/*` is reachable
 *  the same way every other vendored asset is. */
const PDFJS_BASE = 'app://editor/node_modules/pdfjs-dist';

/** The numeric zoom levels offered in the toolbar's percentage select.
 *  `'fit'` and `'width'` are the two named modes. */
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** Gap (px) between adjacent page placeholders inside the viewport. */
const PAGE_GAP = 12;

/**
 * Whether NAME names a file the host should open as a PDF buffer. The
 * suffix check mirrors `mediaKindFor` in `apps/desktop/src/files.js`;
 * the renderer's copy stays near the view it routes to.
 *
 * @param {string} name - A file name or path.
 * @returns {boolean}
 */
export function isPdfName(name) {
  if (typeof name !== 'string') return false;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return name.slice(dot).toLowerCase() === '.pdf';
}

/**
 * The MIME type for a PDF file name, or `null` when the name has no
 * PDF suffix. Kept symmetrical with `mimeTypeForImage` so the file-
 * open dispatch can mix the two checks uniformly.
 *
 * @param {string} name - A file name or path.
 * @returns {string | null}
 */
export function mimeTypeForPdf(name) {
  return isPdfName(name) ? 'application/pdf' : null;
}

/**
 * @typedef {object} PdfViewOptions
 * @property {(key: string) => boolean} [onKey] - Key dispatcher. Called
 *   for each keydown on the outer element that isn't a bare modifier
 *   and didn't originate inside the find input. Returns whether the key
 *   was handled (truthy → preventDefault). Lets chord keys like `C-x b`
 *   reach Godot's keymap while the PDF view has focus.
 */

/**
 * Lazily-loaded pdfjs-dist module. We defer the import so a Node-side
 * importer of this file (the renderer's pure-helper tests reach
 * `isPdfName` through `@editor/renderer`'s barrel) doesn't pay the cost
 * of loading the PDF engine — and so any environment without the DOM
 * doesn't see the worker-src write.
 *
 * @type {Promise<*> | null}
 */
let pdfjsPromise = null;

/** Load pdfjs-dist on demand and configure its global worker source.
 *  Idempotent: subsequent callers receive the same module instance. */
function loadPdfjs() {
  if (pdfjsPromise === null) {
    pdfjsPromise = import('pdfjs-dist').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;
      return mod;
    });
  }
  return pdfjsPromise;
}

export class PdfView extends ViewElement {
  constructor() {
    super();
    /** @type {PdfViewOptions | null} */
    this._options = null;
    /** The view object currently shown — passed by mountKindView. */
    this._buffer = null;
    /** Latch tripped on first mount; gates `_ensureMounted`. */
    this._mounted = false;

    // Chrome.
    /** @type {HTMLDivElement | null} */
    this._toolbar = null;
    /** @type {HTMLButtonElement | null} */
    this._prevBtn = null;
    /** @type {HTMLButtonElement | null} */
    this._nextBtn = null;
    /** @type {HTMLInputElement | null} */
    this._pageInput = null;
    /** @type {HTMLSpanElement | null} */
    this._pageCountEl = null;
    /** @type {HTMLButtonElement | null} */
    this._zoomOutBtn = null;
    /** @type {HTMLButtonElement | null} */
    this._zoomInBtn = null;
    /** @type {HTMLSelectElement | null} */
    this._zoomSelect = null;
    /** @type {HTMLInputElement | null} */
    this._findInput = null;
    /** @type {HTMLDivElement | null} */
    this._statusEl = null;
    /** @type {HTMLDivElement | null} - The scrollable page container. */
    this._viewport = null;

    // Document state.
    /** @type {*} - PDF.js `PDFDocumentProxy` once loaded. */
    this._pdfDoc = null;
    /** @type {*} - The in-flight `getDocument` task, so we can cancel. */
    this._loadingTask = null;
    /** Path the loaded doc was opened from — guards against reload when
     *  the host re-mounts the same view. */
    this._loadedFilePath = null;
    /** Token that increments on each load — render tasks check the token
     *  before painting so a cancelled load doesn't paint stale pages. */
    this._loadGeneration = 0;

    // Per-page bookkeeping.
    /** @type {Array<*>} */
    this._pages = [];
    /** @type {IntersectionObserver | null} */
    this._observer = null;

    // Layout state.
    /** Either `'fit'`, `'width'`, or a numeric scale (e.g. 1.5). */
    this._fitMode = 'fit';
    /** Effective render scale resolved from `_fitMode`. */
    this._scale = 1;
    /** 1-based page currently most-visible in the viewport. */
    this._currentPage = 1;
    /** Re-resolve scale on window resize when in a fit mode. */
    this._resizeObserver = null;
    /** Debounce token for find input. */
    this._findDebounce = 0;
  }

  /**
   * Supply the host's configuration. Must be called before the first
   * `connectedCallback` mounts the inner DOM. Calling it after mount
   * throws — reconfiguring an already-mounted view isn't supported.
   *
   * @param {PdfViewOptions} options
   */
  configure(options) {
    if (this._mounted) {
      throw new Error(
        'PdfView.configure: cannot reconfigure after the inner DOM is ' +
        'mounted; destroy() and replace if the host wants new options'
      );
    }
    this._options = options ?? null;
  }

  /**
   * Show a PDF buffer. The view object carries top-level `src` (a
   * `media://localhost/<path>` URL the host built) and `filePath` (the
   * local path); `page` and `zoom` round-trip the saved scroll / zoom
   * state if present. `createView` spreads its `extras` argument onto
   * the view, so these are top-level fields, not nested under `extras`.
   * Passing `null` clears the viewport. Safe to call before connection
   * — the next mount picks up the pending buffer.
   *
   * @param {object | null} next
   */
  setBuffer(next) {
    if (next === this._buffer) return;
    if (typeof console !== 'undefined') {
      console.debug('[pdf-view] setBuffer', {
        sameAsPrev: false,
        prev: this._buffer ? this._buffer.name : null,
        next: next ? {
          name: next.name,
          kind: next.kind,
          hasSrc: typeof next.src === 'string',
          hasFilePath: typeof next.filePath === 'string',
        } : null,
      });
    }
    this._buffer = next;
    if (this._mounted) this._loadFromBuffer();
  }

  /** The view object currently shown, or null. */
  get buffer() {
    return this._buffer;
  }

  /** Every pdf-view is kind 'pdf'. */
  get kind() { return 'pdf'; }

  // --- Custom-element lifecycle ---------------------------------------

  connectedCallback() {
    if (this._mounted) return;
    this._ensureMounted();
    if (this._buffer) this._loadFromBuffer();
  }

  /** Move and destroy look the same here; real teardown is `destroy()`. */
  disconnectedCallback() {
    /* intentionally empty */
  }

  /** Explicit teardown — cancel any in-flight load, tear down the PDF
   *  document so the worker releases its memory, and drop the buffer
   *  reference. Safe to call when the element was never mounted. */
  destroy() {
    this._teardownDoc();
    this._buffer = null;
  }

  // --- internal: mount ------------------------------------------------

  _ensureMounted() {
    if (this._mounted) return;
    const doc = this.ownerDocument;
    this.classList.add('pdf-view');
    this.tabIndex = 0;

    this._toolbar = doc.createElement('div');
    this._toolbar.className = 'pdf-toolbar';

    this._prevBtn = doc.createElement('button');
    this._prevBtn.className = 'pdf-prev';
    this._prevBtn.title = 'Previous page';
    this._prevBtn.textContent = '←';

    this._pageInput = doc.createElement('input');
    this._pageInput.className = 'pdf-page';
    this._pageInput.type = 'number';
    this._pageInput.min = '1';
    this._pageInput.value = '1';

    this._pageCountEl = doc.createElement('span');
    this._pageCountEl.className = 'pdf-page-count';
    this._pageCountEl.textContent = '/ 0';

    this._nextBtn = doc.createElement('button');
    this._nextBtn.className = 'pdf-next';
    this._nextBtn.title = 'Next page';
    this._nextBtn.textContent = '→';

    const sep1 = doc.createElement('span');
    sep1.className = 'pdf-toolbar-sep';

    this._zoomOutBtn = doc.createElement('button');
    this._zoomOutBtn.className = 'pdf-zoom-out';
    this._zoomOutBtn.title = 'Zoom out';
    this._zoomOutBtn.textContent = '−';

    this._zoomSelect = doc.createElement('select');
    this._zoomSelect.className = 'pdf-zoom';
    const fitOption = doc.createElement('option');
    fitOption.value = 'fit';
    fitOption.textContent = 'Fit page';
    const widthOption = doc.createElement('option');
    widthOption.value = 'width';
    widthOption.textContent = 'Fit width';
    this._zoomSelect.append(fitOption, widthOption);
    for (const scale of ZOOM_PRESETS) {
      const opt = doc.createElement('option');
      opt.value = String(scale);
      opt.textContent = `${Math.round(scale * 100)}%`;
      this._zoomSelect.append(opt);
    }
    this._zoomSelect.value = 'fit';

    this._zoomInBtn = doc.createElement('button');
    this._zoomInBtn.className = 'pdf-zoom-in';
    this._zoomInBtn.title = 'Zoom in';
    this._zoomInBtn.textContent = '+';

    const sep2 = doc.createElement('span');
    sep2.className = 'pdf-toolbar-sep';

    this._findInput = doc.createElement('input');
    this._findInput.className = 'pdf-find';
    this._findInput.type = 'text';
    this._findInput.placeholder = 'Find…';
    this._findInput.spellcheck = false;

    this._statusEl = doc.createElement('div');
    this._statusEl.className = 'pdf-status';

    this._toolbar.append(
      this._prevBtn,
      this._pageInput,
      this._pageCountEl,
      this._nextBtn,
      sep1,
      this._zoomOutBtn,
      this._zoomSelect,
      this._zoomInBtn,
      sep2,
      this._findInput,
    );

    this._viewport = doc.createElement('div');
    this._viewport.className = 'pdf-viewport';

    this.append(this._toolbar, this._viewport, this._statusEl);

    this._wireEvents();
    this._mounted = true;
  }

  _wireEvents() {
    const viewport = /** @type {HTMLDivElement} */ (this._viewport);

    /** @type {HTMLButtonElement} */ (this._prevBtn).addEventListener('click', () => {
      this._gotoPage(this._currentPage - 1);
    });
    /** @type {HTMLButtonElement} */ (this._nextBtn).addEventListener('click', () => {
      this._gotoPage(this._currentPage + 1);
    });

    const pageInput = /** @type {HTMLInputElement} */ (this._pageInput);
    pageInput.addEventListener('change', () => {
      const n = Number.parseInt(pageInput.value, 10);
      if (Number.isFinite(n)) this._gotoPage(n);
    });
    pageInput.addEventListener('keydown', (event) => {
      // Don't let RET reach the host while the input has focus.
      if (event.key === 'Enter') event.stopPropagation();
    });

    /** @type {HTMLButtonElement} */ (this._zoomOutBtn).addEventListener('click', () => {
      this._stepZoom(-1);
    });
    /** @type {HTMLButtonElement} */ (this._zoomInBtn).addEventListener('click', () => {
      this._stepZoom(+1);
    });
    /** @type {HTMLSelectElement} */ (this._zoomSelect).addEventListener('change', () => {
      const raw = /** @type {HTMLSelectElement} */ (this._zoomSelect).value;
      if (raw === 'fit' || raw === 'width') this._setFitMode(raw);
      else this._setFitMode(Number.parseFloat(raw));
    });

    const findInput = /** @type {HTMLInputElement} */ (this._findInput);
    findInput.addEventListener('input', () => {
      clearTimeout(this._findDebounce);
      this._findDebounce = /** @type {*} */ (setTimeout(() => {
        this._runFind(findInput.value);
      }, 200));
    });
    findInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this._runFind(findInput.value, { advance: true });
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        findInput.value = '';
        this.focus();
      }
    });

    viewport.addEventListener('scroll', () => this._updateCurrentPageFromScroll());

    // Outer keydown: forward chord keys through onKey unless the find
    // input or page input has focus (typing into them must not fire
    // editor commands).
    this.addEventListener('keydown', (event) => {
      if (MODIFIERS.has(event.key)) return;
      if (event.target === this._findInput || event.target === this._pageInput) {
        return;
      }
      const onKey = this._options && this._options.onKey;
      if (typeof onKey === 'function' && onKey(keyEventToString(event))) {
        event.preventDefault();
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        if (this._fitMode === 'fit' || this._fitMode === 'width') {
          this._relayout();
        }
      });
      this._resizeObserver.observe(viewport);
    }
  }

  // --- internal: doc loading ------------------------------------------

  async _loadFromBuffer() {
    const view = this._buffer;
    if (!view) {
      this._teardownDoc();
      this._setStatus('');
      return;
    }
    const src = typeof view.src === 'string' ? view.src : null;
    const filePath = typeof view.filePath === 'string' ? view.filePath : null;
    if (typeof console !== 'undefined') {
      console.debug('[pdf-view] _loadFromBuffer', {
        viewName: view.name,
        viewKind: view.kind,
        src,
        filePath,
        savedPage: view.page,
        savedZoom: view.zoom,
        alreadyLoaded: this._pdfDoc !== null
          && this._loadedFilePath === filePath,
      });
    }
    if (src === null) {
      this._setStatus(
        `No PDF source. (view.src is ${typeof view.src}; ` +
        `expected media:// URL. Check the createView call in app.js.)`
      );
      return;
    }

    // Re-mounting the same file is a no-op — preserve the doc + state.
    if (this._pdfDoc !== null && this._loadedFilePath === filePath) return;

    this._teardownDoc();
    this._setStatus('Loading…');

    const generation = ++this._loadGeneration;
    let pdfjs;
    try {
      pdfjs = await loadPdfjs();
    } catch (error) {
      if (generation !== this._loadGeneration) return;
      console.error('[pdf-view] pdfjs-dist failed to load', error);
      this._setStatus(`Failed to load PDF engine: ${error.message}`);
      return;
    }

    const task = pdfjs.getDocument({
      url: src,
      cMapUrl: `${PDFJS_BASE}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
    });
    this._loadingTask = task;

    let pdfDoc;
    try {
      pdfDoc = await task.promise;
    } catch (error) {
      if (generation !== this._loadGeneration) return;
      console.error('[pdf-view] getDocument rejected', { url: src, error });
      this._setStatus(`Failed to open PDF: ${error.message}`);
      this._loadingTask = null;
      return;
    }
    if (generation !== this._loadGeneration) {
      pdfDoc.destroy();
      return;
    }
    this._pdfDoc = pdfDoc;
    this._loadedFilePath = filePath;
    this._loadingTask = null;
    console.debug('[pdf-view] doc loaded', {
      numPages: pdfDoc.numPages,
      filePath,
    });

    // Restore saved zoom + page if the view carries them.
    const savedZoom = view.zoom;
    if (savedZoom === 'fit' || savedZoom === 'width') {
      this._fitMode = savedZoom;
    } else if (typeof savedZoom === 'number' && Number.isFinite(savedZoom)) {
      this._fitMode = savedZoom;
    } else {
      this._fitMode = 'fit';
    }
    this._syncZoomSelect();
    const savedPage = view.page;
    this._currentPage = (typeof savedPage === 'number' && savedPage >= 1)
      ? Math.min(savedPage, pdfDoc.numPages)
      : 1;

    await this._buildPages();
    if (generation !== this._loadGeneration) return;

    this._setStatus('');
    this._gotoPage(this._currentPage, { instant: true });
  }

  /** Build placeholder containers for every page, sized to the first
   *  page's viewport scaled to the resolved scale. Each placeholder is
   *  hooked up to the IntersectionObserver so the canvas + text layer
   *  paint when it scrolls into view. */
  async _buildPages() {
    const pdfDoc = this._pdfDoc;
    const viewport = /** @type {HTMLDivElement} */ (this._viewport);
    viewport.replaceChildren();
    this._pages = [];

    if (this._observer !== null) {
      this._observer.disconnect();
      this._observer = null;
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pageEntry = this._pages.find((p) => p.container === entry.target);
        if (pageEntry !== undefined) this._renderPage(pageEntry);
      }
    }, { root: viewport, rootMargin: '200px 0px' });
    this._observer = observer;

    // Resolve scale against the first page's intrinsic viewport.
    const firstPage = await pdfDoc.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    this._scale = this._resolveScale(baseViewport);

    const numPages = pdfDoc.numPages;
    /** @type {HTMLDocument} */
    const doc = this.ownerDocument;
    for (let n = 1; n <= numPages; n += 1) {
      const container = doc.createElement('div');
      container.className = 'pdf-page';
      container.setAttribute('data-page', String(n));

      // Approximate dimensions from the first page's intrinsic size —
      // close enough for layout until the page actually loads. Once the
      // page renders we resize the container to its real dimensions.
      const approxWidth = baseViewport.width * this._scale;
      const approxHeight = baseViewport.height * this._scale;
      container.style.width = `${approxWidth}px`;
      container.style.height = `${approxHeight}px`;

      viewport.append(container);
      const entry = {
        pageNum: n,
        container,
        canvas: /** @type {HTMLCanvasElement | null} */ (null),
        textLayer: /** @type {HTMLDivElement | null} */ (null),
        page: /** @type {*} */ (null),
        renderTask: /** @type {*} */ (null),
        renderGeneration: 0,
        scale: 0,
      };
      this._pages.push(entry);
      observer.observe(container);
    }

    /** @type {HTMLSpanElement} */ (this._pageCountEl).textContent = `/ ${numPages}`;
    /** @type {HTMLInputElement} */ (this._pageInput).max = String(numPages);
  }

  /** Render a page entry's canvas + text layer at the current scale.
   *  Cancels any in-flight render for the same page if the scale or
   *  document changed, and skips paint if our load generation was
   *  superseded. Idempotent at the same scale. */
  async _renderPage(entry) {
    const pdfDoc = this._pdfDoc;
    if (pdfDoc === null) return;
    if (entry.scale === this._scale && entry.canvas !== null) return;

    const renderGeneration = ++entry.renderGeneration;
    if (entry.renderTask !== null) {
      try { entry.renderTask.cancel(); } catch { /* ignore */ }
      entry.renderTask = null;
    }

    if (entry.page === null) {
      try {
        entry.page = await pdfDoc.getPage(entry.pageNum);
      } catch {
        return;
      }
      if (renderGeneration !== entry.renderGeneration) return;
    }
    const page = entry.page;
    const scale = this._scale;
    const pageViewport = page.getViewport({ scale });
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

    const doc = this.ownerDocument;
    const canvas = entry.canvas !== null
      ? entry.canvas
      : /** @type {HTMLCanvasElement} */ (doc.createElement('canvas'));
    canvas.className = 'pdf-canvas';
    canvas.width = Math.floor(pageViewport.width * dpr);
    canvas.height = Math.floor(pageViewport.height * dpr);
    canvas.style.width = `${pageViewport.width}px`;
    canvas.style.height = `${pageViewport.height}px`;

    const textLayer = entry.textLayer !== null
      ? entry.textLayer
      : doc.createElement('div');
    textLayer.className = 'pdf-text-layer';
    textLayer.replaceChildren();
    textLayer.style.width = `${pageViewport.width}px`;
    textLayer.style.height = `${pageViewport.height}px`;
    // Selection / find-anchor scaling needs the layer to know the
    // device's CSS-px scale (PDF.js text-layer CSS uses the variable).
    textLayer.style.setProperty('--scale-factor', String(scale));

    entry.container.replaceChildren(canvas, textLayer);
    entry.container.style.width = `${pageViewport.width}px`;
    entry.container.style.height = `${pageViewport.height}px`;
    entry.canvas = canvas;
    entry.textLayer = textLayer;
    entry.scale = scale;

    const ctx = canvas.getContext('2d');
    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    const renderTask = page.render({
      canvasContext: ctx,
      viewport: pageViewport,
      transform,
    });
    entry.renderTask = renderTask;
    try {
      await renderTask.promise;
    } catch (error) {
      if (error && error.name === 'RenderingCancelledException') return;
      this._setStatus(`Render error on page ${entry.pageNum}: ${error.message}`);
      return;
    }
    if (renderGeneration !== entry.renderGeneration) return;
    entry.renderTask = null;

    // Text layer — best-effort. If PDF.js exposes a `TextLayer` class
    // we use it; otherwise we paint nothing and selection / find work
    // through the find input's page-text cache instead of the DOM.
    try {
      const pdfjs = await loadPdfjs();
      if (typeof pdfjs.TextLayer === 'function') {
        const textContentSource = page.streamTextContent({
          includeMarkedContent: true,
          disableNormalization: true,
        });
        const tl = new pdfjs.TextLayer({
          textContentSource,
          container: textLayer,
          viewport: pageViewport,
        });
        await tl.render();
      }
    } catch {
      // Text layer is enhancement; render failures don't break the
      // visible canvas.
    }
  }

  // --- internal: navigation + zoom ------------------------------------

  _gotoPage(n, options) {
    const pdfDoc = this._pdfDoc;
    if (pdfDoc === null) return;
    const clamped = Math.max(1, Math.min(n, pdfDoc.numPages));
    const entry = this._pages.find((p) => p.pageNum === clamped);
    if (entry === undefined) return;
    this._currentPage = clamped;
    /** @type {HTMLInputElement} */ (this._pageInput).value = String(clamped);
    this._persistBufferState();
    const behaviour = options && options.instant ? 'auto' : 'smooth';
    const viewport = /** @type {HTMLDivElement} */ (this._viewport);
    viewport.scrollTo({
      top: entry.container.offsetTop - PAGE_GAP,
      behavior: behaviour,
    });
  }

  _updateCurrentPageFromScroll() {
    const viewport = /** @type {HTMLDivElement} */ (this._viewport);
    const scrollTop = viewport.scrollTop;
    const reference = scrollTop + viewport.clientHeight / 3;
    let best = this._pages[0];
    for (const entry of this._pages) {
      if (entry.container.offsetTop <= reference) best = entry;
      else break;
    }
    if (best && best.pageNum !== this._currentPage) {
      this._currentPage = best.pageNum;
      /** @type {HTMLInputElement} */ (this._pageInput).value = String(best.pageNum);
      this._persistBufferState();
    }
  }

  _stepZoom(direction) {
    const current = typeof this._fitMode === 'number'
      ? this._fitMode
      : this._scale;
    let idx = ZOOM_PRESETS.findIndex((s) => s >= current - 1e-6);
    if (idx === -1) idx = ZOOM_PRESETS.length - 1;
    const next = direction > 0
      ? ZOOM_PRESETS[Math.min(idx + 1, ZOOM_PRESETS.length - 1)]
      : ZOOM_PRESETS[Math.max(idx - 1, 0)];
    this._setFitMode(next);
  }

  _setFitMode(mode) {
    this._fitMode = mode;
    this._syncZoomSelect();
    this._persistBufferState();
    this._relayout();
  }

  _syncZoomSelect() {
    const select = /** @type {HTMLSelectElement} */ (this._zoomSelect);
    if (this._fitMode === 'fit' || this._fitMode === 'width') {
      select.value = this._fitMode;
    } else {
      const match = ZOOM_PRESETS.find((s) => Math.abs(s - this._fitMode) < 1e-6);
      select.value = match !== undefined ? String(match) : String(this._fitMode);
    }
  }

  async _relayout() {
    if (this._pdfDoc === null || this._pages.length === 0) return;
    const firstPage = this._pages[0].page
      ?? await this._pdfDoc.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    const nextScale = this._resolveScale(baseViewport);
    if (Math.abs(nextScale - this._scale) < 1e-6) return;
    this._scale = nextScale;
    // Resize every container and clear the rendered canvas/text layer
    // so the IntersectionObserver re-paints visible pages at the new
    // scale. Off-screen pages get repainted lazily.
    for (const entry of this._pages) {
      const approxWidth = baseViewport.width * this._scale;
      const approxHeight = baseViewport.height * this._scale;
      entry.container.style.width = `${approxWidth}px`;
      entry.container.style.height = `${approxHeight}px`;
      entry.scale = 0;
      if (entry.renderTask !== null) {
        try { entry.renderTask.cancel(); } catch { /* ignore */ }
        entry.renderTask = null;
      }
    }
    // Re-render whatever's currently visible.
    for (const entry of this._pages) {
      const rect = entry.container.getBoundingClientRect();
      const vRect = /** @type {HTMLDivElement} */ (this._viewport).getBoundingClientRect();
      if (rect.bottom >= vRect.top - 200 && rect.top <= vRect.bottom + 200) {
        this._renderPage(entry);
      }
    }
  }

  _resolveScale(baseViewport) {
    const viewport = /** @type {HTMLDivElement} */ (this._viewport);
    const availableWidth = Math.max(50, viewport.clientWidth - PAGE_GAP * 2);
    const availableHeight = Math.max(50, viewport.clientHeight - PAGE_GAP * 2);
    if (this._fitMode === 'width') {
      return availableWidth / baseViewport.width;
    }
    if (this._fitMode === 'fit') {
      return Math.min(
        availableWidth / baseViewport.width,
        availableHeight / baseViewport.height,
      );
    }
    return /** @type {number} */ (this._fitMode);
  }

  // --- internal: find -------------------------------------------------

  async _runFind(query, options) {
    const pdfDoc = this._pdfDoc;
    if (pdfDoc === null) return;
    const needle = query.trim().toLowerCase();
    if (needle === '') {
      this._setStatus('');
      return;
    }
    const startPage = options && options.advance
      ? this._currentPage + 1
      : this._currentPage;
    // Sweep forward from startPage, wrap to the beginning. We only
    // resolve text on pages we actually examine, so big PDFs aren't
    // eagerly scanned just because the user typed a letter.
    const numPages = pdfDoc.numPages;
    for (let offset = 0; offset < numPages; offset += 1) {
      let n = ((startPage - 1 + offset) % numPages) + 1;
      const entry = this._pages.find((p) => p.pageNum === n);
      if (entry === undefined) continue;
      const text = await this._pageTextLower(entry);
      if (text.includes(needle)) {
        this._setStatus(`Found "${query}" on page ${n}.`);
        this._gotoPage(n);
        return;
      }
    }
    this._setStatus(`No matches for "${query}".`);
  }

  async _pageTextLower(entry) {
    if (entry.textLower !== undefined) return entry.textLower;
    await this._extractPageTextRaw(entry);
    return entry.textLower ?? '';
  }

  /** Extract the raw (case-preserving) text for one page entry and
   *  cache it. Newlines are inserted on PDF.js's `hasEOL` markers so
   *  the result reads more like the visible document than a flat
   *  space-joined run would. Errors leave the entry's cache as an
   *  empty string so subsequent callers don't keep retrying. */
  async _extractPageTextRaw(entry) {
    if (entry.textRaw !== undefined) return entry.textRaw;
    try {
      if (entry.page === null) {
        entry.page = await this._pdfDoc.getPage(entry.pageNum);
      }
      const textContent = await entry.page.getTextContent();
      let acc = '';
      for (const item of textContent.items) {
        if (typeof item.str === 'string') acc += item.str;
        if (item.hasEOL) acc += '\n';
      }
      entry.textRaw = acc;
      entry.textLower = acc.toLowerCase();
      return acc;
    } catch {
      entry.textRaw = '';
      entry.textLower = '';
      return '';
    }
  }

  // --- public: Lisp surface -------------------------------------------

  /** The 1-based current page (most-visible page in the viewport).
   *  Zero when no document is loaded. */
  get currentPageNumber() {
    return this._pdfDoc === null ? 0 : this._currentPage;
  }

  /** Total page count of the loaded document, or zero when nothing is
   *  loaded. */
  get pageCount() {
    return this._pdfDoc === null ? 0 : this._pdfDoc.numPages;
  }

  /**
   * The text of one page as a string. The first call for a page
   * triggers PDF.js's text-content extraction; subsequent calls return
   * the cached result. Throws when no document is loaded or the page
   * number is out of range.
   *
   * @param {number} pageNum - 1-based page number.
   * @returns {Promise<string>}
   */
  async extractPageText(pageNum) {
    if (this._pdfDoc === null) {
      throw new Error('PdfView.extractPageText: no PDF loaded');
    }
    const entry = this._pages.find((p) => p.pageNum === pageNum);
    if (entry === undefined) {
      throw new Error(
        `PdfView.extractPageText: page ${pageNum} out of range ` +
        `(1..${this._pdfDoc.numPages})`
      );
    }
    return this._extractPageTextRaw(entry);
  }

  /**
   * The text of every page in `[m, n]` (inclusive), as an array of
   * strings of length `n - m + 1`. `m` is clamped to 1 and `n` to the
   * document's page count; an inverted range throws. Each page's text
   * is cached, so a subsequent overlapping range is incremental.
   *
   * @param {number} m - 1-based first page.
   * @param {number} n - 1-based last page (inclusive).
   * @returns {Promise<string[]>}
   */
  async extractPageRangeText(m, n) {
    if (this._pdfDoc === null) {
      throw new Error('PdfView.extractPageRangeText: no PDF loaded');
    }
    if (!Number.isFinite(m) || !Number.isFinite(n) || n < m) {
      throw new Error(
        `PdfView.extractPageRangeText: invalid range ${m}..${n}`
      );
    }
    const first = Math.max(1, Math.floor(m));
    const last = Math.min(this._pdfDoc.numPages, Math.floor(n));
    const out = [];
    for (let i = first; i <= last; i += 1) {
      // Sequential await keeps the worker from being deluged by a
      // hundred concurrent getTextContent calls on a long range.
      // eslint-disable-next-line no-await-in-loop
      out.push(await this.extractPageText(i));
    }
    return out;
  }

  // --- internal: state + teardown ------------------------------------

  /** Write the current page + zoom back to the view's top-level fields
   *  so they round-trip a tab switch. (The view object is the spread
   *  of `createView({ extras })`, so page / zoom live alongside src /
   *  filePath, not nested under an `extras` key.) */
  _persistBufferState() {
    if (!this._buffer) return;
    this._buffer.page = this._currentPage;
    this._buffer.zoom = this._fitMode;
  }

  _setStatus(text) {
    if (this._statusEl !== null) {
      this._statusEl.textContent = text;
      this._statusEl.hidden = text === '';
    }
  }

  _teardownDoc() {
    if (this._loadingTask !== null) {
      try { this._loadingTask.destroy(); } catch { /* ignore */ }
      this._loadingTask = null;
    }
    if (this._observer !== null) {
      this._observer.disconnect();
      this._observer = null;
    }
    for (const entry of this._pages) {
      if (entry.renderTask !== null) {
        try { entry.renderTask.cancel(); } catch { /* ignore */ }
      }
    }
    this._pages = [];
    if (this._viewport !== null) this._viewport.replaceChildren();
    if (this._pdfDoc !== null) {
      try { this._pdfDoc.destroy(); } catch { /* ignore */ }
      this._pdfDoc = null;
    }
    this._loadedFilePath = null;
  }
}

defineViewElement('pdf-view', PdfView);
