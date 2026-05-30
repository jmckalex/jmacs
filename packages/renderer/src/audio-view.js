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
import { mediaErrorAdvice, mimeTypeForAudio } from './media-view.js';
import { buildErrorBlock } from './video-view.js';

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

/** The metadata keys the user can edit. Anything else the view shows
 *  (file, format, path) is derived and read-only — see the
 *  editable-vs-derived discussion in `plans/AUDIO-METADATA-EDIT.md`.
 *  Title is also editable (via double-click on the headline).
 *
 *  Extra keys present in `buffer.metadata` (e.g. `composer`) appear
 *  as editable rows below the standard ones.
 */
const STANDARD_EDITABLE_KEYS = ['artist', 'album', 'track', 'year', 'genre'];

/** Map standard meta keys to the labels shown in the row's <dt>. */
const KEY_LABELS = {
  artist: 'Artist',
  album: 'Album',
  track: 'Track',
  year: 'Year',
  genre: 'Genre',
};

/** A one-line failure message for the minibuffer. Accepts a string,
 *  an Error-like with `.message`, or `null`/`undefined`. */
export function formatEditError(error) {
  if (!error) return 'editing failed';
  if (typeof error === 'string') return `editing failed: ${error}`;
  if (typeof error.message === 'string') return `editing failed: ${error.message}`;
  return 'editing failed';
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
 * @param {(args: { key: string, value: string, buffer: object })
 *   => { ok: true, metadata: object } | { ok: false, error: string }}
 *   [options.onSetMetadata] - Called when the user commits an inline
 *   edit or confirms the plus-pill. Returns success + the updated
 *   metadata, or failure + a one-line error. Sync — Lisp interpreter
 *   is sync and the audio metadata host primitives are too.
 * @param {(args: { key: string, buffer: object })
 *   => { ok: true, metadata: object } | { ok: false, error: string }}
 *   [options.onRemoveMetadata] - Called when the user clicks the minus
 *   button on an editable row.
 * @param {(message: string) => void} [options.showError] - Called with
 *   a one-line failure message when an edit / remove / add fails.
 *   Typically wired to the minibuffer.
 * @returns {{element: HTMLElement, setBuffer, focus, destroy,
 *   pauseAndRelease, resumeFrom}}
 */
function createAudioView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const closeBuffer =
    typeof options.closeBuffer === 'function' ? options.closeBuffer : null;
  const onSetMetadata =
    typeof options.onSetMetadata === 'function' ? options.onSetMetadata : null;
  const onRemoveMetadata =
    typeof options.onRemoveMetadata === 'function' ? options.onRemoveMetadata : null;
  const showError =
    typeof options.showError === 'function' ? options.showError : null;

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

  // Plus-pill — collapsed by default. Clicking the bare pill expands
  // it into a two-input form (key + value) the user fills to add a new
  // tag. Confirm calls `onSetMetadata` with the new pair; cancel or
  // Esc collapses back to the pill.
  const plusPill = doc.createElement('div');
  plusPill.className = 'audio-meta-plus';
  const plusButton = doc.createElement('button');
  plusButton.type = 'button';
  plusButton.className = 'audio-meta-plus-button';
  plusButton.title = 'Add a tag';
  plusButton.textContent = '+';
  const plusForm = doc.createElement('div');
  plusForm.className = 'audio-meta-plus-form';
  plusForm.hidden = true;
  const plusKey = doc.createElement('input');
  plusKey.type = 'text';
  plusKey.className = 'audio-meta-plus-key';
  plusKey.placeholder = 'key (e.g. composer)';
  const plusValue = doc.createElement('input');
  plusValue.type = 'text';
  plusValue.className = 'audio-meta-plus-value';
  plusValue.placeholder = 'value';
  const plusConfirm = doc.createElement('button');
  plusConfirm.type = 'button';
  plusConfirm.className = 'audio-meta-plus-confirm';
  plusConfirm.textContent = 'Add';
  const plusCancel = doc.createElement('button');
  plusCancel.type = 'button';
  plusCancel.className = 'audio-meta-plus-cancel';
  plusCancel.title = 'Cancel';
  plusCancel.textContent = '×';
  plusForm.append(plusKey, plusValue, plusConfirm, plusCancel);
  plusPill.append(plusButton, plusForm);
  right.append(plusPill);

  const audioEl = doc.createElement('audio');
  audioEl.className = 'audio-player';
  audioEl.controls = true;
  audioEl.preload = 'metadata';
  right.append(audioEl);

  // Error block shown when the <audio> element fires `error` — usually
  // an unsupported codec inside an otherwise-recognised container.
  // Sits between the metadata block and the player.
  const errorBlock = buildErrorBlock(doc);
  right.insertBefore(errorBlock.root, audioEl);

  /** The audio buffer currently shown, or `null`. */
  let buffer = null;

  /** Hide the player and show the error block. */
  function showDecodeError() {
    const advice = mediaErrorAdvice(audioEl.error, buffer ? buffer.name : '');
    if (!advice) return;
    audioEl.style.display = 'none';
    errorBlock.show(advice);
  }

  /** Reset error state — called on every new buffer mount. */
  function clearError() {
    audioEl.style.display = '';
    errorBlock.hide();
  }

  audioEl.addEventListener('error', showDecodeError);

  /** Append one row to the metadata list. Empty values are skipped — a
   *  missing field shouldn't waste a row. Editable rows carry a
   *  `data-key` attribute, a hint cursor on the value, a minus button,
   *  and a `data-editable="true"` marker; derived rows render muted
   *  with no affordances. */
  function appendRow(term, value, { key = null, editable = false } = {}) {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text === '') return;
    const dt = doc.createElement('dt');
    dt.textContent = term;
    if (key) dt.dataset.key = key;
    if (!editable) dt.classList.add('audio-meta-derived');
    const dd = doc.createElement('dd');
    if (key) dd.dataset.key = key;
    if (editable) {
      dd.dataset.editable = 'true';
      const valueEl = doc.createElement('span');
      valueEl.className = 'audio-meta-value';
      valueEl.textContent = text;
      const minus = doc.createElement('button');
      minus.type = 'button';
      minus.className = 'audio-meta-minus';
      minus.title = `Remove ${term}`;
      minus.textContent = '−'; // U+2212 minus sign, narrower than hyphen
      minus.dataset.key = key;
      dd.append(valueEl, minus);
    } else {
      dd.textContent = text;
      dd.classList.add('audio-meta-derived');
    }
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
      for (const key of STANDARD_EDITABLE_KEYS) {
        appendRow(KEY_LABELS[key], meta[key], { key, editable: true });
      }
      // Non-standard editable keys (composer, comment, …) render below
      // the standard ones, in insertion order. The plus-pill writes
      // them, and the same minus button removes them.
      for (const [key, value] of Object.entries(meta)) {
        if (key === 'title' || key === 'duration') continue;
        if (STANDARD_EDITABLE_KEYS.includes(key)) continue;
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        appendRow(label, value, { key, editable: true });
      }
      if (typeof meta.duration === 'number') {
        appendRow('Duration', formatDuration(meta.duration));
      }
    }
    appendRow('File', buffer.name);
    const mime = mimeTypeForAudio(buffer.name);
    if (mime) appendRow('Format', mime);
    if (buffer.filePath) appendRow('Path', buffer.filePath);

    if (typeof buffer.albumArtSrc === 'string' && buffer.albumArtSrc !== '') {
      artImg.src = buffer.albumArtSrc;
      artImg.style.display = '';
      artPlaceholder.style.display = 'none';
    } else {
      artImg.removeAttribute('src');
      artImg.style.display = 'none';
      artPlaceholder.style.display = '';
    }

    // The plus-pill always renders below the metadata list. Reset its
    // form state so a switch-buffer doesn't carry a half-typed entry
    // from the previous file.
    collapsePlusPill();
  }

  // -- Inline edit lifecycle --------------------------------------
  //
  // One row at a time: starting a new edit while another is in flight
  // is a no-op (the in-flight one is committed first by the click's
  // own blur event). Each edit has three exits — commit on Enter or
  // blur, revert on Escape — all of which repaint from `buffer.metadata`
  // so the row's DOM structure is reliably rebuilt without our needing
  // to surgically swap the <input> for the original <span> + minus.

  /** The row currently mid-edit, or `null` when nothing is. */
  let editingRow = null;

  /** Replace `dd`'s content with an `<input>` pre-populated with the
   *  current value; wire commit (Enter/blur) and revert (Escape) to
   *  the host primitive via onSetMetadata. */
  function startEditingValue(dd, key) {
    if (editingRow || !buffer) return;
    const valueEl = dd.querySelector('.audio-meta-value') || dd;
    const originalText = (valueEl.textContent || '').trim();
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'audio-meta-input';
    input.value = originalText;
    const row = { settled: false };
    editingRow = row;
    dd.replaceChildren(input);
    input.focus();
    input.select();

    const commit = () => {
      if (row.settled) return;
      row.settled = true;
      const newValue = input.value.trim();
      if (editingRow === row) editingRow = null;
      if (newValue === originalText) {
        paint();
        return;
      }
      applySetResult(key, newValue, originalText);
    };
    const revert = () => {
      if (row.settled) return;
      row.settled = true;
      if (editingRow === row) editingRow = null;
      paint();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        revert();
      }
    });
    input.addEventListener('blur', () => commit());
  }

  /** Same lifecycle as `startEditingValue`, but the target is the
   *  headline (`<h1>`) — a single element, no minus button, no row
   *  structure to rebuild. The result still routes through paint(). */
  function startEditingTitle() {
    if (editingRow || !buffer) return;
    const originalText = (titleEl.textContent || '').trim();
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'audio-meta-input audio-title-input';
    input.value = originalText;
    const row = { settled: false };
    editingRow = row;
    titleEl.replaceChildren(input);
    input.focus();
    input.select();

    const commit = () => {
      if (row.settled) return;
      row.settled = true;
      const newValue = input.value.trim();
      if (editingRow === row) editingRow = null;
      if (newValue === originalText || newValue === '') {
        paint();
        return;
      }
      applySetResult('title', newValue, originalText);
    };
    const revert = () => {
      if (row.settled) return;
      row.settled = true;
      if (editingRow === row) editingRow = null;
      paint();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        revert();
      }
    });
    input.addEventListener('blur', () => commit());
  }

  /** Apply a `set-audio-metadata!` call. On success the buffer's
   *  metadata is updated in place and the view repaints; on failure
   *  the buffer is untouched, the minibuffer gets the error, and the
   *  repaint restores the row to `originalText`. */
  function applySetResult(key, newValue, originalText) {
    if (!onSetMetadata || !buffer) {
      paint();
      return;
    }
    let result;
    try {
      result = onSetMetadata({ key, value: newValue, buffer });
    } catch (error) {
      result = { ok: false, error };
    }
    if (result && result.ok) {
      buffer.metadata = result.metadata
        ? result.metadata
        : { ...(buffer.metadata ?? {}), [key]: newValue };
      paint();
    } else {
      if (showError) showError(formatEditError(result && result.error));
      // The repaint reads from buffer.metadata (still the original
      // value), so the row reverts naturally.
      paint();
      // originalText kept as a closure reference so we could surface
      // it if a future failure-mode wanted to highlight what was lost;
      // currently no such mode exists.
      void originalText;
    }
  }

  /** Apply a `remove-audio-metadata!` call. Same shape as
   *  applySetResult but never carries a value. */
  function applyRemoveResult(key) {
    if (!onRemoveMetadata || !buffer) {
      paint();
      return;
    }
    let result;
    try {
      result = onRemoveMetadata({ key, buffer });
    } catch (error) {
      result = { ok: false, error };
    }
    if (result && result.ok) {
      if (result.metadata) {
        buffer.metadata = result.metadata;
      } else if (buffer.metadata) {
        const next = { ...buffer.metadata };
        delete next[key];
        buffer.metadata = next;
      }
      paint();
    } else {
      if (showError) showError(formatEditError(result && result.error));
      paint();
    }
  }

  // Event delegation on the metadata list — rows are recreated on every
  // paint, so wiring per-element listeners would be brittle. The
  // delegation matches by data-key + class.
  metaList.addEventListener('dblclick', (event) => {
    const valueEl = event.target.closest('.audio-meta-value');
    if (!valueEl) return;
    const dd = valueEl.parentElement;
    const key = dd?.dataset.key;
    if (!key) return;
    startEditingValue(dd, key);
  });
  metaList.addEventListener('click', (event) => {
    const minus = event.target.closest('.audio-meta-minus');
    if (!minus) return;
    const key = minus.dataset.key;
    if (!key) return;
    applyRemoveResult(key);
  });
  titleEl.addEventListener('dblclick', () => startEditingTitle());

  // -- Plus pill --------------------------------------------------

  function expandPlusPill() {
    plusButton.hidden = true;
    plusForm.hidden = false;
    plusKey.focus();
  }

  function collapsePlusPill() {
    plusButton.hidden = false;
    plusForm.hidden = true;
    plusKey.value = '';
    plusValue.value = '';
  }

  function submitPlusPill() {
    const key = plusKey.value.trim().toLowerCase();
    const value = plusValue.value.trim();
    if (!key || !value) return;
    if (!onSetMetadata || !buffer) {
      collapsePlusPill();
      return;
    }
    let result;
    try {
      result = onSetMetadata({ key, value, buffer });
    } catch (error) {
      result = { ok: false, error };
    }
    if (result && result.ok) {
      buffer.metadata = result.metadata
        ? result.metadata
        : { ...(buffer.metadata ?? {}), [key]: value };
      collapsePlusPill();
      paint();
    } else {
      if (showError) showError(formatEditError(result && result.error));
      // Leave the pill expanded with the typed text — the user can fix
      // and retry without re-typing.
    }
  }

  plusButton.addEventListener('click', () => expandPlusPill());
  plusConfirm.addEventListener('click', () => submitPlusPill());
  plusCancel.addEventListener('click', () => collapsePlusPill());
  for (const el of [plusKey, plusValue]) {
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitPlusPill();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        collapsePlusPill();
      }
    });
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
    clearError();
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

  /** Pause the `<audio>` element and drop its `src` so the OS file
   *  handle is released. Returns the play-state snapshot the caller
   *  passes back to `resumeFrom` once the file has been rewritten —
   *  this is what lets the host's metadata-write path do an atomic
   *  temp-file + rename on Windows, where the rename otherwise fails
   *  with EBUSY against an open handle.
   *
   *  @returns {{ wasPlaying: boolean, currentTime: number }}
   */
  function pauseAndRelease() {
    const snapshot = {
      wasPlaying: !audioEl.paused && !audioEl.ended,
      currentTime: audioEl.currentTime || 0,
    };
    try {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
    } catch {
      /* ignore */
    }
    return snapshot;
  }

  /** Restore the `<audio>` element's `src` (from the current buffer)
   *  and seek to `time`. If `wasPlaying` is true, resumes playback.
   *  Pairs with `pauseAndRelease` — the host calls one before a
   *  metadata write and the other after. */
  function resumeFrom({ wasPlaying = false, currentTime = 0 } = {}) {
    if (!buffer || typeof buffer.src !== 'string') return;
    try {
      audioEl.src = buffer.src;
      // Seek once the metadata loads so the playhead lands precisely.
      const onLoaded = () => {
        try {
          audioEl.currentTime = Math.max(0, currentTime);
        } catch {
          /* ignore */
        }
        if (wasPlaying) audioEl.play().catch(() => {});
        audioEl.removeEventListener('loadedmetadata', onLoaded);
      };
      audioEl.addEventListener('loadedmetadata', onLoaded);
      audioEl.load();
    } catch {
      /* ignore */
    }
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
    destroy,
    pauseAndRelease,
    resumeFrom,
  };
}

