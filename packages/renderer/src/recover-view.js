/**
 * @file The `*Recover*` view — a `recover`-kind view shown at startup
 * when crash-recovery snapshots are found (see recovery.js / the
 * autosave controller). It is a clickable HTML table of recoverable
 * buffers, one per row (name / file / age), with a **Recover** and a
 * **Discard** action per row plus **Recover all** / **Discard all** in
 * the footer.
 *
 * Mirrors `view-list-view.js`: a focusable container with clickable
 * rows + chord-key passthrough, fed by `options.getEntries` on every
 * render so the host can keep it live by calling `refresh()` as rows are
 * recovered or discarded. Per the project convention the DOM-driven
 * pieces are verified live; the pure helpers here (age + file labels)
 * are unit-tested.
 */

import { keyEventToString } from './keymap.js';
import { defineViewElement, ViewElement } from './view-elements.js';

/** Modifier keys that are not keystrokes in their own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

// -----------------------------------------------------------------------
// Pure helpers (no DOM) — unit-tested in Node.

/**
 * A short human label for how long ago a snapshot was saved. `savedAt`
 * and `now` are epoch-millis. Sub-minute reads "just now"; otherwise the
 * largest whole unit ("3m ago", "2h ago", "5d ago"). A missing/invalid
 * timestamp reads empty.
 *
 * @param {number} savedAt
 * @param {number} now
 * @returns {string}
 */
