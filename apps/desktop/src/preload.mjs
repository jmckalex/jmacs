/**
 * @file Preload script. Runs in an isolated context with access to
 * Electron IPC, and exposes a small, explicit `host` API to the
 * renderer through the context bridge. The renderer gets exactly these
 * functions and nothing else — no `require`, no `fs`.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('host', {
  /**
   * Show an open dialog and read the chosen file.
   * @returns {Promise<{path: string, name: string, content: string} | null>}
   */
  openFile: () => ipcRenderer.invoke('file:open'),

  /**
   * Save content to a file. With a null path, prompts for one.
   * @param {string | null} path
   * @param {string} content
   * @returns {Promise<{path: string, name: string} | null>}
   */
  saveFile: (path, content) => ipcRenderer.invoke('file:save', { path, content }),

  /** Quit the application. */
  quit: () => ipcRenderer.send('app:quit'),
});
