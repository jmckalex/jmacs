# Architect Notes

Notes from autonomous sessions for Jason to review. Newest at the top.
Nothing here is blocking — these are decisions made under the "build a
running app" brief that touch standing commitments or span territories,
flagged so the standing instructions can be updated if you disagree.

---

## [2026-05-21] Renderer + desktop: a running editor, with deviations to confirm

**Context**: Brief was "be ambitious, I'd love to see a running app
tomorrow." Built the full L1→L2→L4 vertical slice; the editor opens in
an Electron window and is editable. Smoke test confirms typing,
deletion, cursor and modeline.

**Decisions that touch standing commitments — please confirm or correct:**

1. **No bundler (deviates from architecture commitment #6, "Vite for
   the renderer").** For v0 there is nothing to bundle. The renderer
   loads the workspace packages as native ES modules via an import map,
   served over a custom `app://` scheme (`apps/desktop/src/serve.js`).
   This is simpler, has no build step, and is more legible. Fully
   reversible — Vite can be added when there is a real reason (HMR,
   minified release builds). If you want Vite in from the start, say so.

2. **L3 Lisp runtime deferred.** A running editor does not need it, and
   it is the riskiest compounding decision in the architecture —
   rushing it autonomously seemed wrong. The editor runs without Lisp;
   v0 keybindings are a small hardcoded keymap in the renderer
   (`packages/renderer/src/keymap.js`), explicitly a placeholder for the
   real Lisp-defined bindings.

3. **L1 persistence split to a sub-path entry.** `@editor/storage` now
   exports only the browser-safe `createBuffer`; `loadBuffer`/
   `saveBuffer` (which use `node:fs`) moved to
   `@editor/storage/persistence`. Necessary — the renderer pulled
   `node:fs/promises` into the browser otherwise. A genuine improvement:
   L1's default surface is now browser-safe.

4. **pnpm via corepack.** pnpm was not installed; activated it through
   Node's bundled `corepack` (pnpm 11.2.2, pinned in root
   `package.json`'s `packageManager`). No global npm install.

**L2 is minimal.** `@editor/buffer` has point/mark, editing, movement,
undo/redo and events — enough to drive the window. Text properties,
overlays, markers, modes and hooks are deferred (noted in its README).

**Territory note.** This session spanned `packages/renderer` and
`apps/desktop`, both built on branch `agent-4-renderer`, plus a small
browser-safety fix in `packages/storage` (item 3). Done under the
direct "running app" brief rather than routed through notes, since you
were monitoring live.

**State of the work**: Branch `agent-4-renderer`, all committed, tests
green (storage 47, buffer 29, renderer 26) and the Electron smoke test
passing. Pre-commit hook also had a real bug fixed this session
(`pnpm test --silent` forwarded `--silent` to `node --test`); that fix
is already on `main`.

---
