/**
 * @file The video view — the view a `video`-kind buffer is shown
 * through. A video buffer is the result of opening a single video
 * file (`.mp4`, `.webm`, `.mov`, …) the same way the image view opens
 * a single image: the editor's text path is bypassed and an HTML5
 * `<video>` element handles playback.
 *
 * Buffer shape:
 *
 *   { kind: 'video',
 *     name: 'foo.mp4',
 *     filePath: '/Users/.../foo.mp4',
 *     src: 'media://localhost/...' }
 *
 * Unlike the audio view, there's no metadata sidebar and no album
 * art: a video carries its picture in the picture. The element is
 * centred and constrained with `object-fit: contain` so the aspect
 * ratio is preserved.
 *
 * Per-format note: Chromium does not natively decode `.mkv` (Matroska)
 * — the `<video>` element shows its native "no playable source"
 * message for those. The view still mounts; the modeline still reads
 * the filename; the user can `q` out.
 */

import { keyEventToString } from './keymap.js';
import { mimeTypeForVideo } from './media-view.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Tags whose own keyboard handling must not be hijacked. */
const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

/**
 * Create the video view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Dispatches a key
 *   typed in the view through the global Lisp keymap.
 * @param {() => void} [options.closeBuffer] - Called when the user
 *   presses `q` to dismiss the video buffer.
 * @returns {{element: HTMLElement, setBuffer: (buffer: object | null)
 *   => void, focus: () => void, destroy: () => void}}
 */
export function createVideoView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const closeBuffer =
    typeof options.closeBuffer === 'function' ? options.closeBuffer : null;

  const root = doc.createElement('div');
  root.className = 'video-view';
  root.tabIndex = 0;
  container.append(root);

  const stage = doc.createElement('div');
  stage.className = 'video-stage';
  root.append(stage);

  const videoEl = doc.createElement('video');
  videoEl.className = 'video-player';
  videoEl.controls = true;
  videoEl.preload = 'metadata';
  stage.append(videoEl);

  const caption = doc.createElement('div');
  caption.className = 'video-caption';
  const nameEl = doc.createElement('div');
  nameEl.className = 'video-name';
  const pathEl = doc.createElement('div');
  pathEl.className = 'video-path';
  caption.append(nameEl, pathEl);
  root.append(caption);

  /** The video buffer currently shown. */
  let buffer = null;

  /** Render the caption strip for the current buffer. */
  function paint() {
    if (!buffer) {
      nameEl.textContent = '';
      pathEl.textContent = '';
      return;
    }
    const mime = mimeTypeForVideo(buffer.name);
    nameEl.textContent = mime ? `${buffer.name}  —  ${mime}` : buffer.name;
    pathEl.textContent = buffer.filePath ?? '';
  }

  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    // The browser's video controls own their own keys (arrow keys for
    // scrubbing, space for play/pause when the element is focused).
    if (FORM_TAGS.has(event.target.tagName)) return;
    if (event.target === videoEl) return;
    const key = keyEventToString(event);

    if (event.ctrlKey || event.metaKey || event.altKey) {
      if (onKey && onKey(key)) event.preventDefault();
      return;
    }

    if (key === 'q') {
      event.preventDefault();
      if (closeBuffer) closeBuffer();
      return;
    }
    if (key === ' ') {
      event.preventDefault();
      if (videoEl.paused) {
        videoEl.play().catch(() => {});
      } else {
        videoEl.pause();
      }
      return;
    }
    // Any other plain printable: swallow so it doesn't reach
    // handle-key and self-insert into the text buffer the editor
    // view is still pointed at.
    if (key.length === 1) {
      event.preventDefault();
      return;
    }
    if (onKey && onKey(key)) event.preventDefault();
  });

  /**
   * Show a video buffer.
   *
   * @param {object | null} next
   */
  function setBuffer(next) {
    if (buffer && buffer !== next) {
      try {
        videoEl.pause();
      } catch {
        /* ignore */
      }
    }
    buffer = next;
    if (!buffer || typeof buffer.src !== 'string') {
      videoEl.removeAttribute('src');
      paint();
      return;
    }
    if (videoEl.getAttribute('src') !== buffer.src) {
      videoEl.src = buffer.src;
    }
    paint();
  }

  /** Pause and drop the source. Called by the host when the buffer
   *  is killed. */
  function destroy() {
    try {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch {
      /* ignore */
    }
    buffer = null;
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
    destroy,
  };
}
