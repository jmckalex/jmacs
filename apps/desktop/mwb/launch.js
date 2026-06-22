/**
 * @file Model-B Phase-0 spike — a STANDALONE Electron entry point.
 *
 * This is NOT the real app's main process. It exists only to run the
 * latency experiment in isolation: it forks the Lisp server into a
 * `utilityProcess`, opens one client window (the harness page), and wires
 * a direct MessagePort channel between them (plan §3 (i) + §4). The real
 * apps/desktop/src/main.js is untouched, so the existing app and its
 * suite are unaffected.
 *
 * Run it explicitly:
 *   cd apps/desktop && ./node_modules/.bin/electron mwb/launch.js \
 *       --user-data-dir=/tmp/godot-mw-b-userdata --enable-logging=stderr
 *
 * Channel topology (the recommended one from the plan):
 *
 *     renderer (client) <== MessagePort ==> server (utilityProcess)
 *            ^                                      ^
 *            |  ipcRenderer.postMessage(port)       |  parentPort.postMessage(port)
 *            +------------------ main --------------+
 *
 * main creates ONE MessageChannelMain and hands port1 to the server and
 * port2 to the renderer; thereafter client and server talk directly, no
 * main hop on the hot path (plan §4 tactic 2).
 */

import {
  app,
  BrowserWindow,
  MessageChannelMain,
  protocol,
  utilityProcess,
} from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveAppFile } from '../src/serve.js';

const here = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(here, 'preload.mjs');
const SERVER_MODULE = join(here, 'server.js');
// MWB_VIEW=1 opens the render-from-mirror harness (the REAL view.js driven
// by a mirror); otherwise the Phase-0 latency harness (trivial painter).
const VIEW_MODE = process.env.MWB_VIEW === '1';
const HARNESS_URL = VIEW_MODE
  ? 'app://editor/apps/desktop/mwb/view-harness.html'
  : 'app://editor/apps/desktop/mwb/harness.html';

/** @type {Electron.UtilityProcess | null} */
let server = null;
/** @type {BrowserWindow | null} */
let win = null;

function startServer() {
  // The server is a Node ESM module; serviceName shows up in process
  // listings / crash reports as a named, isolated process (plan §7.1:
  // a server crash kills only the server).
  server = utilityProcess.fork(SERVER_MODULE, [], {
    serviceName: 'godot-mwb-server',
    stdio: 'inherit', // so the server's console.* reaches our stderr
  });
  server.on('exit', (code) => {
    console.error(`[mwb] server exited (code ${code})`);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 640,
    backgroundColor: '#1b1b23',
    title: 'Godot — Model B Phase 0 latency spike',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadURL(HARNESS_URL);

  // Surface the renderer's console to our stderr so the latency numbers
  // (and the autobench-done line) are visible from a headless launch.
  win.webContents.on('console-message', (_e, _level, message) => {
    console.error('[renderer]', message);
    // The render-from-mirror self-test logs this line when done; quit so a
    // headless `MWB_VIEW=1 MWB_VIEW_SELFTEST=1` run terminates cleanly.
    if (message.startsWith('[mwb-view-selftest-done]')) {
      setTimeout(() => {
        if (server) server.kill();
        app.exit(message.includes('PASS') ? 0 : 1);
      }, 100);
    }
    // In autobench mode, the page logs this line when both passes are
    // done; we read the JSON, print a clean summary, and quit.
    if (message.startsWith('[mwb-autobench-done]')) {
      const json = message.slice('[mwb-autobench-done]'.length).trim();
      console.error('\n===== MWB Phase 0 latency (ms) =====');
      try {
        const r = JSON.parse(json);
        const row = (name, s) =>
          s
            ? `${name.padEnd(11)} n=${s.n}  mean=${s.mean}  p50=${s.p50}  p95=${s.p95}  p99=${s.p99}  max=${s.max}`
            : `${name.padEnd(11)} (no samples)`;
        console.error(row('local-echo', r.localEcho));
        console.error(row('round-trip', r.roundTrip));
        console.error(row('baseline', r.baseline));
      } catch {
        console.error(json);
      }
      console.error('====================================\n');
      setTimeout(() => {
        if (server) server.kill();
        app.exit(0);
      }, 100);
    }
  });
}

/** Create the channel and transfer the two ends. The server must be up
 *  first (it waits for its port on parentPort); the renderer asks for its
 *  port via the preload once the page is ready. */
function wireChannel() {
  const { port1, port2 } = new MessageChannelMain();
  // Server gets port1.
  server.postMessage({ type: 'init' }, [port1]);
  // Renderer gets port2 — delivered into the page over a dedicated IPC
  // channel the preload listens for.
  win.webContents.once('did-finish-load', () => {
    win.webContents.postMessage('mwb:port', null, [port2]);
  });
}

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  startServer();
  createWindow();
  wireChannel();
});

app.on('window-all-closed', () => {
  if (server) server.kill();
  app.quit();
});
