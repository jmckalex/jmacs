/**
 * @file `<notebook-js-view>` — the JavaScript notebook view.
 *
 * A column of cells. Each cell is a JS code input (`<textarea>`), a run
 * affordance, and an output area that materializes the renderable
 * descriptor produced by running the cell through the engine
 * (`notebook-js-engine.js`) and inspecting its value
 * (`notebook-js-output.js`). v1 is sequential (Jupyter-style): you run a
 * cell on demand; named cell values flow into `cells.<name>` for the
 * cells below it (the named-value map is in place so reactivity can drop
 * in later — design `plans/NOTEBOOK-JS.md` §4).
 *
 * In the flag-off MVP this view is **renderer-resident**: cells eval in
 * the renderer's own context (the facade is built locally), not the
 * server's Node session. The Model-B port (server-side eval) keeps the
 * same view but swaps the local `runCell` for a message round-trip — the
 * engine and descriptors are unchanged. See `architect-notes.md`.
 *
 * Structure mirrors the gnuplot view: a `createNotebookJsView` factory
 * (the live object) wrapped by a `NotebookJsView extends ViewElement`
 * custom element.
 */

import { runCell } from './notebook-js-engine.js';
import { inspect, Inspector } from './notebook-js-output.js';
import { defineViewElement, ViewElement } from './view-elements.js';

// -----------------------------------------------------------------------
// Pure helpers (no DOM) — unit-tested in Node.

let cellSeq = 0;

/**
 * Mint a stable, process-unique cell id.
 * @returns {string}
 */
export function nextCellId() {
  cellSeq += 1;
  return `c${cellSeq}`;
}

/**
 * Build a fresh cell model.
 *
 * @param {{id?: string, name?: string, source?: string}} [init]
 * @returns {{id: string, name: string, source: string, result: null}}
 */
export function makeCell(init = {}) {
  return {
    id: init.id || nextCellId(),
    name: init.name || '',
    source: init.source || '',
    result: null,
  };
}

/**
 * Map a cell result record to a small status badge descriptor (glyph +
 * css class + tooltip). Pure so it's testable without a DOM.
 *
 * @param {{state: string, error?: {message: string}}|null} result
 * @returns {{glyph: string, cls: string, title: string}}
 */
export function badgeForResult(result) {
  if (!result) return { glyph: '◌', cls: 'nbjs-badge-idle', title: 'not run' };
  if (result.state === 'running') {
    return { glyph: '⟳', cls: 'nbjs-badge-running', title: 'running…' };
  }
  if (result.state === 'error') {
    return {
      glyph: '✕',
      cls: 'nbjs-badge-error',
      title: result.error?.message || 'error',
    };
  }
  return { glyph: '●', cls: 'nbjs-badge-ok', title: 'ok' };
}

/**
 * The canonical text serialization of a notebook: cells separated by a
 * fence line. Each cell is `// @cell [name]` then its source. This is the
 * on-disk / buffer form (design §7); a notebook saves its *arrangement*,
 * cell results are runtime-only.
 *
 * @param {Array<{name: string, source: string}>} cells
 * @returns {string}
 */
export function serializeNotebook(cells) {
  return cells
    .map((c) => {
      const header = c.name ? `// @cell ${c.name}` : '// @cell';
      return `${header}\n${c.source}`;
    })
    .join('\n\n');
}

/**
 * Parse the canonical text serialization back into cell models. A line
 * matching `// @cell [name]` starts a new cell; everything until the next
 * such line (or EOF) is that cell's source (trimmed of one trailing
 * blank line). Text before the first fence is ignored. An empty / fence-
 * less source yields a single empty cell so the view is never blank.
 *
 * @param {string} text
 * @returns {Array<{id: string, name: string, source: string, result: null}>}
 */
