/**
 * @file Main-process file handling. The renderer is sandboxed and has
 * no filesystem access, so opening and saving files happens here and is
 * reached over IPC (see `preload.mjs`).
 */

import { app, dialog, ipcMain } from 'electron';
import { readdirSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Expand a leading `~` (or `~/…`) to the current user's home directory.
 * Paths a user types from the REPL (e.g. `(jukebox "~/Music/foo")`)
 * arrive verbatim — Node does not do the shell's tilde expansion. Used
 * by every IPC handler that touches a user-supplied path.
 *
 * @param {string} path
 * @returns {string}
 */
function expandTilde(path) {
  if (typeof path !== 'string') return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

// apps/desktop/src/files.js → repository root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const docsBuildDir = join(repoRoot, 'docs', 'build');

/** Cached parse of docs/build/manifest.json, refreshed when mtime
 *  changes. `null` = unloaded; `false` = manifest does not exist. */
let docManifestCache = null;
let docManifestMtimeMs = 0;

/**
 * Read (and cache) the documentation manifest produced by
 * `pnpm run docs`. Returns the parsed object, or `null` when the
 * manifest doesn't exist yet (docs haven't been built).
 */
async function loadDocManifest() {
  const path = join(docsBuildDir, 'manifest.json');
  try {
    const info = await stat(path);
    if (
      docManifestCache &&
      docManifestCache !== false &&
      info.mtimeMs === docManifestMtimeMs
    ) {
      return docManifestCache;
    }
    const raw = await readFile(path, 'utf8');
    docManifestCache = JSON.parse(raw);
    docManifestMtimeMs = info.mtimeMs;
    return docManifestCache;
  } catch {
    docManifestCache = false;
    docManifestMtimeMs = 0;
    return null;
  }
}

/** The companion file holding a file's jmacs metadata (sticky notes). */
const metadataPath = (filePath) => `${filePath}.jmacs-metadata`;

/** Image file suffixes → MIME type. A file with one of these suffixes
 *  is read as binary and returned as a `data:` URL, so the renderer can
 *  show the image instead of its bytes. */
const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/** The image MIME type for a path, by its suffix, or `null` when the
 *  path is not a recognised image. The renderer's `mimeTypeForImage`
 *  (in `@editor/renderer`) is the unit-tested twin of this logic; this
 *  copy stays here because the main process cannot import the renderer
 *  package. The pair is exercised end-to-end by the smoke test. */
function imageMimeType(filePath) {
  if (typeof filePath !== 'string') return null;
  return IMAGE_MIME_TYPES[extname(filePath).toLowerCase()] ?? null;
}

/**
 * Read an image file as a `data:` URL.
 *
 * @param {string} filePath
 * @param {string} mime - The image's MIME type.
 * @returns {Promise<string>}
 */
async function readImageDataUrl(filePath, mime) {
  const data = await readFile(filePath);
  return `data:${mime};base64,${data.toString('base64')}`;
}

/** A config file lives in the per-user data directory; its name is a
 *  bare filename (no path separators), resolved against that directory. */
function configPath(name) {
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) return null;
  return join(app.getPath('userData'), name);
}

/** Register the `file:*` IPC handlers. Call once, after the app is ready. */
export function registerFileHandlers() {
  // Show an open dialog and read the chosen file. An image file is
  // read as a `data:` URL (in `imageSrc`) so the renderer can display
  // it; any other file is read as UTF-8 text (in `content`).
  ipcMain.handle('file:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const path = result.filePaths[0];
    const mime = imageMimeType(path);
    if (mime !== null) {
      const imageSrc = await readImageDataUrl(path, mime);
      return { path, name: basename(path), imageSrc };
    }
    const content = await readFile(path, 'utf8');
    return { path, name: basename(path), content };
  });

  // Open a file by an explicit path — no dialog. Mirrors `file:open`
  // for image-vs-text handling so callers from inside the renderer
  // (e.g. jukebox-mode's M-RET on the album-art file) can hand a path
  // to the same image-buffer pipeline `file:open` feeds into.
  ipcMain.handle('file:open-path', async (_event, payload) => {
    const raw = payload?.path;
    if (typeof raw !== 'string' || raw === '') return null;
    const path = expandTilde(raw);
    try {
      const mime = imageMimeType(path);
      if (mime !== null) {
        const imageSrc = await readImageDataUrl(path, mime);
        return { path, name: basename(path), imageSrc };
      }
      const content = await readFile(path, 'utf8');
      return { path, name: basename(path), content };
    } catch {
      return null;
    }
  });

  // Show a directory-only open dialog. Used by jukebox-mode.
  ipcMain.handle('directory:open', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // Write content to a path; with no path, prompt for one first.
  ipcMain.handle('file:save', async (_event, payload) => {
    let target = payload?.path ?? null;
    if (target === null) {
      const result = await dialog.showSaveDialog({});
      if (result.canceled || !result.filePath) {
        return null;
      }
      target = result.filePath;
    }
    await writeFile(target, payload?.content ?? '', 'utf8');
    return { path: target, name: basename(target) };
  });

  // Read a file's companion metadata (sticky notes). Returns the parsed
  // JSON, or null when the companion file is absent or unreadable.
  ipcMain.handle('metadata:read', async (_event, payload) => {
    try {
      const content = await readFile(metadataPath(payload?.path), 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  });

  // List the (non-hidden) entries of a directory. Returns an array of
  // filenames or null when the path cannot be read — used by
  // jukebox-mode to discover audio files and album art.
  ipcMain.handle('directory:list', async (_event, payload) => {
    try {
      const entries = await readdir(expandTilde(payload?.path), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return null;
    }
  });

  // The same listing, synchronously. The Lisp interpreter is synchronous,
  // so the jukebox-mode Lisp calls this directly to read a directory in
  // the middle of building its panel. Used sparingly — sync IPC blocks
  // the renderer thread.
  ipcMain.on('directory:list-sync', (event, payload) => {
    try {
      const entries = readdirSync(expandTilde(payload?.path), {
        withFileTypes: true,
      });
      event.returnValue = entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      event.returnValue = null;
    }
  });

  // Write a file's companion metadata. With no notes, the companion
  // file is removed rather than left as an empty husk.
  ipcMain.handle('metadata:write', async (_event, payload) => {
    const target = metadataPath(payload?.path);
    const data = payload?.data ?? {};
    const notes = Array.isArray(data.notes) ? data.notes : [];
    if (notes.length === 0) {
      await rm(target, { force: true });
      return { path: target, removed: true };
    }
    await writeFile(target, JSON.stringify(data, null, 2), 'utf8');
    return { path: target };
  });

  // Read a user config file (custom.lisp, init.lisp) from the per-user
  // data directory. Returns the text, or null when it does not exist.
  ipcMain.handle('config:read', async (_event, payload) => {
    const target = configPath(payload?.name);
    if (target === null) return null;
    try {
      return await readFile(target, 'utf8');
    } catch {
      return null;
    }
  });

  // Write a user config file to the per-user data directory.
  ipcMain.handle('config:write', async (_event, payload) => {
    const target = configPath(payload?.name);
    if (target === null) throw new Error('invalid config file name');
    await writeFile(target, payload?.content ?? '', 'utf8');
    return { path: target };
  });

  // Documentation: read the manifest produced by `pnpm run docs`.
  // Returns { names: [...] } or null when no manifest exists yet.
  ipcMain.handle('doc:manifest', async () => {
    const map = await loadDocManifest();
    if (map === null) return null;
    return { names: Object.keys(map) };
  });

  // Documentation: read the rendered HTML for a doc page by name.
  // Returns { name, path, html } or null when the name is unknown
  // or the file can't be read.
  ipcMain.handle('doc:read', async (_event, payload) => {
    const map = await loadDocManifest();
    if (map === null) return null;
    const name = payload?.name;
    if (typeof name !== 'string') return null;
    const relPath = map[name];
    if (typeof relPath !== 'string') return null;
    const absPath = join(docsBuildDir, relPath);
    // Refuse to read outside docs/build/.
    if (!absPath.startsWith(docsBuildDir + '/')) return null;
    try {
      const html = await readFile(absPath, 'utf8');
      return { name, path: relPath, html };
    } catch {
      return null;
    }
  });
}
