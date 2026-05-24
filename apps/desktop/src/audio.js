/**
 * @file Audio playback — a thin wrapper around a single shared
 * HTMLAudioElement, exposed to Lisp through `app.js`. The jukebox-mode
 * standard library drives playback through these primitives.
 *
 * Only one track plays at a time. Asking to play a different path stops
 * whatever was playing and starts the new path; asking to play the same
 * path resumes (if paused) or starts from the beginning.
 *
 * v1 keeps the contract tiny: play, pause, stop, query time/duration,
 * and a single `onEnded` callback the jukebox uses to auto-advance.
 */

/**
 * Create an audio controller. The renderer calls this once; the returned
 * object's methods become Lisp primitives.
 *
 * @returns {{
 *   play(path: string): void,
 *   pause(): void,
 *   stop(): void,
 *   currentTime(): number,
 *   duration(): number,
 *   currentPath(): string | null,
 *   isPlaying(): boolean,
 *   onEnded(callback: () => void): void,
 * }}
 */
export function createAudioController() {
  /** @type {HTMLAudioElement | null} */
  let element = null;
  /** @type {string | null} */
  let currentPath = null;
  /** @type {(() => void) | null} */
  let endedCallback = null;

  /** Lazily construct the audio element on first use. */
  function ensureElement() {
    if (element) return element;
    element = new Audio();
    element.preload = 'metadata';
    element.addEventListener('ended', () => {
      if (endedCallback) endedCallback();
    });
    return element;
  }

  /** Adopt an external `<audio>` element as the playback element. Used
   *  by the jukebox view so the visible `<audio controls>` widget and
   *  the shared controller agree on what's playing. The previous
   *  element (if any) is detached and stopped. */
  function attachElement(externalElement) {
    if (element === externalElement) return;
    if (element) {
      try {
        element.pause();
        element.removeAttribute('src');
      } catch {
        /* ignore */
      }
    }
    element = externalElement;
    if (!element) {
      currentPath = null;
      return;
    }
    element.preload = element.preload || 'metadata';
    element.addEventListener('ended', () => {
      if (endedCallback) endedCallback();
    });
    // Whatever src might be on the adopted element, treat it as unknown.
    currentPath = null;
  }

  /**
   * A filesystem path → a renderable `media://` URL. The renderer page
   * is at `app://editor/...`, a privileged origin Chromium will not
   * fetch `file://` from cross-origin; the `media://` scheme registered
   * in `serve.js` streams arbitrary local files through the main
   * process (with Range support, so the `<audio>` element can seek).
   * Spaces and unicode in audio filenames need per-segment encoding.
   */
  function pathToUrl(path) {
    if (/^(media|file|https?|blob|data):/.test(path)) return path;
    return 'media://localhost' + path.split('/').map(encodeURIComponent).join('/');
  }

  return {
    play(path) {
      const el = ensureElement();
      if (path !== currentPath) {
        el.src = pathToUrl(path);
        currentPath = path;
      }
      // play() returns a promise that rejects on autoplay block, on a
      // file:// URL the renderer can't load, on an unsupported codec —
      // silent failures are the worst way to debug a jukebox, so surface
      // the reason on the renderer console. The Lisp call still returns;
      // the panel just shows no progress.
      el.play().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`audio.play(${path}) failed:`, err?.message ?? err);
      });
    },
    pause() {
      if (element) element.pause();
    },
    stop() {
      if (!element) return;
      element.pause();
      element.currentTime = 0;
      // Drop the src so the next play() of the same path starts fresh.
      element.removeAttribute('src');
      element.load();
      currentPath = null;
    },
    currentTime() {
      return element ? element.currentTime || 0 : 0;
    },
    duration() {
      if (!element) return 0;
      const d = element.duration;
      return Number.isFinite(d) ? d : 0;
    },
    currentPath() {
      return currentPath;
    },
    isPlaying() {
      return element !== null && !element.paused && !element.ended;
    },
    onEnded(callback) {
      endedCallback = callback;
    },
    attachElement,
  };
}
