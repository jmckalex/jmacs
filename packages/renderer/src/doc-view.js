/**
 * @file The documentation view — the view a `doc`-kind buffer is shown
 * through. The host builds the documentation HTML offline (see
 * `scripts/build-docs.js` and `docs/MANUAL.jmd`); the renderer is
 * sandboxed and just displays the pre-rendered page.
 *
 * Cross-links between doc pages carry a `data-jmacs-doc` attribute on
 * the `<a>`. This view intercepts clicks on those links and calls back
 * through `openDoc(name)` — so navigation between doc pages happens
 * inside the editor without ever following the relative `href` (which
 * is there for browser fallback when a page is opened over `file://`).
 *
 * Modelled on `image-view.js`: a plain DOM component, no Lisp
 * knowledge, no filesystem access.
 */

import { keyEventToString } from './keymap.js';

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * The cross-link target for an event target — the value of the nearest
 * `[data-jmacs-doc]` ancestor's attribute, or `null` if there isn't
 * one. Pulled out so the click-routing logic is unit-testable
 * independently of the DOM event handler that wraps it.
 *
 * @param {Element | null | undefined} target
 * @returns {string | null}
 */
export function docLinkName(target) {
  if (!target || typeof target.closest !== 'function') return null;
  const link = target.closest('[data-jmacs-doc]');
  if (!link || typeof link.getAttribute !== 'function') return null;
  const name = link.getAttribute('data-jmacs-doc');
  return name || null;
}

/**
 * Create the documentation view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Dispatches a key
 *   typed in the view, so `C-x b`/`M-x`/`C-h f` work here too.
 *   Returns whether the key was handled.
 * @param {() => void} [options.closeBuffer] - Called when the user
 *   presses `q` to dismiss the doc page.
 * @param {(name: string) => void} [options.openDoc] - Called when the
 *   user clicks a `[data-jmacs-doc]` cross-link. The argument is the
 *   value of the attribute (the function name).
 * @param {(text: string, language: string) =>
 *   import('./highlight.js').Run[][] | null} [options.highlightCode] -
 *   Returns per-line highlight runs for a code block's body, or null
 *   when the language isn't known. Called once per
 *   `pre code[class*="language-"]` after the page renders.
 * @returns {{element: HTMLElement, setBuffer: (buffer: object | null)
 *   => void, focus: () => void}}
 */
function createDocView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const closeBuffer =
    typeof options.closeBuffer === 'function' ? options.closeBuffer : null;
  const openDoc =
    typeof options.openDoc === 'function' ? options.openDoc : null;
  const highlightCode =
    typeof options.highlightCode === 'function' ? options.highlightCode : null;

  const root = doc.createElement('div');
  root.className = 'doc-view';
  root.tabIndex = 0;
  container.append(root);

  const article = doc.createElement('article');
  article.className = 'doc-page';
  root.append(article);

  let buffer = null;

  // Capture-phase click handler so we win even if the doc HTML
  // installs its own listeners. Middle-click and cmd/ctrl-click are
  // treated the same as a plain click — there's no "open in browser"
  // alternative inside the editor.
  function handleClick(event) {
    const name = docLinkName(event.target);
    if (!name) return;
    event.preventDefault();
    event.stopPropagation();
    if (openDoc) openDoc(name);
  }
  root.addEventListener('click', handleClick, true);
  // Auxclick (middle-click) goes through the same path; without this
  // the browser would follow the href in a new tab.
  root.addEventListener('auxclick', handleClick, true);

  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    // Don't swallow keys typed in a form control inside the docs (no
    // such controls today, but cheap to guard).
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const key = keyEventToString(event);
    // `q` dismisses the doc page. Until the editor grows a per-buffer
    // keymap, the text buffer behind us is still the "current buffer"
    // and `handle-key` would self-insert any printable character into
    // it — so consume every plain printable here instead of dispatching.
    if (key === 'q') {
      event.preventDefault();
      if (closeBuffer) closeBuffer();
      return;
    }
    if (key.length === 1) {
      event.preventDefault();
      return;
    }
    if (onKey && onKey(key)) event.preventDefault();
  });

  /** Replace `code`'s children with the per-line highlight runs from
   *  `highlightCode`. Each line's runs become `<span class="tok-…">`
   *  nodes; newlines are inserted between lines so the existing
   *  `<pre>` line-breaking is preserved. */
  function applyCodeHighlight(code, language) {
    if (!highlightCode) return;
    let perLine;
    try {
      perLine = highlightCode(code.textContent, language);
    } catch {
      return;
    }
    if (!Array.isArray(perLine) || perLine.length === 0) return;
    code.replaceChildren();
    for (let i = 0; i < perLine.length; i += 1) {
      if (i > 0) code.append(doc.createTextNode('\n'));
      const runs = perLine[i];
      if (!Array.isArray(runs)) continue;
      for (const run of runs) {
        if (run.face === null || run.face === undefined) {
          code.append(doc.createTextNode(run.text));
        } else {
          const span = doc.createElement('span');
          span.className = `tok-${run.face}`;
          span.textContent = run.text;
          code.append(span);
        }
      }
    }
  }

  /** Walk every code block with a `language-…` class and re-highlight
   *  it through the renderer's pipeline. Block-language is taken from
   *  the class name (jmarkdown + marked both use the same convention). */
  function highlightAllCodeBlocks() {
    if (!highlightCode) return;
    const codes = article.querySelectorAll('pre code[class*="language-"]');
    for (const code of codes) {
      const match = code.className.match(/language-([\w-]+)/);
      if (!match) continue;
      applyCodeHighlight(code, match[1]);
    }
  }

  /**
   * Show a doc buffer. The buffer carries
   * `{kind:'doc', name, docName, html}` — `html` is the per-function
   * page fragment (or the whole MANUAL.html) the host read from
   * `docs/build/`.
   *
   * @param {object | null} next
   */
  function setBuffer(next) {
    buffer = next;
    if (!buffer || typeof buffer.html !== 'string') {
      article.replaceChildren();
      return;
    }
    article.innerHTML = buffer.html;
    highlightAllCodeBlocks();
    root.scrollTop = 0;
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
  };
}

// -----------------------------------------------------------------------
// `<doc-view>` — Phase 3e custom-element wrapper. Same pattern as
// AudioView / VideoView / CustomizeView.

import { defineViewElement, ViewElement } from './view-elements.js';

/** @typedef {object} DocViewOptions
 *  Same options bag the factory accepts — see `createDocView`. */

export class DocView extends ViewElement {
  constructor() {
    super();
    /** @type {ReturnType<typeof createDocView> | null} */
    this._inner = null;
    /** @type {DocViewOptions | null} */
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('DocView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() { return 'doc'; }

  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    if (this._inner !== null) this._inner.setBuffer(buffer);
  }

  focus() {
    if (this._inner !== null) this._inner.focus();
    else super.focus();
  }

  connectedCallback() {
    if (this._inner !== null) return;
    this._inner = createDocView(this, this._options ?? {});
    if (this._pendingBuffer !== null) this._inner.setBuffer(this._pendingBuffer);
  }

  disconnectedCallback() {
    /* intentionally empty */
  }

  destroy() {
    this._inner = null;
    this._pendingBuffer = null;
  }
}

defineViewElement('doc-view', DocView);
