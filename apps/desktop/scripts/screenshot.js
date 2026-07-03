/**
 * @file Boot the editor in a hidden Electron window, optionally drive it with a
 * Lisp form, capture the rendered window to a PNG, and exit. Lets an agent (or a
 * dev) *see* the app without a human at the screen.
 *
 *   pnpm --filter @editor/desktop screenshot [out.png] ["(lisp to run first)"] [waitMs]
 *
 * The window is `show:false` but `paintWhenInitiallyHidden` defaults true, so
 * webContents.capturePage() still returns the composited pixels. Like smoke.js,
 * this boots the REAL Model-B spine (server-bridge + attachWindow) — the earlier
 * version predated Model B and only ever captured the dead thin-client. The
 * spine is pointed at an isolated scratch config so the capture is hermetic.
 */

import {
  app, BrowserWindow, protocol, utilityProcess, MessageChannelMain,
} from 'electron';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServerBridge } from '../src/server-bridge.js';
import { registerFileHandlers } from '../src/files.js';
import { registerShellHandlers } from '../src/shell.js';
import { EDITOR_URL, serveAppFile, serveMediaFile } from '../src/serve.js';

if (process.env.SHOT_SOFTWARE === '1') app.disableHardwareAcceleration();

const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'preload.mjs');
const outPath = process.argv[2] ?? join(tmpdir(), 'godot-shot.png');
const driveLisp = process.argv[3] ?? '';
const waitMs = Number(process.argv[4]) || 6000;
const configHome = join(tmpdir(), 'godot-shot-config');

let bridge = null;
function done(code, msg) {
  console.log(msg);
  if (bridge) bridge.dispose();
  app.exit(code);
}

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  protocol.handle('media', serveMediaFile);
  registerFileHandlers();
  registerShellHandlers();
  rmSync(configHome, { recursive: true, force: true });
  mkdirSync(configHome, { recursive: true });
  process.env.MWB_CONFIG_HOME = configHome;
  process.env.MWB_SESSION_STORE = join(configHome, 'workspaces.json');
  process.env.MWB_RECOVERY_DIR = join(configHome, 'recovery');
  delete process.env.MWB_SESSION_SEED;

  try {
    bridge = createServerBridge({ utilityProcess, MessageChannelMain });
  } catch (error) {
    done(1, `failed to fork the spine: ${error.message}`);
    return;
  }

  const offscreen = process.env.SHOT_OFFSCREEN === '1';
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    backgroundColor: '#1b1b23',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      offscreen,
    },
  });
  if (offscreen) win.webContents.on('paint', () => {});

  const capture = async () => {
    try {
      console.log('[shot] settling', waitMs, 'ms (offscreen:', offscreen, ')');
      await new Promise((r) => setTimeout(r, waitMs));
      if (driveLisp) {
        console.log('[shot] driving:', driveLisp);
        await win.webContents.executeJavaScript(`(() => {
          const i = document.querySelector('.repl-input');
          i.value = ${JSON.stringify(driveLisp)};
          i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        })()`);
        await new Promise((r) => setTimeout(r, 2500));
      }
      console.log('[shot] capturing');
      const image = await Promise.race([
        win.webContents.capturePage(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('capturePage timed out')), 12000)),
      ]);
      const png = image.toPNG();
      writeFileSync(outPath, png);
      const { width, height } = image.getSize();
      done(png.length > 0 ? 0 : 1, `wrote ${outPath} (${width}x${height}, ${png.length} bytes)`);
    } catch (error) {
      done(1, `capture failed: ${error.message}`);
    }
  };
  win.webContents.once('did-finish-load', () => {
    console.log('[shot] did-finish-load');
    capture();
  });

  win.loadURL(EDITOR_URL);
  bridge.attachWindow(win.webContents);
  setTimeout(() => done(1, 'timed out'), waitMs + 30000);
});
