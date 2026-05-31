/**
 * @file Electron main process — Layer 0, the host.
 *
 * Responsibilities are deliberately thin: create a window, serve the
 * repository's files to it (see `serve.js`), and handle filesystem
 * access on the renderer's behalf (see `files.js`). The editor itself
 * runs entirely in the renderer process.
 */

import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerFileHandlers } from './files.js';
import { renderJMarkdown } from './jmarkdown.js';
import { buildAppMenu } from './menu.js';
import { EDITOR_URL, serveAppFile, serveMediaFile } from './serve.js';
import { registerShellHandlers } from './shell.js';

const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'preload.mjs');

/** The editor window — there is only ever one. */
let mainWindow = null;

/** Send a command chosen from a native menu to the renderer to run. */
function dispatchMenuCommand(command) {
  if (mainWindow) mainWindow.webContents.send('menu:invoke', command);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 880,
    minWidth: 480,
    minHeight: 520,
    backgroundColor: '#1b1b23',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // An ESM preload requires the sandbox off; the renderer stays
      // isolated and reaches the host only through the context bridge.
      sandbox: false,
      // <webview> is disabled by default in Electron. The <browser-view>
      // mounts one to embed external pages; other view kinds may follow
      // the same pattern. The webview itself remains sandboxed — this
      // flag just allows the tag to mount.
      webviewTag: true,
    },
  });
  mainWindow = win;
  win.loadURL(EDITOR_URL);
}

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  protocol.handle('media', serveMediaFile);
  registerFileHandlers();
  registerShellHandlers();
  buildAppMenu(null, dispatchMenuCommand);
  ipcMain.on('app:quit', () => app.quit());
  // Render a sticky note's JMarkdown via the user-configured command.
  ipcMain.handle('jmarkdown:render', (_event, { command, source }) =>
    renderJMarkdown(command, source)
  );
  // The renderer sends the current buffer's mode menu; rebuild the
  // application menu around it as the buffer's mode changes.
  ipcMain.on('menu:set', (_event, modeMenu) => {
    buildAppMenu(modeMenu, dispatchMenuCommand);
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS apps conventionally stay open with no windows; quit elsewhere.
  if (process.platform !== 'darwin') app.quit();
});
