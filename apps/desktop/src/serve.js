/**
 * @file The `app://` scheme — serving the repository's files to the
 * renderer. Shared by the main process and the smoke test.
 *
 * A privileged standard scheme gives the page a real, secure origin, so
 * native ES modules and import maps load without a bundler. Files are
 * served from the repository root.
 */

import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/desktop/src -> repository root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The URL of the editor page, served over the `app://` scheme. */
export const EDITOR_URL = 'app://editor/apps/desktop/index.html';

/** Content types for the file extensions the app actually serves. */
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

// Must run before the app is ready; importing this module is enough.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

/**
 * Handle an `app://editor/...` request by serving the matching
 * repo-relative file. Register with `protocol.handle('app', ...)` once
 * the app is ready.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function serveAppFile(request) {
  const { pathname } = new URL(request.url);
  const filePath = join(repoRoot, decodeURIComponent(pathname));
  // Refuse to serve anything outside the repository.
  if (filePath !== repoRoot && !filePath.startsWith(repoRoot + '/')) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? 'application/octet-stream';
    return new Response(data, { headers: { 'content-type': type } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
