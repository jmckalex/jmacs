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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerFileHandlers } from '../src/files.js';
import { renderJMarkdown } from '../src/jmarkdown.js';
import { EDITOR_URL, serveAppFile, serveMediaFile } from '../src/serve.js';
import { registerShellHandlers } from '../src/shell.js';

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

/** A scratch directory the jukebox smoke arm seeds with fake audio files. */
const jukeboxDir = join(tmpdir(), 'jmacs-smoke-jukebox');

/** Scratch paths the media-views smoke arm opens through the file
 *  dialog. The MP3 is a real ID3v2 tag plus a JPEG-sniffable picture
 *  so the smoke confirms the metadata + album-art pipeline ran end-
 *  to-end; the MP4 is a stub — the smoke checks the view mounts and
 *  the src is wired, not that the codec plays. */
const mediaAudioPath = join(tmpdir(), 'jmacs-smoke-media-audio.mp3');
const mediaVideoPath = join(tmpdir(), 'jmacs-smoke-media-video.mp4');

/** A minimal (not standards-perfect, but JPEG-sniffable) byte string
 *  the smoke uses as embedded album-art for the seeded MP3. The art
 *  parser sniffs the MIME from the SOI marker (`FF D8 FF`), so a few
 *  bytes are enough; the renderer only needs them to be base64-able
 *  into a `data:` URL. */
const SAMPLE_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** Encode `n` into 4 syncsafe bytes (7 bits per byte) — the ID3v2 tag
 *  size and v2.4 frame sizes use this encoding so the bytes never
 *  collide with the MPEG sync word inside the audio stream. */
function syncsafeInt32(n) {
  return Buffer.from([
    (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f,
  ]);
}

/** Build a minimal ID3v2.3 tag carrying a single APIC frame whose
 *  payload is `picture` bytes labelled with `mime`. The output is a
 *  valid prefix the smoke can drop on disk as an `.mp3`; the art
 *  extractor in `audio-art.js` parses it round-trip. */
function buildID3v23WithAPIC(mime, picture) {
  const payload = Buffer.concat([
    Buffer.from([0]),                  // text encoding: ISO-8859-1
    Buffer.from(mime, 'ascii'),
    Buffer.from([0]),                  // MIME NUL
    Buffer.from([3]),                  // picture type: cover (front)
    Buffer.from([0]),                  // empty description + NUL
    picture,
  ]);
  const frame = Buffer.concat([
    Buffer.from('APIC', 'ascii'),
    Buffer.from([
      (payload.length >> 24) & 0xff, (payload.length >> 16) & 0xff,
      (payload.length >> 8) & 0xff, payload.length & 0xff,
    ]),                                // v2.3: plain big-endian size
    Buffer.from([0, 0]),               // flags
    payload,
  ]);
  return Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([3, 0, 0]),            // v2.3.0, no flags
    syncsafeInt32(frame.length),
    frame,
  ]);
}

/** Build an ID3v2.3 text frame: 4-byte ID + 4-byte plain BE size +
 *  2-byte flags + 1-byte encoding (ISO-8859-1) + ASCII text. */
function id3v23TextFrame(id, value) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(value, 'ascii')]);
  return Buffer.concat([
    Buffer.from(id, 'ascii'),
    Buffer.from([
      (payload.length >> 24) & 0xff, (payload.length >> 16) & 0xff,
      (payload.length >> 8) & 0xff, payload.length & 0xff,
    ]),
    Buffer.from([0, 0]),
    payload,
  ]);
}

/** Build a tag with APIC + TIT2/TPE1/TALB text frames so the same
 *  seeded file exercises both the art extractor and the metadata
 *  formatter. */
function buildID3v23Tagged(title, artist, album, mime, picture) {
  const apicPayload = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(mime, 'ascii'),
    Buffer.from([0]),
    Buffer.from([3]),
    Buffer.from([0]),
    picture,
  ]);
  const apic = Buffer.concat([
    Buffer.from('APIC', 'ascii'),
    Buffer.from([
      (apicPayload.length >> 24) & 0xff, (apicPayload.length >> 16) & 0xff,
      (apicPayload.length >> 8) & 0xff, apicPayload.length & 0xff,
    ]),
    Buffer.from([0, 0]),
    apicPayload,
  ]);
  const frames = Buffer.concat([
    id3v23TextFrame('TIT2', title),
    id3v23TextFrame('TPE1', artist),
    id3v23TextFrame('TALB', album),
    apic,
  ]);
  return Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([3, 0, 0]),
    syncsafeInt32(frames.length),
    frames,
  ]);
}

