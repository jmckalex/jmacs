I have now read all 23 files fully and grepped each. Here is the structured audit report.

---

# Documentation Audit — Godot in-app Lisp guide & reference

Format: `path:LINE — [DIMENSION] — SEVERITY — "quote" — problem — fix`

Note on the pervasive `data-jmacs-doc="…"` HTML attributes and `nodes/jmacs-*.html` / `reference/…` href doc-node ids throughout the guide: these are internal doc-linking plumbing (not visible prose) and are **not flagged** — listed in the summary.

## docs/guide/intro.md
- intro.md:1 — [NAMING] — HIGH — "## Introducing jmacs Lisp" — section/book title the app displays — "Introducing Godot Lisp" (or "the Lisp").
- intro.md:17 — [NAMING] — HIGH — "### What jmacs Lisp Is" — section title — "What Godot's Lisp Is".
- intro.md:19 — [NAMING] — HIGH — "*jmacs Lisp* is a custom dialect" — the dialect is now "the Lisp" of Godot — reword; drop "jmacs Lisp".
- intro.md:48 — [NAMING] — HIGH — "jmacs deliberately has two extension languages" — "Godot deliberately has…".
- intro.md:68 — [NAMING] — HIGH — "jmacs keeps the engine in JavaScript" — "Godot keeps…".
- intro.md:103 — [NAMING] — HIGH — "Four surfaces evaluate Lisp in a stock jmacs" — "a stock Godot".
- intro.md:25-26 — [MODEL-B] — LOW — "a tree-walking interpreter … running inside the editor's own JavaScript runtime" — under Model B the interpreter lives in the central Lisp **server (spine)**, not the renderer; phrasing is vague enough to be misread as renderer-embedded — clarify it runs server-side.

## docs/guide/data-types.md
- data-types.md:3 — [NAMING] — HIGH — "Every value in jmacs Lisp is one of a small number of types" — "in Godot's Lisp".
- data-types.md:289 — [NAMING] — HIGH — "jmacs Lisp has two general equality predicates" — reword.
- data-types.md:403 — [NAMING] — HIGH — "jmacs Lisp is a language of immutable values" — reword.
- data-types.md:73,74,75,92 — [NAMING] — MED — `(string-length "jmacs")`, `(substring "jmacs" …)`, `(string-prefix? "jm" "jmacs")` — sample string literals use old product name — change to "Godot" (note: "godot" is also 5 chars so `⇒ 5` stays, but substring results `"ma"`/`"acs"` and the prefix `"jm"` need updating).
- Model-B: clean.

## docs/guide/evaluation.md
- evaluation.md:3 — [NAMING] — HIGH — "Everything you do in jmacs Lisp" — reword.
- evaluation.md:366 — [NAMING] — HIGH — "Every evaluation in jmacs is this picture" — "in Godot".
- Model-B: clean (pure language/evaluator; no renderer-eval or single-window assumption).

## docs/guide/control-flow.md
- control-flow.md:3 — [NAMING] — HIGH — "In jmacs Lisp, control flow is not a set of statements" — reword. Model-B: clean.

## docs/guide/functions.md
- functions.md:3 — [NAMING] — HIGH — "Procedures are the working material of jmacs Lisp" — reword.
- functions.md:379 — [NAMING] — HIGH — "jmacs Lisp is a Lisp-1: one namespace" — reword.
- functions.md:441 — [NAMING] — HIGH — "the `C-h` help commands described in *Extending jmacs*" — a **cross-referenced part title** — "*Extending Godot*". Model-B: clean.

## docs/guide/macros.md
- Clean on both (only internal `data-jmacs-doc` attributes; no prose "jmacs"; language-level content is Model-B-consistent).

## docs/guide/modes-hooks.md
- Clean on both (only the internal `data-jmacs-doc="modes"` attribute; mode/keymap/hook prose is Model-B-consistent, e.g. late symbol resolution at dispatch).

## docs/guide/modules.md
- modules.md:283 — [NAMING] — HIGH — ";;; init.lisp — your jmacs configuration." — user-facing first-run template text — "your Godot configuration".
- modules.md:286 — [NAMING] — HIGH — "It is the jmacs equivalent of .emacs:" — "the Godot equivalent of .emacs".
- modules.md:273-278 — [FACT/config-home] — MED — "the editor's per-user data directory (Electron's `userData` path — on macOS, `~/Library/Application Support/<App>/`, beside `faces.json`, `session.json`…)" — **stale**: user config now lives in `~/.godot` (`$GODOT_HOME`), per the config-home migration — update the path (and `<App>` = Godot). Model-B otherwise clean; "re-evaluates … into the running interpreter" (line 221) is Model-B-consistent (single server interpreter).

