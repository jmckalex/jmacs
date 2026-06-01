/**
 * @file The directory tree-view — a `directory-tree`-kind buffer is
 * shown through this view. Folders expand/collapse on click; clicking
 * a file routes through the host's `open-file-path!` so it opens in
 * whichever view its kind dictates (text editor, image, audio, video).
 *
 * Buffer shape:
 *
 *   { kind: 'directory-tree',
 *     name: 'Tree: /Users/jalex/Source/...',
 *     rootPath: '/Users/jalex/Source/jmacs',
 *     expanded: Set<string> }   // absolute paths of opened folders
 *
 * Listings come from a host primitive (`listDirectoryDetailedSync`)
 * that returns `{ name, kind: 'directory' | 'file' | 'other' }[]`,
 * folders-first. Each row carries the absolute path on its
 * `data-path`, so a click handler reads it back to either toggle
 * `expanded` or call `openPath`.
 *
 * FontAwesome icons pick a glyph from the filename extension. The
 * pattern matches the existing sticky-notes / jukebox usage of the
 * vendored Font Awesome (see `apps/desktop/vendor/fontawesome/`):
 * `<i class="fa-solid fa-folder">` etc.
 */

import { keyEventToString } from './keymap.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A simple right-pointing arrow polygon, sized for viewBox 0 0 640 640.
 * Hand-drawn from straight edges (rectangle shaft + triangle head) —
 * no third-party authorship, safe under GPL distribution.
 */
const SYMLINK_ARROW_PATH =
  'M180 280 L390 280 L390 220 L500 320 L390 420 L390 360 L180 360 Z';

/**
 * Build the symlink overlay badge — a filled dark disc with a thin
 * white halo around it and a white right-pointing arrow inside.
 * Mounted as the absolutely-positioned corner stamp on an icon stack,
 * the disc gives the badge a solid opaque core so the arrow is clearly
 * readable; the halo separates it from whatever base icon it overlays.
 *
 * The disc fill is `currentColor`, so consumers can theme it via CSS
 * (defaults to a dark navy below). The halo and arrow are pure white.
 *
 * @param {Document} doc
 * @param {string} className - CSS class on the root SVG.
 * @returns {SVGElement}
 */
export function createSymlinkBadge(doc, className) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 640 640');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);

  // Filled background disc + white stroke halo. Stroke is centred on
  // r=240, so the visible outer edge sits at r=260 — a thin bright ring.
  const disc = doc.createElementNS(SVG_NS, 'circle');
  disc.setAttribute('cx', '320');
  disc.setAttribute('cy', '320');
  disc.setAttribute('r', '240');
  disc.setAttribute('fill', 'currentColor');
  disc.setAttribute('stroke', '#fff');
  disc.setAttribute('stroke-width', '40');
  svg.append(disc);

  // White arrow centred inside the disc.
  const arrow = doc.createElementNS(SVG_NS, 'path');
  arrow.setAttribute('d', SYMLINK_ARROW_PATH);
  arrow.setAttribute('fill', '#fff');
  svg.append(arrow);

  return svg;
}

/** Tags whose own keyboard handling must not be hijacked. */
const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

/**
 * Suffix → FontAwesome icon class. The mapping is small and biased
 * toward common cases; everything else falls back to a plain
 * `fa-file`. Casing matches the vendored Font Awesome free set.
 */
