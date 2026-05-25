# Plan — Font-face syntax highlighting customisation

**Status: planned, not started.** A detailed design for review.

## Context

Today, syntax highlighting paints text spans with CSS classes named
from tree-sitter capture names (`@keyword` → `tok-keyword`). The three
themes in `packages/stdlib/lisp/themes.lisp` set the colours by writing
CSS custom properties (`--tok-comment`, `--tok-string`, …) on
`document.documentElement`. There are 13 face slots: `comment`,
`string`, `number`, `keyword`, `constant`, `function`, `type`, `tag`,
`operator`, `paren`, `heading`, `code`, `link`.

What's missing: a user can swap the **theme**, but cannot customise
individual **faces**. To make keywords bolder, or change the operator
colour without forking a theme, they'd have to write CSS by hand.

This plan adds a customisation group for font faces — persistent
across restarts, live-applied on change, theme-aware.

## The face model

A *face* is a tagged attribute set, every attribute optional:

```
(face :foreground "#c594c5"
      :background nil
      :weight :normal         ; :normal | :bold
      :slant  :normal         ; :normal | :italic
      :underline      false
      :strike-through false)
```

The 13 face names above remain. New language modules can register more
via `defface`.

## Registration — `defface` (a new primitive)

`defface` is its own primitive, parallel to `defcustom`. Faces have
richer semantics than settings — multi-attribute, themed — and the
customise-face UI needs widgets a generic setting can't carry.

```lisp
(defface 'comment
  :doc "Source comments — slash-slash, hash, percent."
  :default-light    (face :foreground "#93a1a1" :slant :italic)
  :default-dark     (face :foreground "#7c8f9e" :slant :italic)
  :default-midnight (face :foreground "#8b949e" :slant :italic))
```

`themes.lisp` becomes a sequence of `defface` calls. **The existing
theme system keeps working unchanged from the user's point of view**:
the `:on-change` hook on `*theme*` triggers a face-CSS regeneration,
the same way it triggers a custom-CSS-variable rewrite today.

A theme does NOT get to declare overrides of other themes' defaults.
Each theme declares only its own. (Less surface, fewer surprises.)

## Override layers

Three layers, resolved in this order for the active theme:

1. **Built-in default** for the active theme (set by `defface`).
2. **User per-theme override** (saved in `faces.json` under `themes.<name>`).
3. **User global override** (saved in `faces.json` under `global`).

More-specific wins: per-theme override takes precedence over global
override. So a user can say *"globally I want comments italic"* and
*"in midnight theme specifically, comments are also bold."*

## Persistence — a single `faces.json`

One file at `<userData>/faces.json` (for convenience and
discoverability — easy to copy between machines, easy to delete to
reset).

```json
{
  "global": {
    "keyword": { "weight": "bold" }
  },
  "themes": {
    "dark":     { "operator": { "foreground": "#62b3b2" } },
    "midnight": { "comment":  { "weight": "bold" } }
  }
}
```

New IPC pair `faces:read` / `faces:write` (mirrors `panes:read` /
`panes:write` from the resize-panes work). Loaded at startup *before*
themes apply so the first paint already has overrides. Synchronous
write on every set — the file is small and faces don't change rapidly.

## CSS generation

A `<style id="face-overrides">` element in `<head>`. Regenerated on:

- Startup (after `faces.json` loaded).
- Theme switch.
- Any `set-face-attribute` / `reset-face` call.

For each face, one CSS rule on `.tok-FACE` setting `color`,
`background-color`, `font-weight`, `font-style`, `text-decoration` as
present in the resolved face. 13 faces → ~50 lines of generated CSS.
Cheap; full rewrite per change is fine.

## Default italics

Per the architect's call: **`@comment` is italicised by default** in
all three built-in themes. This goes in the new `defface` definitions
in `themes.lisp`. Sublime / VSCode / most modern editors do this; jmacs
follows. (Plan provides the capability; this is one default that
changes.)

## Lisp surface

```lisp
(face-attribute 'keyword :foreground)                ; → "#c594c5"
(face-attribute 'keyword :foreground :theme 'dark)   ; explicit theme

(set-face-attribute 'keyword :weight :bold)          ; global override
(set-face-attribute 'keyword :weight :bold
                    :theme 'dark)                    ; per-theme override

(reset-face 'keyword)                                ; drop overrides
(reset-face 'keyword :theme 'dark)                   ; drop per-theme only
(reset-all-faces)                                    ; wipe everything

(customize-face 'keyword)                            ; interactive
```

## UI — extending the existing `customize` buffer

