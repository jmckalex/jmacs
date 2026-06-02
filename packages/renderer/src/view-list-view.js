/**
 * @file The view-list view — a `view-list`-kind buffer is shown through
 * this view as a clickable HTML table of every open *view* (Emacs's
 * *Buffer List*, but about views and rendered as a real table). Click a
 * row to switch to that view; the trailing ✕ kills it.
 *
 * The data is pulled from the host on every render via `options.getViews`
 * (one record per view), so the table needs no buffer of its own and the
 * host can keep it live by calling `refresh()` when the view list changes.
 *
 * This mirrors the directory-tree view's interaction model (a focusable
 * container with clickable rows + chord-key passthrough) and the gnuplot/
 * notebook custom-element scaffold.
 */

import { keyEventToString } from './keymap.js';

/** Modifier keys that are not keystrokes in their own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

// -----------------------------------------------------------------------
// Pure helpers (no DOM) — unit-tested in Node.

/** Pretty labels for non-text view kinds. */
const KIND_LABELS = {
  text: 'Text',
  browser: 'Browser',
  gnuplot: 'Gnuplot',
  notebook: 'Notebook',
  image: 'Image',
  pdf: 'PDF',
  audio: 'Audio',
  video: 'Video',
  shell: 'Shell',
  jukebox: 'Jukebox',
  customize: 'Customize',
  doc: 'Doc',
  'directory-tree': 'Directory tree',
  'directory-columns': 'Directory columns',
  'view-list': 'View list',
  tabline: 'Tabline',
};

/**
 * The display label for a view's "Kind" column. A text view shows its
 * major-mode name (e.g. "Fundamental", "Markdown"); every other kind
 * shows the kind itself, prettified ("Browser", "Gnuplot", …) — fixing
 * the old menu, which showed "Fundamental" for browsers and the like.
 *
 * @param {string} kind
 * @param {string|null|undefined} mode - The major-mode name (text views).
 * @returns {string}
 */
export function kindLabel(kind, mode) {
  if (kind === 'text') {
    return typeof mode === 'string' && mode !== '' ? mode : 'Fundamental';
  }
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : '';
}

/** The file column's text: the path, or empty. */
export function fileLabel(file) {
  return typeof file === 'string' ? file : '';
}

// -----------------------------------------------------------------------
// The DOM factory.

/**
 * Create a view-list view.
 *
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {() => Array<{id:string,name:string,kind:string,mode:?string,lines:number,pane:?string,file:?string,modified:boolean,current:boolean}>} [options.getViews]
 * @param {(id: string) => void} [options.selectView]
 * @param {(id: string) => void} [options.killView]
 * @param {(key: string) => boolean} [options.onKey]
 * @param {() => boolean} [options.chordPending]
 * @returns {{ element: HTMLElement, setBuffer: Function, refresh: Function, focus: Function, destroy: Function, applyTheme: Function }}
 */
