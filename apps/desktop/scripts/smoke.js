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

      // The startup splash: present in the background layer, and
      // dismissed (no longer visible) once a buffer is switched.
      const splash = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const present =
          document.querySelector('.editor-background .splash.is-visible')
            !== null;
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        submit('(next-buffer!)');     // a switch dismisses the splash
        submit('(previous-buffer!)'); // ... and back: the count is intact
        await frame();
        return {
          present,
          dismissed: document.querySelector('.splash.is-visible') === null,
        };
      })()`);
      console.log('  splash:', JSON.stringify(splash));

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

        // Multiple buffers + highlighting: two buffers are seeded;
        // switching to scratch.lisp shows syntax-highlighted spans.
        submit('(buffer-count)');
        const bufferCount = lastResult();
        submit('(next-buffer!)');
        await frame();
        const tokenSpans = document.querySelectorAll(
          '.tok-keyword, .tok-comment, .tok-string'
        ).length;
        submit('(previous-buffer!)');
        await frame();

        const firstLineBefore = document.querySelector('.editor-line').textContent;
        submit('(goto! 0)');
        submit('(insert! "[lisp] ")');
        await frame();
        const firstLineAfter = document.querySelector('.editor-line').textContent;

        return {
          arithmetic, stdlib, sequence, modules,
          bufferCount, tokenSpans,
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

      // Command palette: M-x opens it, a query filters commands, Enter
      // runs the top match and closes the minibuffer.
      const palette = await win.webContents.executeJavaScript(`(async () => {
        const editor = document.querySelector('.editor');
        editor.focus();
        // The real macOS event: Option composes a character into key,
        // and code carries the physical key.
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: '≈', code: 'KeyX', altKey: true, bubbles: true, cancelable: true,
        }));
        const mb = document.querySelector('.minibuffer-input');
        const panel = document.querySelector('.minibuffer');
        const opened = !!mb && panel !== null && !panel.hidden;
        const focused = document.activeElement === mb;
        let matched = false;
        let closed = false;
        if (opened) {
          mb.value = 'beginning-of-buffer';
          mb.dispatchEvent(new Event('input', { bubbles: true }));
          matched = document.querySelector('.minibuffer-status')
            .textContent.includes('beginning-of-buffer');
          mb.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
          closed = panel.hidden;
        }
        return { opened, matched, closed, focused };
      })()`);
      console.log('  palette:', JSON.stringify(palette));

      // Tree-sitter: JavaScript, Python and HTML buffers are highlighted
      // by their grammars. The function spans in Python prove it is the
      // grammar and not the line tokenizer (which never emits @function).
      const treesitter = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        submit('(new-buffer! "smoke.js")');
        submit('(insert! "const answer = 42;")');
        await frame();
        const keywords = document.querySelectorAll('.tok-keyword').length;
        const numbers = document.querySelectorAll('.tok-number').length;
        submit('(new-buffer! "smoke.py")');
        submit('(insert! "def go(): return go()")');
        await frame();
        const pyFunctions = document.querySelectorAll('.tok-function').length;
        submit('(new-buffer! "smoke.html")');
        submit('(insert! "<div id=x></div>")');
        await frame();
        const htmlTags = document.querySelectorAll('.tok-tag').length;
        return {
          // The languages whose grammar WASM actually loaded.
          langs: document.body.dataset.treesitter,
          keywords,
          numbers,
          pyFunctions,
          htmlTags,
        };
      })()`);
      console.log('  treesitter:', JSON.stringify(treesitter));

      // The background and overlay layers exist and are stacked right.
      const layers = await win.webContents.executeJavaScript(`(() => {
        const z = (sel) =>
          Number(getComputedStyle(document.querySelector(sel)).zIndex);
        return {
          background: document.querySelector('.editor-background') !== null,
          overlay: document.querySelector('.editor-overlay') !== null,
          ordered:
            z('.editor-background') < z('.editor-lines') &&
            z('.editor-lines') < z('.editor-cursor') &&
            z('.editor-cursor') < z('.editor-overlay'),
        };
      })()`);
      console.log('  layers:', JSON.stringify(layers));

      // Replace-string: a chained two-prompt minibuffer flow.
      const replace = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const replSubmit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        replSubmit('(new-buffer! "replace-test")');
        replSubmit('(insert! "foo foo foo")');
        await frame();
        replSubmit('(replace-string)');
        const mb = document.querySelector('.minibuffer-input');
        const fill = async (text) => {
          mb.value = text;
          mb.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
          await frame();
        };
        await fill('foo');
        await fill('bar');
        return { text: document.querySelector('.editor-line').textContent };
      })()`);
      console.log('  replace:', JSON.stringify(replace));

      // Mouse: click in the buffer to place the cursor on another line.
      const mouse = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const replSubmit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        replSubmit('(new-buffer! "mouse-test")');
        await frame();
        const editor = document.querySelector('.editor');
        editor.focus();
        const press = (key) => editor.dispatchEvent(new KeyboardEvent('keydown', {
          key, bubbles: true, cancelable: true,
        }));
        for (const ch of 'alpha') press(ch);
        press('Enter');
        for (const ch of 'beta') press(ch);
        press('Enter');
        for (const ch of 'gamma') press(ch);
        await frame();
        const before = document.getElementById('modeline-position').textContent;
        const click = (x, y) => {
          editor.dispatchEvent(new MouseEvent('mousedown', {
            clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true,
          }));
        };
        // The cursor is on line 3; click line 1 and check it moved.
        const line0 = document.querySelectorAll('.editor-line')[0].getBoundingClientRect();
        click(line0.left + 16, line0.top + 4);
        await frame();
        const after = document.getElementById('modeline-position').textContent;
        // Click well past the end of line 2 ("beta") — the cursor should
        // land at that line's end, not stay put.
        const line1 = document.querySelectorAll('.editor-line')[1].getBoundingClientRect();
        click(line1.right + 90, line1.top + 4);
        await frame();
        const endOfLine = document.getElementById('modeline-position').textContent;
        // Double-click selects the word under the pointer.
        const line0b = document.querySelectorAll('.editor-line')[0].getBoundingClientRect();
        editor.dispatchEvent(new MouseEvent('dblclick', {
          clientX: line0b.left + 12, clientY: line0b.top + 4,
          bubbles: true, cancelable: true,
        }));
        await frame();
        return {
          before,
          after,
          endOfLine,
          wordSelected: document.querySelectorAll('.editor-selection-rect').length > 0,
        };
      })()`);
      console.log('  mouse:', JSON.stringify(mouse));

      // Markdown: a .md buffer highlights a heading.
      const markdown = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        replInput.value = '(new-buffer! "notes.md")';
        replInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
        await frame();
        const editor = document.querySelector('.editor');
        editor.focus();
        for (const ch of '# Title') {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: ch, bubbles: true, cancelable: true,
          }));
        }
        await frame();
        return { headings: document.querySelectorAll('.tok-heading').length };
      })()`);
      console.log('  markdown:', JSON.stringify(markdown));

      // Virtualisation: a long buffer keeps only a window of lines in
      // the DOM, while the scroll height spans the whole document.
      const virtual = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        replInput.value = '(new-buffer! "big.txt")';
        replInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
        await frame();
        const editor = document.querySelector('.editor');
        editor.focus();
        for (let i = 0; i < 400; i += 1) {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        }
        await frame();
        editor.scrollTop = 0;
        await frame();
        return {
          lineDivs: document.querySelectorAll('.editor-line').length,
          firstNumber: (document.querySelector('.editor-line-no') || {}).textContent,
          scrollHeight: editor.scrollHeight,
        };
      })()`);
      console.log('  virtual:', JSON.stringify(virtual));

      // Modes: a new buffer's major mode is chosen from its name and
      // shown in the modeline.
      const modes = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        submit('(new-buffer! "core.lisp")');
        await frame();
        const lisp = document.getElementById('modeline-name').textContent;
        submit('(new-buffer! "notes.txt")');
        await frame();
        const txt = document.getElementById('modeline-name').textContent;
        submit('(toggle-math-mode)'); // a minor mode — shows in the modeline
        await frame();
        const math = document.getElementById('modeline-name').textContent;
        // With math mode on, \` then Shift then G must insert \\Gamma —
        // the bare Shift press must not reach the key reader.
        const editor = document.querySelector('.editor');
        editor.focus();
        const key = (k, shift) => editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: k, shiftKey: shift === true, bubbles: true, cancelable: true,
        }));
        key('\`');
        key('Shift', true);
        key('G', true);
        await frame();
        const mathText = document.querySelector('.editor-line').textContent;
        return { lisp, txt, math, mathText };
      })()`);
      console.log('  modes:', JSON.stringify(modes));

      const renderOk =
        render.lines > 0 && render.hasCursor && render.modeline.length > 0;
      const typeOk = input.afterType === 'Zz!' + input.before;
      const deleteOk = input.afterDelete === input.before;
      const replOk = lisp.arithmetic === '6';
      const stdlibOk = lisp.stdlib.includes('procedure');
      const sequenceOk = lisp.sequence === '#t';
      const modulesOk = lisp.modules === '42';
      const buffersOk = lisp.bufferCount === '2';
      const highlightOk = lisp.tokenSpans > 0;
      const interopOk = lisp.firstLineAfter === '[lisp] ' + lisp.firstLineBefore;
      const filesOk =
        files.exposed && files.saved && savedContent === 'smoke save ok';
      const searchOk = search.opened && search.matched;
      const paletteOk =
        palette.opened && palette.matched && palette.closed && palette.focused;
      const treesitterOk =
        treesitter.langs.includes('javascript') &&
        treesitter.langs.includes('html') &&
        treesitter.langs.includes('python') &&
        treesitter.keywords > 0 && treesitter.numbers > 0 &&
        treesitter.pyFunctions > 0 && treesitter.htmlTags > 0;
      const replaceOk = replace.text === 'bar bar bar';
      const mouseOk =
        mouse.after.includes('Ln 1') && mouse.before !== mouse.after &&
        mouse.endOfLine.includes('Ln 2') && mouse.endOfLine.includes('Col 5') &&
        mouse.wordSelected;
      const markdownOk = markdown.headings > 0;
      const virtualOk =
        virtual.lineDivs > 0 && virtual.lineDivs < 120 &&
        virtual.scrollHeight > 3000 && virtual.firstNumber === '1';
      const modesOk =
        modes.lisp.includes('Lisp') && modes.txt.includes('Fundamental') &&
        modes.math.includes('Math') && modes.mathText.includes('Gamma');
      const layersOk = layers.background && layers.overlay && layers.ordered;
      const splashOk = splash.present && splash.dismissed;

      if (
        renderOk && typeOk && deleteOk && replOk && stdlibOk && sequenceOk &&
        modulesOk && buffersOk && highlightOk && interopOk && filesOk &&
        searchOk && paletteOk && treesitterOk && replaceOk && mouseOk &&
        markdownOk && virtualOk && modesOk && layersOk && splashOk
      ) {
        finish(
          0,
          `${render.lines} lines; keymap, modes, mouse, highlighting, markdown, virtualisation, search and files all work`
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
      } else if (!highlightOk) {
        finish(1, 'syntax highlighting did not render');
      } else if (!interopOk) {
        finish(1, 'Lisp did not edit the buffer');
      } else if (!filesOk) {
        finish(1, 'the file bridge did not work');
      } else if (!searchOk) {
        finish(1, 'incremental search did not work');
      } else if (!paletteOk) {
        finish(1, 'the command palette did not work');
      } else if (!treesitterOk) {
        finish(
          1,
          `tree-sitter highlighting did not work (${JSON.stringify(treesitter)})`
        );
      } else if (!replaceOk) {
        finish(1, 'replace-string did not work');
      } else if (!mouseOk) {
        finish(1, 'mouse click did not move the cursor');
      } else if (!markdownOk) {
        finish(1, 'markdown highlighting did not work');
      } else if (!virtualOk) {
        finish(
          1,
          `view virtualisation did not work (${JSON.stringify(virtual)})`
        );
      } else if (!modesOk) {
        finish(1, `modes did not work (${JSON.stringify(modes)})`);
      } else if (!layersOk) {
        finish(1, `the view layers did not work (${JSON.stringify(layers)})`);
      } else {
        finish(1, `the splash did not work (${JSON.stringify(splash)})`);
      }
    } catch (err) {
      finish(1, `inspection failed: ${err.message}`);
    }
  });

  win.loadURL(EDITOR_URL);
  setTimeout(() => finish(1, 'timed out waiting for the editor to load'), 20000);
});