const ICON_FOR_SUFFIX = {
  // code
  '.js': 'fa-file-code',
  '.mjs': 'fa-file-code',
  '.cjs': 'fa-file-code',
  '.ts': 'fa-file-code',
  '.tsx': 'fa-file-code',
  '.jsx': 'fa-file-code',
  '.lisp': 'fa-file-code',
  '.scm': 'fa-file-code',
  '.clj': 'fa-file-code',
  '.py': 'fa-file-code',
  '.rb': 'fa-file-code',
  '.lua': 'fa-file-code',
  '.go': 'fa-file-code',
  '.rs': 'fa-file-code',
  '.c': 'fa-file-code',
  '.h': 'fa-file-code',
  '.cpp': 'fa-file-code',
  '.hpp': 'fa-file-code',
  '.cc': 'fa-file-code',
  '.cs': 'fa-file-code',
  '.java': 'fa-file-code',
  '.kt': 'fa-file-code',
  '.swift': 'fa-file-code',
  '.zig': 'fa-file-code',
  '.hs': 'fa-file-code',
  '.ml': 'fa-file-code',
  '.ex': 'fa-file-code',
  '.exs': 'fa-file-code',
  '.erl': 'fa-file-code',
  '.sql': 'fa-file-code',
  '.sh': 'fa-file-code',
  '.bash': 'fa-file-code',
  '.zsh': 'fa-file-code',
  '.php': 'fa-file-code',
  '.html': 'fa-file-code',
  '.css': 'fa-file-code',
  '.xml': 'fa-file-code',
  '.yaml': 'fa-file-code',
  '.yml': 'fa-file-code',
  '.toml': 'fa-file-code',
  '.json': 'fa-file-code',
  '.nix': 'fa-file-code',
  '.graphql': 'fa-file-code',

  // prose
  '.md': 'fa-file-lines',
  '.jmd': 'fa-file-lines',
  '.txt': 'fa-file-lines',
  '.rst': 'fa-file-lines',
  '.tex': 'fa-file-lines',
  '.org': 'fa-file-lines',
  '.adoc': 'fa-file-lines',

  // images
  '.png': 'fa-file-image',
  '.jpg': 'fa-file-image',
  '.jpeg': 'fa-file-image',
  '.gif': 'fa-file-image',
  '.svg': 'fa-file-image',
  '.webp': 'fa-file-image',
  '.bmp': 'fa-file-image',
  '.ico': 'fa-file-image',

  // audio
  '.mp3': 'fa-file-audio',
  '.flac': 'fa-file-audio',
  '.wav': 'fa-file-audio',
  '.m4a': 'fa-file-audio',
  '.ogg': 'fa-file-audio',
  '.oga': 'fa-file-audio',
  '.aac': 'fa-file-audio',
  '.opus': 'fa-file-audio',

  // video
  '.mp4': 'fa-file-video',
  '.m4v': 'fa-file-video',
  '.webm': 'fa-file-video',
  '.mov': 'fa-file-video',
  '.mkv': 'fa-file-video',

  // pdf
  '.pdf': 'fa-file-pdf',

  // archives
  '.zip': 'fa-file-zipper',
  '.tar': 'fa-file-zipper',
  '.gz': 'fa-file-zipper',
  '.bz2': 'fa-file-zipper',
  '.xz': 'fa-file-zipper',
  '.7z': 'fa-file-zipper',
};

/** The icon glyph for a file's name — by suffix, falling back to a
 *  plain `fa-file` for anything unrecognised. */
export function iconClassForFile(name) {
  if (typeof name !== 'string') return 'fa-file';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'fa-file';
  return ICON_FOR_SUFFIX[name.slice(dot).toLowerCase()] ?? 'fa-file';
}

/** Join a directory absolute path with a child name. We don't import
 *  Node's path module — this is renderer code. Forward-slash only;
 *  the host already normalises paths. */
export function joinPath(parent, child) {
  if (parent.endsWith('/')) return parent + child;
  return `${parent}/${child}`;
}

/**
 * Create the directory tree-view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(path: string) => Array<{name: string, kind: string}> | null} [options.listDirectory] -
 *   Synchronously read a directory. Called as the user expands folders.
 *   Returns null on read failure; the view shows an error row in place
 *   of the children.
 * @param {(path: string) => void} [options.openPath] - Called when the
 *   user activates a non-directory entry (click, Enter). The host routes
 *   it through the same `open-file-path!` flow as the REPL.
 * @param {(key: string) => boolean} [options.onKey] - Chord-key passthrough
 *   to the global Lisp keymap, like the other custom views.
 * @param {() => void} [options.closeBuffer] - Called when the user
 *   presses `q` to dismiss the buffer.
 * @returns {{element: HTMLElement, setBuffer: (buffer: object | null)
 *   => void, focus: () => void}}
 */
