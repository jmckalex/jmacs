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
  screen,
} from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reconcileBounds } from './window-geometry.js';
import { registerFileHandlers } from './files.js';
import { isServerMode, createServerBridge } from './server-bridge.js';
import { renderJMarkdown } from './jmarkdown.js';
import {
  registerJmarkdownWatchHandlers,
  stopJmarkdownWatch,
  reapJmarkdownWatchers,
  watcherPort,
  transferWatcherTo,
} from './jmarkdown-watch.js';
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
const PREVIEW_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'preview-preload.mjs');
const PREVIEW_WINDOW_URL = EDITOR_URL.replace(/index\.html$/, 'preview-window.html');

// Markdown-preview pop-out: each editor window ↔ its popped-out preview window,
// for forward/inverse-search relay (separate renderers route through main).
const previewPopoutByEditor = new Map(); // editorWcId -> popout webContents
const previewEditorByPopout = new Map(); // popoutWcId -> editor webContents

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

/** G4.3: the last mode-menu each window sent, keyed by `webContents.id`. The
 *  macOS app menu is global, so only the FOCUSED window's menu is applied; a
 *  background window's spec is held here and re-applied when it regains focus.
 *  Flag-off (single window) keeps last-writer-wins behaviour — that one window
 *  is always the focused one. */
const windowMenuSpecs = new Map();

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

/** A display descriptor for window-geometry reconciliation (the shape
 *  window-geometry.js expects: id + workArea + scaleFactor). */
function describeDisplay(display) {
  if (!display) return null;
  return { id: display.id, workArea: display.workArea, scaleFactor: display.scaleFactor };
}

/** This window's current frame + the display it sits on — the geometry the
 *  session records (sent to the renderer, which reports it to the server). */
function boundsDescriptor(win) {
  const bounds = win.getBounds();
  return { bounds, display: describeDisplay(screen.getDisplayMatching(bounds)) };
}

/**
 * Create a browser window. With `opts.geometry` (a saved `{ bounds, display }`
 * from a session restore), reconcile it against the CURRENT displays — exact
 * when the display is still present and the frame fits, else a proportional
 * rescale (window-geometry.js) — and open the window there; otherwise use the
 * defaults.
 */
