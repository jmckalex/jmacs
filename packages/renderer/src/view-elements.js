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
 * Idempotent wrapper around `customElements.define`. The native call
 * throws if the tag name is already registered — fine in production,
 * fatal under hot-reload / repeated module evaluation in tests.
 *
 * Returns the class actually associated with TAGNAME (the existing one
 * if already registered, otherwise KLASS).
 *
 * @template {typeof HTMLElement} K
 * @param {string} tagName
 * @param {K} klass
 * @returns {K | CustomElementConstructor}
 */
export function defineViewElement(tagName, klass) {
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
