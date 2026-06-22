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

// A trivial bridge so the page knows the preload ran.
contextBridge.exposeInMainWorld('mwb', { ready: true });
