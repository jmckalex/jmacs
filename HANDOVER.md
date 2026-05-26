# Handover — jmacs session 2026-05-26

A snapshot for resuming work on **jmacs** in a fresh session. Read
`CLAUDE.md` first — it carries the standing working agreements
(branching, commits, testing discipline, territory). This file is the
where-things-stand record. The previous handover (2026-05-25) is
preserved in `git log` against `96ea97b`; this one supersedes it.

## Where main is

HEAD: `d2a061e` (`merge: agent-shell-buffer-v4 — xterm.js terminal
grid`). **All test suites green (843/843); the desktop smoke passes
end-to-end including the v4 shell arm with [pty], resize, and the
RPROMPT timestamp visible (ZLE is back on under the new model).**

The session's headline: **shell v4 landed.** A real terminal emulator
(xterm.js) replaced the line-oriented v3 transcript, fixing curses
apps (vi, htop, less) and full ZLE/RPROMPT prompt fidelity. Resize
travels through a new fd 3 sidechannel that the python pty helper
ioctls onto the master. Before v4, the session also: fixed an
invalid `permissions.defaultMode` in `.claude/settings.json`, and
authored `plans/PANES.md` as design notes for the next big reshape
(window/pane/view + multi-window + view-without-buffer).

## Landed this session

Merge bubbles + direct-to-main, top of `main`:

