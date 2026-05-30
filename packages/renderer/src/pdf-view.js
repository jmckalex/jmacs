/**
 * @file `<pdf-view>` — the custom element a buffer of kind `pdf` is
 * shown through. v1 wraps an Electron `<webview>` pointed at the file
 * via the existing `media://` protocol; Chromium's built-in PDF plugin
 * does the actual rendering (zoom / scroll / find / print / download
 * all "for free" via its own toolbar). PDF.js with theme-matching
 * chrome is the v2 plan documented in `plans/PDF-VIEW.md`.
 *
 * The class follows the same shape every other singleton-kind view
 * does (TextView, ImageView, AudioView, VideoView): a no-DOM
 * constructor, an explicit `configure(options)` step the host calls
 * once before mount, a lazy `_ensureMounted` from `connectedCallback`,
 * `setBuffer(view)` to point the webview at a new file, and an
 * explicit `destroy()` because move and dispose are
 * indistinguishable inside `disconnectedCallback`.
 *
 * Per-view-instance is the architectural shape; each pdf tab gets its
 * own `<pdf-view>` from the perKindConfigureFactory in app.js. There
 * is no shared `<webview>` across pdf tabs — Chromium's PDF plugin
 * keeps its own scroll position and zoom level per-webview, so
 * per-instance is the only way tabbed PDFs survive a tab switch with
 * their state intact.
 *
 * Suffix helpers (`isPdfName`, `mimeTypeForPdf`) live alongside the
 * class so the file-open dispatch can use them without pulling in the
 * whole element machinery.
 */

import { keyEventToString } from './keymap.js';
import { defineViewElement, ViewElement } from './view-elements.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

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
 *   for each keydown on the outer element that isn't a bare modifier.
 *   Returns whether the key was handled (truthy → preventDefault).
 *   Note: keys typed *inside* the `<webview>` (the rendered PDF and
 *   Chromium's own PDF toolbar) cannot be intercepted here — webview
 *   has its own focus world. Only outer-element keys (when the host
 *   gives the pdf-view focus directly) reach onKey.
 * @property {string} [partition] - The Electron webview partition the
 *   `<webview>` is mounted in. Defaults to `persist:pdf-views` so PDF
 *   sessions persist across reloads (Chromium remembers zoom / scroll
 *   per file inside the partition). Pass a non-`persist:` partition
 *   for ephemeral viewing.
 */

export class PdfView extends ViewElement {
  constructor() {
    super();
    /** @type {PdfViewOptions | null} */
    this._options = null;
    /** @type {HTMLElement | null} - The `<webview>` element. Typed
     *  loosely because the webview tag isn't in the standard DOM lib. */
    this._webview = null;
    /** The PDF buffer currently shown — `{name, src, filePath}` or null. */
    this._buffer = null;
  }

  /**
   * Supply the host's configuration. Must be called before the first
   * `connectedCallback` mounts the inner DOM. Calling it after mount
   * throws — reconfiguring an already-mounted view isn't supported.
   *
   * @param {PdfViewOptions} options
   */
  configure(options) {
    if (this._webview !== null) {
      throw new Error(
        'PdfView.configure: cannot reconfigure after the inner DOM is ' +
        'mounted; destroy() and replace if the host wants new options'
      );
    }
    this._options = options ?? null;
  }

  /**
   * Show a PDF buffer. The buffer carries `{name, src, filePath}` —
   * `src` is the `media://localhost/<path>` URL the host produced.
   * Passing `null` clears the webview's src. Safe to call before
   * connection — the next mount picks up the pending buffer.
   *
   * @param {object | null} next
   */
  setBuffer(next) {
    this._buffer = next;
    if (this._webview !== null) this._paint();
  }

  /** The buffer currently shown, or null. */
  get buffer() {
    return this._buffer;
  }

  /** Every pdf-view is kind 'pdf'. */
  get kind() { return 'pdf'; }

  // --- Custom-element lifecycle ---------------------------------------

  connectedCallback() {
    if (this._webview !== null) return;
    this._ensureMounted();
    this._paint();
  }

  /** Fired when the element leaves the document. Empty by convention
   *  (a move and a destroy look the same from here). Real teardown is
   *  `destroy()`. */
  disconnectedCallback() {
    /* intentionally empty */
  }

  /** Explicit teardown — clear the buffer reference and blank the
   *  webview's src so the underlying renderer process can be torn down
   *  by Chromium. Safe to call when the element was never mounted. */
  destroy() {
    if (this._webview !== null) {
      try {
        this._webview.setAttribute('src', 'about:blank');
      } catch {
        // Webview may already be in teardown; nothing useful to do.
      }
    }
    this._buffer = null;
  }

  // --- internal ------------------------------------------------------

  _ensureMounted() {
    if (this._webview !== null) return;
    const doc = this.ownerDocument;
    this.classList.add('pdf-view');
    this.tabIndex = 0;

    // The webview tag isn't in the standard DOM type lib but Electron
    // accepts it like any other element. `createElement` works fine.
    const webview = /** @type {HTMLElement} */ (doc.createElement('webview'));
    webview.className = 'pdf-content';
    const partition =
      this._options && typeof this._options.partition === 'string'
        ? this._options.partition
        : 'persist:pdf-views';
    webview.setAttribute('partition', partition);
    // No src yet — we wait for setBuffer / connectedCallback's _paint.
    this._webview = webview;
    this.append(webview);

    this.addEventListener('keydown', (event) => {
      if (MODIFIERS.has(event.key)) return;
      const onKey = this._options && this._options.onKey;
      if (typeof onKey === 'function' && onKey(keyEventToString(event))) {
        event.preventDefault();
      }
    });
  }

  /** Paint the current buffer onto the webview's src. Called from
   *  `connectedCallback` (initial mount) and `setBuffer` (subsequent
   *  changes). Reuses the webview element across buffer swaps; the
   *  attribute set is what Chromium picks up. */
  _paint() {
    if (this._webview === null) return;
    if (!this._buffer || typeof this._buffer.src !== 'string') {
      this._webview.setAttribute('src', 'about:blank');
      return;
    }
    this._webview.setAttribute('src', this._buffer.src);
  }
}

defineViewElement('pdf-view', PdfView);
