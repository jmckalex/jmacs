/**
 * @file The jukebox view — the view a `jukebox`-kind buffer is shown
 * through. A jukebox buffer carries `{ kind:'jukebox', name, dir,
 * tracks, art }`; the view owns playback state (current index, shuffle
 * flag, the actual `<audio>` element) and the DOM that makes it
 * visible.
 *
 * The old jukebox was a text-buffer mode that re-painted an ASCII
 * "panel" on every command. That fought the editor for SPC/RET and
 * smuggled paint code through buffer text. This view sidesteps both:
 * a real `<img>`, a real `<audio controls>`, an `<ol>` track list.
 *
 * The view receives the shared audio controller (the one `app.js`
 * already created for the Lisp `play-audio!` primitive) so a track
 * playing here ends up in the same `audio` object — `audio-playing?`
 * and friends still answer truthfully when the REPL asks.
 *
 * No filesystem access: the host produces `tracks` and `art` before
 * mounting the buffer. No Lisp knowledge: chord keys are forwarded
 * back through `onKey`.
 */

import { keyEventToString } from './keymap.js';

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
/** Tags whose own keyboard handling must not be hijacked. */
const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

/**
 * Recognised audio filename suffixes. Lower-case, with the leading dot.
 * The host's `open-jukebox-buffer!` primitive uses the same set when it
 * filters a directory listing.
 */
export const AUDIO_SUFFIXES = [
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus',
];

/** Candidate album-art filenames, case-insensitive. */
export const ART_FILENAMES = [
  'cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp',
  'folder.jpg', 'folder.png',
  'album.jpg', 'album.png',
];

/**
 * Whether NAME has one of the recognised audio suffixes.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isAudioFile(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return AUDIO_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * The first member of ENTRIES whose lowercase name is one of the
 * known art filenames, or `null`. The match is case-insensitive; the
 * original casing of the matching entry is returned.
 *
 * @param {string[]} entries
 * @returns {string | null}
 */
export function findArt(entries) {
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    if (ART_FILENAMES.includes(entry.toLowerCase())) return entry;
  }
  return null;
}

/**
 * A Fisher–Yates random permutation of ITEMS. `random` is an optional
 * function returning a value in [0, 1) — defaults to `Math.random` so
 * the function is deterministic to test by injection.
 *
 * @template T
 * @param {T[]} items
 * @param {() => number} [random]
 * @returns {T[]}
 */
