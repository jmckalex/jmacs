/**
 * @file The audio view — the view an `audio`-kind buffer is shown
 * through. An audio buffer is the result of opening a single audio
 * file (`.mp3`, `.flac`, `.wav`, …) the way the image view opens a
 * single image: the editor's text path is bypassed and an HTML5
 * `<audio>` element handles playback.
 *
 * The buffer carries:
 *
 *   { kind: 'audio',
 *     name: 'track.flac',
 *     filePath: '/Users/.../track.flac',
 *     src: 'media://localhost/...',
 *     metadata: { title, artist, album, ... } | undefined,
 *     albumArtSrc: 'data:image/...' | undefined }
 *
 * `metadata` and `albumArtSrc` come from the host's audio-metadata /
 * audio-art extractors before the buffer is mounted; either or both
 * may be absent (an untagged file, a format without art) and the view
 * still works.
 *
 * The jukebox-view uses the shared audio controller (so playback
 * survives a buffer switch and the Lisp `audio-playing?` primitive
 * stays truthful). This view does NOT: each audio buffer owns its own
 * `<audio>` element so several open files can sit alongside the
 * jukebox without their playback heads clashing. Switching away
 * leaves the element paused (see `destroy`); switching back resumes
 * from where the user paused.
 */

import { keyEventToString } from './keymap.js';
import { mimeTypeForAudio } from './media-view.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Tags whose own keyboard handling must not be hijacked. */
const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

/**
 * Format `seconds` as `M:SS` (or `H:MM:SS` once the duration crosses
 * an hour). Returns the empty string when the input is not a finite
 * number — `<audio>` reports `NaN` for an unloaded duration.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.round(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Create the audio view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Dispatches a key
 *   typed in the view through the global Lisp keymap, so chord keys
 *   (`C-x b`, `M-x`, `C-x k`, …) still work here. Returns whether the
 *   key was handled.
 * @param {() => void} [options.closeBuffer] - Called when the user
 *   presses `q` to dismiss the audio buffer.
 * @returns {{element: HTMLElement, setBuffer: (buffer: object | null)
 *   => void, focus: () => void, destroy: () => void}}
 */
