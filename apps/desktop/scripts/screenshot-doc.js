/**
 * @file Capture a PNG of the editor with a doc-view buffer open. A
 * development aid for reviewing the documentation system without
 * launching the app.
 *
 * Requires that `pnpm run docs` has been run first; otherwise the
 * doc-view stays empty and the screenshot just shows the editor.
 *
 * Run with `pnpm --filter @editor/desktop screenshot-doc [outPath]`.
 */

import { app, BrowserWindow, protocol } from 'electron';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerFileHandlers } from '../src/files.js';
import { EDITOR_URL, serveAppFile } from '../src/serve.js';

const outPath = process.argv[2] ?? 'doc-view-screenshot.png';

const PRELOAD = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'preload.mjs'
);

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  registerFileHandlers();

  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    show: false,
    backgroundColor: '#2b333b',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.once('did-finish-load', async () => {
    // Give the renderer time to load the stdlib, fetch the doc
    // manifest, and settle.
    await new Promise((resolve) => setTimeout(resolve, 800));

    await win.webContents.executeJavaScript(`(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      const replInput = document.querySelector('.repl-input');
      replInput.value = '(open-doc "forward-char")';
      replInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      }));
      // The open-doc primitive fires an async fetch; six frames is
      // plenty for both the fetch and the buffer switch.
      for (let i = 0; i < 6; i += 1) await frame();
    })()`);

    await new Promise((resolve) => setTimeout(resolve, 350));
    const image = await win.webContents.capturePage();
    await writeFile(outPath, image.toPNG());
    console.log(`wrote ${outPath}`);
    app.exit(0);
  });

  win.loadURL(EDITOR_URL);
});
