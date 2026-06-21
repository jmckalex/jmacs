/**
 * @file Material Icon Theme lookup for the directory tree. Maps a file or
 * folder name to one of the vendored Material SVGs
 * (apps/desktop/vendor/material-icons/ — the full material-icon-theme set,
 * MIT). The large mapping tables live in the generated
 * `material-icons-data.js`; this is the small pure lookup + URL builder. The
 * host (app.js) hands the resolved URL to the directory-tree element, which
 * renders the SVG; the renderer stays icon-source-agnostic.
 */
import { MATERIAL_ICONS as M } from './material-icons-data.js';

/** app:// base for the vendored SVGs (served from the repo root). */
const BASE = 'app://editor/apps/desktop/vendor/material-icons/';

/** Extension overrides for our own file kinds the upstream set doesn't cover.
 *  The icon names must already be vendored — these are (markdown, lisp). */
const EXT_OVERRIDES = {
  jmd: 'markdown', // JMarkdown
  rxlisp: 'lisp', // reactive Lisp notebook
  el: 'lisp', // Emacs Lisp
};

/**
 * The Material icon NAME for a file called NAME. An exact (lowercased)
 * filename wins (e.g. package.json, Dockerfile), then the longest extension
 * suffix (so `foo.test.js` → `test-js` before `javascript`), then the default
 * file icon.
 *
 * @param {string} name
 * @returns {string}
 */
export function materialFileIconName(name) {
  const lower = String(name == null ? '' : name).toLowerCase();
  const exact = M.fileNames[lower];
  if (exact) return exact;
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i += 1) {
    const ext = parts.slice(i).join('.');
    if (EXT_OVERRIDES[ext]) return EXT_OVERRIDES[ext];
    if (M.extensions[ext]) return M.extensions[ext];
  }
  return M.default;
}

/**
 * The Material icon NAME for a folder called NAME (its open variant when
 * EXPANDED). Per-name folder icons (folder-src, …) when the upstream set has
 * one, else the generic folder / folder-open.
 *
 * @param {string} name
 * @param {boolean} expanded
 * @returns {string}
 */
export function materialFolderIconName(name, expanded) {
  const lower = String(name == null ? '' : name).toLowerCase();
  if (expanded) return M.folderNamesExpanded[lower] || M.folderOpen;
  return M.folderNames[lower] || M.folder;
}

/**
 * The app:// URL of the SVG for icon NAME, or null.
 * @param {string} iconName
 * @returns {string|null}
 */
export function materialIconUrl(iconName) {
  if (!iconName) return null;
  const file = M.files[iconName] || `${iconName}.svg`;
  return BASE + file;
}

/**
 * The icon URL for a directory ENTRY — what the directory-tree's configure()
 * hands to the element.
 *
 * @param {string} name
 * @param {boolean} isDirectory
 * @param {boolean} expanded
 * @returns {string|null}
 */
export function materialIconUrlForEntry(name, isDirectory, expanded) {
  const iconName = isDirectory
    ? materialFolderIconName(name, expanded)
    : materialFileIconName(name);
  return materialIconUrl(iconName);
}