export function createAudioView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const closeBuffer =
    typeof options.closeBuffer === 'function' ? options.closeBuffer : null;

  const root = doc.createElement('div');
  root.className = 'audio-view';
  root.tabIndex = 0;
  container.append(root);

  const layout = doc.createElement('div');
  layout.className = 'audio-layout';
  root.append(layout);

  // Left column — the album art (or a placeholder).
  const artStage = doc.createElement('div');
  artStage.className = 'audio-art';
  const artImg = doc.createElement('img');
  artImg.className = 'audio-art-image';
  artImg.alt = '';
  const artPlaceholder = doc.createElement('div');
  artPlaceholder.className = 'audio-art-placeholder';
  artPlaceholder.textContent = 'No album art';
  artStage.append(artImg, artPlaceholder);
  layout.append(artStage);

  // Right column — the title and metadata block, with the audio
  // element pinned to the bottom.
  const right = doc.createElement('div');
  right.className = 'audio-right';
  layout.append(right);

  const titleEl = doc.createElement('h1');
  titleEl.className = 'audio-title';
  right.append(titleEl);

  const subtitleEl = doc.createElement('div');
  subtitleEl.className = 'audio-subtitle';
  right.append(subtitleEl);

  const metaList = doc.createElement('dl');
  metaList.className = 'audio-meta';
  right.append(metaList);

  const audioEl = doc.createElement('audio');
  audioEl.className = 'audio-player';
  audioEl.controls = true;
  audioEl.preload = 'metadata';
  right.append(audioEl);

  /** The audio buffer currently shown, or `null`. */
  let buffer = null;

  /** Append one (term, value) row to the metadata list. Empty values
   *  are skipped — a missing field shouldn't waste a row. */
  function appendMeta(term, value) {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text === '') return;
    const dt = doc.createElement('dt');
    dt.textContent = term;
    const dd = doc.createElement('dd');
    dd.textContent = text;
    metaList.append(dt, dd);
  }

  /** Render the metadata block, the title and the subtitle for the
   *  current buffer. */
  function paint() {
    metaList.replaceChildren();
    if (!buffer) {
      titleEl.textContent = '';
      subtitleEl.textContent = '';
      artImg.removeAttribute('src');
      artImg.style.display = 'none';
      artPlaceholder.style.display = '';
      return;
    }
    const meta = buffer.metadata ?? null;
    const title = (meta && meta.title) || buffer.name || 'Audio';
    titleEl.textContent = title;

    // The subtitle line: "Artist — Album" if both are present, just
    // one of them if only one is, the filename if neither.
    const artist = meta && meta.artist ? String(meta.artist) : '';
    const album = meta && meta.album ? String(meta.album) : '';
    let subtitle = '';
    if (artist && album) subtitle = `${artist} — ${album}`;
    else if (artist) subtitle = artist;
    else if (album) subtitle = album;
    subtitleEl.textContent = subtitle;

    if (meta) {
      appendMeta('Artist', meta.artist);
      appendMeta('Album', meta.album);
      appendMeta('Track', meta.track);
      appendMeta('Year', meta.year);
      appendMeta('Genre', meta.genre);
      if (typeof meta.duration === 'number') {
        appendMeta('Duration', formatDuration(meta.duration));
      }
    }
    appendMeta('File', buffer.name);
    const mime = mimeTypeForAudio(buffer.name);
    if (mime) appendMeta('Format', mime);
    if (buffer.filePath) appendMeta('Path', buffer.filePath);

    if (typeof buffer.albumArtSrc === 'string' && buffer.albumArtSrc !== '') {
      artImg.src = buffer.albumArtSrc;
      artImg.style.display = '';
      artPlaceholder.style.display = 'none';
    } else {
      artImg.removeAttribute('src');
      artImg.style.display = 'none';
      artPlaceholder.style.display = '';
    }
  }

  // Key handling mirrors doc-view: `q` closes; bare printables are
  // swallowed so they don't fall through to handle-key and self-insert
  // into the text buffer behind us. Chord keys still route through
  // onKey so `C-x k`, `M-x`, etc. stay reachable.
  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    // Keys typed into the <audio> controls (volume slider arrow keys,
    // spacebar, …) belong to the browser's media UI.
    if (FORM_TAGS.has(event.target.tagName)) return;
    if (event.target === audioEl) return;
    const key = keyEventToString(event);

    // Modifier chords go straight to the global keymap.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      if (onKey && onKey(key)) event.preventDefault();
      return;
    }

    if (key === 'q') {
      event.preventDefault();
      if (closeBuffer) closeBuffer();
      return;
    }
    // Spacebar toggles play / pause when focus is on the view root.
    if (key === ' ') {
      event.preventDefault();
      if (audioEl.paused) {
        audioEl.play().catch(() => {});
      } else {
        audioEl.pause();
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
   * Show an audio buffer.
   *
   * @param {object | null} next
   */
  function setBuffer(next) {
    // Switching buffers: stop whatever the previous file was doing.
    if (buffer && buffer !== next) {
      try {
        audioEl.pause();
      } catch {
        /* ignore */
      }
    }
    buffer = next;
    if (!buffer || typeof buffer.src !== 'string') {
      audioEl.removeAttribute('src');
      paint();
      return;
    }
    // Only reset src when the source actually changed — a same-buffer
    // re-mount (the host re-points us at the same record) should not
    // restart playback from zero.
    if (audioEl.getAttribute('src') !== buffer.src) {
      audioEl.src = buffer.src;
    }
    paint();
  }

  /** Pause the element and drop the source so a destroyed view stops
   *  holding the file open. Called by the host when the buffer is
   *  killed. */
  function destroy() {
    try {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
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
