/**
 * @file Model-B generic PICKER panel (G0b) — the client-side render of the
 * reusable picker channel.
 *
 * This is the ONE render-side picker UI that every server-driven picker
 * reuses: the buffer list, *Recover*, completions, RefTeX select, cite. The
 * server sends a `PICKER` message `{ id, title, rows, options }`; this module
 * paints an interactive list — a title, a type-to-narrow filter, keyboard
 * navigation, Enter/click to choose, Escape to cancel — and reports the
 * chosen row's value (or a cancel) back through two host closures. It holds
 * NO buffer/registry knowledge: the rows are opaque `{ label, value, ...meta }`
 * records the server's row-provider built, so the same panel serves any
 * picker (plan §2.2.3).
 *
 * The interaction state machine (which rows survive the filter, which row is
 * selected, how the selection moves) is factored into PURE functions at the
 * top so it is unit-testable under `node --test` with no DOM; the DOM half
 * (`createPickerPanel`) is verified live + by the electron self-test. Loaded
 * only by the mwb pane harness — production is untouched.
 */

import { filterPickerRows } from './protocol.js';

// --- the pure interaction core (DOM-free, unit-tested) ----------------

/**
 * The visible rows for a query + the index of the row that should be
 * selected, given the previously-selected value. Keeps the selection on the
 * same row when it survives the filter; otherwise selects the first match (or
 * the row marked `current`, on the first paint with no query). Pure.
 *
 * @param {import('./protocol.js').PickerRow[]} rows - All rows.
 * @param {string} query - The filter text.
 * @param {*} prevValue - The value of the previously-selected row, or null.
 * @returns {{ visible: import('./protocol.js').PickerRow[], selected: number }}
 *   `selected` is an index into `visible` (-1 when empty).
 */
export function pickerView(rows, query, prevValue) {
  const visible = filterPickerRows(rows, query);
  if (visible.length === 0) return { visible, selected: -1 };
  // Keep the selection on the same value if it survived the filter.
  if (prevValue != null) {
    const keep = visible.findIndex((r) => r.value === prevValue);
    if (keep >= 0) return { visible, selected: keep };
  }
  // No query yet and a row is marked current → select it (the window's buffer).
  if ((query ?? '').trim() === '') {
    const cur = visible.findIndex((r) => r.current);
    if (cur >= 0) return { visible, selected: cur };
  }
  return { visible, selected: 0 };
}

/**
 * Move a selection index by DELTA within a list of LENGTH, clamping at the
 * ends (no wrap — like Emacs's completion list). Pure.
 *
 * @param {number} index - Current index.
 * @param {number} delta - +1 (down) / -1 (up) / ±N (page).
 * @param {number} length - The number of visible rows.
 * @returns {number} The new index (clamped to [0, length-1], or -1 if empty).
 */
export function moveSelection(index, delta, length) {
  if (length <= 0) return -1;
  const next = (Number.isFinite(index) ? index : 0) + delta;
  return Math.max(0, Math.min(length - 1, next));
}

// --- the DOM panel ----------------------------------------------------

/**
 * Create a generic picker panel and mount it in CONTAINER. Returns a handle
 * with `destroy()` and `focus()`. The host wires two closures: `onChoose`
 * (the chosen row's value) and `onCancel`. The panel owns ALL interaction:
 * filtering, keyboard nav, click — the host only learns the outcome.
 *
 * @param {HTMLElement} container - Where to mount (an overlay host).
 * @param {object} options
 * @param {import('./protocol.js').PickerRequest} options.request - The
 *   normalised `{ id, title, rows, options }` from the PICKER message.
 * @param {(value: *) => void} options.onChoose - Called with the chosen row's
 *   value (Enter / click).
 * @param {() => void} options.onCancel - Called on Escape / C-g.
 * @param {Document} [options.document] - Injectable for tests.
 * @returns {{ destroy: () => void, focus: () => void, el: HTMLElement }}
 */
