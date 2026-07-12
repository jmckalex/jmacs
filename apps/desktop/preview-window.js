/**
 * @file The popped-out Markdown-preview window's relay (preview-window.html).
 *
 * It embeds the live `jmarkdown watch` page in an iframe — so the page's sync.js
 * sees a parent (`window.parent !== window.self`) and engages — and bridges that
 * iframe's forward/inverse-search postMessages to the EDITOR window, which lives
 * in a separate renderer. The hop goes through this window's preload
 * (preview-preload.mjs) and main:
 *
 *   iframe sync.js  <-- postMessage -->  THIS page  <-- IPC -->  main  <-- IPC -->  editor
 *
 * - Inverse (⌘-click): the iframe posts `source-line-click`; we send it up.
 * - Forward (cursor):  main sends a `scroll-to-line` down; we post it to the iframe.
 * - `ready`: relayed up so the editor can replay the current cursor line at once.
 */

const SOURCE = 'jmarkdown-sync';
const VERSION = 1;

const frame = document.getElementById('preview-frame');
const params = new URLSearchParams(location.search);

// Theme the window to match the editor: the file name in the title bar, and the
// editor's resolved chrome colours (passed at pop-out time).
const name = params.get('name');
if (name) {
  document.title = name;
  document.getElementById('titlebar-name').textContent = name;
}
const tbBg = params.get('bg');
const tbFg = params.get('fg');
if (tbBg) document.documentElement.style.setProperty('--tb-bg', tbBg);
if (tbFg) document.documentElement.style.setProperty('--tb-fg', tbFg);

const port = params.get('port');
if (port) frame.src = `http://localhost:${port}/`;

/** Only the embedded localhost preview is a trusted message source. */
function fromPreview(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// iframe (sync.js) → editor: ready + inverse-search clicks.
window.addEventListener('message', (event) => {
  if (!fromPreview(event.origin)) return;
  const d = event.data;
  if (!d || d.source !== SOURCE) return;
  if (d.type === 'ready') {
    window.host.up({ type: 'ready' });
  } else if (d.type === 'source-line-click' && typeof d.line === 'number') {
    window.host.up({ type: 'source-line-click', line: d.line });
  }
});

// editor cursor (via main) → iframe: forward-search scroll.
window.host.onDown((msg) => {
  if (!msg || msg.type !== 'scroll-to-line' || typeof msg.line !== 'number') return;
  const win = frame.contentWindow;
  if (win) {
    win.postMessage(
      { source: SOURCE, version: VERSION, type: 'scroll-to-line', line: msg.line, behavior: 'smooth', flash: !!msg.flash },
      '*'
    );
  }
});
