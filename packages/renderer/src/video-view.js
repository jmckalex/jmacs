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
import { mediaErrorAdvice, mimeTypeForVideo } from './media-view.js';

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

  // Error block, only shown when the <video> element fires an `error`
  // event (almost always SRC_NOT_SUPPORTED — Chromium can't decode the
  // codec or container). The block replaces the broken element and
  // tells the user exactly what's wrong and how to convert.
  const errorBlock = buildErrorBlock(doc);
  stage.append(errorBlock.root);

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

  /** Hide the player and show the error block. */
  function showError() {
    const advice = mediaErrorAdvice(videoEl.error, buffer ? buffer.name : '');
    if (!advice) return;
    videoEl.style.display = 'none';
    errorBlock.show(advice);
  }

  /** Clear the error block — called every time a new buffer mounts so
   *  switching from a broken file to a working one shows the player. */
  function clearError() {
    videoEl.style.display = '';
    errorBlock.hide();
  }

  videoEl.addEventListener('error', showError);

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
    clearError();
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

/**
 * Build the error-block element shown when the `<video>`/`<audio>`
 * element's `error` event fires. Exposed via factory so both views
 * use the same DOM shape and styling. The block is hidden by default;
 * `show(advice)` populates and reveals it, `hide()` empties it.
 *
 * @param {Document} doc
 */
export function buildErrorBlock(doc) {
  const root = doc.createElement('div');
  root.className = 'media-error';
  root.hidden = true;

  const headline = doc.createElement('div');
  headline.className = 'media-error-headline';
  root.append(headline);

  const detail = doc.createElement('p');
  detail.className = 'media-error-detail';
  root.append(detail);

  const suggestion = doc.createElement('p');
  suggestion.className = 'media-error-suggestion';
  root.append(suggestion);

  const commandRow = doc.createElement('div');
  commandRow.className = 'media-error-command-row';
  const commandEl = doc.createElement('code');
  commandEl.className = 'media-error-command';
  const copyBtn = doc.createElement('button');
  copyBtn.className = 'media-error-copy';
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.title = 'Copy command to clipboard';
  commandRow.append(commandEl, copyBtn);
  root.append(commandRow);

  copyBtn.addEventListener('click', async () => {
    const text = commandEl.textContent ?? '';
    if (!text) return;
    try {
      const nav = doc.defaultView?.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(text);
        copyBtn.textContent = 'Copied';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 1200);
      }
    } catch {
      /* clipboard may be unavailable; the user can still read + paste */
    }
  });

  return {
    root,
    show(advice) {
      headline.textContent = advice.headline;
      detail.textContent = advice.detail;
      if (advice.suggestion) {
        suggestion.textContent = advice.suggestion;
        suggestion.hidden = false;
      } else {
        suggestion.hidden = true;
      }
      if (advice.command) {
        commandEl.textContent = advice.command;
        commandRow.hidden = false;
      } else {
        commandRow.hidden = true;
      }
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
      headline.textContent = '';
      detail.textContent = '';
      suggestion.textContent = '';
      commandEl.textContent = '';
    },
  };
}
