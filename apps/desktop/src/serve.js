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
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  // Images — so the `__host__` route serves a markdown file's relative
  // images (and a stylesheet's referenced art) into the preview iframe
  // with a real type. SVG especially must not fall back to octet-stream,
  // or the browser won't render it as an image.
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/** Path prefix on `app://editor/` under which arbitrary file paths
 *  outside the repo are served. Used by views that need fetch-friendly
 *  URLs for files anywhere on disk — the pdf-view is the current one,
 *  since PDF.js needs a same-origin URL (custom schemes can't be
 *  cross-origin fetch targets per Chromium's scheme allowlist, and
 *  `media://` is a different origin from the `app://editor` renderer).
 *
 *  The prefix is intentionally unusual so it can't collide with a real
 *  repo path. */
const HOST_FILE_PREFIX = '/__host__/';

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
 * Plus a special same-host route:
 *
 *   - `app://editor/__host__/<encoded absolute path>` — serves a file
 *     anywhere on disk. Used by views that need a fetch-friendly URL
 *     for arbitrary files (the pdf-view's PDF.js loader). Stays on the
 *     `app://editor` origin so renderer fetches are same-origin —
 *     `media://` would be a different origin and Chromium refuses
 *     cross-origin fetches for non-allowlisted schemes.
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
  const pathname = decodeURIComponent(url.pathname);

  // Same-host arbitrary-file route. `__host__` is treated as opaque —
  // the remainder is the absolute path to read. Returns 404 on unread.
  if (url.host === 'editor' && pathname.startsWith(HOST_FILE_PREFIX)) {
    const filePath = pathname.slice(HOST_FILE_PREFIX.length - 1); // keep '/'
    try {
      const data = await readFile(filePath);
      const type = MIME[extname(filePath).toLowerCase()]
        ?? 'application/octet-stream';
      // No-store: this route serves the live PDF after each compile, so a
      // recompiled document must never be masked by a stale cached copy.
      return new Response(data, {
        headers: { 'content-type': type, 'cache-control': 'no-store' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }

  const base = url.host === 'docs' ? join(repoRoot, 'docs', 'build') : repoRoot;
  const filePath = join(base, pathname);
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
    // No-store: the renderer's source (app.js / view.js / *.lisp /
    // styles.css …) is served straight from the working tree on every
    // request, so a reload or restart always picks up edited code rather
    // than a stale copy from Chromium's HTTP cache. (There is no build
    // step; freshness matters more than caching for a local dev editor.)
    return new Response(data, {
      headers: { 'content-type': type, 'cache-control': 'no-store' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/**
 * Build an `app://editor/__host__/<encoded path>` URL that the
 * arbitrary-file route above serves. Per-segment encoding so spaces /
 * unicode / parentheses in a path survive the URL round-trip.
 *
 * @param {string} filePath - An absolute filesystem path.
 * @returns {string}
 */
export function hostFileUrl(filePath) {
  return (
    'app://editor' + HOST_FILE_PREFIX.slice(0, -1)
    + filePath.split('/').map(encodeURIComponent).join('/')
  );
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