// -----------------------------------------------------------------------
// `<audio-view>` — the custom-element wrapper around the factory above.
//
// Phase 3b of `plans/VIEWS-AS-CUSTOM-ELEMENTS.md`. The wrapper is the
// `TextView` pattern: rather than rewrite the 715-line factory into a
// class (it's mostly closures for the metadata-editing UI, which earn
// no clarity from being moved into instance methods), the class
// provides the custom-element shell — single-parent enforcement, the
// lifecycle hooks, the warehouse-friendly identity — and forwards the
// API the host already uses to the factory's return.
//
// The factory still does the heavy lifting; the element is what the
// outside world holds onto and what the DOM single-parent invariant
// applies to. `setBuffer` / `focus` / `destroy` / `pauseAndRelease` /
// `resumeFrom` are the surface the host (`apps/desktop/src/app.js`)
// touches; they pass through to the inner instance once it's been
// mounted via `connectedCallback`.

import { defineViewElement, ViewElement } from './view-elements.js';

/**
 * @typedef {object} AudioViewOptions
 * Same options bag the factory accepts — see `createAudioView`'s JSDoc.
 * Documented separately on `configure()` because the wrapper enforces
 * "configure before mount" rather than passing options on construction.
 */

export class AudioView extends ViewElement {
  constructor() {
    super();
    /** @type {ReturnType<typeof createAudioView> | null} */
    this._inner = null;
    /** @type {AudioViewOptions | null} */
    this._options = null;
    /** A buffer set before `connectedCallback` fired — applied on mount. */
    this._pendingBuffer = null;
  }