export function createPickerPanel(container, options = {}) {
  const doc = options.document || (container && container.ownerDocument) || globalThis.document;
  const request = options.request || { id: 'picker', title: '', rows: [], options: {} };
  const rows = Array.isArray(request.rows) ? request.rows : [];
  const opts = request.options || {};
  const onChoose = typeof options.onChoose === 'function' ? options.onChoose : () => {};
  const onCancel = typeof options.onCancel === 'function' ? options.onCancel : () => {};
  const onDelete = typeof options.onDelete === 'function' ? options.onDelete : null;
  const filterEnabled = opts.filter !== false;

  // --- mutable interaction state ---
  let query = '';
  let visible = rows.slice();
  let selected = -1;
  let selectedValue = null;

  // --- DOM scaffold ---
  const root = doc.createElement('div');
  root.className = 'mwb-picker';
  if (opts.kind) root.classList.add(`mwb-picker--${opts.kind}`);

  const titleEl = doc.createElement('div');
  titleEl.className = 'mwb-picker-title';
  titleEl.textContent = request.title || '';
  root.appendChild(titleEl);

  let inputEl = null;
  if (filterEnabled) {
    inputEl = doc.createElement('input');
    inputEl.className = 'mwb-picker-filter';
    inputEl.type = 'text';
    inputEl.spellcheck = false;
    if (opts.placeholder) inputEl.placeholder = opts.placeholder;
    inputEl.addEventListener('input', () => {
      query = inputEl.value;
      recompute();
      renderRows();
    });
    root.appendChild(inputEl);
  }

  const listEl = doc.createElement('div');
  listEl.className = 'mwb-picker-list';
  root.appendChild(listEl);

  // An optional action hint footer (e.g. "↵ restore   ⌫ delete   esc start fresh").
  if (typeof opts.hint === 'string' && opts.hint !== '') {
    const hintEl = doc.createElement('div');
    hintEl.className = 'mwb-picker-hint';
    hintEl.textContent = opts.hint;
    hintEl.style.cssText = 'opacity:0.55;font-size:0.85em;padding:6px 10px;';
    root.appendChild(hintEl);
  }

  if (container) container.appendChild(root);

  // --- the row-element map (rebuilt on each filter) ---
  /** @type {HTMLElement[]} */
  let rowEls = [];

  function recompute() {
    const v = pickerView(rows, query, selectedValue);
    visible = v.visible;
    selected = v.selected;
    selectedValue = selected >= 0 ? visible[selected].value : null;
  }

  function renderRows() {
    listEl.replaceChildren();
    rowEls = [];
    visible.forEach((row, i) => {
      const item = doc.createElement('div');
      item.className = 'mwb-picker-row';
      if (row.current) item.classList.add('mwb-picker-row--current');
      const label = doc.createElement('span');
      label.className = 'mwb-picker-row-label';
      label.textContent = row.label;
      item.appendChild(label);
      if (row.meta) {
        const meta = doc.createElement('span');
        meta.className = 'mwb-picker-row-meta';
        meta.textContent = row.meta;
        item.appendChild(meta);
      }
      if (row.detail) {
        const detail = doc.createElement('div');
        detail.className = 'mwb-picker-row-detail';
        detail.textContent = row.detail;
        item.appendChild(detail);
      }
      // A clickable × on a deletable row (workspace mgmt), top-right of the row.
      if (onDelete && row.deletable === true) {
        item.style.position = 'relative';
        const del = doc.createElement('span');
        del.className = 'mwb-picker-row-delete';
        del.textContent = '×';
        del.title = 'Delete workspace';
        del.style.cssText =
          'position:absolute;right:6px;top:6px;color:#e06c75;cursor:pointer;'
          + 'opacity:0.6;font-size:1.15em;line-height:1;padding:2px 5px;';
        del.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation(); // don't also trigger the row's choose
          deleteAt(i);
        });
        item.appendChild(del);
      }
      item.addEventListener('mousedown', (e) => {
        // mousedown (not click) so the focus doesn't bounce to the row first.
        e.preventDefault();
        choose(i);
      });
      listEl.appendChild(item);
      rowEls.push(item);
    });
    paintSelection();
  }

  function paintSelection() {
    rowEls.forEach((el, i) => {
      el.classList.toggle('mwb-picker-row--selected', i === selected);
    });
    const sel = rowEls[selected];
    if (sel && typeof sel.scrollIntoView === 'function') {
      sel.scrollIntoView({ block: 'nearest' });
    }
  }

  function move(delta) {
    if (visible.length === 0) return;
    selected = moveSelection(selected, delta, visible.length);
    selectedValue = visible[selected] ? visible[selected].value : null;
    paintSelection();
  }

  function choose(index) {
    const i = typeof index === 'number' ? index : selected;
    if (i < 0 || i >= visible.length) { onCancel(); return; }
    const value = visible[i].value;
    onChoose(value);
  }

  /** Delete the row at visible-index POS (only if it's flagged `deletable` — a
   *  named workspace, not "Last workspace" / "Start fresh"). Removes it and keeps
   *  the selection at the SAME position (the item that slid up, or the new last
   *  one) rather than jumping to the top; the panel stays open so several can be
   *  cleared in a row. */
  function deleteAt(pos) {
    if (!onDelete || pos < 0 || pos >= visible.length) return;
    const row = visible[pos];
    if (!row || row.deletable !== true) return;
    onDelete(row.value);
    const i = rows.indexOf(row);
    if (i >= 0) rows.splice(i, 1);
    recompute(); // would re-select the first row (the deleted value is gone) —
    if (visible.length > 0) {
      selected = Math.min(pos, visible.length - 1); // …so pin it back to POS.
      selectedValue = visible[selected].value;
    }
    renderRows();
  }
  function deleteSelected() { deleteAt(selected); }

  // --- keyboard ---
  function onKeyDown(event) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault(); move(1); break;
      case 'ArrowUp':
        event.preventDefault(); move(-1); break;
      case 'n':
        // C-n navigates ANY picker (a modifier can't be filter text); bare n
        // navigates a no-filter MENU picker (the workspace chooser), where there
        // is no filter input to swallow it.
        if (event.ctrlKey || !inputEl) { event.preventDefault(); move(1); }
        break;
      case 'p':
        if (event.ctrlKey || !inputEl) { event.preventDefault(); move(-1); }
        break;
      case 'PageDown':
        event.preventDefault(); move(8); break;
      case 'PageUp':
        event.preventDefault(); move(-8); break;
      case 'Enter':
        event.preventDefault(); choose(); break;
      case 'Escape':
        event.preventDefault(); onCancel(); break;
      case 'Backspace':
      case 'Delete':
        // ⌫ removes a deletable row in a no-filter MENU (where it can't be filter
        // editing) — workspace management. A no-op for filtered pickers.
        if (onDelete && !inputEl) { event.preventDefault(); deleteSelected(); }
        break;
      default:
        break;
    }
  }
  root.addEventListener('keydown', onKeyDown);
  // When no filter input exists, the root itself must catch keys.
  if (!inputEl) root.tabIndex = 0;

  // --- initial paint ---
  recompute();
  renderRows();

  function focus() {
    if (inputEl) inputEl.focus();
    else root.focus();
  }
  // Focus now, then RE-assert on the next frame. A no-filter MENU picker focuses
  // a bare div (there's no <input> to reliably hold focus), and a render that
  // lands right after we mount — the server's snapshot/pane-tree repaint — steals
  // focus back to the editor, killing keyboard nav. Re-grabbing focus next frame
  // wins that race (an <input> picker is unaffected; it just re-focuses itself).
  focus();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);

  return {
    el: root,
    focus,
    destroy() {
      root.removeEventListener('keydown', onKeyDown);
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}
