/**
 * @file Smoke test — launches the editor in a hidden Electron window,
 * waits for it to load, and checks that the renderer actually projected
 * the buffer into the DOM. Exits 0 on success, 1 on any failure.
 *
 * Run with `pnpm --filter @editor/desktop smoke`. Kept out of the
 * normal test run because it needs an Electron runtime.
 */

import { app, BrowserWindow, protocol } from 'electron';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerFileHandlers } from '../src/files.js';
import { EDITOR_URL, serveAppFile } from '../src/serve.js';

/** A scratch path the file round-trip writes to. */
const savePath = join(tmpdir(), 'jmacs-smoke-save.txt');

/** The preload script — shared with the real window in main.js. */
const PRELOAD = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'preload.mjs'
);

let done = false;

/** Report a result once and quit. */
function finish(code, message) {
  if (done) return;
  done = true;
  console.log(code === 0 ? `PASS — ${message}` : `FAIL — ${message}`);
  app.exit(code);
}

app.whenReady().then(() => {
  protocol.handle('app', serveAppFile);
  registerFileHandlers();

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (...args) => {
    const detail = args.find((a) => a && typeof a === 'object');
    console.log('  [renderer]', detail?.message ?? args.join(' '));
  });
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    finish(1, `page failed to load (${code}): ${desc}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    finish(1, `render process gone: ${details.reason}`);
  });

  win.webContents.once('did-finish-load', async () => {
    try {
      // Give the module graph a moment to evaluate and the first
      // animation frame to render.
      await new Promise((resolve) => setTimeout(resolve, 700));

      const render = await win.webContents.executeJavaScript(`(() => ({
        lines: document.querySelectorAll('.editor-line').length,
        hasCursor: !!document.querySelector('.editor-cursor'),
        modeline: document.getElementById('modeline-position')?.textContent ?? '',
      }))()`);
      console.log('  rendered:', JSON.stringify(render));

      // Drive the real input path: dispatch key events at the editor
      // and confirm the projected DOM changes.
      const input = await win.webContents.executeJavaScript(`(async () => {
        const editor = document.querySelector('.editor');
        editor.focus();
        const press = (key, opts = {}) =>
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key, bubbles: true, cancelable: true, ...opts,
          }));
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const firstLine = () => document.querySelector('.editor-line').textContent;

        const before = firstLine();
        for (const ch of 'Zz!') press(ch);
        await frame();
        const afterType = firstLine();
        press('Backspace'); press('Backspace'); press('Backspace');
        await frame();
        const afterDelete = firstLine();
        return { before, afterType, afterDelete };
      })()`);
      console.log('  input:', JSON.stringify(input));

      // Drive the REPL: evaluate arithmetic, and have Lisp edit the
      // buffer, confirming the L3 -> L2 -> L4 path.
      const lisp = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        const lastResult = () => {
          const all = document.querySelectorAll('.repl-result');
          return all.length ? all[all.length - 1].textContent : '';
        };

        submit('(+ 1 2 3)');
        const arithmetic = lastResult();

        // handle-key exists only if the standard library loaded.
        submit('handle-key');
        const stdlib = lastResult();

        // A prefix key (C-x) begins a sequence rather than running a
        // command; this checks and then resets the pending state.
        submit('(begin (handle-key "C-x")'
          + ' (let ((p (not (eq? active-keymap the-keymap))))'
          + ' (reset-keymap!) p))');
        const sequence = lastResult();

        // The module system: define a module, import it, call its export.
        submit('(module demo (export answer) (define (answer) 42))');
        submit('(begin (import demo) (answer))');
        const modules = lastResult();

        // Multiple buffers: create one (the view re-points to it), then
        // switch back to the first.
        submit('(begin (new-buffer!) (buffer-count))');
        const bufferCount = lastResult();
        await frame();
        const newBufferLines = document.querySelectorAll('.editor-line').length;
        submit('(previous-buffer!)');
        await frame();

        const firstLineBefore = document.querySelector('.editor-line').textContent;
        submit('(goto! 0)');
        submit('(insert! "[lisp] ")');
        await frame();
        const firstLineAfter = document.querySelector('.editor-line').textContent;

        return {
          arithmetic, stdlib, sequence, modules,
          bufferCount, newBufferLines,
          firstLineBefore, firstLineAfter,
        };
      })()`);
      console.log('  lisp:', JSON.stringify(lisp));

      // Check the file bridge: the host API is exposed, and a save with
      // an explicit path writes the file (no dialog needed).
      const files = await win.webContents.executeJavaScript(`(async () => {
        const api = window.host;
        const exposed = !!(api
          && typeof api.openFile === 'function'
          && typeof api.saveFile === 'function');
        let saved = false;
        if (exposed) {
          const result = await api.saveFile(
            ${JSON.stringify(savePath)}, 'smoke save ok');
          saved = result !== null;
        }
        return { exposed, saved };
      })()`);
      console.log('  files:', JSON.stringify(files));
      const savedContent = await readFile(savePath, 'utf8').catch(() => null);
      await rm(savePath, { force: true });

      // Incremental search: C-s opens the minibuffer; typing a query
      // selects a match (rendered as selection rectangles).
      const search = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const editor = document.querySelector('.editor');
        editor.focus();
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 's', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        const mb = document.querySelector('.minibuffer-input');
        const panel = document.querySelector('.minibuffer');
        const opened = !!mb && panel !== null && !panel.hidden;
        let matched = false;
        if (opened) {
          mb.value = 'Lisp';
          mb.dispatchEvent(new Event('input', { bubbles: true }));
          await frame();
          matched = document.querySelectorAll('.editor-selection-rect').length > 0;
          mb.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
          }));
        }
        return { opened, matched };
      })()`);
      console.log('  search:', JSON.stringify(search));

      const renderOk =
        render.lines > 0 && render.hasCursor && render.modeline.length > 0;
      const typeOk = input.afterType === 'Zz!' + input.before;
      const deleteOk = input.afterDelete === input.before;
      const replOk = lisp.arithmetic === '6';
      const stdlibOk = lisp.stdlib.includes('procedure');
      const sequenceOk = lisp.sequence === '#t';
      const modulesOk = lisp.modules === '42';
      const buffersOk = lisp.bufferCount === '2' && lisp.newBufferLines === 1;
      const interopOk = lisp.firstLineAfter === '[lisp] ' + lisp.firstLineBefore;
      const filesOk =
        files.exposed && files.saved && savedContent === 'smoke save ok';
      const searchOk = search.opened && search.matched;

      if (
        renderOk && typeOk && deleteOk && replOk && stdlibOk && sequenceOk &&
        modulesOk && buffersOk && interopOk && filesOk && searchOk
      ) {
        finish(
          0,
          `${render.lines} lines; keymap, sequences, modules, buffers, search, REPL and files all work`
        );
      } else if (!renderOk) {
        finish(1, 'editor did not render expected DOM');
      } else if (!typeOk || !deleteOk) {
        finish(1, 'editor rendered but typing did not update the DOM');
      } else if (!replOk) {
        finish(1, 'the REPL did not evaluate Lisp');
      } else if (!stdlibOk) {
        finish(1, 'the standard library did not load');
      } else if (!sequenceOk) {
        finish(1, 'key sequences (prefix keys) did not work');
      } else if (!modulesOk) {
        finish(1, 'the module system did not work');
      } else if (!buffersOk) {
        finish(1, 'multiple buffers did not work');
      } else if (!interopOk) {
        finish(1, 'Lisp did not edit the buffer');
      } else if (!filesOk) {
        finish(1, 'the file bridge did not work');
      } else {
        finish(1, 'incremental search did not work');
      }
    } catch (err) {
      finish(1, `inspection failed: ${err.message}`);
    }
  });

  win.loadURL(EDITOR_URL);
  setTimeout(() => finish(1, 'timed out waiting for the editor to load'), 20000);
});
