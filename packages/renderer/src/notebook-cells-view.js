/**
 * @file `<notebook-cells-view>` — the Architecture-A cell notebook view.
 *
 * Where `<notebook-js-view>` is a column of `<textarea>` cells, this view
 * renders ALL cells in ONE real editor over a single unified buffer
 * (`notebook-cells.js`): one tree-sitter parse, the windowed renderer, full
 * highlighting and editing — the cells ARE the editor. Per-cell chrome (a
 * header bar with a Run button, and an output region) is drawn through the
 * existing block-replaced-range / widget layer (`math-layout.js`,
 * `view.js` `getReplacedRanges`) that math preview already uses: each cell's
 * scaffolding lines (`{` / `}`, the language adapter's wrappers) are replaced
 * by — and so hidden behind — a block widget anchored at that line. The
 * widget's measured height feeds the renderer's per-key rowSpan cache, so
 * outputs and headers auto-size with no new renderer machinery.
 *
 * The unified buffer is renderer-LOCAL (an `@editor/buffer` buffer the view
 * owns) — "the client owns the cell model" (plans/NOTEBOOK-ENV.md §11.1).
 * Editing is self-driven (no `onKey` → the editor's built-in keymap), so it
 * works identically flag-on and flag-off. Only *evaluation* differs:
 * `window.__godotNotebookEval` (the spine's Node session under GODOT_SERVER=1)
 * when present, else the renderer-local `runCell` (flag-off) — exactly the
 * `notebook-js` round-trip, reused.
 *
 * Cell content is tracked with two edit-riding markers per cell (content
 * start + the close-scaffold `}`); cell *source* is read live from the
 * buffer between them, so typing never needs a model write. Structural ops
 * (add cell) go through the `notebook-cells.js` document and rebuild the
 * buffer + markers.
 *
 * v1 scope: JavaScript code cells (the substrate made real). Typed cells
 * (heading/text/output) with prose-as-comments + group folds are the
 * follow-on (plans/NOTEBOOK-ENV.md P1+).
 */

import { createBuffer } from '@editor/buffer';
import { createNotebookDocument, NOTEBOOK_ADAPTERS } from './notebook-cells.js';
import { inspect, Inspector } from './notebook-js-output.js';
import { runCell } from './notebook-js-engine.js';
import { badgeForResult, serializeNotebook, parseNotebook } from './notebook-js-view.js';
import { defineViewElement, ViewElement } from './view-elements.js';

/** The cells a fresh notebook opens with — a tiny worked example that shows
 *  CROSS-CELL state: a cell's top-level `const`/`function` declarations persist
 *  to later cells in the same notebook (Jupyter-style), via a persistent
 *  per-notebook scope on the server (plans/NOTEBOOK-ENV.md §4.3, §11). */
const SAMPLE_CELLS = [
  'const xs = [1, 2, 3, 4, 5];\nconst total = xs.reduce((a, b) => a + b, 0);\ntotal',
  '// `xs` and `total` carry over from the cell above (Shift-Enter):\nxs.map((x) => ({ x, scaled: x * total }))',
];

/** Process-unique notebook session ids (key a notebook's shared scope). */
let notebookSessionSeq = 0;

// -----------------------------------------------------------------------
// The live view (DOM). Not exercised by the Node unit tests (no jsdom); the
// model it sits on (`notebook-cells.js`) is unit-tested, and the live
// surface is covered by manual / smoke verification.

/**
 * Create the notebook-cells view's live object.
 *
 * @param {HTMLElement} container - the host element to mount into.
 * @param {object} [options]
 * @param {object} [options.facade] - extra facade bindings for local eval.
 * @returns {{element: HTMLElement, setBuffer: Function, focus: Function, destroy: Function, applyTheme: Function}}
 */
