# Handover: PDF-view Option B (PDF.js with custom chrome)

## What just merged into main

The previous session landed a long fix-and-feature chain. As of `e2f2d1a`
on `main`:

- **Views-as-custom-elements refactor** (Phase 1 through Phase 4 deep
  cleanup): every view kind now has its own custom element
  (`<text-view>`, `<browser-view>`, …) and per-tab instances.
- **Browser-view feature**: `(open-url! "...")` opens a URL in a
  `<browser-view>` with a back/forward/reload/URL/stop toolbar
  wrapping Electron's `<webview>`.
- **PDF-view v1**: routes `.pdf` files to a `<pdf-view>` that wraps
  an Electron `<webview>` pointed at Chromium's built-in PDF plugin.
  **This is broken** — see "Why we're here" below.
- **Add-pane mode** (`C-x +`): a visual macro that highlights every
  splitter and the four outer borders; click one to insert a pane
  there. Plus `C-u C-x 2` / `C-u C-x 3` to flip the side of regular
  splits.
- **Bug-fix sequence**: clip on `.tabline-content`, seed-splice
  `currentViewIndex` shift, `:scope > text-view` for the leaf-direct
  query, `activateTabInTabline` modeline sync, cross-pane tab-click
  fixes (capture-phase focus + `hideInactiveSingletons`).
- **`docs/VIEWS.md`** — the architectural playbook for view/pane
  invariants. **Read this first** if your work touches views.

`main` is ahead of `origin/main`; nothing has been pushed yet.

## Why we're here

The user reports the PDF view shows a blank pane. Two things:

1. **The v1 doesn't actually render PDFs.** Electron's `<webview>`
   defaults plugins to off, and Chromium's built-in PDF viewer is
   implemented as a plugin. Without `webpreferences="plugins=true"` on
   the `<webview>`, the webview loads the URL, has no plugin to render
   it, and shows blank.

2. **`plans/PDF-VIEW.md` recommended PDF.js (Option B), not the
   Chromium plugin (Option A).** The sub-agent who built v1 went with
   Option A — explicitly called out by the plan as "a fine v0" if you
   want the half-day version, but not the recommended path. The
   reasons B beats A are spelled out in the plan and they are exactly
   the things we'd want from a Lisp-extensible editor:

   - Theme matching with Godot's chrome (Option A is fixed Chromium UI).
   - Keymap integration — `j`/`k` page nav, `/` find, etc.
   - **Programmatic text access** so Lisp can extract citations, do
     `M-x cite-pdf`, search across PDFs from `M-x occur`, etc.

So the right move is to skip patching v1 and implement Option B per
the plan.

## The task

Implement **Option B** from `plans/PDF-VIEW.md`:

- Rip out the `<webview>` from `packages/renderer/src/pdf-view.js`.
- Add `pdfjs-dist` (Apache 2.0, ~2 MB) as a renderer dependency.
- Render each page to a `<canvas>` + overlapping text layer inside
  `<pdf-view>`.
- Build the chrome: page indicator (`n / m`), zoom in/out, fit-width
  / fit-page, find bar (`/`), download.
- Wire `setBuffer(view)` to load `view.filePath` via PDF.js,
  jumping to `view.page` and applying `view.zoom`.
- Per-tab state preservation: each `<pdf-view>` keeps its own
  `_pdfDoc`, current page, and zoom across tab switches.
- Optional but low-cost while you're in there: lay the groundwork
  for a `pdf-extract-text` Lisp primitive (the spec is in the plan).

The plan estimates **1–2 focused days** for v1 of Option B.

## What's already in place (don't redo)

- The view kind, dispatch, and file-open detection — `.pdf` suffix
  routes through `openFileByPath` → `result.pdfKind: true` →
  `createView({kind: 'pdf', name, extras: {filePath, src}})`. The
  `src` is a `media://localhost/<path>` URL.
- `<pdf-view>` custom-element shell (constructor + `configure` +
  `setBuffer` + `connectedCallback` + `destroy`). Replace the
  `_ensureMounted` / `_paint` internals; keep the outer shape so
  the host's `perKindConfigureFactory` integration doesn't need to
  change.
- `SINGLETON_VIEWS` entry, `configurePdfView`, and the per-kind
  configure factory dispatch — all live in `apps/desktop/src/app.js`.
- Session-restore plumbing for ephemeral kinds (PDF is ephemeral —
  not persisted across restart, like browser-view).
- The media protocol already supports Range requests; PDF.js
  handles those fine.

## Required reading (in this order)

1. **`docs/VIEWS.md`** — invariants and ownership boundaries. The
   pdf-view follows the per-view-instance pattern; understand it
   before touching the mount path. Specifically the visibility
   ownership table.
2. **`plans/PDF-VIEW.md`** — the architecture for Option B. Includes
   the layout, the state fields on `_pdfDoc`, the API surface, the
   Lisp text-extraction plan, the cost estimate, and the known
   limitations (encrypted PDFs, malformed input, hi-DPI, etc.).
3. **`packages/renderer/src/pdf-view.js`** — the current v1 shell
   you'll be replacing. The outer custom-element interface stays;
   the inside changes.
4. **`packages/renderer/src/browser-view.js`** — useful reference
   for how a custom view-element with chrome (toolbar + main
   content area) is structured here. Style of buttons, event
   wiring, etc.
