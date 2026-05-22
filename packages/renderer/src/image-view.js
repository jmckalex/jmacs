/**
 * @file The image view — the view an `image`-kind buffer is shown
 * through. A buffer has a kind; the host mounts the matching view (text
 * buffers → the editor view, an image buffer → this).
 *
 * The renderer is sandboxed, so it never touches the filesystem: the
 * host reads the image and hands this view a ready-to-display source (a
 * `data:` URL or an `app://` URL). The view's only job is presentation
 * — fit-to-window by default, with a toggle to actual (100%) size.
 *
 * Like the customisation view, this is decoupled from the Lisp: it
 * receives a plain-data model and reports nothing back.
 */

import { keyEventToString } from './keymap.js';

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
 * Create the image view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Dispatches a key
 *   typed in the view, so `C-x b`/`M-x` work here too. Returns whether
 *   the key was handled.
 * @returns {{element: HTMLElement, setBuffer: (buffer: object | null)
 *   => void, focus: () => void}}
 */
export function createImageView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;

  const root = doc.createElement('div');
  root.className = 'image-view';
  root.tabIndex = 0;
  container.append(root);

  const toolbar = doc.createElement('div');
  toolbar.className = 'image-toolbar';

  const info = doc.createElement('span');
  info.className = 'image-info';

  const zoomButton = doc.createElement('button');
  zoomButton.className = 'image-zoom-toggle';

  toolbar.append(info, zoomButton);

  const stage = doc.createElement('div');
  stage.className = 'image-stage';

  const img = doc.createElement('img');
  img.className = 'image-content';
  img.alt = '';
  stage.append(img);

  root.append(toolbar, stage);

  /** The image buffer currently shown. */
  let buffer = null;
  /** `'fit'` (fit-to-window) or `'actual'` (100%). */
  let mode = 'fit';

  /** Apply the current zoom mode to the image and the toggle button. */
  function applyMode() {
    img.classList.toggle('is-fit', mode === 'fit');
    img.classList.toggle('is-actual', mode === 'actual');
    stage.classList.toggle('is-actual', mode === 'actual');
    zoomButton.textContent =
      mode === 'fit' ? 'Actual size (100%)' : 'Fit to window';
  }

  zoomButton.addEventListener('click', () => {
    mode = mode === 'fit' ? 'actual' : 'fit';
    applyMode();
  });

  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    // The toggle button handles its own key activation.
    if (event.target === zoomButton) return;
    if (onKey && onKey(keyEventToString(event))) event.preventDefault();
  });

  /** Render the toolbar for the current buffer once the image loads. */
  function showInfo() {
    if (!buffer) {
      info.textContent = '';
      return;
    }
    const dims =
      img.naturalWidth > 0
        ? `  —  ${img.naturalWidth}×${img.naturalHeight}`
        : '';
    info.textContent = (buffer.name ?? 'image') + dims;
  }

  img.addEventListener('load', showInfo);
  img.addEventListener('error', () => {
    info.textContent = `${buffer ? buffer.name : 'image'}  —  failed to load`;
  });

  /**
   * Show an image buffer. The buffer carries `{name, src}` — `src` is a
   * ready-to-display URL the host produced.
   *
   * @param {object | null} next
   */
  function setBuffer(next) {
    buffer = next;
    mode = 'fit';
    applyMode();
    if (!buffer || typeof buffer.src !== 'string') {
      img.removeAttribute('src');
      info.textContent = '';
      return;
    }
    img.alt = buffer.name ?? '';
    img.src = buffer.src;
    showInfo();
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
  };
}
