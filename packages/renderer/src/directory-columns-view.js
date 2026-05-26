/**
 * @file The directory columns-view — a `directory-columns`-kind
 * buffer is shown through this view: a horizontal row of columns
 * mirroring Finder's column-browser UI. Each column is one directory
 * listing; clicking a subfolder appends a column to its right (or
 * replaces an existing one) showing that folder's contents; clicking
 * a file replaces the trailing column with a preview pane for it.
 *
 * Buffer shape:
 *
 *   { kind: 'directory-columns',
 *     name: '*Columns: /Users/.../Source*',
 *     rootPath: '/Users/.../Source',
 *     columns: [
 *       { path: '/Users/.../Source', selected: 'jmacs' },
 *       { path: '/Users/.../Source/jmacs', selected: 'README.md' },
 *     ],
 *     // The file being previewed in the rightmost column. Set when
 *     // the user clicks a file row; cleared when they navigate up
 *     // again to a folder.
 *     previewPath: '/Users/.../Source/jmacs/README.md' | null }
 *
 * Listings come from the same `listDirectoryDetailedSync` primitive
 * the tree-view uses. The preview pane reads the file lazily through
 * a separate callback the host plugs in (`getPreview`) so this module
 * stays renderer-only — no filesystem, no IPC.
 */

import { keyEventToString } from './keymap.js';
import { iconClassForFile, joinPath } from './directory-tree-view.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Tags whose own keyboard handling must not be hijacked. */
const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

/**
 * Create the directory columns-view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(path: string) => Array<{name: string, kind: string}> | null} [options.listDirectory] -
 *   Synchronously list a directory's entries.
 * @param {(path: string) =>
 *   Promise<{ kind: 'image' | 'text' | 'audio' | 'video' | 'binary' | 'unreadable',
 *     name: string,
 *     size?: number,
 *     content?: string,
 *     src?: string,
 *     mime?: string } | null>} [options.getPreview] -
 *   Read a file for the preview pane. Returns a shape the view can
 *   render directly — text content for small text files, a data: URL
 *   for images, a media:// URL for audio/video, or just size/name for
 *   binaries. `null` means the file couldn't be read. Asynchronous;
 *   the view shows a loading state while the promise pends.
 * @param {(path: string) => void} [options.openPath] - Open a file
 *   the user activated (double-click or Enter). Routes through the
 *   host's `open-file-path!`.
 * @param {(key: string) => boolean} [options.onKey] - Chord-key
 *   passthrough to the global Lisp keymap.
 * @param {() => void} [options.closeBuffer] - Called when the user
 *   presses `q` to dismiss the buffer.
 * @returns {{element: HTMLElement, setBuffer, focus}}
 */