The `customize` buffer kind already exists for `defcustom`. Add a new
"Faces" group to it. Each face renders as:

- Name + docstring.
- A small swatch (`<span class="tok-NAME">Aa</span>`) showing current
  rendering live.
- Foreground / background as colour swatches that open the existing
  colour-swatch modal (already implemented for the inline-colour
  feature).
- Weight, slant as dropdowns.
- Underline, strike-through as checkboxes.
- A per-face Reset button.

Edits update the in-memory map and `faces.json` immediately; the
style element regenerates; all visible buffers re-render. No restart.

## Integration with `describe-face-at-point`

The diagnostic command being built in parallel (`agent-describe-face`
branch) opens a `*Face at point*` doc buffer. That buffer gets a
`[Customize this face]` button at the top — clicking it opens the
customize buffer scrolled to that face. Closes the diagnostic loop:
see what face this is → tweak it → see result.

## Phasing

**Phase 1.** `defface` machinery; rewrite `themes.lisp` to use it;
italicise `@comment` defaults; verify same visual output otherwise.
Tests: the existing smoke and theme tests pass; the new defface
storage is unit-tested.

**Phase 2.** `set-face-attribute` Lisp API + per-theme + global
override layers + CSS regeneration on change. Usable from REPL and
`init.lisp`; no UI yet.

**Phase 3.** `faces.json` persistence + restore on launch (`faces:read`
/ `faces:write` IPC, `host.readFaces` / `host.writeFaces`).

**Phase 4.** `customize-face` UI in the customize buffer, with
colour-swatch modal integration and live swatch preview. Wire the
`[Customize this face]` button in `*Face at point*`.

## Risks / open at implementation time

- **Customize buffer richness**. Today the customize buffer is a list
  of `defcustom`s. Faces are richer (multi-attribute, themed). Adding
  groups with sub-widgets expands what the customize buffer renders —
  bounded but non-trivial DOM work.
- **Order of operations at startup**. `faces.json` must load before
  the first theme application; the renderer must regenerate
  `face-overrides` CSS before the editor view renders any buffer.
  Mistakes here cause a brief flash of un-overridden colours.
- **Backward compatibility**. Existing `(theme 'oceanic)` user
  invocations still work. Anyone with raw CSS overrides in a custom
  stylesheet still has them (loaded after `face-overrides`, so they
  win — escape hatch).
- **Face-name collisions**. If a language module declares a face name
  that overlaps with a built-in, the registry must error rather than
  silently shadow — same rule as `defcustom` today.

## Critical files

- `packages/stdlib/lisp/themes.lisp` — rewritten as `defface` calls
  with italics on `@comment`.
- `packages/stdlib/lisp/faces.lisp` (new) — the customisation surface:
  `defface`, `set-face-attribute`, `reset-face`, `customize-face`.
- `packages/stdlib/lisp/customize-face.lisp` (new) or an extension of
  `customize.lisp` — the UI for Phase 4.
- `apps/desktop/src/face-styles.js` (new) — CSS generation in the
  renderer.
- `apps/desktop/src/files.js` — `faces:read` / `faces:write` IPC.
- `apps/desktop/src/preload.mjs` — `host.readFaces` / `host.writeFaces`.

## Inheritance (added 2026-05-24)

A face can inherit from another with the `from` keyword between the
name and the first kwarg:

```lisp
(defface 'link-visited from 'link
  :doc "A visited hyperlink."
  :default-light (face :foreground "#6c71c4")
  :default-dark  (face :foreground "#c594c5"))
```

Single parent only (no multi-inheritance — keeps the semantics
obvious). The parent chain is walked bottom-up: each face's
`(default + user-overrides)` contribution is composed from the topmost
ancestor down, with descendant attributes winning on conflict. As a
consequence, a user override on a parent flows into any child that
does not override the same attribute. Cycles (a `from`-chain that
loops back to itself) raise a `face inheritance cycle: a -> b -> a`
error at resolution time.

The override-layer ordering in the section above becomes: for the
queried face and each ancestor, `(built-in default → user global →
user per-theme)`; ancestors layer under descendants. The built-in
faces in `themes.lisp` are all independent — inheritance is offered as
a capability for third-party language modules and user `init.lisp`.

## What's deliberately NOT in this plan

- **Live theme editor** (build a theme from scratch in the UI). The
  customise-face buffer lets a user tweak the active theme's faces;
  building a *new* named theme is a separate plan.
- **Per-buffer faces** (set comment to a different colour just in
  Markdown). Out of scope; possible later via mode-keyed overrides.
- **Importing themes from other editors**. Out of scope; possible
  later via a small VS Code .json → faces.json translator.
