/**
 * @file Shared infrastructure for the view-as-custom-element model.
 *
 * Each view kind in the editor is its own custom element class:
 * `<text-view>`, `<image-view>`, `<tabline-view>`, etc. This module
 * provides the small helpers they all share — idempotent registration,
 * attribute coercion — and documents the lifecycle conventions every
 * view class is expected to follow.
 *
 * See `plans/VIEWS-AS-CUSTOM-ELEMENTS.md` for the architectural intent
 * and the resolved Phase 0 decisions. The short version:
 *
 *   - Cursor / point / scroll / per-view-mode state lives on instance
 *     fields. Identity that's worth seeing in DevTools (`name`,
 *     `data-file-path`) lives on attributes.
 *
 *   - Each view class implements `destroy()` as the *explicit* teardown
 *     path. The platform's `disconnectedCallback` may be empty —
 *     moving an element fires it too, and there's no way to
 *     distinguish a move from a destroy *inside* the callback.
 *     `destroy()` is called by the editor's kill-view path.
 *
 *   - "Hidden but not unmounted" is a DOM-tree concept. A view stays
 *     in the document (in a pane, in the warehouse, in a tabline's
 *     children); the `[active]` attribute and `display: none` control
 *     what's visible.
 */

/**
 * The base class every view-element extends. In a browser this is the
 * platform `HTMLElement`; under Node (where the renderer's pure-helper
 * unit tests load these modules without a DOM), it's a no-op stub so
 * `class FooView extends ViewElement` can evaluate. The class's DOM-
 * touching methods can't run in Node, but the pure helpers exported
 * alongside the class — `isImageName`, `formatDuration`, etc. — can.
 *
 * The compromise is honest: we don't pretend the class is testable in
 * Node, we just keep the module loadable so its pure helpers are
 * reachable. The smoke arm exercises the class for real, in Electron.
 *
 * @type {typeof HTMLElement}
 */
export const ViewElement = /** @type {*} */ (
  typeof HTMLElement === 'undefined' ? class {} : HTMLElement
);

/**
 * Idempotent wrapper around `customElements.define`. The native call
 * throws if the tag name is already registered — fine in production,
 * fatal under hot-reload / repeated module evaluation in tests.
 *
 * Also defensive against environments that don't have a `customElements`
 * registry at all — the renderer's test suite runs under Node without a
 * DOM and imports view modules to exercise their pure helpers. In that
 * setting the registration is a no-op; the class still exists and the
 * pure helpers work normally.
 *
 * Returns the class actually associated with TAGNAME (the existing one
 * if already registered), or KLASS otherwise.
 *
 * @template {typeof HTMLElement} K
 * @param {string} tagName
 * @param {K} klass
 * @returns {K | CustomElementConstructor}
 */
export function defineViewElement(tagName, klass) {
  if (typeof customElements === 'undefined') return klass;
  const existing = customElements.get(tagName);
  if (existing !== undefined) return existing;
  customElements.define(tagName, klass);
  return klass;
}

/**
 * Read a string-valued attribute on EL with FALLBACK if absent.
 *
 * @param {Element} el
 * @param {string} name
 * @param {string} [fallback='']
 * @returns {string}
 */
export function strAttr(el, name, fallback = '') {
  const value = el.getAttribute(name);
  return value === null ? fallback : value;
}

/**
 * Parse an integer-valued attribute, returning FALLBACK for missing /
 * malformed input. Accepts negative integers; rejects fractions and
 * non-numeric strings.
 *
 * @param {Element} el
 * @param {string} name
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function numAttr(el, name, fallback = 0) {
  const raw = el.getAttribute(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Boolean-attribute semantics: present (any value, including the empty
 * string) means true; absent means false. Mirrors how `hidden`,
 * `disabled` and similar HTML attributes work.
 *
 * @param {Element} el
 * @param {string} name
 * @returns {boolean}
 */
export function boolAttr(el, name) {
  return el.hasAttribute(name);
}

/**
 * Write a boolean attribute: `el.setAttribute(name, '')` when VALUE is
 * truthy; `el.removeAttribute(name)` when falsy. Symmetric with the
 * `boolAttr` reader.
 *
 * @param {Element} el
 * @param {string} name
 * @param {boolean} value
 */
export function setBoolAttr(el, name, value) {
  if (value) el.setAttribute(name, '');
  else el.removeAttribute(name);
}
