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
import { createServerBridge } from './server-bridge.js';
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
import { setupConfigHome } from './config-home.js';

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
// Electron userData directory (`app.getPath('userData')` → …/Application
// Support/Godot) — where Chromium keeps its caches, and the legacy location
// the config-home migration reads from. (Godot's own user config now lives in
// ~/.godot; see config-home.js.) `setName` must run before the app is ready
// and before any `getPath('userData')`, hence here at load.
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

/** The editor window. Tracks the most-recently-created window and is re-pointed
 *  at a survivor when a window closes; routing that should target the *focused*
 *  window uses `focusedWindow()` instead. */
let mainWindow = null;

/** Every open client window. Each is a thin client on the one shared server;
 *  the buffers live in the server and outlive any window. */
const windows = new Set();

/** The last mode-menu each window sent, keyed by `webContents.id`. The macOS
 *  app menu is global, so only the FOCUSED window's menu is applied; a
 *  background window's spec is held here and re-applied when it regains focus. */
const windowMenuSpecs = new Map();

/** The window a menu command / quit confirm should target: the focused one,
 *  falling back to `mainWindow` (e.g. during quit, when nothing is focused). */
function focusedWindow() {
  return BrowserWindow.getFocusedWindow() ?? mainWindow;
}

/**
 * The Model-B server bridge. Forked once at startup (see `whenReady`); a port is
 * connected to each window's renderer. Stays null only if the fork fails, so the
 * references below keep a defensive null-guard. See `server-bridge.js`.
 *
 * @type {ReturnType<typeof createServerBridge> | null}
 */
let serverBridge = null;

/** True once a quit has been confirmed through the renderer (nothing
 *  unsaved, or the user chose to discard). Lets `before-quit` allow the
 *  quit through instead of prompting again. */
let quitConfirmed = false;

/** Send a command chosen from a native menu to the renderer to run. The menu's
 *  "New Window" item is a window-lifecycle action main performs directly (the
 *  server can't open an OS window); everything else targets the focused window. */
function dispatchMenuCommand(command) {
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
      buildAppMenu(spec, dispatchMenuCommand, { canNewWindow: true });
    }
  });

  // A window closes freely: in Model B the buffers live in the central server
  // and outlive any window — closing one loses nothing (the server-side detach
  // reaps the client; unsaved edits stay in the server + its autosave). Only
  // QUITTING the app (before-quit / C-x C-c), which kills the server, runs the
  // unsaved-changes confirm. (Cmd+W does NOT close a window — the renderer binds
  // it to close-tab; only the traffic-light button and app.quit() close it.)

  // Keep the window registry current as windows close, and re-point `mainWindow`
  // at a survivor so the quit/menu fallbacks never reference a destroyed window.
  const wcId = win.webContents.id; // capture now; gone after 'closed'
  win.on('closed', () => {
    windows.delete(win);
    windowMenuSpecs.delete(wcId); // drop the closed window's menu spec
    if (mainWindow === win) {
      mainWindow = windows.values().next().value ?? null;
    }
  });

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

  // Plumb a MessageChannel port from the server to this window's renderer.
  // `serverBridge` is null only if the startup fork failed, so this keeps a
  // defensive null-guard.
  if (serverBridge) serverBridge.attachWindow(win.webContents);
  return win;
}