function createWindow(opts = {}) {
  const geom = opts.geometry
    ? reconcileBounds(opts.geometry, screen.getAllDisplays().map(describeDisplay))
    : null;
  const win = new BrowserWindow({
    width: geom ? geom.width : 1040,
    height: geom ? geom.height : 880,
    ...(geom ? { x: geom.x, y: geom.y } : {}),
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
  if (isServerMode()) {
    windows.add(win);
    // B2: report this window's frame to its renderer on move/resize (debounced),
    // so the session snapshot records its geometry — the renderer forwards it to
    // the server. The renderer also pulls once on connect (window:get-bounds).
    let boundsTimer = null;
    const scheduleBoundsReport = () => {
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        boundsTimer = null;
        if (!win.isDestroyed()) win.webContents.send('window:bounds', boundsDescriptor(win));
      }, 250);
    };
    win.on('resize', scheduleBoundsReport);
    win.on('move', scheduleBoundsReport);
    // G4.3: gaining focus makes the global app menu THIS window's menu. (No
    // stored spec yet — a just-opened window — leaves the current menu; it
    // sends its own menu:set on boot.)
    win.on('focus', () => {
      const spec = windowMenuSpecs.get(win.webContents.id);
      if (spec) {
        buildAppMenu(spec, dispatchMenuCommand, { canNewWindow: isServerMode() });
      }
    });
  }

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
    const wcId = win.webContents.id; // capture now; gone after 'closed'
    win.on('closed', () => {
      windows.delete(win);
      windowMenuSpecs.delete(wcId); // G4.3: drop the closed window's menu spec
      if (mainWindow === win) {
        mainWindow = windows.values().next().value ?? null;
      }
    });
  }

  // Reap this window's JMarkdown preview watcher (if any) when it closes, in
  // every mode — a live `jmarkdown watch` subprocess must not outlive the
  // window that asked for it. (`webContents.id` is captured now; it's gone
  // once 'closed' has fired.)
  const previewWcId = win.webContents.id;
  win.on('closed', () => stopJmarkdownWatch(previewWcId));

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
  registerJmarkdownWatchHandlers();
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
  // window, so main does it and the bridge attaches it as a new client. B2: a
  // session restore threads the saved window geometry through, so a spawned
  // window is born at its reconciled size/position.
  ipcMain.on('window:new', (_event, geometry) => {
    if (isServerMode()) createWindow({ geometry: geometry ?? null });
  });
  // P2: the renderer asks main to close THIS window (host.closeWindow()),
  // driven by the server's close-window CLIENT_DIRECTIVE (C-x 5 0, or C-x 5 1
  // from another window). Server mode only — in server mode a window closes
  // freely (the buffers live in the server; win.on('close') returns early), so
  // we just close the sender's BrowserWindow.
  ipcMain.on('window:close', (event) => {
    if (!isServerMode()) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });
  // B2: apply a saved frame to an existing window (window 1 on restore — it
  // pre-exists at default bounds). main owns `screen`, so it reconciles the
  // saved frame against the live displays here, then resizes.
  ipcMain.on('window:set-bounds', (event, geometry) => {
    if (!isServerMode() || !geometry) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const b = reconcileBounds(geometry, screen.getAllDisplays().map(describeDisplay));
    if (b) win.setBounds(b);
  });
  // B2: the renderer pulls its current frame once on connect, to seed the
  // session's geometry before any move/resize.
  ipcMain.handle('window:get-bounds', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() ? boundsDescriptor(win) : null;
  });
  // Render a sticky note's JMarkdown via the user-configured command.
  ipcMain.handle('jmarkdown:render', (_event, { command, source }) =>
    renderJMarkdown(command, source)
  );
  // Pop the Markdown preview out into its own Godot window: a BrowserWindow on
  // the wrapper page (preview-window.html), which embeds the live `jmarkdown
  // watch` localhost page in an iframe and relays forward/inverse search to the
  // editor window (the two are separate renderers, so they talk through main —
  // see the preview-sync:* handlers below). The watch process's OWNERSHIP
  // transfers from the editor window to the preview window, so it is reaped when
  // the preview window closes (and on app quit), and a fresh C-c v in the editor
  // starts an independent watcher.
  ipcMain.handle('jmarkdown:watch:popout', (event) => {
    const editorWc = event.sender;
    const editorWcId = editorWc.id;
    if (watcherPort(editorWcId) == null) return { ok: false, error: 'no preview to pop out' };
    const win = new BrowserWindow({
      width: 820,
      height: 1000,
      title: 'Preview',
      webPreferences: {
        preload: PREVIEW_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // ESM preload
      },
    });
    const port = transferWatcherTo(editorWcId, win.webContents.id);
    if (port == null) {
      win.destroy();
      return { ok: false, error: 'no preview to pop out' };
    }
    const popoutWcId = win.webContents.id;
    previewPopoutByEditor.set(editorWcId, win.webContents);
    previewEditorByPopout.set(popoutWcId, editorWc);
    win.loadURL(`${PREVIEW_WINDOW_URL}?port=${port}`);
    win.on('closed', () => {
      stopJmarkdownWatch(popoutWcId);
      previewPopoutByEditor.delete(editorWcId);
      previewEditorByPopout.delete(popoutWcId);
      // Tell the editor its preview window is gone so it stops forwarding.
      if (!editorWc.isDestroyed()) editorWc.send('preview-sync:popout-closed');
    });
    return { ok: true };
  });

  // Forward search: an editor's cursor line → ITS popped-out preview window.
  ipcMain.on('preview-sync:down', (event, msg) => {
    const popoutWc = previewPopoutByEditor.get(event.sender.id);
    if (popoutWc && !popoutWc.isDestroyed()) popoutWc.send('preview-sync:down', msg);
  });
  // Inverse search (+ the preview's `ready`): a popped-out preview → ITS editor.
  ipcMain.on('preview-sync:up', (event, msg) => {
    const editorWc = previewEditorByPopout.get(event.sender.id);
    if (editorWc && !editorWc.isDestroyed()) editorWc.send('preview-sync:up', msg);
  });
  // The renderer sends the current buffer's mode menu; rebuild the
  // application menu around it as the buffer's mode changes.
  ipcMain.on('menu:set', (event, modeMenu) => {
    // G4.3: the app menu follows the focused window. Store this window's menu;
    // apply it only if this window is focused (or nothing is focused — e.g. the
    // app is backgrounded — so the menu isn't left stale). Flag-off has one
    // window, which is the focused one, so this stays last-writer-wins.
    const id = event.sender.id;
    windowMenuSpecs.set(id, modeMenu);
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || focused.webContents.id === id) {
      buildAppMenu(modeMenu, dispatchMenuCommand, { canNewWindow: isServerMode() });
    }
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
// Reap every JMarkdown preview watcher once the quit actually proceeds (after
// any save-confirm). 'will-quit' fires only on a real quit — unlike
// 'before-quit', which also fires on a quit the user then cancels.
app.on('will-quit', () => reapJmarkdownWatchers());

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