function createDirectoryTreeView(container, options = {}) {
  const doc = container.ownerDocument;
  const listDirectory =
    typeof options.listDirectory === 'function' ? options.listDirectory : null;
  const openPath =
    typeof options.openPath === 'function' ? options.openPath : null;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const closeBuffer =
    typeof options.closeBuffer === 'function' ? options.closeBuffer : null;

  const root = doc.createElement('div');
  root.className = 'directory-tree-view';
  root.tabIndex = 0;
  container.append(root);

  const header = doc.createElement('div');
  header.className = 'directory-tree-header';
  const headerIcon = doc.createElement('i');
  headerIcon.className = 'fa-solid fa-folder-tree';
  const headerLabel = doc.createElement('span');
  headerLabel.className = 'directory-tree-header-label';
  header.append(headerIcon, headerLabel);
  root.append(header);

  const body = doc.createElement('div');
  body.className = 'directory-tree-body';
  root.append(body);

  /** Buffer currently shown, or `null`. */
  let buffer = null;
  /** Index of the keyboard-focused row in the rendered list, or -1. */
  let selectedIndex = -1;
  /** Flattened row list — kept in sync with the rendered DOM so up/down
   *  arrows can step through it without re-querying. */
  let rows = [];

  /** Toggle expansion of a folder at `path`. The view's `buffer.expanded`
   *  is the source of truth; we just flip membership and repaint. */
  function toggleExpansion(path) {
    if (!buffer) return;
    if (!(buffer.expanded instanceof Set)) buffer.expanded = new Set();
    if (buffer.expanded.has(path)) buffer.expanded.delete(path);
    else buffer.expanded.add(path);
    paint();
  }

  /** Re-render the visible rows from the buffer's state. Folders that
   *  appear in `buffer.expanded` are shown with their children inline
   *  immediately below; clicking the chevron toggles. */
  function paint() {
    body.replaceChildren();
    rows = [];
    if (!buffer || typeof buffer.rootPath !== 'string' || buffer.rootPath === '') {
      headerLabel.textContent = '';
      return;
    }
    headerLabel.textContent = buffer.rootPath;
    appendDirectoryRows(buffer.rootPath, 0);
    clampSelection();
    highlightSelected();
  }

  /** Recursively render a directory's children. Stops at folders the
   *  user hasn't expanded. Reads the listing on demand via the host
   *  primitive, so a 10k-file repo opens at the root with O(1) DOM. */
  function appendDirectoryRows(path, depth) {
    const entries = listDirectory ? listDirectory(path) : null;
    if (entries === null) {
      const errRow = doc.createElement('div');
      errRow.className = 'directory-tree-error';
      errRow.style.paddingLeft = `${depth * 18 + 28}px`;
      errRow.textContent = '(unreadable)';
      body.append(errRow);
      return;
    }
    for (const entry of entries) {
      const entryPath = joinPath(path, entry.name);
      const row = buildRow(entry, entryPath, depth);
      body.append(row);
      rows.push({ path: entryPath, kind: entry.kind, broken: entry.broken === true });
      if (
        entry.kind === 'directory' &&
        buffer.expanded instanceof Set &&
        buffer.expanded.has(entryPath)
      ) {
        appendDirectoryRows(entryPath, depth + 1);
      }
    }
  }

  /** Build one row's DOM. The indent uses padding rather than nested
   *  containers so the DOM is flat — N rows, all at the same level. */
  function buildRow(entry, entryPath, depth) {
    const row = doc.createElement('div');
    row.className = 'directory-tree-row';
    row.dataset.path = entryPath;
    row.dataset.kind = entry.kind;
    if (entry.isSymlink) {
      row.dataset.symlink = entry.broken ? 'broken' : 'true';
      // Hover reveals where the link points. Broken links keep the
      // target text so the user can see what's missing.
      row.title = entry.target ? `→ ${entry.target}` : '→ (unreadable)';
    }
    row.style.paddingLeft = `${depth * 18}px`;

    const chevron = doc.createElement('i');
    chevron.className = 'directory-tree-chevron fa-solid fa-chevron-right';
    if (entry.kind !== 'directory') chevron.classList.add('is-hidden');
    const isOpen =
      entry.kind === 'directory' &&
      buffer.expanded instanceof Set &&
      buffer.expanded.has(entryPath);
    if (isOpen) chevron.classList.add('is-open');
    row.append(chevron);

    const baseIconClass = entry.kind === 'directory'
      ? (isOpen ? 'fa-folder-open' : 'fa-folder')
      : entry.kind === 'other'
        ? 'fa-file-circle-question'
        : iconClassForFile(entry.name);

    if (entry.isSymlink) {
      // Stack: the target's icon as the base, an SVG circle-arrow
      // badge stamped in the bottom-right corner. The wrapper takes
      // the same horizontal slot as the standalone .directory-tree-icon,
      // so symlink rows align with non-symlink rows.
      const stack = doc.createElement('span');
      stack.className = 'directory-tree-icon-stack';
      const base = doc.createElement('i');
      base.className = `directory-tree-icon fa-solid ${baseIconClass}`;
      stack.append(base);
      stack.append(createSymlinkBadge(doc, 'directory-tree-symlink'));
      row.append(stack);
    } else {
      const icon = doc.createElement('i');
      icon.className = `directory-tree-icon fa-solid ${baseIconClass}`;
      row.append(icon);
    }

    const label = doc.createElement('span');
    label.className = 'directory-tree-name';
    label.textContent = entry.name;
    row.append(label);

    return row;
  }

  /** Activate a row — toggle the chevron for a folder, route to the
   *  host's openPath for anything else. Used by both click and Enter.
   *  Broken symlinks are inert: there's nothing on the other end. */
  function activateRow(idx) {
    const row = rows[idx];
    if (!row || row.broken) return;
    if (row.kind === 'directory') {
      toggleExpansion(row.path);
    } else if (openPath) {
      openPath(row.path);
    }
  }

  function highlightSelected() {
    const all = body.querySelectorAll('.directory-tree-row');
    for (let i = 0; i < all.length; i++) {
      all[i].classList.toggle('is-selected', i === selectedIndex);
    }
    if (selectedIndex >= 0 && selectedIndex < all.length) {
      const el = all[selectedIndex];
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function clampSelection() {
    if (rows.length === 0) {
      selectedIndex = -1;
    } else if (selectedIndex < 0) {
      selectedIndex = 0;
    } else if (selectedIndex >= rows.length) {
      selectedIndex = rows.length - 1;
    }
  }

  // Click — single click selects the row. Folders still toggle on
  // single click (matches Finder / VS Code Explorer convention).
  // Files open on double-click (see dblclick handler below), bringing
  // them in line with the directory-columns view's open-on-double-
  // click semantics.
  body.addEventListener('click', (event) => {
    const row = event.target.closest('.directory-tree-row');
    if (!row) return;
    const idx = Array.from(body.children).indexOf(row);
    if (idx < 0) return;
    selectedIndex = idx;
    const rowData = rows[idx];
    if (rowData && rowData.kind === 'directory' && event.detail <= 1) {
      // Folder + first click of the sequence: toggle expansion. Skip
      // on event.detail >= 2 so a quick double-click doesn't toggle
      // twice. (event.detail is 0 for programmatic clicks from the
      // smoke harness; treat those as a normal single click.)
      activateRow(idx);
    } else {
      highlightSelected();
    }
  });

  // Double-click — opens files (folders are handled by single click).
  body.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.directory-tree-row');
    if (!row) return;
    const idx = Array.from(body.children).indexOf(row);
    if (idx < 0) return;
    selectedIndex = idx;
    const rowData = rows[idx];
    if (rowData && !rowData.broken && rowData.kind !== 'directory' && openPath) {
      openPath(rowData.path);
    }
  });

  // Key handling: arrows step selection, Enter activates, Space
  // toggles the current folder, q closes. Chord keys still route
  // through the global keymap.
  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    if (FORM_TAGS.has(event.target.tagName)) return;
    const key = keyEventToString(event);

    if (event.ctrlKey || event.metaKey || event.altKey) {
      if (onKey && onKey(key)) event.preventDefault();
      return;
    }

    if (key === 'ArrowDown' || key === 'down') {
      event.preventDefault();
      if (rows.length === 0) return;
      selectedIndex = Math.min(selectedIndex + 1, rows.length - 1);
      highlightSelected();
      return;
    }
    if (key === 'ArrowUp' || key === 'up') {
      event.preventDefault();
      if (rows.length === 0) return;
      selectedIndex = Math.max(selectedIndex - 1, 0);
      highlightSelected();
      return;
    }
    if (key === 'Enter' || key === 'enter') {
      event.preventDefault();
      if (selectedIndex >= 0) activateRow(selectedIndex);
      return;
    }
    if (key === ' ' || key === 'space') {
      event.preventDefault();
      // Space toggles the current folder; on a file it acts like Enter.
      if (selectedIndex >= 0) activateRow(selectedIndex);
      return;
    }
    if (key === 'q') {
      event.preventDefault();
      if (closeBuffer) closeBuffer();
      return;
    }
    // Any other plain printable: swallow so it doesn't reach
    // handle-key and self-insert into a text buffer behind us.
    if (key.length === 1) {
      event.preventDefault();
      return;
    }
    if (onKey && onKey(key)) event.preventDefault();
  });

  /**
   * Show a directory-tree buffer.
   *
   * @param {object | null} next
   */
  function setBuffer(next) {
    buffer = next;
    if (buffer && !(buffer.expanded instanceof Set)) {
      buffer.expanded = new Set();
    }
    selectedIndex = buffer ? 0 : -1;
    paint();
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
  };
}

// -----------------------------------------------------------------------
// `<directory-tree-view>` — Phase 3g custom-element wrapper.

import { defineViewElement, ViewElement } from './view-elements.js';

/** @typedef {object} DirectoryTreeViewOptions */

export class DirectoryTreeView extends ViewElement {
  constructor() {
    super();
    /** @type {ReturnType<typeof createDirectoryTreeView> | null} */
    this._inner = null;
    /** @type {DirectoryTreeViewOptions | null} */
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('DirectoryTreeView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() { return 'directory-tree'; }

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
    this._inner = createDirectoryTreeView(this, this._options ?? {});
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

defineViewElement('directory-tree-view', DirectoryTreeView);
