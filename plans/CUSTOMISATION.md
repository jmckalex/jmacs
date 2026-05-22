# Plan — Emacs-style customisation

**Status: planned, not started.** A detailed design for review.

## Context

jmacs has no settings registry, no persistence, and no init file.
Configuration today is ad-hoc Lisp variables — the canonical example is
`*jmarkdown-command*` (`packages/stdlib/lisp/sticky-notes.lisp`), read
defensively by the host. The architect wants an Emacs-style system:
`defcustom`-style declared settings with types, groups and docstrings;
a registry; persistence; the jmacs equivalent of `.emacs` (an
`init.lisp`); and — the distinguishing goal — a *pretty HTML-forms
front-end*, since the editor's chrome is real HTML, not a text buffer.

What the codebase gives us to build on:

- **The Lisp.** `defmacro` is procedural and proven; `define-mode`
  (`modes.lisp`) is the established pattern of a macro expanding to a
  `define` over a map literal. Maps, keywords, `set!`, late-resolving
  `eval` are all first-class.
- **Stdlib loading.** `STDLIB_FILES` (`packages/stdlib/src/index.js`) is
  an ordered list; `loadStdlib` evaluates each in order. The desktop
  app calls it at startup and on `reload-stdlib`. *There is no init-file
  hook today* — this plan adds one.
- **Persistence precedent.** Sticky-note metadata uses `metadata:*` IPC
  in `files.js` + `preload.mjs`. The settings file reuses that exact
  pattern.
- **The chrome.** The titlebar, REPL panel and minibuffer are plain DOM
  components driven by callbacks, ignorant of Lisp. A customisation
  view follows the same recipe.

## Data model

A `defcustom` produces a Lisp map stored in a central registry, reusing
the `define-mode` shape:

```
{ :name 'jmarkdown-command  :default "multimarkdown -s"
  :value "multimarkdown -s" :type :string  :group 'sticky-notes
  :doc "…"  :options nil  :on-change nil }
```

**Type → widget vocabulary** (open-ended; an unknown type falls back to
a text field with a `read`/`write-string` round-trip):

| `:type`    | widget                | Lisp value        |
|------------|-----------------------|-------------------|
| `:boolean` | checkbox              | `#t` / `#f`       |
| `:integer` | number input          | number            |
| `:string`  | text input            | string            |
| `:choice`  | `<select>` of `:options` | one of `:options` |
| `:colour`  | colour picker         | `#rrggbb` string  |
| `:text`    | textarea              | string            |

Two registries: `*custom-registry*` (name → setting map) and
`*custom-groups*` (name → `{:name :doc :parent}`); groups form a tree
via `:parent`, with a root group `jmacs`.

**Two persisted files**, under Electron's `app.getPath('userData')`:

- `custom.lisp` — *machine-written*. One `(custom-set! 'name value)`
  form per non-default setting. Written by the customisation UI.
- `init.lisp` — *user-written*, free-form Lisp; the `.emacs` equivalent.
  The editor never writes it.

## Components

1. **`packages/stdlib/lisp/custom.lisp`** (new) — the heart, pure Lisp.
   `defcustom` (a macro: expands to a *guarded* `define` plus a
   `custom-register!` — guarded so a hot reload does not reset a
   customised value to its default); `defgroup`; `custom-ref`,
   `custom-set!` (the single mutation path — updates the variable, the
   registry, and runs `:on-change`), `custom-reset!`; query procedures
   the view calls (`custom-group-names`, `customs-in-group`,
   `custom-field`) returning plain data; the `customize` command and
   `save-customizations`. Added to `STDLIB_FILES` *early* (right after
   `editing.lisp`) so later files can call `defcustom`.

2. **Host primitives** (`apps/desktop/src/app.js`) — `open-customize!`
   (shows the view) and `write-custom-file!` (persists the serialised
   settings).

3. **Persistence** — `config:read` / `config:write` IPC in `files.js`
   (resolving `app.getPath('userData')`); `readConfigFile` /
   `writeConfigFile` on the `window.host` bridge.

