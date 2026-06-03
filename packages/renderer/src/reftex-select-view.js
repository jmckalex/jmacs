/**
 * @file The `*RefTeX Select*` view — RefTeX's signature label / cite
 * picker, the selection-first half of plans/RefTeX.md's "dual picker".
 *
 * A `reftex-select`-kind singleton view shows the document's reference
 * candidates grouped by type, each row a `name` plus a one-line
 * **context** (the source line carrying the label, or its enclosing
 * section title). The user navigates with the keyboard — the keys mirror
 * Emacs RefTeX:
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
 * `options.getCandidates()` (one record per candidate), so the element
 * needs no buffer of its own; the host keeps it live by calling
 * `refresh()`. Selection / peek / cancel act on the **originating** view
 * through the host closures (`onSelect(name)`, `onPeek(name)`,
 * `onCancel()`), which call back into Lisp.
 *
 * Element-level keydown lifecycle follows placeholder-view /
 * view-list-view: single keys are captured natively on the element and
 * removed on destroy; genuine editor chords (Ctrl/Alt/Meta held, or a
 * chord in progress) are forwarded to the host keymap via `onKey`.
 *
 * See docs/VIEWS.md for the view-kind invariants; this is a leaf-direct
 * singleton, hidden by `hideInactiveSingletons` when not the active leaf.
 */

import { keyEventToString } from './keymap.js';
import { defineViewElement, ViewElement } from './view-elements.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

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

// -----------------------------------------------------------------------
// The DOM factory.

/**
 * Create a RefTeX-select view.
 *
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {() => ReftexCandidate[]} [options.getCandidates]
 * @param {(name: string) => void} [options.onSelect]
 * @param {(name: string) => void} [options.onPeek]
 * @param {() => void} [options.onCancel]
 * @param {(key: string) => boolean} [options.onKey]
 * @param {() => boolean} [options.chordPending]
 * @returns {{ element: HTMLElement, setBuffer: Function, refresh: Function, focus: Function, destroy: Function, applyTheme: Function }}
 */
function createReftexSelectView(container, options = {}) {
  const doc = container.ownerDocument;
  const getCandidates =
    typeof options.getCandidates === 'function' ? options.getCandidates : () => [];
  const onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
  const onPeek = typeof options.onPeek === 'function' ? options.onPeek : null;
  const onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const chordPending =
    typeof options.chordPending === 'function' ? options.chordPending : () => false;

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
  container.append(root);

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

  // Element-level keydown: single keys are the picker's; genuine chords
  // forward to the host keymap. Captured on the focusable root and
  // removed on destroy.
  function onKeyDown(event) {
    if (MODIFIERS.has(event.key)) return;
    const key = keyEventToString(event);

    // Forward genuine editor chords (or a chord in progress) so C-x etc.
    // still fire while the picker has focus.
    if (chordPending() || event.ctrlKey || event.altKey || event.metaKey) {
      if (onKey && onKey(key)) event.preventDefault();
      return;
    }

    switch (event.key) {
      case 'n':
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'p':
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Enter':
        event.preventDefault();
        selectCurrent();
        return;
      case ' ':
        event.preventDefault();
        peekCurrent();
        return;
      case 't':
        event.preventDefault();
        cycleType();
        return;
      case 'q':
      case 'Escape':
        event.preventDefault();
        cancel();
        return;
      case 'Backspace':
        event.preventDefault();
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          highlight = 0;
          render();
        }
        return;
      default:
        break;
    }

    // Printable single characters extend the substring filter. (`t`, `n`,
    // `p`, `q` are reserved above — RefTeX's own trade-off; the substring
    // filter is still reachable for other letters, and Backspace edits.)
    if (event.key.length === 1) {
      event.preventDefault();
      filter += event.key;
      highlight = 0;
      render();
    }
  }
  root.addEventListener('keydown', onKeyDown);

  function setBuffer() {
    // A fresh activation resets the transient filter state so the picker
    // always opens showing everything.
    filter = '';
    typeFilter = null;
    highlight = 0;
    render();
  }

  render();
  return {
    element: root,
    setBuffer,
    refresh: render,
    focus: () => root.focus(),
    applyTheme: () => {},
    destroy: () => {
      root.removeEventListener('keydown', onKeyDown);
    },
  };
}

// -----------------------------------------------------------------------
// `<reftex-select-view>` — custom-element wrapper.

export class ReftexSelectView extends ViewElement {
  constructor() {
    super();
    this._inner = null;
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('ReftexSelectView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'reftex-select';
  }

  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    if (this._inner !== null) this._inner.setBuffer(buffer);
  }

  /** Re-read the candidates and repaint — called when the document or
   *  the candidate set changes so the list stays live. */
  refresh() {
    if (this._inner !== null) this._inner.refresh();
  }

  focus() {
    if (this._inner !== null) this._inner.focus();
    else super.focus();
  }

  applyTheme() {
    if (this._inner !== null) this._inner.applyTheme();
  }

  connectedCallback() {
    if (this._inner !== null) return;
    this._inner = createReftexSelectView(this, this._options ?? {});
    if (this._pendingBuffer !== null) this._inner.setBuffer(this._pendingBuffer);
  }

  disconnectedCallback() {
    /* hide-not-kill: a DOM move keeps the element alive */
  }

  destroy() {
    if (this._inner !== null) {
      this._inner.destroy();
      this._inner = null;
    }
    this._pendingBuffer = null;
  }
}

defineViewElement('reftex-select-view', ReftexSelectView);
