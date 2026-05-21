/**
 * @file Electron main process — Layer 0, the host.
 *
 * Responsibilities are deliberately thin: create a window and serve the
 * repository's files to it (see `serve.js`). The editor itself runs
 * entirely in the renderer process.
 */

import { app, BrowserWindow, protocol } from 'electron';

import { EDITOR_URL, serveAppFile } from './serve.js';

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 480,
    minHeight: 320,
    backgroundColor: '#1b1b23',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(EDITOR_URL);
}

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS apps conventionally stay open with no windows; quit elsewhere.
  if (process.platform !== 'darwin') app.quit();
});
