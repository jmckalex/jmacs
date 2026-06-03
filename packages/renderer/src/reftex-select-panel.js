/**
 * @file The `*RefTeX Select*` panel — RefTeX's signature label / cite
 * picker, the selection-first half of plans/RefTeX.md's "dual picker".
 *
 * This is the **floating-panel** form of the picker: it renders the
 * document's reference candidates grouped by type (each row a `name` plus
 * a one-line **context**), but it is NOT a pane view. The host mounts the
 * panel element in a right-edge drawer overlaid on the editor (see
 * `openReftexSelectOverlay` in apps/desktop/src/app.js, modelled on
 * `move-view-mode.js`) so the document stays visible underneath and
 * **SPC peek can drive the editor pane below the panel** — the bug the
 * old pane-takeover form couldn't fix.
 *
 * The keys mirror Emacs RefTeX:
 *
 *   n / p, ↓ / ↑   move the highlight
 *   RET            select — insert the reference at the origin
 *   SPC            peek — jump to the label's source, keep the picker
 *   t              cycle the type filter (all → first type → … → all)
 *   <printable>    filter rows by substring (case-insensitive)
 *   Backspace      edit the substring filter
 *   q / Escape     cancel — return to the origin
 *
 * The data is pulled from the host on every render via
 * `options.getCandidates()` (one record per candidate), so the panel
 * needs no buffer of its own; the host keeps it live by calling
 * `refresh()`. Selection / peek / cancel act on the **originating** view
 * through the host closures (`onSelect(name)`, `onPeek(name)`,
 * `onCancel()`), which call back into Lisp.
 *
 * The overlay feeds keys in via `handleKey(keyString)` (the modal
 * window-capture handler reads keystrokes even when a focused `<webview>`
 * would eat them); `handleKey` returns whether it consumed the key. The
 * pure key→action mapping (`mapReftexKey`) is exported and unit-tested.
 */

// -----------------------------------------------------------------------
// Pure helpers (no DOM) — unit-tested in Node.

/**
 * @typedef {object} ReftexCandidate
 * @property {string} name - The label name (the `{…}` key).
 * @property {string} type - The display type ("equation", "figure", …)
 *   or '' for a typeless label.
 * @property {string} macro - The reference macro for this candidate
 *   (`\ref`, `\eqref`, …) — shown as a hint and used by the host on
 *   select.
 * @property {string} context - The one-line context (source line or
 *   enclosing section title), already trimmed.
 */

/** The display heading for a candidate's type. A typeless candidate
 *  groups under "Other". */
