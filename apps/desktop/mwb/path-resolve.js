/**
 * @file Pure path resolution for the Model-B server's find-file / write-file.
 *
 * Extracted from server.js so it is unit-testable without booting the server
 * (server.js has utilityProcess side-effects on import). The server is a Node
 * child, so it resolves a user-typed path to an absolute one itself: a leading
 * `~` / `~/…` expands to the home directory (the shell convention the renderer
 * also honours via `host.homeDirectory`), an absolute path passes through, and
 * a bare relative path resolves against the seed-file directory.
 */

import { join, resolve } from 'node:path';

/**
 * Resolve a user-typed find-file/write-file PATH to an absolute path.
 *   - `~`        → HOME
 *   - `~/sub`    → HOME/sub
 *   - `/abs`     → unchanged (absolute)
 *   - `rel`      → BASEDIR/rel
 * `~user` is NOT expanded (only the current-user `~`); it falls through as a
 * literal segment, matching how we don't resolve other users' homes.
 *
 * @param {string} path  the raw value typed at the minibuffer
 * @param {string} baseDir  the directory relative paths resolve against
 * @param {string} home  the home directory (`os.homedir()`)
 * @returns {string} an absolute path
 */
export function resolveUserPath(path, baseDir, home) {
  let p = String(path ?? '');
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = join(home, p.slice(2));
  return resolve(baseDir, p);
}
