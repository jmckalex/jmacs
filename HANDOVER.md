# Handover — jmacs session 2026-05-28 (citations + pane moves + package plan)

A snapshot for resuming work on **jmacs** (renaming to **Godot** —
see "Naming" below) in a fresh session. Read `CLAUDE.md` first — it
carries the standing working agreements (branching, commits, testing
discipline, territory). This file is the where-things-stand record.

The prior handover (2026-05-27, multi-cursor merge + stretch) is
preserved in `git log` against `3455602`; this one supersedes it.
The chain back: phase-3b polish at `0b596f5`, phase-3b landing at
`f09ec46`, phase-3a landing at `bff550a`.

This session was lighter than the previous: **two feature commits**
(citation.js + pane-move surface), **one major plan document**
(`plans/PACKAGES.md`), an **off-repo marketing site** for Godot, and
a **rename intent** about to land. The big next step is shipping the
package system; the plan document is the entry point.

## Where main is

HEAD: `9c06bea` (`feat(citation): vendor citation.js + Lisp surface
for bibliographies`).

**All test suites green (1030/1030 — +3 from the prior handover's
1027: +4 pane-primitives for move-tab! / swap-panes!, −1 net from
test renumbering during the citation work). Smoke arms unchanged —
no new ones added this session; the multi-cursor smoke arm is still
a known follow-up.**

| package | tests |
|---|---|
| storage | 47 |
| pane | 42 |
| lisp | 68 |
| buffer | 55 |
| view | 34 |
| renderer | 247 |
| desktop | 166 |
| stdlib | 371 |

## Naming