export function shufflePermutation(items, random = Math.random) {
  if (!Array.isArray(items) || items.length < 2) {
    return Array.isArray(items) ? items.slice() : [];
  }
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Join DIR and NAME with a single slash. */
export function joinPath(dir, name) {
  const trimmed = typeof dir === 'string' && dir.endsWith('/')
    ? dir.slice(0, -1)
    : String(dir ?? '');
  return `${trimmed}/${name}`;
}

/**
 * Create the jukebox view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Forwarded for
 *   chord keys (so `C-x b`, `M-x`, … still work here).
 * @param {{
 *   play(path: string): void,
 *   pause(): void,
 *   stop(): void,
 *   isPlaying(): boolean,
 *   currentPath(): string | null,
 *   onEnded(cb: () => void): void,
 * }} [options.audio] - The shared audio controller. Without one, the
 *   view falls back to a per-instance `HTMLAudioElement` (mostly for
 *   tests).
 * @param {(path: string) => void} [options.openImage] - Open a file as
 *   an image buffer. Called by the M-RET binding on the art file.
 * @param {(message: string) => void} [options.report] - Print a
 *   message to the user (the REPL note path, usually).
 * @returns {{
 *   element: HTMLElement,
 *   setBuffer(buffer: object | null): void,
 *   focus(): void,
 *   // Test hooks:
 *   trackCount(): number,
 *   currentIndex(): number | null,
 *   isShuffleOn(): boolean,
 * }}
 */
export function createJukeboxView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const openImage =
    typeof options.openImage === 'function' ? options.openImage : null;
  const report = typeof options.report === 'function' ? options.report : null;

  // The shared audio controller, or a fallback that wraps a private
  // <audio>. The shared one is what production uses — the fallback
  // exists so the view also works in isolation.
  const audio = options.audio ?? createPrivateAudioShim(doc);

  const root = doc.createElement('div');
  root.className = 'jukebox-view';
  root.tabIndex = 0;
  container.append(root);

  const layout = doc.createElement('div');
  layout.className = 'jukebox-layout';
  root.append(layout);

  // ----- left column: cover art + audio controls -----
  const left = doc.createElement('div');
  left.className = 'jukebox-left';
  layout.append(left);

  const artStage = doc.createElement('div');
  artStage.className = 'jukebox-art';
  const artImg = doc.createElement('img');
  artImg.className = 'jukebox-art-image';
  artImg.alt = '';
  artStage.append(artImg);

  const artNote = doc.createElement('div');
  artNote.className = 'jukebox-art-note';

  const audioEl = doc.createElement('audio');
  audioEl.className = 'jukebox-audio';
  audioEl.controls = true;
  audioEl.preload = 'metadata';

  // If the audio controller can adopt our <audio> element, do so —
  // that way the visible widget *is* what's playing, and the user can
  // scrub. The shared controller's `attachElement` is optional; the
  // private shim doesn't need it (its own element handles everything).
  if (typeof audio.attachElement === 'function') {
    audio.attachElement(audioEl);
  }

  const nowPlaying = doc.createElement('div');
  nowPlaying.className = 'jukebox-now-playing';

  const toolbar = doc.createElement('div');
  toolbar.className = 'jukebox-toolbar';

  const shuffleBtn = doc.createElement('button');
  shuffleBtn.type = 'button';
  shuffleBtn.className = 'jukebox-button jukebox-shuffle';
  shuffleBtn.textContent = 'Shuffle: off';

  const randomiseBtn = doc.createElement('button');
  randomiseBtn.type = 'button';
  randomiseBtn.className = 'jukebox-button jukebox-randomise';
  randomiseBtn.textContent = 'Randomise order';

  const refreshBtn = doc.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'jukebox-button jukebox-refresh';
  refreshBtn.textContent = 'Refresh';

  const quitBtn = doc.createElement('button');
  quitBtn.type = 'button';
  quitBtn.className = 'jukebox-button jukebox-quit';
  quitBtn.textContent = 'Quit';

  toolbar.append(shuffleBtn, randomiseBtn, refreshBtn, quitBtn);

  left.append(artStage, artNote, nowPlaying, audioEl, toolbar);

  // ----- right column: track list + key cheatsheet -----
  const right = doc.createElement('div');
  right.className = 'jukebox-right';
  layout.append(right);

  const trackHeading = doc.createElement('div');
  trackHeading.className = 'jukebox-track-heading';
  right.append(trackHeading);

  const list = doc.createElement('ol');
  list.className = 'jukebox-tracks';
  right.append(list);

  const help = doc.createElement('div');
  help.className = 'jukebox-help';
  help.textContent =
    'SPC play/pause   RET play row   n next   p prev   ' +
    's shuffle   R randomise   g refresh   q quit   M-RET open art';
  right.append(help);

  // ----- state -----
  let buffer = null;
  /** A mutable copy of `buffer.tracks` so shuffle/randomise can reorder
   *  without mutating the host's record. */
  let tracks = [];
  /** The index of the track presented as "now playing", or `null`. */
  let index = null;
  let shuffleOn = false;
  /** The directory the tracks live in (joined to make a play path). */
  let dir = '';
  /** Album-art filename within `dir`, or `null`. */
  let art = null;

  /** Path to feed the audio controller for the track at INDEX. */
  function pathForIndex(i) {
    if (i === null || i < 0 || i >= tracks.length) return null;
    return joinPath(dir, tracks[i]);
  }

  /** Play the current track. No-op if `index` is null/out of range. */
  function playCurrent() {
    const path = pathForIndex(index);
    if (path === null) return;
    audio.play(path);
    redraw();
  }

  function pause() {
    audio.pause();
    redraw();
  }

  function togglePlay() {
    if (audio.isPlaying()) {
      pause();
      return;
    }
    if (index === null && tracks.length > 0) index = 0;
    playCurrent();
  }

  function step(delta) {
    if (tracks.length === 0) return;
    const base = index ?? 0;
    index = ((base + delta) % tracks.length + tracks.length) % tracks.length;
    playCurrent();
  }

  function playAt(i) {
    if (i < 0 || i >= tracks.length) return;
    index = i;
    playCurrent();
  }

  function toggleShuffle() {
    shuffleOn = !shuffleOn;
    redraw();
  }

  function randomise() {
    if (tracks.length === 0) return;
    const currentTrack = index !== null ? tracks[index] : null;
    tracks = shufflePermutation(tracks);
    if (currentTrack) {
      const next = tracks.indexOf(currentTrack);
      index = next >= 0 ? next : 0;
    } else {
      index = 0;
    }
    if (buffer) buffer.tracks = tracks.slice();
    redraw();
  }

  function refresh() {
    // Re-read happens on the host side; the view asks the buffer for
    // a callback. The host sets `buffer.refresh()` when it creates
    // the buffer.
    if (buffer && typeof buffer.refresh === 'function') {
      buffer.refresh();
    }
  }

  function quit() {
    audio.stop();
    if (buffer && typeof buffer.quit === 'function') buffer.quit();
  }

  function openArt() {
    if (art === null) {
      if (report) report('jukebox: no album-art file in this directory');
      return;
    }
    if (openImage) openImage(joinPath(dir, art));
  }

  // ----- rendering -----

  /** Build the cover-art DOM for the current `art` value. */
  function paintArt() {
    if (art && dir) {
      // The renderer can't load `file://`; the host's `media://`
      // scheme handles ordinary local files. Image files happen to
      // serve too (the scheme doesn't care about the suffix).
      const url = 'media://localhost' +
        joinPath(dir, art).split('/').map(encodeURIComponent).join('/');
      artImg.src = url;
      artImg.style.display = '';
      artNote.textContent = `Album art: ${art}    (M-RET to open)`;
    } else {
      artImg.removeAttribute('src');
      artImg.style.display = 'none';
      artNote.textContent = 'No album art in this directory.';
    }
  }

  /** Build the track-list DOM. */
  function paintTracks() {
    list.replaceChildren();
    trackHeading.textContent = `Tracks (${tracks.length})`;
    tracks.forEach((track, i) => {
      const li = doc.createElement('li');
      li.className = 'jukebox-track';
      if (i === index) li.classList.add('is-current');
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'jukebox-track-button';
      btn.textContent = track;
      btn.addEventListener('click', () => playAt(i));
      li.append(btn);
      list.append(li);
    });
  }

  /** Update the "Now playing" line and the shuffle button label. */
  function paintStatus() {
    const current =
      index !== null && index >= 0 && index < tracks.length
        ? tracks[index]
        : null;
    nowPlaying.textContent = current
      ? `Now playing: ${current}`
      : 'Nothing selected.';
    shuffleBtn.textContent = `Shuffle: ${shuffleOn ? 'on' : 'off'}`;
    shuffleBtn.classList.toggle('is-on', shuffleOn);
  }

  /** A full redraw — used on every state change. */
  function redraw() {
    paintArt();
    paintTracks();
    paintStatus();
  }

  // ----- wiring -----

  shuffleBtn.addEventListener('click', toggleShuffle);
  randomiseBtn.addEventListener('click', randomise);
  refreshBtn.addEventListener('click', refresh);
  quitBtn.addEventListener('click', quit);

  // The shared audio controller fires `ended`; auto-advance. The
  // private shim wires the same callback through `onended`.
  audio.onEnded(() => {
    if (buffer !== null) step(1);
  });

  // The view's keyboard model: chord keys (anything with a modifier)
  // ALWAYS go through `onKey` so the global keymap (`C-x k`, `C-x b`,
  // `C-x C-right`, `M-1`, `M-x`, …) stays reachable even when focus is
  // sitting on one of the view's buttons. Bare jukebox shortcuts (SPC,
  // RET, n, p, …) are only intercepted when focus is on the view root —
  // a focused button gets its normal browser activation instead.
  // Anything we don't claim falls through to the global keymap, so the
  // editor's bare-key bindings stay live in a jukebox buffer too.
  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    const keyStr = keyEventToString(event);

    // Modifier chords go straight to the global keymap. The `M-enter`
    // exception is the view's only Alt binding — opens the album art.
    if (
      event.ctrlKey || event.metaKey ||
      (event.altKey && keyStr !== 'M-enter')
    ) {
      if (onKey && onKey(keyStr)) event.preventDefault();
      return;
    }

    // M-RET → open album art (works regardless of focus target).
    if (keyStr === 'M-enter') {
      event.preventDefault();
      openArt();
      return;
    }

    // Bare keys on form controls: let the browser handle the
    // interaction (Tab navigation, Enter/Space to activate a button).
    // The chord branch above already handled modified keys, so the
    // global keymap still receives `C-x k` etc. from a focused button.
    if (FORM_TAGS.has(event.target.tagName)) return;

    // Bare named keys (Enter, Tab, …) — handle the ones we use, hand
    // the rest to the global keymap.
    switch (event.key) {
      case ' ':
        event.preventDefault();
        togglePlay();
        return;
      case 'Enter':
        // Enter on a focused track row plays that row; otherwise plays
        // the current track. The browser would activate the focused
        // button anyway; we just need to suppress newline injection.
        event.preventDefault();
        if (event.target && event.target.tagName === 'BUTTON') {
          event.target.click();
        } else {
          playCurrent();
        }
        return;
      case 'n':
      case 'N':
        if (event.shiftKey) break; // Shift-N is not "next"
        event.preventDefault();
        step(1);
        return;
      case 'p':
      case 'P':
        if (event.shiftKey) break;
        event.preventDefault();
        step(-1);
        return;
      case 's':
        event.preventDefault();
        toggleShuffle();
        return;
      case 'R':
        event.preventDefault();
        randomise();
        return;
      case 'g':
        event.preventDefault();
        refresh();
        return;
      case 'q':
        event.preventDefault();
        quit();
        return;
      default:
        break;
    }

    // Everything else: the global keymap.
    if (onKey && onKey(keyStr)) event.preventDefault();
  });

  /**
   * Show JUKEBOXBUFFER. Mutating the buffer's `tracks` here would
   * confuse the host's snapshot; the view keeps its own copy.
   *
   * @param {object | null} next
   */
  function setBuffer(next) {
    buffer = next;
    if (!buffer) {
      tracks = [];
      index = null;
      shuffleOn = false;
      dir = '';
      art = null;
      redraw();
      return;
    }
    dir = String(buffer.dir ?? '');
    tracks = Array.isArray(buffer.tracks) ? buffer.tracks.slice() : [];
    art = typeof buffer.art === 'string' ? buffer.art : null;
    index = tracks.length > 0 ? 0 : null;
    shuffleOn = false;
    redraw();
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
    trackCount: () => tracks.length,
    currentIndex: () => index,
    isShuffleOn: () => shuffleOn,
  };
}

/** A thin shim around a private `HTMLAudioElement` for when the view
 *  is used outside the editor — tests, primarily. */
function createPrivateAudioShim(doc) {
  const el = doc.createElement('audio');
  let endedCallback = null;
  el.addEventListener('ended', () => {
    if (endedCallback) endedCallback();
  });
  let currentPath = null;
  return {
    play(path) {
      if (path !== currentPath) {
        el.src = path;
        currentPath = path;
      }
      el.play().catch(() => {});
    },
    pause() { el.pause(); },
    stop() {
      el.pause();
      el.currentTime = 0;
      el.removeAttribute('src');
      currentPath = null;
    },
    isPlaying() { return !el.paused && !el.ended; },
    currentPath() { return currentPath; },
    onEnded(cb) { endedCallback = cb; },
  };
}
