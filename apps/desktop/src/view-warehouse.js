/**
 * @file The view warehouse — a hidden DOM container for view elements
 * that exist but aren't currently shown in any pane.
 *
 * Lifecycle context (see plans/VIEWS-AS-CUSTOM-ELEMENTS.md):
 *
 *   constructed → warehoused → live in pane ←→ warehoused → destroyed
 *
 * Newly-constructed views are placed in the warehouse first, then
 * moved to a pane (the document tree). When a pane is removed but a
 * view should survive, the move-back-to-warehouse happens before the
 * pane teardown. When a view is truly killed, `view.destroy()` runs
 * and the element is `remove()`d.
 *
 * The warehouse element itself is declared in `apps/desktop/index.html`
 * as `<div id="view-warehouse" hidden>`. This module is the small
 * Lisp-and-app.js-facing API for reading and mutating it.
 */

/** Lazily-cached reference to the `#view-warehouse` element. */
let warehouseEl = null;

/**
 * The warehouse element. Throws if the host page hasn't declared
 * `<div id="view-warehouse">` — that's a setup bug, not a runtime
 * condition, so loud failure is right.
 *
 * @returns {HTMLElement}
 */
export function getWarehouse() {
  if (warehouseEl === null) {
    warehouseEl = document.getElementById('view-warehouse');
    if (warehouseEl === null) {
      throw new Error(
        '#view-warehouse is missing from index.html — every view-element ' +
        'expects this container as its first home'
      );
    }
  }
  return warehouseEl;
}

/**
 * Move VIEW into the warehouse. Idempotent: a view already in the
 * warehouse stays where it is. Use this when:
 *   - Constructing a view that's not yet ready to be shown.
 *   - Removing a pane whose view should survive.
 *   - The user closes a tab but the underlying view stays alive.
 *
 * @param {Element} view
 */
export function warehouse(view) {
  const wh = getWarehouse();
  if (view.parentNode !== wh) wh.appendChild(view);
}

/**
 * Whether VIEW is currently in the warehouse (vs. attached to a pane
 * or detached from the document tree entirely).
 *
 * @param {Element} view
 * @returns {boolean}
 */
export function isWarehoused(view) {
  return view.parentNode === getWarehouse();
}

/**
 * The current warehouse contents, in document order. A flat snapshot —
 * the caller is free to iterate, filter, or further mutate the DOM
 * without confusing the iteration.
 *
 * @returns {Element[]}
 */
export function warehouseContents() {
  return Array.from(getWarehouse().children);
}

/**
 * For tests / smoke harnesses: forget the cached warehouse element so
 * the next `getWarehouse()` call performs a fresh lookup. No
 * production caller should need this.
 */
export function resetWarehouseCache() {
  warehouseEl = null;
}
