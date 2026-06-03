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
 *  to the repository root and `readFile` follows symlinks, so this URL
 *  reaches the pnpm symlink the renderer's local node_modules points at.
 *  (pnpm's isolated layout doesn't install pdfjs-dist at the repo root —
 *  same as `@xterm/xterm` etc., the import-map pattern points at the
 *  renderer's copy.) */
const PDFJS_BASE = 'app://editor/packages/renderer/node_modules/pdfjs-dist';

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
 * @property {(page: number, x: number, y: number) => void} [onSyncTexClick]
 *   - Inverse-SyncTeX click hook. Called when the user Option-clicks a
 *   page, with the 1-based `page` and the clicked PDF point `(x, y)` in
 *   SyncTeX's convention (points, origin at the page's top-left). The
 *   host runs `synctex edit` and jumps the editor to the source line.
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
    /** `<mark>` elements currently highlighting find matches on the
     *  page in view. Cleared on every new search. */
    /** @type {HTMLElement[]} */
    this._findMatches = [];
    /** Index into `_findMatches` of the "current" highlight, or -1 if
     *  no search is active. Enter / Shift+Enter cycle this within the
     *  current page; exhausting the page jumps to the next/previous
     *  page that has matches. */
    this._findMatchIndex = -1;
    /** The needle the current `_findMatches` were derived from. Lets
     *  the Enter handler distinguish "same search, advance" from "new
     *  search, restart" without round-tripping through _runFind. */
    this._findQuery = '';
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

  /**
   * Force a reload of the current PDF, bypassing the same-path load
   * guard. A recompile (AUCTeX) produces the *same* file path with
   * *new* bytes on disk — `_loadFromBuffer` would normally short-circuit
   * because `_loadedFilePath` still matches. `_teardownDoc()` clears
   * that guard (it resets `_loadedFilePath = null`), so re-running
   * `_loadFromBuffer` fetches the fresh bytes.
   *
   * The current page is preserved across the reload: it is stashed on
   * the buffer's `page` slot, which `_loadFromBuffer` reads back as the
   * saved page (clamped to the new page count). A no-op when no buffer
   * is loaded or the view was never mounted.
   */
  reload() {
    if (!this._buffer) return;
    // Preserve the page the user is on. `_loadFromBuffer` restores
    // `view.page` (clamped to the reloaded doc's page count).
    if (typeof this._currentPage === 'number' && this._currentPage >= 1) {
      this._buffer.page = this._currentPage;
    }
    this._teardownDoc();
    if (this._mounted) this._loadFromBuffer();
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
        clearTimeout(this._findDebounce);
        const direction = event.shiftKey ? 'backward' : 'forward';
        const trimmed = findInput.value.trim();
        // Same search → cycle within the current page first; only fall
        // through to a page-level jump when the page is exhausted.
        // Different search → start fresh from the current page.
        if (trimmed === this._findQuery
            && this._advanceFindMatch(direction)) {
          return;
        }
        this._runFind(findInput.value, {
          direction,
          advance: trimmed === this._findQuery,
        });
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        findInput.value = '';
        this._clearHighlights();
        this._findQuery = '';
        this._setStatus('');
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

    // Cache-bust the media:// URL so a reload after a recompile fetches
    // the NEW bytes, not Chromium's cached copy of the same path. The
    // media protocol resolves the file from url.pathname (serve.js), so
    // the query is ignored server-side but makes each load a distinct URL.
    const bustedSrc = `${src}${src.includes('?') ? '&' : '?'}v=${generation}`;
    const task = pdfjs.getDocument({
      url: bustedSrc,
      cMapUrl: `${PDFJS_BASE}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
      // OCR-scanned PDFs encode pages as JBIG2 / JPEG2000 images;
      // PDF.js decodes those through WASM modules bundled in
      // pdfjs-dist/wasm/. Without wasmUrl, getDocument loads but
      // every image page comes back as "JbigZ failed to initialize".
      wasmUrl: `${PDFJS_BASE}/wasm/`,
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

      // Inverse SyncTeX: an Option-click (Alt) on a page asks the editor
      // to jump to the source that produced the clicked spot. We use
      // `mousedown` (not `click`) so we can `preventDefault` before the
      // browser begins a text selection on the overlapping text layer.
      container.addEventListener('mousedown', (event) => {
        if (!event.altKey) return;
        this._onPageOptionClick(entry, event);
      });
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
    this._clearHighlights();
    const trimmed = query.trim();
    if (trimmed === '') {
      this._findQuery = '';
      this._setStatus('');
      return;
    }
    const needleLower = trimmed.toLowerCase();
    const direction = options && options.direction === 'backward'
      ? 'backward' : 'forward';
    const dirStep = direction === 'backward' ? -1 : 1;
    const advance = options && options.advance === true;
    const startPage = advance
      ? this._currentPage + dirStep
      : this._currentPage;
    const numPages = pdfDoc.numPages;
    for (let offset = 0; offset < numPages; offset += 1) {
      // Modular sweep — startPage -> ±1 -> ±2 -> ... wrapping at the
      // ends. The `+ numPages * numPages` term keeps the dividend
      // non-negative for backward sweeps.
      const n = ((startPage - 1 + dirStep * offset + numPages * numPages)
                  % numPages) + 1;
      const entry = this._pages.find((p) => p.pageNum === n);
      if (entry === undefined) continue;
      const text = await this._pageTextLower(entry);
      if (!text.includes(needleLower)) continue;
      // Render the page if it hasn't painted yet — highlighting walks
      // the text-layer DOM, which doesn't exist until then.
      await this._renderPage(entry);
      const count = this._highlightInPage(entry, trimmed);
      // Update current-page bookkeeping *without* re-triggering a
      // smooth scroll; we want the scroll target to be the highlight,
      // not the top of the page.
      this._currentPage = n;
      /** @type {HTMLInputElement} */ (this._pageInput).value = String(n);
      this._persistBufferState();
      this._findQuery = trimmed;
      if (count > 0) {
        // Forward arrival starts at the topmost match; backward
        // arrival starts at the bottommost so cycling continues to
        // feel "previous" instead of jumping to the top.
        const idx = direction === 'backward' ? count - 1 : 0;
        if (idx !== 0) {
          this._findMatches[0].classList.remove('is-current');
          this._findMatches[idx].classList.add('is-current');
        }
        this._findMatchIndex = idx;
        this._findMatches[idx].scrollIntoView({
          block: 'center',
          behavior: 'smooth',
        });
        this._setStatus(
          `Match ${idx + 1} of ${count} on page ${n}.`
        );
      } else {
        // The flat page text matched but the text layer didn't yield a
        // contiguous run (a line break splits the needle in the layer,
        // for example). Still useful to navigate to the page.
        entry.container.scrollIntoView({
          block: 'start',
          behavior: 'smooth',
        });
        this._findMatchIndex = -1;
        this._setStatus(
          `Found "${trimmed}" on page ${n} ` +
          `(no highlight — match likely spans a line break).`
        );
      }
      return;
    }
    this._findQuery = trimmed;
    this._setStatus(`No matches for "${trimmed}".`);
  }

  /** Move the "current" highlight forward / backward within the
   *  page that's already highlighted. Returns true on a successful
   *  move; false when the page is exhausted in the requested
   *  direction (the caller then falls through to a page-level jump). */
  _advanceFindMatch(direction) {
    const matches = this._findMatches;
    if (matches.length === 0 || this._findMatchIndex < 0) return false;
    const next = direction === 'backward'
      ? this._findMatchIndex - 1
      : this._findMatchIndex + 1;
    if (next < 0 || next >= matches.length) return false;
    matches[this._findMatchIndex].classList.remove('is-current');
    matches[next].classList.add('is-current');
    this._findMatchIndex = next;
    matches[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
    this._setStatus(
      `Match ${next + 1} of ${matches.length} on page ${this._currentPage}.`
    );
    return true;
  }

  /** Unwrap every active `<mark>` highlight, restoring the original
   *  text nodes inside the affected text-layer spans. Safe to call
   *  when nothing is highlighted. */
  _clearHighlights() {
    for (const mark of this._findMatches) {
      const parent = mark.parentNode;
      if (parent === null) continue;
      parent.replaceChild(this.ownerDocument.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
    this._findMatches = [];
    this._findMatchIndex = -1;
  }

  /** Highlight every occurrence of `needle` inside ENTRY's text layer
   *  by wrapping the matched characters in `<mark class="pdf-find-match">`
   *  elements. The first occurrence (in document order) gets the
   *  `.is-current` class for prominent styling.
   *
   *  Returns the number of matches found. Zero usually means the text
   *  layer couldn't reconstruct a contiguous string for the needle —
   *  often a line break splitting the match — in which case the
   *  caller falls back to a no-highlight jump.
   */
  _highlightInPage(entry, needle) {
    const textLayer = entry.textLayer;
    if (textLayer === null) return 0;
    // The text layer renders top-level `<span>` elements (one per
    // PDF.js text run) interspersed with `<br>` for hasEOL markers.
    // We walk only the spans; the `<br>`s contribute nothing to the
    // text content and so are invisible to the offset map.
    const spans = Array.from(textLayer.querySelectorAll(':scope > span'));
    if (spans.length === 0) return 0;
    const ranges = [];
    let acc = '';
    for (const span of spans) {
      const start = acc.length;
      acc += span.textContent;
      ranges.push({ start, end: acc.length });
    }
    const lowerAcc = acc.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    if (lowerNeedle === '') return 0;
    const matches = [];
    let from = 0;
    while (from <= lowerAcc.length) {
      const idx = lowerAcc.indexOf(lowerNeedle, from);
      if (idx === -1) break;
      matches.push({ start: idx, end: idx + lowerNeedle.length });
      from = idx + lowerNeedle.length;
    }
    // Wrap matches in reverse so the textContent rewrites we do for a
    // later match don't shift earlier matches' offsets — they're
    // independent per-span rewrites, but reverse order is the safer
    // invariant against subtle adjacency bugs.
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      this._wrapMatch(spans, ranges, matches[i]);
    }
    if (this._findMatches.length > 0) {
      // _findMatches collected in reverse-wrap-order; sort by
      // document position so [0] is the first occurrence and
      // scrollIntoView lands on the topmost match.
      this._findMatches.sort((a, b) => {
        const rel = a.compareDocumentPosition(b);
        if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
      this._findMatches[0].classList.add('is-current');
    }
    return this._findMatches.length;
  }

  /** Wrap the part of MATCH that lies within each crossed span. */
  _wrapMatch(spans, ranges, match) {
    let startIdx = -1;
    let endIdx = -1;
    for (let i = 0; i < ranges.length; i += 1) {
      if (startIdx === -1 && match.start < ranges[i].end) startIdx = i;
      if (match.end <= ranges[i].end) { endIdx = i; break; }
    }
    if (startIdx === -1) return;
    if (endIdx === -1) endIdx = ranges.length - 1;
    if (startIdx === endIdx) {
      this._wrapInSpan(
        spans[startIdx],
        match.start - ranges[startIdx].start,
        match.end - ranges[startIdx].start,
      );
      return;
    }
    // Multi-span: wrap last → middle → first so the spans we still
    // need to read (start offsets are slices into the original text)
    // aren't mutated until their turn.
    this._wrapInSpan(
      spans[endIdx],
      0,
      match.end - ranges[endIdx].start,
    );
    for (let i = endIdx - 1; i > startIdx; i -= 1) {
      this._wrapInSpan(spans[i], 0, spans[i].textContent.length);
    }
    this._wrapInSpan(
      spans[startIdx],
      match.start - ranges[startIdx].start,
      spans[startIdx].textContent.length,
    );
  }

  /** Wrap characters `[startInSpan, endInSpan)` of SPAN in a
   *  `<mark class="pdf-find-match">`. Rebuilds the span's inner DOM as
   *  text-mark-text. */
  _wrapInSpan(span, startInSpan, endInSpan) {
    if (startInSpan >= endInSpan) return;
    const text = span.textContent;
    const before = text.slice(0, startInSpan);
    const matchText = text.slice(startInSpan, endInSpan);
    const after = text.slice(endInSpan);
    const doc = this.ownerDocument;
    span.textContent = '';
    if (before !== '') span.appendChild(doc.createTextNode(before));
    const mark = doc.createElement('mark');
    mark.className = 'pdf-find-match';
    mark.textContent = matchText;
    span.appendChild(mark);
    if (after !== '') span.appendChild(doc.createTextNode(after));
    this._findMatches.push(mark);
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

  /**
   * Forward SyncTeX: scroll page `page` into view and flash a transient
   * highlight at the source position SyncTeX reported. Coordinates are in
   * PDF points with SyncTeX's convention — `(x, y)` is the click point and
   * the optional `box` `{h, v, w, h_}` (anchor `h`,`v` plus size `W`,`H`)
   * is the surrounding box; we draw the box when given, else a small
   * marker at `(x, y)`.
   *
   * Coordinate path: SyncTeX measures `v` from the page TOP, while PDF.js
   * uses PDF-native coordinates (origin bottom-left, y up). We flip with
   * `pageHeight - v` and run it through the page's viewport
   * `convertToViewportPoint`, which yields CSS-px coordinates inside the
   * page container (the container is CSS-px sized — DPR scales only the
   * canvas backing store, not layout — so no DPR factor enters here). The
   * highlight is an absolutely-positioned div in the page container; it
   * fades out via a CSS transition and is removed after the fade.
   *
   * Pragmatic about un-rendered pages: it forces a render of the target
   * page so the container has its real size, then scrolls + places the
   * highlight. A no-op when no document is loaded or the page is out of
   * range.
   *
   * @param {number} page - 1-based PDF page number.
   * @param {number} x - Click-point x (PDF points).
   * @param {number} y - Click-point y (PDF points, from page top).
   * @param {{ h?: number, v?: number, w?: number, h_?: number } | null} [box]
   *   Optional box anchor/size (PDF points): `h`,`v` top-left from page
   *   top, `w`,`h_` width/height. When present, the highlight covers it.
   * @returns {Promise<void>}
   */
  async syncTexShow(page, x, y, box) {
    const pdfDoc = this._pdfDoc;
    if (pdfDoc === null) return;
    const clamped = Math.max(1, Math.min(page, pdfDoc.numPages));
    const entry = this._pages.find((p) => p.pageNum === clamped);
    if (entry === undefined) return;

    // Bring the page on screen and ensure it's rendered so the container
    // carries its real CSS-px size (and `entry.page`/`entry.scale` exist).
    this._gotoPage(clamped, { instant: true });
    await this._renderPage(entry);
    if (entry.page === null) return;

    const scale = entry.scale || this._scale;
    const pageViewport = entry.page.getViewport({ scale });
    // The page's intrinsic height in PDF points (origin bottom-left).
    const baseViewBox = entry.page.getViewport({ scale: 1 }).viewBox;
    const pageHeightPts = baseViewBox[3] - baseViewBox[1];

    // SyncTeX v is from the TOP; PDF-native y is from the BOTTOM. Flip,
    // then convert to viewport (CSS-px, top-left origin) coordinates.
    const anchorH = (box && typeof box.h === 'number') ? box.h : x;
    const anchorV = (box && typeof box.v === 'number') ? box.v : y;
    const [vx, vy] = pageViewport.convertToViewportPoint(
      anchorH,
      pageHeightPts - anchorV,
    );

    const boxW = box && typeof box.w === 'number' && box.w > 0 ? box.w : 0;
    const boxH = box && typeof box.h_ === 'number' && box.h_ > 0 ? box.h_ : 0;
    // Box size scales linearly with the render scale (points -> CSS px).
    const cssW = boxW > 0 ? boxW * scale : 24;
    const cssH = boxH > 0 ? boxH * scale : 14;

    const doc = this.ownerDocument;
    const hl = doc.createElement('div');
    hl.className = 'pdf-synctex-highlight';
    hl.style.position = 'absolute';
    // `vy` is the top of the box (we flipped v, which is the box top);
    // when no box height, centre a small marker on the point instead.
    const left = boxW > 0 ? vx : vx - cssW / 2;
    const top = boxH > 0 ? vy : vy - cssH / 2;
    hl.style.left = `${left}px`;
    hl.style.top = `${top}px`;
    hl.style.width = `${cssW}px`;
    hl.style.height = `${cssH}px`;
    entry.container.appendChild(hl);

    // Force a layout read so the appended element starts opaque, then
    // trip the fade on the next frame (CSS transitions the opacity).
    // eslint-disable-next-line no-unused-expressions
    hl.offsetWidth;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        hl.classList.add('is-fading');
        hl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    } else {
      hl.classList.add('is-fading');
    }
    // Remove after the fade completes (CSS transition is ~1.2s).
    setTimeout(() => {
      if (hl.parentNode !== null) hl.parentNode.removeChild(hl);
    }, 1400);
  }

  /**
   * Inverse SyncTeX click handler: translate an Option-click on a page
   * into a PDF point (SyncTeX convention: origin top-left, points) and
   * hand it to the host's `onSyncTexClick(page, x, y)`.
   *
   * The page container is CSS-px sized (DPR scales only the canvas
   * backing store, never layout), so the click's offset relative to the
   * container's bounding box IS in CSS px and converts directly through
   * the page viewport's `convertToPdfPoint` — no DPR factor. That yields
   * PDF-native coordinates (origin bottom-left, y up); SyncTeX's `edit`
   * wants y measured from the page TOP, so we flip with `pageHeight - y`.
   *
   * @param {*} entry - The page entry that was clicked.
   * @param {MouseEvent} event
   */
  _onPageOptionClick(entry, event) {
    const onClick = this._options && this._options.onSyncTexClick;
    if (typeof onClick !== 'function') return;
    if (entry.page === null) return;
    // Don't let the Option-click also start a text selection.
    event.preventDefault();

    const rect = entry.container.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;

    const scale = entry.scale || this._scale;
    const pageViewport = entry.page.getViewport({ scale });
    const [pdfX, pdfYFromBottom] = pageViewport.convertToPdfPoint(cssX, cssY);

    // Flip to SyncTeX's top-origin convention.
    const baseViewBox = entry.page.getViewport({ scale: 1 }).viewBox;
    const pageHeightPts = baseViewBox[3] - baseViewBox[1];
    const pdfY = pageHeightPts - pdfYFromBottom;

    onClick(entry.pageNum, pdfX, pdfY);
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
