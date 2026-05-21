# @editor/desktop — the Electron host (L0)

The desktop application. It opens a window and runs the editor inside
it. The main process is deliberately thin; the editor itself (L1, L2,
L4) runs entirely in the renderer process.

## Running it

```
pnpm dev          # from the repository root
```

## How it loads

There is no bundler. The renderer loads the workspace packages as
native ES modules, resolved through an import map in `index.html`.

Files are served over a custom `app://` scheme (`src/serve.js`) rather
than `file://`: a privileged standard scheme gives the page a real,
secure origin, which is what native modules and import maps need. The
main process (`src/main.js`) serves the repository's files and opens
the window; `src/app.js` runs in the renderer and wires a buffer to an
editor view and a modeline.

## Scripts

- `pnpm --filter @editor/desktop dev` — open the editor.
- `pnpm --filter @editor/desktop smoke` — launch hidden, verify the
  editor renders and that typing updates the DOM. Exits non-zero on
  failure. Kept out of `pnpm test` because it needs an Electron runtime.
- `pnpm --filter @editor/desktop screenshot [path]` — capture a PNG of
  the editor as it first opens.

## Layout

```
src/main.js      Electron main process — window + protocol
src/serve.js     the app:// scheme, shared with the smoke test
src/app.js       renderer entry — wires buffer, view, modeline
index.html       the page: import map + mount points
styles.css       the editor's visual defaults
scripts/         smoke test and screenshot tooling
```