## docs/guide/text-editing.md
- text-editing.md:373 — [NAMING] — HIGH — "The file surface splits, as it so often does in jmacs, into commands" — "in Godot".
- text-editing.md:22-24 — [MODEL-B] — LOW — "host primitives: procedures the desktop application registers into the Lisp when it boots … resolves 'the buffer' through the focused pane" — under Model B primitives register into the **server** and the active view is server-tracked; wording is not wrong but worth confirming it doesn't imply renderer-side registration.

## docs/guide/commands-keys.md
- commands-keys.md:58 — [NAMING] — HIGH — "jmacs ships five sources:" — "Godot ships five sources".
- Model-B: acceptable. Line 206-207 ("The renderer normalises every keystroke to a string (`keyEventToString`)… keymaps match those strings") is consistent with the thin-client-captures / server-resolves model; dispatcher location is left unstated. No flag.

## docs/guide/custom-faces.md
- custom-faces.md:35 — [NAMING] — MED — ":group 'GROUP ; defaults to 'jmacs" — the customize **root group** symbol is `jmacs`; shown to users in the customize buffer — rename to `godot` (needs a coordinated code change in themes/custom stdlib; doc faithfully reflects a stale identifier).
- custom-faces.md:84 — [NAMING] — MED — ":group 'jmacs" (example) — same.
- custom-faces.md:118 — [NAMING] — MED — "the root is `jmacs` (registered with parent `nil`)" — same root-group identifier.
- custom-faces.md:127 — [NAMING] — MED — "browsing starts at `jmacs` and follows only registered links" — same.
- custom-faces.md:319 — [NAMING] — MED — "(defgroup 'desk 'jmacs …)" (example parent) — same.
- Model-B: clean (highlighting/customize registry described correctly as display/server split).

## docs/guide/errors.md
- errors.md:3 — [NAMING] — HIGH — "When a jmacs Lisp program cannot continue" — reword.
- errors.md:345 — [NAMING] — HIGH — "An error nobody catches does not crash jmacs" — "does not crash Godot".
- Model-B: clean (renderer error boundary is correctly a display concern).

## docs/guide/style-pitfalls.md
- style-pitfalls.md:14 — [NAMING] — HIGH — "jmacs Lisp has one namespace and no access control" — reword. Model-B: clean ("single output sink"/"running interpreter" phrasing is Model-B-consistent).

## docs/reference/index.md
- index.md:1 — [NAMING] — HIGH — "Title: jmacs Function Reference" — book title the app shows in the sidebar — "Godot Function Reference".
- index.md:6 — [NAMING] — HIGH — "## jmacs Function Reference" — same.
- index.md:8 — [NAMING] — HIGH — "the per-function reference for jmacs" — reword.
- index.md:20 — [NAMING] — HIGH — "A procedure callable from jmacs Lisp belongs to one of four tiers" — reword. Model-B: clean.

## docs/reference/lisp-core.md
- lisp-core.md:1 — [NAMING] — HIGH — "Title: jmacs Core Lisp Reference" — book title — "Godot Core Lisp Reference".
- lisp-core.md:6 — [NAMING] — HIGH — "## jmacs Core Lisp Reference" — same.
- lisp-core.md:9 — [NAMING] — HIGH — "the procedures built into the jmacs Lisp itself" — "into Godot's Lisp itself". Model-B: clean.

## docs/reference/buffer-primitives.md
- buffer-primitives.md:1 — [NAMING] — HIGH — "Title: jmacs Buffer & Host Primitives" — book title — "Godot Buffer & Host Primitives".
- buffer-primitives.md:6 — [NAMING] — HIGH — "## jmacs Buffer & Host Primitives" — same. Model-B: clean.

## docs/reference/commands.md
- commands.md:1 — [NAMING] — HIGH — "Title: jmacs Command Reference" — book title — "Godot Command Reference".
- commands.md:6 — [NAMING] — HIGH — "## jmacs Command Reference" — same.
- commands.md:8 — [NAMING] — HIGH — "every procedure in the jmacs standard library" — reword.
- commands.md:302 — [NAMING] — HIGH — "jmacs indents with spaces." — "Godot indents with spaces."
- commands.md:1047 — [NAMING] — HIGH — "they persist to a companion `<file>.jmacs-metadata` file" — **wrong sidecar name**; the actual sidecar is `.godot-metadata` — change to `.godot-metadata`.
- Model-B: clean. Line 771-773 ("The renderer reports each keystroke as a normalised string; `handle-key` dispatches it") is **correct** for Model B (thin client reports; server `handle-key` resolves) — no flag.

