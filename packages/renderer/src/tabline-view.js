/**
 * @file `<tabline-view>` — a custom element that contains N child view
 * elements (its tabs) and renders a strip showing them.
 *
 * Phase 2 of `plans/VIEWS-AS-CUSTOM-ELEMENTS.md`. The class replaces
 * the per-pane tabline-view object + `tablineStateByView` map +
 * `mountTablineActiveChild` machinery with a single self-contained
 * custom element:
 *
 *   - The element contains two structural children: a `.tabline-strip`
 *     (where the tab strip renders) and a `.tabline-content` (where
 *     the tabs themselves live).
 *   - Tabs are children of `.tabline-content`. They are real custom
 *     element instances (`<text-view>`, `<image-view>`, …). The
 *     active tab carries the `[active]` attribute; CSS hides the
 *     others. The all-attached-attribute-toggled model is Phase 0
 *     Decision 4.
 *   - The `data-edge` attribute (`top` / `right` / `bottom` / `left`)
 *     controls flex direction via CSS.
 *
 * Q9 enforcement is structural: a view element is in at most one
 * tabline's `.tabline-content` at any time (DOM single-parent
 * invariant). Moving a view between tablines is a single
 * `tablineB.addTab(view)` call — the platform automatically removes
 * it from `tablineA.content`.
 *
 * Tab-close is dispatched as a bubbling `tab-close` CustomEvent on
 * the tabline-view, carrying `{ view, index }` in `detail`. The host
 * decides what to do — typically `view.destroy()` then a kill-view
 * step that removes the element. This keeps the policy out of the
 * tabline (whether close means "kill" or "warehouse" is a host
 * decision).
 */

import { defineViewElement, strAttr } from './view-elements.js';
import { createTabline } from './tabline.js';

export class TablineView extends HTMLElement {
  constructor() {
    super();
    /** @type {HTMLElement | null} */
    this._stripEl = null;
    /** @type {HTMLElement | null} */
    this._contentEl = null;
    /** @type {{element: HTMLElement, refresh: () => void, setEdge: (edge: string) => void} | null} */
    this._stripWidget = null;
    /** Set while a programmatic mutation runs, to suppress the strip's
     *  refresh until the dust settles (single refresh at the end). */
    this._mutating = false;
  }

  /** @returns {string[]} */
  static get observedAttributes() {
    return ['data-edge'];
  }

  attributeChangedCallback(name, _oldValue, newValue) {
    if (name === 'data-edge' && this._stripWidget !== null) {
      this._stripWidget.setEdge(newValue ?? 'top');
    }
  }

  // --- lifecycle ------------------------------------------------------

  connectedCallback() {
    this._ensureMounted();
    this._refreshStrip();
  }

  disconnectedCallback() {
    /* intentionally empty — moves and destroys look the same here */
  }

  /** Explicit teardown. Does *not* destroy the child tabs — they live
   *  independently and may be re-parented (e.g. to the warehouse).
   *  The host decides each tab's fate. */
  destroy() {
    if (this._stripEl !== null) this._stripEl.remove();
    if (this._contentEl !== null) this._contentEl.remove();
    this._stripEl = null;
    this._contentEl = null;
    this._stripWidget = null;
  }

  // --- accessors -----------------------------------------------------

  /** The live tab list — children of `.tabline-content` in document
   *  order. Snapshot at call time; safe to iterate. */
  get tabs() {
    this._ensureMounted();
    return Array.from(this._contentEl.children);
  }

  /** Number of tabs. */
  get tabCount() {
    return this._contentEl === null ? 0 : this._contentEl.children.length;
  }

  /** The currently-active tab element, or null. */
  get activeChild() {
    this._ensureMounted();
    return this._contentEl.querySelector(':scope > [active]');
  }

  /** Index of the active tab in `tabs`, or -1 when no tab is active. */
  get activeIndex() {
    const child = this.activeChild;
    if (child === null) return -1;
    const idx = Array.prototype.indexOf.call(this._contentEl.children, child);
    return idx;
  }

  /** The configured edge ('top' / 'right' / 'bottom' / 'left'). */
  get edge() {
    return strAttr(this, 'data-edge', 'top');
  }

  set edge(value) {
    const v = (value === 'top' || value === 'right' ||
               value === 'bottom' || value === 'left')
      ? value
      : 'top';
    this.setAttribute('data-edge', v);
  }

  // --- mutation API --------------------------------------------------

