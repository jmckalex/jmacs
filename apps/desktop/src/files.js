/**
 * @file Main-process file handling. The renderer is sandboxed and has
 * no filesystem access, so opening and saving files happens here and is
 * reached over IPC (see `preload.mjs`).
 */

import { dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** Register the `file:*` IPC handlers. Call once, after the app is ready. */
export function registerFileHandlers() {
  // Show an open dialog and read the chosen file.
  ipcMain.handle('file:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const path = result.filePaths[0];
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
}
