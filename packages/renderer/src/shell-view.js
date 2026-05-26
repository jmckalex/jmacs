/**
 * @file The shell view (v4) — a `shell`-kind buffer is shown through
 * this view as a real terminal grid. Each shell buffer owns one
 * long-lived child process running the user's default shell; xterm.js
 * owns the DOM, parses every escape sequence (cursor positioning,
 * SGR, scrollback, line wrapping), and exposes a tiny surface back to
 * the host (`onData`, `onResize`).
 *
 * v4 replaces v3's line-oriented transcript with xterm.js + the
 * fit-to-container addon. The renderer becomes a thin pipe: bytes
 * from the pty go straight into `term.write(...)`; keystrokes the
 * user makes inside the terminal go straight back out through
 * `options.write`. Resize is forwarded through `options.resize` so
 * the host can ioctl(TIOCSWINSZ) on the pty master.
 *
 * What this fixes vs v3:
 *
 *   - Curses applications (vi, htop, less, top) draw correctly. They
 *     emit cursor-positioning escapes that v3's line-oriented
 *     transcript discarded; xterm.js maintains a real grid.
 *   - Oh My Zsh and similar prompts render with full fidelity. ZLE
 *     is back on (we dropped `+Z`), so the prompt's editing layer,
 *     RPROMPT, completion menus etc. all draw.
 *
 * Buffer shape (v4):
 *
 *   { kind: 'shell',
 *     name: '*shell*',
 *     sessionId: 'shell-<n>',
 *     pty: boolean | undefined,
 *     ended: boolean,
 *     spawned: boolean }
 *
 * No transcript field — xterm.js's internal buffer is the transcript,
 * and we kill+respawn on reload (cheaper than buffering bytes on the
 * main side). A buffer-switch preserves the terminal: the same
 * `Terminal` instance is reattached so prior output stays visible.
 *
 * Theme integration: xterm.js's `theme` is a flat object of named
 * colours; the view reads them from the document's computed CSS
 * custom properties (--bg-editor, --fg, --ansi-*) at mount time and
 * exposes `applyTheme()` for the host to call on theme switch.
 *
 * Selection / copy: xterm.js owns its own selection. We intercept
 * Cmd+C: if `term.getSelection()` is non-empty, we copy that to the
 * clipboard and consume the event. Ctrl+C still forwards through to
 * the shell (the kernel raises SIGINT in the foreground process group).
 *
 * Smoke / test handle: when `window.__SMOKE__` is truthy the view
 * attaches `__term` to its root element so the desktop smoke can poke
 * the terminal directly without simulating keystrokes.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

/** The CSS custom-property names xterm.js's theme object expects, mapped
 *  to the editor's named ANSI variables. */
const ANSI_VARS = [
  ['background', '--bg-editor'],
  ['foreground', '--fg'],
  ['cursor', '--fg'],
  ['cursorAccent', '--bg-editor'],
  ['selectionBackground', '--selection'],
  ['black', '--ansi-black'],
  ['red', '--ansi-red'],
  ['green', '--ansi-green'],
  ['yellow', '--ansi-yellow'],
  ['blue', '--ansi-blue'],
  ['magenta', '--ansi-magenta'],
  ['cyan', '--ansi-cyan'],
  ['white', '--ansi-white'],
  ['brightBlack', '--ansi-bright-black'],
  ['brightRed', '--ansi-bright-red'],
  ['brightGreen', '--ansi-bright-green'],
  ['brightYellow', '--ansi-bright-yellow'],
  ['brightBlue', '--ansi-bright-blue'],
  ['brightMagenta', '--ansi-bright-magenta'],
  ['brightCyan', '--ansi-bright-cyan'],
  ['brightWhite', '--ansi-bright-white'],
];

/**
 * Read the editor's current CSS custom properties and build an
 * xterm.js theme object. Empty values are dropped — xterm.js fills
 * them with its own defaults. Called at mount time and on theme
 * switch (via `applyTheme()`).
 *
 * @param {Document} doc
 * @returns {object}
 */
function readThemeFromCss(doc) {
  const style = doc.defaultView.getComputedStyle(doc.documentElement);
  const theme = {};
  for (const [key, cssVar] of ANSI_VARS) {
    const value = style.getPropertyValue(cssVar).trim();
    if (value !== '') theme[key] = value;
  }
  return theme;
}