  /**
   * Append VIEW as a tab. If INDEX is given and in range, insert at
   * that position; otherwise append at the end. If VIEW was already
   * a tab elsewhere (including in another tabline), the DOM's single-
   * parent invariant moves it; no aliasing is possible.
   *
   * The newly-inserted tab does not become active automatically —
   * call `activateTab(index)` to switch.
   *
   * @param {HTMLElement} view
   * @param {number} [index]
   */
  addTab(view, index) {
    this._ensureMounted();
    const tabs = this._contentEl.children;
    const target =
      typeof index === 'number' && index >= 0 && index <= tabs.length
        ? index
        : tabs.length;
    if (target >= tabs.length) {
      this._contentEl.appendChild(view);
    } else {
      this._contentEl.insertBefore(view, tabs[target]);
    }
    this._refreshStrip();
  }

  /**
   * Remove the tab at INDEX. Returns the removed element (now
   * unparented) so the caller can warehouse it, destroy it, or
   * re-attach it elsewhere. Re-anchors `active` onto a surviving
   * sibling when the active tab was removed.
   *
   * @param {number} index
   * @returns {HTMLElement | null}
   */
  removeTab(index) {
    if (this._contentEl === null) return null;
    const tabs = this._contentEl.children;
    if (index < 0 || index >= tabs.length) return null;
    const target = /** @type {HTMLElement} */ (tabs[index]);
    const wasActive = target.hasAttribute('active');
    this._contentEl.removeChild(target);
    if (wasActive) {
      const remaining = this._contentEl.children;
      if (remaining.length > 0) {
        const nextActiveIdx = Math.max(0, index - 1);
        remaining[nextActiveIdx].setAttribute('active', '');
      }
    }
    this._refreshStrip();
    return target;
  }

  /**
   * Move the tab at FROM to position TO inside this tabline. No-op
   * when FROM === TO or either is out of range.
   *
   * @param {number} from
   * @param {number} to
   */
  reorderTab(from, to) {
    if (from === to) return;
    if (this._contentEl === null) return;
    const tabs = this._contentEl.children;
    if (from < 0 || from >= tabs.length) return;
    if (to < 0 || to >= tabs.length) return;
    const moved = /** @type {HTMLElement} */ (tabs[from]);
    // insertBefore-after-remove semantics: removing FROM shifts every
    // later index down by one, so the "reference node" for `to` after
    // the splice differs depending on direction.
    if (to > from) {
      const reference = tabs[to + 1] ?? null;
      this._contentEl.insertBefore(moved, reference);
    } else {
      const reference = tabs[to];
      this._contentEl.insertBefore(moved, reference);
    }
    this._refreshStrip();
  }

  /**
   * Activate the tab at INDEX. Clears `[active]` from any other tab;
   * sets it on the target. No-op when INDEX is out of range.
   *
   * @param {number} index
   */
  activateTab(index) {
    if (this._contentEl === null) return;
    const tabs = this._contentEl.children;
    if (index < 0 || index >= tabs.length) return;
    for (const tab of tabs) tab.removeAttribute('active');
    tabs[index].setAttribute('active', '');
    this._refreshStrip();
    // Re-focus the newly active tab if it can take focus.
    if (typeof tabs[index].focus === 'function') {
      tabs[index].focus();
    }
  }

  // --- internal ------------------------------------------------------

  _ensureMounted() {
    if (this._stripEl !== null) return;
    this._stripEl = document.createElement('div');
    this._stripEl.className = 'tabline-strip';
    this._contentEl = document.createElement('div');
    this._contentEl.className = 'tabline-content';
    this.append(this._stripEl, this._contentEl);
    if (!this.hasAttribute('data-edge')) {
      this.setAttribute('data-edge', 'top');
    }
    this._stripWidget = createTabline(this._stripEl, {
      getTabs: () => this.tabs,
      getActiveIndex: () => Math.max(0, this.activeIndex),
      onSelect: (i) => this.activateTab(i),
      onClose: (i) => this._dispatchTabClose(i),
      onReorder: (from, to) => this.reorderTab(from, to),
      edge: this.getAttribute('data-edge') ?? 'top',
    });
  }

  _refreshStrip() {
    if (this._mutating) return;
    if (this._stripWidget !== null) this._stripWidget.refresh();
  }

  _dispatchTabClose(index) {
    if (this._contentEl === null) return;
    const tabs = this._contentEl.children;
    if (index < 0 || index >= tabs.length) return;
    this.dispatchEvent(new CustomEvent('tab-close', {
      detail: { view: tabs[index], index },
      bubbles: true,
      composed: true,
    }));
  }
}

defineViewElement('tabline-view', TablineView);
