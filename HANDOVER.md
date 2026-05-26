# Handover — jmacs session 2026-05-26

A snapshot for resuming work on **jmacs** in a fresh session. Read
`CLAUDE.md` first — it carries the standing working agreements
(branching, commits, testing discipline, territory). This file is the
where-things-stand record. The previous handover (2026-05-25) is
preserved in `git log` against `96ea97b`; this one supersedes it.

## Where main is

HEAD: `0b12776` (`fix(shell-view): treat \r\n as one line terminator,
not rewind+flush`). **All test suites green across every package; the
desktop smoke passes end-to-end including the shell arm.**

The session's headline: a shell buffer (`M-x shell`) reachable on
main, plus two new tree-sitter grammars (Make, Perl), plus a small
chord-prefix / find-file merge from the prior queue. The shell
landed in three versions on top of each other (v1 line-oriented →
v2 pty + ANSI → v3 inline-input GitKraken-style), each merged
in turn after a brief interactive try-out. A planned v4 (xterm.js)
is documented in `plans/SHELL-V4-XTERM.md` and **not yet built**;
the user wants to swap to a real terminal emulator rather than
extend the line-oriented model further.

## Landed this session

Merge bubbles + direct-to-main, top of `main`:

| Commit | What | Notes |
|---|---|---|
| `0b12776` | `fix(shell-view): treat \r\n as one line terminator` | The bug that made `ls`/`pwd` show empty output. Tty driver converts output `\n` → `\r\n`; v3's `feedLiveLine` was treating the `\r` as a rewind and wiping the line before `\n` flushed it. Look ahead one char: `\r\n` is a single terminator. |
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

Eight left from the prior session's queue. All were rebased forward
through this session's merges only where strictly required; most are
on top of older commits and will need a small merge.

| Branch | HEAD | What it adds |
|---|---|---|
| `agent-regex-search` | `0305696` | `C-M-s` regex isearch, `C-M-%` regex-replace, `M-%` query-replace |
| `agent-latex` | `5cf4fc9` | LaTeX wasm built via Docker + TikZ-aware query |
| `agent-folding` | `7e269e2` | Tree-sitter code folding for 8 languages |
| `agent-multi-cursor` | `484b430` | Selection-set buffer + renderer foundation. **⚠ Lisp uses `hash-set` which doesn't exist; needs `assoc` fix** |
| `agent-lsp` | `3f3a666` | TypeScript LSP, diagnostics + hover |
| `agent-file-nav` | `074adab` | Fuzzy project find-file + sidebar tree |
| `agent-session` | `5c9e7eb` | Tabline (drag-reorder) + persistent session restore |
| `agent-reactive-notebook` | `d453841` | Reactive Lisp notebook (engine phase) |

`agent-chord-find-file` merged this session; remove from the queue.

