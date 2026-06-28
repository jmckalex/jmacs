/**
 * @file `<browser-view>` — a thin chrome (URL bar, back / forward /
 * reload / stop buttons) wrapping Electron's native `<webview>` tag.
 * Lets the user open a URL inside a Godot pane, navigate normally, and
 * drop the page into a tabline alongside text views.
 *
 * The class follows the same shape every other singleton-kind view
 * does (TextView, ImageView, AudioView, VideoView, PdfView): a no-DOM
 * constructor, an explicit `configure(options)` step the host calls
 * once before mount, a lazy `_ensureMounted` from `connectedCallback`,
 * `setBuffer(view)` to point the webview at a new URL, and an explicit
 * `destroy()` (move and dispose are indistinguishable inside
 * `disconnectedCallback`).
 *
 * Per-view-instance is the architectural shape; each browser tab gets
 * its own `<browser-view>` from the perKindConfigureFactory in app.js
 * so navigation state (history, scroll, URL) survives a tab switch.
 *
 * See `plans/BROWSER-VIEW.md` for the architectural intent.
 */

import { keyEventToString } from './keymap.js';
import { defineViewElement, ViewElement } from './view-elements.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Default URL when the host doesn't supply one. */
const DEFAULT_URL = 'about:blank';

/**
 * Normalise a user-typed URL. If the input has no recognisable scheme,
 * prepend `https://` so `example.com` works without ceremony. Internal
 * Chromium schemes (`about:`, `chrome:`, `view-source:`) pass through
 * unchanged. Pure helper, exported for tests.
 *
 * @param {string} input
 * @returns {string}
 */