function createNotebookCellsView(container, options = {}) {
  const ownerDoc = container.ownerDocument || document;

  // The cell model (structure) and the unified buffer (live content). The
  // buffer is named `*.js` so the editor highlights it as JavaScript.
  const model = createNotebookDocument(NOTEBOOK_ADAPTERS.javascript);
  const buffer = createBuffer('', { name: '*notebook*.js' });

  /**
   * Per-cell runtime state, kept ALIGNED with `model` cell order.
   * @type {Array<{
   *   id: string,
   *   result: object|null,
   *   version: number,
   *   startMarker: {offset: number, remove: Function}|null,
   *   endMarker: {offset: number, remove: Function}|null,
   *   headerNode: HTMLElement|null, headerVersion: number,
   *   outputNode: HTMLElement|null, outputVersion: number,
   * }>}
   */
  let cells = [];
  /** Shared named-value map (local-eval only; the seam for reactivity). */
  const namedValues = Object.create(null);
  // This notebook's identity for cross-cell state. The server keeps a
  // persistent shared scope keyed by `sessionId`; the flag-off local path
  // uses `localScope` directly. A cell's top-level `const`/`function` decls
  // flow to later cells in THIS notebook (and only this one).
  notebookSessionSeq += 1;
  const sessionId = `notebook-cells-${notebookSessionSeq}-${Date.now()}`;
  const localScope = Object.create(null);
  /** The file this notebook was last saved to / opened from (null = unsaved). */
  let savedPath = null;
  /** Monotonic evaluation counter — a cell's `In[n]` is the n at the moment it
   *  was last RUN (Mathematica semantics), not its position. Re-running a cell
   *  gives it a new, higher number. */
  let execCounter = 0;

  const root = ownerDoc.createElement('div');
  root.className = 'nbc-view';

  // A thin top toolbar so structural ops don't depend on keyboard chords
  // (the view runs under :keyboard 'off' — editing keys stay with the
  // embedded editor, command chords bubble to the host router).
  const toolbar = ownerDoc.createElement('div');
  toolbar.className = 'nbc-toolbar';
  const tIcon = ownerDoc.createElement('i');
  tIcon.className = 'fa-solid fa-table-cells nbc-toolbar-icon';
  const tTitle = ownerDoc.createElement('span');
  tTitle.className = 'nbc-toolbar-title';
  tTitle.textContent = 'Notebook';
  const mkToolbarBtn = (label, title, onClick) => {
    const b = ownerDoc.createElement('button');
    b.className = 'nbc-toolbar-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };
  const openBtn = mkToolbarBtn('Open', 'Open a notebook file', () => openNotebook());
  const saveBtn = mkToolbarBtn('Save', 'Save this notebook to a file', () => saveNotebook());
  const runAllBtn = mkToolbarBtn('Run all', 'Run every cell, top to bottom', () => runAll());
  const addBtn = mkToolbarBtn('+ Cell', 'Append a new cell', () => addCell());
  toolbar.append(tIcon, tTitle, openBtn, saveBtn, runAllBtn, addBtn);
  root.appendChild(toolbar);

  /** Reflect the saved file name in the toolbar title. */
  function updateTitle() {
    tTitle.textContent = savedPath ? savedPath.split('/').pop() : 'Notebook';
  }

  // The embedded editor. No `onKey`, so the editor's built-in keymap drives
  // editing/motion; our own listeners (below) claim Shift-Enter and guard
  // the cursor off scaffolding lines.
  const hl = (typeof window !== 'undefined' && window.__godotHighlighters) || {};
  const editor = /** @type {*} */ (ownerDoc.createElement('text-view'));
  editor.configure({
    highlighters: hl.highlighters || {},
    foldCaptures: hl.foldCaptures || {},
    getTabWidth: () => 4,
    colourSwatches: false,
    // No sticky structure headers: they'd pin each cell's wrapper `{` at the
    // top of the viewport (the brace the chrome widget is meant to hide).
    stickyHeaderLanguages: [],
    getReplacedRanges,
  });
  editor.setBuffer(buffer);
  root.appendChild(editor);
  container.appendChild(root);

  /** Ask the editor to repaint (no buffer edit happened — e.g. a run result). */
  function refresh() {
    if (typeof editor.refresh === 'function') editor.refresh();
  }

  // -------------------------------------------------------------------
  // Buffer <-> model plumbing.

  /** The live source of a cell, read straight from the buffer between its
   *  markers (content + the trailing newline before `}`, which we drop). */
  function cellSource(cell) {
    if (!cell.startMarker || !cell.endMarker) return '';
    const text = buffer.text;
    const raw = text.slice(cell.startMarker.offset, cell.endMarker.offset);
    return raw.replace(/\n$/, '');
  }

  /** Push every cell's live buffer source back into the model (before a
   *  structural op that regenerates the unified text). */
  function syncModelFromBuffer() {
    for (const cell of cells) model.setContent(cell.id, cellSource(cell));
  }

  /** Regenerate the unified buffer from the model and re-anchor each cell's
   *  edit-riding markers. Runtime state (result/version/cached nodes)
   *  persists on the runtime cell objects. */
  function rebuildBufferFromModel() {
    for (const cell of cells) {
      cell.startMarker?.remove();
      cell.endMarker?.remove();
      cell.startMarker = null;
      cell.endMarker = null;
    }
    buffer.setText(model.unifiedText());
    for (const cell of cells) {
      const range = model.cellLineRange(cell.id);
      if (!range) continue;
      const [startLine, endLine] = range; // content [start, end); `}` at endLine
      cell.startMarker = buffer.createMarker(buffer.offsetAt(startLine, 0));
      cell.endMarker = buffer.createMarker(buffer.offsetAt(endLine, 0));
      // A structural change can shift this cell's index — force its header to
      // rebuild so the In[n] label is correct (output cache is left intact).
      cell.headerVersion = -1;
    }
  }

  /** Current line geometry of every cell, derived from its live markers.
   *  Skips cells whose markers aren't anchored yet (defensive: a render
   *  could fire between setText and marker re-creation in a rebuild). */
  function cellLines() {
    const out = [];
    for (const cell of cells) {
      if (!cell.startMarker || !cell.endMarker) continue;
      const contentStart = buffer.positionAt(cell.startMarker.offset).line;
      const closeLine = buffer.positionAt(cell.endMarker.offset).line;
      if (contentStart < 1) continue; // need the `{` scaffolding line above
      out.push({ cell, openLine: contentStart - 1, contentStart, contentEnd: closeLine - 1, closeLine });
    }
    return out;
  }

  /** Content length (no newline) of buffer line L. */
  function lineLength(line) {
    const from = buffer.offsetAt(line, 0);
    const to = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1, 0) - 1 : buffer.text.length;
    return Math.max(0, to - from);
  }

  // -------------------------------------------------------------------
  // Replaced ranges: a header block over each cell's `{` line, an output
  // block over its `}` line. Both start at column 0, so the renderer shows
  // no source prefix — the scaffolding char is fully hidden behind the
  // widget. Stable `key`s let the renderer cache each widget's measured
  // height (auto-sizing outputs).

  function getReplacedRanges() {
    const ranges = [];
    for (const info of cellLines()) {
      const openStart = buffer.offsetAt(info.openLine, 0);
      ranges.push({
        start: openStart,
        end: openStart + Math.max(1, lineLength(info.openLine)),
        kind: 'block',
        key: `nbc-hdr:${info.cell.id}`,
        el: () => headerWidget(info.cell),
      });
      const closeStart = buffer.offsetAt(info.closeLine, 0);
      ranges.push({
        start: closeStart,
        end: closeStart + Math.max(1, lineLength(info.closeLine)),
        kind: 'block',
        key: `nbc-out:${info.cell.id}`,
        el: () => outputWidget(info.cell),
      });
    }
    return ranges;
  }

  /** The header bar widget for a cell (cached per content version). */
  function headerWidget(cell) {
    if (cell.headerNode && cell.headerVersion === cell.version) return cell.headerNode;
    const el = ownerDoc.createElement('div');
    el.className = 'nbc-header';
    // Don't let a click on the chrome trigger the widget-reveal mousedown
    // (which would drop the cursor onto the hidden scaffolding line).
    el.addEventListener('mousedown', (e) => e.stopPropagation());

    const badge = ownerDoc.createElement('span');
    const b = badgeForResult(cell.result);
    badge.className = `nbc-badge ${b.cls}`;
    badge.textContent = b.glyph;
    badge.title = b.title;

    const label = ownerDoc.createElement('span');
    label.className = 'nbc-label';
    // The evaluation index (Mathematica's In[n]); blank until the cell is run.
    label.textContent = `In[${cell.execCount != null ? cell.execCount : ' '}]`;

    const mkBtn = (cls, text, title, onClick) => {
      const btn = ownerDoc.createElement('button');
      btn.className = cls;
      btn.textContent = text;
      btn.title = title;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return btn;
    };
    // Jupyter-style per-cell inserts, to the left of Run.
    const addAbove = mkBtn('nbc-cell-add', '+↑', 'Insert cell above', () =>
      addCell(cells.indexOf(cell), '')
    );
    const addBelow = mkBtn('nbc-cell-add', '+↓', 'Insert cell below', () =>
      addCell(cells.indexOf(cell) + 1, '')
    );
    const run = mkBtn('nbc-run', '▶ Run', 'Run this cell (Shift-Enter)', () => runOne(cell));

    el.append(badge, label, addAbove, addBelow, run);
    cell.headerNode = el;
    cell.headerVersion = cell.version;
    return el;
  }

  /** The output region widget for a cell (cached per content version). */
  function outputWidget(cell) {
    if (cell.outputNode && cell.outputVersion === cell.version) return cell.outputNode;
    const el = ownerDoc.createElement('div');
    el.className = 'nbc-output';
    el.addEventListener('mousedown', (e) => e.stopPropagation());

    const r = cell.result;
    if (!r) {
      el.classList.add('nbc-output-empty');
    } else if (r.state === 'running') {
      el.classList.add('nbc-output-running');
      el.textContent = '↻ running…';
    } else if (r.state === 'error') {
      el.classList.add('nbc-output-error');
      el.textContent = r.error ? `${r.error.name}: ${r.error.message}` : 'error';
    } else {
      for (const log of r.logs || []) {
        const line = ownerDoc.createElement('div');
        line.className = `nbc-log nbc-log-${log.level}`;
        line.textContent = log.text;
        el.appendChild(line);
      }
      const result = ownerDoc.createElement('div');
      result.className = 'nbc-result';
      // Server eval ships a pre-built descriptor; local eval ships the raw
      // value (inspected here). Prefer the server's when present.
      materialize(result, r.descriptor ?? inspect(r.value));
      el.appendChild(result);
    }
    cell.outputNode = el;
    cell.outputVersion = cell.version;
    return el;
  }

  // -------------------------------------------------------------------
  // Output materialization. A focused copy of the `notebook-js-view`
  // switch, kept local so the shipped flat notebook is untouched (v1);
  // consolidate when notebook-js is next refactored (NOTEBOOK-ENV.md §16).

  function materialize(out, desc) {
    out.textContent = '';
    if (!desc || desc.type === 'empty') return;
    switch (desc.type) {
      case 'text':
        out.classList.add('nbc-result-text');
        out.textContent = desc.text;
        break;
      case 'svg':
        out.innerHTML = desc.svg;
        break;
      case 'html':
        out.innerHTML = desc.html;
        break;
      case 'image': {
        const img = ownerDoc.createElement('img');
        img.src = desc.dataUrl;
        img.alt = desc.alt || '';
        out.appendChild(img);
        break;
      }
      case 'table':
        out.appendChild(buildTableEl(ownerDoc, desc));
        break;
      case 'json':
        out.classList.add('nbc-result-json');
        out.textContent = safeStringify(desc.value);
        if (desc.truncated) out.appendChild(truncNote(ownerDoc));
        break;
      case 'element':
        mountElement(out, desc);
        break;
      default:
        out.textContent = safeStringify(desc);
    }
  }

  function mountElement(out, desc) {
    import(desc.moduleUrl)
      .then(() => {
        const el = ownerDoc.createElement(desc.tag);
        for (const [k, v] of Object.entries(desc.attrs || {})) {
          try {
            el[k] = v;
          } catch {
            el.setAttribute(k, String(v));
          }
        }
        out.appendChild(el);
        refresh(); // height changed after the async mount
      })
      .catch((err) => {
        out.classList.add('nbc-output-error');
        out.textContent = `cannot load ${desc.moduleUrl}: ${err.message}`;
        refresh();
      });
  }

  // -------------------------------------------------------------------
  // Evaluation — reuse the notebook-js round-trip.

  function facadeFor() {
    return { ...(options.facade || {}), Inspector, cells: namedValues };
  }

  async function runOne(cell) {
    const source = cellSource(cell);
    // Stamp the evaluation index now (run start), like Mathematica's In[n].
    execCounter += 1;
    cell.execCount = execCounter;
    cell.result = { state: 'running' };
    cell.version += 1;
    refresh();

    const serverEval = typeof window !== 'undefined' ? window.__godotNotebookEval : null;
    let result;
    try {
      // Server eval: the spine keeps this notebook's shared scope by sessionId.
      // Flag-off local eval: pass the renderer-side persistent scope directly.
      result = serverEval
        ? await serverEval(source, sessionId)
        : await runCell(source, facadeFor(), { scope: localScope });
    } catch (err) {
      result = {
        state: 'error',
        descriptor: { type: 'empty' },
        logs: [],
        error: { name: 'Error', message: String((err && err.message) || err), stack: '' },
      };
    }
    cell.result = result;
    cell.version += 1;
    // Cross-cell named values only flow with local eval (the server sends a
    // descriptor, not the raw value) — the reactivity seam, deferred.
    if (result.state === 'ok' && 'value' in result) {
      /* named-value wiring is a P3 concern (server eval session) */
    }
    refresh();
  }

  async function runAll() {
    for (const cell of cells) {
      // eslint-disable-next-line no-await-in-loop
      await runOne(cell);
    }
  }

  // -------------------------------------------------------------------
  // Structural ops.

  /** Append a fresh runtime cell aligned to a model cell id. */
  function makeRuntimeCell(id) {
    return {
      id,
      result: null,
      version: 0,
      execCount: null, // the In[n] stamped at last run; null until run
      startMarker: null,
      endMarker: null,
      headerNode: null,
      headerVersion: -1,
      outputNode: null,
      outputVersion: -1,
    };
  }

  /** Add a cell after ATINDEX (default: end) and move the cursor into it. */
  function addCell(atIndex = cells.length, content = '') {
    syncModelFromBuffer();
    const id = model.addCell(content, atIndex);
    cells.splice(atIndex, 0, makeRuntimeCell(id));
    rebuildBufferFromModel();
    const range = model.cellLineRange(id);
    if (range) buffer.moveTo(buffer.offsetAt(range[0], 0));
    refresh();
  }

  /** Remove a cell. */
  function removeCell(cell) {
    const i = cells.indexOf(cell);
    if (i === -1) return;
    syncModelFromBuffer();
    cell.startMarker?.remove();
    cell.endMarker?.remove();
    model.removeCell(cell.id);
    cells.splice(i, 1);
    rebuildBufferFromModel();
    refresh();
  }

  /** Replace ALL cells with a list of source strings (used by Open/load). */
  function loadCells(sources) {
    for (const cell of cells) {
      cell.startMarker?.remove();
      cell.endMarker?.remove();
    }
    for (const id of model.cellIds()) model.removeCell(id);
    cells = [];
    const list = sources && sources.length ? sources : [''];
    for (const src of list) {
      const id = model.addCell(src);
      cells.push(makeRuntimeCell(id));
    }
    rebuildBufferFromModel();
    if (cells[0]) {
      const range = model.cellLineRange(cells[0].id);
      if (range) buffer.moveTo(buffer.offsetAt(range[0], 0));
    }
    refresh();
  }

  // -------------------------------------------------------------------
  // Persistence. The notebook serialises to the same `// @cell` fenced text
  // the flat JS notebook uses, so the two interchange; cell *outputs* are
  // runtime-only (recomputed on open), matching notebook-js.

  async function saveNotebook() {
    if (typeof window === 'undefined' || !window.host || typeof window.host.saveFile !== 'function') {
      return;
    }
    const text = serializeNotebook(cells.map((c) => ({ name: '', source: cellSource(c) })));
    let result = await window.host.saveFile(savedPath || null, text);
    if (result && result.conflict) {
      result = await window.host.saveFile(result.path, text, { force: true });
    }
    if (result && result.path) {
      savedPath = result.path;
      updateTitle();
    }
  }

  async function openNotebook() {
    if (typeof window === 'undefined' || !window.host || typeof window.host.openFile !== 'function') {
      return;
    }
    const result = await window.host.openFile();
    if (!result || typeof result.content !== 'string') return;
    loadCells(parseNotebook(result.content).map((c) => c.source));
    savedPath = result.path || null;
    updateTitle();
  }

  // -------------------------------------------------------------------
  // Focus + the scaffold edit-guard.

  /** The cell whose content range contains the cursor (or null). */
  function focusedCell() {
    const line = buffer.positionAt(buffer.point).line;
    for (const info of cellLines()) {
      if (line >= info.contentStart && line <= info.contentEnd) return info.cell;
    }
    return cells[0] || null;
  }

  /** Keep the cursor off scaffolding lines: if it lands on a `{` / `}`
   *  line, snap it to the nearest content line in the travel direction. */
  function guardCursor(direction) {
    const info = cellLines();
    const scaffold = new Set();
    for (const i of info) {
      scaffold.add(i.openLine);
      scaffold.add(i.closeLine);
    }
    const line = buffer.positionAt(buffer.point).line;
    if (!scaffold.has(line)) return;
    if (direction >= 0) {
      for (const i of info) {
        if (i.contentStart >= line) {
          buffer.moveTo(buffer.offsetAt(i.contentStart, 0));
          return;
        }
      }
      const last = info[info.length - 1];
      if (last) buffer.moveTo(Math.max(0, last.cell.endMarker.offset - 1));
    } else {
      for (let k = info.length - 1; k >= 0; k -= 1) {
        if (info[k].contentEnd <= line) {
          buffer.moveTo(Math.max(0, info[k].cell.endMarker.offset - 1));
          return;
        }
      }
      const first = info[0];
      if (first) buffer.moveTo(buffer.offsetAt(first.contentStart, 0));
    }
  }

  const BACKWARD_KEYS = new Set(['ArrowUp', 'ArrowLeft', 'Backspace', 'PageUp', 'Home']);

  // Capture phase: claim Shift/Cmd/Ctrl-Enter (run) before the editor's own
  // keydown turns it into a newline.
  root.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' && (event.shiftKey || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        const cell = focusedCell();
        if (cell) runOne(cell);
      }
    },
    true
  );

  // Bubble phase: the editor has processed the key (cursor/markers updated);
  // snap off any scaffolding line and repaint.
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.shiftKey || event.metaKey || event.ctrlKey)) return;
    guardCursor(BACKWARD_KEYS.has(event.key) ? -1 : 1);
    refresh();
  });

  // -------------------------------------------------------------------
  // Lifecycle.

  function setBuffer() {
    // v1 owns its content (seeded below). Persisting/loading a `.gnb` file
    // into the cell model is a follow-on; the host buffer is ignored here.
  }

  function focus() {
    editor.focus();
    // Never rest focus on a scaffolding line (a `{` / `}`), which would
    // reveal the raw brace instead of the cell's chrome widget.
    guardCursor(1);
    refresh();
  }

  function applyTheme() {
    /* faces are CSS-variable driven; nothing imperative needed */
  }

  function destroy() {
    for (const cell of cells) {
      cell.startMarker?.remove();
      cell.endMarker?.remove();
    }
    cells = [];
    if (typeof editor.destroy === 'function') editor.destroy();
  }

  // Seed the sample cells.
  for (const src of SAMPLE_CELLS) {
    const id = model.addCell(src);
    cells.push(makeRuntimeCell(id));
  }
  rebuildBufferFromModel();
  if (cells[0]) {
    const range = model.cellLineRange(cells[0].id);
    if (range) buffer.moveTo(buffer.offsetAt(range[0], 0));
  }
  // Repaint with the cursor on content (not the default offset 0, which is the
  // first cell's `{` scaffolding line — that would reveal the brace).
  refresh();

  return {
    element: root,
    setBuffer,
    focus,
    applyTheme,
    destroy,
    // Exposed for commands / tests.
    addCell,
    removeCell,
    runAll,
  };
}

// -----------------------------------------------------------------------
// Small DOM helpers (local copies — see materialize note above).

function buildTableEl(doc, desc) {
  const table = doc.createElement('table');
  table.className = 'nbc-table';
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
    cap.className = 'nbc-trunc';
    cap.textContent = `showing ${desc.rows.length} of ${desc.total} rows`;
    table.appendChild(cap);
  }
  return table;
}

function truncNote(doc) {
  const note = doc.createElement('div');
  note.className = 'nbc-trunc';
  note.textContent = '… (truncated)';
  return note;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// -----------------------------------------------------------------------
// `<notebook-cells-view>` — custom-element wrapper (mirrors NotebookJsView).

export class NotebookCellsView extends ViewElement {
  constructor() {
    super();
    /** @type {ReturnType<typeof createNotebookCellsView> | null} */
    this._inner = null;
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('NotebookCellsView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'notebook-cells';
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
    this._inner = createNotebookCellsView(this, this._options ?? {});
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

defineViewElement('notebook-cells-view', NotebookCellsView);

export { createNotebookCellsView };