The unmerged shell branches (`agent-shell-buffer`,
`agent-shell-buffer-v2`) — both already merged into main this
session; the branch refs can be deleted with `git branch -d` when
convenient (Git's safety-checked delete refuses unless fully merged).

### Suggested merge order

Largely unchanged from the prior handover:

1. `agent-regex-search`
2. `agent-latex`
3. `agent-folding` — touches view.js; first non-trivial conflict surface
4. `agent-multi-cursor` — apply the `hash-set` → `assoc` fix first, then merge
5. `agent-session` — tabline; touches index.html, app.js, styles.css
6. `agent-lsp` — largest standalone surface
7. `agent-file-nav` — sidebar tree
8. `agent-reactive-notebook` — last; complete on its own

Expected conflict surfaces (still mostly additive, keep-both):
`apps/desktop/scripts/smoke.js`, `apps/desktop/src/app.js`,
`packages/stdlib/lisp/keymap.lisp`, `packages/stdlib/src/index.js`,
`apps/desktop/styles.css`.

## In flight / queued

- **Shell v4 (xterm.js)** — design written, not yet built. See
  `plans/SHELL-V4-XTERM.md`. The user explicitly chose this path over
  patching v3 further: "There's no point doing a halfway house." When
  ready to start: spawn an agent on `agent-shell-buffer-v4`, the
  brief is the plan doc.

  Key points the plan settles:
  - Adds `@xterm/xterm` (~250 kB) + `@xterm/addon-fit`.
  - Drops `feedLiveLine`, the ANSI parser, the inline contenteditable,
    `+Z`/`--noediting`, the parent-side ECHO-off termios tweak.
  - Adds a `shell:resize` IPC channel and a sidechannel pipe (fd 3)
    the python helper reads `<cols>:<rows>\n` from for `TIOCSWINSZ`
    via `ioctl`.
  - Theme bridge: map the existing `--ansi-*` palette into xterm.js's
    flat theme object.
  - Open questions in the plan: selection/copy model, reload
    behaviour, font loading timing, bell style.

  Effort estimate: a focused day's work; big surface but additive
  (build the new view alongside v3 first, swap the import last).

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
- **Shell v3 prompt fidelity.** Under `+Z` (ZLE off) the Oh My Zsh
  prompt's git branch and right-aligned timestamp don't render —
  they're emitted via ZLE's cursor-up + clear-to-end + reprint
  sequence, which a line-oriented transcript can't honour. The
  static left prompt (`(base) ~/Source/jmacs/main/` + `$ `) renders
  correctly. v4 with xterm.js will fix this.
- **Shell v3 curses apps** — `vi`, `htop`, `less +F` won't work.
  Documented in the file header of `shell-view.js`. Same v4 fix.

## Plan documents

In `plans/`:

- `LANGUAGE-INJECTION.md` — implementation merged.
- `REACTIVE-NOTEBOOK.md` — phase 1 on `agent-reactive-notebook`.
- `FACE-CUSTOMISATION.md` — implementation merged.
- `SHELL-V4-XTERM.md` — **new this session.** xterm.js-based v4.

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

Unchanged from the prior handover, roughly:

1. **Splits / multiple panes.** Worth a `plans/PANES.md` first.
2. **LSP autocomplete.** Diagnostics + hover without completion feels
   half-done; `agent-lsp` lands the first half.
3. **Git integration.** Diff gutter, blame, basic conflict UI.
4. **Performance proven at scale.**
5. **Process isolation for user code.** The real architectural debt.
   See the Phase 1 proposal in the prior handover (`git show 96ea97b
   -- HANDOVER.md`).
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

1. **Build v4 (xterm.js).** The plan is in `plans/SHELL-V4-XTERM.md`.
   Spawn an agent on `agent-shell-buffer-v4`; the brief is the plan.
   Once landed, delete `packages/renderer/src/ansi.js` and the
   `feedLiveLine` machinery (v3 carries a lot of dead-end work that
   becomes obsolete the day xterm.js lands).
2. **Merge the surviving review queue** (eight branches). Half a
   day if conflicts behave; the multi-cursor `hash-set` fix is the
   only known blocker.
3. **Phase 1 interruptibility.** Single highest-leverage
   architectural work. See the prior handover.
4. **Investigate the muted-palette issue.**
5. **Daily-drive for a week, then a real README + 60-second demo.**
6. **Splits** (`plans/PANES.md`).
7. **LSP autocomplete** as its own session.

---

The story so far: a Lisp-extensible editor with a custom dialect, an
Electron presentation layer, real tree-sitter highlighting (36
languages), a face system customisable via `M-x customize-faces`,
documentation, a working jukebox with album art + metadata,
drag-resizable panes, a diagnostic `C-h F` for syntax highlighting,
directory-tree and Finder-style column browsers, double-click-to-open,
chord-prefix display in the echo area, find-file with tab-completion,
and now a `M-x shell` running the user's default shell with full
PTY + ANSI. v4 (xterm.js) is queued.
