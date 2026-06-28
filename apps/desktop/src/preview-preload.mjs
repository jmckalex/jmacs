/**
 * @file Preload for the popped-out Markdown-preview window (preview-window.html).
 *
 * A minimal bridge for the forward/inverse-search relay: send the embedded
 * preview's messages UP to main (which routes them to the editor window), and
 * receive forward-scroll messages DOWN from main. No other host surface is
 * exposed — the window only shows a preview.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('host', {
  /** Relay a message from the embedded preview up to the editor (ready /
   *  source-line-click). */
  up: (msg) => ipcRenderer.send('preview-sync:up', msg),
  /** Receive a message from the editor (scroll-to-line) to apply to the preview. */
  onDown: (cb) => ipcRenderer.on('preview-sync:down', (_event, msg) => cb(msg)),
});
