/**
 * @file `<image-view>` — the custom element a buffer of kind `image` is
 * shown through. A buffer has a kind; the host mounts the matching
 * element type (text buffers → `<text-view>`, image buffers → this).
 *
 * Phase 3a of `plans/VIEWS-AS-CUSTOM-ELEMENTS.md`. The element replaces
 * the `createImageView` factory; what was the factory's `root` div is
 * now the element itself, and the toolbar / stage / image children live
 * directly inside it. The element-as-root model lets the DOM enforce
 * Q9 ("no same View in two panes") — the same element can't sit in
 * two parents — and lets the standard `connectedCallback` /
 * `disconnectedCallback` lifecycle replace the bespoke mount/dispose
 * machinery the host's mount dispatch used to drive.
 *
 * The renderer remains sandboxed: this element never touches the
 * filesystem. The host reads the image and hands us a ready-to-display
 * `src` (a `data:` URL or an `app://` URL) via `setBuffer(buffer)`.
 *
 * Lifecycle:
 *
 *   - `constructor()` does no DOM work. State fields are initialised
 *     to null / sentinel.
 *   - `configure(options)` supplies the host-provided closures
 *     (currently just `onKey`). Must be called before the first
 *     `connectedCallback`; reconfiguring after mount throws.
 *   - `setBuffer(buffer)` populates the image source. Idempotent on
 *     null. Safe to call before connection — the inner DOM mounts
 *     lazily.
 *   - `connectedCallback()` builds the inner DOM on first connect and
 *     paints whatever buffer is pending. A re-connect (warehouse ↔
 *     pane) is a no-op for the structure; only the tree position
 *     changes.
 *   - `disconnectedCallback()` is empty (moves and destroys look the
 *     same here; Phase 0 Decision 3).
 *   - `destroy()` is the explicit teardown — clears the buffer
 *     reference and detaches the image src so the underlying resource
 *     can be GC'd.
 */

import { keyEventToString } from './keymap.js';
import { defineViewElement, ViewElement } from './view-elements.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** File-name suffix → image MIME type, for the suffixes jmacs opens as
 *  images. The keys are lower-case, with the leading dot. */
const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/**
 * The image MIME type for a file name, by its suffix.
 *
 * @param {string} name - A file name or path.
 * @returns {string | null} The MIME type, or `null` when the name has
 *   no recognised image suffix.
 */
export function mimeTypeForImage(name) {
  if (typeof name !== 'string') return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const suffix = name.slice(dot).toLowerCase();
  return IMAGE_MIME_TYPES[suffix] ?? null;
}

/**
 * Whether a file name names an image jmacs should open as an image
 * buffer rather than as text.
 *
 * @param {string} name - A file name or path.
 * @returns {boolean}
 */
export function isImageName(name) {
  return mimeTypeForImage(name) !== null;
}

/**
 * @typedef {object} ImageViewOptions
 * @property {(key: string) => boolean} [onKey] - Key dispatcher. Called
 *   for each keydown that isn't a bare modifier and didn't originate
 *   from the zoom toggle button. Returns whether the key was handled
 *   (truthy → preventDefault).
 */

export class ImageView extends ViewElement {
  constructor() {
    super();
    /** @type {ImageViewOptions | null} */
    this._options = null;
    /** @type {HTMLElement | null} */
    this._toolbar = null;
    /** @type {HTMLElement | null} */
    this._info = null;
    /** @type {HTMLButtonElement | null} */
    this._zoomButton = null;
    /** @type {HTMLElement | null} */
    this._stage = null;
    /** @type {HTMLImageElement | null} */
    this._img = null;
    /** The image buffer currently shown — `{name, src}` or null. */
    this._buffer = null;
    /** `'fit'` (fit-to-window) or `'actual'` (100%). */
    this._mode = 'fit';
  }

  /**
   * Supply the host's configuration. Must be called before the first
   * `connectedCallback` mounts the inner DOM. Calling it after mount
   * throws — reconfiguring an already-mounted view isn't supported.
   *
   * @param {ImageViewOptions} options
   */
  configure(options) {
    if (this._img !== null) {
      throw new Error(
        'ImageView.configure: cannot reconfigure after the inner DOM is ' +
        'mounted; destroy() and replace if the host wants new options'
      );
    }
    this._options = options ?? null;
  }

