/**
 * @file path-resolve.js — pure POSIX-style path string helpers.
 *
 * The app runs on macOS / Linux, so `/` is the only separator and
 * there is no Windows drive handling. These are string operations
 * only: they never touch the filesystem, so they are safe to unit-test
 * and to call from the synchronous Lisp interpreter.
 *
 * RefTeX uses these to walk `\input` / `\include` chains relative to a
 * master file, e.g.
 *
 *     (path-resolve (path-dirname master) "chapters/intro.tex")
 */

/**
 * Normalise a POSIX path: collapse `.` and `..` segments and runs of
 * `/`. Preserves leading-`/` absoluteness and a trailing slash is
 * dropped (except for the root `/`).
 *
 * A relative path that resolves above its start keeps the leading
 * `..` segments (`"a/../../b"` → `"../b"`). An absolute path that
 * tries to go above root simply stays at root (`"/.."` → `"/"`).
 *
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  const isAbsolute = path.startsWith('/');
  const parts = path.split('/');
  /** @type {string[]} */
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (!isAbsolute) {
        // A relative path may climb above its origin.
        out.push('..');
      }
      // An absolute path at root ignores extra `..`.
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  if (isAbsolute) return '/' + joined;
  return joined === '' ? '.' : joined;
}

/**
 * The directory portion of a path — everything up to (not including)
 * the final component, with no trailing slash.
 *
 *   - `"/a/b/c"`  → `"/a/b"`
 *   - `"/a/b/c/"` → `"/a/b"`   (a trailing slash is ignored)
 *   - `"a/b"`     → `"a"`
 *   - `"a"`       → `"."`      (a bare name has no directory)
 *   - `"/"`       → `"/"`
 *   - `"/a"`      → `"/"`
 *   - `""`        → `"."`
 *
 * @param {string} path
 * @returns {string}
 */
export function pathDirname(path) {
  if (path === '') return '.';
  // Drop a single trailing slash (but keep the root "/").
  let p = path;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const idx = p.lastIndexOf('/');
  if (idx === -1) return '.';
  if (idx === 0) return '/';
  return p.slice(0, idx);
}

/**
 * The final component of a path.
 *
 *   - `"/a/b/c"`  → `"c"`
 *   - `"/a/b/c/"` → `"c"`   (a trailing slash is ignored)
 *   - `"a"`       → `"a"`
 *   - `"/"`       → `""`
 *   - `""`        → `""`
 *
 * @param {string} path
 * @returns {string}
 */
export function pathBasename(path) {
  if (path === '') return '';
  let p = path;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '/') return '';
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Resolve `relative` against `baseDir` (treated as a directory),
 * normalising `.` and `..`. When `relative` is itself absolute it is
 * returned normalised and `baseDir` is ignored.
 *
 *   - `("/a/b", "c.tex")`      → `"/a/b/c.tex"`
 *   - `("/a/b", "../c.tex")`   → `"/a/c.tex"`
 *   - `("/a/b", "./c.tex")`    → `"/a/b/c.tex"`
 *   - `("/a/b", "/x/y.tex")`   → `"/x/y.tex"`  (absolute passthrough)
 *   - `("", "c.tex")`          → `"c.tex"`
 *
 * @param {string} baseDir
 * @param {string} relative
 * @returns {string}
 */
export function pathResolve(baseDir, relative) {
  if (relative.startsWith('/')) {
    return normalizePath(relative);
  }
  const base = baseDir === '' ? '' : baseDir;
  const combined = base === '' ? relative : `${base}/${relative}`;
  return normalizePath(combined);
}
