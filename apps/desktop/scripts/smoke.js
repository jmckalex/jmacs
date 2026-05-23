/**
 * @file Smoke test — launches the editor in a hidden Electron window,
 * waits for it to load, and checks that the renderer actually projected
 * the buffer into the DOM. Exits 0 on success, 1 on any failure.
 *
 * Run with `pnpm --filter @editor/desktop smoke`. Kept out of the
 * normal test run because it needs an Electron runtime.
 */

import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerFileHandlers } from '../src/files.js';
import { renderJMarkdown } from '../src/jmarkdown.js';
import { EDITOR_URL, serveAppFile } from '../src/serve.js';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..'
);

/** True when `docs/build/manifest.json` already exists — meaning the
 *  user has run `pnpm run docs` before. We do NOT build the docs from
 *  inside the smoke: spawning a subprocess in Electron's main thread
 *  before `app.whenReady()` keeps the dock icon bouncing for a few
 *  seconds, which is needlessly slow. The doc-view smoke arm is
 *  skipped when the manifest isn't present. */
const docsBuilt = existsSync(join(repoRoot, 'docs', 'build', 'manifest.json'));

/** A scratch path the file round-trip writes to. */
const savePath = join(tmpdir(), 'jmacs-smoke-save.txt');

/** A scratch path the sticky-note metadata round-trip writes beside. */
const notesPath = join(tmpdir(), 'jmacs-smoke-notes.txt');