  /**
   * Show an image buffer. The buffer carries `{name, src}` — `src` is
   * a ready-to-display URL the host produced. Passing `null` clears
   * the image; safe to call before connection (the next mount picks
   * up the pending buffer).
   *
   * @param {object | null} next
   */
  setBuffer(next) {
    this._buffer = next;
    this._mode = 'fit';
    if (this._img !== null) this._paint();
  }

  /** The buffer currently shown, or null. */
  get buffer() {
    return this._buffer;
  }

  /** Every image-view is kind 'image'. */
  get kind() { return 'image'; }

  // --- Custom-element lifecycle ---------------------------------------

  connectedCallback() {
    if (this._img !== null) return;
    this._ensureMounted();
    this._paint();
  }

  /** Fired when the element leaves the document. Empty by convention
   *  (a move and a destroy look the same from here). Real teardown is
   *  `destroy()`. */
  disconnectedCallback() {
    /* intentionally empty */
  }

  /** Explicit teardown — detach the image source so the underlying
   *  resource can be GC'd, clear state. Safe to call when the element
   *  was never mounted. */
  destroy() {
    if (this._img !== null) {
      this._img.removeAttribute('src');
    }
    this._buffer = null;
  }

  // --- internal ------------------------------------------------------

  _ensureMounted() {
    if (this._img !== null) return;
    const doc = this.ownerDocument;
    this.classList.add('image-view');
    this.tabIndex = 0;

    this._toolbar = doc.createElement('div');
    this._toolbar.className = 'image-toolbar';

    this._info = doc.createElement('span');
    this._info.className = 'image-info';

    this._zoomButton = doc.createElement('button');
    this._zoomButton.className = 'image-zoom-toggle';

    this._toolbar.append(this._info, this._zoomButton);

    this._stage = doc.createElement('div');
    this._stage.className = 'image-stage';

    this._img = doc.createElement('img');
    this._img.className = 'image-content';
    this._img.alt = '';
    this._stage.append(this._img);

    this.append(this._toolbar, this._stage);

    this._zoomButton.addEventListener('click', () => {
      this._mode = this._mode === 'fit' ? 'actual' : 'fit';
      this._applyMode();
    });

    this.addEventListener('keydown', (event) => {
      if (MODIFIERS.has(event.key)) return;
      // The toggle button handles its own key activation.
      if (event.target === this._zoomButton) return;
      const onKey = this._options && this._options.onKey;
      if (typeof onKey === 'function' && onKey(keyEventToString(event))) {
        event.preventDefault();
      }
    });

    this._img.addEventListener('load', () => this._showInfo());
    this._img.addEventListener('error', () => {
      if (this._info === null) return;
      this._info.textContent =
        `${this._buffer ? this._buffer.name : 'image'}  —  failed to load`;
    });
  }

  /** Apply the current zoom mode to the image and the toggle button. */
  _applyMode() {
    if (this._img === null) return;
    this._img.classList.toggle('is-fit', this._mode === 'fit');
    this._img.classList.toggle('is-actual', this._mode === 'actual');
    this._stage.classList.toggle('is-actual', this._mode === 'actual');
    this._zoomButton.textContent =
      this._mode === 'fit' ? 'Actual size (100%)' : 'Fit to window';
  }

  /** Render the toolbar's info line for the current buffer. */
  _showInfo() {
    if (this._info === null) return;
    if (!this._buffer) {
      this._info.textContent = '';
      return;
    }
    const dims =
      this._img !== null && this._img.naturalWidth > 0
        ? `  —  ${this._img.naturalWidth}×${this._img.naturalHeight}`
        : '';
    this._info.textContent = (this._buffer.name ?? 'image') + dims;
  }

  /** Paint the current buffer onto the inner DOM. Called from
   *  `connectedCallback` (initial mount) and `setBuffer` (subsequent
   *  changes). */
  _paint() {
    this._applyMode();
    if (!this._buffer || typeof this._buffer.src !== 'string') {
      this._img.removeAttribute('src');
      if (this._info !== null) this._info.textContent = '';
      return;
    }
    this._img.alt = this._buffer.name ?? '';
    this._img.src = this._buffer.src;
    this._showInfo();
  }
}

defineViewElement('image-view', ImageView);
