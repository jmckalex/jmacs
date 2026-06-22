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

// How many client windows to open. MWB_CLIENTS=2 stands up a SECOND client
// attached to the same server, viewing the same buffer — the Model-B killer
// feature (one buffer in two windows; type in one, watch the other update).
const CLIENT_COUNT = Math.max(1, Number(process.env.MWB_CLIENTS) || 1);

/** @type {Electron.UtilityProcess | null} */
let server = null;
/** @type {BrowserWindow[]} */
const windows = [];

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
  // The server-side save self-test (MWB_SAVE_SELFTEST=1) posts its result
  // here when done (it owns fs, so it does the bytes-on-disk + snapshot
  // assertions itself); exit on it. Other server messages (server-ready) are
  // ignored — the prototype doesn't gate on them.
  server.on('message', (message) => {
    if (message && message.type === 'save-selftest-done') {
      console.error(`[mwb] save self-test ${message.ok ? 'PASS' : 'FAIL'}`);
      setTimeout(() => {
        if (server) server.kill();
        app.exit(message.ok ? 0 : 1);
      }, 100);
    }
    if (message && message.type === 'undo-selftest-done') {
      console.error(`[mwb] undo self-test ${message.ok ? 'PASS' : 'FAIL'}`);
      setTimeout(() => {
        if (server) server.kill();
        app.exit(message.ok ? 0 : 1);
      }, 100);
    }
  });
}

/** Open one client window (index `n`) and wire its own MessageChannel to
 *  the server. Each window is a separate renderer (its own JS isolation,
 *  plan §7) sharing the one server buffer. */
function createWindow(n) {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    x: 60 + n * 60,
    y: 60 + n * 60,
    backgroundColor: '#1b1b23',
    title: `Godot — Model B (client ${n})`,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  windows.push(win);
  win.loadURL(HARNESS_URL);

  // Surface the renderer's console to our stderr so the latency numbers
  // (and the *-done lines) are visible from a headless launch. Tag each
  // line with the client index.
  win.webContents.on('console-message', (_e, _level, message) => {
    console.error(`[renderer ${n}]`, message);
    // The view self-test logs this line when done; quit (only the primary
    // client runs the self-test).
    if (message.startsWith('[mwb-view-selftest-done]')) {
      setTimeout(() => {
        if (server) server.kill();
        app.exit(message.includes('PASS') ? 0 : 1);
      }, 100);
    }
    // The same-buffer self-test (two clients): the primary logs this once it
    // has confirmed the OTHER window saw its edit.
    if (message.startsWith('[mwb-same-buffer-done]')) {
      setTimeout(() => {
        if (server) server.kill();
        app.exit(message.includes('PASS') ? 0 : 1);
      }, 100);
    }
    // The richer-stdlib self-test (kill/yank + a Markdown binding through
    // the real server + view.js). See view-client.js runCommandsSelfTest.
    if (message.startsWith('[mwb-commands-selftest-done]')) {
      setTimeout(() => {
        if (server) server.kill();
        app.exit(message.includes('PASS') ? 0 : 1);
      }, 100);
    }
    // The overlay + multi-cursor self-test (select-all-matches +
    // highlight-matches through the real server + view.js; with
    // MWB_CLIENTS=2 the second window's observer logs the done line once it
    // has seen the overlay propagate). See view-client.js runOverlaySelfTest.
    if (message.startsWith('[mwb-overlay-selftest-done]')) {
      setTimeout(() => {
        if (server) server.kill();
        app.exit(message.includes('PASS') ? 0 : 1);
      }, 100);
    }
    // The multi-buffer self-test: a window opens a 2nd buffer + switches
    // between buffers; with MWB_CLIENTS=2 a 2nd window views a different
    // buffer and the same-buffer lockstep still holds. See view-client.js
    // runMultiBufferSelfTest.
    if (message.startsWith('[mwb-multibuffer-selftest-done]')) {
      setTimeout(() => {
        if (server) server.kill();
        app.exit(message.includes('PASS') ? 0 : 1);
      }, 100);
    }
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

  // Each window gets its OWN MessageChannel to the server. main creates the
  // channel, posts port1 to the server (a new client) and port2 into the
  // page once it has loaded.
  const { port1, port2 } = new MessageChannelMain();
  server.postMessage({ type: 'init', client: n }, [port1]);
  win.webContents.once('did-finish-load', () => {
    win.webContents.postMessage('mwb:port', null, [port2]);
  });
}

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  startServer();
  for (let n = 0; n < CLIENT_COUNT; n += 1) createWindow(n);
});

app.on('window-all-closed', () => {
  if (server) server.kill();
  app.quit();
});
