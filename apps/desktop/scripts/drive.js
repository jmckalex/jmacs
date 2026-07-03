/**
 * @file A persistent, drivable instance of the editor. Boots the real app once
 * (Model-B spine + window, hidden) and exposes a localhost HTTP control port so
 * an agent (or a dev) can drive it interactively — eval JS in the renderer, run
 * Lisp through the REPL, and capture screenshots — without re-booting per step.
 *
 *   pnpm --filter @editor/desktop drive          # listens on 127.0.0.1:$DRIVE_PORT (default 8347)
 *
 * Control API (all localhost only):
 *   GET  /ping                       -> { ok, ready }
 *   POST /eval   body = JS           -> { ok, value } | { ok:false, error }   (JS may `return`, may be async)
 *   POST /lisp   body = Lisp form    -> { ok, result }                        (submits to the REPL, returns the new result text)
 *   GET  /shot?path=/abs.png         -> { ok, path, size }                    (capturePage -> PNG on disk)
 *   POST /quit                       -> exits
 *
 * Hermetic: the spine's config/session/recovery point at a scratch dir.
 */

import {
  app, BrowserWindow, protocol, utilityProcess, MessageChannelMain,
} from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServerBridge } from '../src/server-bridge.js';
import { registerFileHandlers } from '../src/files.js';
import { registerShellHandlers } from '../src/shell.js';
import { EDITOR_URL, serveAppFile, serveMediaFile } from '../src/serve.js';

const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'preload.mjs');
const PORT = Number(process.env.DRIVE_PORT) || 8347;
const configHome = join(tmpdir(), 'godot-drive-config');

let win = null;
let bridge = null;
let ready = false;

/** Collect a request body into a string. */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
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

  bridge = createServerBridge({ utilityProcess, MessageChannelMain });

  win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 1000,
    backgroundColor: '#1b1b23',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  win.webContents.once('did-finish-load', () => {
    // Give the spine round-trip time to mount the first view before we call ready.
    setTimeout(() => { ready = true; console.log('[drive] ready'); }, 4000);
  });
  win.loadURL(EDITOR_URL);
  bridge.attachWindow(win.webContents);

  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/ping') return send(200, { ok: true, ready });

      if (url.pathname === '/eval') {
        const js = await readBody(req);
        // Wrap so the caller can `return` and/or be async; result is JSON round-tripped.
        const out = await win.webContents.executeJavaScript(
          `(async () => { try { const v = await (async function(){ ${js} })(); `
          + `return JSON.stringify({ ok: true, value: v === undefined ? null : v }); } `
          + `catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); } })()`,
        );
        return send(200, JSON.parse(out));
      }

      if (url.pathname === '/lisp') {
        const src = await readBody(req);
        const out = await win.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const input = document.querySelector('.repl-input');
            if (!input) return JSON.stringify({ ok: false, error: 'no REPL input' });
            const before = document.querySelectorAll('.repl-result').length;
            input.value = ${JSON.stringify(src)};
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            for (let k = 0; k < 200 && document.querySelectorAll('.repl-result').length <= before; k += 1) await wait(20);
            const all = document.querySelectorAll('.repl-result');
            return JSON.stringify({ ok: true, result: all.length ? all[all.length - 1].textContent : '' });
          })()`,
        );
        return send(200, JSON.parse(out));
      }

      if (url.pathname === '/shot') {
        const p = url.searchParams.get('path') || join(tmpdir(), 'godot-drive-shot.png');
        const image = await win.webContents.capturePage();
        writeFileSync(p, image.toPNG());
        return send(200, { ok: true, path: p, size: image.getSize() });
      }

      if (url.pathname === '/quit') {
        send(200, { ok: true });
        if (bridge) bridge.dispose();
        setTimeout(() => app.exit(0), 50);
        return;
      }

      send(404, { ok: false, error: `unknown path ${url.pathname}` });
    } catch (error) {
      send(500, { ok: false, error: String(error && error.message ? error.message : error) });
    }
  });
  server.listen(PORT, '127.0.0.1', () => console.log('[drive] listening on 127.0.0.1:' + PORT));
});
