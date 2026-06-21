/**
 * @file The Project Chooser — a Nova-style launcher modal. A centered
 * dialog (fixed-position, appended to <body>, dark backdrop) showing a grid
 * of known projects as thumbnail tiles, a search field, and Open / Add
 * actions. Click a tile to open that project; Escape / backdrop / × to
 * dismiss. Modelled on the directory-columns / colour-picker modal pattern
 * (capture-phase keydown, backdrop-click dismiss), not the pane/view system
 * — the chooser is transient and never part of a saved workspace.
 *
 * This module only builds the DOM and wires interaction; every side effect
 * (open a project, pick a directory, set a thumbnail, read a thumbnail
 * image) is a host-supplied callback in `options`, so the module stays free
 * of host/IPC knowledge. The pure tile/search helpers come from
 * `project-index.js`.
 */

import {
  filterProjects,
  projectTileAppearance,
} from './project-index.js';

/** The single open chooser, so a second invocation replaces (not stacks). */
let current = null;

/**
 * Open the Project Chooser modal. Returns a handle with `close()`. Opening
 * while one is already open closes the previous instance first.
 *
 * @param {Object} options
 * @param {() => Array<{path: string, name: string, thumbnail?: string}>}
 *   options.getProjects - The known projects (most-recent-first).
 * @param {(path: string) => void} options.openProject - Open a project by
 *   root path. The chooser closes itself just before calling this.
 * @param {() => void} [options.openFolder] - Show a directory picker and
 *   open the chosen folder as a project (the chooser closes first).
 * @param {() => Promise<Array|null>} [options.addProject] - Pick a directory
 *   and add it to the index WITHOUT opening; resolve to the updated project
 *   list (or null if cancelled). The grid re-renders with the result.
 * @param {(path: string) => Promise<Array|null>} [options.pickThumbnail] -
 *   Pick a custom thumbnail image for a project; resolve to the updated list
 *   (or null if cancelled).
 * @param {(path: string) => Promise<Array>} [options.removeProject] - Drop a
 *   project from the index; resolve to the updated list.
 * @param {(imagePath: string) => Promise<string|null>} [options.loadThumbnail]
 *   - Read a thumbnail image path as a displayable data URL (or null).
 * @returns {{ close: () => void }}
 */
