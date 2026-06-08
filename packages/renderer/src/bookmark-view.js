/**
 * @file The bookmark view — a polished, hierarchical outliner of a text
 * file's bookmarks. Shown through a `bookmark`-kind view whose
 * `extras.sourceBuffer` is the text buffer being annotated; the records
 * live on `sourceBuffer.metadata.bookmarks` (persisted to the shared
 * `.godot-metadata` sidecar), so editing the outline here writes back
 * through the host's `persist` callback.
 *
 * Interaction: ↑/↓ select · Enter jump to the mark · Tab / Shift-Tab
 * indent / outdent (with the whole subtree) · Space toggle a parent's
 * disclosure · r rename (inline) · d delete · g refresh · q close ·
 * right-click for a rename/delete menu. Chords (C-x …, M-x) pass through
 * to the editor.
 */

import { keyEventToString } from './keymap.js';
import {
  depthOf,
  hasChildren,
  visibleRows,
  indent,
  outdent,
} from './bookmark-outline.js';

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Pixels of indentation per outline level. */
const INDENT = 16;

/**
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Forward a chord to
 *   the editor keymap. Returns whether it was handled.
 * @param {() => void} [options.closeBuffer] - Dismiss the view (q).
 * @param {(sourceBuffer: object, name: string) => void} [options.jump] -
 *   Switch to the source buffer's text view and move point to the named
 *   bookmark (resolved host-side via its live marker).
 * @param {(sourceBuffer: object) => void} [options.persist] - Schedule a
 *   metadata write after the outline changes.
 */
