/**
 * @file Pure helpers for the central project index — the catalogue of
 * known projects that the (future) Project Chooser lists. Kept free of
 * any host / DOM / Node dependency so it can run in the renderer and be
 * unit-tested directly. The index itself is a plain
 * `{ projects: [{ path, name }] }` object persisted via the host's
 * `project:index-*` channels; these helpers only shape the list.
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

/**
 * Insert (or refresh) ROOT at the front of the known-projects LIST,
 * deduped by path so a re-opened project moves to the front rather than
 * duplicating — most-recently-opened first. Returns a NEW array; the
 * input is never mutated. A blank root yields a copy of the list
 * unchanged. Trailing slashes on ROOT are normalised away so
 * `/p` and `/p/` are the same project.
 *
 * @param {Array<{path: string, name?: string}>} list - The current index.
 * @param {string} root - The project root to promote.
 * @param {string} [name] - Display name; defaults to ROOT's folder name.
 * @returns {Array<{path: string, name: string}>}
 */
export function upsertProject(list, root, name) {
  const base = Array.isArray(list) ? list : [];
  const cleanRoot = typeof root === 'string' ? root.replace(/\/+$/, '') : '';
  if (cleanRoot === '') {
    return base.filter((p) => p && typeof p.path === 'string');
  }
  const entry = {
    path: cleanRoot,
    name: (typeof name === 'string' && name !== '')
      ? name
      : projectNameFromRoot(cleanRoot),
  };
  const rest = base.filter(
    (p) => p && typeof p.path === 'string' && p.path.replace(/\/+$/, '') !== cleanRoot
  );
  return [entry, ...rest];
}
