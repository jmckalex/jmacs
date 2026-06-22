/**
 * @file G2 server-view self-test — a STANDALONE Electron entry point for the
 * architect to run by hand (the agent's sandbox can't launch a GUI Electron).
 *
 * It exercises the REAL G2 path end-to-end against REAL Electron + the REAL
 * editor page:
 *   - the real `src/server-bridge.js` forks the real `mwb/server.js`
 *     `utilityProcess` (exactly as `main.js` does behind GODOT_SERVER=1);
 *   - the REAL editor page (`app://…/index.html`) boots with the real preload
 *     re-dispatch, so the real app.js G2 boot constructs `createServerViewClient`
 *     and mounts a REAL `<text-view>` (real `createEditorView` + highlighters)
 *     on a ClientBuffer mirror, routed to the server;
 *   - this driver then DRIVES a marker through the client (via the serverMode-
 *     only `window.__godotG2` hook) and asserts the typed text ROUND-TRIPS: the
 *     server applied it to the canonical buffer and the delta reached the
 *     client's mirror — proving the real renderer is a server client.
 *
 * It asserts the G2 exit-criteria signals:
 *   1. the real G2 view MOUNTS through the server (`isMounted()` true, a buffer
 *      id is set — the seed buffer opened through a HELLO/SNAPSHOT);
 *   2. a typed marker ROUND-TRIPS (the mirror text grows by the marker — key →
 *      intent → server command → delta → mirror).
 *
 * Run it (the agent cannot — GUI launch is permission-blocked in the sandbox):
 *
 *   cd apps/desktop && GODOT_SERVER=1 ./node_modules/.bin/electron \
 *       mwb/server-view-selftest.js \
 *       --user-data-dir=/tmp/godot-g2-selftest --enable-logging=stderr
 *
 * Expected on stderr:
 *   [g2-selftest] mounted-through-server: PASS
 *   [g2-selftest] char-round-trips: PASS
 *   [g2-selftest-done] PASS
 *
 * It exits 0 on PASS, 1 on FAIL or a 20s timeout, and never lets a throw escape
 * into the main process (the guardrail). NOTE the typed marker is written to the
 * server's SEED buffer (view.js by default) IN MEMORY only — the self-test does
 * NOT save, so nothing is written to disk. Point MWB_FILE at a scratch file if
 * you want to be doubly sure.
 */

import { app, BrowserWindow, protocol, utilityProcess, MessageChannelMain } from 'electron';

import { serveAppFile, serveMediaFile, EDITOR_URL } from '../src/serve.js';
import { createServerBridge } from '../src/server-bridge.js';

// The real preload reads process.env.GODOT_SERVER at preload-eval time (the
// launch-time OS env), so it MUST be prefixed on the launch — a runtime
// mutation here would not reach the preload. Bail loudly if it's missing.
if (process.env.GODOT_SERVER !== '1') {
  console.error(
    '[g2-selftest] GODOT_SERVER is not "1" — relaunch with `GODOT_SERVER=1` prefixed.'
  );
  app.exit(1);
}

const PRELOAD = new URL('../src/preload.mjs', import.meta.url).pathname;
const MARKER = 'G2OK';

const results = { mounted: false, roundTrip: false };
let finished = false;

function finish(ok) {
  if (finished) return;
  finished = true;
  console.error(`[g2-selftest] mounted-through-server: ${results.mounted ? 'PASS' : 'FAIL'}`);
  console.error(`[g2-selftest] char-round-trips: ${results.roundTrip ? 'PASS' : 'FAIL'}`);
  console.error(`[g2-selftest-done] ${ok ? 'PASS' : 'FAIL'}`);
  setTimeout(() => app.exit(ok ? 0 : 1), 100);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `window.__godotG2.isMounted()` until the real G2 view has mounted
 *  through the server (or we give up). */
async function waitForMount(win) {
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential polling
    const mounted = await win.webContents.executeJavaScript(
      'Boolean(window.__godotG2 && window.__godotG2.isMounted() && window.__godotG2.bufferId())'
    ).catch(() => false);
    if (mounted) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  return false;
}

/** Drive the marker through the client and confirm it round-trips into the
 *  mirror (the server applied it + the delta came back). We type at the
 *  CURRENT point (wherever the seed buffer opened) and check the marker
 *  SUBSTRING appears — robust regardless of the seed content. NOTE: no
 *  backticks inside executeJavaScript (they would close the outer template and
 *  crash the main process — a known trap); we build the script with
 *  concatenation + JSON.stringify. */
async function driveAndCheck(win) {
  // Read the text before typing.
  const before = await win.webContents.executeJavaScript(
    'window.__godotG2.mirrorText()'
  ).catch(() => null);
  if (typeof before !== 'string') return false;

  // Type the marker one char at a time, as the keymap would.
  for (const ch of MARKER) {
    // eslint-disable-next-line no-await-in-loop
    await win.webContents.executeJavaScript(
      'window.__godotG2.dispatchKey(' + JSON.stringify(ch) + ')'
    ).catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    await sleep(40); // pace like typing; let each round-trip land
  }
  await sleep(300); // let the last server delta settle

  const after = await win.webContents.executeJavaScript(
    'window.__godotG2.mirrorText()'
  ).catch(() => null);
  if (typeof after !== 'string') return false;

  // The marker appears AND the text grew by exactly its length — proving the
  // server applied each self-insert and the deltas reconciled the mirror.
  return after.includes(MARKER) && after.length === before.length + MARKER.length;
}

app.whenReady().then(async () => {
  try {
    protocol.handle('app', serveAppFile);
    protocol.handle('media', serveMediaFile);

    // The REAL bridge — the exact wiring main.js uses behind the flag.
    const bridge = createServerBridge({ utilityProcess, MessageChannelMain });

    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // Surface the page's [godot] G2 boot line for the architect's eye.
    win.webContents.on('console-message', (_e, _level, message) => {
      if (typeof message === 'string' && message.includes('[godot] G2')) {
        console.error(`[g2-selftest] page: ${message}`);
      }
    });

    win.loadURL(EDITOR_URL);
    // The REAL per-window port-transfer dance (transfers the server port to the
    // renderer once the page has loaded).
    bridge.attachWindow(win.webContents);

    // Fail safe: never hang the architect's screen — bail after 20s.
    const guard = setTimeout(() => finish(false), 20000);

    results.mounted = await waitForMount(win);
    if (results.mounted) {
      results.roundTrip = await driveAndCheck(win);
    }
    clearTimeout(guard);
    finish(results.mounted && results.roundTrip);
  } catch (error) {
    // A throw here would pop a main-process dialog; catch + fail cleanly.
    console.error(`[g2-selftest] threw: ${error && error.message}`);
    finish(false);
  }
});

app.on('window-all-closed', () => app.quit());