Jason is renaming **jmacs** → **Godot** ("the editor we've been
waiting for" — Beckett). The rename is **intent, not yet executed.**
Open questions for whoever ships the rename:

- Repo name (`jmacs/main` → `Godot/main`? Stay `jmacs`?).
- `apps/desktop/package.json` name field (currently `@editor/desktop`)
  — does it become `@godot/desktop`?
- The Electron `userData` directory derives from the package name.
  Today: `~/Library/Application Support/@editor/desktop/`. After
  rename: `~/Library/Application Support/Godot/` or
  `~/Library/Application Support/@godot/desktop/`? **A migration
  path matters** — users have `init.lisp`, `custom.lisp`,
  `faces.json`, `session.json` in the old location.
- CSS class prefixes (`.editor-line`, `.editor-cursor`, etc.) —
  almost certainly don't rename. They're internal.
- Documentation, comments, READMEs — gradual cleanup as files are
  touched.
- The marketing site already lives under the new name (see below).

Suggested approach: leave the rename to a dedicated session. The
migration logic for `userData` is the only delicate part; everything
else is mechanical search-and-replace.

## Landed this session

Top of `main`, newest first:

| Commit | What |
|---|---|
| `9c06bea` | `feat(citation): vendor citation.js + Lisp surface for bibliographies` |
| `da36cbe` | `feat(panes): move-tab! / swap-panes! + close-pane / send-view commands` |

Below the surface of those two commits:

### `9c06bea` — Citation.js bridge

- **Vendored bundle**: `packages/renderer/vendor/citation-js.esm.js`
  (~1.2MB ESM, built via `scripts/build-citation-js.js`). Includes
  `@citation-js/core` + `@citation-js/plugin-bibtex` +
  `@citation-js/plugin-csl`. esbuild added as a devDep; the build
  script is committed and re-runnable.
- **Renderer wrapper** (`packages/renderer/src/citation.js`):
  `parseCitations` / `formatBibliography` / `formatCitation` /
  `citationKeys`. Handles are JSON-encoded CSL-JSON strings, so the
  Lisp side never sees JS objects.
- **Host primitives** in `app.js`: `citation-parse`,
  `citation-format-bibliography`, `citation-format`, `citation-keys`.
- **Sync file-read primitive**: new `file:read-text-sync` IPC,
  `readFileTextSync` in the preload, `read-file-text!` Lisp
  primitive. General-purpose; `load-bibliography` is its first
  caller.
- **`cite.lisp`**: `*citation-style*` (default `"apa"`) and
  `*citation-bib-path*` (default `""`) defcustoms, plus
  `(load-bibliography path)`, `(load-default-bibliography)`,
  `(format-bibliography handle :style ... :format ... :lang ...)`,
  `(format-citation handle ...)` wrappers.
- **No commands ship** — the intent is for users to build pickers /
  inline-cite expansion / format-on-save in `init.lisp`.

### `da36cbe` — Pane-move surface

- **Host helpers** in `app.js`: `moveTabAcrossTablines` (splice + activate;
  same-tabline = reorder) and `swapPaneViews` (exchange `.view` between
  two leaves, re-mount via the kind registry).
- **paneHost** gains `moveTab` and `swapPanes` closures.
- **Lisp primitives**:
  - `(move-tab! src-tlv src-idx dst-tlv [dst-idx])` →
    destination tabline.
  - `(swap-panes! pane-a pane-b)` → boolean.
  - `(tabline-active tlv)` / `(tabline-tabs tlv)` accessors —
    needed by the commands, useful in general.
- **Lisp commands** in `panes.lisp`:
  - `close-pane` — alias for `delete-pane`, emphasises view-stays-alive.
  - `close-tab` — drop the active tab from the focused tabline;
    view stays in `views[]`.
  - `send-view-to-other-pane` — both ends promote to tabline; the
    active tab moves across.
  - `send-tab-to-other-pane` — alias.
  - `swap-with-other-pane`.
  - `-other-leaf-pane` helper (focus-toggle dance).
- **Bindings** in `keymap.lisp`: `C-x x` (send-view) and `C-x X`
  (swap-with-other-pane).
- **+4 pane-primitives tests**.

## The package plan — `plans/PACKAGES.md` (NEW, uncommitted)

**The most important artifact this session.** A guide-style design
document for an extension package system, in the style of `PANES.md`
(open questions + suggested phasing, not a phase brief).

Status: **uncommitted in the working tree** — Jason asked for "plan,
not implement." Commit it as the first thing in the build session
once the open questions have answers.

Headlines from the plan:

- **A package is a directory** with a Lisp manifest (`package.lisp`),
  source files, optional non-Lisp assets. Same dialect as the rest
  of the editor; the manifest is data.
- **Namespace via convention** in the MVP (prefix-by-package, à la
  Emacs); real module system as a follow-up if the ecosystem
  demands it.
- **Loading between `custom.lisp` and `init.lisp`** in the boot
  pipeline. Autoload stubs by default; `:eager t` for theme
  packages and similar.
- **Three distribution layers**, each useful on its own: local
  install (MVP) → git-based install → centralised registry
  ("GELPA" — naming TBD).
- **Pure Lisp in the MVP**; native code is a separate two-tier
  conversation for later.
- **A `package-list` view-kind** as the user-facing browse surface;
  install / update / uninstall via `M-x`.

**12 open questions** identified explicitly in the plan, including:

1. Namespace approach (convention / modules / implicit).
2. Manifest format (Lisp form / TOML / JSON).
3. Package directory location (`~/.config/Godot/` vs the
   platform's userData).
4. Whether the MVP supports any native code at all.
5. Default-installed packages on a fresh install.
6. Naming (GELPA? Godot Packages? Vladimir's Chest?).
7. Themes-as-packages vs themes-as-special-case.
8. Whether the manifest is evaluated or just parsed.
9. Dependency resolution scope.
10. Test packages.
11. Behaviour when `:godot-version` constraint fails.
12. Recovery when a Godot bump breaks a package.

Suggested phasing (in the plan):

- **Phase 1 — Local packages, manifest, autoload, list-view, pinning.**
- **Phase 2 — Git-based install + updates.**
- **Phase 3 — Centralised registry (GELPA), signing.**
- **Phase 4 (or never) — Native plugins, two-tier extensibility.**

Phase 1 is the substrate the rest builds on. The open questions
above need answers (most of them) before Phase 1 is ready to brief.

## Off-repo: the Godot marketing site

Lives at `~/Sites/jmckalex/software/Godot/`:

- `index.html` — ~1,200 lines, Folio-style sidebar-nav layout, warm
  paper palette, Instrument Serif headings, DM Sans body, JetBrains
  Mono code. Covers: overview, philosophy, quick start, panes /
  tablines, multi-cursor, tabs / indentation, syntax highlighting,
  folding, find-file, directory views, citations, themes, media /
  jukebox, shell, the Lisp dialect, architecture, full keyboard
  shortcut reference, status section with shipped / in-flight /
  planned labels.
- `screenshot-column-view.png`, `screenshot-injection.png`,
  `screenshot-multi-pane.png`, `screenshot-video-preview.png` —
  diagnostic captures from prior sessions, in place as
  placeholders. They show real working features but weren't shot
  as marketing screenshots. Replace as time allows.

Page imports Google Fonts + FontAwesome from CDN — same pattern as
the Folio docs page. Self-contained inline stylesheet; sticky
sidebar with scroll-spy active-link highlighting.

## Pending commits

The **only** uncommitted artifact in the repo is
`plans/PACKAGES.md`. Everything else in `git status` is the
pre-existing screenshot PNG noise (`bug-hunt.png`, etc.) and the
stray `Makefile` from previous sessions. Leave them alone.

Commit `plans/PACKAGES.md` in the next session — probably as
`docs(plans): add PACKAGES.md — package-system design notes` —
after Jason has answered the open questions (or as-is, if Jason
wants the plan committed first and the questions tracked
separately).

## Branches still ready for review

Three remaining, unchanged since the prior handover:

| Branch | HEAD | What it adds |
|---|---|---|
| `agent-reactive-notebook` | `d453841` | Reactive Lisp notebook (engine phase). **Next in the queue** — phase 3b unblocked it. |
| `agent-lsp` | `3f3a666` | TypeScript LSP, diagnostics + hover. |
| `agent-file-nav` | `074adab` | Fuzzy project find-file + sidebar tree. |

The merged-but-stale branches `agent-pane-splits`,
`agent-tabline-view`, `agent-multi-cursor`,
`agent-multi-cursor-rebase` and tag `agent-tabline-view-attempt-1`
all still exist as refs.

## Architecture decisions worth preserving

Carried forward from the prior handover, with one new entry:

1. Lisp at the seams; JS at the engine.
2. View is the addressable on-screen thing; buffer is L2 substrate.
3. Faces as data, not CSS variables.
4. `assoc`, never `hash-set`.
5. Sync Lisp is a feature.
6. `Cmd`/`Meta` maps to `C-`.
7. Chromium colour-manages CSS.
8. Subprocesses go through Python for PTY needs.
9. Per-view-point: cursors live on the view, including the cursor set.
10. Pane-creating commands return handles.
11. Focus stays on the originating pane after split.
12. Tabline-views are not in `views[]`.
13. Non-text active tabs re-parented into the tabline content area.
14. Non-text singletons visible-iff-any-leaf-shows-them.
15. Chord-prefix lookup falls through to the global keymap.
16. `session.currentView` resolves through the pane tree.
17. `*tab-width*` is the only tab-width source of truth.
18. Mode-local indent-tabs preference wins over the global.
19. `:choice` settings round-trip as the original Lisp value.

20. **Citation-handle round-trip is JSON-CSL string.** *New this
    session.* `citation-parse` returns a JSON-serialised CSL-JSON
    array as a Lisp string; every other citation primitive accepts
    that string. The Lisp side never sees JS objects, the marshalling
    is cheap, and the round-trip is debuggable as text in the REPL.

## Known issues / paper cuts

- **Binding displacements still pending** for unmerged branches.
- **Token colours feel washed-out vs Sublime.** Mitigated this
  session by shipping the `bright` theme; the colour-pipeline
  pre-compensation thread is still open.
- **Faint strip at the bottom of the shell view.** Unchanged.
- **Multi-cursor doesn't have a smoke arm.** Carried over.
- **`directory-tree` doesn't yet have the same context menu as
  `directory-columns`.** Carried over.
- **The post-move source pane in `send-view-to-other-pane` can end
  up showing an empty strip.** *New this session.* When a source
  tabline had exactly one tab and the user moves it away, the
  destination is happy but the source's strip is empty. The user
  can `C-x 0` to close the empty pane. Could be auto-collapsed;
  consider in a polish pass.
- **The Godot marketing screenshots are diagnostic captures.**
  They show working features but weren't shot for marketing.
  Replace when convenient.

## Plan documents

In `plans/`:

- `LANGUAGE-INJECTION.md` — implementation merged.
- `REACTIVE-NOTEBOOK.md` — phase 1 on `agent-reactive-notebook`.
- `FACE-CUSTOMISATION.md` — implementation merged.
- `SHELL-V4-XTERM.md` — implementation merged.
- `PANES.md` — guide notes. All 15 open questions resolved.
- `PANES-PHASE-1.md` — merged.
- `PANES-PHASE-2.md` — merged.
- `PANES-PHASE-3A.md` — merged.
- `PANES-PHASE-3B.md` — merged.
- **`PACKAGES.md`** — *NEW THIS SESSION, UNCOMMITTED.* Guide
  notes for a package management system. See the section above for
  the headlines; see the document itself for the full design.

In `docs/`:

- `CUSTOM-VIEWS.md` — still out of date. Now also wants:
  - the directory-columns context-menu / modal pattern;
  - the renderer-side highlighters / virtualisation contract;
  - the citation.js bridge (a precedent for "renderer-vendored
    library + thin host-primitive wrapper").

## What's missing — the headlines

1. **LSP autocomplete.** `agent-lsp` lands the first half.
2. **Reactive notebook.** `agent-reactive-notebook` (next merge).
3. **A package system.** Plan in `plans/PACKAGES.md`; build is the
   next focused session.
4. **Git integration.** Diff gutter, blame, basic conflict UI.
5. **Performance proven at scale.**
6. **Process isolation for user code.**
7. **A real README + 60-second demo.**
8. **PANES phase 4** (multi-window) and **3c** (cross-pane tab drag).
9. **The rename to Godot.**

## Suggested next steps in priority order

1. **Resolve the open questions in `plans/PACKAGES.md`.** Twelve
   of them are listed at the end of the plan; the package system
   can't be briefed until at least the structural ones (namespace
   approach, manifest format, package directory location, native-code
   policy) have answers.

2. **Ship Phase 1 of the package system.** Local packages,
   manifest, autoload, list-view, pinning. The plan describes the
   surface; the implementation brief writes itself off the back of
   the resolved open questions.

3. **The jmacs → Godot rename.** Mostly mechanical; the migration
   logic for `userData` needs a few minutes of care.

4. **Merge `agent-reactive-notebook`.** Was next in the queue
   before package planning displaced it; remains the next branch to
   land once packages are in.

5. **Cleanup pass on branches + tag.** `agent-pane-splits`,
   `agent-tabline-view`, `agent-multi-cursor`,
   `agent-multi-cursor-rebase`, and tag
   `agent-tabline-view-attempt-1` are all still around.

6. **Same context menu for `directory-tree`.** Rename / Trash /
   Reveal carry verbatim from `directory-columns-view.js`. ~30
   minutes.

7. **Multi-cursor smoke arm.**

8. **Rewrite `docs/CUSTOM-VIEWS.md`.**

9. **Investigate the muted-palette / shell-view residual strip
   thread.**

10. **Daily-drive for a week, then a real README + 60-second demo.**

## Workflow lessons (this session)

1. **The "ship plan, not implementation" instruction is load-
   bearing.** Jason asked for a package plan and explicitly told the
   agent not to implement. The result is a substantially better
   plan than would have emerged if it had been mixed with code work
   — the open questions surfaced cleanly precisely because there
   was no pressure to resolve them en route to a commit. Worth
   repeating for any other large design surface.

2. **A 1.2MB vendored bundle is a real cost; admit it.** The
   citation.js bundle is big enough to mention in the commit
   message and to leave a note in the README about. Don't hide
   bundle weight; price it explicitly so future maintainers know
   what they're paying for. Lazy loading is a follow-up if perf
   measurement shows it matters.

3. **Named-let still bites.** Third time this session-series the
   agent reached for `(let loop ((x ...)) ...)` and the dialect
   threw "expected a proper list" at runtime. Should probably
   become a `defmacro` at some point. Until then: tail-recursive
   helper, every time.

4. **Marketing screenshots are not diagnostic screenshots.** The
   screenshots committed to `~/Sites/jmckalex/software/Godot/` are
   real working features captured during debugging — they're
   informative but they don't pop. Worth a focused "marketing
   capture" session once a binary exists to demo.

---

The story so far: a Lisp-extensible editor with a custom dialect, an
Electron presentation layer, real tree-sitter highlighting (36
languages with cross-language injection), a face system customisable
via `M-x customize-faces` (and `M-x customize` for everything else),
documentation, a working jukebox with album art + metadata, a **pane
tree with user-facing splits** (per-view cursors, drag-resizable
splitters, focus indicator), **per-pane tabline-views** (configurable
edge + drag-resizable width, session-restorable, **move-views-between-
panes** primitives + commands), **Sublime-style multi-cursor** (per-
view cursor sets, `C-c d` / `C-c D`, ESC deselect without collapsing,
in-sync blink, faded cursors on inactive panes), **directory views
with all the trimmings** (persisted across restart, context menu with
Rename / Trash / Reveal, syntax-highlighted virtualised preview pane,
open-in-new-tab), find-file with case-insensitive completion,
drag-resizable preview/REPL splitters, a diagnostic `C-h F` for
syntax highlighting, double-click-to-open, chord-prefix display in
the echo area with global-fallthrough, `M-x shell` running on
xterm.js, tab-width / indent-tabs settings with mode-local overrides
(Makefile gets real tabs), folding with chevron + closing-token
preview + yellow ellipsis + void-element filter, a **four-theme
palette** (dark / bright / light / midnight) reachable from `M-x
customize`, **citation.js for BibTeX / CSL formatting** with a thin
Lisp wrapper, and a **package management plan** ready to brief once
the open questions are settled. The renaming to Godot is the
threshold the next session crosses on its way to building Phase 1 of
the package system.
