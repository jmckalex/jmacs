/**
 * @file Pure argument / environment builders for the JMarkdown preview watcher.
 *
 * Split out from jmarkdown-watch.js (which imports `electron` and so can't load
 * under a plain `node --test`) so these pure pieces stay unit-testable. The
 * spawn / port-probe / reaping I/O lives in jmarkdown-watch.js and is verified
 * live against a real watch server.
 */

import { dirname, basename, extname, join } from 'node:path';

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
 * The shadow (preview sidecar) path for a source file: a hidden sibling in the
 * SAME directory, so relative resources in the metadata header (`CSS:`,
 * `Bibliography:`, images, `[[includes]]`) resolve exactly as they do for the
 * real file. The debounced live preview writes the current buffer text here and
 * points `jmarkdown watch` at it, so the user's real file is never touched until
 * they actually save. The `.godot-preview` infix keeps it out of the way and
 * easy to `.gitignore` (`.*.godot-preview.*`); the original extension is kept so
 * `jmarkdown` treats `.jmd` vs `.md` identically to the source.
 *
 * @param {string} filePath - Absolute path of the real source file.
 * @returns {string}
 */
export function shadowPathFor(filePath) {
  const ext = extname(filePath);
  const base = basename(filePath, ext);
  return join(dirname(filePath), `.${base}.godot-preview${ext}`);
}

/**
 * The build-output sibling `jmarkdown watch` may emit next to the shadow (a
 * `<name>.html`), swept on teardown so a preview leaves nothing behind.
 *
 * @param {string} shadowPath
 * @returns {string}
 */
export function shadowHtmlSibling(shadowPath) {
  const ext = extname(shadowPath);
  const base = basename(shadowPath, ext);
  return join(dirname(shadowPath), `${base}.html`);
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
