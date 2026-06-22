/**
 * @file Electron main process — Layer 0, the host.
 *
 * Responsibilities are deliberately thin: create a window, serve the
 * repository's files to it (see `serve.js`), and handle filesystem
 * access on the renderer's behalf (see `files.js`). The editor itself
 * runs entirely in the renderer process.
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  utilityProcess,
  MessageChannelMain,
} from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerFileHandlers } from './files.js';
import { isServerMode, createServerBridge } from './server-bridge.js';
import { renderJMarkdown } from './jmarkdown.js';
import { buildAppMenu } from './menu.js';
import { EDITOR_URL, serveAppFile, serveMediaFile, allowHostDir } from './serve.js';
import { registerShellHandlers } from './shell.js';
import { registerProcessHandlers } from './process.js';
import { registerGnuplotHandlers } from './gnuplot.js';

// Match Sublime Text's colour rendering. By default Chromium colour-manages
// CSS values — it transforms every hex through the display's ICC profile
// before drawing — which desaturates the editor's themes (the Mariana
// palette reads "washed out" next to Sublime, which writes native pixels
// with no profile transform). Forcing the sRGB profile disables that
// transform, so every hex renders as its raw sRGB pixel: the same convention
// Sublime uses. Must be set before the app is ready, hence here at load.
// (Paired with restoring the dark theme's --bg-editor to Mariana's true
// #303841 in themes.lisp, since it had been pre-compensated for the now-
// disabled transform.)
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// The product name. Drives the macOS app menu / About / Hide / Quit labels
// (the menu uses `role: 'appMenu'`, which reads `app.getName()`) and the
// userData directory (`app.getPath('userData')` → …/Application Support/Godot)
// — the same location the packaged build resolves from its productName, so
// dev and release share one config home. Must be set before the app is ready
// (and before any `getPath('userData')`), hence here at load.
app.setName('Godot');

const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'preload.mjs');

// §3a: a main-process throw or unhandled rejection should log, not kill
// the host silently (which would take the window down with no warning).
// The renderer owns the user's data and has its own recovery/error
// nets; here we just keep the process alive and leave a trail.
process.on('uncaughtException', (error) => {
  console.error('[main] uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason);
});

/** The editor window — there is only ever one. */
let mainWindow = null;

/**
 * G1 (plans/MWB-GRADUATION.md): the Model-B server bridge, or null.
 *
 * Non-null ONLY when `GODOT_SERVER=1`. With the flag unset (the default), this
 * stays null and every reference below is a guarded no-op, so the app's
 * behaviour is byte-for-byte today: no server process, no port plumbing, no new
 * code path taken. When the flag is on, a server `utilityProcess` is forked and
 * a port is connected to the window's renderer — but nothing is routed through
 * it yet (G2 routes editing). See `server-bridge.js`.
 *
 * @type {ReturnType<typeof createServerBridge> | null}
 */
let serverBridge = null;

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
      // Godot is a desktop app — everything is user-driven, so the
      // browser autoplay safeguards don't fit. Match the browser
      // environment audio components are built for: an AudioContext
      // starts suspended until the first interaction with the window,
      // then plays in sync. Electron's default ('no-user-gesture-
      // required') instead lets a context run before any gesture, which
      // defeats a component's resume-time buffer flush and leaves audio
      // standing ~0.5s behind video (seen with the Stella emulator). One
      // interaction anywhere unlocks audio app-wide. See
      // plans/ELEMENT-VIEWS.md.
      autoplayPolicy: 'document-user-activation-required',
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

  // §3a: the renderer crashing (or being killed) takes the editor down.
  // Log the cause; the user's unsaved work is recoverable on relaunch
  // from the autosave snapshots (the *Recover* view), since a crash is
  // exactly the case those exist for.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] render process gone:', details?.reason ?? details);
  });

  win.loadURL(EDITOR_URL);

  // G1: when the server is running (GODOT_SERVER=1), plumb a MessageChannel
  // port from the server to this window's renderer. `serverBridge` is null with
  // the flag off, so this is a no-op in the default config — the renderer never
  // hears of a port and boots exactly as today. With the flag on, the renderer
  // receives + stashes the port but does NOT route editing through it (G2).
  if (serverBridge) serverBridge.attachWindow(win.webContents);
}

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  protocol.handle('media', serveMediaFile);
  // The per-user data dir (init.lisp, custom preview CSS kept there, …) is
  // a trusted host root for the `__host__` route.
  allowHostDir(app.getPath('userData'));
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

  // G1: behind GODOT_SERVER=1 only, fork the Model-B server utilityProcess so a
  // window can later (G2) be driven by it. Construction is wrapped so a fork
  // failure logs rather than crashing the host. With the flag off, isServerMode
  // is false and `serverBridge` stays null — the app is unchanged.
  if (isServerMode()) {
    try {
      serverBridge = createServerBridge({ utilityProcess, MessageChannelMain });
      console.error('[main] GODOT_SERVER=1: Model-B server forked');
    } catch (error) {
      serverBridge = null;
      console.error('[main] failed to start the Model-B server:', error);
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS apps conventionally stay open with no windows; quit elsewhere.
  if (process.platform !== 'darwin') app.quit();
});

// G1 lifecycle: kill the server `utilityProcess` when the app is quitting, so
// no orphaned server outlives the app. `will-quit` fires once the quit is
// committed (after the renderer's confirm). `dispose` is idempotent and guarded;
// with the flag off `serverBridge` is null and this is a no-op.
app.on('will-quit', () => {
  if (serverBridge) {
    serverBridge.dispose();
    serverBridge = null;
  }
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
