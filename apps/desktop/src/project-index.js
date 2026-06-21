/**
 * @file Pure helpers for the central project index — the catalogue of
 * known projects that the Project Chooser lists. Kept free of any host /
 * DOM / Node dependency so it can run in the renderer and be unit-tested
 * directly. The index itself is a plain
 * `{ projects: [{ path, name, thumbnail? }] }` object persisted via the
 * host's `project:index-*` channels; these helpers only shape the list.
 *
 * An entry's optional `thumbnail` is an absolute path to an image the user
 * chose for that project's tile in the chooser (vs the generated letter
 * tile). It is preserved across re-opens (see `upsertProject`).
 */

/**
 * The display name for a project: the last path segment of ROOT (its
 * folder name). Trailing slashes are ignored. Returns '' for an empty or
 * non-string root. Implemented with string ops (not `node:path`) so the
 * module stays importable from the renderer.
 *
 * @param {string} root - A project's absolute root directory.
 * @returns {string}
 */
export function projectNameFromRoot(root) {
  if (typeof root !== 'string' || root === '') return '';
  const trimmed = root.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return name === '' ? trimmed : name;
}

/** Normalise a root for comparison: trailing slashes removed. */
function normaliseRoot(root) {
  return typeof root === 'string' ? root.replace(/\/+$/, '') : '';
}

/** A well-shaped index entry has a string `path`. */
function isEntry(p) {
  return p && typeof p === 'object' && typeof p.path === 'string';
}

/**
 * Insert (or refresh) ROOT at the front of the known-projects LIST, deduped
 * by path so a re-opened project moves to the front rather than
 * duplicating — most-recently-opened first. Returns a NEW array; the input
 * is never mutated. A blank root yields a copy of the list (malformed
 * entries dropped) unchanged. Trailing slashes on ROOT are normalised away
 * so `/p` and `/p/` are the same project.
 *
 * An existing entry's extra fields (notably `thumbnail`) are preserved when
 * it moves to the front; a NAME argument overrides, else the existing name
 * is kept, else the folder name is derived.
 *
 * @param {Array<{path: string, name?: string, thumbnail?: string}>} list
 * @param {string} root - The project root to promote.
 * @param {string} [name] - Display name; defaults to the existing/derived.
 * @returns {Array<{path: string, name: string, thumbnail?: string}>}
 */
export function upsertProject(list, root, name) {
  const base = Array.isArray(list) ? list : [];
  const cleanRoot = normaliseRoot(root);
  if (cleanRoot === '') return base.filter(isEntry);
  const existing = base.find((p) => isEntry(p) && normaliseRoot(p.path) === cleanRoot);
  const entry = {
    ...(existing ?? {}),
    path: cleanRoot,
    name: (typeof name === 'string' && name !== '')
      ? name
      : (existing && existing.name)
        ? existing.name
        : projectNameFromRoot(cleanRoot),
  };
  const rest = base.filter((p) => isEntry(p) && normaliseRoot(p.path) !== cleanRoot);
  return [entry, ...rest];
}

/**
 * Set (or clear) ROOT's custom thumbnail in LIST without reordering.
 * Passing a null/empty THUMBNAIL clears it (the entry falls back to the
 * generated letter tile). Returns a NEW array; the input is not mutated. A
 * root not present in the list is a no-op (returns a cleaned copy).
 *
 * @param {Array<object>} list
 * @param {string} root
 * @param {string|null} thumbnail - Absolute image path, or null to clear.
 * @returns {Array<object>}
 */
export function setProjectThumbnail(list, root, thumbnail) {
  const base = Array.isArray(list) ? list : [];
  const cleanRoot = normaliseRoot(root);
  const clean = base.filter(isEntry);
  if (cleanRoot === '') return clean;
  return clean.map((p) => {
    if (normaliseRoot(p.path) !== cleanRoot) return p;
    const next = { ...p };
    if (thumbnail === null || thumbnail === undefined || thumbnail === '') {
      delete next.thumbnail;
    } else {
      next.thumbnail = thumbnail;
    }
    return next;
  });
}

/**
 * Filter LIST to the projects whose name or path contains QUERY
 * (case-insensitive, trimmed). A blank query returns every well-shaped
 * entry. Order is preserved.
 *
 * @param {Array<object>} list
 * @param {string} query
 * @returns {Array<object>}
 */
export function filterProjects(list, query) {
  const clean = (Array.isArray(list) ? list : []).filter(isEntry);
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return clean;
  return clean.filter(
    (p) =>
      String(p.name ?? '').toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q)
  );
}

/**
 * The generated tile appearance for a project with no custom thumbnail:
 * up-to-two-character initials and a deterministic colour derived from the
 * name (same name → same colour, always). Mirrors Nova's letter tiles. The
 * colour is an HSL string at a fixed saturation/lightness picked to read
 * with white text in both light and dark themes.
 *
 * @param {string} name - The project's display name.
 * @returns {{ initials: string, hue: number, bg: string, fg: string }}
 */
export function projectTileAppearance(name) {
  const label = String(name ?? '').trim();
  const words = label.split(/[\s._/\-]+/).filter(Boolean);
  let initials;
  if (words.length >= 2) {
    initials = words[0][0] + words[1][0];
  } else if (words.length === 1) {
    initials = words[0].slice(0, 2);
  } else {
    initials = '?';
  }
  initials = initials.toUpperCase();
  // A small deterministic string hash → hue. (djb2-ish, kept in 32-bit.)
  let hash = 5381;
  for (let i = 0; i < label.length; i += 1) {
    hash = ((hash * 33) ^ label.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return {
    initials,
    hue,
    bg: `hsl(${hue} 42% 44%)`,
    fg: '#ffffff',
  };
}