// A browser VIEW is an Electron <webview>; a `target="_blank"` link or a
// `window.open()` inside a page would otherwise spawn a bare OS popup window
// (the guest asked for a new window, and `allowpopups` keeps it from being
// silently dropped). We never want a popup OS window, so we always DENY. The
// disposition tells us what the page meant:
//   - 'foreground-tab' — a real link the USER clicked (a `target="_blank"`):
//     keep it inside the editor by loading it in THIS webview (the back button
//     returns; `did-navigate` updates the URL bar + reports to the server).
//   - anything else ('new-window' / 'background-tab' / 'other') — a programmatic
//     / background popup: silent OAuth renewal (Spotify embeds do this with
//     `window.open(...prompt=none&response_mode=web_message)`), ad windows, etc.
//     Drop it silently — opening it would pop a window, and navigating THIS view
//     to it would hijack the user's page with a login/redirect endpoint.
// Scoped to webview-type contents, so editor windows and the jmarkdown-preview
// iframe are unaffected.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'foreground-tab'
        && typeof url === 'string' && /^https?:\/\//i.test(url)) {
      contents.loadURL(url).catch(() => { /* aborted / bad URL — ignore */ });
    }
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  protocol.handle('media', serveMediaFile);
  // Godot's config home (~/.godot, or $GODOT_HOME) — created here, with a
  // one-time migration of config from the legacy Electron userData dir on the
  // first run. A trusted host root for the `__host__` route (the snippet
  // engine, init.lisp and custom preview CSS live under it).
  const configHome = setupConfigHome(app.getPath('userData'));
  allowHostDir(configHome);
  registerFileHandlers();
  registerShellHandlers();
  registerProcessHandlers();
  registerGnuplotHandlers();
  registerJmarkdownWatchHandlers();
  buildAppMenu(null, dispatchMenuCommand, { canNewWindow: true });
  // The renderer calls this (via host.quit) from quitInteractive, after
  // it has confirmed there is nothing unsaved to lose. Mark the quit
  // confirmed so before-quit lets it through, then quit.
  ipcMain.on('app:quit', () => {
    quitConfirmed = true;
    app.quit();
  });
  // The renderer asks for another window via host.newWindow() — driven by the
  // server's WINDOW_NEW effect (the C-x 5 2 chord resolves to a server
  // `new-window` command). The server can't open an OS window, so main does it
  // and the bridge attaches it as a new client. B2: a session restore threads
  // the saved window geometry through, so a spawned window is born at its
  // reconciled size/position.
  ipcMain.on('window:new', (_event, geometry) => {
    createWindow({ geometry: geometry ?? null });
  });
  // P2: the renderer asks main to close THIS window (host.closeWindow()),
  // driven by the server's close-window CLIENT_DIRECTIVE (C-x 5 0, or C-x 5 1
  // from another window). A window closes freely (the buffers live in the
  // server), so we just close the sender's BrowserWindow.
  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });
  // B2: apply a saved frame to an existing window (window 1 on restore — it
  // pre-exists at default bounds). main owns `screen`, so it reconciles the
  // saved frame against the live displays here, then resizes.
  ipcMain.on('window:set-bounds', (event, geometry) => {
    if (!geometry) return;
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
  ipcMain.handle('jmarkdown:watch:popout', (event, opts) => {
    const editorWc = event.sender;
    const editorWcId = editorWc.id;
    if (watcherPort(editorWcId) == null) return { ok: false, error: 'no preview to pop out' };
    const name = typeof opts?.name === 'string' ? opts.name : '';
    const bg = typeof opts?.bg === 'string' ? opts.bg : '';
    const fg = typeof opts?.fg === 'string' ? opts.fg : '';
    const win = new BrowserWindow({
      width: 820,
      height: 1000,
      title: name || 'Preview',
      // Match the editor's window chrome: an inset title bar (the page draws a
      // themed strip) over the theme's background colour, not a white native bar.
      titleBarStyle: 'hiddenInset',
      backgroundColor: /^#[0-9a-fA-F]{3,8}$/.test(bg) ? bg : '#1b1b23',
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
    const query = `port=${port}&name=${encodeURIComponent(name)}`
      + `&bg=${encodeURIComponent(bg)}&fg=${encodeURIComponent(fg)}`;
    win.loadURL(`${PREVIEW_WINDOW_URL}?${query}`);
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
    // The app menu follows the focused window. Store this window's menu; apply
    // it only if this window is focused (or nothing is focused — e.g. the app is
    // backgrounded — so the menu isn't left stale).
    const id = event.sender.id;
    windowMenuSpecs.set(id, modeMenu);
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || focused.webContents.id === id) {
      buildAppMenu(modeMenu, dispatchMenuCommand, { canNewWindow: true });
    }
  });

  // Fork the Model-B server utilityProcess. Construction is wrapped so a fork
  // failure logs rather than crashing the host (the references to `serverBridge`
  // keep a defensive null-guard for that case).
  try {
    // Let the server SEED its session from the renderer's session.json on its
    // first boot (so the user's existing open files come back through the
    // server). The forked utilityProcess inherits process.env, so set the path
    // here, before the fork. After the first boot the server owns its own
    // session and ignores this.
    process.env.MWB_SESSION_SEED = join(configHome, 'session.json');
    // The spine reads user config (faces.json, custom.lisp) from the config
    // home directly via fs (plans/MODEL-B-DEFAULT.md, Part B; ~/.godot).
    process.env.MWB_CONFIG_HOME = configHome;
    serverBridge = createServerBridge({ utilityProcess, MessageChannelMain });
    console.error('[main] Model-B server forked');
  } catch (error) {
    serverBridge = null;
    console.error('[main] failed to start the Model-B server:', error);
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

// Kill the server `utilityProcess` when the app is quitting, so no orphaned
// server outlives the app. `will-quit` fires once the quit is committed (after
// the renderer's confirm). `dispose` is idempotent and guarded; `serverBridge`
// is null only if the fork failed, in which case this is a no-op.
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
  // The confirm runs in the focused window (any window can confirm — the buffers
  // are shared server state). quitInteractive there calls back via `app:quit` to
  // proceed.
  const win = focusedWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('app:confirm-quit');
  } else {
    // No window to confirm with (e.g. all closed in server mode): nothing in
    // the renderer to lose — the server autosaves — so let the quit proceed.
    quitConfirmed = true;
    app.quit();
  }
});
