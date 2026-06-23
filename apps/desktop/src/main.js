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

/** The editor window. In the flag-off (default) build there is only ever one,
 *  and this is it. In server mode (GODOT_SERVER=1, G4 multi-window) it tracks
 *  the most-recently-created window and is re-pointed at a survivor when a
 *  window closes; routing that should target the *focused* window uses
 *  `focusedWindow()` instead. */
let mainWindow = null;

/** G4 (server mode only): every open client window. Each is a thin client on
 *  the one shared server; the buffers live in the server and outlive any
 *  window. Empty + untouched in the flag-off build. */
const windows = new Set();

/** The window a menu command / quit confirm should target: the focused one,
 *  falling back to `mainWindow` (e.g. during quit, when nothing is focused).
 *  Only consulted in server mode. */
function focusedWindow() {
  return BrowserWindow.getFocusedWindow() ?? mainWindow;
}

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

/** Send a command chosen from a native menu to the renderer to run. In server
 *  mode the menu's "New Window" item is a window-lifecycle action main performs
 *  directly (the server can't open an OS window); everything else targets the
 *  focused window. The flag-off path is byte-for-byte today (single window). */
function dispatchMenuCommand(command) {
  if (!isServerMode()) {
    if (mainWindow) mainWindow.webContents.send('menu:invoke', command);
    return;
  }
  if (command === 'new-window') {
    createWindow();
    return;
  }
  const win = focusedWindow();
  if (win && !win.isDestroyed()) win.webContents.send('menu:invoke', command);
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
  if (isServerMode()) windows.add(win);

  // The red traffic-light button closes the window directly, which (like
  // a native Quit) would tear down the renderer and drop unsaved edits
  // with no prompt. (Cmd+W does NOT reach here — the renderer binds it to
  // close-tab; only the traffic-light button and app.quit() close the
  // window.) Intercept the first close and route it through the same
  // renderer confirm as before-quit; quitInteractive calls back via
  // `app:quit` (which sets quitConfirmed) to let the next close through,
  // or does nothing to cancel and the window stays open.
  win.on('close', (event) => {
    // G4: in server mode the buffers live in the central server and outlive
    // any window — closing a window loses nothing (the server-side detach
    // reaps the client; unsaved edits stay in the server + its autosave). So
    // a window closes freely; only QUITTING the app (before-quit / C-x C-c),
    // which kills the server, runs the unsaved-changes confirm.
    if (isServerMode()) return;
    if (!shouldHoldForConfirm()) return;
    event.preventDefault();
    win.webContents.send('app:confirm-quit');
  });

  // G4: keep the window registry current as windows close, and re-point
  // `mainWindow` at a survivor so the quit/menu fallbacks never reference a
  // destroyed window. Flag-off (single window) never adds this listener, so
  // its lifecycle is unchanged.
  if (isServerMode()) {
    win.on('closed', () => {
      windows.delete(win);
      if (mainWindow === win) {
        mainWindow = windows.values().next().value ?? null;
      }
    });
  }

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
  return win;
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
  buildAppMenu(null, dispatchMenuCommand, { canNewWindow: isServerMode() });
  // The renderer calls this (via host.quit) from quitInteractive, after
  // it has confirmed there is nothing unsaved to lose. Mark the quit
  // confirmed so before-quit lets it through, then quit.
  ipcMain.on('app:quit', () => {
    quitConfirmed = true;
    app.quit();
  });
  // G4: the renderer asks for another window via host.newWindow() — driven by
  // the server's WINDOW_NEW effect (the C-x 5 2 chord resolves to a server
  // `new-window` command). Server mode only; the server can't open an OS
  // window, so main does it and the bridge attaches it as a new client.
  ipcMain.on('window:new', () => {
    if (isServerMode()) createWindow();
  });
  // Render a sticky note's JMarkdown via the user-configured command.
  ipcMain.handle('jmarkdown:render', (_event, { command, source }) =>
    renderJMarkdown(command, source)
  );
  // The renderer sends the current buffer's mode menu; rebuild the
  // application menu around it as the buffer's mode changes.
  ipcMain.on('menu:set', (_event, modeMenu) => {
    buildAppMenu(modeMenu, dispatchMenuCommand, { canNewWindow: isServerMode() });
  });

  // G1: behind GODOT_SERVER=1 only, fork the Model-B server utilityProcess so a
  // window can later (G2) be driven by it. Construction is wrapped so a fork
  // failure logs rather than crashing the host. With the flag off, isServerMode
  // is false and `serverBridge` stays null — the app is unchanged.
  if (isServerMode()) {
    try {
      // Increment 3: let the server SEED its session from the renderer's
      // session.json on its first boot (so the user's existing open files come
      // back through the server). The forked utilityProcess inherits
      // process.env, so set the path here, before the fork. After the first
      // boot the server owns its own session and ignores this.
      process.env.MWB_SESSION_SEED = join(app.getPath('userData'), 'session.json');
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
  // G4: in server mode the confirm runs in the focused window (any window can
  // confirm — the buffers are shared server state); flag-off it is the single
  // window. quitInteractive there calls back via `app:quit` to proceed.
  const win = isServerMode() ? focusedWindow() : mainWindow;
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('app:confirm-quit');
  } else {
    // No window to confirm with (e.g. all closed in server mode): nothing in
    // the renderer to lose — the server autosaves — so let the quit proceed.
    quitConfirmed = true;
    app.quit();
  }
});