  /**
   * Supply the construction-time options the inner view needs (key
   * dispatcher, metadata edit/remove handlers, …). Must be called
   * before the first `connectedCallback` mounts the inner view.
   *
   * @param {AudioViewOptions} options
   */
  configure(options) {
    if (this._inner !== null) {
      throw new Error(
        'AudioView.configure: cannot reconfigure after the inner view is ' +
        'mounted; destroy() and replace if the host wants new options'
      );
    }
    this._options = options ?? null;
  }

  /** @returns {string} */
  get kind() { return 'audio'; }

  /**
   * Bind to an audio buffer (or null to clear). Safe to call before
   * connection — the pending value applies on first mount.
   *
   * @param {object | null} buffer
   */
  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    if (this._inner !== null) this._inner.setBuffer(buffer);
  }

  /** Focus the inner view's keyboard target. */
  focus() {
    if (this._inner !== null) this._inner.focus();
    else super.focus();
  }

  /**
   * Pause playback and release the underlying media source so it can be
   * GC'd. Returns a snapshot the host can hand back to `resumeFrom` to
   * restore playback at the same position.
   *
   * @returns {*}
   */
  pauseAndRelease() {
    return this._inner === null ? null : this._inner.pauseAndRelease();
  }

  /**
   * Restore playback from a snapshot previously returned by
   * `pauseAndRelease`.
   *
   * @param {*} snapshot
   */
  resumeFrom(snapshot) {
    if (this._inner !== null) this._inner.resumeFrom(snapshot);
  }

  // --- Custom-element lifecycle -----------------------------------------

  connectedCallback() {
    if (this._inner !== null) return;
    this._inner = createAudioView(this, this._options ?? {});
    if (this._pendingBuffer !== null) {
      this._inner.setBuffer(this._pendingBuffer);
    }
  }

  disconnectedCallback() {
    /* intentionally empty — moves and destroys are indistinguishable here */
  }

  /** Explicit teardown. Releases the inner view (which pauses the audio
   *  element, unsubscribes from buffer events, and detaches its DOM). */
  destroy() {
    if (this._inner !== null) {
      this._inner.destroy();
      this._inner = null;
    }
    this._pendingBuffer = null;
  }
}

defineViewElement('audio-view', AudioView);
