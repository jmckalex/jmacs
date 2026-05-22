# Plan — Emacs-style customisation

**Status: planned, not started.** A detailed design for review.

**Revised** — the customisation screen is a *buffer* with an HTML view,
not a modal panel; and it uses Emacs's explicit Set / Apply / Save
model, not live-apply. See "The view model" and "The apply model".

## Context

jmacs has no settings registry, no persistence, and no init file.
Configuration today is ad-hoc Lisp variables — the canonical example is
`*jmarkdown-command*` (`packages/stdlib/lisp/sticky-notes.lisp`). The
architect wants an Emacs-style system: `defcustom`-declared settings
with types, groups and docstrings; a registry; persistence; the jmacs
equivalent of `.emacs` (an `init.lisp`); and a customisation UI built
from real HTML form controls.

How Emacs does it, for reference: `defcustom` declares a user option;
`M-x customize` opens a **Customize buffer** — a real buffer in a major
mode — whose "widgets" are simulated in text by `widget.el` because
Emacs has no HTML. Each setting carries a *state* (standard / set /
saved); "Set for this session" applies a change, "Save" writes it to
the `custom-file`. jmacs keeps Emacs's buffer and state model and
replaces the simulated widgets with real HTML form controls.

## The view model — a customisation buffer

The customisation screen is a **buffer** — listed, reachable by `C-x b`,
killable — whose **view is an HTML form**, not the monospace text grid.
This requires one generalisation, and it is the reusable part:

> **A buffer has a *kind*. The host mounts the *view* that matches the
> kind.** Text buffers → the editor (text/grid) view we have. A
> customisation buffer → the HTML-form customisation view. Later, a
> notebook buffer → the notebook view.

Today `apps/desktop/src/app.js` holds one `editorView` and a buffer
list of uniformly-text buffers. The change:

- The buffer list becomes **heterogeneous**: an entry is either a text
  buffer (an L2 `createBuffer`) or a **special buffer** — a light
  object `{ kind, name }` with no L2 text.
- A small **view registry** maps a `kind` to a view instance. The host
  creates each view once; `switchToBuffer` shows the current buffer's
  kind's view and hides the others (the `toggle-repl!` show/hide
  pattern).
- The modeline shows a special buffer's name and kind; `C-x b` lists it
  like any buffer.
- L2 buffer primitives operate on the current *text* buffer. A special
  buffer does not become `session.current` — the session tracks the
  last text buffer — so `buffer-text` and friends stay well-defined
  while the customisation buffer is on screen. (See Risks.)

This "buffer-kind / view-kind" mechanism is the *general-purpose
buffer/view interface*; customisation is its first client and the
reactive notebook will be its second.

## The apply model — Set / Apply / Save

Faithful to Emacs. A setting has three values in play and a visible
*state*:

- **default** — the `defcustom` default.
- **value** — the live session value (the Lisp variable's current
  binding).
- **saved** — what is written in the persisted `custom.lisp`, if any.

A setting's **state**, shown per row in the view:

| state | meaning |
|-------|---------|
| `standard` | value = default, nothing saved |
| `edited` | the widget has been changed but not yet applied |
| `set` | applied to the session (value ≠ saved/default), not saved |
| `saved` | value persisted to `custom.lisp` |

Editing a widget *stages* a change (`edited`). The buffer offers
**Apply** — make staged values live for the session (`set`) — and
**Apply and Save** — live *and* written to `custom.lisp` (`saved`).
Per-setting Set / Revert is also available. So a setting can be changed
for the session without persisting — the behaviour the architect asked
for.

## Data model

A `defcustom` produces a registry entry — a Lisp map, the `define-mode`
shape:

```
{ :name 'jmarkdown-command  :default "multimarkdown -s"
  :value "multimarkdown -s"  :type :string  :group 'sticky-notes
  :doc "…"  :options nil }
```

Two registries: `*custom-registry*` (name → entry) and `*custom-groups*`
(name → `{:name :doc :parent}`); groups form a tree via `:parent`, root
`jmacs`.

**Type → widget vocabulary** (open-ended; an unknown type falls back to
a text field with a `read`/`write-string` round-trip):

| `:type`    | widget            | Lisp value          |
|------------|-------------------|---------------------|
| `:boolean` | checkbox          | `#t` / `#f`         |
| `:integer` | number input      | number              |
| `:string`  | text input        | string              |
| `:choice`  | `<select>`        | one of `:options`   |
| `:colour`  | colour picker     | `#rrggbb` string    |
| `:text`    | textarea          | string              |

**Setting a variable named by data.** `custom-set!` must assign the
variable a setting's `:name` symbol refers to. No new Layer-3 primitive
is needed: `custom-set!` builds the form `(set! <name> (quote <value>))`
and `eval`s it — `eval` and `set!` already exist, and `defcustom` has
`define`d the variable so `set!` finds it. The plan therefore touches
only the stdlib and the host, not the Lisp core.

**Persistence** — two files under Electron's `app.getPath('userData')`:

- `custom.lisp` — *machine-written*, one `(custom-set-saved! 'name
  value)` per saved setting. Written by "Apply and Save".
- `init.lisp` — *user-written*, free-form Lisp; the `.emacs` equivalent.
  The editor never writes it; a commented template is created on first
  run.