| Commit | What | Notes |
|---|---|---|
| `d2a061e` | `merge: agent-shell-buffer-v4 — xterm.js terminal grid` | **v4.** Full rewrite of `shell-view.js` on top of `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0`. `feedLiveLine` and `ansi.js` deleted (424 + 249 lines gone, plus ~660 CSS lines). Resize via fd 3 → `TIOCSWINSZ` on the master. Cmd+C copies the xterm selection, OS-default otherwise. Theme bridge reads `--bg-editor` / `--fg` / `--ansi-*` via `getComputedStyle` and rebuilds on theme switch. Five fix commits on the v4 branch before merge: TDZ on `themeListeners` from hoisting asymmetry; vendor stylesheet load order; xterm-viewport black background; single-render-path via transparent canvas + `allowTransparency`; Hard Reload menu entry. |
| `27a3051` | `chore(settings): fix invalid permissions.defaultMode value` | `/doctor` flagged `"ask"` as not a valid mode. Changed to `"default"`; the `allow`/`deny`/`ask` rule arrays already encode the prompt behavior. |
| `0b12776` | `fix(shell-view): treat \r\n as one line terminator` | (v3-era; superseded by v4.) The bug that made `ls`/`pwd` show empty output. Tty driver converts output `\n` → `\r\n`; v3's `feedLiveLine` was treating the `\r` as a rewind and wiping the line before `\n` flushed it. |
| `8a5fd40` | `feat(shell-view): inline input + CR/BS-aware streaming` | v3: GitKraken-style. Bottom input bar gone; typing in a contenteditable inline at the end of the transcript, alongside whatever partial line the shell last emitted. `feedLiveLine` single-line terminal emulator handles `\r`/`\b`/`\n`. PTY now sets ECHO off on the master in the parent (atomic before any input). |
| `7882c28` | `fix(make): use \\\" inside template literal` | The makefile highlighter was failing to load at startup with "Bad node name 'paren'". The JS template literal was unescaping `"\""` → `"""` (three literal quotes); tree-sitter parsed that as two empty strings + a stray `"`, then choked on the `@paren` after. Doubled the backslash. |
| `f8d3679` | `fix(shell-view): disable zsh ZLE under pty + drop duplicate echo` | v2 was double-rendering commands (zsh's per-char ZLE echo + our local echo). Pass `+Z` to zsh (`--noediting` to bash). Suppress local echo when pty is on. |
| `e3255ab` | `merge: agent-shell-buffer-v2` | v2 — PTY backing via inline `python3 -c 'pty.spawn(...)'` (BSD `script(1)` doesn't work from Node — see `architect-notes.md`), full ANSI parser (`packages/renderer/src/ansi.js`), styled spans for output, `[pty]`/`[pipe]` adornment in the header. |
| `022ef15` | `merge: agent-shell-buffer` | v1 — line-oriented shell. Pipes + no ANSI. Subsumed by v2/v3 but left in git as a stepping stone. |
| `9e72d48` | `feat(grammars): tree-sitter Make + Perl` | Direct-to-main. Make's wasm came prebuilt from npm; Perl's was built from upstream because the npm tarball is missing `lib/primitives.js` (a grammar.js dependency). Both auto-discovered like the other 34 languages. |
| `d79528d` | `merge: agent-chord-find-file` | Chord prefix in echo area (`C-x-` etc.) + minibuffer find-file with TAB completion. Cmd+O still does the native dialog. Reconciled two `show-status!`/`clear-status!` primitive definitions that collided — chord display now writes to the echo area; query-replace's "Replace? y/n/q/!" prompt goes there too. |

The shell-buffer chain spans seven commits between `a01a218` and
`0b12776` — that's the v1 + v2 work landed as `--no-ff` merges with
their full sub-commit history preserved. Three subsequent fixes
were direct-to-main once v3 was already on main (the user prefers
small polish committed directly rather than branched + merged).

## Branches still ready for review

Four left after a branch cleanup on 2026-05-26 that deleted 20
fully-merged branches and removed the v4 worktree. Audit at cleanup
time also corrected the prior handover's stale claim that
`agent-regex-search`, `agent-latex`, `agent-folding`, and
`agent-session` were unmerged — git confirmed all four were already
reachable from main, so they got deleted with the rest. The four
remaining branches have unique work not yet on main:

| Branch | HEAD | What it adds |
|---|---|---|
| `agent-multi-cursor` | `484b430` | Selection-set buffer + renderer foundation. **⚠ Lisp uses `hash-set` which doesn't exist; needs `assoc` fix** |
| `agent-lsp` | `3f3a666` | TypeScript LSP, diagnostics + hover |
| `agent-file-nav` | `074adab` | Fuzzy project find-file + sidebar tree |
| `agent-reactive-notebook` | `d453841` | Reactive Lisp notebook (engine phase) |

`agent-shell-buffer-v4` merged this session via `d2a061e` and the
branch ref was deleted in the cleanup. Same for the v1/v2 shell
branches and a long list of older work whose branches outlived their
merges.

### Suggested merge order

1. `agent-multi-cursor` — apply the `hash-set` → `assoc` fix first, then merge
2. `agent-lsp` — largest standalone surface
3. `agent-file-nav` — sidebar tree
4. `agent-reactive-notebook` — last; complete on its own. **Natural
   canary for the PANES.md view-without-buffer model** — its
   notebook view is exactly the kind of view that shouldn't need a
   buffer underneath. Worth doing the view/buffer split (PANES phase
   1) before merging this branch so it lands on the new model.

Expected conflict surfaces (still mostly additive, keep-both):
`apps/desktop/scripts/smoke.js`, `apps/desktop/src/app.js`,
`packages/stdlib/lisp/keymap.lisp`, `packages/stdlib/src/index.js`,
`apps/desktop/styles.css`.

## In flight / queued

- **Panes / windows / view-as-primary reshape.** `plans/PANES.md` was
  authored this session as guide notes for a detailed plan later.
  Three coupled changes: view (not buffer) becomes the addressable
  top-level thing, with buffer kept as the L2 substrate for
  text-editing views; replace the single-window pane code with a real
  pane tree (rectangular box model, flat-leaf DOM, `<div class="pane">`
  siblings absolute-positioned from a JS-owned tree); allow multiple
  OS windows. The doc lists 15 open questions Jason needs to settle
  before implementation begins. Non-goal: non-rectangular pane
  shapes (he asked; the answer is in the doc).

  Sequencing in the doc: (1) view/buffer split with no UI change,
  (2) pane tree with a single pane, (3) expose splits, (4) multi-
  window. Each phase is mergeable. The biggest open call is whether
  the Lisp VM moves into the main process under multi-window — the
  doc leans toward yes (cleanest, most work).

  Worth coordinating with the queued `agent-session` branch, whose
  tabline + restore design embeds buffer-as-target assumptions that
  this reshape would invalidate.

## Architecture decisions worth preserving

Carried forward, lightly updated:

1. **Lisp at the seams; JS at the engine.** Unchanged.

2. **Custom views as a documented abstraction.** Now ten kinds
   (text, customize, image, doc, jukebox, audio, video,
   directory-tree, directory-columns, shell). The pattern is stable:
   new buffer kind → new `packages/renderer/src/<name>-view.js` →
   mount in `app.js`'s `switchToBuffer` kind dispatch → set
   `buffer.kind = '<name>'` on creation. See `docs/CUSTOM-VIEWS.md`.

3. **Faces as data, not CSS variables.** Unchanged.

4. **The map-update primitive is `assoc`, never `hash-set`.** Still
   the most-repeated mistake. Multi-cursor branch still ships
   broken because of it.

5. **Sync Lisp is a feature, not a bug.** Unchanged.

6. **`Cmd`/`Meta` maps to `C-` in key normalisation.** Unchanged.

7. **Chromium colour-manages CSS; Sublime writes native pixels.**
   Same `--bg-editor` = `#2e3842` story. The token-colour palette
   may still need the same shift; not investigated this session.

8. **Subprocesses go through Python for PTY needs.** Recorded in
   `architect-notes.md` (the entry from `agent-shell-buffer-v2`).
   BSD `script(1)` doesn't work from Node — it `tcgetattr`s stdin at
   startup and bails when stdin is a pipe. `python3 -c '<pty.spawn>'`
   is the cross-platform substitute (macOS ships python3; Linux
   distros do too). Falls back to plain pipes when python is
   missing.

## Known issues / paper cuts

- **Binding displacements still pending** for unmerged branches
  (taste calls only Jason can make). Same list as the prior handover.
- **Multi-cursor branch still ships broken** (`hash-set` typo).
  Five-minute fix:
  - `sed -i.bak 's/hash-set/assoc/g' packages/stdlib/lisp/multi-cursor.lisp`
  - Add `'multi-cursor.lisp'` to `STDLIB_FILES` in `packages/stdlib/src/index.js`.
- **Token colours feel washed-out vs Sublime.** Unchanged from prior;
  same sRGB-vs-native split as the background. Jason wants to be
  involved in palette decisions.
- **Faint strip at the bottom of the shell view.** Sub-cell residue
  where the `.xterm-viewport` extends past the cell-aligned canvas.
  Four fixes were tried during the v4 hand-off (viewport background
  override; vendor stylesheet load order; transparent canvas + single
  CSS painter via `allowTransparency`; Hard Reload menu entry to rule
  out cache). Each made it better but the strip is still visible to
  Jason. Same colour-management family as the muted-palette and
  Sublime-bg-precompensation threads — Chromium's canvas vs DOM paint
  pipelines render the same hex slightly differently, and the residual
  difference appears to survive even with the canvas transparent
  (suggesting the residual is somewhere else: possibly compositor /
  GPU layer boundaries). Jason chose to ship and revisit. Carry this
  into whatever palette / colour-pipeline work happens next.

## Plan documents

In `plans/`:

- `LANGUAGE-INJECTION.md` — implementation merged.
- `REACTIVE-NOTEBOOK.md` — phase 1 on `agent-reactive-notebook`.
- `FACE-CUSTOMISATION.md` — implementation merged.
- `SHELL-V4-XTERM.md` — implementation merged this session (`d2a061e`).
- `PANES.md` — **new this session.** Guide notes for window/pane/view
  reshape + multi-window + view-without-buffer. 15 open questions
  for a later detailed plan.

In `docs/`:

- `CUSTOM-VIEWS.md` — the how-to for wiring a custom view.

## Tree-sitter inventory

After this session: **36 vendored grammars** (34 user-facing, two
companions: `markdown-inline` and `php_only`). The full list:

- **C-family / systems**: c, cpp, csharp, java, kotlin, swift, rust,
  go, zig
- **Scripting / dynamic**: python, ruby, **perl** (new), php, lua,
  javascript, typescript
- **Functional**: haskell, ocaml, erlang, elixir, clojure, scheme
- **Markup / data**: html, xml, json, yaml, toml, css, markdown,
  latex
- **Shell / infra**: bash, dockerfile, nix, **make** (new — replaces
  the hand-tokenized fallback)
- **Query languages**: sql, graphql

The hand-tokenized makefile fallback in `packages/renderer/src/highlight.js`
stays in place — fires only if `tree-sitter-make.wasm` fails to load.

## Memory / preferences saved

- **Direct-to-main commits are fine for small polish.** Branch +
  merge stays the default for feature-sized work. Jason confirmed
  during this session (the make/perl grammars and the three shell
  fixes went directly).
- **"There's no point doing a halfway house."** Settled on xterm.js
  for v4 rather than extending the line-oriented view further.

## What's missing — the headlines

1. **Settle the PANES.md open questions and start the reshape.**
   `plans/PANES.md` has 15 calls only Jason can make. After that:
   view/buffer split first (no UI change), then the pane tree.
2. **LSP autocomplete.** Diagnostics + hover without completion feels
   half-done; `agent-lsp` lands the first half.
3. **Git integration.** Diff gutter, blame, basic conflict UI.
4. **Performance proven at scale.**
5. **Process isolation for user code.** The real architectural debt.
   See the Phase 1 proposal in the prior-prior handover (`git show
   96ea97b -- HANDOVER.md`).
6. **A real README + 60-second demo.**

## Workflow lessons (this session)

1. **Three iterations on the shell were the right move.** v1 → v2 → v3
   each shipped with a tested working state before the next attempt
   built on top. The user took screenshots from the running app
   between iterations; "shell-bug.png" → "v2 worked but had per-char
   echo" → "no-output.png" each surfaced a real regression that
   couldn't have been caught by the smoke alone. Plan, build, try
   live, iterate.
2. **JS template-literal escape rules bite.** Two bugs this session
   were one in each direction: `"\""` in `make.js` produced three
   literal quotes (tree-sitter choked); a backtick in a smoke
   comment broke the outer `executeJavaScript(\`...\`)` and crashed
   Electron on launch. Worth a memory note: when writing
   non-JS-source inside a JS template literal, audit for `\"`, `\``,
   and `${`.
3. **`node --check` is fast triage.** Both crashes above were caught
   in seconds by running `node --check` over the changed files —
   faster than re-launching Electron.
4. **The pty-from-Node trap.** BSD `script(1)` fails because of
   `tcgetattr(stdin)` on a pipe. Recorded in `architect-notes.md`
   and now in the architecture-decisions list above.
5. **Tty ECHO race.** Setting termios in the child after `pty.fork`
   races against bytes that may already be in the kernel's input
   buffer; do it on the master in the parent before forwarding any
   input. Worth remembering if anyone hand-rolls the helper again.

## Suggested next steps in priority order

1. **Settle the `plans/PANES.md` open questions.** Reading the doc and
   making the 15 calls is the gate to starting the reshape. Half a
   focused hour with the doc and a pen. Particularly load-bearing: VM
   hosting under multi-window, Lisp-surface migration strategy
   (flag day vs dual), per-pane vs per-buffer point.
2. **Start the view/buffer split.** First phase from PANES.md, no UI
   change — pure rename + Lisp-surface migration. Mergeable on its
   own. Unblocks the `agent-session` branch by fixing its data
   model, and unblocks `agent-reactive-notebook` (which is the
   natural view-without-buffer canary).
3. **Merge the surviving review queue** (eight branches). Half a
   day if conflicts behave; the multi-cursor `hash-set` fix is the
   only known blocker. Worth deciding whether to do this before or
   after step 2 — if after, fewer rebases; if before, the reshape
   touches a smaller queue.
4. **Phase 1 interruptibility.** Single highest-leverage
   architectural work. See the prior handover.
5. **Investigate the muted-palette issue.** Bundle the shell-view
   residual strip into the same investigation — same colour-pipeline
   family.
6. **Daily-drive for a week, then a real README + 60-second demo.**
7. **LSP autocomplete** as its own session.

---

The story so far: a Lisp-extensible editor with a custom dialect, an
Electron presentation layer, real tree-sitter highlighting (36
languages), a face system customisable via `M-x customize-faces`,
documentation, a working jukebox with album art + metadata,
drag-resizable panes, a diagnostic `C-h F` for syntax highlighting,
directory-tree and Finder-style column browsers, double-click-to-open,
chord-prefix display in the echo area, find-file with tab-completion,
and now a `M-x shell` running the user's default shell on a real
terminal emulator (xterm.js) — curses apps and ZLE-driven prompts
both render. The next architectural lift (window/pane/view reshape
+ multi-window) is sketched in `plans/PANES.md` awaiting decisions.
