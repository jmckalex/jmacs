/**
 * @file element-view.js — the generic "host an arbitrary custom element
 * as a view" kind.
 *
 * Unlike the other view kinds, `<element-view>` has no behaviour of its
 * own: it lazily loads a bundle module, creates the custom element that
 * module defines, and hosts it. The differentiation (which module, which
 * tag, which attributes) lives entirely in the view's `extras`, set by
 * the `open-element-view!` host primitive from a Lisp spec. So a single
 * `element` kind, wired into the desktop app once, backs every web
 * component a user registers with `define-element-view` — no new JS kind
 * per component.
 *
 * The embedded element keeps its own DOM (often a shadow root) and its
 * own lifecycle. We only:
 *   1. lazily `import()` its module (which runs `customElements.define`);
 *   2. create + attribute + append the element;
 *   3. optionally grab the keyboard so the element's keys don't leak up
 *      to the editor's window-level key router;
 *   4. on `destroy()`, remove the element — firing *its* own
 *      `disconnectedCallback`, which is where a well-behaved component
 *      tears itself down.
 *
 * See `plans/ELEMENT-VIEWS.md`.
 */

import { ViewElement, defineViewElement } from './view-elements.js';

/**
 * @typedef {object} ElementViewOptions
 * @property {(callback: *, args: *[]) => void} [deliver] - Invoke a Lisp
 *   callback (the spec's `:on-ready`) with JS arguments. Supplied by the
 *   host so the element stays free of any interpreter dependency.
 * @property {(form: *) => void} [onKey] - The host key dispatcher
 *   (unused while `keyboard` is `'grab'`; reserved for non-grabbing
 *   embeds).
 */

export class ElementView extends ViewElement {
  constructor() {
    super();
    /** @type {ElementViewOptions | null} */
    this._options = null;
    /** The view record; its `extras` carries the spec. */
    this._view = null;
    /** The embedded custom element, once created. @type {HTMLElement|null} */
    this._inner = null;
    /** Bubble-phase key handler installed for `keyboard: 'grab'/'share'`. */
    this._keyHandler = null;
    this._booting = false;
    this._destroyed = false;
  }

  /**
   * Supply host services. Must be called before the first
   * `connectedCallback`; reconfiguring after the element is mounted
   * throws (matches the other view kinds).
   *
   * @param {ElementViewOptions} options
   */
  configure(options) {
    if (this._inner !== null) {
      throw new Error(
        'ElementView.configure: cannot reconfigure after the inner ' +
        'element is mounted; destroy() and replace instead'
      );
    }
    this._options = options ?? null;
  }

  /**
   * Bind the view whose `extras` describes the element to host. The spec
   * is immutable, so this only records the view; the element is built on
   * connection. Safe to call before connection.
   *
   * @param {object | null} view
   */
  setBuffer(view) {
    this._view = view;
  }

  /** The bound view, or null. */
  get buffer() {
    return this._view;
  }

  /** Every element-view is kind 'element'. */
  get kind() { return 'element'; }

  // --- Custom-element lifecycle ---------------------------------------

  connectedCallback() {
    if (this._inner !== null || this._booting) return;
    this._booting = true;
    this._boot().finally(() => { this._booting = false; });
  }

  /** Empty by convention — a move and a destroy look the same here.
   *  Real teardown is `destroy()`. */
  disconnectedCallback() {
    /* intentionally empty */
  }

  /**
   * Explicit teardown: drop the key grab and remove the embedded
   * element, which fires *its* `disconnectedCallback` (where a good
   * component releases its own resources — audio, workers, WASM).
   */
  destroy() {
    this._destroyed = true;
    if (this._keyHandler !== null) {
      this.removeEventListener('keydown', this._keyHandler);
      this.removeEventListener('keyup', this._keyHandler);
      this._keyHandler = null;
    }
    if (this._inner !== null) {
      try { this._inner.remove(); } catch { /* already detached */ }
      this._inner = null;
    }
    this._view = null;
  }

  /** Forward focus to the embedded element when it's focusable; many
   *  components (e.g. an emulator screen) manage their own focus on
   *  click, in which case this is a harmless no-op. */
  focus() {
    if (this._inner !== null && typeof this._inner.focus === 'function') {
      try { this._inner.focus(); } catch { /* not focusable */ }
    }
  }

  // --- internal ------------------------------------------------------

  /** Build the embedded element: import its module, instantiate the tag,
   *  apply attributes, grab the keyboard, run the ready callback. */
  async _boot() {
    if (this._inner !== null) return;
    this.classList.add('element-view');
    const extras = (this._view && this._view.extras) || {};
    const tag = extras.tag;
    if (typeof tag !== 'string' || tag === '') {
      this._fail('element-view: spec has no element tag');
      return;
    }
    const moduleUrl = extras.moduleUrl;
    if (typeof moduleUrl === 'string' && moduleUrl !== '') {
      try {
        await import(/* @vite-ignore */ moduleUrl);
        if (typeof customElements !== 'undefined' &&
            typeof customElements.whenDefined === 'function') {
          await customElements.whenDefined(tag);
        }
      } catch (error) {
        this._fail(
          `element-view: could not load ${moduleUrl} — ` +
          `${error && error.message ? error.message : error}`
        );
        return;
      }
    }
    // The view may have been killed while the import was in flight.
    if (this._destroyed || !this.isConnected) return;

    const inner = this.ownerDocument.createElement(tag);
    const attrs = Array.isArray(extras.attrs) ? extras.attrs : [];
    for (const [name, value] of attrs) {
      if (value === true) inner.setAttribute(name, '');
      else if (value !== false && value != null) {
        inner.setAttribute(name, String(value));
      }
    }
    this._inner = inner;
    this.append(inner);
    this._installKeyGrab(extras.keyboard ?? 'grab');

    const onReady = extras.onReady;
    if (onReady && this._options && typeof this._options.deliver === 'function') {
      this._options.deliver(onReady, [inner]);
    }
  }

  /**
   * Install a bubble-phase key swallow so the embedded element owns the
   * keyboard while it has focus. The element's own handler runs first
   * (it's deeper in the tree); we then `stopPropagation` before the event
   * reaches the editor's window-level bubble router. `'share'` lets
   * modified chords (`C-`/`M-`/`A-`) through so editor commands still
   * work; `'off'`/anything else installs nothing.
   *
   * @param {string} mode
   */
  _installKeyGrab(mode) {
    if (mode !== 'grab' && mode !== 'share') return;
    const handler = (event) => {
      if (mode === 'share' &&
          (event.ctrlKey || event.metaKey || event.altKey)) {
        return; // let editor chords pass through to the router
      }
      event.stopPropagation();
    };
    this._keyHandler = handler;
    this.addEventListener('keydown', handler);
    this.addEventListener('keyup', handler);
  }

  /** Show a load/spec error in place rather than a blank pane. */
  _fail(message) {
    const box = this.ownerDocument.createElement('div');
    box.className = 'element-view-error';
    box.textContent = message;
    this.append(box);
  }
}

defineViewElement('element-view', ElementView);
