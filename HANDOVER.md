# Handover — jmacs session 2026-05-25

A snapshot for resuming work on **jmacs** in a fresh session. Read
`CLAUDE.md` first — it carries the standing working agreements
(branching, commits, testing discipline, territory). This file is the
where-things-stand record. The previous handover (sessions 23/24) is
preserved in `git log` against `0af6fc0`; this one supersedes it.

## Where main is

HEAD: `96ea97b` (`feat(faces): describe-face shows tree-sitter node
when no capture fires`). **All test suites green across every
package.** Eight branches landed this session, and three small
direct-to-main commits cleaned up follow-ups (see "Direct-to-main
commits" below).

Main now carries everything from the prior session's "ready for
review" list except the nine still-pending branches (see below). The
session's work made the editor noticeably more cohesive — face
customisation, contrast-bumped tree-sitter palettes, jukebox metadata
+ embedded art, resizable panes, the diagnostic `C-h F` with a node-
type fallback, and more.

## Landed this session

Merge commits, top of `main`:

| Commit | Branch | Brought in |
|---|---|---|
| `c77b4fd` | `agent-describe-face` | `describe-face-at-point` (`C-h F`), q-to-kill in doc view, view setBuffer redraw fix |
| `bde59f6` | `agent-resize-panes` | drag-resizable REPL + markdown-preview panes |
| `b43f357` | `agent-audio-metadata` | MP3/MP4/OGG metadata parsers + `*jukebox-track-format*` |
| `fa18e78` | `agent-jukebox-art-keys` | embedded ID3v2 APIC + MP4 covr art; chord-key passthrough |
| `0e751ea` | `agent-syntax-pass` | Sublime-style queries for Python/TS/Rust/Go/Bash/CSS/HTML + theme contrast bump |
| `7707a1b` | `agent-face-customisation` | `defface` + override layers + `faces.json` persistence + customize UI |
| `75e4365` | `agent-face-inheritance` | face inheritance via `from PARENT` syntax |

Direct-to-main commits, applied on top:

| Commit | What |
|---|---|
| `3012405` | `feat(faces): variable face + JS parameter captures` — new `defface 'variable`, parameter captures in JS query |
| `734dfbb` | `fix(themes): match Sublime Mariana's editor background` — sRGB pre-compensation, `--bg-editor` is `#2e3842` |
| `96ea97b` | `feat(faces): describe-face shows tree-sitter node when no capture fires` — `C-h F` falls back to node type + ancestor chain + query template |

The bug-fix commits on `agent-describe-face` (before merge) are worth
noting: a recursive `smallest-covering-capture` was overflowing the
stack on real buffers (fixed with `reduce`), the doc view was
swallowing `q` into the hidden text buffer, and `view.setBuffer`
short-circuited on same-buffer calls so the underlying source didn't
redraw after killing a doc/customize view.

## Branches still ready for review

Nine left from the prior session's pile. All are on top of `3fa211a`
(or `3fa211a` plus the agent-custom-views merge). Each is green on
its own branch but unmerged.

| Branch | HEAD | What it adds |
|---|---|---|
| `agent-regex-search` | `0305696` | `C-M-s` regex isearch, `C-M-%` regex-replace, `M-%` query-replace |
| `agent-latex` | `5cf4fc9` | LaTeX wasm built via Docker + TikZ-aware query |
| `agent-folding` | `7e269e2` | Tree-sitter code folding for 8 languages |
| `agent-multi-cursor` | `484b430` | Selection-set buffer + renderer foundation. **⚠ Lisp file uses `hash-set` which doesn't exist; needs `assoc` fix** |
| `agent-lsp` | `3f3a666` | TypeScript LSP, diagnostics + hover |
| `agent-file-nav` | `074adab` | Fuzzy project find-file + sidebar tree |
| `agent-session` | `5c9e7eb` | Tabline (drag-reorder) + persistent session restore |
| `agent-chord-find-file` | `3f0aa1d` | Chord prefix in minibuffer + minibuffer find-file with tab-complete + Cmd+O native dialog |
| `agent-reactive-notebook` | `d453841` | Reactive Lisp notebook (engine phase) |

### Suggested merge order

The Sublime-style query work already landed, so the surviving order is:

1. `agent-regex-search`
2. `agent-latex`
3. `agent-folding` — touches view.js; first non-trivial conflict surface
4. `agent-multi-cursor` — apply the `hash-set` → `assoc` fix first, then merge
5. `agent-session` — tabline; touches index.html, app.js, styles.css
6. `agent-chord-find-file` — rebinds `C-x C-f`
7. `agent-lsp` — largest standalone surface; touches app.js
8. `agent-file-nav` — sidebar tree; touches index.html, app.js, styles.css
9. `agent-reactive-notebook` — last; complete on its own

Expected conflict surfaces (still all additive in practice — keep both sides):

- `apps/desktop/scripts/smoke.js` (every branch adds an arm)
- `apps/desktop/src/app.js` (LSP, file-nav, session all add primitives)
- `packages/stdlib/lisp/keymap.lisp` (chord-find, multi-cursor, folding all add bindings)
- `packages/stdlib/src/index.js` (everyone adds a `.lisp` file to `STDLIB_FILES`)
- `apps/desktop/styles.css` (session, folding, file-nav all add rules)

## In flight / queued

Two new agents in motion as of this writing:

- **`agent-language-pack`** (running, autonomous, background). Building
  tree-sitter highlighting for 22 new languages in tiers — mainstream
  (C, C++, Java, C#, Ruby, Lua, YAML, TOML), FP (Haskell, OCaml,
  Erlang, Elixir, Clojure, Scheme), specialty (SQL, Dockerfile, Nix,
  XML, GraphQL), JVM/Apple (Kotlin, Swift, Zig). One commit per
  language, plus an aggregated smoke arm at the end. Extends
  `scripts/build-grammars.sh` for grammars without prebuilt `.wasm`.
- **`agent-media-views`** (queued; fires after the language-pack
  agent completes). Will add buffer/view support for video and audio
  files — opening a `.mp4`, `.mp3`, etc. should bring up the right
  HTML5 `<video>` / `<audio>` element through a native view, not be
  read as text. Builds on `image-view.js` and `jukebox-view.js` as
  templates, and on the merged `audio-metadata.js` / `audio-art.js`
  for metadata + cover.

## Architecture decisions worth preserving

Carried forward from the prior handover with light updates:

1. **Lisp at the seams; JS at the engine.** Lisp for keymaps,
   commands, hooks, modes, themes, customisation — anything the user
   might override. JS for buffer storage, rendering, parsing, IO,
   anything hot. Host primitives are the seam. Rough test: "if it
   calls itself in a tight loop, or touches every character in a
   buffer, it's JS."

2. **Custom views as a documented abstraction.** New buffer kind →
   new `packages/renderer/src/<name>-view.js` → mount in `app.js`'s
   `switchToBuffer` kind dispatch → set `buffer.kind = '<name>'` on
   creation. See `docs/CUSTOM-VIEWS.md`. The jukebox refactor was
   the forcing function; the queued media-views agent will extend
   this further for video/audio file kinds.

3. **Faces are first-class data, not CSS variables.** A face is a
   typed value (`(face :foreground ... :weight ... ...)`). Inheritance
   via `from PARENT`. Resolution: parent chain (bottom-up) → user
   global → user per-theme → CSS rule generated by `face-styles.js`.
   Now 14 built-ins — `variable` was added this session for parameter
   declarations (Sublime-style: only declarations get the face,
   references in the body read as default text).

4. **The map-update primitive is `assoc`, never `hash-set`.** Three
   agents tripped on this in the prior session; `agent-multi-cursor`
   is still broken because of it. Any new `.lisp` file using
   `hash-set` will not load.

5. **Sync Lisp is a feature, not a bug.** User code can reason about
   state because the interpreter is synchronous. Don't make the
   interpreter async to "improve concurrency" — see Phase 1 / Phase 2
   below if isolation becomes necessary.

6. **`Cmd`/`Meta` maps to `C-` in this editor's key normalisation.**
   To bind native `Cmd+O`, use the Electron application menu
   accelerator (`menu.js`'s `CmdOrCtrl+O`), NOT a Lisp keymap binding
   — the latter collides with `C-o` (`open-line`).

7. **Chromium colour-manages CSS; Sublime writes native pixels.**
   The dark theme's `--bg-editor` is `#2e3842` — looks "wrong" vs
   Mariana's documented `#303841`, but that's the sRGB
   pre-compensation needed so jmacs's rendered native pixel lands on
   Sublime's `(48, 56, 65)`. Same shift probably needs applying to
   the rest of the dark palette (see "Known issues" — muted colours).

## Known issues / paper cuts

- **Binding displacements still pending** for the unmerged branches
  (taste calls only Jason can make):
  - `M-d`: was `kill-word`, multi-cursor wants `add-cursor-next`. Displaced to `M-S-d`.
  - `C-l`: was `recenter`, multi-cursor wants `select-all-matches`. Displaced to `C-M-l`.
  - `K`: was self-insert for shift-K, LSP wants `lsp-hover`. Vim convention; worth confirming.
  - `C-x p`: was `toggle-repl`, file-nav wants `find-file-in-project`. `toggle-repl` still reachable via `M-x`.
- **Multi-cursor branch still ships broken** (`hash-set` typo). Five-minute fix:
  - `sed -i.bak 's/hash-set/assoc/g' packages/stdlib/lisp/multi-cursor.lisp`
  - Add `'multi-cursor.lisp'` to `STDLIB_FILES` in `packages/stdlib/src/index.js`.
- **agent-folding changes `loadLanguageHighlighters` return shape** —
  `{ highlighters, foldCaptures }` instead of just `highlighters`.
  Several merged branches now touch the same call site, so the
  conflict resolution will be slightly more involved than it was at
  the start of the session.
- **Token colours feel washed-out vs Sublime.** Jason flagged this
  during the bg-editor matching work; almost certainly the same
  sRGB-vs-native colour-management split as the background. Saved in
  memory; he wants to be involved in the palette decisions.
- **`docs/MANUAL.html` and `docs/reference/*.html`** are pre-existing
  untracked build artefacts. Ignore.

## Plan documents

In `plans/`:

- `LANGUAGE-INJECTION.md` — design for tree-sitter language injection.
  Implementation merged.
- `REACTIVE-NOTEBOOK.md` — design for the reactive notebook. Phase 1
  on `agent-reactive-notebook`. Phase 2 (HTML view) deferred.
- `FACE-CUSTOMISATION.md` — face customisation design. Implementation
  merged this session (`agent-face-customisation` + `agent-face-inheritance`).

In `docs/`:

- `CUSTOM-VIEWS.md` — the how-to for wiring a custom HTML view to a
  buffer. The queued media-views agent will follow this pattern.

## What's missing — the headlines

Roughly unchanged from the prior handover, in order of impact:

1. **Splits / multiple panes.** L2 buffer abstraction supports this;
   renderer doesn't yet. Worth a plan doc before code (`plans/PANES.md`).
2. **LSP autocomplete.** Diagnostics + hover without completion feels
   half-done. Foundation exists in `packages/lsp/`; agent-lsp lands
   the first half.
3. **Git integration.** Diff in the gutter, blame, basic conflict UI.
4. **Performance proven at scale.** Large files, large projects,
   multi-hour sessions — none tested.
5. **Process isolation for user code.** The real architectural debt.
   See Phase 1 proposal below.
6. **A real README + 60-second demo.** The thesis isn't visible
   without it.

## Process isolation — Phase 1 proposal

The actual problem is two distinct things:

- (A) A runaway user macro freezes the UI. (Bug case.)
- (B) Heavy user computation blocks the UI thread. (Workload case.)

**Phase 1 — cooperative scheduling + interruptibility** solves (A) at
low cost without breaking sync semantics or the Lisp/JS seam:

- Add a step budget to `eval.js`'s eval loop (check every N forms or
  every M ms).
- A `C-g` interrupt sets a flag the loop reads; the loop throws a
  `LispInterrupt` that the top-level handler catches.
- Top-level commands taking longer than ~500 ms prompt the user in
  the minibuffer ("still running, kill?").

Implementation: ~200–300 lines in `eval.js` plus a host primitive for
the interrupt flag. No seam changes; no serialisation; no async
refactor. Highest-leverage architectural fix available.

**Phase 2 — worker-thread Lisp for explicit-async** is only worth
doing if (B) becomes a real workload. Don't pre-emptively. If needed:
an `(in-background EXPR)` primitive that ships work to a worker and
returns a future. Sync semantics for the 99% case stay intact.

Explicitly do NOT:

- Move the whole Lisp interpreter to a worker by default — the
  Lisp/JS seam becomes message-passing, tenfold slowdown on the hot
  path, sync semantics lost.
- Run Lisp in a hidden BrowserWindow. Way too heavy.
- Try thread-level isolation in V8. Doesn't exist for user code
  without workers.

## Workflow lessons

Refined this session:

1. **Sequential single-agent works cleanly.** Each agent commits to
   its own branch from the same checkout; no leaks because there's no
   isolation to fail. Parallel worktree agents still fail (`cd`
   resets between Bash calls; agents drift out of their worktree).
2. **`--no-ff` merges for every branch landing.** The merge bubble
   (`merge: agent-X (one-line description)`) is the established
   pattern; `git log --merges main` reads as a feature changelog.
3. **Conflict resolution is mostly keep-both.** The 8 merges this
   session triggered conflicts on the same files (`smoke.js`,
   `app.js`, `themes.lisp`, `styles.css`, `preload.mjs`,
   `files.js`); all but `themes.lisp` were trivial keep-both. The
   exception: `agent-face-customisation` restructured `themes.lisp`
   to move `--tok-*` out of the theme hash-maps and into `defface`
   defaults, which had to be reconciled with the contrast bump from
   `agent-syntax-pass`.
4. **Direct-to-main is fine for small polish.** Jason prefers it for
   single-file follow-ups (a face value, a hex tweak, a diagnostic
   improvement). Branch + merge stays the default for anything
   feature-sized. Memory note saved.
5. **Agents make local design calls.** Binding displacements, API
   shape changes (e.g. `loadLanguageHighlighters` return shape), new
   primitives. Read the report carefully before merging.
6. **The `hash-set` mistake repeats.** New agents who haven't seen
   the codebase invent it. The map-update primitive is `assoc`.
7. **Smoke arms keep the contract.** Every agent should add one
   contiguous smoke arm at the bottom of `scripts/smoke.js`. Merging
   that file is then trivially additive.
8. **Plan docs first for design-heavy work.** The face customisation
   system went well because the plan was written and approved before
   the build. Mechanical work (drop-in language grammars, simple view
   additions) can skip the plan and go straight to a brief.

## The Lisp/JS principle

When adding a feature, ask:

- Is there a place where the user might want to extend behaviour?
  → Lisp surface.
- Is there a tight inner loop?
  → JS implementation; Lisp calls a primitive.
- Is there both?
  → Thin Lisp wrapper over a JS engine. (See `faces.lisp` calling
  `apply-face-styles!`; `regex-search.lisp` calling
  `replace-regexp-all!`; `jukebox.lisp` calling `play-audio!`.)

The seam — host primitives — was built in from day one. That makes
"move it to JS" a small refactor, not a runtime change.

## Branch hygiene

Twenty-one merged-but-still-named branch refs were deleted this
session via `git branch -d` (Git's safety-checked deletion — refuses
unless the branch is fully merged into HEAD). Commits stay reachable
through main's merge history; the refs just stopped cluttering
`git branch`. Worth doing again after the next merge batch.

## Suggested next steps in priority order

1. **Let the agents finish.** `agent-language-pack` is mid-run;
   `agent-media-views` is queued. Review their final reports, merge
   their branches as usual.
2. **Merge the surviving review queue.** The nine branches above. Half
   a day if conflicts behave; the multi-cursor `hash-set` fix is the
   only known blocker.
3. **Phase 1 interruptibility.** Single highest-leverage
   architectural work. Removes the only real "I had to force-quit"
   failure mode.
4. **Investigate the muted-palette issue.** Probably the same sRGB
   pre-compensation as the background; Jason wants involvement in the
   colour choices. Could be a one-evening pass.
5. **Daily-drive for a week.** Note paper cuts; don't fix them yet.
6. **A real README + 60-second demo.** Install instructions; thesis
   in two sentences.
7. **Splits** — start with `plans/PANES.md`. A few days of careful
   work; deserves a design pass first.
8. **LSP autocomplete** as a separate session, after `agent-lsp` lands.

---

The story so far: a Lisp-extensible editor with a custom dialect, an
Electron presentation layer, real tree-sitter highlighting (about to
become 33 languages), a face system you can customise with `M-x
customize-faces`, a documentation surface, a working jukebox with
album art and metadata, drag-resizable panes, a diagnostic for
syntax highlighting that tells you what to write if a face is
missing, and a colour scheme pre-compensated to match Sublime
Mariana. Nine branches still in the queue and two more in flight.
