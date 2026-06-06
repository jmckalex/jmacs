# 02 — Extension onboarding & API docs

**Pillar:** extensibility is the entire pitch, so the first thing a
stranger will try is *extending* jmacs. This plan makes that a great
five-minute on-ramp and gets the API documented honestly.

**Scope of this document:** a concrete, prioritised, repo-grounded plan
covering (1) where third-party config lives and how it loads, (2) a
"first extension in 5 minutes" tutorial, (3) the reference docs needed
and how to keep them honest, (4) a community-extension distribution
story, (5) the JS-extension story, and (6) the sharp edges that will
trip up outside extenders.

Everything below is grounded in the code as it stands on `main`
(`2f6e970`). **This is a planning document — nothing here is
implemented yet.**

---

## 0. What already exists (the good news)

The substrate is in far better shape than a typical pre-launch editor.
Before designing anything, here is what is *already built and working*,
with citations, because several "gaps" people assume exist are in fact
solved:

- **A real init-file mechanism is already wired.** `loadUserConfig()`
  (`apps/desktop/src/app.js:4764-4781`) reads `custom.lisp` first, then
  `init.lisp`, evaluating each into the live interpreter. On first run
  it *writes a commented `init.lisp` template* if none exists
  (`app.js:4773-4774`, template at `app.js:204-214`). It runs at boot
  (`app.js:4891`) and again after every `reload-stdlib` (`app.js:4804`).
  Errors in a config file are reported to the REPL, not fatal
  (`app.js:4768-4769, 4778-4779`).
- **Config lives in Electron's `userData` dir.** `configPath(name)`
  (`apps/desktop/src/files.js:163-168`) resolves a bare filename against
  `app.getPath('userData')`; the IPC handlers are `config:read` /
  `config:write` (`files.js:523-545`), exposed to the renderer as
  `window.host.readConfigFile` / `writeConfigFile`
  (`preload.mjs:187-201`). Neighbours in the same dir: `custom.lisp`,
  `init.lisp`, `faces.json`, `session.json`, `panes.json`.
- **`defcommand`** records a command in `*commands*` so `M-x` finds it
  whether or not it is bound (`commands.lisp:35-50`), with an optional
  `(interactive …)` clause (region / point / minibuffer prompts).
- **Keymaps are plain Lisp maps**, composed through a chain (minor-mode
  maps → major-mode map → `the-keymap`), resolved late by command name
  (`keymap.lisp:99-192, 250-303`). Prefix maps are nested maps.
- **`define-mode`** is keyword-pair sugar over a map (`modes.lisp:9-10`);
  `register-mode` maps a filename suffix to a mode (`modes.lisp:77-91`).
  Minor modes stack by `:priority` (`modes.lisp:160-188`).
- **`defcustom` / `custom-apply!` / `custom-apply-and-save!`** — a typed,
  grouped settings registry with on-change hooks and persistence to
  `custom.lisp` (`custom.lisp:64-72, 112-127, 184-188`).
- **`defface` / `create-face!`** — a face registry with per-theme and
  per-mode overrides, persisted to `faces.json` (`faces.lisp:87-96,
  123-148`); live customisation via `C-h F` and `C-h C-f`
  (`keymap.lisp:57-63`).
- **A live REPL + inline eval** — `C-x C-e` / `C-RET` evaluate a form in
  place and show the result as a pill (`inline-eval.lisp`); `C-x p`
  toggles the REPL (`system.lisp`).
- **Hot reload** — `C-x C-r` re-evaluates the whole stdlib *and re-runs
  init.lisp* (`app.js:4787-4811`); commands resolve by name so the
  change is live (spec `docs/spec/lisp.md` §6).
- **Drop-in languages** — any `.lisp` in
  `packages/stdlib/lisp/languages/` plus a JS module in
  `packages/renderer/src/languages/` is auto-discovered at startup
  (`stdlib/src/index.js` loader; `app.js:4710-4738`; both READMEs).
- **Self-documentation** — `(doc p)`, `(where-defined p)`,
  `(describe p)`; `C-h k`, `C-h f`, `C-h .`, `C-h a` surface it live
  (`help.lisp`, `keymap.lisp:57-63`).