// Seed the media-views fixtures: a fully tagged MP3 (so the audio
// view's title/artist/album row and album-art panel exercise the
// metadata + art pipelines end-to-end), and a stub MP4 (the smoke
// asserts the view mounts and the src is wired — it doesn't care
// that Electron can't decode the bytes).
writeFileSync(
  mediaAudioPath,
  buildID3v23Tagged(
    'Smoke Song', 'Smoke Artist', 'Smoke Album',
    'image/jpeg', SAMPLE_JPEG_BYTES
  )
);
writeFileSync(mediaVideoPath, Buffer.from([0, 0, 0, 0]));

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
  protocol.handle('media', serveMediaFile);
  registerFileHandlers();
  registerShellHandlers();
  // The image-buffer check drives the real `file:open` path; with
  // no way to click a native dialog, stub it to choose the scratch
  // image. The audio/video media-views arms drive `file:open-path`
  // directly through `host.openFilePath`, so they don't need the
  // dialog stub at all.
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
      // 33 tree-sitter grammars + the directory views need to load
      // before the editor can mount its view; on a cold machine this
      // is ~3s. Bump generously — a smoke run that flakes here
      // wastes the full subsequent inspection cycle.
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const render = await win.webContents.executeJavaScript(`(() => ({
        lines: document.querySelectorAll('text-view:not([style*="display: none"]) .editor-line').length,
        hasCursor: !!document.querySelector('text-view:not([style*="display: none"]) .editor-cursor'),
        modeline: document.getElementById('modeline-position')?.textContent ?? '',
      }))()`);
      console.log('  rendered:', JSON.stringify(render));

      // The startup splash: present in the background layer, and
      // dismissed (no longer visible) once a buffer is switched.
      const splash = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const present =
          document.querySelector('text-view:not([style*="display: none"]) .editor-background .splash.is-visible')
            !== null;
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        submit('(next-view!)');     // a switch dismisses the splash
        submit('(previous-view!)'); // ... and back: the count is intact
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
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
        editor.focus();
        const press = (key, opts = {}) =>
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key, bubbles: true, cancelable: true, ...opts,
          }));
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const firstLine = () => document.querySelector('text-view:not([style*="display: none"]) .editor-line').textContent;

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
        submit('(view-count)');
        const bufferCount = lastResult();
        submit('(next-view!)');
        await frame();
        const tokenSpans = document.querySelectorAll(
          '.tok-keyword, .tok-comment, .tok-string'
        ).length;
        submit('(previous-view!)');
        await frame();

        const firstLineBefore = document.querySelector('text-view:not([style*="display: none"]) .editor-line').textContent;
        submit('(goto! 0)');
        submit('(insert! "[lisp] ")');
        await frame();
        const firstLineAfter = document.querySelector('text-view:not([style*="display: none"]) .editor-line').textContent;

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
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
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
          matched = document.querySelectorAll('text-view:not([style*="display: none"]) .editor-selection-rect').length > 0;
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
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
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
        submit('(new-view! "smoke.js")');
        submit('(insert! "const answer = 42;")');
        await frame();
        const keywords = document.querySelectorAll('.tok-keyword').length;
        const numbers = document.querySelectorAll('.tok-number').length;
        submit('(new-view! "smoke.py")');
        submit('(insert! "def go(): return go()")');
        await frame();
        const pyFunctions = document.querySelectorAll('.tok-function').length;
        submit('(new-view! "smoke.html")');
        submit('(insert! "<div id=x></div>")');
        await frame();
        const htmlTags = document.querySelectorAll('.tok-tag').length;
        // HTML → CSS language injection: a <style> body in an HTML
        // buffer must be highlighted with CSS faces. The HTML
        // grammar's own highlight query never produces tok-keyword
        // for this snippet (no doctype, no JS) — so a non-zero count
        // here proves the inner CSS highlighter ran on the raw_text.
        submit('(new-view! "smoke-injection.html")');
        submit('(insert! "<style>p { color: red; }</style>")');
        await frame();
        const htmlInjectsCss = document.querySelectorAll('.tok-keyword').length;
        // PHP (mixed) — a <?php ?> block plus surrounding HTML. The
        // PHP grammar's own captures cover the keyword, variable and
        // string inside the tag; the (text) node outside is injected
        // as HTML, so an HTML tag in the surrounding markup gets a
        // .tok-tag span from the inner HTML highlighter. Both counts
        // non-zero prove PHP loaded and the HTML injection ran.
        submit('(new-view! "smoke.php")');
        submit('(insert! "<?php echo 1; ?> <b>html</b>")');
        await frame();
        await frame();
        const phpKeywords = document.querySelectorAll('.tok-keyword').length;
        const phpTags = document.querySelectorAll('.tok-tag').length;
        submit('(new-view! "smoke.json")');
        // No embedded double-quotes here: those would need backslash
        // escapes through both layers (executeJavaScript and repl).
        // A numeric/constant array still proves the grammar loaded:
        // JSON has no fallback tokenizer that could emit @number or
        // @constant otherwise.
        submit('(insert! "[1, true, null]")');
        await frame();
        const jsonNumbers = document.querySelectorAll('.tok-number').length;
        const jsonConstants = document.querySelectorAll('.tok-constant').length;
        submit('(new-view! "smoke.css")');
        submit('(insert! "p { color: red; }")');
        await frame();
        // CSS has no fallback tokenizer either — tok-keyword (the
        // property name "color") proves the grammar loaded.
        const cssKeywords = document.querySelectorAll('.tok-keyword').length;
        const cssTags = document.querySelectorAll('.tok-tag').length;
        submit('(new-view! "smoke.ts")');
        submit('(insert! "const n: number = 1;")');
        await frame();
        const tsKeywords = document.querySelectorAll('.tok-keyword').length;
        const tsTypes = document.querySelectorAll('.tok-type').length;
        submit('(new-view! "smoke.rs")');
        submit('(insert! "fn go() -> u32 { 1 }")');
        await frame();
        const rsKeywords = document.querySelectorAll('.tok-keyword').length;
        const rsTypes = document.querySelectorAll('.tok-type').length;
        submit('(new-view! "smoke.go")');
        submit('(insert! "package p; func F() int32 { return 0 }")');
        await frame();
        const goKeywords = document.querySelectorAll('.tok-keyword').length;
        const goTypes = document.querySelectorAll('.tok-type').length;
        submit('(new-view! "smoke.sh")');
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
        // The fence info-string is '\`\`\`js' (the short alias) rather
        // than the full 'javascript' name — proves the registry's
        // alias system resolves common markdown fence names.
        // (A '\`\`\`lisp' fence is **not** used here because the lisp
        // highlighter is the line tokenizer, not a tree-sitter grammar,
        // and the injection pipeline only resolves tree-sitter inner
        // highlighters — so a lisp fence would render as plain
        // tok-code, not as lisp keywords.)
        submit('(new-view! "smoke.md")');
        // Four backslashes in the template literal → two in the JS
        // string → one backslash-n pair in the Lisp source, which the
        // reader's string-escape table maps to a real newline. (Using
        // a real newline here would be stripped, since the REPL is a
        // single-line <input>.)
        submit('(insert! "# heading\\\\n\\\\n\`\`\`js\\\\nconst x = 1;\\\\n\`\`\`\\\\n")');
        await frame();
        const mdHeadings = document.querySelectorAll('.tok-heading').length;
        const mdInjectsJs = document.querySelectorAll('.tok-keyword').length;
        // LaTeX: a .tex buffer with a generic command, a sectioning
        // command, inline math, an environment and a tikzpicture
        // exercises five key faces. \\textbf is a generic_command, the
        // @function catch-all; environment names (equation, tikzpicture)
        // are @type; the math delimiters ($) are @string; and the TikZ
        // specials (\\draw, \\node, ...) are @tag, a face no other
        // inserted buffer in this smoke arm produces inside its content
        // — so a non-zero count proves the LaTeX grammar's TikZ rule
        // fired. Backslash escaping: this string traverses four nested
        // layers (template literal → executeJavaScript script → JS
        // string → Lisp string), each interpreting a backslash; a
        // literal one in the buffer needs eight source backslashes
        // here, and the newline escape collapses 4→2→1 over the same
        // chain (the Lisp reader's n-escape, used to step across lines
        // the REPL's single-line input won't accept verbatim).
        submit('(new-view! "smoke.tex")');
        submit('(insert! "\\\\\\\\textbf{hi} $x=1$\\\\n\\\\\\\\section{Hi}\\\\n\\\\\\\\begin{equation}x=1\\\\\\\\end{equation}\\\\n\\\\\\\\begin{tikzpicture}\\\\n\\\\\\\\draw (0,0) -- (1,1);\\\\n\\\\\\\\end{tikzpicture}\\\\n")');
        await frame();
        await frame();
        const texFunctions = document.querySelectorAll('.tok-function').length;
        const texTypes = document.querySelectorAll('.tok-type').length;
        const texStrings = document.querySelectorAll('.tok-string').length;
        const texTags = document.querySelectorAll('.tok-tag').length;
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
          texFunctions,
          texTypes,
          texStrings,
          texTags,
        };
      })()`);
      console.log('  treesitter:', JSON.stringify(treesitter));

      // describe-face-at-point (C-h F): in a .js buffer containing
      // `function foo() {}`, with point inside `function`, the
      // command opens a *Doc: Face at point* buffer whose HTML names
      // the `keyword` face.
      const faceInfo = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        submit('(new-view! "face-smoke.js")');
        await frame();
        submit('(insert! "function foo() {}")');
        await frame();
        submit('(goto! 3)');            // inside 'function'
        submit('(describe-face-at-point)');
        for (let i = 0; i < 8; i += 1) await frame();
        const modeline = document.getElementById('modeline-name')?.textContent ?? '';
        const docPage = document.querySelector('doc-view:not([style*="display: none"]) .doc-page');
        const text = docPage ? docPage.textContent : '';
        return {
          modeline,
          mentionsKeyword: text.includes('keyword'),
          mentionsTokKeyword: text.includes('tok-keyword'),
        };
      })()`);
      console.log('  faceInfo:', JSON.stringify(faceInfo));

      // The background and overlay layers exist and are stacked right.
      // Structural test of the editor's CSS layers — works on any
      // text-view, visible or not, so the unfiltered selectors are
      // correct here.
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
        replSubmit('(new-view! "replace-test")');
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
        return { text: document.querySelector('text-view:not([style*="display: none"]) .editor-line').textContent };
      })()`);
      console.log('  replace:', JSON.stringify(replace));

      // Regex-replace and query-replace: two new commands that share
      // the chained two-prompt minibuffer flow as replace-string, with
      // JS RegExp semantics and a per-match prompt respectively.
      const regexReplace = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const replSubmit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        // 1. replace-regexp: (\\w+)(\\d+) -> $2-$1 on a mixed line.
        replSubmit('(new-view! "regex-replace-test")');
        replSubmit('(insert! "foo123 bar45 baz6")');
        await frame();
        replSubmit('(run-command (quote replace-regexp))');
        const mb = () => document.querySelector('.minibuffer-input');
        const fill = async (text) => {
          const input = mb();
          input.value = text;
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
          await frame();
        };
        // Four backslashes in the template literal -> two in JS string
        // -> two in the Lisp-readable text the REPL submits.
        await fill('(\\\\w+?)(\\\\d+)');
        await fill('$2-$1');
        const regexText = document.querySelector('text-view:not([style*="display: none"]) .editor-line').textContent;

        // 2. query-replace: foo -> xxx with a y, then a n, then a q
        //    sequence — exactly one replacement should happen.
        replSubmit('(new-view! "query-replace-test")');
        replSubmit('(insert! "foo foo foo")');
        await frame();
        // Move to the start so the walk sees every match.
        replSubmit('(beginning-of-buffer)');
        await frame();
        replSubmit('(run-command (quote query-replace))');
        await fill('foo');
        await fill('xxx');
        // Now the editor has focus (query-replace's status message did
        // not steal it), and read-next-key has installed a callback.
        // Send the answers as keyboard events on the editor surface.
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
        editor.focus();
        const press = (key) => editor.dispatchEvent(new KeyboardEvent('keydown', {
          key, bubbles: true, cancelable: true,
        }));
        press('y'); // replace the first
        await frame();
        press('q'); // quit before the second
        await frame();
        const queryText = document.querySelector('text-view:not([style*="display: none"]) .editor-line').textContent;
        return { regexText, queryText };
      })()`);
      console.log('  regexReplace:', JSON.stringify(regexReplace));

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
        replSubmit('(new-view! "mouse-test")');
        await frame();
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
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
        const line0 = document.querySelectorAll('text-view:not([style*="display: none"]) .editor-line')[0].getBoundingClientRect();
        click(line0.left + 16, line0.top + 4);
        await frame();
        const after = document.getElementById('modeline-position').textContent;
        // Click well past the end of line 2 ("beta") — the cursor should
        // land at that line's end, not stay put.
        const line1 = document.querySelectorAll('text-view:not([style*="display: none"]) .editor-line')[1].getBoundingClientRect();
        click(line1.right + 90, line1.top + 4);
        await frame();
        const endOfLine = document.getElementById('modeline-position').textContent;
        // Double-click selects the word — a mousedown with detail 2,
        // which is how the editor detects a double-click.
        const line0b = document.querySelectorAll('text-view:not([style*="display: none"]) .editor-line')[0].getBoundingClientRect();
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
          wordSelected: document.querySelectorAll('text-view:not([style*="display: none"]) .editor-selection-rect').length > 0,
        };
      })()`);
      console.log('  mouse:', JSON.stringify(mouse));

      // Markdown: a .md buffer highlights a heading.
      const markdown = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        replInput.value = '(new-view! "notes.md")';
        replInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
        await frame();
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
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
        submit('(new-view! "preview.md")');
        await frame();
        submit('(set! *markdown-interpreter* "cat")');
        await frame();
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
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
        replInput.value = '(new-view! "big.txt")';
        replInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
        await frame();
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
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
          lineDivs: document.querySelectorAll('text-view:not([style*="display: none"]) .editor-line').length,
          firstNumber: (document.querySelector('text-view:not([style*="display: none"]) .editor-line-no') || {}).textContent,
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
        submit('(new-view! "core.lisp")');
        await frame();
        const lisp = document.getElementById('modeline-name').textContent;
        submit('(new-view! "notes.txt")');
        await frame();
        const txt = document.getElementById('modeline-name').textContent;
        submit('(toggle-math-mode)'); // a minor mode — shows in the modeline
        await frame();
        const math = document.getElementById('modeline-name').textContent;
        // With math mode on, \` then Shift then G must insert \\Gamma —
        // the bare Shift press must not reach the key reader.
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
        editor.focus();
        const key = (k, shift) => editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: k, shiftKey: shift === true, bubbles: true, cancelable: true,
        }));
        key('\`');
        key('Shift', true);
        key('G', true);
        await frame();
        const mathText = document.querySelector('text-view:not([style*="display: none"]) .editor-line').textContent;
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
        submit('(new-view! "notes-sticky.txt")');
        await frame();
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
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
        // Phase 2c + 3d: the per-pane editor is a <text-view> wrapping
        // the .editor div, and customize is a <customize-view> wrapping
        // the .customize div. Visibility now lives on the wrappers.
        const customizeEl = document.querySelector('customize-view:not([style*="display: none"])');
        const customizeShown = !!(
          customizeEl &&
          getComputedStyle(customizeEl).display !== 'none' &&
          !document.querySelector('text-view:not([style*="display: none"])')
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

      // Face customisation: open the customize-faces buffer, then set
      // the keyword face's foreground via the Lisp API and assert the
      // computed `.tok-keyword` colour (from the live swatch inside
      // the customize buffer) reflects the override. Reset, then
      // assert the default colour is back.
      const faces = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        // Open the Faces customize buffer — it renders one live
        // .tok-keyword swatch we can read.
        submit('(customize-faces)');
        await new Promise((r) => setTimeout(r, 250));
        await frame();
        // Phase 3d: query the wrapper element for visibility — its
        // inline display:none toggle is what hides the customize UI;
        // the inner .customize div's computed style stays 'block'.
        const cv = document.querySelector('customize-view:not([style*="display: none"])');
        const customizeShown = !!(cv && getComputedStyle(cv).display !== 'none');
        const faceRows = cv ? cv.querySelectorAll('.customize-face-row').length : 0;
        const swatchFor = (face) => {
          const row = cv && cv.querySelector(\`[data-face-name="\${face}"]\`);
          if (!row) return null;
          const span = row.querySelector(\`.tok-\${face}\`);
          if (!span) return null;
          return getComputedStyle(span).color;
        };
        const before = swatchFor('keyword');
        // Override the keyword face to bright red.
        submit('(set-face-attribute (quote keyword) :foreground "#ff0000")');
        await new Promise((r) => setTimeout(r, 150));
        await frame();
        const after = swatchFor('keyword');
        // Reset.
        submit('(reset-face (quote keyword))');
        await new Promise((r) => setTimeout(r, 150));
        await frame();
        const reset = swatchFor('keyword');

        // Inheritance: declare a child face that inherits from
        // \`keyword\`, then override the parent's foreground and assert
        // the child face's resolved foreground reflects the change.
        const lastResult = () => {
          const all = document.querySelectorAll('.repl-result');
          return all.length ? all[all.length - 1].textContent.trim() : '';
        };
        submit('(defface (quote smoke-keyword-child) from (quote keyword))');
        await new Promise((r) => setTimeout(r, 100));
        await frame();
        submit('(set-face-attribute (quote keyword) :foreground "#00ff00")');
        await new Promise((r) => setTimeout(r, 100));
        await frame();
        submit('(face-attribute (quote smoke-keyword-child) :foreground)');
        await new Promise((r) => setTimeout(r, 100));
        const inheritedAfter = lastResult();
        submit('(reset-face (quote keyword))');
        await new Promise((r) => setTimeout(r, 100));

        return {
          before, after, reset,
          changed: !!(before && after && before !== after),
          restored: !!(before && reset && before === reset),
          customizeShown,
          faceRows,
          redLike: after === 'rgb(255, 0, 0)',
          inheritedAfter,
          inheritsParentOverride: inheritedAfter.includes('#00ff00'),
        };
      })()`);
      console.log('  faces:', JSON.stringify(faces));

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
        const view = document.querySelector('image-view:not([style*="display: none"])');
        const img = view ? view.querySelector('.image-content') : null;
        const toggle = view ? view.querySelector('.image-zoom-toggle') : null;
        const shown = !!(
          view &&
          getComputedStyle(view).display !== 'none' &&
          !document.querySelector('text-view:not([style*="display: none"])')
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
        submit('(new-view! "swatch.css")');
        await frame();
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
        editor.focus();
        for (const ch of 'a #ff8800 b rgb(0,0,0)') {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: ch, bubbles: true, cancelable: true,
          }));
        }
        await frame();
        // One swatch per literal — the #ff8800 hash and the rgb() form.
        const count = document.querySelectorAll('.colour-swatch').length;
        const firstBefore = document.querySelector('text-view:not([style*="display: none"]) .editor-line').textContent;
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
          edited = document.querySelector('text-view:not([style*="display: none"]) .editor-line').textContent;
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
        const view = document.querySelector('doc-view:not([style*="display: none"])');
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
        const secondPage = document.querySelector('doc-view:not([style*="display: none"]) .doc-page');
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
        const view = document.querySelector('doc-view:not([style*="display: none"])');
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

      // Buffer menu: C-x C-b opens *Buffer List* with one row per
      // open buffer; marking and executing kills the marked buffer.
      // We drive the read-back through (buffer-text) in the REPL —
      // the editor view is virtualised, so .innerText only shows the
      // visible window.
      const bufferMenu = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
        // Seed a couple of throwaway buffers to mark and kill.
        submit('(new-view! "bm-target.txt")');
        await frame();
        submit('(new-view! "bm-keep.txt")');
        await frame();
        // Open the menu via the bound key.
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
        editor.focus();
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'x', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'b', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        await frame();
        // Read the menu contents from Lisp.
        submit('(view-name)');
        const menuName = lastResult();
        submit('(buffer-text)');
        const text = JSON.parse(lastResult());
        const lines = text.split('\\n').filter((l) => l.length > 0);
        const rowCount = lines.length - 1; // minus the header
        const listsTarget = text.includes('bm-target.txt');
        const listsKeep = text.includes('bm-keep.txt');
        const listsSelf = text.includes('*Buffer List*');
        // Mark bm-target and execute. We use Lisp to do the navigation:
        // a goto-line based on the line that contains bm-target.
        submit('(define (-bm-find-row i)'
          + ' (goto-line! (+ i 1))'
          + ' (cond ((>= i (buffer-line-count)) nil)'
          + ' ((string-contains? (current-line-text) "bm-target.txt") i)'
          + ' (else (-bm-find-row (+ i 1)))))');
        await wait(20);
        submit('(-bm-find-row 0)');
        await wait(50);
        submit('(current-line-text)');
        await wait(50);
        const cursorLine = lastResult();
        editor.focus();
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'd', bubbles: true, cancelable: true,
        }));
        await frame();
        // Capture the marked-state mid-flight so a failure tells us
        // whether marking or execution broke.
        submit('(current-line-text)');
        await wait(50);
        const afterMark = lastResult();
        editor.focus();
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'x', bubbles: true, cancelable: true,
        }));
        await wait(100);
        submit('(buffer-text)');
        await wait(50);
        const after = JSON.parse(lastResult());
        return {
          menuName,
          rowCount,
          listsTarget,
          listsKeep,
          listsSelf,
          cursorLine,
          afterMark,
          targetGone: !after.includes('bm-target.txt'),
          keepStill: after.includes('bm-keep.txt'),
        };
      })()`);
      console.log('  bufferMenu:', JSON.stringify(bufferMenu));

      // Jukebox: seed a directory with placeholder audio files (their
      // contents are irrelevant — the smoke checks the jukebox view
      // mounts, lists every track, finds the cover, and the shuffle
      // toggle flips on user interaction), then run `(jukebox <dir>)`
      // and inspect the rendered DOM.
      await mkdir(jukeboxDir, { recursive: true });
      // aaa-silence.mp3 carries a real ID3v2 tag with an embedded APIC
      // picture so the smoke can verify the view shows it as a
      // `data:` URL (i.e. the extraction pipeline ran end-to-end).
      // The `aaa-` prefix keeps it first in the alphabetic track
      // ordering, so it's the initial "now playing" the embedded-art
      // assertion runs against.
      // aaa-silence.mp3 also carries TIT2/TPE1/TALB frames so the
      // jukebox view's row label is `"Test", A, B` rather than the
      // bare filename — proves the metadata parser + IPC + Lisp
      // formatter all wired through. The APIC frame is still here too.
      const embeddedMp3 = buildID3v23Tagged(
        'Test', 'A', 'B', 'image/jpeg', SAMPLE_JPEG_BYTES
      );
      void buildID3v23WithAPIC; // kept for compatibility / readability
      await Promise.all([
        writeFile(join(jukeboxDir, 'aaa-silence.mp3'), embeddedMp3),
        writeFile(join(jukeboxDir, 'second.flac'), ''),
        writeFile(join(jukeboxDir, 'cover.jpg'), ''),
        writeFile(join(jukeboxDir, 'readme.txt'), 'ignore me'),
      ]);
      const jukebox = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        // Track the audio controller's play() so the test can assert
        // the click on a track row reaches it. The renderer stashes the
        // jukebox view on window for inspection isn't ideal — we read
        // the DOM instead and rely on the fact that the underlying
        // HTMLAudioElement updates its src.
        submit('(jukebox ${JSON.stringify(jukeboxDir)})');
        await frame();
        await frame();
        // Embedded-art lookup is async (IPC round-trip); wait for the
        // <img src> to flip from the sidecar's media:// URL to the
        // data: URL the parser produces. Poll a handful of frames so
        // the smoke isn't flaky on slow CI.
        const waitFor = async (predicate, max) => {
          for (let i = 0; i < max; i += 1) {
            if (predicate()) return true;
            await frame();
          }
          return predicate();
        };
        const view = document.querySelector('jukebox-view:not([style*="display: none"])');
        const visible = view && view.style.display !== 'none';
        const name = document.getElementById('modeline-name').textContent;
        const tracks = view
          ? Array.from(view.querySelectorAll('.jukebox-track-button'))
              .map((b) => b.textContent)
          : [];
        const art = view ? view.querySelector('.jukebox-art-image') : null;
        const hasArt = !!(art && art.getAttribute('src'));
        // Wait for the embedded art to land. aaa-silence.mp3 (the seeded
        // first track) carries an APIC frame; the view should switch
        // its <img src> to a data:image/jpeg;base64,... URL.
        await waitFor(
          () => !!(art && (art.getAttribute('src') || '').startsWith('data:')),
          30
        );
        const artSrcAfterEmbed = art ? (art.getAttribute('src') || '') : '';
        const embeddedArtShown = artSrcAfterEmbed.startsWith('data:');
        const audioEl = view ? view.querySelector('audio.jukebox-audio') : null;
        const hasAudio = !!audioEl;
        // Click the second track row → the audio element's src should
        // change to the second track's media:// URL.
        const buttons = view
          ? view.querySelectorAll('.jukebox-track-button')
          : [];
        if (buttons.length >= 2) buttons[1].click();
        await frame();
        const audioSrc = audioEl ? audioEl.src : '';
        // Toggle shuffle by clicking the shuffle button.
        const shuffleBtn = view
          ? view.querySelector('.jukebox-shuffle')
          : null;
        const shuffleBefore = shuffleBtn ? shuffleBtn.textContent : '';
        if (shuffleBtn) shuffleBtn.click();
        await frame();
        const shuffleAfter = shuffleBtn ? shuffleBtn.textContent : '';

        // Keymap forwarding: with the jukebox view focused, fire
        // C-x then k as keydowns. The view must forward both to the
        // global keymap; C-x k (kill-buffer) then removes the
        // jukebox buffer. Without the keymap fix the keys are eaten
        // by the view and the buffer survives.
        if (view) view.focus();
        // Dispatch on the inner .jukebox-view root div (or fall back
        // to body). The custom element wrapper doesn't carry the
        // keydown listener — the inner root is a descendant — so a
        // synthetic dispatch on the wrapper bubbles up and never
        // reaches the handler. Hitting root directly is what real
        // focus + key events do.
        const target =
          (view && view.querySelector('.jukebox-view')) || view || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'x', code: 'KeyX', ctrlKey: true,
          bubbles: true, cancelable: true,
        }));
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'k', code: 'KeyK',
          bubbles: true, cancelable: true,
        }));
        await frame();
        await frame();
        // The jukebox view's container is hidden once the jukebox
        // buffer is gone (the next buffer's view is mounted instead).
        // Phase 3f: visibility is on the <jukebox-view> wrapper, not
        // on the inner .jukebox-view div.
        const jukeboxWrapperEl = document.querySelector('jukebox-view');
        const jukeboxStillVisible = !!(
          jukeboxWrapperEl && jukeboxWrapperEl.style.display !== 'none'
        );
        const modelineName =
          document.getElementById('modeline-name').textContent;

        return {
          name,
          visible,
          tracks,
          hasArt,
          hasAudio,
          audioSrc,
          shuffleBefore,
          shuffleAfter,
          jukeboxStillVisible,
          afterKillName: modelineName,
          embeddedArtShown,
          artSrcPrefix: artSrcAfterEmbed.slice(0, 30),
        };
      })()`);
      console.log('  jukebox:', JSON.stringify({
        name: jukebox.name,
        visible: jukebox.visible,
        tracks: jukebox.tracks.length,
        hasArt: jukebox.hasArt,
        hasAudio: jukebox.hasAudio,
        shuffleFlip: jukebox.shuffleBefore + ' -> ' + jukebox.shuffleAfter,
        killedByCx: !jukebox.jukeboxStillVisible,
        afterKillName: jukebox.afterKillName,
        embeddedArt: jukebox.embeddedArtShown,
        artSrcPrefix: jukebox.artSrcPrefix,
      }));
      await rm(jukeboxDir, { recursive: true, force: true });

      // Media views: opening an audio file (a tagged .mp3) mounts the
      // audio view with the title, artist, album and album art drawn
      // from the embedded tag; opening a video file (.mp4) mounts the
      // video view with the filename and absolute path beneath the
      // <video controls> element. `q` dismisses each. The smoke uses
      // `open-file-path!` so the dialog stub (still pointing at the
      // smoke image) stays out of the way.
      const mediaViews = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };

        // --- audio view ---
        submit('(open-file-path! ${JSON.stringify(mediaAudioPath)})');
        await wait(400);
        await frame();
        const audioView = document.querySelector('audio-view:not([style*="display: none"])');
        const audioShown = !!(
          audioView &&
          getComputedStyle(audioView).display !== 'none' &&
          !document.querySelector('text-view:not([style*="display: none"])')
        );
        const audioName =
          document.getElementById('modeline-name')?.textContent ?? '';
        const audioEl = audioView ? audioView.querySelector('audio.audio-player') : null;
        const hasAudioEl = !!(audioEl && audioEl.getAttribute('src'));
        const audioSrc = audioEl ? (audioEl.getAttribute('src') || '') : '';
        // The embedded TIT2/TPE1/TALB frames must reach the title and
        // metadata block.
        const titleText = audioView
          ? (audioView.querySelector('.audio-title')?.textContent ?? '')
          : '';
        const subtitleText = audioView
          ? (audioView.querySelector('.audio-subtitle')?.textContent ?? '')
          : '';
        const metaText = audioView
          ? Array.from(audioView.querySelectorAll('.audio-meta dd')).map((dd) => {
              // Editable rows wrap their value in .audio-meta-value
              // (next to the minus button); derived rows put the value
              // directly in <dd>. Either way, read the value's text.
              const valueEl = dd.querySelector('.audio-meta-value');
              return (valueEl ? valueEl.textContent : dd.textContent).trim();
            })
          : [];
        const albumArt = audioView
          ? audioView.querySelector('.audio-art-image')
          : null;
        const albumArtSrc = albumArt
          ? (albumArt.getAttribute('src') || '')
          : '';
        // The inner .audio-layout is content-sized (flex: 0 0 auto),
        // so the play controls sit right under the metadata instead of
        // being pushed to the pane's bottom. The REPL splitter still
        // owns the editor / REPL boundary so the user can drag it as
        // usual.
        const audioLayout = audioView
          ? audioView.querySelector('.audio-layout')
          : null;
        const audioLayoutStyle = audioLayout
          ? getComputedStyle(audioLayout)
          : null;
        const audioLayoutIsContentSized = !!(
          audioLayoutStyle &&
          audioLayoutStyle.flexGrow === '0' &&
          audioLayoutStyle.flexShrink === '0' &&
          audioLayoutStyle.flexBasis === 'auto'
        );

        // --- inline-edit affordances (agent-audio-edit-ui) ---
        // Editable rows carry data-editable="true" + a .audio-meta-
        // value span + a .audio-meta-minus button. Derived rows
        // carry .audio-meta-derived. The plus-pill renders below the
        // metadata list.
        const editableDds = audioView
          ? Array.from(audioView.querySelectorAll('.audio-meta dd[data-editable="true"]'))
          : [];
        const derivedDds = audioView
          ? Array.from(audioView.querySelectorAll('.audio-meta dd.audio-meta-derived'))
          : [];
        const minusButtons = audioView
          ? audioView.querySelectorAll('.audio-meta-minus').length
          : 0;
        const plusButton = audioView
          ? audioView.querySelector('.audio-meta-plus-button')
          : null;
        const plusFormHiddenInitially = audioView
          ? !!audioView.querySelector('.audio-meta-plus-form')?.hidden
          : false;
        const editableKeys = editableDds.map((dd) => dd.dataset.key).sort();

        // Drive the inline-edit lifecycle: double-click the Artist
        // value, type a new value, press Enter. The stubbed primitive
        // returns success, so buffer.metadata updates and the row
        // repaints with the new text.
        const artistDd = audioView
          ? audioView.querySelector('.audio-meta dd[data-key="artist"]')
          : null;
        const artistValueBefore = artistDd
          ? (artistDd.querySelector('.audio-meta-value')?.textContent ?? '')
          : '';
        if (artistDd) {
          artistDd.querySelector('.audio-meta-value').dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true, cancelable: true })
          );
        }
        await frame();
        const editingInput = audioView
          ? audioView.querySelector('.audio-meta-input')
          : null;
        if (editingInput) {
          editingInput.value = 'Edited Artist';
          editingInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        }
        await frame();
        const artistDdAfter = audioView
          ? audioView.querySelector('.audio-meta dd[data-key="artist"]')
          : null;
        const artistValueAfter = artistDdAfter
          ? (artistDdAfter.querySelector('.audio-meta-value')?.textContent ?? '')
          : '';

        // Minus button removes the album row.
        const albumMinus = audioView
          ? audioView.querySelector('.audio-meta dd[data-key="album"] .audio-meta-minus')
          : null;
        if (albumMinus) {
          albumMinus.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
          }));
        }
        await frame();
        const albumAfter = audioView
          ? audioView.querySelector('.audio-meta dd[data-key="album"]')
          : null;

        // Plus pill: click to expand, type a key+value, confirm.
        if (plusButton) {
          plusButton.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
          }));
        }
        await frame();
        const plusForm = audioView
          ? audioView.querySelector('.audio-meta-plus-form')
          : null;
        const plusFormShownAfterClick = plusForm ? !plusForm.hidden : false;
        if (plusForm) {
          plusForm.querySelector('.audio-meta-plus-key').value = 'composer';
          plusForm.querySelector('.audio-meta-plus-value').value = 'Smoke Composer';
          plusForm.querySelector('.audio-meta-plus-confirm').dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
          );
        }
        await frame();
        const composerDd = audioView
          ? audioView.querySelector('.audio-meta dd[data-key="composer"]')
          : null;
        const composerValue = composerDd
          ? (composerDd.querySelector('.audio-meta-value')?.textContent ?? '')
          : '';

        // Disk verification: re-read the seeded MP3 through
        // audioMetadataSync to confirm the edits reached the file.
        // The ID3v2 writer rebuilds the whole tag, so a successful
        // edit replaces the old values byte-for-byte. (The album
        // row was removed; the artist was edited; composer was
        // added via the plus pill — the sequence exercises the
        // writer's three paths.)
        const onDisk = window.host.audioMetadataSync(${JSON.stringify(mediaAudioPath)});
        const diskArtist = onDisk?.artist ?? '';
        const diskAlbum = onDisk?.album ?? null;
        const diskTitle = onDisk?.title ?? '';

        // \`q\` on the focused view dismisses the buffer; the audio
        // view should be hidden afterwards and the modeline back on a
        // different buffer.
        if (audioView) audioView.focus();
        // Dispatch on the inner .audio-view root, not the wrapper —
        // see the jukebox arm above for the same reason.
        const target =
          (audioView && audioView.querySelector('.audio-view')) ||
          audioView || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'q', code: 'KeyQ',
          bubbles: true, cancelable: true,
        }));
        await wait(150);
        await frame();
        // Phase 3b: the display:none toggle moved from the inner
        // .audio-view div to the <audio-view> wrapper element.
        const audioWrapperEl = document.querySelector('audio-view');
        const audioStillVisible = !!(
          audioWrapperEl && audioWrapperEl.style.display !== 'none'
        );
        const afterAudioKill =
          document.getElementById('modeline-name')?.textContent ?? '';

        // --- video view ---
        submit('(open-file-path! ${JSON.stringify(mediaVideoPath)})');
        await wait(400);
        await frame();
        const videoView = document.querySelector('video-view:not([style*="display: none"])');
        const videoShown = !!(
          videoView &&
          getComputedStyle(videoView).display !== 'none' &&
          !document.querySelector('text-view:not([style*="display: none"])')
        );
        const videoName =
          document.getElementById('modeline-name')?.textContent ?? '';
        const videoEl = videoView
          ? videoView.querySelector('video.video-player')
          : null;
        const hasVideoEl = !!(videoEl && videoEl.getAttribute('src'));
        const videoSrc = videoEl ? (videoEl.getAttribute('src') || '') : '';
        const captionName = videoView
          ? (videoView.querySelector('.video-name')?.textContent ?? '')
          : '';
        const captionPath = videoView
          ? (videoView.querySelector('.video-path')?.textContent ?? '')
          : '';
        // \`q\` dismisses.
        if (videoView) videoView.focus();
        // Inner-root dispatch — same reason as the audio/jukebox arms.
        const videoTarget =
          (videoView && videoView.querySelector('.video-view')) ||
          videoView || document.body;
        videoTarget.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'q', code: 'KeyQ',
          bubbles: true, cancelable: true,
        }));
        await wait(150);
        await frame();
        // Phase 3c: same wrapper-vs-inner change as audio above —
        // display:none lives on the video-view element, not on the
        // inner .video-view div.
        const videoWrapperEl = document.querySelector('video-view');
        const videoStillVisible = !!(
          videoWrapperEl && videoWrapperEl.style.display !== 'none'
        );
        const afterVideoKill =
          document.getElementById('modeline-name')?.textContent ?? '';

        return {
          audioShown, audioName, hasAudioEl, audioSrc,
          titleText, subtitleText, metaText, albumArtSrc,
          audioLayoutIsContentSized,
          editableKeys, derivedCount: derivedDds.length, minusButtons,
          plusButton: !!plusButton, plusFormHiddenInitially,
          artistValueBefore, artistValueAfter,
          albumRemoved: !albumAfter,
          plusFormShownAfterClick, composerValue,
          diskArtist, diskAlbum, diskTitle,
          audioStillVisible, afterAudioKill,
          videoShown, videoName, hasVideoEl, videoSrc,
          captionName, captionPath,
          videoStillVisible, afterVideoKill,
        };
      })()`);
      console.log('  mediaViews:', JSON.stringify({
        audio: {
          shown: mediaViews.audioShown,
          name: mediaViews.audioName,
          srcPrefix: mediaViews.audioSrc.slice(0, 30),
          title: mediaViews.titleText,
          subtitle: mediaViews.subtitleText,
          metaRows: mediaViews.metaText.length,
          albumArtIsDataUrl:
            mediaViews.albumArtSrc.startsWith('data:image/'),
          layoutIsContentSized: mediaViews.audioLayoutIsContentSized,
          editableKeys: mediaViews.editableKeys,
          derivedCount: mediaViews.derivedCount,
          minusButtons: mediaViews.minusButtons,
          plusPresent: mediaViews.plusButton && mediaViews.plusFormHiddenInitially,
          edited: {
            before: mediaViews.artistValueBefore,
            after: mediaViews.artistValueAfter,
          },
          albumRemoved: mediaViews.albumRemoved,
          plusFormExpanded: mediaViews.plusFormShownAfterClick,
          composerAdded: mediaViews.composerValue,
          onDisk: {
            artist: mediaViews.diskArtist,
            album: mediaViews.diskAlbum,
            title: mediaViews.diskTitle,
          },
          dismissed: !mediaViews.audioStillVisible,
        },
        video: {
          shown: mediaViews.videoShown,
          name: mediaViews.videoName,
          srcPrefix: mediaViews.videoSrc.slice(0, 30),
          captionName: mediaViews.captionName,
          dismissed: !mediaViews.videoStillVisible,
        },
      }));
      await rm(mediaAudioPath, { force: true });
      await rm(mediaVideoPath, { force: true });

      // Splitters: each drag updates a CSS custom property on the
      // document root, and the host persists the final value through
      // panes.json. The check programmatically drives pointer events
      // at each splitter, reads back the CSS variable, then reads
      // panes.json through the host bridge to confirm persistence.
      const splitters = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        const cssVar = (name) => getComputedStyle(document.documentElement)
          .getPropertyValue(name).trim();
        // Show the preview pane so its splitter has something to act on.
        submit('(new-view! "splitter.md")');
        await frame();
        submit('(set! *markdown-interpreter* "cat")');
        await frame();
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
        editor.focus();
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'c', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'v', bubbles: true, cancelable: true,
        }));
        await wait(400);
        const previewSplit = document.getElementById('preview-splitter');
        const replSplit = document.getElementById('repl-splitter');
        const previewShown = !!(previewSplit
          && getComputedStyle(previewSplit).display !== 'none');
        const replShown = !!(replSplit
          && getComputedStyle(replSplit).display !== 'none');
        // Drag the preview splitter: the new preview width is measured
        // from the workspace's right edge. Aim for ~280px.
        const workspace = document.getElementById('workspace');
        const wsRect = workspace.getBoundingClientRect();
        const targetPreviewX = wsRect.right - 280;
        const previewBefore = cssVar('--preview-width');
        previewSplit.dispatchEvent(new PointerEvent('pointerdown', {
          pointerId: 1, button: 0, bubbles: true, cancelable: true,
        }));
        previewSplit.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: 1, clientX: targetPreviewX, bubbles: true, cancelable: true,
        }));
        previewSplit.dispatchEvent(new PointerEvent('pointerup', {
          pointerId: 1, bubbles: true, cancelable: true,
        }));
        await frame();
        const previewAfter = cssVar('--preview-width');
        // Drag the REPL splitter: the new REPL height is measured from
        // the viewport's bottom edge. Aim for ~180px.
        const targetReplY = window.innerHeight - 180;
        const replBefore = cssVar('--repl-height');
        replSplit.dispatchEvent(new PointerEvent('pointerdown', {
          pointerId: 2, button: 0, bubbles: true, cancelable: true,
        }));
        replSplit.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: 2, clientY: targetReplY, bubbles: true, cancelable: true,
        }));
        replSplit.dispatchEvent(new PointerEvent('pointerup', {
          pointerId: 2, bubbles: true, cancelable: true,
        }));
        await frame();
        const replAfter = cssVar('--repl-height');
        // Give the writePanes IPC a beat to flush to disk.
        await wait(150);
        const stored = await window.host.readPanes();
        return {
          previewShown, replShown,
          previewBefore, previewAfter,
          replBefore, replAfter,
          stored,
        };
      })()`);
      console.log('  splitters:', JSON.stringify(splitters));

      // Tabline + persistent session. Open a real file (the dialog is
      // stubbed to choose the scratch path written below), type into
      // it, move the cursor, then drive the round-trip:
      //   1. force-save the session via the host bridge
      //   2. read it back through the same bridge
      //   3. re-run the restore loop in-place against a freshly seeded
      //      buffer list, asserting the file + content + cursor land.
      // The tabline checks just inspect the live DOM: one tab per open
      // buffer, the current tab marked, clicks switch buffers.
      const tabPath = join(tmpdir(), 'jmacs-smoke-tabline.txt');
      await writeFile(tabPath, 'tab smoke content\nline two\n', 'utf8');
      // Stub the dialog to choose this scratch file (the image path
      // stub was set up much earlier in this run).
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [tabPath],
      });
      const tabline = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        // Open the scratch file through the real path (the dialog is
        // stubbed). Wait for the IPC to settle.
        submit('(open-file!)');
        await wait(400);
        // Type a bit and move point to a known position.
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
        editor.focus();
        for (const ch of 'XY') {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: ch, bubbles: true, cancelable: true,
          }));
        }
        await frame();
        submit('(goto! 5)');
        await frame();
        // Tabline DOM: one tab per buffer, including the freshly
        // opened one; the current tab is filled.
        const tabs = document.querySelectorAll('.tabline-tab');
        const tabCount = tabs.length;
        const currentTab = document.querySelector('.tabline-tab.is-current');
        const currentLabel = currentTab
          ? currentTab.querySelector('.tabline-label').textContent
          : '';
        // Force-save the session through the host bridge — we
        // deliberately write a v1 payload here so the same arm also
        // exercises the v1 → v2 migration path in createSession.restore.
        const beforeWrite = await window.host.readSession();
        await window.host.writeSession({
          buffers: [
            { path: ${JSON.stringify(tabPath)}, point: 5, mark: null },
          ],
          currentPath: ${JSON.stringify(tabPath)},
        });
        const written = await window.host.readSession();
        // Restore loop, in-place: re-instantiating the renderer is
        // disruptive in a single Electron run, so we drive the same
        // controller logic by importing the module fresh and exercising
        // it against a captured handle to the host bridge. Phase 3b
        // commit 6: createSession is pane-tree-shaped — openByPath
        // returns a view handle and installRootPane is called once
        // with the assembled tree.
        const sessionMod = await import('app://editor/apps/desktop/src/session.js');
        const fakeViews = [];
        let installedRoot = null;
        let installedCurrent = null;
        const controller = sessionMod.createSession({
          getRootPane: () => ({ kind: 'leaf', id: 'pane-leaf-test', view: null }),
          getCurrentPaneId: () => 'pane-leaf-test',
          openByPath: async (path, entry) => {
            // Read the file back the same way the real app does.
            const result = await window.host.openFilePath(path);
            if (result === null) return null;
            const view = {
              kind: 'text',
              name: result.name,
              content: result.content,
              buffer: {
                filePath: result.path,
                point: entry.point,
                mark: entry.mark,
              },
              point: entry.point,
              mark: entry.mark,
            };
            fakeViews.push(view);
            return view;
          },
          installRootPane: (root, currentPaneId) => {
            installedRoot = root;
            installedCurrent = currentPaneId;
          },
          host: window.host,
        });
        await controller.restore();
        // For the v1 migration: the installed root is a single leaf
        // holding a tabline-view whose tabs were materialised from
        // openByPath's returned handles.
        const installedTabs = installedRoot && installedRoot.view
          && installedRoot.view.kind === 'tabline'
          ? installedRoot.view.tabs : [];
        return {
          tabCount,
          currentLabel,
          beforeWrite,
          written,
          restoredCount: fakeViews.length,
          restoredPath: fakeViews[0]?.buffer?.filePath ?? '',
          restoredContent: fakeViews[0]?.content ?? '',
          restoredPoint: fakeViews[0]?.buffer?.point ?? -1,
          installedRootKind: installedRoot ? installedRoot.kind : null,
          installedRootViewKind: installedRoot && installedRoot.view
            ? installedRoot.view.kind : null,
          installedTabsCount: installedTabs.length,
          installedCurrent,
        };
      })()`);
      console.log('  tabline:', JSON.stringify({
        tabCount: tabline.tabCount,
        currentLabel: tabline.currentLabel,
        written: tabline.written?.currentPath,
        restoredCount: tabline.restoredCount,
        restoredPoint: tabline.restoredPoint,
        installedRootKind: tabline.installedRootKind,
        installedRootViewKind: tabline.installedRootViewKind,
        installedTabsCount: tabline.installedTabsCount,
        installedCurrent: tabline.installedCurrent,
      }));
      await rm(tabPath, { force: true });

      // Language pack: one canonical buffer per newly added language,
      // each insert-then-frame followed by a face-class count read
      // through document.querySelectorAll. A non-zero count proves the
      // grammar loaded and its highlight query produced spans. The
      // arm is intentionally additive — adding a language is one new
      // submit + one new count read — and aggregates to a single
      // boolean. Languages whose grammar is built from C source are
      // bunched with the npm-prebuilt ones; the .wasm file is the
      // same shape either way.
      const langPack = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        const counts = (cls) => document.querySelectorAll('.' + cls).length;
        const open = async (file, body) => {
          submit('(new-view! "' + file + '")');
          submit('(insert! "' + body.replace(/"/g, '\\\\"').replace(/\\n/g, '\\\\n') + '")');
          await frame();
        };
        const results = {};
        // Each row: language tag, sample file, one canonical line, and
        // the face classes expected to have produced at least one span.
        const cases = [
          ['c',          'smoke.c',          'int main(void) { return 0; }',     ['tok-keyword','tok-type','tok-number']],
          ['cpp',        'smoke.cpp',        'class C { int x = 1; };',          ['tok-keyword','tok-type']],
          ['java',       'smoke.java',       'class C { int x = 1; }',           ['tok-keyword','tok-type']],
          ['csharp',     'smoke.cs',         'class C { int x = 1; }',           ['tok-keyword','tok-type']],
          ['ruby',       'smoke.rb',         'def foo; return nil; end',         ['tok-keyword','tok-function']],
          ['lua',        'smoke.lua',        'local function foo() return 1 end',['tok-keyword','tok-function']],
          ['yaml',       'smoke.yaml',       'name: smoke',                       ['tok-function']],
          ['toml',       'smoke.toml',       'name = 42',                         ['tok-function','tok-number']],
          ['haskell',    'smoke.hs',         'main = putStrLn "hi"',             ['tok-function','tok-string']],
          ['ocaml',      'smoke.ml',         'let x = 42',                       ['tok-keyword','tok-number']],
          ['elixir',     'smoke.ex',         'def foo do 1 end',                 ['tok-keyword','tok-number']],
          ['clojure',    'smoke.clj',        '(defn foo [] 1)',                  ['tok-function','tok-number']],
          ['scheme',     'smoke.scm',        '(define (foo) 1)',                 ['tok-keyword','tok-number']],
          ['erlang',     'smoke.erl',        '-module(foo). x() -> 1.',          ['tok-keyword','tok-number']],
          ['sql',        'smoke.sql',        'SELECT * FROM users;',             ['tok-keyword']],
          ['dockerfile', 'smoke.dockerfile', 'FROM alpine\\nRUN echo hi',         ['tok-keyword']],
          ['nix',        'smoke.nix',        'let x = 1; in x',                  ['tok-keyword','tok-number']],
          ['xml',        'smoke.xml',        '<root attr="v">x</root>',          ['tok-tag','tok-string']],
          ['graphql',    'smoke.graphql',    'query { user { id } }',            ['tok-keyword','tok-function']],
          ['kotlin',     'smoke.kt',         'fun foo(): Int = 1',               ['tok-keyword','tok-type','tok-number']],
          ['swift',      'smoke.swift',      'func foo() -> Int { return 1 }',   ['tok-keyword','tok-type']],
          ['zig',        'smoke.zig',        'fn foo() i32 { return 1; }',       ['tok-keyword','tok-number']],
        ];
        for (const [tag, file, body, classes] of cases) {
          await open(file, body);
          // Re-read each class fresh after the buffer is rendered.
          const found = {};
          for (const c of classes) found[c] = counts(c);
          results[tag] = found;
        }
        return {
          // Which language tags actually loaded a tree-sitter grammar.
          langs: document.body.dataset.treesitter,
          results,
        };
      })()`);
      console.log('  langPack:', JSON.stringify(langPack));

      // Directory tree-view: open a tree rooted at the temp dir we've
      // been writing scratch files into. Expand a known subfolder (we
      // seed one), confirm a file row exists with the right icon
      // class, click it, confirm the right view took over.
      const treeDir = join(tmpdir(), 'jmacs-smoke-tree');
      await rm(treeDir, { recursive: true, force: true });
      await mkdir(join(treeDir, 'subdir'), { recursive: true });
      await writeFile(join(treeDir, 'note.txt'), 'hello\n', 'utf8');
      await writeFile(join(treeDir, 'main.js'), 'export default 1\n', 'utf8');
      await writeFile(join(treeDir, 'subdir', 'inner.md'), '# inner\n', 'utf8');
      const tree = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        // Open the tree-view at the seeded directory.
        submit('(directory-tree ${JSON.stringify(treeDir)})');
        await wait(150);
        await frame();
        const view = document.querySelector('directory-tree-view:not([style*="display: none"])');
        const shown = !!(view && getComputedStyle(view).display !== 'none');
        // Row count: subdir (one folder, collapsed) + main.js + note.txt
        // = 3 rows at root level. Folders first, then files
        // alphabetically per the host's sort.
        const rowsBefore = view ? view.querySelectorAll('.directory-tree-row').length : 0;
        // Find the subdir row and click its chevron.
        const subdirRow = view ? Array.from(view.querySelectorAll('.directory-tree-row'))
          .find((r) => r.querySelector('.directory-tree-name').textContent === 'subdir')
          : null;
        if (subdirRow) {
          subdirRow.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
          }));
        }
        await frame();
        const rowsAfterExpand = view ? view.querySelectorAll('.directory-tree-row').length : 0;
        // The chevron rotated. (Re-query after paint — the row element
        // is rebuilt each render, so subdirRow held the old chevron.)
        const subdirAfter = view ? Array.from(view.querySelectorAll('.directory-tree-row'))
          .find((r) => r.querySelector('.directory-tree-name').textContent === 'subdir')
          : null;
        const chevronOpen = subdirAfter
          ? subdirAfter.querySelector('.directory-tree-chevron').classList.contains('is-open')
          : false;
        // The file rows' icons reflect their suffix.
        const jsRow = view ? Array.from(view.querySelectorAll('.directory-tree-row'))
          .find((r) => r.querySelector('.directory-tree-name').textContent === 'main.js')
          : null;
        const jsIconClass = jsRow
          ? jsRow.querySelector('.directory-tree-icon').className
          : '';
        const noteRow = view ? Array.from(view.querySelectorAll('.directory-tree-row'))
          .find((r) => r.querySelector('.directory-tree-name').textContent === 'note.txt')
          : null;
        const noteIconClass = noteRow
          ? noteRow.querySelector('.directory-tree-icon').className
          : '';
        // Activate the note.txt row — files open on double-click now
        // (matches directory-columns). A single click would just
        // select the row.
        const beforeOpenBuffer = document.getElementById('modeline-name')?.textContent ?? '';
        if (noteRow) {
          // First click selects; dblclick opens.
          noteRow.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
          }));
          noteRow.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, detail: 2,
          }));
          noteRow.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true, cancelable: true,
          }));
        }
        await wait(200);
        await frame();
        const afterOpenBuffer = document.getElementById('modeline-name')?.textContent ?? '';
        return {
          shown,
          rowsBefore,
          rowsAfterExpand,
          chevronOpen,
          jsIconClass,
          noteIconClass,
          beforeOpenBuffer,
          afterOpenBuffer,
        };
      })()`);
      console.log('  tree:', JSON.stringify(tree));
      await rm(treeDir, { recursive: true, force: true });

      // Directory columns-view: drill into a subfolder, preview a
      // text file, check the preview pane fills with the file body.
      const colsDir = join(tmpdir(), 'jmacs-smoke-cols');
      await rm(colsDir, { recursive: true, force: true });
      await mkdir(join(colsDir, 'subdir'), { recursive: true });
      await writeFile(join(colsDir, 'subdir', 'inner.txt'), 'hello columns\n', 'utf8');
      await writeFile(join(colsDir, 'readme.md'), '# readme\n', 'utf8');
      const cols = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        submit('(directory-columns ${JSON.stringify(colsDir)})');
        await wait(200);
        await frame();
        const view = document.querySelector('directory-columns-view:not([style*="display: none"])');
        const shown = !!(view && getComputedStyle(view).display !== 'none');
        const initialColumns = view
          ? view.querySelectorAll('.directory-columns-column').length
          : 0;
        const findRow = (name) => view
          ? Array.from(view.querySelectorAll('.directory-columns-row'))
              .find((r) => r.querySelector('.directory-columns-name').textContent === name)
          : null;
        const subdirRow = findRow('subdir');
        if (subdirRow) {
          subdirRow.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
          }));
        }
        await frame();
        const columnsAfterDrill = view
          ? view.querySelectorAll('.directory-columns-column').length
          : 0;
        const innerRow = findRow('inner.txt');
        if (innerRow) {
          innerRow.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
          }));
        }
        await frame();
        // Preview is async — wait for the cache to fill, then repaint.
        await wait(400);
        await frame();
        const preview = view ? view.querySelector('.directory-columns-preview') : null;
        const previewName = preview
          ? preview.querySelector('.directory-columns-preview-name')?.textContent ?? ''
          : '';
        const previewText = preview
          ? preview.querySelector('.directory-columns-preview-text')?.textContent ?? ''
          : '';
        // Column resize: grab the first column's resizer handle and
        // simulate a pointerdown / pointermove / pointerup drag to
        // widen it by 80px. The width should persist on the buffer
        // so a re-paint preserves it.
        const firstCol = view ? view.querySelector('.directory-columns-column') : null;
        const widthBefore = firstCol ? firstCol.getBoundingClientRect().width : 0;
        const resizer = firstCol ? firstCol.querySelector('.directory-columns-resizer') : null;
        if (resizer) {
          const handleRect = resizer.getBoundingClientRect();
          const startX = handleRect.left + handleRect.width / 2;
          const startY = handleRect.top + handleRect.height / 2;
          // PointerEvent constructor is available in renderer.
          resizer.dispatchEvent(new PointerEvent('pointerdown', {
            clientX: startX, clientY: startY, button: 0, pointerId: 7,
            bubbles: true, cancelable: true,
          }));
          resizer.dispatchEvent(new PointerEvent('pointermove', {
            clientX: startX + 80, clientY: startY, pointerId: 7,
            bubbles: true, cancelable: true,
          }));
          resizer.dispatchEvent(new PointerEvent('pointerup', {
            clientX: startX + 80, clientY: startY, pointerId: 7,
            bubbles: true, cancelable: true,
          }));
        }
        await frame();
        const widthAfter = firstCol ? firstCol.getBoundingClientRect().width : 0;
        // Trigger a repaint (drill into the second column again — it's
        // already-expanded, so this just re-paints) and confirm the
        // resized width survives.
        if (subdirRow) {
          // Re-find it because subdirRow may have been detached.
          const sub = view ? Array.from(view.querySelectorAll('.directory-columns-row'))
            .find((r) => r.querySelector('.directory-columns-name').textContent === 'subdir') : null;
          if (sub) sub.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        await frame();
        const firstColAfterRepaint = view ? view.querySelector('.directory-columns-column') : null;
        const widthAfterRepaint = firstColAfterRepaint
          ? firstColAfterRepaint.getBoundingClientRect().width
          : 0;
        // Double-click a file row -> opens it in a new tab. Two
        // rapid clicks on inner.txt; the second click should route
        // through openPath and switch the buffer.
        const tabsBefore = document.querySelectorAll('.tabline-tab').length;
        const innerForDouble = view ? Array.from(view.querySelectorAll('.directory-columns-row'))
          .find((r) => r.querySelector('.directory-columns-name').textContent === 'inner.txt') : null;
        if (innerForDouble) {
          innerForDouble.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        await frame();
        // Re-find after first-click repaint.
        const innerAgain = view ? Array.from(view.querySelectorAll('.directory-columns-row'))
          .find((r) => r.querySelector('.directory-columns-name').textContent === 'inner.txt') : null;
        if (innerAgain) {
          innerAgain.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        await wait(300);
        await frame();
        const tabsAfter = document.querySelectorAll('.tabline-tab').length;
        const modelineAfterOpen = document.getElementById('modeline-name')?.textContent ?? '';
        // Switch back to the columns buffer via the tabline (find its
        // tab by label).
        const colsTab = Array.from(document.querySelectorAll('.tabline-tab'))
          .find((t) => t.querySelector('.tabline-label')?.textContent?.startsWith('*Columns:'));
        if (colsTab) {
          colsTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        await frame();
        // Double-click the same file again — should NOT open a new
        // tab (dedup), and should re-focus the existing one.
        const innerThird = document.querySelector('.directory-columns-row[data-name="inner.txt"]');
        if (innerThird) {
          innerThird.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        await frame();
        const innerFourth = document.querySelector('.directory-columns-row[data-name="inner.txt"]');
        if (innerFourth) {
          innerFourth.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        await wait(300);
        await frame();
        const tabsAfterSecondOpen = document.querySelectorAll('.tabline-tab').length;
        return {
          shown, initialColumns, columnsAfterDrill, previewName, previewText,
          widthBefore: Math.round(widthBefore),
          widthAfter: Math.round(widthAfter),
          widthAfterRepaint: Math.round(widthAfterRepaint),
          tabsBefore, tabsAfter, tabsAfterSecondOpen,
          modelineAfterOpen,
        };
      })()`);
      console.log('  cols:', JSON.stringify(cols));
      await rm(colsDir, { recursive: true, force: true });

      // Shell-buffer arm (v4): open a shell buffer, drive the xterm.js
      // terminal directly through its `__term` handle (the view exposes
      // this when `window.__SMOKE__` is set), type a command, wait for
      // its output to land in the terminal's buffer, then assert the
      // [pty]/[pipe] backing tag is present. After that run a resize
      // sanity check — shrink the term host's width and verify
      // term.cols updates — and finally kill the buffer and confirm
      // cleanup.
      const shell = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        // Turn on the smoke handle BEFORE the shell view mounts so the
        // freshly-constructed Terminal attaches itself to view.__term.
        window.__SMOKE__ = true;
        submit('(shell)');
        await wait(500);
        await frame();
        const view = document.querySelector('shell-view:not([style*="display: none"])');
        const shown = !!(view && getComputedStyle(view).display !== 'none');
        // The xterm.js host appears once the terminal opens; .xterm
        // is the wrapping element xterm.js mounts inside it.
        const termHost = view ? view.querySelector('.shell-term-host') : null;
        const xtermEl = view ? view.querySelector('.shell-term-host .xterm') : null;
        // shell-view-wrapper holds an inner .shell-view div from the
        // factory; the smoke hook attaches __term to that inner div.
        const innerRoot = view ? view.querySelector('.shell-view') : null;
        const term = innerRoot ? innerRoot.__term : null;
        if (!term || !xtermEl) {
          return { shown, mounted: false };
        }
        // Helper: read every visible line from the terminal's active
        // buffer and join it into a single string. We use this to
        // assert the echo command's output arrived.
        const readBuffer = () => {
          const buf = term.buffer.active;
          const lines = [];
          // baseY + cursorY covers everything from the top of
          // scrollback through the cursor row.
          const end = buf.length;
          for (let i = 0; i < end; i += 1) {
            const line = buf.getLine(i);
            if (line) lines.push(line.translateToString(true));
          }
          return lines.join('\\n');
        };
        // Type a command directly into the terminal. \`term.input\`
        // feeds bytes through the onData path — same as a real key.
        // The marker is intentionally not in the command itself so a
        // true match requires the shell's stdout, not just the
        // tty-echoed input line.
        const marker = 'JMACSMARKER42';
        term.focus();
        term.input('echo ' + marker + '\\r');
        let bufferText = '';
        for (let i = 0; i < 80; i += 1) {
          await wait(100);
          bufferText = readBuffer();
          // A successful match needs the marker to appear OUTSIDE the
          // typed echo line — i.e. on a different row. Cheap proxy:
          // count occurrences.
          const matches = bufferText.split(marker).length - 1;
          if (matches >= 2) break;
        }
        const markerMatches = bufferText.split(marker).length - 1;
        // The header should carry the [pty] / [pipe] backing tag.
        const backingEl = view.querySelector('.shell-header-backing');
        const backing = backingEl ? backingEl.textContent : '';
        const colsBefore = term.cols;
        // Resize sanity arm: shrink the host width and re-fit. The
        // FitAddon attached inside the view listens on the host's
        // ResizeObserver, which fires from the style mutation; xterm.js
        // recomputes cols/rows.
        const prevWidth = termHost.style.width;
        termHost.style.width = '40ch';
        // Give the ResizeObserver a tick to fire, then a frame for
        // requestAnimationFrame-deferred fit() to apply.
        await wait(200);
        await frame();
        await wait(200);
        const colsAfter = term.cols;
        // Restore so the kill-buffer arm doesn't see a half-resized
        // grid (cosmetic — the buffer is about to go).
        termHost.style.width = prevWidth;
        const tabsBefore = document.querySelectorAll('.tabline-tab').length;
        // Kill the shell buffer through the same path the keymap uses.
        submit('(kill-view!)');
        await wait(400);
        await frame();
        // Phase 3h: visibility lives on the <shell-view> wrapper.
        const viewAfterKill = document.querySelector('shell-view');
        const stillShown = viewAfterKill && getComputedStyle(viewAfterKill).display !== 'none';
        const tabsAfter = document.querySelectorAll('.tabline-tab').length;
        return {
          shown,
          mounted: true,
          markerMatches,
          bufferText,
          backing,
          colsBefore,
          colsAfter,
          tabsBefore,
          tabsAfter,
          stillShownAfterKill: !!stillShown,
        };
      })()`);
      console.log('  shell:', JSON.stringify(shell));

      // Chord-prefix display: pressing C-x mid-sequence echoes "C-x-"
      // in the minibuffer's echo area; a follow-up unbound key clears
      // it. The echo area is the .minibuffer-echo element, visible
      // only when no prompt is active.
      const chord = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
        editor.focus();
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'x', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        await frame();
        const echoEl = document.querySelector('.minibuffer-echo');
        const echo = echoEl ? echoEl.textContent : '';
        const visible = echoEl ? !echoEl.hidden : false;
        // Press C-g to abort the prefix; the echo clears.
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'g', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        await frame();
        const cleared = echoEl ? echoEl.textContent === '' && echoEl.hidden : true;
        return { echo, visible, cleared };
      })()`);
      console.log('  chord:', JSON.stringify(chord));

      // Find-file completing minibuffer: C-x C-f opens a "Find file: "
      // prompt seeded with $HOME/; typing a leaf name + TAB completes
      // against the filesystem; Enter opens the chosen file. The
      // smoke uses a scratch file under /tmp/ — a stable absolute
      // path on macOS — so the completion result is deterministic
      // (Node's `os.tmpdir()` returns the per-user T/ folder under
      // /var/folders/ on macOS, which is unwieldy for a smoke test).
      const ffPath = '/tmp/jmacs-smoke-find-file.txt';
      await writeFile(ffPath, 'smoke find-file ok');
      const findFile = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
        editor.focus();
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'x', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        await frame();
        const mb = document.querySelector('.minibuffer-input');
        const panel = document.querySelector('.minibuffer');
        const opened = !!mb && !panel.hidden;
        const promptText = document.querySelector('.minibuffer-prompt')
          ?.textContent ?? '';
        const seed = mb ? mb.value : '';
        // Replace the seeded $HOME/ with a known absolute path and
        // drive TAB; the unique prefix completes to the full filename.
        mb.value = '/tmp/jmacs-smoke-find-fi';
        mb.dispatchEvent(new Event('input', { bubbles: true }));
        mb.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab', bubbles: true, cancelable: true,
        }));
        await frame();
        const completed = mb.value;
        // Enter opens the completed path.
        mb.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
        // The open path is async (IPC + read); give it room.
        await wait(400);
        const opened2 = document.getElementById('modeline-name')
          ?.textContent ?? '';
        return { opened, promptText, seed, completed, opened2 };
      })()`);
      console.log('  findFile:', JSON.stringify(findFile));
      await rm(ffPath, { force: true });

      // Multi-pane arm (phase 3a of plans/PANES.md): split the editor
      // area into two panes, assert focus + per-view-point behaviour,
      // cycle focus with `other-pane`, then collapse back to one pane
      // and finally drive a splitter drag programmatically. The arm
      // composes all of commit 4–5's user-visible behaviour.
      const paneA = '/tmp/jmacs-smoke-pane-a.txt';
      const paneB = '/tmp/jmacs-smoke-pane-b.txt';
      await writeFile(paneA, 'pane a — left side\nsecond line a', 'utf8');
      await writeFile(paneB, 'pane b — right side\nsecond line b', 'utf8');
      const panes = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
        const editorHost = document.getElementById('editor-host');
        const countPanes = () =>
          editorHost.querySelectorAll('.pane').length;
        const focusedPaneId = () =>
          editorHost.querySelector('.pane--focused')?.dataset?.paneId ?? null;
        // Land on the first pane-a file so the originating pane has
        // a known, fresh text view.
        submit('(open-file-path! "${paneA}")');
        await wait(300);
        const paneCountBefore = countPanes();
        const focusBefore = focusedPaneId();
        const nameBefore = document.getElementById('modeline-name')
          ?.textContent ?? '';

        // Split horizontally (side-by-side) — bound to C-x 3.
        submit('(split-horizontal!)');
        await wait(250);
        const paneCountAfterSplit = countPanes();
        const focusAfterSplit = focusedPaneId();
        const focusStayed = focusAfterSplit === focusBefore;

        // After split, the right pane was given a duplicate view over
        // the same buffer. Move the *focused* (left) pane's point so
        // we can verify the two cursors are independent.
        submit('(goto! 5)');
        await wait(80);
        submit('(point)');
        await wait(80);
        const leftPointEcho = lastResult();

        // Cycle focus to the other pane (C-x o → other-pane).
        submit('(other-pane!)');
        await wait(200);
        const focusAfterOther = focusedPaneId();
        const cycled = focusAfterOther && focusAfterOther !== focusBefore;
        // The right pane holds the duplicate view; its point is the
        // copied original (0 — we hadn't moved the original cursor
        // before splitting). Read it.
        submit('(point)');
        await wait(80);
        const rightPointEcho = lastResult();

        // Switch the focused (right) pane to the second test file.
        // Auto-duplicate doesn't apply (different file); the view list
        // grows by one and the right pane shows it. The collision rule
        // doesn't fire because no other pane shows that file.
        submit('(open-file-path! "${paneB}")');
        await wait(350);
        const rightNameAfterOpen = document.getElementById('modeline-name')
          ?.textContent ?? '';

        // Cycle back to the left pane and verify its name is still A.
        submit('(other-pane!)');
        await wait(200);
        const leftNameAfterCycle = document.getElementById('modeline-name')
          ?.textContent ?? '';

        // delete-other-panes from the left pane (C-x 1): collapses
        // back to one pane, with the left pane's view as the survivor.
        submit('(delete-other-panes!)');
        await wait(200);
        const paneCountAfterCollapse = countPanes();
        const focusAfterCollapse = focusedPaneId();
        const nameAfterCollapse = document.getElementById('modeline-name')
          ?.textContent ?? '';

        // Splitter drag: split again, grab the handle, drag it, and
        // verify the resulting pane-A rect shrank. This validates the
        // pointer-capture path end-to-end.
        submit('(split-horizontal!)');
        await wait(200);
        const splitter = editorHost.querySelector('.pane-splitter');
        const splitterShown = !!splitter;
        let widthBefore = 0;
        let widthAfter = 0;
        let splitterClass = '';
        if (splitter) {
          const leaves = editorHost.querySelectorAll('.pane');
          widthBefore = leaves[0].getBoundingClientRect().width;
          splitterClass = splitter.className;
          const hostRect = editorHost.getBoundingClientRect();
          // Drag the splitter ~100px to the left.
          const startX = splitter.getBoundingClientRect().left + 2;
          const targetX = startX - 100;
          splitter.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 7, button: 0, clientX: startX, clientY: 100,
            bubbles: true, cancelable: true,
          }));
          window.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 7, clientX: targetX, clientY: 100,
            bubbles: true, cancelable: true,
          }));
          window.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 7, clientX: targetX, clientY: 100,
            bubbles: true, cancelable: true,
          }));
          await wait(80);
          widthAfter = editorHost.querySelectorAll('.pane')[0]
            .getBoundingClientRect().width;
        }

        // Tidy: collapse back so subsequent arms (none in this commit,
        // but good housekeeping) see a single pane.
        submit('(delete-other-panes!)');
        await wait(150);
        const paneCountFinal = countPanes();

        return {
          paneCountBefore,
          focusBefore,
          nameBefore,
          paneCountAfterSplit,
          focusAfterSplit,
          focusStayed,
          leftPointEcho,
          rightPointEcho,
          cycled,
          rightNameAfterOpen,
          leftNameAfterCycle,
          paneCountAfterCollapse,
          focusAfterCollapse,
          nameAfterCollapse,
          splitterShown,
          splitterClass,
          widthBefore,
          widthAfter,
          paneCountFinal,
        };
      })()`);
      console.log('  panes:', JSON.stringify(panes));
      await rm(paneA, { force: true });
      await rm(paneB, { force: true });

      // Tabline-view behaviour (phase 3b commit 7 of plans/PANES-PHASE-3B.md):
      // assert that the root pane's tabline accumulates tabs on
      // open-file, cycles with C-x ←/→, kills with C-x k, and that
      // C-x 3 leaves the left pane's tabline intact while the right
      // pane is a plain leaf. The kill-until-*scratch* path is
      // exercised at the end: drain every open view and verify the
      // root tabline's sole surviving tab is *scratch*.
      const tablineA = join(tmpdir(), 'jmacs-smoke-tabline-A.txt');
      const tablineB = join(tmpdir(), 'jmacs-smoke-tabline-B.txt');
      const tablineC = join(tmpdir(), 'jmacs-smoke-tabline-C.txt');
      const tablineD = join(tmpdir(), 'jmacs-smoke-tabline-D.txt');
      const tablineE = join(tmpdir(), 'jmacs-smoke-tabline-E.txt');
      await writeFile(tablineA, 'tabline-A body\n', 'utf8');
      await writeFile(tablineB, 'tabline-B body\n', 'utf8');
      await writeFile(tablineC, 'tabline-C body\n', 'utf8');
      await writeFile(tablineD, 'tabline-D body\n', 'utf8');
      await writeFile(tablineE, 'tabline-E body\n', 'utf8');
      // Also seed a v2 session JSON the controller-level migration
      // arm uses to verify the persisted-active tab is the one the
      // controller picks. The arm doesn't reload the renderer; it
      // calls `controller.restore()` against the bridge directly.
      const tablineSessionFile1 = join(tmpdir(), 'jmacs-smoke-tabline-sess-1.txt');
      const tablineSessionFile2 = join(tmpdir(), 'jmacs-smoke-tabline-sess-2.txt');
      const tablineSessionFile3 = join(tmpdir(), 'jmacs-smoke-tabline-sess-3.txt');
      await writeFile(tablineSessionFile1, 'sess1\n', 'utf8');
      await writeFile(tablineSessionFile2, 'sess2\n', 'utf8');
      await writeFile(tablineSessionFile3, 'sess3\n', 'utf8');
      const tablineArm = await win.webContents.executeJavaScript(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        const editorHost = document.getElementById('editor-host');
        const modelineName = () =>
          document.getElementById('modeline-name')?.textContent ?? '';
        const allTabsInPane = (paneEl) =>
          Array.from(paneEl.querySelectorAll('.tabline-tab .tabline-label'))
            .map((el) => el.textContent);
        const activeTabInPane = (paneEl) => {
          const el = paneEl.querySelector('.tabline-tab.is-current .tabline-label');
          return el ? el.textContent : '';
        };
        const focusedPaneEl = () =>
          editorHost.querySelector('.pane--focused');

        // --- Phase A: tabs accumulate on open-file inside the root tabline.
        submit('(open-file-path! "${tablineA}")');
        await wait(250);
        submit('(open-file-path! "${tablineB}")');
        await wait(250);
        submit('(open-file-path! "${tablineC}")');
        await wait(250);
        const pane = focusedPaneEl();
        const tabsAfterThreeOpens = allTabsInPane(pane);
        const activeAfterThreeOpens = activeTabInPane(pane);
        const threeTabsPresent =
          tabsAfterThreeOpens.includes('${'jmacs-smoke-tabline-A.txt'}') &&
          tabsAfterThreeOpens.includes('${'jmacs-smoke-tabline-B.txt'}') &&
          tabsAfterThreeOpens.includes('${'jmacs-smoke-tabline-C.txt'}');

        // --- Open a 4th file → new tab added, activated.
        submit('(open-file-path! "${tablineD}")');
        await wait(250);
        const tabsAfterFourOpens = allTabsInPane(pane);
        const activeAfterFourOpens = activeTabInPane(pane);

        // Per-tab text-views: with four text tabs now open, each one's
        // <text-view> wrapper should carry its own data-file-path (the
        // per-view-instance architecture). A single shared/repointed
        // element would collapse this to one. We capture this now,
        // before the subsequent kill/split steps tear most tabs down.
        const distinctTextViewPathsAfterFour = (() => {
          const paths = new Set();
          for (const tv of document.querySelectorAll('text-view')) {
            const p = tv.getAttribute('data-file-path');
            if (p) paths.add(p);
          }
          return paths.size;
        })();

        // --- C-x ← cycles to the previous tab; C-x → returns.
        const editor = document.querySelector('text-view:not([style*="display: none"]) .editor');
        editor.focus();
        const chord = (key) => {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'x', ctrlKey: true, bubbles: true, cancelable: true,
          }));
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key, bubbles: true, cancelable: true,
          }));
        };
        chord('ArrowLeft');
        await frame();
        await wait(60);
        const activeAfterArrowLeft = activeTabInPane(pane);
        chord('ArrowRight');
        await frame();
        await wait(60);
        const activeAfterArrowRight = activeTabInPane(pane);

        // --- C-x k kills the active tab; previous tab becomes active.
        chord('k');
        await wait(120);
        const tabsAfterKill = allTabsInPane(pane);
        const activeAfterKill = activeTabInPane(pane);

        // --- Phase B: split horizontally; left keeps tabline, right is plain leaf.
        submit('(split-horizontal!)');
        await wait(250);
        const paneCountAfterSplit = editorHost.querySelectorAll('.pane').length;
        const leaves = editorHost.querySelectorAll('.pane');
        // After split, the originating (left) pane is index 0; the
        // newly-created right pane is index 1. Left keeps its tabline-
        // pane container; the right pane should NOT carry a tabline-
        // pane container (the duplicate-of-active is a plain leaf
        // view, per the brief's commit-5 split-leaves rule).
        const leftHasTabline = leaves[0].querySelector('tabline-view') !== null;
        const rightHasTabline = leaves[1].querySelector('tabline-view') !== null;

        // Focus the right pane (other-pane!) and open a file. The
        // right pane is a plain leaf; opening a file should swap the
        // leaf's view to the new file (no new tabline strip).
        submit('(other-pane!)');
        await wait(120);
        submit('(open-file-path! "${tablineE}")');
        await wait(250);
        const rightLeafAfterOpen = leaves[1];
        const rightHasTablineAfterOpen =
          rightLeafAfterOpen.querySelector('tabline-view') !== null;
        const rightModelineAfterOpen = modelineName();

        // --- Phase C: kill-until-scratch on the root tabline.
        // First, collapse back to a single pane (the left pane / the
        // root tabline). Then run a tight kill-view! loop until the
        // root tabline's only surviving tab is *scratch*.
        submit('(other-pane!)');           // back to left pane
        await wait(120);
        submit('(delete-other-panes!)');   // collapse to root tabline
        await wait(200);
        const paneCountAfterCollapse = editorHost.querySelectorAll('.pane').length;
        // Kill aggressively. The kill-view! command drops the current
        // tab; the previous tab becomes active. We bound the loop
        // generously — the smoke has accumulated 60–70 views by now.
        for (let i = 0; i < 200; i += 1) {
          // Stop once the only view is *scratch* (the Q6 fallback).
          const labels = allTabsInPane(focusedPaneEl());
          if (labels.length === 1 && labels[0].includes('*scratch*')) break;
          submit('(kill-view!)');
          // Yielding a microtask is enough — kill-view! is synchronous.
          if (i % 5 === 0) await wait(20);
        }
        await wait(200);
        const finalTabs = allTabsInPane(focusedPaneEl());
        const finalActive = activeTabInPane(focusedPaneEl());

        // --- Phase D: controller-level v2-session restore (no reload).
        // Write a v2 session blob with three files + a specific active
        // index, then drive controller.restore against the bridge with
        // captured callbacks. Asserts the migration / restore loop
        // builds a single-leaf root with a tabline-view whose tabs are
        // the three persisted paths and whose active-index matches.
        await window.host.writeSession({
          version: 2,
          rootPane: {
            kind: 'leaf', id: 'pane-leaf-sess',
            view: {
              kind: 'tabline', edge: 'top', active: 1,
              tabs: [
                { kind: 'text', path: ${JSON.stringify(tablineSessionFile1)}, point: 0, mark: null },
                { kind: 'text', path: ${JSON.stringify(tablineSessionFile2)}, point: 2, mark: null },
                { kind: 'text', path: ${JSON.stringify(tablineSessionFile3)}, point: 0, mark: null },
              ],
            },
          },
          currentPaneId: 'pane-leaf-sess',
        });
        const sessionMod = await import('app://editor/apps/desktop/src/session.js');
        let restoredRoot = null;
        let restoredCurrent = null;
        const restoreCalls = [];
        const ctrl = sessionMod.createSession({
          getRootPane: () => ({ kind: 'leaf', id: 'pane-leaf-test', view: null }),
          getCurrentPaneId: () => 'pane-leaf-test',
          openByPath: async (path, entry) => {
            const result = await window.host.openFilePath(path);
            if (result === null) return null;
            restoreCalls.push(path);
            return {
              kind: 'text', name: result.name, content: result.content,
              point: entry.point, mark: entry.mark,
              buffer: { filePath: result.path },
            };
          },
          installRootPane: (root, paneId) => {
            restoredRoot = root;
            restoredCurrent = paneId;
          },
          host: window.host,
        });
        await ctrl.restore();
        // installRootPane receives the serialised root blob (the
        // controller hands the blob + handlesByBlob to the caller so
        // it can build the runtime tree). So restoredRoot.view.tabs
        // here is the array of serialised text-view blobs — each
        // carrying \`path\` directly, not a buffer wrapper.
        const restoredTabs = restoredRoot && restoredRoot.view
          && restoredRoot.view.kind === 'tabline'
          ? restoredRoot.view.tabs.map((t) => (t.path ?? ''))
          : [];
        const restoredActive = restoredRoot && restoredRoot.view
          ? restoredRoot.view.active : -1;
        const restoredCurrentBuffer = restoredRoot && restoredRoot.view
          && restoredRoot.view.kind === 'tabline'
          ? (restoredRoot.view.tabs[restoredRoot.view.active]?.path ?? '')
          : '';

        // Carried forward from the earlier four-files snapshot.
        const distinctTextViewPaths = distinctTextViewPathsAfterFour;

        return {
          tabsAfterThreeOpens,
          threeTabsPresent,
          activeAfterThreeOpens,
          tabsAfterFourOpens,
          activeAfterFourOpens,
          activeAfterArrowLeft,
          activeAfterArrowRight,
          tabsAfterKill,
          activeAfterKill,
          paneCountAfterSplit,
          leftHasTabline,
          rightHasTabline,
          rightHasTablineAfterOpen,
          rightModelineAfterOpen,
          paneCountAfterCollapse,
          finalTabs,
          finalActive,
          distinctTextViewPaths,
          restoredTabs,
          restoredActive,
          restoredCurrent,
          restoredCurrentBuffer,
          restoreCalls,
        };
      })()`);
      console.log('  tablineArm:', JSON.stringify({
        threeTabsPresent: tablineArm.threeTabsPresent,
        activeAfterThreeOpens: tablineArm.activeAfterThreeOpens,
        activeAfterFourOpens: tablineArm.activeAfterFourOpens,
        activeAfterArrowLeft: tablineArm.activeAfterArrowLeft,
        activeAfterArrowRight: tablineArm.activeAfterArrowRight,
        activeAfterKill: tablineArm.activeAfterKill,
        paneCountAfterSplit: tablineArm.paneCountAfterSplit,
        leftHasTabline: tablineArm.leftHasTabline,
        rightHasTabline: tablineArm.rightHasTabline,
        rightHasTablineAfterOpen: tablineArm.rightHasTablineAfterOpen,
        rightModelineAfterOpen: tablineArm.rightModelineAfterOpen,
        paneCountAfterCollapse: tablineArm.paneCountAfterCollapse,
        finalTabs: tablineArm.finalTabs,
        finalActive: tablineArm.finalActive,
        distinctTextViewPaths: tablineArm.distinctTextViewPaths,
        restoredTabs: tablineArm.restoredTabs,
        restoredActive: tablineArm.restoredActive,
        restoredCurrent: tablineArm.restoredCurrent,
        restoredCurrentBuffer: tablineArm.restoredCurrentBuffer,
      }));
      await rm(tablineA, { force: true });
      await rm(tablineB, { force: true });
      await rm(tablineC, { force: true });
      await rm(tablineD, { force: true });
      await rm(tablineE, { force: true });
      await rm(tablineSessionFile1, { force: true });
      await rm(tablineSessionFile2, { force: true });
      await rm(tablineSessionFile3, { force: true });

      // Add-pane arm: covers two related features.
      //
      // 1. C-u direction flip on C-x 2 / C-x 3. Calling
      //    `(split-horizontal! 0.5 'before)` should put the *new* pane
      //    on the left (rect.left === 0) and leave focus on the
      //    originating pane, now on the right.
      // 2. The add-pane overlay (C-x +). Entering the mode mounts
      //    `.add-pane-overlay` with one target per outer border (4)
      //    plus one per splitter. Clicking the bottom-border target
      //    inserts a new pane spanning full width at the bottom; it
      //    becomes focused. Clicking a splitter target after a split
      //    inserts a third pane in the gap.
      //
      // Runs last because it leaves the editor with a non-pristine
      // view list (each split spawns a duplicate text view, the cleanup
      // collapses panes but doesn't reclaim the views).
      const addPaneArm = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        const editorHost = document.getElementById('editor-host');
        const countPanes = () =>
          editorHost.querySelectorAll('.pane').length;
        const focusedPaneId = () =>
          editorHost.querySelector('.pane--focused')?.dataset?.paneId ?? null;
        const focusedRect = () => {
          const el = editorHost.querySelector('.pane--focused');
          return el ? el.getBoundingClientRect() : null;
        };

        // Make sure we start from a single pane.
        submit('(delete-other-panes!)');
        await wait(150);

        // --- (1) C-u flip on split-horizontal -----------------------
        const focusStart = focusedPaneId();
        submit("(split-horizontal! 0.5 'before)");
        await wait(200);
        const flipHCount = countPanes();
        const flipHFocus = focusedPaneId();
        const flipHFocusedRect = focusedRect();
        // The originating leaf kept focus; with side='before the new
        // leaf is *first* (left), so the focused (originating) pane
        // sits at rect.left > 0.
        const flipHFocusOnRight = !!(flipHFocusedRect && flipHFocusedRect.left > 0);
        submit('(delete-other-panes!)');
        await wait(150);

        // --- (1b) C-u flip on split-vertical ------------------------
        submit("(split-vertical! 0.5 'before)");
        await wait(200);
        const flipVCount = countPanes();
        const flipVFocusedRect = focusedRect();
        // side='before puts the new leaf on top; focused (originating)
        // pane sits at rect.top > 0.
        const flipVFocusOnBottom = !!(flipVFocusedRect && flipVFocusedRect.top > 0);
        submit('(delete-other-panes!)');
        await wait(150);

        // --- (2) Add-pane mode: open overlay ------------------------
        submit('(enter-add-pane-mode!)');
        await wait(120);
        const overlay = editorHost.querySelector('.add-pane-overlay');
        const overlayShown = !!overlay;
        const borderTargets = overlay
          ? overlay.querySelectorAll('.add-pane-target--border').length
          : 0;
        const splitterTargetsInitial = overlay
          ? overlay.querySelectorAll('.add-pane-target--splitter').length
          : 0;

        // Click the bottom-border target.
        let afterBorderClickCount = 0;
        let bottomPaneSpansFullWidth = false;
        let bottomPaneIsFocused = false;
        if (overlay) {
          const bottom = overlay.querySelector('.add-pane-target--bottom');
          if (bottom) {
            const r = bottom.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            bottom.dispatchEvent(new MouseEvent('click', {
              clientX: cx, clientY: cy, bubbles: true, cancelable: true,
            }));
          }
        }
        await wait(200);
        afterBorderClickCount = countPanes();
        // After insertAtRootBorder('bottom', ...) the new leaf is the
        // second child of a vertical split — it sits at the bottom and
        // takes the full editor-host width.
        const focusedAfter = editorHost.querySelector('.pane--focused');
        if (focusedAfter) {
          const fr = focusedAfter.getBoundingClientRect();
          const hostRect = editorHost.getBoundingClientRect();
          bottomPaneSpansFullWidth = Math.abs(fr.width - hostRect.width) < 4;
          bottomPaneIsFocused = fr.top > hostRect.top + hostRect.height / 2;
        }

        // --- (3) Add-pane mode: click a splitter target -------------
        // We now have a vertical split (top region + bottom new pane).
        // Re-enter add-pane mode; the one splitter should appear as a
        // target. Clicking it should insert a third pane "in the gap".
        submit('(enter-add-pane-mode!)');
        await wait(120);
        const overlay2 = editorHost.querySelector('.add-pane-overlay');
        const splitterTargetsWithSplit = overlay2
          ? overlay2.querySelectorAll('.add-pane-target--splitter').length
          : 0;
        if (overlay2) {
          const sp = overlay2.querySelector('.add-pane-target--splitter');
          if (sp) {
            const r = sp.getBoundingClientRect();
            sp.dispatchEvent(new MouseEvent('click', {
              clientX: r.left + r.width / 2,
              clientY: r.top + r.height / 2,
              bubbles: true, cancelable: true,
            }));
          }
        }
        await wait(200);
        const afterSplitterClickCount = countPanes();

        // --- (4) Escape cancels --------------------------------------
        submit('(enter-add-pane-mode!)');
        await wait(120);
        const overlay3 = editorHost.querySelector('.add-pane-overlay');
        const overlay3Shown = !!overlay3;
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true,
        }));
        await wait(120);
        const overlay3GoneAfterEscape =
          !editorHost.querySelector('.add-pane-overlay');
        const countAfterEscape = countPanes();

        // Tidy.
        submit('(delete-other-panes!)');
        await wait(150);
        const finalPaneCount = countPanes();

        return {
          focusStart,
          flipHCount,
          flipHFocus,
          flipHFocusOnRight,
          flipVCount,
          flipVFocusOnBottom,
          overlayShown,
          borderTargets,
          splitterTargetsInitial,
          afterBorderClickCount,
          bottomPaneSpansFullWidth,
          bottomPaneIsFocused,
          splitterTargetsWithSplit,
          afterSplitterClickCount,
          overlay3Shown,
          overlay3GoneAfterEscape,
          countAfterEscape,
          finalPaneCount,
        };
      })()`);
      console.log('  addPaneArm:', JSON.stringify(addPaneArm));

      // Bug-2 arm: a file opened in two separate tablines should land
      // as two independent View objects sharing the same buffer; closing
      // one tab should leave the other alive — Q9 auto-duplicate's job.
      const bug2File = join(tmpdir(), 'jmacs-bug2-shared.txt');
      await writeFile(bug2File, 'shared content\\n', 'utf8');
      const bug2 = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        const editorHost = document.getElementById('editor-host');
        const tabsForFile = () => {
          // Count tabline-tab elements whose label matches the file's
          // basename, across every visible tabline strip in the panes.
          const basename = '${bug2File}'.split('/').pop();
          const labels = editorHost.querySelectorAll(
            '.tabline-strip .tabline-tab .tabline-label'
          );
          return Array.from(labels).filter((el) => el.textContent === basename).length;
        };
        const panesWithFile = () => {
          const basename = '${bug2File}'.split('/').pop();
          return Array.from(editorHost.querySelectorAll('.pane'))
            .map((paneEl) =>
              Array.from(paneEl.querySelectorAll(
                '.tabline-strip .tabline-tab .tabline-label'
              )).some((el) => el.textContent === basename)
            );
        };

        submit('(delete-other-panes!)');
        await wait(150);
        submit('(promote-to-tabline!)');
        await wait(120);

        // Open shared file in pane A.
        submit('(open-file-path! "${bug2File}")');
        await wait(300);

        // Split horizontally; right pane becomes B.
        submit('(split-horizontal!)');
        await wait(250);
        submit('(other-pane!)');
        await wait(150);
        submit('(promote-to-tabline!)');
        await wait(150);

        // Open the same file in pane B — auto-dup should fire.
        submit('(open-file-path! "${bug2File}")');
        await wait(400);

        const tabsBeforeKill = tabsForFile();
        const panesBeforeKill = panesWithFile();

        // The focused pane is B. The × button on a tab triggers
        // killViewAtIndex (not just remove-tab), so use kill-view! to
        // mirror that behaviour for the active view in pane B.
        submit('(kill-view!)');
        await wait(400);

        const tabsAfterKill = tabsForFile();
        const panesAfterKill = panesWithFile();

        // Tidy.
        submit('(delete-other-panes!)');
        await wait(150);
        return {
          tabsBeforeKill,
          panesBeforeKill,
          tabsAfterKill,
          panesAfterKill,
        };
      })()`);
      console.log('  bug2:', JSON.stringify(bug2));
      await rm(bug2File, { force: true });

      // Bug-3 arm: when the user clicks a non-text tab (e.g. video) in
      // a non-focused pane's tabline, the focused leaf-pane's text-view
      // should stay visible. Hypothesis: the legacy
      // `hideInactiveRendererViews(child.kind)` call in
      // mountTablineActiveChild's non-text branch is misbehaving for
      // cross-pane activations.
      const bug3TextA = join(tmpdir(), 'jmacs-bug3-A.txt');
      const bug3VideoPath = join(tmpdir(), 'jmacs-bug3.mp4');
      await writeFile(bug3TextA, 'pane A text content\\n', 'utf8');
      // Reuse the media-arm's video file shape — minimal MP4 isn't
      // really needed since the test only checks visibility, not playback.
      await writeFile(bug3VideoPath, 'placeholder\\n', 'utf8');
      const bug3 = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const replInput = document.querySelector('.repl-input');
        const submit = (src) => {
          replInput.value = src;
          replInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
          }));
        };
        const editorHost = document.getElementById('editor-host');
        const focusedPaneId = () =>
          editorHost.querySelector('.pane--focused')?.dataset?.paneId ?? null;
        const paneSummary = () =>
          Array.from(editorHost.querySelectorAll('.pane')).map((paneEl) => {
            const directTextView = paneEl.querySelector(':scope > text-view');
            const tabline = paneEl.querySelector(':scope > tabline-view');
            return {
              id: paneEl.dataset.paneId,
              focused: paneEl.classList.contains('pane--focused'),
              hasDirectTextView: !!directTextView,
              directTextViewVisible: directTextView
                ? getComputedStyle(directTextView).display !== 'none'
                : null,
              directTextViewInlineDisplay: directTextView
                ? directTextView.style.display
                : null,
              hasTabline: !!tabline,
              activeTabName: tabline?.querySelector('.tabline-strip .tabline-tab.is-current .tabline-label')?.textContent ?? null,
            };
          });

        submit('(delete-other-panes!)');
        await wait(150);
        submit('(promote-to-tabline!)');
        await wait(120);

        // Open the markdown in the root tabline — this becomes pane A.
        submit('(open-file-path! "${bug3TextA}")');
        await wait(300);
        // Demote so pane A is a leaf-direct text view (matches user's
        // scenario where the middle pane is a leaf, not a tabline).
        submit('(demote-tabline!)');
        await wait(200);

        // Split horizontally to make pane B on the right.
        submit('(split-horizontal!)');
        await wait(250);
        submit('(other-pane!)');
        await wait(150);
        submit('(promote-to-tabline!)');
        await wait(150);

        // Open the video file in pane B's tabline.
        submit('(open-file-path! "${bug3VideoPath}")');
        await wait(400);

        // Snapshot before clicking.
        const before = paneSummary();
        const focusedBefore = focusedPaneId();

        // Cycle focus back to pane A (the leaf with text-view).
        submit('(other-pane!)');
        await wait(200);
        const focusedAfterCycle = focusedPaneId();

        // Now simulate clicking the video tab in pane B's tabline.
        // Real clicks fire mousedown → click; tabline's onSelect is on
        // mousedown, so we need to dispatch that explicitly.
        const paneB = editorHost.querySelector('.pane[data-pane-id="' +
          (focusedAfterCycle === before[0].id ? before[1]?.id : before[0]?.id) + '"]');
        const videoTab = Array.from(paneB?.querySelectorAll('.tabline-strip .tabline-tab') ?? [])
          .find((t) => {
            const name = t.querySelector('.tabline-label')?.textContent ?? '';
            return name.endsWith('.mp4');
          });
        if (videoTab) {
          const r = videoTab.getBoundingClientRect();
          videoTab.dispatchEvent(new MouseEvent('mousedown', {
            button: 0,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            bubbles: true, cancelable: true,
          }));
        }
        await wait(300);

        const after = paneSummary();
        const focusedAfterClick = focusedPaneId();

        // Tidy.
        submit('(delete-other-panes!)');
        await wait(150);

        return {
          before,
          focusedBefore,
          focusedAfterCycle,
          videoTabFound: !!videoTab,
          after,
          focusedAfterClick,
        };
      })()`);
      console.log('  bug3:', JSON.stringify(bug3));
      await rm(bug3TextA, { force: true });
      await rm(bug3VideoPath, { force: true });

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
        treesitter.langs.includes('latex') &&
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
        treesitter.mdHeadings > 0 && treesitter.mdInjectsJs > 0 &&
        treesitter.texFunctions > 0 && treesitter.texTypes > 0 &&
        treesitter.texStrings > 0 && treesitter.texTags > 0;
      const faceInfoOk =
        faceInfo.modeline.includes('*Doc: Face at point*') &&
        faceInfo.mentionsKeyword &&
        faceInfo.mentionsTokKeyword;
      const replaceOk = replace.text === 'bar bar bar';
      const regexReplaceOk =
        regexReplace.regexText === '123-foo 45-bar 6-baz' &&
        regexReplace.queryText === 'xxx foo foo';
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
      const facesOk =
        faces.changed &&
        faces.restored &&
        faces.customizeShown &&
        faces.faceRows >= 13 &&
        faces.inheritsParentOverride;
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
      // Buffer menu arm: header present, both seeded buffers listed,
      // *Buffer List* lists itself, and `d` then `x` removes the
      // marked buffer.
      const bufferMenuOk =
        bufferMenu.listsTarget &&
        bufferMenu.listsKeep &&
        bufferMenu.listsSelf &&
        bufferMenu.rowCount >= 4 &&
        bufferMenu.targetGone &&
        bufferMenu.keepStill;
      const jukeboxOk =
        jukebox.name.includes('Jukebox:') &&
        jukebox.visible &&
        jukebox.hasAudio &&
        jukebox.hasArt &&
        // The tagged MP3 (TIT2/TPE1/TALB = Test/A/B) is rendered
        // through the default *jukebox-track-format* — the row text
        // is the formatted label rather than the filename.
        jukebox.tracks.includes('"Test", A, B') &&
        // The untagged FLAC falls back to its bare filename.
        jukebox.tracks.includes('second.flac') &&
        !jukebox.tracks.includes('readme.txt') &&
        // Clicking a track row points the audio element at one of them.
        // The directory-listing order is filesystem-dependent, so check
        // for either of the seeded files rather than assuming an order.
        (jukebox.audioSrc.includes('aaa-silence.mp3') ||
          jukebox.audioSrc.includes('second.flac')) &&
        jukebox.shuffleBefore.includes('off') &&
        jukebox.shuffleAfter.includes('on') &&
        // C-x k from the focused jukebox view kills the buffer and
        // takes the user back to a different (non-jukebox) buffer.
        !jukebox.jukeboxStillVisible &&
        !jukebox.afterKillName.includes('Jukebox:') &&
        // Embedded album art extracted from aaa-silence.mp3's ID3 tag
        // ends up on the <img> as a data: URL — the parser, the IPC
        // handler, and the view all wired through.
        jukebox.embeddedArtShown;
      // Splitter arm: both splitters are visible when their pane is
      // visible; dragging updates the CSS variable; and the new size
      // is persisted through panes.json. Sizes are within 2px of the
      // requested target — a one-pixel rounding wobble is fine.
      const previewWidth = parseFloat(splitters.previewAfter);
      const replHeight = parseFloat(splitters.replAfter);
      const splittersOk =
        splitters.previewShown &&
        splitters.replShown &&
        splitters.previewBefore !== splitters.previewAfter &&
        splitters.replBefore !== splitters.replAfter &&
        Math.abs(previewWidth - 280) < 3 &&
        Math.abs(replHeight - 180) < 3 &&
        splitters.stored &&
        Math.abs((splitters.stored.previewWidth ?? 0) - previewWidth) < 3 &&
        Math.abs((splitters.stored.replHeight ?? 0) - replHeight) < 3;
      // Media views arm: the audio view mounts with the embedded
      // tag's title/artist/album reaching the title block and the
      // metadata list, the album art ends up as a data: URL on the
      // <img>, the <audio> element streams from a media:// URL, and
      // `q` dismisses the buffer; the video view mounts with the
      // filename in the caption, a media:// src on the <video>, and
      // `q` dismisses too.
      const mediaViewsOk =
        mediaViews.audioShown &&
        mediaViews.audioName.includes('jmacs-smoke-media-audio.mp3') &&
        mediaViews.hasAudioEl &&
        mediaViews.audioSrc.startsWith('media://') &&
        mediaViews.titleText === 'Smoke Song' &&
        mediaViews.subtitleText.includes('Smoke Artist') &&
        mediaViews.subtitleText.includes('Smoke Album') &&
        mediaViews.metaText.some((t) => t === 'Smoke Artist') &&
        mediaViews.metaText.some((t) => t === 'Smoke Album') &&
        mediaViews.albumArtSrc.startsWith('data:image/') &&
        !mediaViews.audioStillVisible &&
        !mediaViews.afterAudioKill.includes('jmacs-smoke-media-audio') &&
        mediaViews.videoShown &&
        mediaViews.videoName.includes('jmacs-smoke-media-video.mp4') &&
        mediaViews.hasVideoEl &&
        mediaViews.videoSrc.startsWith('media://') &&
        mediaViews.captionName.includes('jmacs-smoke-media-video.mp4') &&
        !mediaViews.videoStillVisible &&
        !mediaViews.afterVideoKill.includes('jmacs-smoke-media-video');
      // Tabline + session round-trip: the tabline shows the open
      // buffers including the scratch file, the current tab is the
      // scratch file's basename, the session write is read back
      // intact, and the restore loop re-opens the file with the
      // content + cursor we asked for.
      const tablineOk =
        tabline.tabCount >= 3 &&
        tabline.currentLabel.includes('jmacs-smoke-tabline.txt') &&
        tabline.written &&
        tabline.written.currentPath === tabPath &&
        tabline.written.buffers.length === 1 &&
        tabline.restoredCount === 1 &&
        tabline.restoredPath === tabPath &&
        tabline.restoredContent.includes('tab smoke content') &&
        tabline.restoredPoint === 5 &&
        // v1 → v2 migration: a flat buffer list becomes a single root
        // leaf holding a top-edge tabline-view with one tab (the
        // restored file). currentPaneId follows the v1-migration leaf id.
        tabline.installedRootKind === 'leaf' &&
        tabline.installedRootViewKind === 'tabline' &&
        tabline.installedTabsCount === 1 &&
        tabline.installedCurrent === 'pane-leaf-restored';
      // Language pack arm: every one of the 22 languages added by
      // agent-language-pack registers a highlighter, and each one's
      // sample buffer produces face spans for at least one
      // expected class. The wasms for clojure, graphql, xml and zig
      // were rebuilt (regenerated parser.c + emscripten wasm) so
      // they speak the current runtime ABI; the queries for cpp,
      // lua, ruby, sql, swift, graphql, xml, zig were patched
      // against the bundled grammars' actual node sets — see the
      // per-file comments.
      const expectedLangs = [
        'c', 'cpp', 'java', 'csharp', 'ruby', 'lua', 'yaml', 'toml',
        'haskell', 'ocaml', 'elixir', 'clojure', 'scheme', 'erlang',
        'sql', 'dockerfile', 'nix', 'xml', 'graphql', 'kotlin',
        'swift', 'zig',
      ];
      const langPackOk =
        langPack &&
        expectedLangs.every((tag) => langPack.langs.includes(tag));
      // Directory tree-view arm: the view mounts, the seeded folder
      // expands on click (showing one more row), and clicking a file
      // routes to the text buffer with the file's name in the modeline.
      const treeOk =
        tree &&
        tree.shown &&
        tree.rowsBefore === 3 &&
        tree.rowsAfterExpand === 4 &&
        tree.chevronOpen === true &&
        tree.jsIconClass.includes('fa-file-code') &&
        tree.noteIconClass.includes('fa-file-lines') &&
        tree.beforeOpenBuffer !== tree.afterOpenBuffer &&
        tree.afterOpenBuffer.includes('note.txt');
      // Directory columns-view arm: the view mounts; the first
      // column lists the seeded files (1 folder, 1 file); drilling
      // into the folder spawns a second column; clicking a file in
      // that column fills the preview pane with its name and body.
      const colsOk =
        cols &&
        cols.shown &&
        cols.initialColumns === 1 &&
        cols.columnsAfterDrill === 2 &&
        cols.previewName === 'inner.txt' &&
        cols.previewText.includes('hello columns') &&
        // Column resize: drag widened by ~80px, and that width
        // survives the next repaint. (3px slop for the rounding
        // wobble at the boundary.)
        Math.abs(cols.widthAfter - cols.widthBefore - 80) < 3 &&
        Math.abs(cols.widthAfterRepaint - cols.widthAfter) < 3 &&
        // Double-click adds exactly one tab and switches to it.
        cols.tabsAfter === cols.tabsBefore + 1 &&
        cols.modelineAfterOpen.includes('inner.txt') &&
        // Double-clicking the same file again de-dups: no extra tab.
        cols.tabsAfterSecondOpen === cols.tabsAfter;
      // Shell-buffer arm (v4): the view mounts an xterm.js terminal,
      // the echo command's output reaches the terminal's buffer
      // (twice: once as the tty echo of the typed command line, once
      // as the shell's actual stdout — markerMatches >= 2), the
      // [pty]/[pipe] backing tag is present, the FitAddon recomputes
      // cols when the host shrinks, and killing the buffer removes
      // the tab + unmounts the view.
      const shellOk =
        shell &&
        shell.shown &&
        shell.mounted &&
        shell.markerMatches >= 2 &&
        // Backing tag: [pty] on macOS dev machines where python3 is
        // available (the smoke runs on dev hardware). [pipe] is the
        // legitimate fallback if the python probe failed.
        (shell.backing === '[pty]' || shell.backing === '[pipe]') &&
        // Resize: shrinking the host's width below the original grid
        // must reduce term.cols. (40ch is much narrower than xterm.js's
        // default 80 columns.)
        shell.colsAfter > 0 &&
        shell.colsAfter < shell.colsBefore &&
        shell.tabsAfter === shell.tabsBefore - 1 &&
        !shell.stillShownAfterKill;
      const chordOk =
        chord.echo === 'C-x-' && chord.visible && chord.cleared;
      const findFileOk =
        findFile.opened &&
        findFile.promptText === 'Find file: ' &&
        findFile.seed.endsWith('/') &&
        findFile.completed === '/tmp/jmacs-smoke-find-file.txt' &&
        findFile.opened2.includes('jmacs-smoke-find-file.txt');
      // Multi-pane arm: splits land, focus stays on the originating
      // (left) pane, the right pane gets a duplicate view; other-pane
      // cycles focus; opening a different file in the right pane
      // moves only that pane; delete-other-panes collapses back to
      // one pane on the original; the splitter handle drags.
      const panesOk =
        panes.paneCountBefore === 1 &&
        panes.paneCountAfterSplit === 2 &&
        panes.focusStayed === true &&
        // Per-view-point: the left pane's point is 5 (we set it); the
        // right pane (duplicate view over the same buffer) has its own
        // point that wasn't touched by the set on the left.
        panes.leftPointEcho === '5' &&
        panes.rightPointEcho !== panes.leftPointEcho &&
        panes.cycled === true &&
        panes.rightNameAfterOpen.includes('jmacs-smoke-pane-b.txt') &&
        panes.leftNameAfterCycle.includes('jmacs-smoke-pane-a.txt') &&
        panes.paneCountAfterCollapse === 1 &&
        panes.focusAfterCollapse === panes.focusBefore &&
        panes.nameAfterCollapse.includes('jmacs-smoke-pane-a.txt') &&
        panes.splitterShown === true &&
        panes.splitterClass.includes('pane-splitter--horizontal') &&
        panes.widthBefore > 0 &&
        panes.widthAfter > 0 &&
        Math.abs(panes.widthBefore - panes.widthAfter) > 50 &&
        panes.paneCountFinal === 1;

      // Add-pane arm: C-u flip + the visual add-pane overlay.
      // - `(split-horizontal! 0.5 'before)` puts the new pane on the
      //   left; the originating (focused) pane sits at x > 0.
      // - `(split-vertical! 0.5 'before)` puts it above; focused sits
      //   at y > 0.
      // - `(enter-add-pane-mode!)` shows .add-pane-overlay with
      //   exactly four border targets and zero splitter targets in
      //   the single-pane case.
      // - Clicking the bottom-border target inserts a pane spanning
      //   full width at the bottom; it becomes focused.
      // - After that split, re-entering the mode shows one splitter
      //   target; clicking it grows the count from 2 to 3.
      // - Escape closes the overlay without inserting.
      const addPaneOk =
        addPaneArm.flipHCount === 2 &&
        addPaneArm.flipHFocusOnRight === true &&
        addPaneArm.flipVCount === 2 &&
        addPaneArm.flipVFocusOnBottom === true &&
        addPaneArm.overlayShown === true &&
        addPaneArm.borderTargets === 4 &&
        addPaneArm.splitterTargetsInitial === 0 &&
        addPaneArm.afterBorderClickCount === 2 &&
        addPaneArm.bottomPaneSpansFullWidth === true &&
        addPaneArm.bottomPaneIsFocused === true &&
        addPaneArm.splitterTargetsWithSplit === 1 &&
        addPaneArm.afterSplitterClickCount === 3 &&
        addPaneArm.overlay3Shown === true &&
        addPaneArm.overlay3GoneAfterEscape === true &&
        addPaneArm.countAfterEscape === addPaneArm.afterSplitterClickCount &&
        addPaneArm.finalPaneCount === 1;

      // Bug-2: closing a tab in pane B (the duplicate) does NOT remove
      // the original from pane A. Q9 auto-duplicate has done its job.
      const bug2Ok =
        bug2.tabsBeforeKill === 2 &&
        bug2.panesBeforeKill.length === 2 &&
        bug2.panesBeforeKill[0] === true && bug2.panesBeforeKill[1] === true &&
        bug2.tabsAfterKill === 1 &&
        bug2.panesAfterKill.length === 1 &&
        bug2.panesAfterKill[0] === true;

      // Bug-3: clicking a non-text tab in a non-focused pane's tabline
      // should (a) move focus to that pane and (b) leave the previously
      // focused pane's leaf-direct text-view visible.
      const bug3Ok =
        bug3.videoTabFound === true &&
        bug3.focusedAfterCycle !== bug3.focusedAfterClick &&
        bug3.after[0].directTextViewVisible === true &&
        bug3.after[0].directTextViewInlineDisplay === '';

      // Tabline arm (phase 3b commit 7): opening files appends tabs to
      // the root tabline; C-x ←/→ cycle; C-x k kills and falls back;
      // C-x 3 split leaves the left tabline intact and the right pane
      // plain; an open-file in the right pane swaps its leaf view
      // (no new strip); the kill-until-*scratch* path lands on a
      // single-tab tabline whose tab is *scratch*. The controller-
      // level v2-session restore reproduces the persisted tab list
      // and `active` index through the openByPath / installRootPane
      // callbacks.
      const tablineArmOk =
        tablineArm.threeTabsPresent &&
        tablineArm.activeAfterThreeOpens.includes('jmacs-smoke-tabline-C.txt') &&
        tablineArm.tabsAfterFourOpens.length === tablineArm.tabsAfterThreeOpens.length + 1 &&
        tablineArm.activeAfterFourOpens.includes('jmacs-smoke-tabline-D.txt') &&
        // C-x ← moves off D; C-x → returns to it.
        !tablineArm.activeAfterArrowLeft.includes('jmacs-smoke-tabline-D.txt') &&
        tablineArm.activeAfterArrowRight.includes('jmacs-smoke-tabline-D.txt') &&
        // C-x k kills D; another tab becomes active. D is gone from
        // the tabs list.
        !tablineArm.tabsAfterKill.includes('jmacs-smoke-tabline-D.txt') &&
        !tablineArm.activeAfterKill.includes('jmacs-smoke-tabline-D.txt') &&
        // Per-tab text-views: after opening four text files, each tab
        // has its own <text-view> with its own data-file-path. A single
        // shared/repointed element would collapse this to one path.
        // (Includes the scratch tab's text-view too, which has no
        // data-file-path and isn't counted.)
        tablineArm.distinctTextViewPaths >= 4 &&
        // Split: 2 panes; left keeps its tabline strip, right doesn't.
        tablineArm.paneCountAfterSplit === 2 &&
        tablineArm.leftHasTabline === true &&
        tablineArm.rightHasTabline === false &&
        // Open in right pane: leaf swaps, still no tabline strip.
        tablineArm.rightHasTablineAfterOpen === false &&
        tablineArm.rightModelineAfterOpen.includes('jmacs-smoke-tabline-E.txt') &&
        // After collapse: single pane. Killing every view leaves a
        // single *scratch* tab in the tabline (Q6 fallback).
        tablineArm.paneCountAfterCollapse === 1 &&
        tablineArm.finalTabs.length === 1 &&
        tablineArm.finalTabs[0].includes('*scratch*') &&
        tablineArm.finalActive.includes('*scratch*') &&
        // Controller-level v2 restore: three tabs, active = 1, the
        // sole installed leaf matches the persisted id.
        tablineArm.restoredTabs.length === 3 &&
        tablineArm.restoredActive === 1 &&
        tablineArm.restoredCurrent === 'pane-leaf-sess' &&
        tablineArm.restoredCurrentBuffer.includes('jmacs-smoke-tabline-sess-2.txt');

      if (
        renderOk && typeOk && deleteOk && replOk && stdlibOk && sequenceOk &&
        modulesOk && buffersOk && highlightOk && interopOk && filesOk &&
        searchOk && paletteOk && treesitterOk && faceInfoOk && replaceOk &&
        regexReplaceOk &&
        mouseOk && markdownOk && previewOk && virtualOk && modesOk && layersOk &&
        splashOk && stickyOk && configOk && themesOk && facesOk && imageOk && swatchesOk &&
        docsOk && liveDocsOk && bufferMenuOk && jukeboxOk && mediaViewsOk && splittersOk &&
        tablineOk && langPackOk && treeOk && colsOk && shellOk &&
        chordOk && findFileOk && panesOk && addPaneOk && bug2Ok && bug3Ok &&
        tablineArmOk
      ) {
        finish(
          0,
          `${render.lines} lines; keymap, modes, mouse, highlighting, markdown, markdown preview, virtualisation, sticky notes, colour swatches, customisation, image buffers, splitters, search and files all work`
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
      } else if (!faceInfoOk) {
        finish(
          1,
          `describe-face-at-point did not work (${JSON.stringify(faceInfo)})`
        );
      } else if (!replaceOk) {
        finish(1, 'replace-string did not work');
      } else if (!regexReplaceOk) {
        finish(
          1,
          `regex-replace or query-replace did not work (${JSON.stringify(regexReplace)})`
        );
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
      } else if (!facesOk) {
        finish(1, `face customisation did not work (${JSON.stringify(faces)})`);
      } else if (!imageOk) {
        finish(1, `image buffers did not work (${JSON.stringify(image)})`);
      } else if (!docsOk) {
        finish(1, `docs did not work (${JSON.stringify(docs)})`);
      } else if (!liveDocsOk) {
        finish(1, `live docstring rendering did not work (${JSON.stringify(liveDocs)})`);
      } else if (!bufferMenuOk) {
        finish(1, `buffer menu did not work (${JSON.stringify(bufferMenu)})`);
      } else if (!swatchesOk) {
        finish(
          1,
          `colour swatches did not work (${JSON.stringify(swatches)})`
        );
      } else if (!chordOk) {
        finish(1, `chord-prefix display did not work (${JSON.stringify(chord)})`);
      } else if (!findFileOk) {
        finish(1, `find-file did not work (${JSON.stringify(findFile)})`);
      } else if (!jukeboxOk) {
        finish(1, `jukebox did not work (${JSON.stringify(jukebox)})`);
      } else if (!mediaViewsOk) {
        finish(
          1,
          `media views did not work (${JSON.stringify(mediaViews)})`
        );
      } else if (!splittersOk) {
        finish(1, `splitters did not work (${JSON.stringify(splitters)})`);
      } else if (!tablineOk) {
        finish(1, `tabline / session did not work (${JSON.stringify(tabline)})`);
      } else if (!langPackOk) {
        finish(1, `language pack did not work (${JSON.stringify(langPack)})`);
      } else if (!treeOk) {
        finish(1, `directory tree-view did not work (${JSON.stringify(tree)})`);
      } else if (!colsOk) {
        finish(1, `directory columns-view did not work (${JSON.stringify(cols)})`);
      } else if (!shellOk) {
        finish(1, `shell buffer did not work (${JSON.stringify(shell)})`);
      } else if (!panesOk) {
        finish(1, `multi-pane splits did not work (${JSON.stringify(panes)})`);
      } else if (!addPaneOk) {
        finish(1, `add-pane mode / C-u flip did not work (${JSON.stringify(addPaneArm)})`);
      } else if (!bug2Ok) {
        finish(1, `close-one-closes-both regression (${JSON.stringify(bug2)})`);
      } else if (!bug3Ok) {
        finish(1, `cross-pane tab click regression (${JSON.stringify(bug3)})`);
      } else {
        finish(1, `tabline behaviour did not work (${JSON.stringify(tablineArm)})`);
      }
    } catch (err) {
      finish(1, `inspection failed: ${err.message}`);
    }
  });

  win.loadURL(EDITOR_URL);
  // The smoke runs a long sequence of inspections; the timer protects
  // against a wedge in `did-finish-load`, not against slow checks. Sized
  // for v2 where the shell arm waits up to 8s for stdout under the pty
  // backing — the older 20s cap raced the tail of the run.
  setTimeout(() => finish(1, 'timed out waiting for the editor to load'), 60000);
});