export function parseNotebook(text) {
  const lines = String(text ?? '').split('\n');
  const cells = [];
  let current = null;
  for (const line of lines) {
    const m = /^\/\/\s*@cell(?:\s+(\S.*))?$/.exec(line);
    if (m) {
      if (current) cells.push(finishCell(current));
      current = { name: (m[1] || '').trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) cells.push(finishCell(current));
  if (cells.length === 0) return [makeCell()];
  return cells;
}

/**
 * @param {{name: string, body: string[]}} c
 * @returns {{id: string, name: string, source: string, result: null}}
 */
function finishCell(c) {
  let body = c.body.join('\n');
  body = body.replace(/^\n+/, '').replace(/\n+$/, '');
  return makeCell({ name: c.name, source: body });
}

// -----------------------------------------------------------------------
// The live view (DOM). Not exercised by the Node unit tests (no jsdom);
// the smoke arm / live verification covers it.

/**
 * Create the notebook view's live object.
 *
 * @param {HTMLElement} container - the host element to mount into.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - chord passthrough.
 * @param {() => boolean} [options.chordPending]
 * @param {object} [options.facade] - extra facade bindings (e.g. `editor`).
 * @param {(text: string) => void} [options.onSourceChange] - mark dirty.
 * @returns {{element: HTMLElement, setBuffer: Function, focus: Function, destroy: Function, applyTheme: Function}}
 */
function createNotebookJsView(container, options = {}) {
  const doc = container.ownerDocument || document;

  /** @type {Array<{id, name, source, result}>} */
  let cells = [makeCell()];
  /** Named-value map shared across cells (the reactivity seam). */
  const namedValues = Object.create(null);
  /** @type {Map<string, object>} cell id → its DOM row handle. */
  const rows = new Map();

  const root = doc.createElement('div');
  root.className = 'nbjs-view';

  const header = doc.createElement('div');
  header.className = 'nbjs-header';
  const headerIcon = doc.createElement('i');
  headerIcon.className = 'fa-solid fa-flask';
  const headerTitle = doc.createElement('span');
  headerTitle.className = 'nbjs-title';
  headerTitle.textContent = 'JavaScript notebook';
  const runAllBtn = doc.createElement('button');
  runAllBtn.className = 'nbjs-run-all';
  runAllBtn.textContent = 'Run all';
  runAllBtn.title = 'Run every cell, top to bottom';
  runAllBtn.addEventListener('click', () => runAll());
  const addBtn = doc.createElement('button');
  addBtn.className = 'nbjs-add-cell';
  addBtn.textContent = '+ Cell';
  addBtn.addEventListener('click', () => {
    const cell = makeCell();
    cells.push(cell);
    renderCell(cell, cellsEl);
    markDirty();
    rows.get(cell.id)?.editor.focus();
  });
  header.append(headerIcon, headerTitle, runAllBtn, addBtn);

  const cellsEl = doc.createElement('div');
  cellsEl.className = 'nbjs-cells';

  root.append(header, cellsEl);
  container.appendChild(root);

  function markDirty() {
    if (typeof options.onSourceChange === 'function') {
      options.onSourceChange(serializeNotebook(cells));
    }
  }

  /** Build the facade for one run (fresh capture state each time). */
  function facadeFor() {
    return {
      ...(options.facade || {}),
      Inspector,
      cells: namedValues,
    };
  }

  /**
   * Run a single cell: run it through the engine, store the result, push
   * its named value into the shared map, and repaint its output region.
   *
   * @param {object} cell
   */
  async function runOne(cell) {
    const row = rows.get(cell.id);
    cell.source = row ? row.editor.value : cell.source;
    cell.result = { state: 'running' };
    paintBadge(cell);
    // Under GODOT_SERVER=1 the cell evaluates in the spine's Node context — the
    // renderer can't (CSP forbids unsafe-eval). The server returns a serializable
    // result with a pre-built `descriptor`. Flag-off falls back to local eval.
    const serverEval =
      typeof window !== 'undefined' ? window.__godotNotebookEval : null;
    const result = serverEval
      ? await serverEval(cell.source)
      : await runCell(cell.source, facadeFor());
    cell.result = result;
    // Cross-cell named values only flow with local eval (the raw value stays in
    // this context); the server sends a descriptor, not the value — deferred.
    if (result.state === 'ok' && cell.name && 'value' in result) {
      namedValues[cell.name] = result.value;
    }
    paintResult(cell);
  }

  /** Run every cell sequentially, top to bottom. */
  async function runAll() {
    for (const cell of cells) {
      // eslint-disable-next-line no-await-in-loop
      await runOne(cell);
    }
  }

  /**
   * Materialize a renderable descriptor into OUT (clearing it first).
   * Element descriptors import-and-mount; svg/html set innerHTML; table/
   * json/text/image build DOM directly.
   *
   * @param {HTMLElement} out
   * @param {object} desc
   */
  function materialize(out, desc) {
    out.textContent = '';
    out.className = 'nbjs-output';
    if (!desc || desc.type === 'empty') {
      out.classList.add('nbjs-output-empty');
      return;
    }
    switch (desc.type) {
      case 'text':
        out.classList.add('nbjs-output-text');
        out.textContent = desc.text;
        break;
      case 'svg':
        out.innerHTML = desc.svg;
        break;
      case 'html':
        out.innerHTML = desc.html;
        break;
      case 'image': {
        const img = doc.createElement('img');
        img.src = desc.dataUrl;
        img.alt = desc.alt || '';
        out.appendChild(img);
        break;
      }
      case 'table':
        out.appendChild(buildTableEl(doc, desc));
        break;
      case 'json':
        out.classList.add('nbjs-output-json');
        out.textContent = safeStringify(desc.value);
        if (desc.truncated) out.appendChild(truncNote(doc));
        break;
      case 'element':
        mountElement(out, desc);
        break;
      default:
        out.textContent = safeStringify(desc);
    }
  }

  /**
   * Import the descriptor's module and mount its custom element into OUT,
   * reusing the element-view transport. Best-effort: a failed import
   * shows the error rather than throwing.
   *
   * @param {HTMLElement} out
   * @param {{tag: string, moduleUrl: string, attrs: object}} desc
   */
  function mountElement(out, desc) {
    import(desc.moduleUrl)
      .then(() => {
        const el = doc.createElement(desc.tag);
        for (const [k, v] of Object.entries(desc.attrs || {})) {
          try {
            el[k] = v;
          } catch {
            el.setAttribute(k, String(v));
          }
        }
        out.appendChild(el);
      })
      .catch((err) => {
        out.classList.add('nbjs-output-error');
        out.textContent = `cannot load ${desc.moduleUrl}: ${err.message}`;
      });
  }

  /** Repaint a cell's status badge only. */
  function paintBadge(cell) {
    const row = rows.get(cell.id);
    if (!row) return;
    const badge = badgeForResult(cell.result);
    row.badge.className = `nbjs-badge ${badge.cls}`;
    row.badge.textContent = badge.glyph;
    row.badge.title = badge.title;
  }

  /** Repaint a cell's badge + logs + output/error after a run. */
  function paintResult(cell) {
    const row = rows.get(cell.id);
    if (!row) return;
    paintBadge(cell);
    const r = cell.result;
    row.logs.textContent = '';
    for (const log of r?.logs || []) {
      const line = doc.createElement('div');
      line.className = `nbjs-log nbjs-log-${log.level}`;
      line.textContent = log.text;
      row.logs.appendChild(line);
    }
    if (r?.state === 'error') {
      row.output.textContent = '';
      row.output.className = 'nbjs-output nbjs-output-error';
      row.output.textContent = `${r.error.name}: ${r.error.message}`;
    } else {
      // Server eval ships a pre-built serializable descriptor; local eval ships
      // the raw value, inspected here. Prefer the server's when present.
      materialize(row.output, r?.descriptor ?? inspect(r?.value));
    }
  }

  /**
   * Build and append a cell's DOM row.
   *
   * @param {object} cell
   * @param {HTMLElement} into
   */
  function renderCell(cell, into) {
    const cellRoot = doc.createElement('div');
    cellRoot.className = 'nbjs-cell';
    cellRoot.dataset.cellId = cell.id;

    const gutter = doc.createElement('div');
    gutter.className = 'nbjs-gutter';
    const badge = doc.createElement('span');
    badge.className = 'nbjs-badge nbjs-badge-idle';
    badge.textContent = '◌';
    const runBtn = doc.createElement('button');
    runBtn.className = 'nbjs-run';
    runBtn.textContent = '▶';
    runBtn.title = 'Run this cell (Shift-Enter)';
    runBtn.addEventListener('click', () => runOne(cell));
    gutter.append(badge, runBtn);

    const body = doc.createElement('div');
    body.className = 'nbjs-cell-body';

    const nameField = doc.createElement('input');
    nameField.className = 'nbjs-name';
    nameField.placeholder = 'name (optional)';
    nameField.value = cell.name;
    nameField.addEventListener('input', () => {
      cell.name = nameField.value.trim();
      markDirty();
    });

    const editor = doc.createElement('textarea');
    editor.className = 'nbjs-editor';
    editor.value = cell.source;
    editor.spellcheck = false;
    editor.rows = Math.max(2, cell.source.split('\n').length);
    editor.addEventListener('input', () => {
      cell.source = editor.value;
      autosize(editor);
      markDirty();
    });
    editor.addEventListener('keydown', (event) => onEditorKeydown(event, cell));

    const logs = doc.createElement('div');
    logs.className = 'nbjs-logs';
    const output = doc.createElement('div');
    output.className = 'nbjs-output nbjs-output-empty';

    body.append(nameField, editor, logs, output);
    cellRoot.append(gutter, body);
    into.appendChild(cellRoot);

    rows.set(cell.id, { root: cellRoot, badge, editor, nameField, logs, output });
    autosize(editor);
  }

  /**
   * Editor keymap: Shift-Enter (and Cmd/Ctrl-Enter) runs the cell;
   * other chords are forwarded to the host so M-x / C-x b still work.
   *
   * @param {KeyboardEvent} event
   * @param {object} cell
   */
  function onEditorKeydown(event, cell) {
    if (event.key === 'Enter' && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      runOne(cell);
      return;
    }
    // Let the host keymap see prefix chords / commands.
    if (typeof options.onKey === 'function') {
      // (the host decides whether to claim it; we don't preventDefault here)
    }
  }

  function setBuffer(next) {
    const text = next?.text ?? next?.buffer?.text ?? '';
    cells = parseNotebook(text);
    cellsEl.textContent = '';
    rows.clear();
    for (const cell of cells) renderCell(cell, cellsEl);
  }

  function focusInput() {
    const first = cells[0] && rows.get(cells[0].id);
    if (first) first.editor.focus();
  }

  function applyTheme() {
    /* faces are CSS-variable driven; nothing imperative needed */
  }

  // Seed the initial empty cell into the DOM.
  for (const cell of cells) renderCell(cell, cellsEl);

  return {
    element: root,
    setBuffer,
    focus: focusInput,
    applyTheme,
    destroy: () => {
      rows.clear();
    },
  };
}

/**
 * Build a `<table>` element from a `table` descriptor.
 *
 * @param {Document} doc
 * @param {{columns: string[], rows: Array<Object>, truncated: boolean, total: number}} desc
 * @returns {HTMLElement}
 */
function buildTableEl(doc, desc) {
  const table = doc.createElement('table');
  table.className = 'nbjs-table';
  const thead = doc.createElement('thead');
  const htr = doc.createElement('tr');
  for (const col of desc.columns) {
    const th = doc.createElement('th');
    th.textContent = col;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  const tbody = doc.createElement('tbody');
  for (const row of desc.rows) {
    const tr = doc.createElement('tr');
    for (const col of desc.columns) {
      const td = doc.createElement('td');
      td.textContent = row[col] ?? '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  if (desc.truncated) {
    const cap = doc.createElement('caption');
    cap.className = 'nbjs-trunc';
    cap.textContent = `showing ${desc.rows.length} of ${desc.total} rows`;
    table.appendChild(cap);
  }
  return table;
}

/**
 * @param {Document} doc
 * @returns {HTMLElement}
 */
function truncNote(doc) {
  const note = doc.createElement('div');
  note.className = 'nbjs-trunc';
  note.textContent = '… (truncated)';
  return note;
}

/**
 * JSON-stringify with indentation, falling back to `String` on failure.
 * @param {*} v
 * @returns {string}
 */
function safeStringify(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Grow a textarea to fit its content (a few lines minimum).
 * @param {HTMLTextAreaElement} editor
 */
function autosize(editor) {
  editor.style.height = 'auto';
  editor.style.height = `${editor.scrollHeight}px`;
}

// -----------------------------------------------------------------------
// `<notebook-js-view>` — custom-element wrapper (mirrors GnuplotView).

/** @typedef {object} NotebookJsViewOptions */

export class NotebookJsView extends ViewElement {
  constructor() {
    super();
    /** @type {ReturnType<typeof createNotebookJsView> | null} */
    this._inner = null;
    /** @type {NotebookJsViewOptions | null} */
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('NotebookJsView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'notebook-js';
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
    this._inner = createNotebookJsView(this, this._options ?? {});
    if (this._pendingBuffer !== null) this._inner.setBuffer(this._pendingBuffer);
  }

  /** Hide-not-kill: a pane→warehouse move fires this; keep state. */
  disconnectedCallback() {
    /* intentionally empty */
  }

  destroy() {
    if (this._inner !== null) {
      this._inner.destroy();
      this._inner = null;
    }
  }
}

defineViewElement('notebook-js-view', NotebookJsView);

export { createNotebookJsView };