export function formatAge(savedAt, now) {
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return '';
  const secs = Math.max(0, Math.floor((now - savedAt) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * The "File" column for a snapshot: the source path, or a parenthesised
 * note for a path-less (never-saved) buffer.
 *
 * @param {string|null|undefined} path
 * @returns {string}
 */
export function recoverFileLabel(path) {
  return typeof path === 'string' && path !== '' ? path : '(unsaved buffer)';
}

// -----------------------------------------------------------------------
// The DOM factory.

/**
 * Create a recover view.
 *
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {() => Array<{key:string,name:string,path:?string,savedAt:number}>} [options.getEntries]
 * @param {(key: string) => void} [options.recover]
 * @param {(key: string) => void} [options.discard]
 * @param {() => void} [options.recoverAll]
 * @param {() => void} [options.discardAll]
 * @param {(key: string) => boolean} [options.onKey]
 * @param {() => boolean} [options.chordPending]
 * @param {() => number} [options.now]
 * @returns {{ element: HTMLElement, setBuffer: Function, refresh: Function, focus: Function, destroy: Function, applyTheme: Function }}
 */
function createRecoverView(container, options = {}) {
  const doc = container.ownerDocument;
  const getEntries =
    typeof options.getEntries === 'function' ? options.getEntries : () => [];
  const recover = typeof options.recover === 'function' ? options.recover : null;
  const discard = typeof options.discard === 'function' ? options.discard : null;
  const recoverAll =
    typeof options.recoverAll === 'function' ? options.recoverAll : null;
  const discardAll =
    typeof options.discardAll === 'function' ? options.discardAll : null;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const chordPending =
    typeof options.chordPending === 'function' ? options.chordPending : () => false;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  const root = doc.createElement('div');
  root.className = 'recover-view';
  root.tabIndex = -1;
  container.append(root);

  // Header: icon + title + subtitle.
  const header = doc.createElement('div');
  header.className = 'recover-header';
  const headerIcon = doc.createElement('i');
  headerIcon.className = 'fa-solid fa-life-ring';
  const headerLabel = doc.createElement('span');
  headerLabel.className = 'recover-header-label';
  headerLabel.textContent = 'Recover unsaved work';
  header.append(headerIcon, headerLabel);
  root.append(header);

  const intro = doc.createElement('p');
  intro.className = 'recover-intro';
  root.append(intro);

  // Table.
  const table = doc.createElement('table');
  table.className = 'recover-table';
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const [cls, text] of [
    ['recover-name', 'Buffer'],
    ['recover-file', 'File'],
    ['recover-age', 'Saved'],
    ['recover-actions', ''],
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
  scroll.className = 'recover-scroll';
  scroll.append(table);
  root.append(scroll);

  // Footer: bulk actions.
  const footer = doc.createElement('div');
  footer.className = 'recover-footer';
  const recoverAllBtn = doc.createElement('button');
  recoverAllBtn.type = 'button';
  recoverAllBtn.className = 'recover-all-btn';
  recoverAllBtn.textContent = 'Recover all';
  const discardAllBtn = doc.createElement('button');
  discardAllBtn.type = 'button';
  discardAllBtn.className = 'recover-discard-all-btn';
  discardAllBtn.textContent = 'Discard all';
  footer.append(recoverAllBtn, discardAllBtn);
  root.append(footer);
  // After any action the host has mutated its entry list; re-render THIS
  // element (not the host's singleton, which may be a different instance
  // when this view is shown as a tabline tab) so the table reflects it.
  recoverAllBtn.addEventListener('click', () => {
    if (recoverAll) recoverAll();
    render();
  });
  discardAllBtn.addEventListener('click', () => {
    if (discardAll) discardAll();
    render();
  });

  /** Add a `<td>` with CLASS + TEXT to ROW. */
  function cell(row, cls, text) {
    const td = doc.createElement('td');
    td.className = cls;
    td.textContent = text;
    row.append(td);
    return td;
  }

  /** Re-read the entries from the host and repaint. */
  function render() {
    const entries = getEntries() || [];
    const t = now();
    tbody.replaceChildren();
    for (const entry of entries) {
      const tr = doc.createElement('tr');
      tr.className = 'recover-row';
      tr.dataset.key = String(entry.key);
      cell(tr, 'recover-name', entry.name ?? '');
      cell(tr, 'recover-file', recoverFileLabel(entry.path));
      cell(tr, 'recover-age', formatAge(entry.savedAt, t));
      const actions = doc.createElement('td');
      actions.className = 'recover-actions';
      const recoverBtn = doc.createElement('button');
      recoverBtn.type = 'button';
      recoverBtn.className = 'recover-btn';
      recoverBtn.title = 'Recover this buffer';
      recoverBtn.textContent = 'Recover';
      const discardBtn = doc.createElement('button');
      discardBtn.type = 'button';
      discardBtn.className = 'recover-discard-btn';
      discardBtn.title = 'Discard this snapshot';
      discardBtn.textContent = 'Discard';
      actions.append(recoverBtn, discardBtn);
      tr.append(actions);
      tbody.append(tr);
    }
    const n = entries.length;
    const empty = n === 0;
    intro.textContent = empty
      ? 'Nothing left to recover — close this tab (Cmd+W).'
      : `jmacs found unsaved changes in ${n} buffer(s) from a previous ` +
        'session. Recover each into a live (unsaved) buffer, or discard it.';
    footer.style.display = empty ? 'none' : '';
  }

  // Click: Recover / Discard buttons act on their row's snapshot.
  tbody.addEventListener('click', (event) => {
    const tr = event.target.closest('.recover-row');
    if (!tr) return;
    const key = tr.dataset.key;
    if (!key) return;
    if (event.target.closest('.recover-btn')) {
      if (recover) recover(key);
      render();
      return;
    }
    if (event.target.closest('.recover-discard-btn')) {
      if (discard) discard(key);
      render();
    }
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
// `<recover-view>` — custom-element wrapper.

export class RecoverView extends ViewElement {
  constructor() {
    super();
    this._inner = null;
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('RecoverView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'recover';
  }

  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    if (this._inner !== null) this._inner.setBuffer(buffer);
  }

  /** Re-read the host's recovery entries and repaint. */
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
    this._inner = createRecoverView(this, this._options ?? {});
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

defineViewElement('recover-view', RecoverView);