function createViewListView(container, options = {}) {
  const doc = container.ownerDocument;
  const getViews = typeof options.getViews === 'function' ? options.getViews : () => [];
  const selectView = typeof options.selectView === 'function' ? options.selectView : null;
  const killView = typeof options.killView === 'function' ? options.killView : null;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const chordPending =
    typeof options.chordPending === 'function' ? options.chordPending : () => false;

  const root = doc.createElement('div');
  root.className = 'view-list-view';
  root.tabIndex = -1;
  container.append(root);

  // Header: icon + title + a refresh button.
  const header = doc.createElement('div');
  header.className = 'view-list-header';
  const headerIcon = doc.createElement('i');
  headerIcon.className = 'fa-solid fa-list';
  const headerLabel = doc.createElement('span');
  headerLabel.className = 'view-list-header-label';
  headerLabel.textContent = 'View List';
  const refreshBtn = doc.createElement('button');
  refreshBtn.className = 'view-list-refresh';
  refreshBtn.type = 'button';
  refreshBtn.title = 'Refresh';
  refreshBtn.textContent = '⟳';
  refreshBtn.addEventListener('click', () => render());
  header.append(headerIcon, headerLabel, refreshBtn);
  root.append(header);

  // Table.
  const table = doc.createElement('table');
  table.className = 'view-list-table';
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const [cls, text] of [
    ['view-list-modified', ''],
    ['view-list-name', 'Name'],
    ['view-list-kind', 'Kind'],
    ['view-list-lines', 'Lines'],
    ['view-list-pane', 'Pane'],
    ['view-list-file', 'File'],
    ['view-list-kill', ''],
  ]) {
    const th = doc.createElement('th');
    th.className = cls;
    th.textContent = text;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = doc.createElement('tbody');
  table.append(thead, tbody);
  const scroll = doc.createElement('div');
  scroll.className = 'view-list-scroll';
  scroll.append(table);
  root.append(scroll);

  /** Add a `<td>` with CLASS + TEXT to ROW. */
  function cell(row, cls, text) {
    const td = doc.createElement('td');
    td.className = cls;
    td.textContent = text;
    row.append(td);
    return td;
  }

  /** Re-read the views from the host and repaint the table. */
  function render() {
    const records = getViews() || [];
    tbody.replaceChildren();
    for (const rec of records) {
      const tr = doc.createElement('tr');
      tr.className = 'view-list-row';
      tr.dataset.id = String(rec.id);
      if (rec.current) tr.classList.add('is-current');
      cell(tr, 'view-list-modified', rec.modified ? '●' : '');
      cell(tr, 'view-list-name', rec.name ?? '');
      cell(tr, 'view-list-kind', kindLabel(rec.kind, rec.mode));
      cell(tr, 'view-list-lines', String(rec.lines ?? 0));
      cell(tr, 'view-list-pane', rec.pane ?? '');
      cell(tr, 'view-list-file', fileLabel(rec.file));
      const killTd = doc.createElement('td');
      killTd.className = 'view-list-kill';
      const killBtn = doc.createElement('button');
      killBtn.type = 'button';
      killBtn.className = 'view-list-kill-btn';
      killBtn.title = 'Kill this view';
      killBtn.textContent = '✕';
      killTd.append(killBtn);
      tr.append(killTd);
      tbody.append(tr);
    }
  }

  // Click: the ✕ kills the row's view; anywhere else on the row switches
  // to it.
  tbody.addEventListener('click', (event) => {
    const tr = event.target.closest('.view-list-row');
    if (!tr) return;
    const id = tr.dataset.id;
    if (!id) return;
    if (event.target.closest('.view-list-kill-btn')) {
      if (killView) killView(id);
      render();
      return;
    }
    if (selectView) selectView(id);
  });

  // Keys: forward editor chords to the host keymap; swallow plain keys so
  // they don't self-insert into a text buffer behind the list.
  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    const key = keyEventToString(event);
    if (chordPending() || event.ctrlKey || event.altKey || event.metaKey) {
      if (onKey && onKey(key)) event.preventDefault();
      return;
    }
    if (key.length === 1) event.preventDefault();
  });

  function setBuffer() {
    render();
  }

  render();
  return {
    element: root,
    setBuffer,
    refresh: render,
    focus: () => root.focus(),
    applyTheme: () => {},
    destroy: () => {},
  };
}

// -----------------------------------------------------------------------
// `<view-list-view>` — custom-element wrapper.

import { defineViewElement, ViewElement } from './view-elements.js';

export class ViewListView extends ViewElement {
  constructor() {
    super();
    this._inner = null;
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('ViewListView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'view-list';
  }

  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    if (this._inner !== null) this._inner.setBuffer(buffer);
  }

  /** Re-read the host's view list and repaint — called when the view
   *  list changes so the table stays live. */
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
    this._inner = createViewListView(this, this._options ?? {});
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

defineViewElement('view-list-view', ViewListView);