4. **Startup loading** (`apps/desktop/src/app.js`) — after `loadStdlib`,
   evaluate `custom.lisp` then `init.lisp`, each in a try/catch that
   reports to the REPL, so a broken init file does not abort the
   editor. `reload-stdlib` re-runs this block.

5. **The HTML customisation view** — `packages/renderer/src/customize.js`
   (new), a plain DOM component like `createReplView`: a group tree on
   the left, a form panel on the right rendering each setting as a
   typed widget. A widget's change calls back into `custom-set!` and a
   debounced `save-customizations`. Mounted in a new `#customize-host`
   overlay div, hidden by default, opened by the `customize` command.

**Worked migration.** `*jmarkdown-command*` becomes a `defcustom` with
type `:string`, group `sticky-notes`, default `"multimarkdown -s"`.
Because `defcustom` still `define`s the variable, every existing reader
keeps working unchanged — proof that `defcustom` is a strict superset
of `define`. The hardcoded default in `app.js` then collapses to a
single source of truth.

## Phasing

1. **The Lisp registry + `defcustom`** — `custom.lisp`, no host changes,
   no UI. Settings are declarable, queryable, settable from the REPL.
   Fully unit-tested.
2. **Migrate `*jmarkdown-command*`** — the worked example; proves the
   macro against real usage.
3. **Persistence** — `config:*` IPC, the startup loading of
   `custom.lisp` + `init.lisp`, `save-customizations`. Customisations
   survive restarts; users get an `init.lisp`.
4. **The HTML customisation view** — `customize.js`, the `#customize-host`
   overlay, the `customize` command, widget→`custom-set!` wiring.
5. **Polish** — nested group navigation, search/filter, per-setting
   revert.

## Testing

- **Stdlib unit tests** (`stdlib.test.js` harness, no new infra):
  `defcustom` defines *and* registers; `custom-set!` updates variable +
  registry and fires `:on-change`; `custom-reset!`; group-tree queries;
  the `custom.lisp` serialiser round-trips.
- **Smoke test**: open the view via `(customize)`, assert a known
  widget rendered, dispatch an `input`, assert the Lisp value changed;
  a `writeConfigFile`/`readConfigFile` round-trip.

## Risks

- **Load-order coupling** — `custom.lisp` must precede any file that
  calls `defcustom`; documented in its header, enforced by its position
  in `STDLIB_FILES`.
- **Hot reload resetting values** — a re-run `defcustom` must keep an
  existing customised value, not re-`define` to the default. Designed
  into the macro (a guarded define) from phase 1.
- **A broken `init.lisp`** — per-file try/catch; the error must be
  visible (the REPL, perhaps a modeline flag).
- **Assigning a computed symbol** — `custom-set!` must assign a variable
  named by data. `set!` needs a literal symbol; this likely needs a
  small new L3 primitive (`set-symbol-value!`). See open questions.

## Open questions for the architect

1. **`init.lisp` vs `custom.lisp` precedence** — which is authoritative
   when both set the same variable? (Plan loads `custom.lisp` then
   `init.lisp`, so hand edits win.)
2. **A new L3 primitive** to set a variable named by data
   (`set-symbol-value!`) — recommended, so a custom variable can stay a
   plain readable Lisp variable. The only Layer-3 change in the plan.
3. **Live apply vs explicit Apply/Save buttons** — plan applies changes
   live and persists debounced.
4. **Group-tree depth** in the view — two levels for v1, or arbitrary
   nesting from the start (the data model supports either).
5. **A template `init.lisp`** written on first run, so users have
   something to edit — recommended.

## Critical files

- `packages/stdlib/lisp/custom.lisp` — **new**, the registry + macros.
- `packages/stdlib/src/index.js` — register `custom.lisp` early.
- `apps/desktop/src/app.js` — startup loading; the view-opening and
  file-writing primitives.
- `apps/desktop/src/files.js`, `preload.mjs` — `config:*` IPC + bridge.
- `packages/renderer/src/customize.js` — **new**, the HTML-forms view.
- `packages/stdlib/lisp/sticky-notes.lisp` — the `*jmarkdown-command*`
  migration.