5. **`packages/renderer/src/image-view.js`** — useful reference
   for how a *non-webview* view kind handles `setBuffer` + paint
   inside a custom element.

## Known caveats / pitfalls

- **Don't break the per-view-instance shape.** Each pdf tab gets
  its own `<pdf-view>` with its own `_pdfDoc` — that's how tabbed
  PDFs survive a tab switch with their scroll/zoom state.
- **Don't reach into `.tabline-content` from outside.** Per
  `docs/VIEWS.md`: per-tab visibility is owned by
  `mountTablineActiveChild`. The pdf-view should just respond to
  `setBuffer` and rely on the standard display loop for show/hide.
- **The `media://` protocol gives a URL, not a file path.** PDF.js's
  `getDocument` accepts either a URL or a `Uint8Array`. Use the
  URL form — Chromium streams with Range support and PDF.js
  handles Range responses natively. No new IPC needed.
- **Hi-DPI**: PDF.js's `viewport.scale` needs to multiply by
  `window.devicePixelRatio` so canvases stay crisp on retina. See
  the plan's pitfalls section.
- **Don't try to use Chromium's PDF plugin as a fallback.** The
  webview-with-plugins-on approach is a rabbit hole (plugin gating
  varies by Electron version; sandbox interaction is fiddly).
  Commit to PDF.js.

## After the rewrite

- The user's smoke test for it is just `C-x C-f` to a `.pdf` file.
  No automated arm yet — drive it in the live app. Try:
  - A small text-only PDF (page nav, find).
  - A multi-page PDF with images (rendering, zoom).
  - A large PDF (Range streaming, scroll perf).
  - Open two PDFs in the same tabline, switch between them
    (per-tab `_pdfDoc` should survive).
  - Open one in pane A, open the same one in pane B — Q9
    auto-duplicate should give two independent `_pdfDoc` instances.
- Add a regression smoke arm only if you can find a small reliable
  test PDF; PDF.js loading from a URL inside an Electron smoke is
  achievable but more involved than text/audio arms.

## The three worktree branches under `.claude/worktrees/`

These are leftover artefacts from parallel sub-agent runs earlier in
the session. They're locked because `git worktree` won't remove a
locked worktree without `--force`. Their commits are all in main now.

| Branch | Path | What it was for | What to do |
|---|---|---|---|
| `worktree-agent-a5c166ffa5919ceb1` | `.claude/worktrees/agent-a5c166ffa5919ceb1` | PDF-view sub-agent's worktree (`feat(pdf-view): …` commits, now in main). | Worktree can be removed with `git worktree remove --force .claude/worktrees/agent-a5c166ffa5919ceb1`, then `git branch -D worktree-agent-a5c166ffa5919ceb1`. |
| `worktree-agent-ae003d3c98574ae31` | `.claude/worktrees/agent-ae003d3c98574ae31` | Browser-view sub-agent's worktree (`feat(browser-view): …` commits, now in main). | Same cleanup pattern. |
| `worktree-agent-ae6e40fc9c135284f` | `.claude/worktrees/agent-ae6e40fc9c135284f` | The **first** browser-view sub-agent attempt. It stopped on entry because its worktree was forked from `main` rather than the views-phase-4-deep base, wrote a note, and never committed any browser work. Its HEAD is back at the base commit. | Same cleanup pattern — there's nothing in it. |

If you're starting fresh on PDF-view Option B, none of these
worktrees are relevant to your work; they can be removed at any
time. They're not on the critical path.

## Branch / commit hygiene for the next session

- Make a new branch from `main`, e.g. `pdf-view-pdfjs`. **Do not
  work directly on main.**
- Commit frequently (per `CLAUDE.md`). Each logical unit — "add
  pdfjs-dist dependency", "replace pdf-view internals with PDF.js
  load + render", "add chrome toolbar", "wire keymap j/k/find", —
  is its own commit.
- Run smoke + unit tests before each commit; never leave the suite
  broken.
- When done, hand off to the user for live testing in the running
  app before merging.

## Quick context for what state main is in

```
e2f2d1a docs(views): capture the per-view-instance invariants and bug catalogue
10d345e fix(panes): cross-pane tab click respects focus + neighbour text-views
18290fa fix(tabline): hide-inactive only addresses leaf-direct text-views
ddb9eb4 fix(session): shift currentViewIndex when the post-restore seed-splice fires
8a06585 fix(tabline): clip tabline-content so tabs can't overspill into the strip
c584c0a test(smoke): add-pane mode + C-u flip arm
2d4d3bf feat(panes): C-u flips the side of C-x 2 / C-x 3
7ed5714 feat(panes): add-pane mode — visual macro for inserting a pane
d8ef890 feat(panes): host + Lisp surface for add-pane-at-splitter/border
761e43a feat(pane): insertAtSplit / insertAtRootBorder primitives
f983fcc feat(browser-view): CSS for <browser-view> — toolbar + content
a8b9082 feat(browser-view): app.js integration + open-url! primitive
804a3ed feat(browser-view): BrowserView custom element + renderer export
6f75dda feat(pdf-view): CSS for <pdf-view> — flex column, full pane height
9da4cfc feat(pdf-view): enable Electron's <webview> tag
2cca5a6 feat(pdf-view): route .pdf files through the pdf view on open
```

Smoke passes cleanly. The replace-string failure that masked many
other arms is gone. `bug2` and `bug3` arms (close-tab independence,
cross-pane tab click) both pass.