function createBookmarkView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const chordPending =
    typeof options.chordPending === 'function' ? options.chordPending : () => false;
  const closeBuffer =
    typeof options.closeBuffer === 'function' ? options.closeBuffer : null;
  const jump = typeof options.jump === 'function' ? options.jump : null;
  const persist = typeof options.persist === 'function' ? options.persist : null;

  const root = doc.createElement('div');
  root.className = 'bookmark-view';
  root.tabIndex = 0;
  container.append(root);

  const header = doc.createElement('div');
  header.className = 'bookmark-header';
  const title = doc.createElement('span');
  title.className = 'bookmark-title';
  title.textContent = 'Bookmarks';
  const subtitle = doc.createElement('span');
  subtitle.className = 'bookmark-subtitle';
  header.append(title, subtitle);
  root.append(header);

  const body = doc.createElement('div');
  body.className = 'bookmark-body';
  root.append(body);

  /** The View object (carries `sourceBuffer`). */
  let view = null;
  /** Selection index into the *visible* rows. */
  let selected = 0;
  /** Parallel to body's children: each visible row's record index. */
  let rows = [];
  /** The open context menu element, or null. */
  let menuEl = null;

  /** The source text buffer this view annotates, or null. `createView`
   *  spreads `extras` onto the view, so the buffer lives at
   *  `view.sourceBuffer` (not `view.extras.sourceBuffer`). */
  function source() {
    return view ? view.sourceBuffer ?? null : null;
  }

  /** The source buffer's bookmark records (live array), or []. */
  function records() {
    const buf = source();
    if (!buf) return [];
    if (!buf.metadata) buf.metadata = {};
    if (!buf.metadata.bookmarks) buf.metadata.bookmarks = [];
    return buf.metadata.bookmarks;
  }

  function selectedRecordIndex() {
    const row = rows[selected];
    return row === undefined ? -1 : row.index;
  }

  /** Persist the records and re-render. */
  function commit() {
    const buf = source();
    if (buf && persist) persist(buf);
    paint();
  }

  // --- rendering ---------------------------------------------------------

  function paint() {
    closeMenu();
    const recs = records();
    const buf = source();
    subtitle.textContent =
      `${buf && buf.name ? buf.name : ''}${recs.length ? `  ·  ${recs.length}` : ''}`;
    body.replaceChildren();
    rows = visibleRows(recs);

    if (recs.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'bookmark-empty';
      empty.textContent = 'No bookmarks — set one with C-x r m.';
      body.append(empty);
      // TEMP DIAGNOSTIC (empty-after-restart): show what the outline is
      // actually reading, right here in the pane the user is looking at,
      // so we don't depend on the REPL being open. Reveals whether the
      // source buffer and its metadata arrived. Remove once fixed.
      const diag = doc.createElement('div');
      diag.className = 'bookmark-empty';
      const md = buf && buf.metadata ? buf.metadata : null;
      const bm = md && Array.isArray(md.bookmarks) ? md.bookmarks.length : 'n/a';
      diag.textContent =
        `[diag] source=${buf ? (buf.name ?? '?') : 'NULL'} · ` +
        `metadata-keys=${md ? Object.keys(md).join(',') : '(none)'} · ` +
        `bookmarks=${bm}`;
      body.append(diag);
      selected = 0;
      return;
    }
    if (selected >= rows.length) selected = rows.length - 1;
    if (selected < 0) selected = 0;

    rows.forEach((row, i) => body.append(buildRow(recs[row.index], row, i)));
    highlight();
  }

  function buildRow(record, row, visibleIndex) {
    const el = doc.createElement('div');
    el.className = 'bookmark-row';
    el.dataset.index = String(visibleIndex);
    el.style.paddingLeft = `${10 + row.depth * INDENT}px`;

    const twist = doc.createElement('span');
    twist.className = 'bookmark-twist';
    if (row.hasChildren) {
      twist.classList.add(row.collapsed ? 'is-collapsed' : 'is-open');
      twist.textContent = '›'; // ›  (rotated open via CSS)
      twist.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleCollapse(row.index);
      });
    } else {
      twist.classList.add('is-leaf');
    }
    el.append(twist);

    const name = doc.createElement('span');
    name.className = 'bookmark-name';
    name.textContent = record.name;
    el.append(name);

    const pos = doc.createElement('span');
    pos.className = 'bookmark-pos';
    pos.textContent = positionLabel(record);
    el.append(pos);

    return el;
  }

  function positionLabel(record) {
    const buf = source();
    if (!buf || typeof buf.positionAt !== 'function') return '';
    const { line, column } = buf.positionAt(record.anchor ?? 0);
    return `Ln ${line + 1}:${column + 1}`;
  }

  function highlight() {
    Array.from(body.children).forEach((el, i) =>
      el.classList.toggle('is-selected', i === selected)
    );
    const el = body.children[selected];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  // --- actions -----------------------------------------------------------

  function moveSelection(delta) {
    if (rows.length === 0) return;
    selected = Math.max(0, Math.min(selected + delta, rows.length - 1));
    highlight();
  }

  function jumpSelected() {
    const idx = selectedRecordIndex();
    const buf = source();
    if (idx < 0 || !buf || !jump) return;
    jump(buf, records()[idx].name);
  }

  function indentSelected() {
    const idx = selectedRecordIndex();
    if (idx >= 0 && indent(records(), idx)) commit();
  }

  function outdentSelected() {
    const idx = selectedRecordIndex();
    if (idx >= 0 && outdent(records(), idx)) commit();
  }

  function toggleCollapse(recordIndex) {
    const recs = records();
    if (recordIndex < 0 || recordIndex >= recs.length) return;
    if (!hasChildren(recs, recordIndex)) return;
    recs[recordIndex].collapsed = !recs[recordIndex].collapsed;
    commit();
  }

  function toggleSelected() {
    toggleCollapse(selectedRecordIndex());
  }

  function deleteSelected() {
    const idx = selectedRecordIndex();
    const recs = records();
    if (idx < 0 || idx >= recs.length) return;
    recs.splice(idx, 1);
    commit();
  }

  /** Replace the selected row's name with an input for inline editing. */
  function renameSelected() {
    const recordIndex = selectedRecordIndex();
    const rowEl = body.children[selected];
    if (recordIndex < 0 || !rowEl) return;
    const record = records()[recordIndex];
    const nameEl = rowEl.querySelector('.bookmark-name');
    if (!nameEl) return;

    const input = doc.createElement('input');
    input.className = 'bookmark-rename';
    input.value = record.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commitEdit) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commitEdit && next !== '' && next !== record.name) {
        record.name = next;
        commit();
      } else {
        paint();
      }
      root.focus();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // --- context menu ------------------------------------------------------

  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
      doc.removeEventListener('mousedown', onDocMouseDown, true);
    }
  }
  const closeContextMenu = closeMenu;

  function onDocMouseDown(event) {
    if (menuEl && !menuEl.contains(event.target)) closeMenu();
  }

  function openMenu(clientX, clientY, items) {
    closeMenu();
    const menu = doc.createElement('div');
    menu.className = 'bookmark-menu';
    for (const item of items) {
      const el = doc.createElement('div');
      el.className = 'bookmark-menu-item';
      el.textContent = item.label;
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        item.run();
      });
      menu.append(el);
    }
    doc.body.append(menu);
    // Keep the menu within the viewport.
    const rect = menu.getBoundingClientRect();
    const win = doc.defaultView ?? globalThis;
    const x = Math.min(clientX, win.innerWidth - rect.width - 4);
    const y = Math.min(clientY, win.innerHeight - rect.height - 4);
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
    menuEl = menu;
    doc.addEventListener('mousedown', onDocMouseDown, true);
  }

  // --- input -------------------------------------------------------------

  function rowIndexFromEvent(event) {
    const rowEl = event.target.closest('.bookmark-row');
    if (!rowEl) return -1;
    const i = Number(rowEl.dataset.index);
    return Number.isInteger(i) ? i : -1;
  }

  body.addEventListener('mousedown', (event) => {
    const i = rowIndexFromEvent(event);
    if (i < 0) return;
    selected = i;
    highlight();
  });

  body.addEventListener('dblclick', (event) => {
    const i = rowIndexFromEvent(event);
    if (i < 0) return;
    selected = i;
    jumpSelected();
  });

  body.addEventListener('contextmenu', (event) => {
    const i = rowIndexFromEvent(event);
    if (i < 0) return;
    event.preventDefault();
    selected = i;
    highlight();
    openMenu(event.clientX, event.clientY, [
      { label: 'Rename…', run: () => renameSelected() },
      { label: 'Delete', run: () => deleteSelected() },
    ]);
  });

  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    if (event.target.tagName === 'INPUT') return; // inline rename owns its keys
    const key = keyEventToString(event);

    // Mid-chord (C-x just pressed) or any modified key: forward to the
    // editor keymap. The `chordPending()` guard is what lets the plain
    // second key of a prefix chord through — `C-x 0`, `C-x b`, `C-x p`
    // — instead of the switch/length-1 swallow below trapping it here.
    if (chordPending() || event.ctrlKey || event.metaKey || event.altKey) {
      if (onKey && onKey(key)) event.preventDefault();
      return;
    }

    switch (key) {
      case 'down': moveSelection(1); event.preventDefault(); return;
      case 'up': moveSelection(-1); event.preventDefault(); return;
      case 'enter': jumpSelected(); event.preventDefault(); return;
      case 'tab': indentSelected(); event.preventDefault(); return;
      case 'S-tab': outdentSelected(); event.preventDefault(); return;
      case 'space': toggleSelected(); event.preventDefault(); return;
      case 'r': renameSelected(); event.preventDefault(); return;
      case 'd': deleteSelected(); event.preventDefault(); return;
      case 'g': paint(); event.preventDefault(); return;
      case 'q': if (closeBuffer) closeBuffer(); event.preventDefault(); return;
      case 'escape': closeMenu(); event.preventDefault(); return;
      default: break;
    }
    // Swallow other plain printables so they don't self-insert into the
    // source text buffer behind us; forward anything else as a chord.
    if (key.length === 1) {
      event.preventDefault();
      return;
    }
    if (onKey && onKey(key)) event.preventDefault();
  });

  function setBuffer(next) {
    view = next;
    selected = 0;
    paint();
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
  };
}

// -----------------------------------------------------------------------
// `<bookmark-view>` — custom-element wrapper (same shape as DocView).

import { defineViewElement, ViewElement } from './view-elements.js';

/** @typedef {object} BookmarkViewOptions See `createBookmarkView`. */

export class BookmarkView extends ViewElement {
  constructor() {
    super();
    /** @type {ReturnType<typeof createBookmarkView> | null} */
    this._inner = null;
    /** @type {BookmarkViewOptions | null} */
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('BookmarkView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'bookmark';
  }

  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    if (this._inner !== null) this._inner.setBuffer(buffer);
  }

  focus() {
    if (this._inner !== null) this._inner.focus();
    else super.focus();
  }

  connectedCallback() {
    if (this._inner !== null) return;
    this._inner = createBookmarkView(this, this._options ?? {});
    if (this._pendingBuffer !== null) this._inner.setBuffer(this._pendingBuffer);
  }

  disconnectedCallback() {
    /* intentionally empty */
  }

  destroy() {
    this._inner = null;
    this._pendingBuffer = null;
  }
}

defineViewElement('bookmark-view', BookmarkView);
