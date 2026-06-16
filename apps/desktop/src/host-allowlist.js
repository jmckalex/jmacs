/**
 * @file The `__host__` route's directory allowlist — the electron-free
 * core, so it can be unit-tested without the renderer or Electron.
 *
 * The `app://editor/__host__/<abs path>` route (serve.js) lets the
 * renderer fetch a local file same-origin — needed for the PDF view and
 * the Markdown preview's relative images. Unrestricted, it would read
 * *any* path, so a script in a document you open could
 * `fetch('app://editor/__host__/etc/passwd')` and exfiltrate it. This
 * module restricts the route to a set of directories the MAIN process has
 * vouched for (a file's folder on open, the app root, userData). The
 * renderer cannot add to the set, so an opened document can't widen its
 * own reach.
 */

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

/** Real-path directories the route may serve from. */
const hostRoots = new Set();

/**
 * Permit the route to serve files anywhere under DIR. The path is resolved
 * to its real location, so a symlink planted inside an allowed dir later
 * can't point the route outside it. Call only from trusted main-process
 * code; a non-string / unreadable dir is ignored.
 *
 * @param {string} dir
 */
export function allowHostDir(dir) {
  if (typeof dir !== 'string' || dir === '') return;
  try {
    hostRoots.add(realpathSync(dir));
  } catch {
    // Unreadable / nonexistent — nothing to allow.
  }
}

/**
 * Permit the route to serve FILEPATH specifically, by allowing its real
 * directory (symlinks resolved). For a file the user has explicitly
 * pointed the editor at whose *real* location lies outside any folder
 * they opened — e.g. bib-search loading a document's bibliography that is
 * a symlink to a shared `.bib` elsewhere. Referencing it is the user's
 * vouch; this is the file-level analogue of "opening a file vouches for
 * its folder". Note allowing the symlink's *containing* dir would not
 * help — `hostPathAllowed` resolves the symlink and checks the target,
 * so we must allow the target's real dir. Main-process only.
 *
 * @param {string} filePath
 */
export function allowHostFile(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return;
  try {
    allowHostDir(dirname(realpathSync(filePath)));
  } catch {
    // Unreadable / nonexistent — nothing to allow.
  }
}

/**
 * Whether ABSPATH is exactly one of ROOTS, or below a `root/` boundary —
 * so `/a/bee` is not treated as inside `/a/b`. Pure (no I/O), so the
 * boundary logic is unit-tested directly.
 *
 * @param {string} absPath
 * @param {Iterable<string>} roots
 * @returns {boolean}
 */
export function pathUnderAnyRoot(absPath, roots) {
  for (const root of roots) {
    if (absPath === root || absPath.startsWith(root + '/')) return true;
  }
  return false;
}

/**
 * Whether the route may serve ABSPATH: its real path (symlinks resolved)
 * must be inside an allowed root. False for a missing/unreadable path.
 *
 * @param {string} absPath
 * @returns {boolean}
 */
export function hostPathAllowed(absPath) {
  let real;
  try {
    real = realpathSync(absPath);
  } catch {
    return false;
  }
  return pathUnderAnyRoot(real, hostRoots);
}

/** Test-only: clear the allowlist between cases. */
export function resetHostRootsForTest() {
  hostRoots.clear();
}
