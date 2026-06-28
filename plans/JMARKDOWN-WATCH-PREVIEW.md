# Plan — JMarkdown preview via `jmarkdown watch` (morphdom live-reload)

**Status: DESIGNED, not built (2026-06-28).** Decisions locked with Jason;
the current in-app preview (committed `7a5bc48`, working under Model B) stays
until this lands, then is replaced.

## Goal
Replace the in-app Markdown/JMarkdown preview pane with the **real** jmarkdown
`watch` server, so the preview is byte-identical to the book pipeline and
updates via **morphdom** DOM-diffing (fast, scroll-preserving) instead of a
full re-render.

`jmarkdown watch <file> --port N` (verified on PATH at `/usr/local/bin/jmarkdown`)
rebuilds on file change and live-reloads a localhost preview server; morphdom
is the default (`--full-reload` is the opt-out).

## Decisions (Jason, 2026-06-28)
- **Trigger = on SAVE.** Point `watch` at the **real saved file**; the preview
  refreshes when the buffer is saved (`C-x C-s`), not per keystroke. No temp
  file; relative `\cite` / includes / CSS resolve naturally against the doc's
  directory. (Unsaved / path-less buffer → "save the file first".)
- **Replace** the in-app preview (it becomes the `markdown-preview` toggle).

## Architecture — a main-process subprocess + a localhost iframe
The preview pane is renderer chrome (not a server pane-tree view), so this is
coordinated by the **renderer ↔ MAIN** (like the shell PTY), triggered by the
server's `markdown-preview` directive. The spine stays thin.

1. **spine.js** — `markdown-preview!` includes the active buffer's **file
   path** in the directive: `emit-client-directive! … 'markdown-preview path`
   (empty when unsaved). (Small, unit-testable; the only spine change.)
2. **MAIN (`src/main.js` + a new `src/jmarkdown-watch.js`)** — mirror
   `src/shell.js`'s `child_process.spawn` pattern:
   - `ipcMain.handle('jmarkdown:watch:start', (e, {path}))` → pick a FREE port
     (bind a `net.createServer` to `:0`, read the port, close, reuse — or scan),
     `spawn('jmarkdown', ['watch', path, '--port', String(port)])`, store the
     child keyed by `event.sender.id`, return `{ port }`. Return an error if
     `jmarkdown` isn't found (ENOENT) so the renderer can surface it.
   - `ipcMain.handle('jmarkdown:watch:stop', (e))` → kill this window's child.
   - Reap on window `closed` and app `before-quit` (SIGTERM, then SIGKILL
     backstop — see shell.js's reaping).
3. **`preload.mjs`** — expose `host.startJmarkdownWatch(path) → Promise<{port}>`
   and `host.stopJmarkdownWatch()` over `ipcRenderer.invoke`.
4. **Renderer (`app.js`)** — `applyDirective('markdown-preview', [path])`:
   - If the pane is visible → hide it + `host.stopJmarkdownWatch()`.
   - Else if `path` is empty → status "markdown-preview: save the file first".
   - Else → `const {port} = await host.startJmarkdownWatch(path)`; show the
     preview pane with an **iframe `src = http://localhost:${port}`** (replacing
     the current `srcdoc` injection in the `markdown-preview` module).
   - On window close / a switch to a non-markdown buffer, stop the watch.
5. **CSP (`apps/desktop/index.html`)** — add `http://localhost:* http://127.0.0.1:*`
   to `frame-src` (currently `'self' app: https:`). Without it the iframe is
   blocked. (Alternative: an Electron `<webview>`, which escapes the page CSP —
   heavier; prefer the CSP allowance for a local-first editor.)

## Wrinkles / open points
- **Free-port allocation + races** — bind-to-`:0` is the robust way.
- **Process lifecycle** — one watcher per window; kill + respawn when the
  previewed file changes (buffer switch) or on toggle-off; reap on quit (the
  shell.js SIG_DFL/SIGKILL lessons apply).
- **Startup latency** — `jmarkdown watch` takes a beat to boot its server;
  the iframe may need a brief retry / "starting preview…" state.
- **Save-to-refresh UX** — since it's on-save, a first-time toggle on an
  unsaved-edits buffer shows the last-saved content until the next `C-x C-s`.
- **`--no-serve` / format** — default `--to html`; `--open` NOT passed (we
  embed, don't open a browser).
- This is **main-process work** → quit + relaunch to test; Jason live-verifies
  (build side can't spawn/network-test it). Treat as its own focused session.

## Why this supersedes the in-app preview
The in-app pane is a second rendering path that can drift from real jmarkdown;
`watch` is the one true renderer Jason already maintains, with morphdom
incremental updates. Net system is simpler (one pipeline) even though the
editor-side plumbing is more (a live subprocess). See the help-dock /
shell ports for the directive-channel + live-process patterns reused here.
