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

  /**
   * Render JMarkdown `source` to HTML by running `command` (a shell
   * command) with the source on stdin.
   * @param {string} command
   * @param {string} source
   * @returns {Promise<{html: string} | {error: string}>}
   */
  renderJMarkdown: (command, source) =>
    ipcRenderer.invoke('jmarkdown:render', { command, source }),

  /**
   * Read a file's companion metadata (sticky notes), or null.
   * @param {string} path - The file's own path.
   * @returns {Promise<object | null>}
   */
  readMetadata: (path) => ipcRenderer.invoke('metadata:read', { path }),

  /**
   * Write a file's companion metadata.
   * @param {string} path - The file's own path.
   * @param {object} data
   */
  writeMetadata: (path, data) =>
    ipcRenderer.invoke('metadata:write', { path, data }),
});
