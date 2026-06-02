/**
 * @file The notebook view — a `notebook`-kind buffer is shown through
 * this view as a reactive Lisp notebook. The buffer's text is the
 * canonical source: a sequence of `(cell NAME EXPR)` forms. The view
 * renders one editable cell per form (a name field + a multi-line
 * expression editor + a live result panel + a state badge) and, on every
 * edit, re-serializes the cells, hands the source to the host's reactive
 * engine, and repaints each result from the marshalled records it gets
 * back.
 *
 * This mirrors the gnuplot view's structure (a `createNotebookView`
 * factory + a `NotebookView extends ViewElement` custom-element wrapper)
 * but the interaction model is a *reactive notebook*, not a linear REPL:
 * there is no bottom input line; editing any cell recomputes everything
 * downstream. Evaluation is synchronous and in-process — the host calls
 * the Lisp engine directly — so there's no result-subscription plumbing.
 *
 * The host contract (`options`):
 *   - `evaluate(id, source)` — run the reactive engine for notebook `id`
 *     on `source`; returns a plain array of
 *     `{ name, output, state, error, deps }` (one per cell, source order).
 *   - `onSourceChange(buffer)` — the canonical source changed; the host
 *     marks `buffer` dirty (the view already wrote the new text into
 *     `buffer.text`). Not called on initial load.
 *   - `onKey(key)` / `chordPending()` — chord passthrough so the host
 *     keymap (C-x b, M-x, prefix chords) fires while a cell editor is
 *     focused, exactly like the gnuplot input.
 *
 * View shape (the object passed to `setBuffer`):
 *   { kind: 'notebook', name, notebookId, buffer: { text, filePath? } }
 * The canonical `(cell …)` source lives in `view.buffer.text` so the
 * generic save path (`view.buffer.text` → `view.buffer.filePath`) just
 * works; results live only in the DOM.
 */

import { keyEventToString } from './keymap.js';

// -----------------------------------------------------------------------
// Pure helpers (no DOM) — unit-tested in Node.

/**
 * Split SOURCE into its top-level balanced parenthesised forms, returned
 * as raw substrings. Skips line comments (`;` to end of line) and
 * respects string literals so a `)` or `;` inside a string doesn't end a
 * form early.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function topLevelForms(source) {
  const forms = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === ';') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch !== '(') {
      i++;
      continue;
    }
    const start = i;
    let depth = 0;
    let inStr = false;
    while (i < n) {
      const c = source[i];
      if (inStr) {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') {
        inStr = true;
        i++;
        continue;
      }
      if (c === ';') {
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    forms.push(source.slice(start, i));
  }
  return forms;
}

/**
 * Parse notebook SOURCE into a list of `{ name, expr }` cells, where
 * `expr` is the *raw* expression text (formatting preserved). Non-cell
 * top-level forms are ignored.
 *
 * @param {string} source
 * @returns {{ name: string, expr: string }[]}
 */