- **A docs build pipeline** — `scripts/build-docs.js` renders
  `docs/MANUAL.jmd` to `docs/build/`, splitting the reference into
  per-function pages + a `manifest.json` consumed by the in-app doc
  viewer.

**The headline finding:** the *mechanism* for third-party config is
already there. The launch work is overwhelmingly **discoverability,
documentation, and a handful of small ergonomic primitives** — not
building a config system from scratch. That changes the effort profile
dramatically (most items are S, not L).

---

## 1. Where third-party config lives, and how it loads

### 1.1 Current state (verified)

- **Location:** Electron `userData`. On macOS that is
  `~/Library/Application Support/<appName>/` — opaque to a user who
  expects `~/.config` or `~/.jmacs`. The exact `<appName>` segment
  depends on `package.json` / `app.getName()` and should be pinned as
  part of launch packaging (cross-ref plan 01).
- **Files:** `init.lisp` (free-form, hand-edited; the `.emacs`
  equivalent) and `custom.lisp` (machine-written by the customize UI;
  hand edits are clobbered — header warns of this, `app.js:195-201`).
- **Load order:** `custom.lisp` → `init.lisp` → tab-width sync → theme →
  faces (`app.js:4891-4915`). `init.lisp` running *after* `custom.lisp`
  is correct: a hand edit wins over a saved setting.
- **First-run template** (`app.js:204-214`) is good but thin — two
  example forms, no pointer to docs, no mention of where the file lives.

### 1.2 The problems for an outside extender

1. **It is undiscoverable.** `init.lisp` is mentioned in exactly two
   *stdlib source comments* (`cite.lisp:15`, `tabline.lisp:14`) and
   **nowhere in `docs/MANUAL.jmd` or `README.md`**. A new user has no
   way to learn it exists. The MANUAL's §7.3 even teaches editing
   `the-keymap` live in the REPL but never says how to make that
   persist. This is the single biggest onboarding hole.
2. **The path is opaque.** No command opens the config file or reveals
   its location. A user can't `C-x C-f` something they can't name.
3. **No `(load …)` for arbitrary files.** A primitive `read-file-text!`
   exists (`app.js:3307-3318`) but there is no `load` / `load-file` that
   *evaluates* a Lisp file. So `init.lisp` cannot pull in a
   multi-file personal config or a downloaded package — everything must
   be pasted into one file. This blocks the distribution story (§4).

### 1.3 The design (small, mostly additive)

Keep `userData/init.lisp` as the canonical entry point — it works and
the migration cost of moving it is not worth paying. Add the missing
ergonomics:

- **(a) An `open-init-file` command** (S). New `defcommand` in a small
  `config.lisp` (or `system.lisp`): open `init.lisp` in a buffer for
  editing, creating it from the template if absent. Bind nothing by
  default; expose via `M-x` and the Help menu ("Edit configuration").
  Needs a host primitive `config-file-path!` that returns the absolute
  path (wrap `configPath` from `files.js`).
- **(b) A `load` / `load-file` primitive** (S–M). `(load PATH)` reads
  PATH (tilde-expanded, as `read-file-text!` already does via
  `readFileTextSync`) and evaluates its contents in the global
  environment, with errors reported (not fatal) like `loadUserConfig`.
  This is the keystone of the distribution story: a user drops a package
  file somewhere and adds `(load "…/foo.lisp")` to `init.lisp`. Add a
  regression test that a multi-form file loads and its defs are visible.
- **(c) A `~/.jmacs/` convention layer** (M, optional, post-launch). If
  Jason wants a path users can `cd` to, have the host *also* look for
  `~/.jmacs/init.lisp` and a `~/.jmacs/lisp/` directory, preferring it
  over `userData` when present. This is the Emacs-style "visible config
  dir" pattern. Decide before launch whether to ship this — it is a
  cross-territory change (`apps/desktop/src/files.js`), so route through
  `architect-notes.md`. **Recommendation:** ship the visible dir; the
  opaque `Application Support` path is a real friction point and
  "where's my config?" will be the #1 question.