export function normaliseUrl(input) {
  const trimmed = String(input ?? '').trim();
  if (trimmed === '') return DEFAULT_URL;
  // A "scheme" here is letters/digits/+-. followed by a colon. This
  // catches https, http, file, about, chrome, view-source, data, etc.
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * @typedef {object} BrowserViewOptions
 * @property {(key: string) => boolean} [onKey] - Key dispatcher. Called
 *   for each keydown on the outer element (i.e. on the toolbar or the
 *   wrapper itself; keys typed *inside* the `<webview>` have their own
 *   focus world and aren't intercepted here). Returns whether the key
 *   was handled (truthy → preventDefault).
 * @property {string} [defaultUrl] - URL to load when the buffer carries
 *   no URL. Defaults to `about:blank`.
 * @property {string} [partition] - The Electron webview partition the
 *   `<webview>` is mounted in. Defaults to `persist:browser-views` so
 *   cookies / localStorage persist across Godot restarts, isolated from
 *   anything else the editor embeds.
 * @property {(view: object) => void} [onTitleChanged] - Called when the
 *   page title updates so the host can refresh its label (modeline /
 *   tabline). Receives the view object the buffer was set with.
 * @property {(view: object, url: string) => void} [onNavigate] - Called when
 *   the page navigates (link / URL bar / in-page route) so the host can track
 *   the live URL upstream (the server's data-source state.url). Receives the
 *   buffer/view and the new URL.
 */

export class BrowserView extends ViewElement {
  constructor() {
    super();
    /** @type {BrowserViewOptions | null} */
    this._options = null;
    /** @type {HTMLElement | null} - The `<webview>` element. */
    this._webview = null;
    /** @type {HTMLDivElement | null} */
    this._toolbar = null;
    /** @type {HTMLButtonElement | null} */
    this._backBtn = null;
    /** @type {HTMLButtonElement | null} */
    this._forwardBtn = null;
    /** @type {HTMLButtonElement | null} */
    this._reloadBtn = null;
    /** @type {HTMLButtonElement | null} */
    this._stopBtn = null;
    /** @type {HTMLInputElement | null} */
    this._urlInput = null;
    /** The browser buffer (a view object) currently shown — `{name, url,
     *  extras}` or null. */
    this._buffer = null;
  }

  /**
   * Supply the host's configuration. Must be called before the first
   * `connectedCallback` mounts the inner DOM. Calling it after mount
   * throws — reconfiguring an already-mounted view isn't supported.
   *
   * @param {BrowserViewOptions} options
   */
  configure(options) {
    if (this._webview !== null) {
      throw new Error(
        'BrowserView.configure: cannot reconfigure after the inner DOM ' +
        'is mounted; destroy() and replace if the host wants new options'
      );
    }
    this._options = options ?? null;
  }

  /**
   * Show a browser buffer. The buffer carries `{name, url, extras}` —
   * `url` is what the webview navigates to. Passing `null` clears the
   * webview's src. Safe to call before connection — the next mount
   * picks up the pending buffer.
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

  /** Every browser-view is kind 'browser'. */
  get kind() { return 'browser'; }

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
    this.classList.add('browser-view');
    this.tabIndex = 0;

    // Toolbar: back / forward / reload / URL input / stop.
    const toolbar = doc.createElement('div');
    toolbar.className = 'browser-toolbar';

    const backBtn = doc.createElement('button');
    backBtn.className = 'browser-back';
    backBtn.title = 'Back';
    backBtn.textContent = '←'; // ←
    backBtn.disabled = true;

    const forwardBtn = doc.createElement('button');
    forwardBtn.className = 'browser-forward';
    forwardBtn.title = 'Forward';
    forwardBtn.textContent = '→'; // →
    forwardBtn.disabled = true;

    const reloadBtn = doc.createElement('button');
    reloadBtn.className = 'browser-reload';
    reloadBtn.title = 'Reload';
    reloadBtn.textContent = '⟳'; // ⟳

    const urlInput = doc.createElement('input');
    urlInput.className = 'browser-url';
    urlInput.type = 'text';
    urlInput.spellcheck = false;

    const stopBtn = doc.createElement('button');
    stopBtn.className = 'browser-stop';
    stopBtn.title = 'Stop';
    stopBtn.textContent = '×'; // ×
    stopBtn.hidden = true;

    toolbar.append(backBtn, forwardBtn, reloadBtn, urlInput, stopBtn);

    // Webview: fills the rest of the pane.
    const webview = /** @type {HTMLElement} */ (
      doc.createElement('webview')
    );
    webview.className = 'browser-content';
    const partition =
      this._options && typeof this._options.partition === 'string'
        ? this._options.partition
        : 'persist:browser-views';
    webview.setAttribute('partition', partition);
    // allowpopups surfaces `target="_blank"` / `window.open()` as window-open
    // requests rather than silently dropping them. The MAIN process intercepts
    // them (web-contents-created → setWindowOpenHandler in main.js): it never
    // opens a bare OS popup — a user-clicked link loads in THIS webview, while a
    // background popup (OAuth silent-renewal, ad windows) is dropped.
    webview.setAttribute('allowpopups', '');

    this._toolbar = toolbar;
    this._backBtn = backBtn;
    this._forwardBtn = forwardBtn;
    this._reloadBtn = reloadBtn;
    this._stopBtn = stopBtn;
    this._urlInput = urlInput;
    this._webview = webview;

    this.append(toolbar, webview);

    this._wireEvents();
  }

  /** Wire all eight events documented in plans/BROWSER-VIEW.md plus
   *  the outer-element chord-key forwarding. */
  _wireEvents() {
    const webview = /** @type {*} */ (this._webview);
    const urlInput = /** @type {HTMLInputElement} */ (this._urlInput);
    const backBtn = /** @type {HTMLButtonElement} */ (this._backBtn);
    const forwardBtn = /** @type {HTMLButtonElement} */ (this._forwardBtn);
    const reloadBtn = /** @type {HTMLButtonElement} */ (this._reloadBtn);
    const stopBtn = /** @type {HTMLButtonElement} */ (this._stopBtn);

    // Button handlers.
    backBtn.addEventListener('click', () => {
      try {
        if (typeof webview.canGoBack === 'function' && webview.canGoBack()) {
          webview.goBack();
        }
      } catch { /* webview not yet ready */ }
    });
    forwardBtn.addEventListener('click', () => {
      try {
        if (
          typeof webview.canGoForward === 'function' && webview.canGoForward()
        ) {
          webview.goForward();
        }
      } catch { /* webview not yet ready */ }
    });
    reloadBtn.addEventListener('click', () => {
      try { webview.reload(); } catch { /* not ready */ }
    });
    stopBtn.addEventListener('click', () => {
      try { webview.stop(); } catch { /* not ready */ }
    });

    // URL input: Enter navigates.
    urlInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const target = normaliseUrl(urlInput.value);
      urlInput.value = target;
      try { webview.loadURL(target); } catch { /* not ready */ }
    });

    // Webview: did-navigate → update URL input + nav buttons, and record
    // the live URL on the buffer so a later repaint (e.g. when the element
    // is moved between panes and the guest is re-created) restores the
    // page the user is actually on, not the URL it was first opened at.
    webview.addEventListener('did-navigate', (event) => {
      const next =
        (event && /** @type {*} */ (event).url) ||
        (typeof webview.getURL === 'function' ? webview.getURL() : '');
      this._recordNavigation(next);
      this._refreshNavButtons();
    });
    // Same handler for in-page navigation (hash changes, history.pushState).
    webview.addEventListener('did-navigate-in-page', () => {
      try {
        const next = typeof webview.getURL === 'function'
          ? webview.getURL()
          : '';
        this._recordNavigation(next);
      } catch { /* ignore */ }
      this._refreshNavButtons();
    });

    // Webview: page-title-updated → update view.name + notify host.
    webview.addEventListener('page-title-updated', (event) => {
      const title =
        event && typeof /** @type {*} */ (event).title === 'string'
          ? /** @type {*} */ (event).title
          : (typeof webview.getTitle === 'function' ? webview.getTitle() : '');
      if (this._buffer && typeof title === 'string' && title !== '') {
        this._buffer.name = title;
      }
      const onTitle = this._options && this._options.onTitleChanged;
      if (typeof onTitle === 'function' && this._buffer) {
        try { onTitle(this._buffer); } catch { /* host's problem */ }
      }
    });

    // Loading state: swap reload ↔ stop.
    webview.addEventListener('did-start-loading', () => {
      reloadBtn.hidden = true;
      stopBtn.hidden = false;
    });
    webview.addEventListener('did-stop-loading', () => {
      reloadBtn.hidden = false;
      stopBtn.hidden = true;
      this._refreshNavButtons();
    });

    // Outer-element keydown: forward chord keys through onKey so Godot's
    // keymap fires while the browser chrome has focus. Two guards keep it
    // from eating ordinary input:
    //  - the URL bar is a native text field, so it keeps ALL its keys
    //    (forwarding plain typing both swallows the keystroke and spams
    //    "no-buffer-here", since a browser view has no buffer to
    //    self-insert into — handle-key throws and dispatchKey consumes);
    //  - elsewhere in the chrome, only genuine chords (Ctrl/Alt/Meta held)
    //    forward; bare keys fall through.
    this.addEventListener('keydown', (event) => {
      if (MODIFIERS.has(event.key)) return;
      if (event.target === urlInput) return;
      if (!event.ctrlKey && !event.altKey && !event.metaKey) return;
      const onKey = this._options && this._options.onKey;
      if (typeof onKey === 'function' && onKey(keyEventToString(event))) {
        event.preventDefault();
      }
    });
  }

  /** Record a navigation to NEXT (a `did-navigate` / `did-navigate-in-page`):
   *  reflect it in the URL bar, stamp it on the buffer so a later repaint
   *  restores THIS page (not the URL first opened), and notify the host so it
   *  can track the URL upstream (the server's data-source state). A blank /
   *  non-string url is ignored. */
  _recordNavigation(next) {
    if (typeof next !== 'string' || next === '') return;
    if (this._urlInput) this._urlInput.value = next;
    if (this._buffer) this._buffer.url = next;
    const onNavigate = this._options && this._options.onNavigate;
    if (typeof onNavigate === 'function' && this._buffer) {
      try { onNavigate(this._buffer, next); } catch { /* host's problem */ }
    }
  }

  /** Read canGoBack / canGoForward off the webview and disable the
   *  corresponding buttons. Wrapped in a try because the methods may
   *  throw before the webview is fully ready. */
  _refreshNavButtons() {
    const webview = /** @type {*} */ (this._webview);
    if (!webview || !this._backBtn || !this._forwardBtn) return;
    try {
      this._backBtn.disabled =
        typeof webview.canGoBack === 'function' ? !webview.canGoBack() : true;
      this._forwardBtn.disabled =
        typeof webview.canGoForward === 'function'
          ? !webview.canGoForward()
          : true;
    } catch {
      this._backBtn.disabled = true;
      this._forwardBtn.disabled = true;
    }
  }

  /** Paint the current buffer onto the webview's src. Called from
   *  `connectedCallback` (initial mount) and `setBuffer` (subsequent
   *  changes). Reads `view.url` first, falling back to `view.extras.url`
   *  for the createView shape, then the configured default. */
  _paint() {
    if (this._webview === null || this._urlInput === null) return;
    // Normalise the buffer's URL the same way the URL bar does, so a
    // schemeless address typed at the `M-x browser-view` prompt (e.g.
    // `google.com`) gets `https://` prepended rather than failing to load.
    // Idempotent on a URL that already has a scheme (about:/http(s)/file:…).
    const url = normaliseUrl(this._urlForBuffer());
    this._urlInput.value = url;
    // Drive navigation through the `src` ATTRIBUTE rather than loadURL.
    // The attribute lives on the element, so when the webview's guest is
    // re-created — which Chromium does whenever the <webview> element is
    // moved in the DOM, e.g. the singleton being re-parented into a pane
    // by switchToViewIndex — the new guest reloads THIS url. A transient
    // loadURL would be lost across that recreation, which is exactly why
    // open-url! used to leave the view stuck at about:blank. Compare with
    // what the webview is actually showing (getURL) so we only navigate
    // when it's stale — no spurious reload on a plain tab/pane switch.
    let showing = '';
    try {
      showing =
        typeof /** @type {*} */ (this._webview).getURL === 'function'
          ? /** @type {*} */ (this._webview).getURL()
          : '';
    } catch {
      showing = '';
    }
    if (showing !== url) {
      this._webview.setAttribute('src', url);
    }
    this._refreshNavButtons();
  }

  /** Resolve the URL for the current buffer. */
  _urlForBuffer() {
    if (!this._buffer) {
      return (this._options && this._options.defaultUrl) || DEFAULT_URL;
    }
    if (typeof this._buffer.url === 'string' && this._buffer.url !== '') {
      return this._buffer.url;
    }
    if (
      this._buffer.extras
      && typeof this._buffer.extras.url === 'string'
      && this._buffer.extras.url !== ''
    ) {
      return this._buffer.extras.url;
    }
    return (this._options && this._options.defaultUrl) || DEFAULT_URL;
  }
}

defineViewElement('browser-view', BrowserView);
