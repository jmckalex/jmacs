/**
 * @file The `app://` scheme — serving the repository's files to the
 * renderer. Shared by the main process and the smoke test.
 *
 * A privileged standard scheme gives the page a real, secure origin, so
 * native ES modules and import maps load without a bundler. Files are
 * served from the repository root.
 */

import { net, protocol } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  '.woff2': 'font/woff2',
};

// Must run before the app is ready; importing this module is enough.
//
// `media` is a separate scheme for streaming arbitrary local files
// (audio files the jukebox plays, anywhere on disk). It needs `stream:
// true` so the <audio> element can issue Range requests and the
// playback head can advance without pre-buffering the whole file.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

/**
 * Handle an `app://…/…` request by serving the matching file. Two
 * hosts are supported:
 *
 *   - `app://editor/<path>` — the renderer's modules, the vendored
 *     tree-sitter assets, the editor page itself. Resolves to the
 *     repository root.
 *   - `app://docs/<path>` — the built documentation. Resolves to
 *     `docs/build/<path>`. Returns 404 when the docs haven't been
 *     built yet (no `docs/build/`).
 *
 * Register with `protocol.handle('app', ...)` once the app is ready.
 *
 * A URL ending with a slash and the query string `?list` returns a
 * JSON array of the directory's entries (bare names, no
 * directories). The language registry uses this to discover language
 * modules and Lisp mode files at startup.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function serveAppFile(request) {
  const url = new URL(request.url);
  const base = url.host === 'docs' ? join(repoRoot, 'docs', 'build') : repoRoot;
  const filePath = join(base, decodeURIComponent(url.pathname));
  // Refuse to serve anything outside the host's base.
  if (filePath !== base && !filePath.startsWith(base + '/')) {
    return new Response('Forbidden', { status: 403 });
  }
  if (url.pathname.endsWith('/') && url.searchParams.has('list')) {
    try {
      const entries = await readdir(filePath, { withFileTypes: true });
      const names = entries.filter((e) => e.isFile()).map((e) => e.name);
      return new Response(JSON.stringify(names), {
        headers: { 'content-type': 'application/json' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? 'application/octet-stream';
    return new Response(data, { headers: { 'content-type': type } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/**
 * Handle a `media://localhost/<absolute-path>` request by streaming the
 * file at that path through Electron's `net.fetch` (which honours the
 * incoming Range header — needed for the `<audio>` element to seek and
 * to start playback before the whole file has buffered).
 *
 * The renderer page is served from `app://editor/...`, a privileged
 * origin; a bare `file://` audio request from that origin gets blocked
 * cross-origin. Routing audio through this same-scheme handler keeps
 * the origin sane without disabling webSecurity.
 *
 * Register with `protocol.handle('media', ...)` once the app is ready.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function serveMediaFile(request) {
  const url = new URL(request.url);
  const filePath = decodeURIComponent(url.pathname);
  if (!filePath.startsWith('/')) {
    return new Response('Bad request', { status: 400 });
  }
  // pathToFileURL escapes any character that would confuse the
  // file:// scheme (spaces, unicode, the colon in Windows drives).
  return net.fetch(pathToFileURL(filePath).toString(), {
    headers: request.headers,
  });
}