- **(d) Document the load model** in the MANUAL (see §3). The order
  (`custom.lisp` then `init.lisp`), the clobber rule on `custom.lisp`,
  the reload behaviour, and the error-is-non-fatal contract.
- **(e) Beef up the first-run template** (S). Add a one-line pointer to
  the docs, the file's own path (interpolated), and three live examples
  that exercise the three pillars: a `defcustom` set, a `defcommand` +
  keybinding, and an `enable-minor-mode` in a hook. The template is the
  first Lisp most users will read — make it teach.

**Sequencing:** (a), (b), (e) are launch-blocking and small. (c) is a
judgement call for Jason. (d) folds into the docs work in §3.

---

## 2. "Write your first extension in 5 minutes"

The tutorial. It must be runnable end-to-end with zero setup beyond
launching the editor, and every snippet must be real, tested code. It
lives as a new top section in the MANUAL (or a standalone
`docs/TUTORIAL.jmd` linked from the README's first screen). Structure:

### Step 0 — Try a form live (30 s)

Open the REPL (`C-x p`) or the `scratch.lisp` buffer the editor opens on
first launch (`app.js:230-239`). Type and evaluate:

```lisp
(insert! "hello from lisp\n")
```

Eval with `C-RET` (form at point) or `C-x C-e` (form before point).
Text appears in the visible buffer. *Lesson: the REPL acts on the live
editor.* (Grounded: `inline-eval.lisp`, MANUAL §7.1.)

### Step 1 — Define a command (1 min)

```lisp
(defcommand insert-divider ()
  "Insert a horizontal rule on its own line."
  (insert! "\n---\n"))
```

Run it with `M-x insert-divider`. *Lesson: `defcommand` registers the
command so `M-x` finds it; the docstring is kept, not discarded.*
(Grounded: `commands.lisp:35-50`; `defcommand` vs bare `define` — only
`defcommand` lands in `*commands*` and so in `M-x` / `C-h f`.)

A second command that reads an argument, to show `interactive`:

```lisp
(defcommand wrap-region-in-stars (start end)
  "Wrap the region in **double asterisks**."
  (interactive region)
  (goto! end) (insert! "**")
  (goto! start) (insert! "**"))
```

*Lesson: `(interactive region)` gathers the active region's bounds as
arguments; `(interactive (string "Prompt: "))` would prompt the
minibuffer.* (Grounded: `commands.lisp:84-110`.)

### Step 2 — Bind a key (1 min)

```lisp
(set! the-keymap (assoc the-keymap "C-c -" 'insert-divider))
```

Press `C-c -`. *Lesson: a keymap is a plain map from key-string to a
command symbol; binding is `assoc`; binding is by name and resolved
late, so order doesn't matter and redefining the command is live.*
(Grounded: `keymap.lisp:99-192, 298-303`; MANUAL §7.3. Caveat to
surface: `C-c` is a prefix map (`keymap.lisp:82-97`); binding *into* the
existing `c-c-keymap` is `(set! c-c-keymap (assoc c-c-keymap "-" …))`.
The tutorial should show the simple top-level `the-keymap` case and
footnote the prefix-map case to avoid a confusing first failure.)

Document the key-string grammar inline (it bites everyone): printable
chars are themselves (`"a"`, `" "`); named keys are lowercase
(`"enter"`, `"left"`, `"backspace"`, `"escape"`); modifiers are `C-`
(Ctrl/Cmd), `M-` (Alt), `S-` (Shift); shifted punctuation arrives
named (`M-<` is `"M-S-comma"`). (Grounded: `keymap.lisp:1-12`;
MEMORY `reference_key_names`; real examples at `keymap.lisp:156-159,
176-177`.)

### Step 3 — A tiny minor mode (2 min)

```lisp
;; A keymap the mode will own.
(define dividers-mode-map {"C-c -" 'insert-divider})

;; The mode itself.
(define-mode dividers-mode
  :name "Div"
  :keymap 'dividers-mode-map)        ; note: the keymap by *symbol*

;; Turn it on in the current buffer.
(enable-minor-mode dividers-mode)
```

The modeline now shows `Div` (`modes.lisp:190-199`), and `C-c -` works
*only* in buffers where the mode is on. *Lessons: a mode is just a map;
`:keymap` is the *symbol* naming a keymap so the map stays live-editable;
minor modes stack ahead of the major mode in the keymap chain
(`modes.lisp:186-188`, `keymap.lisp:250-253`).* For a *major* mode tied
to a file type, add `(register-mode ".div" dividers-mode)`
(`modes.lisp:77-79`).

### Step 4 — Make it stick (30 s)

Move the three definitions into `init.lisp` (`M-x open-init-file`, once
§1.3(a) exists) and they load on every launch. *Lesson: `init.lisp` is
your permanent config; `C-x C-r` reloads everything live.* (Grounded:
`app.js:4764-4781, 4804`.)

### Acceptance criteria for the tutorial

- Every snippet is copy-pasted into a fresh build and verified to run
  (per CLAUDE.md: stdlib tests stub host primitives, so this must be
  checked in the *running app*, not just the suite).
- The whole path takes under five minutes for someone who has never
  seen the editor.
- It ends with the reader having a persistent, personal keybinding —
  the "I changed my editor" dopamine hit that converts a viewer into a
  user.

---

## 3. Reference docs needed, and keeping them honest

### 3.1 What exists

- `docs/MANUAL.jmd` (538 lines) — a genuinely good user manual with an
  "Extending jmacs" section (§7) covering REPL, command, keybinding,
  hot reload, self-doc, modes, and the JS path.
- `docs/spec/lisp.md` — the language spec (evaluation, special forms,
  macros, modules, errors).
- `docs/spec/modes.md` — the mode model.
- `docs/reference/{index,commands,buffer-primitives,lisp-core}.md` —
  hand-written per-function reference (~2300 lines total), with a build
  pipeline that splits them into per-function pages + a manifest the
  in-app doc viewer reads.
- `docs/CUSTOM-VIEWS.md`, `docs/api/layer2.md` — view + buffer API.

### 3.2 The gaps an outside extender hits

1. **No keymap authoring guide.** Key-string grammar, prefix maps, the
   chain/precedence model, mode-local vs global — all live in code
   comments (`keymap.lisp`) and scattered MANUAL prose. Needs one
   page.
2. **No face/theme authoring guide.** `defface`, `create-face!`,
   per-theme/per-mode overrides, `faces.json` shape — documented only in
   `faces.lisp` comments and the design plan
   `plans/FACE-CUSTOMISATION.md`. The customize UI is documented; the
   *Lisp authoring* path is not.
3. **No "extension author's guide" connecting the pieces.** The MANUAL
   §7 is an orientation, not a how-to-ship-a-package guide. Needs the
   tutorial (§2) plus a "structuring a larger extension" follow-on
   (modules — `lisp.md` §6 — and `load`).
4. **The defcustom/customize authoring path is under-documented for
   Lisp authors** — how to add a *new* setting (not just change an
   existing one), groups, on-change hooks, persistence semantics.
5. **The reference is hand-written and already drifting.** Concrete
   proof: `lisp.md` §3 says TCO is "Not yet" and lists it under Deferred
   (§Deferred item 2), but MEMORY records the interpreter *now has TCO*
   (trampoline, `eval.js`). The doc is stale the moment code lands. The
   `index.md` even names the source files as `*.jmd` while the actual
   files are `*.md`. This drift is the central honesty risk.

### 3.3 The docs to write (prioritised)

| Pri | Doc | Effort | Notes |
|----|-----|------|-------|
| P0 | **Extension tutorial** (§2) | M | The 5-minute on-ramp. Launch-blocking. |
| P0 | **Keymap authoring guide** | S | Promote `keymap.lisp` comments + the key-string table to `docs/reference/keymaps.md`. |
| P0 | **`init.lisp` / config guide** | S | Where it lives, load order, `custom.lisp` clobber rule, `load`, reload. Folds §1.3(d). |
| P1 | **Face & theme authoring guide** | M | `defface`/`create-face!`/per-mode overrides/`faces.json`. From `faces.lisp` + `plans/FACE-CUSTOMISATION.md`. |
| P1 | **Mode authoring guide** | S | Expand MANUAL §7.6 into a full page incl. `register-mode`, hooks, minor-mode priority, the `:keymap`-by-symbol rule. Cross-ref `docs/spec/modes.md`. |
| P1 | **defcustom authoring guide** | S | Adding settings, groups, on-change, persistence. From `custom.lisp`. |
| P2 | **Larger extensions** | S | Modules (`lisp.md` §6), `load`, file layout conventions. |
| P2 | **Reference refresh** | M | Reconcile `lisp.md` (TCO, the `.jmd`/`.md` slip) with code; cross-ref `project_docs_refresh` (an unmerged docs-refresh branch already exists — fold this in rather than redo). |

### 3.4 Keeping docs honest (this is the durable win)

The editor already self-documents from docstrings (`doc`,
`where-defined`, `describe`; `C-h f` / `C-h k`). The hand-written
reference is the thing that rots. Two mechanisms, low effort, high
payoff:

- **(a) A `doc-coverage` check in CI** (S–M). A test that walks
  `registered-command-names` (`commands.lisp:24-26`) and every primitive
  the app registers, and asserts (i) each has a non-empty docstring, and
  (ii) each command/primitive name appears in the reference
  `manifest.json` (or an explicit allowlist of intentionally-undocumented
  internals). This catches "added a command, forgot the docs" at commit
  time — exactly the failure mode CLAUDE.md already mandates ("update its
  entry here in the same commit", `reference/index.md`). Make the
  process-rule a test.
- **(b) Treat the docstring as canonical, the prose reference as
  commentary.** The MANUAL already says "when this reference and a
  docstring disagree, the docstring is what the editor will tell you —
  one of the two needs fixing" (`reference/index.md`). Lean into it:
  the reference pages should *embed* the live docstring where practical
  (the build can pull `describe` output), so prose can't silently
  contradict the running editor. At minimum, the doc-coverage test
  should diff the manifest against the command registry.
- **(c) A `lisp.md` "Planned vs Built" linter.** The Deferred list in
  `lisp.md` §Deferred is a known drift point (TCO already wrong). A tiny
  test that asserts each "Planned" feature is *actually* absent (e.g. by
  probing the interpreter) would have caught the TCO staleness.

**Recommendation:** ship (a) before launch — it is the single highest-
leverage thing for sustaining honest docs as outside contributors start
adding commands. (b) and (c) are post-launch hardening.

---

## 4. Community-extension distribution

### 4.1 The minimal story (launch)

The honest v1 distribution model, and it is a *good* one because it is
zero-infrastructure:

1. A package is a `.lisp` file (or a small directory of them).
2. The user downloads it anywhere (e.g. `~/.jmacs/lisp/foo.lisp`).
3. They add one line to `init.lisp`: `(load "~/.jmacs/lisp/foo.lisp")`.
4. `C-x C-r` or relaunch loads it live.

This is exactly the Emacs `load-path` pattern at its simplest, and it
is fully unblocked by the `(load …)` primitive in §1.3(b). **It is the
launch deliverable for distribution** — do not build a registry first.

Supporting pieces (all S):

- **Document a package convention** in the extension-author guide: a
  package is plain Lisp, should use `defcommand`/`defcustom`/`defface`
  with a name prefix (e.g. `foo-…`) to avoid collisions in the single
  global namespace (see §6.1), should be idempotent under reload (define,
  don't mutate global state at top level beyond registration), and may
  wrap itself in a `(module foo …)` for a private namespace
  (`lisp.md` §6).
- **A `~/.jmacs/lisp/` auto-load directory** (M, optional). If §1.3(c)
  ships the visible config dir, also glob `~/.jmacs/lisp/*.lisp` at
  startup (mirroring the existing `languages/` auto-discovery in
  `app.js:4710-4738`). Then "install a package" = "drop the file in the
  folder," no `init.lisp` edit. This is the nicest minimal UX and reuses
  a proven loader pattern. **Recommendation: ship this** — it is small
  and it makes the distribution story a one-step drop-in.

### 4.2 A registry (post-launch, design only)

Do **not** build for launch. Sketch only, so the minimal story doesn't
paint us into a corner:

- A package is a Git repo (or a single gist) with a manifest
  (`package.lisp` declaring name, version, entry file, deps).
- A `package-install` command clones/downloads into `~/.jmacs/lisp/<name>/`
  and adds it to the auto-load set.
- A central index (a JSON file in a GitHub repo, à la early MELPA) the
  editor can fetch and search. No server needed initially.
- **Sandboxing is the real open question.** Lisp packages get full
  `read-file-text!`, the buffer, and (planned) JS interop — a malicious
  package is dangerous. For launch, the answer is social ("only load
  code you trust", stated plainly in the docs). A capability model is a
  large future design item; flag it, don't solve it now. (Cross-ref
  plan 03 stability/data-safety and plan 05 governance.)

**Sequencing:** §4.1 (minimal + optional auto-load dir) at launch; §4.2
deferred, gated on actual demand. Building a registry before there are
packages to register is premature.

---

## 5. The JavaScript extension story

JS is billed as first-class ("Lisp UI, JS engine" —
MEMORY `feedback_lisp_ui_js_engine`; README "Two extension languages are
first-class"). The reality is narrower than the pitch, and the launch
messaging must match the reality.

### 5.1 Current state (verified)

- **Host-to-Lisp interop works:** JS functions are registered as Lisp
  primitives via `createInterpreter({ primitives })` (`lisp.md` §9). The
  whole stdlib bridge is JS exposed to Lisp.
- **The drop-in *language* path is genuinely JS-first:** a tree-sitter
  language is a JS module (`packages/renderer/src/languages/<tag>.js`)
  auto-discovered at startup (`app.js:4721-4738`, both `languages/`
  READMEs). This is a real, documented, working JS extension surface —
  arguably the *best* current JS extension story and under-sold.
- **Lisp-to-JS interop does NOT exist.** `lisp.md` §9 and §Deferred(5)
  list `(js/call …)` and JS-module import as **Planned**. A search
  confirms no `js/call` / `js-eval` / `editor.lisp.eval` entry point
  exists in `packages/lisp/src` or `app.js`. There is *no documented way
  for a user to drop in a `.js` file of editor commands* — only the
  language-module path and the (internal) primitive-registration path.

### 5.2 The honest framing for launch

Do not claim a symmetric "write extensions in JS or Lisp" story —
it isn't true yet, and an extender will discover that in minute two and
feel misled. Frame it as:

- **Today:** Lisp is the extension language for *commands, modes, keys,
  faces*. JavaScript is the language for *the engine and for new
  languages/views* — heavy lifting that ships as part of a package's JS
  modules, exposed to Lisp as primitives. The architecture
  (`docs/ARCHITECTURE.md`) and the MEMORY principle back this exactly.
- **Documented JS surfaces that DO exist** (write these up):
  1. The tree-sitter **language drop-in** (`languages/*.js` + `.lisp`).
     This is real and good; give it a first-class "Add a language" guide
     (the README already exists at
     `packages/renderer/src/languages/README.md` — promote it to
     `docs/`).
  2. **Custom views** (`docs/CUSTOM-VIEWS.md` already exists) — the JS
     way to add a non-text view kind.
  3. **Registering primitives** — for a packaged extension that needs JS
     muscle, the pattern is "ship JS that registers primitives, call
     them from Lisp." Document the seam.

### 5.3 The gap to close (post-launch, flag now)

To make JS a *true* first-class user-extension language, two things from
the Deferred list need building (out of this plan's territory — these
are `packages/lisp` work, route via `architect-notes.md`):

- `(js/call "Math.floor" 3.7)` and JS-module import from Lisp
  (`lisp.md` §9, §Deferred 5).
- A documented `editor.lisp.eval(…)` / host API so a `.js` extension can
  call into the editor symmetrically (also §9 Planned).

Until those land, the launch claim should be the accurate "Lisp for
behaviour, JS for engine and languages," not "extend in either."

---

## 6. Sharp edges that will confuse outside extenders

Concrete, repo-grounded hazards a first-time extender will hit. Each
needs *either* a doc callout *or* a small fix before launch.

1. **One global namespace; commands shadow primitives** (DOC, critical).
   Primitives and `defcommand`s share one namespace; a command of the
   same name *shadows* the primitive (MEMORY
   `feedback_command_primitive_namespace`). E.g. the command
   `forward-char` wraps the primitive `cursor-right!`; `newline` exists
   as both a command and a primitive. A package author who names a
   command `insert` or `point` will silently break things. **Fix:**
   document the namespace rule prominently in the author guide and
   mandate name-prefixing for packages (§4.1). Also document the `!`
   convention for side-effecting openers (`view-list!` opens, `(view-list)`
   is data — MEMORY same note).

2. **Stubbed-primitive tests mask real behaviour** (DOC, for
   contributors). Unit tests stub host primitives, so a command can pass
   its test and still be wrong against the real primitive (CLAUDE.md;
   MEMORY `feedback_command_primitive_namespace`). An outside contributor
   who adds a command and sees green may ship a bug. **Fix:** say so in
   CONTRIBUTING (cross-ref plan 05) and in the author guide; point at the
   smoke harness (`apps/desktop/scripts/smoke.js`).

3. **`C-c` is a prefix map, not a leaf** (DOC). The natural first
   binding attempt — `(set! the-keymap (assoc the-keymap "C-c x" …))` —
   silently does nothing useful, because `"C-c"` in `the-keymap` is a
   nested map (`keymap.lisp:190`). The user must bind into `c-c-keymap`.
   **Fix:** the keymap guide must show prefix-map binding explicitly
   (covered in §2 Step 2 footnote).

4. **Key-string surprises** (DOC). Shifted punctuation arrives named
   (`M-<` → `"M-S-comma"`, `M-%` → `"M-S-5"`; `keymap.lisp:156-159,
   176-177`); named keys are lowercase; `C-` means Ctrl *or* Cmd. A user
   guessing `"C-c <"` will fail. **Fix:** the key-string table in the
   keymap guide (already drafted in §2).

5. **`custom.lisp` is machine-owned** (DOC). Hand edits are clobbered on
   the next customize save (`app.js:195-201` header). A user who edits
   `custom.lisp` instead of `init.lisp` loses their work silently.
   **Fix:** doc callout; the `open-init-file` command (§1.3a) steers
   people to the right file.

6. **No hygiene in macros** (DOC). `defmacro` is non-hygienic in v0
   (`lisp.md` §5) — introduced bindings can capture the caller's. An
   extension author writing macros must `gensym`. **Fix:** already in
   the spec; cross-link from the author guide.

7. **`define-mode`'s `:keymap` wants a *symbol*, not the map** (DOC). A
   beginner will write `:keymap dividers-mode-map` (the value) and lose
   live-editability, or worse, define the mode before the map and get a
   stale capture. The convention is `:keymap 'dividers-mode-map`
   (`modes.lisp:128-134`, `keymap.lisp:15` comment). **Fix:** §2 Step 3
   shows it; the mode guide states the rule.

8. **The Deferred-features cliff** (DOC). A user reaching for tail
   recursion, conditions/restarts, hygienic macros, concurrency, or
   Lisp→JS will hit "Planned." (`lisp.md` §Deferred.) Note: TCO is
   *already shipped* but the spec still says Planned — fix the spec
   (§3.2 item 5) so the cliff list is accurate.

9. **Errors in `init.lisp` are non-fatal but quiet** (DOC, maybe FIX).
   A broken config reports to the REPL and the editor continues
   (`app.js:4778-4779`). Good for resilience, but a user whose config
   "didn't work" won't know to look in the REPL. **Fix (S):** on a
   config error, surface a visible notice (minibuffer/echo area), not
   just a REPL line.

10. **The config dir is opaque** (FIX, §1.3). Repeated here because it
    is the most-asked question waiting to happen. `Application Support/…`
    is undiscoverable; resolve via the visible `~/.jmacs/` dir and/or the
    `open-init-file` command.

---

## 7. Prioritised plan with effort & sequencing

Effort: S ≈ <½ day, M ≈ 1–2 days, L ≈ 3+ days. All sizes assume the
substrate above already exists (it does).

### Launch-blocking (P0)

| # | Item | §  | Effort | Territory |
|---|------|----|--------|-----------|
| 1 | `(load PATH)` primitive + test | 1.3b | S–M | `apps/desktop` + `packages/lisp` glue |
| 2 | `open-init-file` command + `config-file-path!` primitive | 1.3a | S | `stdlib` + `apps/desktop` |
| 3 | Richer first-run `init.lisp` template (path + 3 examples + docs link) | 1.3e | S | `apps/desktop` (`app.js:204`) |
| 4 | **Extension tutorial** (the 5-minute on-ramp), verified in the running app | 2 | M | `docs/` |
| 5 | Keymap authoring guide (+ key-string table, prefix maps) | 3.3 | S | `docs/` |
| 6 | `init.lisp` / config guide (location, order, clobber rule, reload) | 1.3d/3.3 | S | `docs/` |
| 7 | Sharp-edges doc callouts: namespace shadowing, `C-c` prefix, `custom.lisp` clobber, `:keymap` symbol | 6 | S | `docs/` |
| 8 | Promote the language drop-in + custom-views READMEs into `docs/`; correct the JS-extension claim to the honest framing | 5.2 | S | `docs/` |
| 9 | Fix `lisp.md` staleness (TCO now shipped; `.jmd`/`.md` slip) | 3.2/3.4c | S | `docs/` (fold into the unmerged docs-refresh branch) |

### Strongly recommended for launch (P0/P1 boundary)

| # | Item | §  | Effort | Territory |
|---|------|----|--------|-----------|
| 10 | Visible `~/.jmacs/` config dir + `~/.jmacs/lisp/*.lisp` auto-load | 1.3c/4.1 | M | `apps/desktop` — route via `architect-notes.md` |
| 11 | `doc-coverage` CI test (command/primitive ↔ manifest) | 3.4a | S–M | per-package test |
| 12 | Visible notice on `init.lisp` load error | 6.9 | S | `apps/desktop` |

### Post-launch (P1/P2)

| # | Item | §  | Effort |
|---|------|----|--------|
| 13 | Face/theme authoring guide | 3.3 | M |
| 14 | Mode + defcustom authoring guides | 3.3 | S each |
| 15 | "Larger extensions" guide (modules, load, layout) | 3.3 | S |
| 16 | Embedded-docstring reference build + `lisp.md` Planned-vs-Built linter | 3.4b/c | M |
| 17 | Lisp→JS interop (`js/call`, module import) + `editor.lisp.eval` | 5.3 | L | `packages/lisp` |
| 18 | Package registry + manifest + `package-install` + sandboxing design | 4.2 | L |

### Critical path

The minimum that makes "extend it in 5 minutes" *true and discoverable*
is items **1–9** plus, ideally, **10**. None is large; the substrate
carries the weight. The single most important item is **#4 (the
tutorial)** backed by **#2/#3 (so the persistence step actually has a
file to open)** and **#6 (so the user knows where config lives)** —
without these three, a curious stranger writes one live form, can't make
it stick, and leaves.

---

## 8. Open questions for the architect

1. **Visible config dir (`~/.jmacs/`) vs staying on `userData`?** (§1.3c,
   §4.1). Recommendation: ship the visible dir + auto-load folder — the
   opaque path is the #1 friction point and the auto-load folder makes
   distribution one-step. This is a cross-territory change
   (`apps/desktop/src/files.js`); needs Jason's sign-off.
2. **How loudly to surface init.lisp errors?** (§6.9). Echo-area notice,
   a popup, or leave it REPL-only?
3. **JS-extension messaging.** Confirm the honest framing in §5.2 — "Lisp
   for behaviour, JS for engine & languages" — is the line for launch,
   rather than promising symmetric JS extension before §5.3 ships.
4. **`load` security posture for launch.** §4.2 — confirm "load only
   code you trust," documented, is the acceptable v1 stance (it is the
   Emacs stance), with sandboxing deferred.