/** A scratch image file the image-buffer check opens. */
const imagePath = join(tmpdir(), 'jmacs-smoke-image.png');
// A 1×1 PNG — the smallest real image the open path can read.
writeFileSync(
  imagePath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4' +
      '2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);

// Isolate the smoke run's config files (custom.lisp, init.lisp) in a
// fresh temp directory, so it never touches the real user data dir.
const configDir = join(tmpdir(), 'jmacs-smoke-config');
rmSync(configDir, { recursive: true, force: true });
mkdirSync(configDir, { recursive: true });
app.setPath('userData', configDir);

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
  // The image-buffer check drives the real `file:open` path; with no
  // way to click a native dialog, stub it to choose the scratch image.
  dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [imagePath],
  });
  ipcMain.handle('jmarkdown:render', (_event, { command, source }) =>
    renderJMarkdown(command, source)
  );

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
        // HTML → CSS language injection: a <style> body in an HTML
        // buffer must be highlighted with CSS faces. The HTML
        // grammar's own highlight query never produces tok-keyword
        // for this snippet (no doctype, no JS) — so a non-zero count
        // here proves the inner CSS highlighter ran on the raw_text.
        submit('(new-buffer! "smoke-injection.html")');
        submit('(insert! "<style>p { color: red; }</style>")');
        await frame();
        const htmlInjectsCss = document.querySelectorAll('.tok-keyword').length;
        // PHP (mixed) — a <?php ?> block plus surrounding HTML. The
        // PHP grammar's own captures cover the keyword, variable and
        // string inside the tag; the (text) node outside is injected
        // as HTML, so an HTML tag in the surrounding markup gets a
        // .tok-tag span from the inner HTML highlighter. Both counts
        // non-zero prove PHP loaded and the HTML injection ran.
        submit('(new-buffer! "smoke.php")');
        submit('(insert! "<?php echo 1; ?> <b>html</b>")');
        await frame();
        await frame();
        const phpKeywords = document.querySelectorAll('.tok-keyword').length;
        const phpTags = document.querySelectorAll('.tok-tag').length;
        submit('(new-buffer! "smoke.json")');
        // No embedded double-quotes here: those would need backslash
        // escapes through both layers (executeJavaScript and repl).
        // A numeric/constant array still proves the grammar loaded:
        // JSON has no fallback tokenizer that could emit @number or
        // @constant otherwise.
        submit('(insert! "[1, true, null]")');
        await frame();
        const jsonNumbers = document.querySelectorAll('.tok-number').length;
        const jsonConstants = document.querySelectorAll('.tok-constant').length;
        submit('(new-buffer! "smoke.css")');
        submit('(insert! "p { color: red; }")');
        await frame();
        // CSS has no fallback tokenizer either — tok-keyword (the
        // property name "color") proves the grammar loaded.
        const cssKeywords = document.querySelectorAll('.tok-keyword').length;
        const cssTags = document.querySelectorAll('.tok-tag').length;
        submit('(new-buffer! "smoke.ts")');
        submit('(insert! "const n: number = 1;")');
        await frame();
        const tsKeywords = document.querySelectorAll('.tok-keyword').length;
        const tsTypes = document.querySelectorAll('.tok-type').length;
        submit('(new-buffer! "smoke.rs")');
        submit('(insert! "fn go() -> u32 { 1 }")');
        await frame();
        const rsKeywords = document.querySelectorAll('.tok-keyword').length;
        const rsTypes = document.querySelectorAll('.tok-type').length;
        submit('(new-buffer! "smoke.go")');
        submit('(insert! "package p; func F() int32 { return 0 }")');
        await frame();
        const goKeywords = document.querySelectorAll('.tok-keyword').length;
        const goTypes = document.querySelectorAll('.tok-type').length;
        submit('(new-buffer! "smoke.sh")');
        submit('(insert! "if true; then echo hi; fi")');
        await frame();
        const shKeywords = document.querySelectorAll('.tok-keyword').length;
        const shFunctions = document.querySelectorAll('.tok-function').length;
        // Markdown: a .md buffer with a heading and a fenced JS block
        // exercises both the markdown block grammar (the heading) and
        // the markdown -> javascript injection (the fence body). The
        // body 'const x = 1;' contributes one tok-keyword span ('const')
        // which proves the inner JS highlighter ran on the
        // code_fence_content; the heading contributes one tok-heading.
        // (A '\`\`\`lisp' fence is **not** used here because the lisp
        // highlighter is the line tokenizer, not a tree-sitter grammar,
        // and the injection pipeline only resolves tree-sitter inner
        // highlighters — so a lisp fence would render as plain
        // tok-code, not as lisp keywords.)
        submit('(new-buffer! "smoke.md")');
        // Four backslashes in the template literal → two in the JS
        // string → one backslash-n pair in the Lisp source, which the
        // reader's string-escape table maps to a real newline. (Using
        // a real newline here would be stripped, since the REPL is a
        // single-line <input>.)
        submit('(insert! "# heading\\\\n\\\\n\`\`\`javascript\\\\nconst x = 1;\\\\n\`\`\`\\\\n")');
        await frame();
        const mdHeadings = document.querySelectorAll('.tok-heading').length;
        const mdInjectsJs = document.querySelectorAll('.tok-keyword').length;
        return {
          // The languages whose grammar WASM actually loaded.
          langs: document.body.dataset.treesitter,
          keywords,
          numbers,
          pyFunctions,
          htmlTags,
          htmlInjectsCss,
          phpKeywords,
          phpTags,
          jsonNumbers,
          jsonConstants,
          cssKeywords,
          cssTags,
          tsKeywords,
          tsTypes,
          rsKeywords,
          rsTypes,
          goKeywords,
          goTypes,
          shKeywords,
          shFunctions,
          mdHeadings,
          mdInjectsJs,
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
        replSubmit('(run-command (quote replace-string))');
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
        // Double-click selects the word — a mousedown with detail 2,
        // which is how the editor detects a double-click.
        const line0b = document.querySelectorAll('.editor-line')[0].getBoundingClientRect();
        editor.dispatchEvent(new MouseEvent('mousedown', {
          detail: 2, button: 0,
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

      // Markdown preview: C-c v toggles a pane that renders the current
      // markdown-mode buffer to HTML. 'cat' is used as the render
      // command so the result is deterministic without a JMarkdown
      // binary; the heading text must reach the rendered pane, and the
      // pane must refresh as the buffer is edited.
      const preview = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        // A fresh markdown buffer; 'cat' echoes the source verbatim.
        submit('(new-buffer! "preview.md")');
        await frame();
        submit('(set! *markdown-interpreter* "cat")');
        await frame();
        const editor = document.querySelector('.editor');
        editor.focus();
        for (const ch of '# Heading') {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: ch, bubbles: true, cancelable: true,
          }));
        }
        await frame();
        // C-c v toggles the preview pane open. C-c is a prefix; the
        // 'v' that completes it carries no modifier.
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'c', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'v', bubbles: true, cancelable: true,
        }));
        await wait(600);
        const pane = document.querySelector('.markdown-preview-host');
        const body = document.querySelector('.markdown-preview-body');
        const shown = !!(pane && getComputedStyle(pane).display !== 'none');
        const rendered = !!(body && body.textContent.includes('# Heading'));
        // Editing the buffer refreshes the pane (debounced ~250ms).
        editor.focus();
        for (const ch of ' more') {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: ch, bubbles: true, cancelable: true,
          }));
        }
        await wait(600);
        const refreshed = !!(body && body.textContent.includes('Heading more'));
        // C-c v again hides the pane.
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'c', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'v', bubbles: true, cancelable: true,
        }));
        await frame();
        const hidden = !!(pane && getComputedStyle(pane).display === 'none');
        return { shown, rendered, refreshed, hidden };
      })()`);
      console.log('  preview:', JSON.stringify(preview));

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
        // The cursor sits on the last line. Scroll to the top and let
        // it settle: the first frame runs the scroll-driven render, the
        // second lets any cursor-follow bounce land. A scroll-only
        // render must leave the viewport where the scroll put it.
        editor.scrollTop = 0;
        await frame();
        await frame();
        return {
          lineDivs: document.querySelectorAll('.editor-line').length,
          firstNumber: (document.querySelector('.editor-line-no') || {}).textContent,
          scrollTop: editor.scrollTop,
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

      // A sticky note: created via Lisp, it shows its source and rides
      // the document when the buffer scrolls.
      const sticky = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        submit('(new-buffer! "notes-sticky.txt")');
        await frame();
        const editor = document.querySelector('.editor');
        editor.focus();
        for (let i = 0; i < 200; i += 1) {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        }
        await frame();
        submit('(goto! 0)');
        await frame();
        // Drive the render pipeline with a controlled command — 'cat'
        // echoes the source, so the output here is deterministic and
        // independent of whether a real JMarkdown binary is installed.
        submit('(set! *markdown-interpreter* "cat")');
        await frame();
        submit('(note-set-source! (note-create!) "sticky body text")');
        await frame();
        const note = document.querySelector('.sticky-note');
        const body = note && note.querySelector('.sticky-note-body');
        const before = note ? note.getBoundingClientRect().top : 0;
        editor.scrollTop = editor.scrollTop + 300;
        await frame();
        await frame();
        const after = note ? note.getBoundingClientRect().top : 0;
        // An HTML tag in the source becomes a real element once rendered.
        submit('(note-set-source! (note-create!) "<b>bold note</b>")');
        await wait(500);
        // A note with mathematics — MathJax typesets it in place.
        submit('(note-set-source! (note-create!) "energy $E = mc^2$")');
        await wait(1200);
        // A metadata header sets the note's colour. The \\n reach the
        // REPL as a two-character escape, so the Lisp reader makes the
        // newlines — a real newline would be stripped by the input.
        submit('(note-set-source! (note-create!) "---\\\\ncolor: tomato\\\\n---\\\\ncoloured")');
        await wait(400);
        const colourNote = document.querySelectorAll('.sticky-note')[3];
        const coloured = colourNote
          ? getComputedStyle(colourNote).backgroundColor
          : '';
        // Persistence: notes round-trip through a .jmacs-metadata file.
        const metaPath = ${JSON.stringify(notesPath)};
        await window.host.writeMetadata(metaPath, {
          notes: [{ id: 'm', anchor: 4, x: 8, y: 0,
                    width: 200, height: 120, source: 'persisted note' }],
        });
        const restored = await window.host.readMetadata(metaPath);
        // Collapse the coloured note via its control, then expand it by
        // double-clicking the icon. Collapsed, only the Font Awesome
        // icon shows — the panel background goes transparent.
        colourNote.querySelector('.sticky-note-collapse').dispatchEvent(
          new MouseEvent('click', { bubbles: true })
        );
        await frame();
        const collapsed = colourNote.classList.contains('is-collapsed');
        const collapsedTransparent =
          getComputedStyle(colourNote).backgroundColor === 'rgba(0, 0, 0, 0)';
        const faLoaded = getComputedStyle(
          colourNote.querySelector('.sticky-note-icon i')
        ).fontFamily.includes('Font Awesome');
        colourNote.querySelector('.sticky-note-icon').dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true })
        );
        await frame();
        const expanded = !colourNote.classList.contains('is-collapsed');
        return {
          present: note !== null,
          body: body ? body.textContent.trim() : '',
          scrolled: Math.abs(after - before + 300) < 4,
          count: document.querySelectorAll('.sticky-note').length,
          rendered: document.querySelectorAll('.sticky-note-body b').length > 0,
          mathTypeset:
            document.querySelectorAll('.sticky-note-body mjx-container')
              .length > 0,
          coloured,
          collapsed,
          collapsedTransparent,
          expanded,
          faLoaded,
          persisted: !!(restored && restored.notes &&
            restored.notes.length === 1 &&
            restored.notes[0].source === 'persisted note'),
        };
      })()`);
      console.log('  sticky:', JSON.stringify(sticky));
      await rm(notesPath + '.jmacs-metadata', { force: true });

      // Customisation: init.lisp is written on first run, and a saved
      // setting is persisted to custom.lisp.
      const config = await win.webContents.executeJavaScript(`(async () => {
        const initLoaded =
          (await window.host.readConfigFile('init.lisp')) !== null;
        const replInput = document.querySelector('.repl-input');
        replInput.value =
          '(custom-apply-and-save! (quote *markdown-interpreter*) "echo smoke")';
        replInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
        await new Promise((r) => setTimeout(r, 250));
        const saved = await window.host.readConfigFile('custom.lisp');
        // (customize) opens a customisation buffer — a non-text buffer
        // shown through its own view, the editor view hidden.
        replInput.value = '(customize)';
        replInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
        await new Promise((r) => requestAnimationFrame(() => r()));
        const customizeEl = document.querySelector('.customize');
        const customizeShown = !!(
          customizeEl &&
          getComputedStyle(customizeEl).display !== 'none' &&
          getComputedStyle(document.querySelector('.editor')).display ===
            'none'
        );
        // The sticky-notes group renders its setting as a form widget.
        replInput.value = '(customize-group (quote sticky-notes))';
        replInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
        await new Promise((r) => requestAnimationFrame(() => r()));
        const settingRendered = !!(
          document.querySelector('.customize-row') &&
          document.querySelector('.customize-row .customize-widget')
        );
        return {
          initLoaded,
          savedSetting: !!(saved &&
            saved.includes('*markdown-interpreter*') &&
            saved.includes('echo smoke')),
          customizeShown,
          settingRendered,
        };
      })()`);
      console.log('  config:', JSON.stringify(config));

      // Themes: changing *theme* through the customisation registry
      // rewrites CSS variables on the document root.
      const themes = await win.webContents.executeJavaScript(`(async () => {
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        const cssVar = (name) =>
          getComputedStyle(document.documentElement)
            .getPropertyValue(name)
            .trim();
        const bgDark = cssVar('--bg');
        submit('(custom-apply! (quote *theme*) (quote light))');
        await new Promise((r) => requestAnimationFrame(() => r()));
        const bgLight = cssVar('--bg');
        const fgLight = cssVar('--fg');
        submit('(custom-apply! (quote *theme*) (quote midnight))');
        await new Promise((r) => requestAnimationFrame(() => r()));
        const bgMidnight = cssVar('--bg');
        submit('(custom-apply! (quote *theme*) (quote dark))');
        await new Promise((r) => requestAnimationFrame(() => r()));
        const bgBack = cssVar('--bg');
        return {
          bgDark, bgLight, fgLight, bgMidnight, bgBack,
          differ: bgDark !== bgLight && bgLight !== bgMidnight,
          restored: bgBack === bgDark,
        };
      })()`);
      console.log('  themes:', JSON.stringify(themes));

      // Image buffers: opening an image file shows it through the image
      // view — a non-text buffer kind — with the editor view hidden.
      // The dialog is stubbed (above) to choose the scratch PNG.
      const image = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        replInput.value = '(open-file!)';
        replInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
        // The open path is async (IPC + a data-URL read); give it room.
        await new Promise((r) => setTimeout(r, 400));
        await frame();
        const view = document.querySelector('.image-view');
        const img = document.querySelector('.image-content');
        const toggle = document.querySelector('.image-zoom-toggle');
        const shown = !!(
          view &&
          getComputedStyle(view).display !== 'none' &&
          getComputedStyle(document.querySelector('.editor')).display ===
            'none'
        );
        // The image carries a data URL and starts fit-to-window.
        const hasDataUrl = !!(img && img.src.startsWith('data:image/png'));
        const startsFit = !!(img && img.classList.contains('is-fit'));
        // The toggle switches it to actual size and back.
        let toActual = false;
        let backToFit = false;
        if (toggle) {
          toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await frame();
          toActual = img.classList.contains('is-actual');
          toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await frame();
          backToFit = img.classList.contains('is-fit');
        }
        return { shown, hasDataUrl, startsFit, toActual, backToFit };
      })()`);
      console.log('  image:', JSON.stringify(image));
      await rm(imagePath, { force: true });

      // Colour swatches: a buffer with colour literals shows a clickable
      // swatch beside each one; clicking a swatch opens the modal colour
      // chooser, and confirming it writes the chosen colour back into the
      // buffer, replacing the literal's text.
      const swatches = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        submit('(new-buffer! "swatch.css")');
        await frame();
        const editor = document.querySelector('.editor');
        editor.focus();
        for (const ch of 'a #ff8800 b rgb(0,0,0)') {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: ch, bubbles: true, cancelable: true,
          }));
        }
        await frame();
        // One swatch per literal — the #ff8800 hash and the rgb() form.
        const count = document.querySelectorAll('.colour-swatch').length;
        const firstBefore = document.querySelector('.editor-line').textContent;
        // Click the first swatch: the modal opens with OK / Cancel.
        const swatch = document.querySelector('.colour-swatch');
        swatch.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        swatch.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await frame();
        const modal = document.querySelector('.colour-picker');
        const modalShown = !!modal;
        // Pick a new colour and confirm with OK.
        let edited = '';
        if (modalShown) {
          const input = document.querySelector('.colour-picker-input');
          input.value = '#00ccff';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('.colour-picker-ok')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await frame();
          edited = document.querySelector('.editor-line').textContent;
        }
        const modalClosed = document.querySelector('.colour-picker') === null;
        return { count, firstBefore, modalShown, edited, modalClosed };
      })()`);
      console.log('  swatches:', JSON.stringify(swatches));

      // Documentation: open the forward-char doc page; the doc-view
      // shows the HTML the build produced; clicking a [data-jmacs-doc]
      // link inside opens a second doc buffer.
      const docs = docsBuilt
        ? await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        submit('(open-doc "forward-char")');
        // The first await yields to the REPL; the open-doc primitive
        // dispatches an async fetch through host.readDocPage, then a
        // buffer switch. A handful of frames is enough for both.
        for (let i = 0; i < 6; i += 1) await frame();
        const view = document.querySelector('.doc-view');
        const shown = !!(view && getComputedStyle(view).display !== 'none');
        const page = view ? view.querySelector('.doc-page') : null;
        const pageText = page ? page.textContent : '';
        // Click the first cross-link inside the page (the cmd() helper
        // emits the backward-char reference).
        const xref = page ? page.querySelector('[data-jmacs-doc]') : null;
        const xrefName = xref ? xref.getAttribute('data-jmacs-doc') : '';
        if (xref) {
          xref.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          for (let i = 0; i < 6; i += 1) await frame();
        }
        const secondPage = document.querySelector('.doc-view .doc-page');
        const secondText = secondPage ? secondPage.textContent : '';
        return {
          shown,
          containsName: pageText.includes('forward-char'),
          hasXref: xref !== null,
          xrefName,
          secondShown: !!(secondPage && secondText.length > 0),
          // After the click the second buffer should be different from
          // the first — we look for the cross-link target name in the
          // active page's text.
          switched: secondText.length > 0 && secondText.includes(xrefName || '__none__'),
        };
      })()`)
        : { skipped: true };
      console.log('  docs:', JSON.stringify(docs));

      // Documentation (live path): a user-defined procedure with a
      // Markdown docstring opens through the doc-view too. This arm
      // doesn't depend on `pnpm run docs` — it exercises the
      // marked.js pipeline directly.
      const liveDocs = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        // Define a procedure whose docstring is Markdown. The
        // \\\\\\\\n sequences become \\\\n in the inner JS string,
        // which the Lisp reader then converts to real newlines so
        // marked sees a proper multi-paragraph document.
        // Earlier smoke arms set *markdown-interpreter* to "cat" /
        // "echo smoke" for their own purposes; reset to the bundled
        // marked.js path before exercising the live-doc renderer.
        submit('(set! *markdown-interpreter* "marked")');
        submit('(define (smoke-doc-fn) "Smoke test for _live_ Markdown.\\\\n\\\\nIncludes:\\\\n\\\\n- A **bold** word.\\\\n- An /italic/ word.\\\\n\\\\nThe end." nil)');
        await frame();
        submit('(open-doc "smoke-doc-fn")');
        for (let i = 0; i < 8; i += 1) await frame();
        const view = document.querySelector('.doc-view');
        const shown = !!(view && getComputedStyle(view).display !== 'none');
        const page = view ? view.querySelector('.doc-page') : null;
        const html = page ? page.innerHTML : '';
        return {
          shown,
          // marked's rendered output uses these tags for **bold**,
          // _italic_ and bullet lists. Their presence proves the
          // Markdown pipeline ran end-to-end.
          hasStrong: /<strong>bold<\\/strong>/.test(html),
          hasEm: /<em>live<\\/em>/.test(html),
          hasList: /<ul>[\\s\\S]*<li>/.test(html),
          modeline: document.querySelector('.modeline')?.textContent ?? '',
        };
      })()`);
      console.log('  liveDocs:', JSON.stringify(liveDocs));

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
        treesitter.langs.includes('json') &&
        treesitter.langs.includes('css') &&
        treesitter.langs.includes('typescript') &&
        treesitter.langs.includes('rust') &&
        treesitter.langs.includes('go') &&
        treesitter.langs.includes('bash') &&
        treesitter.langs.includes('php') &&
        treesitter.langs.includes('markdown') &&
        treesitter.keywords > 0 && treesitter.numbers > 0 &&
        treesitter.pyFunctions > 0 && treesitter.htmlTags > 0 &&
        treesitter.htmlInjectsCss > 0 &&
        treesitter.phpKeywords > 0 && treesitter.phpTags > 0 &&
        treesitter.jsonNumbers > 0 && treesitter.jsonConstants > 0 &&
        treesitter.cssKeywords > 0 && treesitter.cssTags > 0 &&
        treesitter.tsKeywords > 0 && treesitter.tsTypes > 0 &&
        treesitter.rsKeywords > 0 && treesitter.rsTypes > 0 &&
        treesitter.goKeywords > 0 && treesitter.goTypes > 0 &&
        treesitter.shKeywords > 0 && treesitter.shFunctions > 0 &&
        treesitter.mdHeadings > 0 && treesitter.mdInjectsJs > 0;
      const replaceOk = replace.text === 'bar bar bar';
      const mouseOk =
        mouse.after.includes('Ln 1') && mouse.before !== mouse.after &&
        mouse.endOfLine.includes('Ln 2') && mouse.endOfLine.includes('Col 5') &&
        mouse.wordSelected;
      const markdownOk = markdown.headings > 0;
      const previewOk =
        preview.shown &&
        preview.rendered &&
        preview.refreshed &&
        preview.hidden;
      const virtualOk =
        virtual.lineDivs > 0 && virtual.lineDivs < 120 &&
        virtual.scrollHeight > 3000 && virtual.firstNumber === '1' &&
        virtual.scrollTop === 0;
      const modesOk =
        modes.lisp.includes('Lisp') && modes.txt.includes('Fundamental') &&
        modes.math.includes('Math') && modes.mathText.includes('Gamma');
      const layersOk = layers.background && layers.overlay && layers.ordered;
      const splashOk = splash.present && splash.dismissed;
      const stickyOk =
        sticky.present &&
        sticky.body.includes('sticky body text') &&
        sticky.scrolled &&
        sticky.count === 4 &&
        sticky.rendered &&
        sticky.mathTypeset &&
        sticky.coloured === 'rgb(255, 99, 71)' &&
        sticky.collapsed &&
        sticky.collapsedTransparent &&
        sticky.expanded &&
        sticky.faLoaded &&
        sticky.persisted;
      const configOk =
        config.initLoaded &&
        config.savedSetting &&
        config.customizeShown &&
        config.settingRendered;
      const themesOk =
        themes.bgDark !== '' && themes.differ && themes.restored;
      const imageOk =
        image.shown &&
        image.hasDataUrl &&
        image.startsFit &&
        image.toActual &&
        image.backToFit;
      const swatchesOk =
        swatches.count === 2 &&
        swatches.modalShown &&
        swatches.modalClosed &&
        swatches.firstBefore.includes('#ff8800') &&
        swatches.edited.includes('#00ccff') &&
        !swatches.edited.includes('#ff8800');
      // Docs arm: only enforced when the docs were built. If the
      // local environment has no jmarkdown, the build is skipped
      // and docsOk is trivially true (with a logged note).
      const docsOk =
        docs.skipped === true
          ? true
          : docs.shown &&
            docs.containsName &&
            docs.hasXref &&
            docs.secondShown &&
            docs.switched;
      // The live-docstring arm always runs — it doesn't need the
      // pre-built docs. The user-defined function's Markdown
      // docstring must round-trip through marked.js.
      const liveDocsOk =
        liveDocs.shown &&
        liveDocs.hasStrong &&
        liveDocs.hasEm &&
        liveDocs.hasList &&
        liveDocs.modeline.includes('*Doc: smoke-doc-fn*');

      if (
        renderOk && typeOk && deleteOk && replOk && stdlibOk && sequenceOk &&
        modulesOk && buffersOk && highlightOk && interopOk && filesOk &&
        searchOk && paletteOk && treesitterOk && replaceOk && mouseOk &&
        markdownOk && previewOk && virtualOk && modesOk && layersOk &&
        splashOk && stickyOk && configOk && themesOk && imageOk && swatchesOk &&
        docsOk && liveDocsOk
      ) {
        finish(
          0,
          `${render.lines} lines; keymap, modes, mouse, highlighting, markdown, markdown preview, virtualisation, sticky notes, colour swatches, customisation, image buffers, search and files all work`
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
      } else if (!previewOk) {
        finish(
          1,
          `the Markdown preview pane did not work (${JSON.stringify(preview)})`
        );
      } else if (!virtualOk) {
        finish(
          1,
          `view virtualisation did not work (${JSON.stringify(virtual)})`
        );
      } else if (!modesOk) {
        finish(1, `modes did not work (${JSON.stringify(modes)})`);
      } else if (!layersOk) {
        finish(1, `the view layers did not work (${JSON.stringify(layers)})`);
      } else if (!splashOk) {
        finish(1, `the splash did not work (${JSON.stringify(splash)})`);
      } else if (!stickyOk) {
        finish(1, `sticky notes did not work (${JSON.stringify(sticky)})`);
      } else if (!configOk) {
        finish(1, `customisation did not work (${JSON.stringify(config)})`);
      } else if (!themesOk) {
        finish(1, `themes did not work (${JSON.stringify(themes)})`);
      } else if (!imageOk) {
        finish(1, `image buffers did not work (${JSON.stringify(image)})`);
      } else if (!docsOk) {
        finish(1, `docs did not work (${JSON.stringify(docs)})`);
      } else if (!liveDocsOk) {
        finish(1, `live docstring rendering did not work (${JSON.stringify(liveDocs)})`);
      } else {
        finish(
          1,
          `colour swatches did not work (${JSON.stringify(swatches)})`
        );
      }
    } catch (err) {
      finish(1, `inspection failed: ${err.message}`);
    }
  });

  win.loadURL(EDITOR_URL);
  setTimeout(() => finish(1, 'timed out waiting for the editor to load'), 20000);
});
