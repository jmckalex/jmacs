/**
 * @file Pure argument / environment builders for the JMarkdown preview watcher.
 *
 * Split out from jmarkdown-watch.js (which imports `electron` and so can't load
 * under a plain `node --test`) so these pure pieces stay unit-testable. The
 * spawn / port-probe / reaping I/O lives in jmarkdown-watch.js and is verified
 * live against a real watch server.
 */

/**
 * The spawn args for `jmarkdown watch <file> --port <port>`.
 *
 * @param {string} filePath - Absolute path of the file to preview.
 * @param {number} port
 * @returns {string[]}
 */
export function buildWatchArgs(filePath, port) {
  return ['watch', filePath, '--port', String(port)];
}

/**
 * A spawn env whose PATH also includes the common Homebrew / local-bin
 * locations, so `jmarkdown` resolves even when Electron inherited a minimal
 * PATH (a Finder-launched app on macOS doesn't get the login-shell PATH).
 * Existing PATH entries keep priority; the extras are appended once.
 *
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function watchEnv(baseEnv) {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin'];
  const current = String(baseEnv.PATH ?? '').split(':').filter(Boolean);
  const merged = [...current, ...extra.filter((p) => !current.includes(p))];
  return { ...baseEnv, PATH: merged.join(':') };
}