/**
 * Create a shell view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(sessionId: string, options?: { cwd?: string })
 *   => Promise<{ ok: boolean, shell?: string, pid?: number, pty?: boolean, error?: string }>}
 *   [options.spawn] - Spawn a child process for `sessionId`.
 * @param {(sessionId: string, data: string) => Promise<{ ok: boolean }>}
 *   [options.write] - Send a string to the shell's stdin.
 * @param {(sessionId: string, cols: number, rows: number)
 *   => Promise<{ ok: boolean }>}
 *   [options.resize] - Tell the pty its new size.
 * @param {(sessionId: string) => Promise<{ ok: boolean }>}
 *   [options.kill] - Terminate the shell session.
 * @param {(callback: (payload: { sessionId: string, stream: string, data: string }) => void)
 *   => (() => void)} [options.onData] - Subscribe to streamed shell
 *   output. The returned function unsubscribes.
 * @param {(callback: (payload: { sessionId: string, code: number | null, signal: string | null }) => void)
 *   => (() => void)} [options.onExit] - Subscribe to exit events.
 * @returns {{
 *   element: HTMLElement,
 *   setBuffer: (buffer: object | null) => void,
 *   focus: () => void,
 *   destroy: () => void,
 *   applyTheme: () => void,
 * }}
 */
