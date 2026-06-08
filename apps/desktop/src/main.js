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
import { registerProcessHandlers } from './process.js';
import { registerGnuplotHandlers } from './gnuplot.js';

const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'preload.mjs');

/** The editor window — there is only ever one. */
let mainWindow = null;

/** True once a quit has been confirmed through the renderer (nothing
 *  unsaved, or the user chose to discard). Lets `before-quit` allow the
 *  quit through instead of prompting again. */
let quitConfirmed = false;

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

  // The red traffic-light button closes the window directly, which (like
  // a native Quit) would tear down the renderer and drop unsaved edits
  // with no prompt. (Cmd+W does NOT reach here — the renderer binds it to
  // close-tab; only the traffic-light button and app.quit() close the
  // window.) Intercept the first close and route it through the same
  // renderer confirm as before-quit; quitInteractive calls back via
  // `app:quit` (which sets quitConfirmed) to let the next close through,
  // or does nothing to cancel and the window stays open.
  win.on('close', (event) => {
    if (!shouldHoldForConfirm()) return;
    event.preventDefault();
    win.webContents.send('app:confirm-quit');
  });

  win.loadURL(EDITOR_URL);
}

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  protocol.handle('media', serveMediaFile);
  registerFileHandlers();
  registerShellHandlers();
  registerProcessHandlers();
  registerGnuplotHandlers();
  buildAppMenu(null, dispatchMenuCommand);
  // The renderer calls this (via host.quit) from quitInteractive, after
  // it has confirmed there is nothing unsaved to lose. Mark the quit
  // confirmed so before-quit lets it through, then quit.
  ipcMain.on('app:quit', () => {
    quitConfirmed = true;
    app.quit();
  });
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

// Whether an exit (a native Quit or a window close) should be held for
// the renderer's unsaved-changes confirm. False once a quit has been
// confirmed, or if the window / renderer is already gone — then there is
// nothing left to lose, so let the exit proceed.
function shouldHoldForConfirm() {
  if (quitConfirmed) return false;
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  ) {
    return false;
  }
  return true;
}

// A native Quit (Cmd+Q or the app-menu Quit) calls app.quit() directly,
// which would bypass the renderer's unsaved-changes prompt and silently
// drop edits. Intercept the first quit and hand off to the renderer: it
// runs quitInteractive (confirm + flush metadata) and calls back via
// `app:quit` to actually quit, or does nothing to cancel. Holding here
// means the windows never close, so the `close` guard below does not
// also fire for the same Cmd+Q.
app.on('before-quit', (event) => {
  if (!shouldHoldForConfirm()) return;
  event.preventDefault();
  mainWindow.webContents.send('app:confirm-quit');
});
