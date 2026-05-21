/**
 * @file Capture a PNG of the editor as it first opens. A development
 * aid for reviewing the visual defaults without launching the app.
 *
 * Run with `pnpm --filter @editor/desktop screenshot [outPath]`.
 */

import { app, BrowserWindow, protocol } from 'electron';
import { writeFile } from 'node:fs/promises';

import { EDITOR_URL, serveAppFile } from '../src/serve.js';

const outPath = process.argv[2] ?? 'editor-screenshot.png';

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);

  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    show: false,
    backgroundColor: '#1b1b23',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.webContents.once('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));

    // Exercise the REPL so the capture shows it alive.
    await win.webContents.executeJavaScript(`(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      const replInput = document.querySelector('.repl-input');
      const submit = async (src) => {
        replInput.value = src;
        replInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
        await frame();
      };
      await submit('(doc forward-char)');
      await submit('(module geometry (export area)'
        + ' (define (area r) (* 3.14159 r r)))');
      await submit('(begin (import geometry) (area 10))');
      // Switch to the syntax-highlighted scratch.lisp buffer and put
      // the cursor on an opening paren to show the bracket match.
      await submit('(next-buffer!)');
      await submit('(begin (next-line) (next-line) (next-line)'
        + ' (next-line) (next-line))');
    })()`);

    await new Promise((resolve) => setTimeout(resolve, 350));
    const image = await win.webContents.capturePage();
    await writeFile(outPath, image.toPNG());
    console.log(`wrote ${outPath}`);
    app.exit(0);
  });

  win.loadURL(EDITOR_URL);
});