export function createShellView(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const spawnFn = typeof options.spawn === 'function' ? options.spawn : null;
  const writeFn = typeof options.write === 'function' ? options.write : null;
  const resizeFn = typeof options.resize === 'function' ? options.resize : null;

  const root = doc.createElement('div');
  root.className = 'shell-view';
  root.tabIndex = -1;
  container.append(root);

  const header = doc.createElement('div');
  header.className = 'shell-header';
  const headerIcon = doc.createElement('i');
  headerIcon.className = 'fa-solid fa-terminal';
  const headerLabel = doc.createElement('span');
  headerLabel.className = 'shell-header-label';
  headerLabel.textContent = 'shell';
  const headerBacking = doc.createElement('span');
  headerBacking.className = 'shell-header-backing';
  headerBacking.textContent = '';
  header.append(headerIcon, headerLabel, headerBacking);
  root.append(header);

  const termHost = doc.createElement('div');
  termHost.className = 'shell-term-host';
  root.append(termHost);

  /** The xterm.js Terminal — lazy-constructed on first `setBuffer`
   *  with a non-null buffer, so the canvas only gets allocated when a
   *  shell buffer is actually shown. */
  let term = null;
  /** The fit addon, paired with `term`. */
  let fit = null;
  /** Watches the term host for size changes and re-fits. */
  let resizeObserver = null;
  /** Pending fit triggered by mounting — the canvas-renderer's width
   *  measurement is wrong if the host has zero width when `open()` is
   *  called, so we re-fit on the next animation frame. */
  let pendingFit = false;

  /** The buffer currently shown, or null. */
  let buffer = null;

  /** Subscription handles. Initialised below; cleared in `destroy()`. */
  let unsubscribeData = null;
  let unsubscribeExit = null;

  /** Update the [pty] / [pipe] adornment in the header. */
  function refreshBackingLabel() {
    if (!buffer || buffer.pty === undefined) {
      headerBacking.textContent = '';
      return;
    }
    headerBacking.textContent = buffer.pty ? '[pty]' : '[pipe]';
  }

  /** Schedule a fit on the next frame. xterm.js measures the host
   *  element's clientWidth; if the host is display:none or 0-wide at
   *  the call site the measurement is wrong. Coalescing requests keeps
   *  ResizeObserver storms cheap. */
  function scheduleFit() {
    if (pendingFit || !fit) return;
    pendingFit = true;
    win.requestAnimationFrame(() => {
      pendingFit = false;
      try {
        if (termHost.clientWidth > 0 && termHost.clientHeight > 0) {
          fit.fit();
        }
      } catch {
        // The host element may have been removed mid-frame.
      }
    });
  }

  /** Lazy-build the Terminal. Called once, on the first shell-buffer
   *  mount; subsequent buffer switches reuse the same Terminal. */
  async function ensureTerminal() {
    if (term) return;
    // Canvas-renderer needs the font measured to compute cell metrics.
    // Wait for any pending font loads to settle, otherwise the first
    // paint reads the wrong glyph width and the grid never recovers.
    if (doc.fonts && typeof doc.fonts.ready?.then === 'function') {
      try {
        await doc.fonts.ready;
      } catch {
        // Loading failed; xterm.js will still measure something.
      }
    }
    term = new Terminal({
      fontFamily:
        // Resolve the editor's mono font through a small inline read —
        // xterm.js expects a literal font-family string, not a CSS var.
        win
          .getComputedStyle(doc.documentElement)
          .getPropertyValue('--font-mono')
          .trim() || 'ui-monospace, Menlo, monospace',
      fontSize: 13,
      theme: readThemeFromCss(doc),
      scrollback: 10000,
      // The pty already CRLFs its line endings; let xterm.js see them
      // unchanged. (convertEol=true would inject a CR on every bare LF,
      // which the pty doesn't emit.)
      convertEol: false,
      // \a is forwarded by some prompts (zsh's `print -P` etc.).
      // The architect's call: silence it.
      bellStyle: 'none',
      // The visual scrollbar isn't necessary — xterm.js exposes it
      // through the .xterm-viewport's overflow. Default 'auto'.
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost);

    // Forward typed bytes to the shell. xterm.js handles all the
    // input-side mapping (arrow keys -> ESC sequences, etc.) — we
    // just pipe the resulting bytes through.
    term.onData((data) => {
      if (buffer && writeFn) {
        writeFn(buffer.sessionId, data);
      }
    });

    // Forward resize requests. xterm.js's fit() recomputes cols/rows
    // and emits onResize when they change; we ferry that to the pty.
    term.onResize(({ cols, rows }) => {
      if (buffer && resizeFn) {
        resizeFn(buffer.sessionId, cols, rows);
      }
    });

    // Container-driven sizing: any change in the host element's
    // bounding rect (theme switch, sidebar resize, window resize)
    // triggers a re-fit.
    resizeObserver = new win.ResizeObserver(() => scheduleFit());
    resizeObserver.observe(termHost);

    // Cmd+C: if there's a selection, copy it to the system clipboard
    // and consume the event. With no selection, let the keydown
    // propagate — the OS default applies (or, on a system with a
    // bound shortcut, that fires). We do NOT remap Cmd+C to SIGINT:
    // Ctrl+C is the SIGINT path, which xterm.js forwards naturally.
    termHost.addEventListener('keydown', (event) => {
      if (
        event.key === 'c' &&
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        const sel = term.getSelection();
        if (typeof sel === 'string' && sel !== '') {
          event.preventDefault();
          event.stopPropagation();
          if (win.navigator.clipboard?.writeText) {
            win.navigator.clipboard.writeText(sel).catch(() => {
              // Clipboard denied — selection survives, user can retry.
            });
          }
        }
      }
    }, { capture: true });

    // Smoke handle: when running under the desktop smoke we expose the
    // Terminal so the script can `__term.input(...)` directly and
    // poll `__term.buffer.active`. Production runs don't see this.
    if (win.__SMOKE__) {
      root.__term = term;
    }
  }

  /** Stream callback — pty bytes flow into the terminal. xterm.js
   *  accepts bytes as a string (utf-8) or a Uint8Array; the IPC
   *  delivers them as a JS string. */
  function onData(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    if (term) {
      term.write(payload.data);
    }
  }

  /** Exit callback — render a dim `[exited]` marker so the user sees
   *  the session ended. The buffer object is marked accordingly. */
  function onExit(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    buffer.ended = true;
    if (term) {
      const tag = payload.signal
        ? `[exited on ${payload.signal}]`
        : `[exited${typeof payload.code === 'number' ? ` ${payload.code}` : ''}]`;
      term.write(`\r\n\x1b[2m${tag}\x1b[0m\r\n`);
    }
  }

  /** Show a shell buffer. Spawns its child process on first mount. */
  function setBuffer(next) {
    buffer = next;
    if (!buffer) {
      headerLabel.textContent = 'shell';
      headerBacking.textContent = '';
      return;
    }
    headerLabel.textContent = buffer.name ?? 'shell';
    refreshBackingLabel();
    // Ensure the terminal exists, then re-fit on the next frame —
    // by the time we're called, the view has just been un-hidden,
    // so the host's box is now measurable.
    ensureTerminal().then(() => {
      scheduleFit();
      if (term) term.focus();
      if (!buffer.spawned && !buffer.ended && spawnFn) {
        buffer.spawned = true;
        spawnFn(buffer.sessionId, { cwd: buffer.cwd })
          .then((result) => {
            if (!result || !result.ok) {
              if (term) {
                term.write(
                  `\r\n\x1b[31m[spawn failed: ${result?.error ?? 'unknown'}]\x1b[0m\r\n`
                );
              }
              buffer.ended = true;
              return;
            }
            buffer.pty = result.pty === true;
            refreshBackingLabel();
            // Push the current grid size to the freshly-spawned shell.
            if (term && resizeFn) {
              resizeFn(buffer.sessionId, term.cols, term.rows);
            }
          })
          .catch((error) => {
            if (term) {
              term.write(
                `\r\n\x1b[31m[spawn failed: ${error.message}]\x1b[0m\r\n`
              );
            }
            buffer.ended = true;
          });
      }
    });
  }

  /** Recompute the xterm.js theme from the document's current CSS
   *  variables. Called on theme switch. Safe to call before the
   *  terminal exists — it's a no-op then. */
  function applyTheme() {
    if (!term) return;
    term.options.theme = readThemeFromCss(doc);
  }

  if (typeof options.onData === 'function') {
    unsubscribeData = options.onData(onData);
  }
  if (typeof options.onExit === 'function') {
    unsubscribeExit = options.onExit(onExit);
  }

  return {
    element: root,
    setBuffer,
    focus: () => term?.focus(),
    applyTheme,
    destroy: () => {
      if (typeof unsubscribeData === 'function') unsubscribeData();
      if (typeof unsubscribeExit === 'function') unsubscribeExit();
      unsubscribeData = null;
      unsubscribeExit = null;
      if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch { /* gone */ }
        resizeObserver = null;
      }
      if (term) {
        try { term.dispose(); } catch { /* gone */ }
        term = null;
        fit = null;
      }
    },
  };
}
