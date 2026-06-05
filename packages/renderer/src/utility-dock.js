/**
 * @file The **utility dock** — the tabbed chrome region at the bottom of the
 * window that hosts transient tool/command UIs. It occupies the space the REPL
 * used to own; the REPL is now just its resident tab. Tools (the RefTeX
 * pickers, doc/apropos, compile output, …) open additional tabs instead of
 * sliding overlays over the editor or spawning pane-tree views.
 *
 * The dock is **chrome**: it is NOT part of the splittable pane tree and never
 * appears in `views[]`. One panel is visible at a time; the tab strip is hidden
 * while only the REPL exists.
 *
 * A panel is a factory `makePanel(handle) -> panel` returning the shared
 * content-panel contract (the same shape the RefTeX panels already satisfy),
 * extended for tabs:
 *
 *   {
 *     element: HTMLElement,        // mounted into the dock's content area
 *     title: string,              // tab label
 *     icon?: string,              // Font Awesome class for the tab
 *     modal?: boolean,            // capture keys while this tab is active
 *     closable?: boolean,         // render an × on the tab (default true)
 *     handleKey?(key)->boolean, focus?(), refresh?(), destroy?(), reset?(),
 *     onClose?(),
 *   }
 *
 * `handle` (passed to `makePanel`) is bound to the panel's own tab:
 * `{ close(), focus(), activate() }`.
 *
 * **Modality / key routing.** A non-modal tab (the REPL) installs nothing: its
 * native `<input>` receives keys, and the global router already stands down for
 * inputs (`targetOwnsKeys`). A modal tab installs a window **capture-phase**
 * keydown handler while it is the active tab — this beats a focused `<webview>`
 * (PDF/browser) that would otherwise eat keystrokes. A modal panel can still
 * drive the editor underneath via its own callbacks (that is how RefTeX
 * SPC-peek works); modality governs only key capture, not whether the panel may
 * call into the editor.
 */

import { keyEventToString } from './keymap.js';

// -----------------------------------------------------------------------
// Pure tab-state reducer (no DOM) — unit-tested in Node.

/**
 * @typedef {object} UtilityTab
 * @property {string} id
 * @property {string} title
 * @property {string} [icon]
 * @property {boolean} closable
 * @property {boolean} modal
 */

/**
 * @typedef {object} UtilityState
 * @property {UtilityTab[]} tabs - In display (left-to-right) order.
 * @property {string|null} activeId
 */

/** The empty dock state. @returns {UtilityState} */
export function emptyUtilityState() {
  return { tabs: [], activeId: null };
}

/**
 * Add a tab (or update + re-activate an existing one with the same id), and
 * make it active. Pure — returns a new state.
 *
 * @param {UtilityState} state
 * @param {UtilityTab} tab
 * @returns {UtilityState}
 */
