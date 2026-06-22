/**
 * @file G1 server-bridge self-test — a STANDALONE Electron entry point for the
 * architect to run by hand (the agent's sandbox can't launch a GUI Electron).
 *
 * It exercises the REAL G1 wiring against REAL Electron primitives:
 *   - the real `src/server-bridge.js` (`createServerBridge`) — the exact code
 *     `main.js` runs behind GODOT_SERVER=1 — forks the real `mwb/server.js`
 *     `utilityProcess`;
 *   - the real `src/preload.mjs` re-dispatch (gated on GODOT_SERVER=1) carries
 *     the transferred port into the page;
 *   - a minimal page (`server-bridge-selftest.html`) confirms the port arrived.
 *
 * It asserts the two G1 exit-criteria signals:
 *   1. the server `utilityProcess` STARTS and posts `server-ready` (it boots
 *      the interpreter + model exactly as the prototype does);
 *   2. the PORT HANDSHAKE completes (the renderer receives a live MessagePort).
 *
 * Run it (the agent cannot — GUI launch is permission-blocked in the sandbox):
 *
 *   cd apps/desktop && GODOT_SERVER=1 ./node_modules/.bin/electron \
 *       mwb/server-bridge-selftest.js \
 *       --user-data-dir=/tmp/godot-g1-selftest --enable-logging=stderr
 *
 * Expected on stderr:
 *   [g1-selftest] server-ready: PASS
 *   [g1-selftest] port-handshake: PASS
 *   [g1-selftest-done] PASS
 *
 * It exits 0 on PASS, 1 on FAIL or a 10s timeout. It is read-only beyond the
 * server's normal startup (which only touches its recovery temp dir), and never
 * lets a throw escape into the main process (the guardrail).
 */

import { app, BrowserWindow, protocol, utilityProcess, MessageChannelMain } from 'electron';

import { serveAppFile } from '../src/serve.js';
import { createServerBridge } from '../src/server-bridge.js';

// IMPORTANT: the real preload (preload.mjs) reads `process.env.GODOT_SERVER` at
// preload-eval time, which reflects the OS environment the app was LAUNCHED
// with — runtime mutation in this main entry does NOT reach the preload. So you
// MUST launch with `GODOT_SERVER=1` prefixed (see the header). We assert it here
// and bail loudly if it is missing, rather than silently testing the wrong path.
if (process.env.GODOT_SERVER !== '1') {
  console.error(
    '[g1-selftest] GODOT_SERVER is not "1" — relaunch with `GODOT_SERVER=1` prefixed.'
  );
  app.exit(1);
}

const PRELOAD = new URL('../src/preload.mjs', import.meta.url).pathname;
const PAGE_URL = 'app://editor/apps/desktop/mwb/server-bridge-selftest.html';

const results = { serverReady: false, portHandshake: false };
let finished = false;

function finish(ok) {
  if (finished) return;
  finished = true;
  console.error(`[g1-selftest] server-ready: ${results.serverReady ? 'PASS' : 'FAIL'}`);
  console.error(`[g1-selftest] port-handshake: ${results.portHandshake ? 'PASS' : 'FAIL'}`);
  console.error(`[g1-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
  setTimeout(() => app.exit(ok ? 0 : 1), 100);
}

function maybeDone() {
  if (results.serverReady && results.portHandshake) finish(true);
}

app.whenReady().then(() => {
  try {
    protocol.handle('app', serveAppFile);

    // The REAL bridge — the exact wiring main.js uses behind the flag.
    const bridge = createServerBridge({ utilityProcess, MessageChannelMain });

    // The server posts `server-ready` over parentPort after the first client
    // attaches (mwb/server.js). Observe it on the bridge's child process.
    if (bridge.process && typeof bridge.process.on === 'function') {
      bridge.process.on('message', (message) => {
        if (message && message.type === 'server-ready') {
          results.serverReady = true;
          maybeDone();
        }
      });
    }

    const win = new BrowserWindow({
      width: 640,
      height: 400,
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // Watch the page's console for the client-side PASS line (the port arrived
    // via the real preload re-dispatch + host.serverMode is the gate).
    win.webContents.on('console-message', (_e, _level, message) => {
      if (message.startsWith('[g1-selftest-client]')) {
        results.portHandshake = message.includes('PASS');
        maybeDone();
      }
    });

    win.loadURL(PAGE_URL);
    // The REAL per-window port-transfer dance (transfers a port to the renderer
    // once the page has loaded).
    bridge.attachWindow(win.webContents);

    // Fail safe: never hang the architect's screen — bail after 10s.
    setTimeout(() => finish(false), 10000);
  } catch (error) {
    // A throw here would pop a main-process dialog; catch + fail cleanly.
    console.error(`[g1-selftest] threw: ${error && error.message}`);
    finish(false);
  }
});

app.on('window-all-closed', () => app.quit());