## docs/reference/search-and-edit.md
- search-and-edit.md:1 — [NAMING] — HIGH — "Title: jmacs Search & Editing Commands" — book title — "Godot …".
- search-and-edit.md:9 — [NAMING] — HIGH — "whole-line editing commands of the jmacs standard library" — reword. Model-B: clean (folding correctly a renderer/view concern).

## docs/reference/productivity.md
- productivity.md:1 — [NAMING] — HIGH — "Title: jmacs Productivity Commands" — book title — "Godot Productivity Commands".
- productivity.md:8 — [NAMING] — HIGH — "This document describes jmacs's productivity features" — reword.
- productivity.md:157 — [NAMING] — HIGH — "they persist to a companion `<file>.jmacs-metadata` file" — **wrong sidecar name** — change to `.godot-metadata`.
- productivity.md:61 — [FACT/config-home] — LOW — "the user's `<user-data>/snippets/<mode>/` directories" — generic placeholder; verify snippets now resolve under `~/.godot` post config-home migration. Model-B: clean.

## docs/reference/panes.md
- panes.md:1 — [NAMING] — HIGH — "Title: jmacs Pane & Window Commands" — book title — "Godot Pane & Window Commands".
- panes.md:111 — [NAMING] — HIGH — "jmacs distinguishes *closing* a pane" — "Godot distinguishes…". Model-B: clean (per-window pane tree; correctly window-aware, e.g. "the only one in the window").

## docs/reference/views.md
- views.md:1 — [NAMING] — HIGH — "Title: jmacs View & Tool Commands" — book title — "Godot View & Tool Commands".
- views.md:8 — [NAMING] — HIGH — "jmacs is more than a text editor" — "Godot is more than a text editor". Model-B: clean (views = L4/renderer; Lisp surface distinct).

## docs/reference/latex.md
- latex.md:1 — [NAMING] — HIGH — "Title: jmacs LaTeX & RefTeX Commands" — book title — "Godot LaTeX & RefTeX Commands". Model-B: clean.

## docs/reference/help-and-config.md
- help-and-config.md:1 — [NAMING] — HIGH — "Title: jmacs Help, Bookmarks & Customization" — book title — "Godot Help, Bookmarks & Customization".
- help-and-config.md:241 — [NAMING] — MED — "Group: `jmacs`. Defined in `files.lisp`." (`*find-file-case-sensitive*`) — root customize-group identifier `jmacs` (user-visible); rename to `godot` alongside the code change. Model-B: clean.

---

# FINAL SUMMARY

The overwhelming issue is **NAMING**, not Model-B drift. Counts — NAMING: **47 HIGH** (every reference-book `Title:`/`##` header the app displays, the guide part/section titles like "Introducing jmacs Lisp"/"What jmacs Lisp Is"/"*Extending jmacs*", pervasive "jmacs Lisp" prose, and two **wrong sidecar filenames** `<file>.jmacs-metadata` at commands.md:1047 and productivity.md:157 that should be `.godot-metadata`), **~10 MED** (the customize **root group identifier `jmacs`** across custom-faces.md + help-and-config.md, and the "jmacs" sample string literals in data-types.md), plus **2 config-home FACT drifts** (modules.md:273-278 still points config at Electron `userData`/`~/Library/Application Support/<App>/` instead of `~/.godot`; productivity.md:61 LOW). **MODEL-B: only 2 LOW** soft flags (intro.md:25-26 and text-editing.md:22-24 — vague "runs inside the editor's own JavaScript runtime" / "the desktop application registers into the Lisp", which under Model B is the server/spine); the corpus is otherwise Model-B-clean and in one place explicitly correct (commands.md:771-773 describes the thin-client→server `handle-key` dispatch accurately). Highest-value fixes: the ~19 book/section **titles** (shown in-app) and the two `.jmacs-metadata` sidecar names.

**OK jmacs refs NOT flagged** (deliberately): (1) filesystem/repo paths — `packages/lisp/*`, `packages/stdlib/*`, `apps/desktop/src/app.js`, `packages/renderer/src/*`; (2) the internal `data-jmacs-doc="…"` HTML data-attributes and the `nodes/jmacs-core-lisp-reference.html` / `nodes/jmacs-buffer--host-primitives.html` doc-node id filenames used for cross-linking (structural plumbing, not visible prose — appear across intro, data-types, control-flow, functions, macros, modes-hooks, text-editing, errors); (3) `.jmd`/`.md` cross-file references (`commands.jmd`, `index.jmd`, `docs/spec/lisp.md`, `docs/MANUAL.jmd`). The customize-group symbol `jmacs` (custom-faces/help-and-config) is flagged MED rather than ignored because it is user-visible, but note it requires a coordinated stdlib code change, not a doc-only edit.