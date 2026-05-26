# Shell buffer v4 — xterm.js plan

The line-oriented v3 shell buffer (merged) gets us a working `M-x
shell` with colours, prompts and the right interaction model — but
under `+Z` (ZLE off) it loses the ZLE-driven half of the Oh My Zsh
prompt (git branch, RPROMPT timestamp, etc.), and curses apps (vi,
htop, less) can't run because the transcript model has no terminal
grid to draw to.

v4 swaps the v3 model for a real terminal emulator. xterm.js owns
the DOM and handles every escape sequence; the renderer becomes a
thin shim that pipes bytes between the PTY and the terminal widget.
"There's no point doing a halfway house" — once we want curses
apps and full prompt fidelity, only a real terminal will do.

## What goes away

- `feedLiveLine` and the per-session live-line state machine in
  `shell-view.js`. xterm.js handles `\r`, `\b`, cursor positioning,
  scrollback, line wrapping — all of it.
- The ANSI parser in `packages/renderer/src/ansi.js`. xterm.js parses
  ANSI itself. Delete the file and its tests; resurrect from git if
  the code is ever wanted elsewhere.
- The inline contenteditable input row, the live-partial span, the
  per-session command history (xterm forwards keys to the shell;
  ZLE handles history natively).
- Most of the v3 shell CSS (`.shell-live-row`, `.shell-live-partial`,
  `.shell-live-input`, the 16-colour ANSI palette classes, the 512
  256-colour rules, the `--ansi-*` CSS variables). xterm.js carries
  its own theme.
- `+Z` and `--noediting` flags. ZLE / readline are back — they are
  exactly what xterm.js expects from the shell.
- The parent-side termios ECHO-off tweak in `shell.js`'s python
  helper. xterm.js wants normal terminal semantics; the kernel
  echoing typed bytes back to the terminal grid is correct.

## What stays

- The python pty helper in `apps/desktop/src/shell.js`. Same
  invocation strategy (the
  `python3 -c '<pty_helper>' <shell>` pattern). The `pty.fork` +
  select loop survives untouched, minus the termios tweak.
- The session registry (one `child_process` per shell buffer,
  keyed by sessionId, killed on buffer close).
- The IPC surface — `shell:spawn`, `shell:write`, `shell:signal`,
  `shell:end-input`, `shell:kill`, `shell:data`, `shell:exit`. Plus
  one new channel: `shell:resize` (see below).
- The buffer-kind dispatch in `apps/desktop/src/app.js` — `shell` is
  still a buffer kind; the view's external interface (`setBuffer`,
  `focus`, `destroy`) is unchanged.
- The `M-x shell` Lisp command in `packages/stdlib/lisp/shell.lisp`.
  Unchanged.
- The `shell-mode` major mode for the modeline.

## What's new

- **Dependency: `@xterm/xterm`** (the modern package; the old
  `xterm` slot is the same code published from the new name). About
  250 kB minified, pure JS, zero native deps. Industry-standard
  embedded terminal — VS Code, Hyper, Theia, GitKraken (probably)
  all use it.
- **Dependency: `@xterm/addon-fit`** for `term.fit()` — recomputes
  cols × rows when the parent container resizes.
- **`shell:resize` IPC.** A renderer-side `host.shellResize(sessionId,
  cols, rows)` invokes a main-process handler that writes a
  `\x1b[8;<rows>;<cols>t` is the xterm-style query, but the right
  primitive is `ioctl(fd, TIOCSWINSZ, ...)` on the pty master. The
  python helper needs a small protocol: when bytes arrive on a
  separate channel (a sidechannel pipe, or an in-band escape we
  intercept), apply the size. Simplest model: a second pipe (fd 3 in
  the python child) that carries `<cols>:<rows>\n` messages. The
  python loop adds fd 3 to its select set and ioctls the master on
  read.
- **Theme bridge.** xterm.js's `Terminal` constructor accepts a
  `theme` object with named colours. Build it from the existing
  `--bg-editor`, `--fg`, `--ansi-*` variables (or `faces.json`'s
  ANSI palette). Listen for theme changes and call
  `term.options.theme = ...` to live-update.
- **Renderer selection.** xterm.js defaults to the canvas renderer
  for performance. The smoke test reads text via
  `term.buffer.active.getLine(n).translateToString()` — works
  regardless of renderer. The DOM renderer (via `@xterm/addon-dom`)
  is optional and only worth it if accessibility tooling needs the
  DOM nodes; default is fine.

