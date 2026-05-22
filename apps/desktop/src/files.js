/**
 * @file Main-process file handling. The renderer is sandboxed and has
 * no filesystem access, so opening and saving files happens here and is
 * reached over IPC (see `preload.mjs`).
 */

import { app, dialog, ipcMain } from 'electron';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

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
}
