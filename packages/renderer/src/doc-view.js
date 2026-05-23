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
 * @param {(name: string) => void} [options.openDoc] - Called when the
 *   user clicks a `[data-jmacs-doc]` cross-link. The argument is the
 *   value of the attribute (the function name).
 * @returns {{element: HTMLElement, setBuffer: (buffer: object | null)
 *   => void, focus: () => void}}
 */
export function createDocView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const openDoc =
    typeof options.openDoc === 'function' ? options.openDoc : null;

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
    if (onKey && onKey(keyEventToString(event))) event.preventDefault();
  });

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
    root.scrollTop = 0;
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
  };
}
