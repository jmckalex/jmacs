/**
 * @file Model-B Phase-0 spike — the harness window's preload. Its sole
 * job is to receive the MessagePort that main transfers (the direct
 * channel to the Lisp server) and hand it to the page over a window
 * event. Deliberately tiny — the spike's client logic lives in the page.
 */

import { contextBridge, ipcRenderer } from 'electron';

// main posts the server-channel port over the 'mwb:port' IPC channel
// (webContents.postMessage). ipcRenderer delivers transferred ports on
// `event.ports`. We re-dispatch it to the page as a window message so the
// harness module (which can't touch ipcRenderer across the bridge) gets a
// real MessagePort.
ipcRenderer.on('mwb:port', (event) => {
  const [port] = event.ports;
  if (port) {
    // postMessage to our own window, transferring the port into page-land.
    window.postMessage({ type: 'mwb:port' }, '*', [port]);
  }
});

// A trivial bridge so the page knows the preload ran. `autobench` is set
// from the MWB_AUTOBENCH env var so a headless launch can run the
// benchmark with no human in the loop (see launch.js).
contextBridge.exposeInMainWorld('mwb', {
  ready: true,
  autobench: process.env.MWB_AUTOBENCH === '1',
  // Headless self-test for the render-from-mirror view harness: drive a
  // handful of edits through the mirror→server→delta→re-render path and
  // log the outcome to stderr, so the slice is verifiable without a screen.
  selftest: process.env.MWB_VIEW_SELFTEST === '1',
  // Headless self-test for the same-buffer (two-client) feature: client 0
  // types a marker; client 1 (the observer) confirms it sees the edit on
  // its own mirror without having originated it — the Model-B payoff.
  sameBuffer: process.env.MWB_SAME_BUFFER === '1',
  // Headless self-test for the RICHER server-side stdlib slice
  // (PRIMITIVE-SPLIT.md): drives copy/yank and a Markdown mode binding
  // (C-c b) through the real server+protocol+view.js path and asserts the
  // client mirror reflects each. Use with MWB_FILE=<a .md file>.
  commandsSelftest: process.env.MWB_COMMANDS_SELFTEST === '1',
});