export function groupHeading(type) {
  if (typeof type !== 'string' || type === '') return 'Other';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Filter candidates by a case-insensitive substring of the name (and,
 * secondarily, the context), and by an optional exact type. An empty
 * filter and a null type both match everything.
 *
 * @param {ReftexCandidate[]} candidates
 * @param {string} filter - Substring to match (case-insensitive).
 * @param {string|null} typeFilter - Exact type to keep, or null for all.
 * @returns {ReftexCandidate[]}
 */
export function filterCandidates(candidates, filter, typeFilter) {
  const needle = (filter ?? '').toLowerCase();
  return (candidates ?? []).filter((c) => {
    if (typeFilter && c.type !== typeFilter) return false;
    if (needle === '') return true;
    const name = (c.name ?? '').toLowerCase();
    const context = (c.context ?? '').toLowerCase();
    return name.includes(needle) || context.includes(needle);
  });
}

/**
 * The distinct types present across CANDIDATES, in first-seen order.
 * Used to build the `t`-key type-filter cycle.
 *
 * @param {ReftexCandidate[]} candidates
 * @returns {string[]}
 */
export function distinctTypes(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates ?? []) {
    const t = c.type ?? '';
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Group CANDIDATES by type into `{ type, heading, items }` blocks, in
 * first-seen type order. Pure — drives the grouped render.
 *
 * @param {ReftexCandidate[]} candidates
 * @returns {Array<{type: string, heading: string, items: ReftexCandidate[]}>}
 */
export function groupByType(candidates) {
  const order = [];
  const byType = new Map();
  for (const c of candidates ?? []) {
    const t = c.type ?? '';
    if (!byType.has(t)) {
      byType.set(t, []);
      order.push(t);
    }
    byType.get(t).push(c);
  }
  return order.map((t) => ({
    type: t,
    heading: groupHeading(t),
    items: byType.get(t),
  }));
}

/**
 * The next type filter in the cycle: null (all) → types[0] → types[1] →
 * … → null. Given the current filter and the available types.
 *
 * @param {string|null} current
 * @param {string[]} types
 * @returns {string|null}
 */
export function nextTypeFilter(current, types) {
  if (!types || types.length === 0) return null;
  if (current === null) return types[0];
  const idx = types.indexOf(current);
  if (idx === -1 || idx === types.length - 1) return null;
  return types[idx + 1];
}

/**
 * Map a key string (as produced by `keyEventToString`, e.g. "n", "RET",
 * "SPC", "Backspace", "a") to the picker action it triggers — PURE, so
 * the overlay's key routing is unit-testable without a DOM.
 *
 * Returns one of:
 *   { type: 'move', delta: ±1 }     n/p/down/up
 *   { type: 'select' }              RET / Enter
 *   { type: 'peek' }                SPC / Space
 *   { type: 'cycle-type' }          t
 *   { type: 'cancel' }              q / Escape
 *   { type: 'backspace' }           Backspace / Delete
 *   { type: 'filter', char }        a single printable character
 *   null                            not a picker key (ignore)
 *
 * Modifier-bearing chords (C-x, M-…) are NOT mapped here — the caller
 * decides whether to swallow or forward them; this mapping is for the
 * picker's own single-key vocabulary.
 *
 * @param {string} key
 * @returns {{type: string, delta?: number, char?: string}|null}
 */
export function mapReftexKey(key) {
  switch (key) {
    case 'n':
    case 'Down':
    case 'ArrowDown':
      return { type: 'move', delta: 1 };
    case 'p':
    case 'Up':
    case 'ArrowUp':
      return { type: 'move', delta: -1 };
    case 'RET':
    case 'Enter':
      return { type: 'select' };
    case 'SPC':
    case ' ':
    case 'Space':
      return { type: 'peek' };
    case 't':
      return { type: 'cycle-type' };
    case 'q':
    case 'Escape':
    case 'Esc':
      return { type: 'cancel' };
    case 'Backspace':
    case 'Delete':
    case 'DEL':
      return { type: 'backspace' };
    default:
      // A single printable character extends the substring filter.
      // (`t`, `n`, `p`, `q` are reserved above — RefTeX's own trade-off;
      // the substring filter is still reachable for other letters, and
      // Backspace edits it.)
      if (key.length === 1) return { type: 'filter', char: key };
      return null;
  }
}

// -----------------------------------------------------------------------
// The DOM factory.

/**
 * Create a RefTeX-select panel. The host mounts `element` in the
 * right-edge overlay and feeds keys via `handleKey`.
 *
 * @param {object} [options]
 * @param {Document} [options.document] - The document to build nodes in
 *   (defaults to the global `document`).
 * @param {() => ReftexCandidate[]} [options.getCandidates]
 * @param {(name: string) => void} [options.onSelect]
 * @param {(name: string) => void} [options.onPeek]
 * @param {() => void} [options.onCancel]
 * @returns {{ element: HTMLElement, refresh: Function, focus: Function, destroy: Function, handleKey: (key: string) => boolean }}
 */
export function createReftexSelectPanel(options = {}) {
  const doc = options.document ?? globalThis.document;
  const getCandidates =
    typeof options.getCandidates === 'function' ? options.getCandidates : () => [];
  const onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
  const onPeek = typeof options.onPeek === 'function' ? options.onPeek : null;
  const onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;

  /** @type {ReftexCandidate[]} - The current filtered+ordered flat list,
   *  index-aligned with the rendered rows, for highlight movement. */
  let flat = [];
  /** @type {number} - Index of the highlighted row in `flat`. */
  let highlight = 0;
  /** @type {string} - The substring filter. */
  let filter = '';
  /** @type {string|null} - The active type filter (null = all). */
  let typeFilter = null;

  const root = doc.createElement('div');
  root.className = 'reftex-select-view';
  root.tabIndex = -1;

  // Header: icon + title + the live filter line.
  const header = doc.createElement('div');
  header.className = 'reftex-select-header';
  const headerIcon = doc.createElement('i');
  headerIcon.className = 'fa-solid fa-anchor';
  const headerLabel = doc.createElement('span');
  headerLabel.className = 'reftex-select-header-label';
  headerLabel.textContent = 'RefTeX Select';
  const filterEl = doc.createElement('span');
  filterEl.className = 'reftex-select-filter';
  header.append(headerIcon, headerLabel, filterEl);
  root.append(header);

  const scroll = doc.createElement('div');
  scroll.className = 'reftex-select-scroll';
  root.append(scroll);

  const hint = doc.createElement('div');
  hint.className = 'reftex-select-hint';
  hint.textContent =
    'n/p move · RET insert · SPC peek · t type · type to filter · q quit';
  root.append(hint);

  /** Re-read candidates, apply the filters, and repaint the grouped
   *  list. Keeps the highlight in range. */
  function render() {
    const all = getCandidates() || [];
    const filtered = filterCandidates(all, filter, typeFilter);
    flat = filtered;
    if (highlight >= flat.length) highlight = Math.max(0, flat.length - 1);
    if (highlight < 0) highlight = 0;

    // Filter line.
    const bits = [];
    if (typeFilter) bits.push(`[${groupHeading(typeFilter)}]`);
    if (filter !== '') bits.push(`"${filter}"`);
    filterEl.textContent = bits.length ? bits.join(' ') : '';

    scroll.replaceChildren();
    if (flat.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'reftex-select-empty';
      empty.textContent = all.length === 0 ? 'No labels in this document.' : 'No matches.';
      scroll.append(empty);
      return;
    }

    const groups = groupByType(filtered);
    let rowIndex = 0;
    for (const group of groups) {
      const head = doc.createElement('div');
      head.className = 'reftex-select-group';
      head.textContent = group.heading;
      scroll.append(head);
      for (const cand of group.items) {
        const idx = rowIndex;
        const row = doc.createElement('div');
        row.className = 'reftex-select-row';
        row.dataset.index = String(idx);
        if (idx === highlight) row.classList.add('is-current');

        const nameEl = doc.createElement('span');
        nameEl.className = 'reftex-select-name';
        nameEl.textContent = cand.name ?? '';
        const macroEl = doc.createElement('span');
        macroEl.className = 'reftex-select-macro';
        macroEl.textContent = cand.macro ?? '';
        const ctxEl = doc.createElement('div');
        ctxEl.className = 'reftex-select-context';
        ctxEl.textContent = cand.context ?? '';

        const top = doc.createElement('div');
        top.className = 'reftex-select-row-top';
        top.append(nameEl, macroEl);
        row.append(top, ctxEl);
        scroll.append(row);
        rowIndex += 1;
      }
    }
    scrollHighlightIntoView();
  }

  function scrollHighlightIntoView() {
    const el = scroll.querySelector('.reftex-select-row.is-current');
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  /** Move the highlight by DELTA, clamped, and repaint. */
  function move(delta) {
    if (flat.length === 0) return;
    highlight = Math.min(flat.length - 1, Math.max(0, highlight + delta));
    render();
  }

  function currentName() {
    const cand = flat[highlight];
    return cand ? cand.name : null;
  }

  function selectCurrent() {
    const name = currentName();
    if (name != null && onSelect) onSelect(name);
  }

  function peekCurrent() {
    const name = currentName();
    if (name != null && onPeek) onPeek(name);
  }

  function cancel() {
    if (onCancel) onCancel();
  }

  function cycleType() {
    const types = distinctTypes(getCandidates() || []);
    typeFilter = nextTypeFilter(typeFilter, types);
    highlight = 0;
    render();
  }

  function backspaceFilter() {
    if (filter.length > 0) {
      filter = filter.slice(0, -1);
      highlight = 0;
      render();
    }
  }

  function extendFilter(char) {
    filter += char;
    highlight = 0;
    render();
  }

  // Click a row to highlight + select it; the rows render fresh each
  // paint, so delegate from the scroll container.
  scroll.addEventListener('click', (event) => {
    const row = event.target.closest('.reftex-select-row');
    if (!row) return;
    const idx = Number.parseInt(row.dataset.index ?? '', 10);
    if (!Number.isFinite(idx)) return;
    highlight = idx;
    render();
    selectCurrent();
  });

  /**
   * Process a single key string fed by the overlay's window-capture
   * handler. Returns whether the key was consumed (so the caller can
   * `preventDefault`/`stopPropagation`).
   *
   * @param {string} key
   * @returns {boolean}
   */
  function handleKey(key) {
    const action = mapReftexKey(key);
    if (!action) return false;
    switch (action.type) {
      case 'move':
        move(action.delta);
        return true;
      case 'select':
        selectCurrent();
        return true;
      case 'peek':
        peekCurrent();
        return true;
      case 'cycle-type':
        cycleType();
        return true;
      case 'cancel':
        cancel();
        return true;
      case 'backspace':
        backspaceFilter();
        return true;
      case 'filter':
        extendFilter(action.char);
        return true;
      default:
        return false;
    }
  }

  // A fresh activation resets the transient filter state so the picker
  // always opens showing everything.
  function reset() {
    filter = '';
    typeFilter = null;
    highlight = 0;
    render();
  }

  reset();
  return {
    element: root,
    refresh: render,
    reset,
    focus: () => root.focus(),
    handleKey,
    destroy: () => {
      root.remove();
    },
  };
}
