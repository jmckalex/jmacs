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
  // Headless self-test for the OVERLAY + MULTI-CURSOR sync slice: drives
  // select-all-matches (C-c D) and highlight-matches (M-s h) through the
  // real server, then asserts (a) the synced cursor set + overlays reached
  // the client MIRROR, (b) the real view.js PAINTED them (secondary caret
  // DOM + decoration DOM), and (c) with MWB_CLIENTS=2 an overlay change
  // PROPAGATES to the second window. See view-client.js runOverlaySelfTest.
  overlaySelftest: process.env.MWB_OVERLAY_SELFTEST === '1',
  // Headless self-test for the MULTI-BUFFER slice: opens a 2nd buffer via
  // find-file, switches a window between the two buffers (asserting each
  // renders its own content + overlays + cursor through the real view.js),
  // and — with MWB_CLIENTS=2 — proves a 2nd window can view a DIFFERENT
  // buffer while the same-buffer lockstep still holds. See view-client.js
  // runMultiBufferSelfTest.
  multibufferSelftest: process.env.MWB_MULTIBUFFER_SELFTEST === '1',
  // Headless self-test for REAL SAVE + the data-safety story: find-file a
  // /tmp scratch file, edit it, assert dirty + the ● modeline indicator,
  // save it, assert the bytes hit disk (the server reads the file back),
  // assert dirty cleared; then edit again and assert an autosave recovery
  // snapshot appears on disk. See view-client.js runSaveSelfTest. Use with a
  // throwaway /tmp save target so the repo / user data is never touched.
  saveSelftest: process.env.MWB_SAVE_SELFTEST === '1',
  // The /tmp scratch file the save self-test find-files + saves to.
  saveTarget: process.env.MWB_SAVE_TARGET || '',
  // A second file the multi-buffer self-test opens via find-file (relative
  // to the server's seed file dir). Defaults to a sibling stdlib file.
  secondFile: process.env.MWB_SECOND_FILE || 'treesitter.js',
  // Whether a SECOND client window exists (MWB_CLIENTS=2). The overlay +
  // multi-buffer self-tests use this to pick driver vs observer roles +
  // decide which window ends the run.
  twoWindow: (Number(process.env.MWB_CLIENTS) || 1) >= 2,
});