export function createDirectoryColumnsView(container, options = {}) {
  const doc = container.ownerDocument;
  const listDirectory =
    typeof options.listDirectory === 'function' ? options.listDirectory : null;
  const getPreview =
    typeof options.getPreview === 'function' ? options.getPreview : null;
  const openPath =
    typeof options.openPath === 'function' ? options.openPath : null;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const closeBuffer =
    typeof options.closeBuffer === 'function' ? options.closeBuffer : null;

  const root = doc.createElement('div');
  root.className = 'directory-columns-view';
  root.tabIndex = 0;
  container.append(root);

  const header = doc.createElement('div');
  header.className = 'directory-columns-header';
  const headerIcon = doc.createElement('i');
  headerIcon.className = 'fa-solid fa-folder-tree';
  const headerLabel = doc.createElement('span');
  headerLabel.className = 'directory-columns-header-label';
  header.append(headerIcon, headerLabel);
  root.append(header);

  // The column strip. Horizontal flex container; columns slot in
  // alongside each other. Overflows horizontally when there's more
  // than fits — the browser handles the scroll.
  const strip = doc.createElement('div');
  strip.className = 'directory-columns-strip';
  root.append(strip);

  /** Buffer currently shown, or null. */
  let buffer = null;
  /** Cached preview info, keyed by absolute path. Cleared on
   *  setBuffer; populated lazily when the user picks a file. */
  let previewCache = new Map();

  /** Truncate `buffer.columns` to length N (cutting off everything
   *  past index N-1), then push the next column. Used when the user
   *  drills into a subfolder. */
  function setColumnsAfter(index, next) {
    if (!buffer) return;
    buffer.columns = [...buffer.columns.slice(0, index + 1), next];
    buffer.previewPath = null;
  }

  /** Truncate to a folder column and set the preview to a file. */
  function setPreviewAt(index, fileName, path) {
    if (!buffer) return;
    buffer.columns = buffer.columns.slice(0, index + 1);
    buffer.columns[index] = {
      ...buffer.columns[index],
      selected: fileName,
    };
    buffer.previewPath = path;
  }

  /** Update `selected` of a folder column and clear anything to its
   *  right. Used when the user picks a different sibling. */
  function selectIn(index, name) {
    if (!buffer) return;
    buffer.columns[index] = {
      ...buffer.columns[index],
      selected: name,
    };
    buffer.columns = buffer.columns.slice(0, index + 1);
    buffer.previewPath = null;
  }

  /** Default + min/max widths (in px) for a directory column. The
   *  user-set widths persist on `buffer.columnWidths[i]`; absence
   *  falls back to default. */
  const COLUMN_DEFAULT_WIDTH = 220;
  const COLUMN_MIN_WIDTH = 120;
  const COLUMN_MAX_WIDTH = 600;

  /** Apply the persisted (or default) width to a column element by
   *  setting flex-basis explicitly. The CSS rule's `flex: 0 0 220px`
   *  is the un-resized baseline; this override wins on inline. */
  function applyColumnWidth(columnEl, columnIndex) {
    const width =
      (buffer.columnWidths && buffer.columnWidths[columnIndex]) ||
      COLUMN_DEFAULT_WIDTH;
    columnEl.style.flex = `0 0 ${width}px`;
    columnEl.style.minWidth = `${width}px`;
  }

  /** Build one column's DOM: a header strip with the directory's
   *  basename and a scrollable body of row elements. A drag handle
   *  is appended to the right edge for live width-resize. */
  function buildColumn(columnState, columnIndex) {
    const column = doc.createElement('div');
    column.className = 'directory-columns-column';
    column.dataset.index = String(columnIndex);
    column.dataset.path = columnState.path;
    applyColumnWidth(column, columnIndex);

    const entries = listDirectory ? listDirectory(columnState.path) : null;
    if (entries === null) {
      const err = doc.createElement('div');
      err.className = 'directory-columns-error';
      err.textContent = '(unreadable)';
      column.append(err);
      attachColumnResizer(column, columnIndex);
      return column;
    }
    for (const entry of entries) {
      const entryPath = joinPath(columnState.path, entry.name);
      const row = doc.createElement('div');
      row.className = 'directory-columns-row';
      row.dataset.name = entry.name;
      row.dataset.path = entryPath;
      row.dataset.kind = entry.kind;

      const icon = doc.createElement('i');
      icon.className = 'directory-columns-icon fa-solid';
      if (entry.kind === 'directory') {
        icon.classList.add('fa-folder');
      } else if (entry.kind === 'other') {
        icon.classList.add('fa-file-circle-question');
      } else {
        icon.classList.add(iconClassForFile(entry.name));
      }
      row.append(icon);

      const label = doc.createElement('span');
      label.className = 'directory-columns-name';
      label.textContent = entry.name;
      row.append(label);

      // The drill-in chevron sits only on folder rows.
      if (entry.kind === 'directory') {
        const chev = doc.createElement('i');
        chev.className = 'directory-columns-chevron fa-solid fa-chevron-right';
        row.append(chev);
      }

      if (columnState.selected === entry.name) {
        row.classList.add('is-selected');
      }
      column.append(row);
    }
    attachColumnResizer(column, columnIndex);
    return column;
  }

  /** Append a thin draggable handle on the column's right edge. The
   *  pointer drag updates the column's flex-basis live (so the user
   *  sees the resize as they drag) and writes the final width to
   *  `buffer.columnWidths[index]` on release, so it survives the
   *  next paint and a buffer round-trip. */
  function attachColumnResizer(columnEl, columnIndex) {
    const handle = doc.createElement('div');
    handle.className = 'directory-columns-resizer';
    columnEl.append(handle);

    handle.addEventListener('pointerdown', (event) => {
      // Ignore right-click / middle-click — only the primary button
      // initiates a drag.
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = columnEl.getBoundingClientRect().width;
      // setPointerCapture throws on synthetic pointer events (no
      // physical pointer to capture) — fine to swallow, the listener
      // chain below still drives the resize.
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointer; capture unavailable */
      }
      handle.classList.add('is-dragging');

      const onMove = (e) => {
        const delta = e.clientX - startX;
        const next = Math.max(
          COLUMN_MIN_WIDTH,
          Math.min(COLUMN_MAX_WIDTH, startWidth + delta)
        );
        columnEl.style.flex = `0 0 ${next}px`;
        columnEl.style.minWidth = `${next}px`;
      };
      const onUp = (e) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        handle.classList.remove('is-dragging');
        try {
          handle.releasePointerCapture(event.pointerId);
        } catch {
          /* the pointer might already be released */
        }
        const finalWidth = columnEl.getBoundingClientRect().width;
        if (!buffer.columnWidths) buffer.columnWidths = [];
        buffer.columnWidths[columnIndex] = Math.round(finalWidth);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  /** Build the preview pane that sits to the right of the trailing
   *  directory column. The actual preview content is async — it
   *  arrives from getPreview(path) and is cached by path. While the
   *  cache is empty for `path`, render a loading state and trigger a
   *  fetch; the resolve callback repaints. */
  function buildPreview(path) {
    const preview = doc.createElement('div');
    preview.className = 'directory-columns-preview';
    preview.dataset.path = path;
    if (!getPreview) {
      preview.textContent = path;
      return preview;
    }
    const info = previewCache.get(path);
    if (info === undefined) {
      const loading = doc.createElement('div');
      loading.className = 'directory-columns-preview-loading';
      loading.textContent = 'Loading…';
      preview.append(loading);
      // Fetch in the background and repaint when it arrives.
      Promise.resolve(getPreview(path))
        .then((result) => {
          previewCache.set(path, result ?? null);
          if (buffer && buffer.previewPath === path) paint();
        })
        .catch(() => {
          previewCache.set(path, null);
          if (buffer && buffer.previewPath === path) paint();
        });
      return preview;
    }
    if (info === null) {
      const err = doc.createElement('div');
      err.className = 'directory-columns-error';
      err.textContent = '(unreadable)';
      preview.append(err);
      return preview;
    }
    const heading = doc.createElement('div');
    heading.className = 'directory-columns-preview-name';
    heading.textContent = info.name ?? '';
    preview.append(heading);

    if (info.kind === 'image' && typeof info.src === 'string') {
      const img = doc.createElement('img');
      img.className = 'directory-columns-preview-image';
      img.src = info.src;
      img.alt = info.name ?? '';
      preview.append(img);
    } else if (info.kind === 'audio' && typeof info.src === 'string') {
      const audio = doc.createElement('audio');
      audio.className = 'directory-columns-preview-audio';
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = info.src;
      preview.append(audio);
    } else if (info.kind === 'video' && typeof info.src === 'string') {
      const video = doc.createElement('video');
      video.className = 'directory-columns-preview-video';
      video.controls = true;
      video.preload = 'metadata';
      video.src = info.src;
      preview.append(video);
    } else if (info.kind === 'text' && typeof info.content === 'string') {
      const pre = doc.createElement('pre');
      pre.className = 'directory-columns-preview-text';
      // Cap the preview at ~4KB to keep the column light.
      pre.textContent =
        info.content.length > 4096
          ? `${info.content.slice(0, 4096)}\n…`
          : info.content;
      preview.append(pre);
    } else {
      const note = doc.createElement('div');
      note.className = 'directory-columns-preview-binary';
      note.textContent = info.size
        ? `${info.size.toLocaleString()} bytes`
        : '(binary file)';
      preview.append(note);
    }
    return preview;
  }

  /** Re-render the column strip from buffer state. */
  function paint() {
    strip.replaceChildren();
    if (!buffer || !Array.isArray(buffer.columns) || buffer.columns.length === 0) {
      headerLabel.textContent = '';
      return;
    }
    headerLabel.textContent = buffer.rootPath ?? buffer.columns[0].path;
    for (let i = 0; i < buffer.columns.length; i++) {
      strip.append(buildColumn(buffer.columns[i], i));
    }
    if (typeof buffer.previewPath === 'string' && buffer.previewPath !== '') {
      strip.append(buildPreview(buffer.previewPath));
    }
    // After each repaint, scroll the strip so the rightmost column
    // sits at the right edge — the most-recent navigation is what
    // the user is looking at.
    strip.scrollLeft = strip.scrollWidth;
  }

  // Click delegation — every row click does one of three things,
  // resolved by data-kind on the row + data-index on the column.
  // We can't rely on the browser's `dblclick` event because the
  // first click's handler repaints the strip, which detaches the
  // row that received it; the browser then sees the second click
  // on a different element and never fires `dblclick`. Detect
  // double-click ourselves via path + timing instead.
  const DOUBLE_CLICK_WINDOW_MS = 400;
  let lastClickPath = null;
  let lastClickTime = 0;

  strip.addEventListener('click', (event) => {
    const row = event.target.closest('.directory-columns-row');
    if (!row) return;
    const column = row.parentElement;
    const columnIndex = Number(column?.dataset.index ?? '-1');
    if (columnIndex < 0) return;
    const name = row.dataset.name;
    const path = row.dataset.path;
    const kind = row.dataset.kind;

    // Double-click on a file row opens it in its home view.
    // Folders ignore the double-click — drilling-in already happens
    // on the first click, so a fast second click would just toggle
    // selection state in the same way as two distinct clicks.
    const now = Date.now();
    const isDouble =
      kind !== 'directory' &&
      lastClickPath === path &&
      now - lastClickTime < DOUBLE_CLICK_WINDOW_MS;
    lastClickPath = path;
    lastClickTime = now;

    if (isDouble && openPath) {
      openPath(path);
      return;
    }

    if (kind === 'directory') {
      // Drill in: select this folder in its column, spawn a new
      // column to its right showing its contents.
      buffer.columns[columnIndex] = {
        ...buffer.columns[columnIndex],
        selected: name,
      };
      setColumnsAfter(columnIndex, { path, selected: null });
    } else {
      setPreviewAt(columnIndex, name, path);
    }
    paint();
  });

  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    if (FORM_TAGS.has(event.target.tagName)) return;
    const key = keyEventToString(event);
    if (event.ctrlKey || event.metaKey || event.altKey) {
      if (onKey && onKey(key)) event.preventDefault();
      return;
    }
    if (key === 'q') {
      event.preventDefault();
      if (closeBuffer) closeBuffer();
      return;
    }
    // Plain printables: swallow so they don't fall through to the
    // text-buffer handle-key.
    if (key.length === 1) {
      event.preventDefault();
      return;
    }
    if (onKey && onKey(key)) event.preventDefault();
  });

  /**
   * Show a directory-columns buffer.
   *
   * @param {object | null} next
   */
  function setBuffer(next) {
    if (buffer !== next) previewCache = new Map();
    buffer = next;
    if (buffer) {
      if (!Array.isArray(buffer.columns) || buffer.columns.length === 0) {
        buffer.columns = [{ path: buffer.rootPath, selected: null }];
      }
      if (buffer.previewPath === undefined) buffer.previewPath = null;
    }
    paint();
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
    // Expose for the smoke harness — same helpers as the tree.
    _selectIn: selectIn,
  };
}