export function addTab(state, tab) {
  const idx = state.tabs.findIndex((t) => t.id === tab.id);
  if (idx !== -1) {
    const tabs = state.tabs.slice();
    tabs[idx] = { ...tabs[idx], ...tab };
    return { tabs, activeId: tab.id };
  }
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

/**
 * Remove a tab by id. A non-closable tab (the REPL) is refused (state
 * unchanged). If the removed tab was active, the right neighbour becomes
 * active (or the left one if it was last). Pure.
 *
 * @param {UtilityState} state
 * @param {string} id
 * @returns {UtilityState}
 */
export function removeTab(state, id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return state;
  if (!state.tabs[idx].closable) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  let activeId = state.activeId;
  if (activeId === id) {
    const next = tabs[idx] ?? tabs[idx - 1] ?? null;
    activeId = next ? next.id : null;
  }
  return { tabs, activeId };
}

/**
 * Make an existing tab active (no-op if absent or already active). Pure.
 *
 * @param {UtilityState} state
 * @param {string} id
 * @returns {UtilityState}
 */
export function activateTab(state, id) {
  if (!state.tabs.some((t) => t.id === id)) return state;
  if (state.activeId === id) return state;
  return { ...state, activeId: id };
}

/**
 * The id of the tab DELTA steps from the active one, wrapping in both
 * directions. Null when there are no tabs. Pure.
 *
 * @param {UtilityState} state
 * @param {number} delta
 * @returns {string|null}
 */
export function nextTabId(state, delta) {
  const n = state.tabs.length;
  if (n === 0) return null;
  const i = state.tabs.findIndex((t) => t.id === state.activeId);
  const base = i === -1 ? 0 : i;
  const j = (((base + delta) % n) + n) % n;
  return state.tabs[j].id;
}

/** Whether the tab strip should show (more than the resident tab exists). */
export function tabsVisible(state) {
  return state.tabs.length > 1;
}

/** The active tab record, or null. */
export function activeTab(state) {
  return state.tabs.find((t) => t.id === state.activeId) ?? null;
}

// -----------------------------------------------------------------------
// The DOM host factory.

/** Bare modifier keydowns are not keystrokes in their own right. */
const BARE_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * Create the utility dock. The host supplies the three chrome elements (a tab
 * strip, a content area, and the section that wraps them) and a callback to
 * return focus to the editing origin when a tool tab closes or the dock hides.
 *
 * @param {object} options
 * @param {HTMLElement} options.hostEl - The `#utility-host` section.
 * @param {HTMLElement} options.tabsEl - The `.utility-tabs` strip.
 * @param {HTMLElement} options.contentEl - The `.utility-content` area.
 * @param {Document} [options.document]
 * @param {() => void} [options.onFocusOrigin] - Focus the editing origin
 *   (e.g. the active text view) when a tool closes / the dock hides.
 * @returns {object} The dock API.
 */
export function createUtilityDock(options) {
  const doc = options.document ?? globalThis.document;
  const { hostEl, tabsEl, contentEl } = options;
  const onFocusOrigin = typeof options.onFocusOrigin === 'function' ? options.onFocusOrigin : null;

  let state = emptyUtilityState();
  /** @type {Map<string, {tab: UtilityTab, panel: object, wrapper: HTMLElement}>} */
  const entries = new Map();
  /** @type {((event: KeyboardEvent) => void)|null} The window-capture handler
   *  for the active modal tab, or null. */
  let captureHandler = null;

  function removeCapture() {
    if (captureHandler) {
      window.removeEventListener('keydown', captureHandler, true);
      captureHandler = null;
    }
  }

  /** Install the capture-phase key router for a modal panel. Mirrors the
   *  proven RefTeX-dock handler: swallow plain keys and feed them to the
   *  panel; offer chords and swallow only those the panel consumes. */
  function installCaptureFor(panel) {
    removeCapture();
    captureHandler = (event) => {
      if (BARE_MODIFIERS.has(event.key)) return;
      const keyString = keyEventToString(event);
      if (event.metaKey || event.ctrlKey || event.altKey) {
        if (typeof panel.handleKey === 'function' && panel.handleKey(keyString)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (typeof panel.handleKey === 'function') panel.handleKey(keyString);
    };
    window.addEventListener('keydown', captureHandler, true);
  }

  function renderTabs() {
    tabsEl.replaceChildren();
    for (const tab of state.tabs) {
      const tabEl = doc.createElement('button');
      tabEl.type = 'button';
      tabEl.className = 'utility-tab';
      tabEl.dataset.id = tab.id;
      if (tab.id === state.activeId) tabEl.classList.add('is-active');
      if (tab.icon) {
        const i = doc.createElement('i');
        i.className = `${tab.icon} utility-tab-icon`;
        tabEl.append(i);
      }
      const label = doc.createElement('span');
      label.className = 'utility-tab-label';
      label.textContent = tab.title;
      tabEl.append(label);
      if (tab.closable) {
        const close = doc.createElement('span');
        close.className = 'utility-tab-close';
        close.dataset.close = tab.id;
        close.textContent = '×';
        tabEl.append(close);
      }
      tabsEl.append(tabEl);
    }
    tabsEl.hidden = !tabsVisible(state);
  }

  /** Show only the active panel wrapper; (de)install the modal capture. */
  function renderActive() {
    for (const [id, entry] of entries) {
      entry.wrapper.hidden = id !== state.activeId;
    }
    const active = entries.get(state.activeId);
    if (active && active.tab.modal && isUtilityVisible()) installCaptureFor(active.panel);
    else removeCapture();
  }

  function focusActivePanel() {
    const active = entries.get(state.activeId);
    if (!active) return;
    if (typeof active.panel.focus === 'function') active.panel.focus();
    else active.wrapper.focus();
  }

  function showUtilityDock() {
    doc.body.classList.remove('utility-hidden');
  }

  function hideUtilityDock() {
    doc.body.classList.add('utility-hidden');
    removeCapture();
    if (onFocusOrigin) onFocusOrigin();
  }

  function toggleUtilityDock() {
    const hidden = doc.body.classList.toggle('utility-hidden');
    if (hidden) {
      removeCapture();
      if (onFocusOrigin) onFocusOrigin();
    } else {
      renderActive();
      focusActivePanel();
    }
    return hidden;
  }

  function isUtilityVisible() {
    return !doc.body.classList.contains('utility-hidden');
  }

  /** Build the per-panel handle bound to its own tab id. */
  function handleFor(id) {
    return {
      close: () => closeUtilityTab(id),
      focus: () => focusActivePanel(),
      activate: () => activateUtilityTab(id),
    };
  }

  /**
   * Open a panel as a tab, or — if a tab with this id already exists —
   * replace its panel in place (the "swap") and re-activate it. Shows the
   * dock and focuses the panel.
   *
   * @param {object} opts
   * @param {string} opts.id
   * @param {(handle: object) => object} opts.makePanel
   * @param {string} [opts.title]
   * @param {string} [opts.icon]
   * @param {boolean} [opts.modal]
   * @param {boolean} [opts.closable]
   * @returns {string} the tab id.
   */
  function openUtilityPanel(opts) {
    const { id, makePanel } = opts;
    const existing = entries.get(id);
    if (existing) {
      if (makePanel) {
        if (typeof existing.panel.destroy === 'function') existing.panel.destroy();
        existing.wrapper.replaceChildren();
        const panel = makePanel(handleFor(id));
        existing.wrapper.append(panel.element);
        existing.panel = panel;
        existing.tab = mergeTab(id, opts, panel, existing.tab);
      } else {
        existing.tab = mergeTab(id, opts, existing.panel, existing.tab);
      }
      state = addTab(state, existing.tab);
      showUtilityDock();
      renderTabs();
      renderActive();
      focusActivePanel();
      return id;
    }

    const panel = makePanel(handleFor(id));
    const wrapper = doc.createElement('div');
    wrapper.className = 'utility-panel';
    wrapper.tabIndex = -1;
    wrapper.append(panel.element);
    contentEl.append(wrapper);
    const tab = mergeTab(id, opts, panel, null);
    entries.set(id, { tab, panel, wrapper });
    state = addTab(state, tab);
    showUtilityDock();
    renderTabs();
    renderActive();
    focusActivePanel();
    return id;
  }

  function activateUtilityTab(id) {
    if (!entries.has(id)) return;
    state = activateTab(state, id);
    showUtilityDock();
    renderTabs();
    renderActive();
    focusActivePanel();
  }

  function closeUtilityTab(id) {
    const entry = entries.get(id);
    if (!entry) return;
    if (!entry.tab.closable) return;
    const wasActive = state.activeId === id;
    state = removeTab(state, id);
    if (typeof entry.panel.onClose === 'function') entry.panel.onClose();
    if (typeof entry.panel.destroy === 'function') entry.panel.destroy();
    entry.wrapper.remove();
    entries.delete(id);
    renderTabs();
    renderActive();
    if (wasActive) {
      const active = entries.get(state.activeId);
      if (active && active.tab.modal) focusActivePanel();
      else if (onFocusOrigin) onFocusOrigin();
    }
  }

  function cycleUtilityTab(delta) {
    const id = nextTabId(state, delta);
    if (id) activateUtilityTab(id);
  }

  // Click a tab to activate it; click its × to close it.
  tabsEl.addEventListener('click', (event) => {
    const closeEl = event.target.closest('.utility-tab-close');
    if (closeEl) {
      closeUtilityTab(closeEl.dataset.close ?? '');
      return;
    }
    const tabEl = event.target.closest('.utility-tab');
    if (tabEl) activateUtilityTab(tabEl.dataset.id ?? '');
  });

  return {
    openUtilityPanel,
    activateUtilityTab,
    closeUtilityTab,
    focusUtilityPane: focusActivePanel,
    cycleUtilityTab,
    showUtilityDock,
    hideUtilityDock,
    toggleUtilityDock,
    isUtilityVisible,
    hasTab: (id) => entries.has(id),
    /** The live panel object for ID, or null (for output-streaming primitives). */
    getPanel: (id) => entries.get(id)?.panel ?? null,
  };
}

/** Build a tab record from open-options, falling back to panel-declared props
 *  then to a prior tab. Options win over panel props. */
function mergeTab(id, opts, panel, prior) {
  return {
    id,
    title: opts.title ?? panel?.title ?? prior?.title ?? id,
    icon: opts.icon ?? panel?.icon ?? prior?.icon,
    closable: opts.closable ?? panel?.closable ?? prior?.closable ?? true,
    modal: opts.modal ?? panel?.modal ?? prior?.modal ?? false,
  };
}