## File-by-file

### `apps/desktop/src/shell.js`

- Drop the `termios.ECHO` off step from `PYTHON_PTY_SCRIPT`.
- Drop the zsh `+Z` / bash `--noediting` flags.
- Add a sidechannel pipe (fd 3) the python helper reads resize
  commands from. Format: ASCII `<cols>:<rows>\n`; helper splits and
  calls `fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH',
  rows, cols, 0, 0))`. The Node side passes a `{ stdio: ['pipe',
  'pipe', 'pipe', 'pipe'] }` to `spawn` so fd 3 in the child is the
  4th pipe.
- Add `ipcMain.handle('shell:resize', ...)` that writes
  `<cols>:<rows>\n` to that pipe for the matching session.

### `apps/desktop/src/preload.mjs`

- Add `shellResize(sessionId, cols, rows)` to the host bridge.
- Everything else unchanged.

### `packages/renderer/src/shell-view.js`

Full rewrite, much smaller. Outline:

```js
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export function createShellView(container, options = {}) {
  const root = container.ownerDocument.createElement('div');
  root.className = 'shell-view';
  container.append(root);

  // Header carrying the [pty]/[pipe] tag — unchanged from v3.
  const header = makeHeader();
  root.append(header);

  const termHost = document.createElement('div');
  termHost.className = 'shell-term-host';
  root.append(termHost);

  let term = null;
  let fit = null;
  let buffer = null;
  let unsubscribeData = null;
  let unsubscribeExit = null;
  let resizeObserver = null;

  function setBuffer(next) {
    buffer = next;
    if (!buffer) { term?.clear(); return; }
    // First mount: construct the Terminal and bind it to the host.
    if (!term) {
      term = new Terminal({
        fontFamily: 'var(--font-mono)',  // resolves via CSS
        fontSize: 13,
        theme: makeTheme(),
        scrollback: 10000,
        convertEol: false,    // pty already CRLFs
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termHost);
      // Forward typed keys to the shell.
      term.onData((data) => options.write?.(buffer.sessionId, data));
      // Forward terminal-driven resize requests.
      term.onResize(({ cols, rows }) => {
        options.resize?.(buffer.sessionId, cols, rows);
      });
      // Container resize → fit() recomputes cols/rows.
      resizeObserver = new ResizeObserver(() => fit.fit());
      resizeObserver.observe(termHost);
    }
    // Spawn / refresh / fit. Spawn-on-first-mount mirrors v3.
    if (!buffer.spawned && options.spawn) {
      buffer.spawned = true;
      options.spawn(buffer.sessionId, { cwd: buffer.cwd })
        .then((result) => {
          buffer.pty = result.pty === true;
          refreshHeader();
          fit.fit();  // tell the shell its size as soon as it's up
        });
    }
    fit.fit();
    term.focus();
  }

  unsubscribeData = options.onData?.((payload) => {
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    term.write(payload.data);
  });

  unsubscribeExit = options.onExit?.((payload) => {
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    term.writeln(`\r\n\x1b[2m[exited]\x1b[0m`);
  });

  return {
    element: root,
    setBuffer,
    focus: () => term?.focus(),
    destroy: () => {
      unsubscribeData?.();
      unsubscribeExit?.();
      resizeObserver?.disconnect();
      term?.dispose();
    },
  };
}
```

The smoke arm changes: `view.querySelector('.xterm-helper-textarea')`
exists once the terminal mounts (xterm.js focuses an offscreen
`<textarea>` to capture input). Read `term.buffer.active` to assert
content.

### `apps/desktop/src/app.js`

- Hand `term.options.theme = ...` updates on theme switch. The
  existing theme-switch hook lives in… (find: `themes.lisp` →
  `apply-theme!` primitive). Add a callback that the renderer
  registers, calls into the shell view's `applyTheme(themeObj)`.
- Wire the new `resize` option through `createShellView({...})`,
  calling `window.host.shellResize`.

### `apps/desktop/styles.css`

- Delete `.shell-live-row`, `.shell-live-partial`, `.shell-live-input`,
  `.shell-entry-*` rules. Keep `.shell-view` (still the kind
  container) and `.shell-header` (the `[pty]` tag).
- Delete all `.shell-fg-*` / `.shell-bg-*` / `.shell-bold` /
  `.shell-italic` / `.shell-underline` / `.shell-inverse` rules and
  the `--ansi-*` variables on `:root` / per-theme overrides.
- Add `.shell-term-host` (the xterm.js container). Probably
  `flex: 1 1 auto; min-height: 0; overflow: hidden;` so xterm.js
  can size itself.

### `packages/renderer/test/`

- Delete `ansi.test.js` (and `packages/renderer/src/ansi.js`).
- Delete `shell-view.test.js`'s `feedLiveLine` tests (the function
  itself is gone). Replace with a minimal "Terminal mounts, accepts
  writes, emits user data" smoke if it's easy in node-test; otherwise
  leave to the desktop smoke harness.

### `apps/desktop/scripts/smoke.js`

- Update the shell arm. Submit `(shell)`, wait, assert
  `document.querySelector('.shell-term-host .xterm')` exists. Type
  by calling `term.input('echo MARKER\r')` directly (via a `__term`
  handle the view exposes when running under smoke — or fall back to
  dispatching to the helper textarea). Poll the buffer for the
  marker. Verify a colored prompt component matches the user's
  iTerm theme — for example, look for a span with the green git
  branch glyph. The `[pty]` tag check is unchanged.
- Add a resize sanity arm: change `termHost.style.width = '40ch'`;
  expect `term.cols` to update.

## Theme integration

xterm.js's `theme` is a flat object of named colours:

```js
{ background, foreground, cursor, selectionBackground,
  black, red, green, yellow, blue, magenta, cyan, white,
  brightBlack, brightRed, ..., brightWhite }
```

The current dark theme has its 16-colour palette in
`packages/stdlib/lisp/themes.lisp` (Solarized-ish for the moment).
Map the relevant face values to xterm.js's names at view-construction
time and on theme-switch.

A nice future iteration: expose a `(set-shell-theme! palette)` Lisp
primitive so the user can override the shell's palette independently
of editor faces.

## Resize protocol — the fd 3 detail

Two pipe model:

- Renderer issues `shell:resize(sessionId, cols, rows)`.
- Main process looks up the session, writes `${cols}:${rows}\n` to
  the session's resize pipe (the fd 3 we created at spawn time).
- The python helper's select loop has fd 3 in its read set. On read,
  parse `<cols>:<rows>\n` and call `fcntl.ioctl(self.fd,
  termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))`. The
  kernel issues SIGWINCH to the foreground process group, the
  shell repaints, the prompt re-flows.

Why not in-band (write a magic escape to stdin and have the helper
strip it)? In-band collides with user input — anything the user
might type as actual content can collide with the magic bytes.
fd 3 is cleaner.

## Open questions

1. **Selection / copy.** xterm.js owns its own selection model
   (Alt+drag for word, etc.). The browser's native selection won't
   work inside the terminal grid. The xterm.js API supports
   `term.getSelection()` for clipboard handoff. The keybinding for
   "copy" needs deciding — Cmd+C should still work via the OS.
2. **Reload / hot-reload behaviour.** When the renderer reloads, the
   main process keeps the child shells alive (it didn't kill them).
   v3 reuses the session id on reload, but xterm.js has no in-memory
   scrollback from before. Decide: kill on reload (clean state) or
   re-render the existing buffer's prior bytes (need to buffer them
   on the main side). The simple choice is kill-on-reload.
3. **Font choice.** xterm.js renders to canvas by default — it
   needs the font loaded by the time the canvas is created.
   `document.fonts.ready` before `term.open()` is the usual fix.
4. **Bell behaviour.** A `\a` in output should flash the terminal,
   not annoy the user. xterm.js has a `bellStyle: 'none'` option;
   ship with that as default; expose as a customization later.

## Effort estimate

A focused day's work for one agent. Big surface but additive —
build the new view alongside v3 first, swap the import last. Risk
items: theme bridge (depends on touching theme-switch wiring),
resize protocol (the fd 3 pipe pattern in `child_process.spawn`
needs Node-side careful setup).

## Branch & merge

- Branch: `agent-shell-buffer-v4`.
- Built on top of current main (v3 already landed at `8a5fd40` +
  the CRLF fix `0b12776`).
- The merge replaces, rather than augments — most of v3's view code
  is removed in this commit.
- Smoke + tests green before merge per the standing rule.