## Components

1. **`packages/stdlib/lisp/custom.lisp`** (new) — pure Lisp. The
   `defcustom` macro (expands to `custom-register!` + a `define` of the
   variable to its *registered* value, so a hot reload preserves a
   customised value rather than resetting to the default); `defgroup`;
   the registry; `custom-value`, `custom-apply!` (stage→session, via the
   `eval`-a-`set!`-form trick), `custom-save!`, `custom-state`,
   `custom-reset!`; query procedures the view calls
   (`custom-group-names`, `customs-in-group`, `custom-field`) returning
   plain data; the `customize` command. Added to `STDLIB_FILES` *early*
   so later files can call `defcustom`.

2. **Buffer-kind / view-kind mechanism** (`apps/desktop/src/app.js`) —
   the heterogeneous buffer list, the view registry, `switchToBuffer`
   mounting the matching view. New host primitives: `open-customize!`
   (create-or-switch-to the customisation buffer) and `write-custom-file!`.

3. **Persistence** — `config:read` / `config:write` IPC (`files.js`,
   resolving `app.getPath('userData')`); `readConfigFile` /
   `writeConfigFile` on the `window.host` bridge; startup loading of
   `custom.lisp` then `init.lisp` after the stdlib, each in a try/catch
   reporting to the REPL so a broken init file cannot abort the editor.

4. **The HTML customisation view** — `packages/renderer/src/customize.js`
   (new), a plain DOM component like `createReplView`: the group tree
   on the left; the settings of the selected group on the right, each a
   row of label + doc + a typed widget + a state badge + per-setting
   Set/Revert; buffer-level Apply and Apply-and-Save. Mounted in
   `#editor-host` as one of the kind-views. Decoupled from Lisp — it
   takes plain data and reports plain data through callbacks.

**Worked migration.** `*jmarkdown-command*` becomes a `defcustom`
(`:string`, group `sticky-notes`). Because `defcustom` still `define`s
the variable, every existing reader keeps working; the hardcoded
default in `app.js` collapses to a single source of truth.

## Phasing

1. **The Lisp registry + `defcustom`** — `custom.lisp`, no host changes,
   no UI. Settings declarable, queryable, applyable/savable from the
   REPL. Fully unit-tested.
2. **Migrate `*jmarkdown-command*`** — the worked example.
3. **Persistence** — `config:*` IPC, startup loading of `custom.lisp` +
   `init.lisp`, the template init file.
4. **The buffer-kind / view-kind mechanism** — heterogeneous buffers,
   the view registry, `switchToBuffer` mounting; a placeholder
   customisation buffer proving a non-text buffer can be shown.
5. **The HTML customisation view** — `customize.js`, the widgets, the
   state badges, Set / Apply / Save wired to the Lisp registry.
6. **Polish** — nested group navigation, search/filter.

## Testing

- **Stdlib unit tests** (`stdlib.test.js` harness): `defcustom` defines
  *and* registers; `custom-apply!` updates the variable; `custom-save!`
  serialises; state transitions (standard → edited → set → saved);
  group-tree queries; a hot reload preserves a customised value; the
  `custom.lisp` serialiser round-trips.
- **Smoke test**: open the customisation buffer via `(customize)`,
  assert the buffer's view mounted, a known widget rendered; edit it,
  Apply, assert the Lisp value changed; Apply and Save, assert
  `custom.lisp` written; a `config:*` round-trip.

## Risks

- **The buffer-kind mechanism touches `switchToBuffer`** and the buffer
  list — exercised by every buffer switch. Phase 4 is isolated and has
  a placeholder buffer to test against before the real view exists.
- **`session.current` and special buffers** — buffer primitives need a
  text buffer; the session must keep pointing at the last text buffer
  while a special buffer is shown. A buffer command run via `M-x` while
  the customisation buffer is current is the edge case — v1 may simply
  disable `M-x` in the customisation view's keymap.
- **Hot reload resetting values** — `defcustom` defines the variable to
  its *registered* value, not the literal default, so re-running it
  keeps a customised value.
- **A broken `init.lisp`** — per-file try/catch; the error must be
  visible (the REPL).

## Open questions for the architect

1. **One customisation buffer or several?** Emacs opens a separate
   Customize buffer per group/variable. v1 plans a single customisation
   buffer; confirm.
2. **Group-tree depth** in the view — two levels for v1, or arbitrary
   nesting from the start (the data model supports either).
3. **`init.lisp` vs `custom.lisp` precedence** when both set the same
   variable — plan loads `custom.lisp` then `init.lisp`, so hand edits
   win.

## Critical files

- `packages/stdlib/lisp/custom.lisp` — **new**, the registry + macros.
- `packages/stdlib/src/index.js` — register `custom.lisp` early.
- `apps/desktop/src/app.js` — the buffer-kind / view-kind mechanism;
  startup loading; the customisation primitives.
- `apps/desktop/src/files.js`, `preload.mjs` — `config:*` IPC + bridge.
- `packages/renderer/src/customize.js` — **new**, the HTML-form view.
- `packages/stdlib/lisp/sticky-notes.lisp` — the `*jmarkdown-command*`
  migration.