export function openProjectChooser(options = {}) {
  if (current) current.close();

  const doc = document;
  const getProjects =
    typeof options.getProjects === 'function' ? options.getProjects : () => [];
  const openProject =
    typeof options.openProject === 'function' ? options.openProject : null;
  const openFolder =
    typeof options.openFolder === 'function' ? options.openFolder : null;
  const addProject =
    typeof options.addProject === 'function' ? options.addProject : null;
  const pickThumbnail =
    typeof options.pickThumbnail === 'function' ? options.pickThumbnail : null;
  const removeProject =
    typeof options.removeProject === 'function' ? options.removeProject : null;
  const loadThumbnail =
    typeof options.loadThumbnail === 'function' ? options.loadThumbnail : null;

  /** @type {Array<object>} live project list (updated by actions). */
  let projects = (getProjects() || []).filter(
    (p) => p && typeof p.path === 'string'
  );
  /** Filtered view of `projects` for the current query. */
  let shown = projects.slice();
  /** Index into `shown` of the keyboard-selected tile. */
  let selected = 0;
  /** Bumped on every render so async thumbnail loads from a stale render
   *  don't paint over a newer one. */
  let renderToken = 0;

  // --- DOM scaffold -----------------------------------------------------
  const overlay = doc.createElement('div');
  overlay.className = 'project-chooser-overlay';

  const dialog = doc.createElement('div');
  dialog.className = 'project-chooser';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'Project Chooser');
  overlay.append(dialog);

  // Header: title + close button.
  const header = doc.createElement('div');
  header.className = 'project-chooser-header';
  const title = doc.createElement('div');
  title.className = 'project-chooser-title';
  title.textContent = 'Projects';
  const closeBtn = doc.createElement('button');
  closeBtn.className = 'project-chooser-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×'; // ×
  header.append(title, closeBtn);

  // Action row: Open Folder… / Add Project…
  const actions = doc.createElement('div');
  actions.className = 'project-chooser-actions';
  if (openFolder) {
    const openBtn = doc.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'project-chooser-action';
    openBtn.textContent = 'Open Folder…';
    openBtn.addEventListener('click', () => {
      close();
      openFolder();
    });
    actions.append(openBtn);
  }
  if (addProject) {
    const addBtn = doc.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'project-chooser-action';
    addBtn.textContent = 'Add Project…';
    addBtn.addEventListener('click', async () => {
      const next = await addProject();
      if (next) {
        projects = next.filter((p) => p && typeof p.path === 'string');
        applyFilter();
      }
      search.focus();
    });
    actions.append(addBtn);
  }

  // Search field.
  const search = doc.createElement('input');
  search.type = 'text';
  search.className = 'project-chooser-search';
  search.placeholder = 'Search projects…';
  search.setAttribute('aria-label', 'Search projects');
  search.addEventListener('input', () => {
    applyFilter();
  });

  // The grid (and an empty-state message that swaps in when nothing shows).
  const grid = doc.createElement('div');
  grid.className = 'project-chooser-grid';

  dialog.append(header, actions, search, grid);
  doc.body.append(overlay);

  // --- rendering --------------------------------------------------------

  function applyFilter() {
    shown = filterProjects(projects, search.value);
    if (selected >= shown.length) selected = Math.max(0, shown.length - 1);
    render();
  }

  function render() {
    renderToken += 1;
    const token = renderToken;
    grid.replaceChildren();

    if (shown.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'project-chooser-empty';
      empty.textContent = projects.length === 0
        ? 'No projects yet. Use Open Folder… or Add Project… to begin.'
        : 'No projects match your search.';
      grid.append(empty);
      return;
    }

    shown.forEach((proj, i) => {
      const card = doc.createElement('div');
      card.className = 'project-chooser-card';
      if (i === selected) card.classList.add('is-selected');
      card.dataset.path = proj.path;
      card.tabIndex = -1;

      // Tile: custom thumbnail, else a generated letter tile.
      const tile = doc.createElement('div');
      tile.className = 'project-chooser-tile';
      const appearance = projectTileAppearance(proj.name ?? '');
      paintLetterTile(tile, appearance);
      if (proj.thumbnail && loadThumbnail) {
        loadThumbnail(proj.thumbnail).then((dataUrl) => {
          if (token !== renderToken) return; // a newer render superseded us
          if (!dataUrl) return; // keep the letter-tile fallback
          tile.classList.add('has-image');
          tile.style.backgroundColor = '';
          tile.textContent = '';
          const img = doc.createElement('img');
          img.className = 'project-chooser-thumb';
          img.alt = proj.name ?? '';
          img.src = dataUrl;
          tile.append(img);
        }).catch(() => {});
      }

      // Per-card hover affordances (set thumbnail / remove).
      const tools = doc.createElement('div');
      tools.className = 'project-chooser-card-tools';
      if (pickThumbnail) {
        const thumbBtn = doc.createElement('button');
        thumbBtn.type = 'button';
        thumbBtn.className = 'project-chooser-tool';
        thumbBtn.title = 'Set thumbnail…';
        thumbBtn.textContent = '\u{1F4F7}'; // 📷
        thumbBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const next = await pickThumbnail(proj.path);
          if (next) {
            projects = next.filter((p) => p && typeof p.path === 'string');
            applyFilter();
          }
        });
        tools.append(thumbBtn);
      }
      if (removeProject) {
        const rmBtn = doc.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 'project-chooser-tool';
        rmBtn.title = 'Remove from list';
        rmBtn.textContent = '✕'; // ✕
        rmBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const next = await removeProject(proj.path);
          if (next) {
            projects = next.filter((p) => p && typeof p.path === 'string');
            applyFilter();
          }
        });
        tools.append(rmBtn);
      }
      tile.append(tools);

      const name = doc.createElement('div');
      name.className = 'project-chooser-name';
      name.textContent = proj.name ?? '';
      name.title = proj.path;

      card.append(tile, name);
      card.addEventListener('click', () => choose(i));
      grid.append(card);
    });
  }

  /** Paint TILE as a coloured letter tile from APPEARANCE. */
  function paintLetterTile(tile, appearance) {
    tile.classList.remove('has-image');
    tile.style.backgroundColor = appearance.bg;
    tile.style.color = appearance.fg;
    tile.textContent = appearance.initials;
  }

  // --- selection + keyboard --------------------------------------------

  function updateSelectionClass() {
    const cards = grid.querySelectorAll('.project-chooser-card');
    cards.forEach((c, i) => c.classList.toggle('is-selected', i === selected));
    const active = cards[selected];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  /** Number of tiles in the first row — the grid's column count. */
  function columnCount() {
    const cards = grid.querySelectorAll('.project-chooser-card');
    if (cards.length === 0) return 1;
    const top = cards[0].offsetTop;
    let cols = 0;
    for (const c of cards) {
      if (c.offsetTop !== top) break;
      cols += 1;
    }
    return Math.max(1, cols);
  }

  function moveSelection(delta) {
    if (shown.length === 0) return;
    selected = Math.max(0, Math.min(shown.length - 1, selected + delta));
    updateSelectionClass();
  }

  function choose(index) {
    const proj = shown[index];
    if (!proj || !openProject) return;
    close();
    openProject(proj.path);
  }

  function onKeydown(ev) {
    switch (ev.key) {
      case 'Escape':
        ev.preventDefault();
        ev.stopPropagation();
        close();
        return;
      case 'Enter':
        ev.preventDefault();
        ev.stopPropagation();
        choose(selected);
        return;
      case 'ArrowRight':
        ev.preventDefault();
        moveSelection(1);
        return;
      case 'ArrowLeft':
        ev.preventDefault();
        moveSelection(-1);
        return;
      case 'ArrowDown':
        ev.preventDefault();
        moveSelection(columnCount());
        return;
      case 'ArrowUp':
        ev.preventDefault();
        moveSelection(-columnCount());
        return;
      default:
        // Everything else (typing) flows to the focused search input.
        return;
    }
  }

  // Capture phase so Escape / arrows / Enter are handled before the editor's
  // global key dispatcher (which bails on defaultPrevented and on inputs).
  doc.addEventListener('keydown', onKeydown, true);

  // Backdrop click (outside the dialog) dismisses.
  overlay.addEventListener('mousedown', (ev) => {
    if (ev.target === overlay) close();
  });
  closeBtn.addEventListener('click', () => close());

  // --- teardown ---------------------------------------------------------

  let alive = true;
  function close() {
    if (!alive) return;
    alive = false;
    doc.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    if (current === handle) current = null;
  }

  const handle = { close };
  current = handle;

  // Initial paint + focus the search box.
  applyFilter();
  search.focus();

  return handle;
}

/** Close any open chooser (e.g. on teardown). */
export function closeProjectChooser() {
  if (current) current.close();
}