export function cellsFromSource(source) {
  const cells = [];
  for (const form of topLevelForms(source)) {
    const inner = form.slice(1, -1).trim();
    const m = /^cell\s+([^\s()"]+)\s+([\s\S]+)$/.exec(inner);
    if (m) cells.push({ name: m[1], expr: m[2].trim() });
  }
  return cells;
}

/**
 * Serialize a list of `{ name, expr }` cells back into canonical
 * notebook source — `(cell NAME EXPR)` forms, blank-separated. Cells
 * with an empty name or expression are dropped (they aren't yet real
 * cells).
 *
 * @param {{ name: string, expr: string }[]} cells
 * @returns {string}
 */
export function serializeCells(cells) {
  return cells
    .map((c) => ({ name: String(c.name ?? '').trim(), expr: String(c.expr ?? '').trim() }))
    .filter((c) => c.name !== '' && c.expr !== '')
    .map((c) => `(cell ${c.name} ${c.expr})`)
    .join('\n\n');
}

/**
 * Decide whether a keydown in a cell editor should be forwarded to the
 * host keymap rather than handled as text input. Forward only chord keys
 * (Ctrl/Alt held) and any key while a prefix chord is mid-flight; never a
 * bare modifier. Mirrors the gnuplot input's rule so plain typing,
 * Backspace and the arrows stay local.
 *
 * @param {KeyboardEvent} event
 * @param {() => boolean} chordPending
 * @returns {boolean}
 */
export function shouldForwardChord(event, chordPending) {
  const bareModifier =
    event.key === 'Shift' ||
    event.key === 'Control' ||
    event.key === 'Alt' ||
    event.key === 'Meta';
  if (bareModifier) return false;
  const pending = typeof chordPending === 'function' ? chordPending() : false;
  return pending || event.ctrlKey || event.altKey;
}

/**
 * Move the item at INDEX by DELTA positions, returning a new array. A
 * move that would fall off either end returns an unchanged copy.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} index
 * @param {number} delta
 * @returns {T[]}
 */
export function moveItem(arr, index, delta) {
  const next = arr.slice();
  const j = index + delta;
  if (index < 0 || index >= arr.length || j < 0 || j >= arr.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(j, 0, item);
  return next;
}

/**
 * The badge glyph + class for a cell state. A cycle is an error whose
 * message starts with "cycle" — it gets its own glyph so the user can
 * tell a dependency loop from an ordinary runtime error.
 *
 * @param {string} state - 'ok' | 'stale' | 'error'
 * @param {string} [error]
 * @returns {{ glyph: string, cls: string, title: string }}
 */
export function badgeForState(state, error = '') {
  if (state === 'error') {
    if (typeof error === 'string' && error.startsWith('cycle')) {
      return { glyph: '⟳', cls: 'notebook-badge-cycle', title: error };
    }
    return { glyph: '✕', cls: 'notebook-badge-error', title: error || 'error' };
  }
  if (state === 'stale') {
    return { glyph: '◌', cls: 'notebook-badge-stale', title: 'not yet evaluated' };
  }
  return { glyph: '●', cls: 'notebook-badge-ok', title: 'ok' };
}

// -----------------------------------------------------------------------
// The DOM factory.

/**
 * Create a reactive notebook view.
 *
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {(id: string, source: string) => Array<{name:string,output:string,state:string,error:string,deps:string[]}>} [options.evaluate]
 * @param {(text: string) => void} [options.onSourceChange]
 * @param {(key: string) => boolean} [options.onKey]
 * @param {() => boolean} [options.chordPending]
 * @returns {{ element: HTMLElement, setBuffer: Function, focus: Function, destroy: Function, applyTheme: Function }}
 */
function createNotebookView(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const evaluateFn = typeof options.evaluate === 'function' ? options.evaluate : null;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const chordPending =
    typeof options.chordPending === 'function' ? options.chordPending : () => false;
  const onSourceChange =
    typeof options.onSourceChange === 'function' ? options.onSourceChange : null;

  const root = doc.createElement('div');
  root.className = 'notebook-view';
  root.tabIndex = -1;
  container.append(root);

  // Header: an icon + the notebook name + an "add cell" button.
  const header = doc.createElement('div');
  header.className = 'notebook-header';
  const headerIcon = doc.createElement('i');
  headerIcon.className = 'fa-solid fa-table-cells';
  const headerLabel = doc.createElement('span');
  headerLabel.className = 'notebook-header-label';
  headerLabel.textContent = 'notebook';
  const addBtn = doc.createElement('button');
  addBtn.className = 'notebook-add-cell';
  addBtn.type = 'button';
  addBtn.textContent = '+ cell';
  addBtn.title = 'Add a cell';
  addBtn.addEventListener('click', () => {
    const cell = addCell({ name: '', expr: '' }, true);
    cell.nameInput.focus();
  });
  header.append(headerIcon, headerLabel, addBtn);
  root.append(header);

  // The column of cells.
  const cellsEl = doc.createElement('div');
  cellsEl.className = 'notebook-cells';
  root.append(cellsEl);

  /** The view currently shown, or null. Its `buffer.text` is the
   *  canonical source; `notebookId` keys the engine. */
  let view = null;
  /** Cell records: { root, nameInput, exprInput, resultEl, badgeEl }. */
  const cells = [];

  /** Resize a textarea to fit its content. */
  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }

  /** The current `{ name, expr }` model, in source order. */
  function readModel() {
    return cells.map((c) => ({ name: c.nameInput.value, expr: c.exprInput.value }));
  }

  /** Debounced recompute so typing stays smooth. */
  let recomputeTimer = null;
  function scheduleRecompute() {
    if (recomputeTimer) win.clearTimeout(recomputeTimer);
    recomputeTimer = win.setTimeout(() => {
      recomputeTimer = null;
      recompute(true);
    }, 150);
  }

  /**
   * Serialize, optionally mirror the source into the buffer (marking it
   * dirty), evaluate through the host engine, and repaint results.
   *
   * @param {boolean} markDirty - false on the initial load so opening a
   *   notebook doesn't mark it modified.
   */
  function recompute(markDirty) {
    const source = serializeCells(readModel());
    // Always mirror the canonical source into the backing buffer so a
    // save captures exactly what's shown (including the seeded starter
    // cells of a brand-new notebook). Only mark the buffer *dirty* on a
    // real edit — never on the initial load.
    if (view && view.buffer) view.buffer.text = source;
    if (markDirty && onSourceChange && view && view.buffer) {
      onSourceChange(view.buffer);
    }
    if (!evaluateFn || !view) return;
    let results = null;
    try {
      results = evaluateFn(view.notebookId, source);
    } catch {
      results = null;
    }
    applyResults(Array.isArray(results) ? results : []);
  }

  /** Match each cell to its result by name and repaint. */
  function applyResults(results) {
    const byName = new Map();
    for (const r of results) byName.set(r.name, r);
    for (const cell of cells) {
      const name = cell.nameInput.value.trim();
      const r = name === '' ? null : byName.get(name);
      if (!r) {
        setCellState(cell, 'stale', '', '');
      } else {
        setCellState(cell, r.state, r.output, r.error);
      }
    }
  }

  /** Paint a cell's badge + result panel for a state. */
  function setCellState(cell, state, output, error) {
    const badge = badgeForState(state, error);
    cell.badgeEl.textContent = badge.glyph;
    cell.badgeEl.className = `notebook-badge ${badge.cls}`;
    cell.badgeEl.title = badge.title;
    cell.root.dataset.state = state;
    cell.resultEl.textContent = output ? `→ ${output}` : '';
  }

  /** Handle a keydown in a cell's name/expr editor. */
  function onEditorKeydown(event, cell) {
    // Enter commits (forces an immediate recompute); Shift-Enter is a
    // newline in the textarea (left to the platform).
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      if (recomputeTimer) {
        win.clearTimeout(recomputeTimer);
        recomputeTimer = null;
      }
      recompute(true);
      return;
    }
    // M-↑ / M-↓ reorder the cell among its siblings.
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      moveCell(cell, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    // Forward editor chords (C-x b, M-x, prefix continuations) to the
    // host keymap; keep plain typing / arrows / Backspace local.
    if (onKey && shouldForwardChord(event, chordPending)) {
      const key = keyEventToString(event);
      if (key && onKey(key)) event.preventDefault();
    }
  }

  /** Remove a cell and recompute. */
  function removeCell(cell) {
    const idx = cells.indexOf(cell);
    if (idx === -1) return;
    cells.splice(idx, 1);
    cell.root.remove();
    recompute(true);
  }

  /** Move a cell up (-1) or down (+1) in source order, reflecting the new
   *  order in the DOM, and recompute. */
  function moveCell(cell, delta) {
    const i = cells.indexOf(cell);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= cells.length) return;
    const reordered = moveItem(cells, i, delta);
    cells.length = 0;
    cells.push(...reordered);
    // Re-appending each root in the new order moves them in the DOM.
    for (const c of cells) cellsEl.append(c.root);
    cell.exprInput.focus();
    recompute(true);
  }

  /**
   * Build a cell element from an initial `{ name, expr }` and append it.
   *
   * @param {{ name?: string, expr?: string }} init
   * @returns {object} the cell record
   */
  function addCell(init = {}, _focus = false) {
    const cellRoot = doc.createElement('div');
    cellRoot.className = 'notebook-cell';
    cellRoot.dataset.state = 'stale';

    const gutter = doc.createElement('div');
    gutter.className = 'notebook-cell-gutter';
    const badgeEl = doc.createElement('span');
    badgeEl.className = 'notebook-badge notebook-badge-stale';
    badgeEl.textContent = '◌';
    gutter.append(badgeEl);

    const body = doc.createElement('div');
    body.className = 'notebook-cell-body';

    const nameInput = doc.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'notebook-cell-name';
    nameInput.spellcheck = false;
    nameInput.setAttribute('autocomplete', 'off');
    nameInput.placeholder = 'name';
    nameInput.value = init.name ?? '';

    const exprInput = doc.createElement('textarea');
    exprInput.className = 'notebook-cell-expr';
    exprInput.spellcheck = false;
    exprInput.rows = 1;
    exprInput.placeholder = 'expression';
    exprInput.value = init.expr ?? '';

    const resultEl = doc.createElement('div');
    resultEl.className = 'notebook-cell-result';

    body.append(nameInput, exprInput, resultEl);

    const del = doc.createElement('button');
    del.className = 'notebook-cell-delete';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Delete cell';

    cellRoot.append(gutter, body, del);
    cellsEl.append(cellRoot);

    const cell = { root: cellRoot, nameInput, exprInput, resultEl, badgeEl };

    const onInput = () => {
      autosize(exprInput);
      cell.root.dataset.state = 'stale';
      badgeEl.textContent = '◌';
      badgeEl.className = 'notebook-badge notebook-badge-stale';
      scheduleRecompute();
    };
    nameInput.addEventListener('input', onInput);
    exprInput.addEventListener('input', onInput);
    nameInput.addEventListener('keydown', (e) => onEditorKeydown(e, cell));
    exprInput.addEventListener('keydown', (e) => onEditorKeydown(e, cell));
    del.addEventListener('click', () => removeCell(cell));

    cells.push(cell);
    autosize(exprInput);
    return cell;
  }

  /** Show a notebook view: rebuild the cells from its source. */
  function setBuffer(next) {
    view = next;
    cells.length = 0;
    cellsEl.replaceChildren();
    if (!view) {
      headerLabel.textContent = 'notebook';
      return;
    }
    headerLabel.textContent = view.name ?? 'notebook';
    const source =
      view.buffer && typeof view.buffer.text === 'string' ? view.buffer.text : '';
    const parsed = cellsFromSource(source);
    const seed = parsed.length
      ? parsed
      : [
          { name: 'x', expr: '3' },
          { name: 'y', expr: "(* (ref 'x) 4)" },
        ];
    for (const c of seed) addCell(c, false);
    // Evaluate once to fill in results, without marking the buffer dirty.
    recompute(false);
  }

  /** Focus the first cell's expression editor. */
  function focusInput() {
    const first = cells[0];
    if (first) first.exprInput.focus();
    else root.focus();
  }

  /** Nothing theme-specific to recompute; kept for the view interface. */
  function applyTheme() {
    /* no-op */
  }

  return {
    element: root,
    setBuffer,
    focus: focusInput,
    applyTheme,
    destroy: () => {
      if (recomputeTimer) {
        win.clearTimeout(recomputeTimer);
        recomputeTimer = null;
      }
      cells.length = 0;
    },
  };
}

// -----------------------------------------------------------------------
// `<notebook-view>` — custom-element wrapper. Per-view-instance (you can
// have several notebooks open at once), so unlike the singleton kinds
// each tab/leaf gets its own element. Hide-not-kill like the other
// custom-element views: a pane move fires `disconnectedCallback` but the
// in-memory cell state must survive, so only `destroy()` tears down.

import { defineViewElement, ViewElement } from './view-elements.js';

export class NotebookView extends ViewElement {
  constructor() {
    super();
    this._inner = null;
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('NotebookView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'notebook';
  }

  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    if (this._inner !== null) this._inner.setBuffer(buffer);
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
    this._inner = createNotebookView(this, this._options ?? {});
    if (this._pendingBuffer !== null) this._inner.setBuffer(this._pendingBuffer);
  }

  /** Hide-not-kill: a DOM move fires this; the cell state stays. */
  disconnectedCallback() {
    /* intentionally empty */
  }

  destroy() {
    if (this._inner !== null) {
      this._inner.destroy();
      this._inner = null;
    }
    this._pendingBuffer = null;
  }
}

defineViewElement('notebook-view', NotebookView);
