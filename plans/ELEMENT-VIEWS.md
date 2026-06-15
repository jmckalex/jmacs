# element-views — drop any custom element into Godot from Lisp

**Status:** Phase 1 in progress (branch `element-views`).
**Motivating client:** the Stella Atari 2600 emulator (`<stella-emulator>`).

## The idea

A user (or we) has an existing web component — a `<custom-element>` bundled
with its own JS/WASM/assets. They want it to *be* a Godot view with minimal
pain. Today adding a view kind means ~7–14 edits to `apps/desktop/src/app.js`.

Instead we wire **one** generic host view kind — `element` — into the editor
**once**. After that, every embeddable web component is registered from Lisp
with a small macro that stores a *spec* and defines a command. The host kind is
data-driven: it reads `tag` / `module` / `attrs` off the view and never learns
the difference between an emulator and anything else.

Per-kind cost drops from ~7–14 JS touch points to **six lines of Lisp, no
engine surgery**. This is the "Lisp UI, JS engine" split: the engine provides a
generic element-hosting kind + a primitive; Lisp provides the declarative
surface; the user never touches `app.js`.

## The six-line payoff

```lisp
(define-element-view 'atari
  :title    "Atari 2600"
  :module   "apps/desktop/vendor/stella/stella-element.js"
  :tag      "stella-emulator"
  :attrs    '((controls))
  :keyboard 'grab)
```

`M-x atari` → a working emulator with its own Load/Reset/crop toolbar.

## Part 1 — the generic `<element-view>` host kind (built once)

`packages/renderer/src/element-view.js`, **per-instance** like `browser-view`
(each view owns its element; nothing shared). Implements the `ViewElement`
contract (`configure`, `setBuffer`, `connectedCallback`, `destroy`). Its job:

1. On first connect, lazily `import()` the spec's module URL (the
   `discoverRendererLanguages` pattern, `app.js`). Importing it runs the
   bundle's `customElements.define(tag, …)` as a side effect.
2. `document.createElement(tag)`, apply `attrs`, append as a child.
3. If `keyboard === 'grab'`, install a **bubble-phase** `keydown`/`keyup`
   listener on the wrapper that `stopPropagation()`s, so the embedded
   element's keys (which it `preventDefault`s but does not stop) don't leak
   up to Godot's window-level bubble router. `'share'` lets `C-`/`M-`/`A-`
   chords through; `'off'` does nothing.
4. `destroy()` removes the inner element → fires *its* `disconnectedCallback`
   (e.g. Stella's `stella.destroy()`), so teardown is free.

Wiring `element` into `app.js` mirrors `browser-view`: a `configureElementView`
factory; `case 'element'` in `perKindConfigureFactory`; per-instance
`ensure/hide/dispose` helpers + a `Map<View,Element>`; routing in
`mountKindView` / `disposeKindView` / `elementForViewInstance` /
`hideInactiveSingletons`. **Ephemerality is automatic** — `session.js`'s
`isEphemeral` returns true for any non-`text` kind, so element-views never try
to persist (there are no save-states anyway).

## Part 2 — the `open-element-view!` host primitive (built once)

Follows the `open-customize-faces!` template. Receives the spec as a Lisp
hash-map (a JS `Map` keyed by keyword objects — the established marshalling),
resolves the module path to an `app://` URL, parses `attrs`, and creates a view
of the single `element` kind with the spec on `view.extras`, then
`switchToViewIndex`. An optional `:on-ready` procedure is delivered via the
existing `deliverLispCallback`.

Module URL resolution: a repo-relative `:module` → `app://editor/<module>`; an
absolute `app://`/`http(s)` URL passes through.

## Part 3 — the `define-element-view` macro (Lisp, the user surface)

Stores the spec in a `*element-views*` registry (mirrors `register-command!`)
and expands to a `defcommand` (itself a macro, so this composes) whose body
calls `(open-element-view! (hash-map …))`. The whole user surface is this one
form. `:command` defaults to the kind symbol.

## Part 4 — asset serving

`serve.js` already serves the `app://editor` origin from the repo with
`.wasm`/`.js`/`.mjs` MIME and `no-store`, and has a same-origin
`__host__/<encoded-abs-path>` route gated by an allowlist. **Relative
resolution under `__host__` works** — a module served there resolves its
sibling `import`s and `new URL('./x.wasm', import.meta.url)` to sibling
`__host__` URLs. CSP already permits `app:` modules, `wasm-unsafe-eval`,
same-origin `fetch`, and `AudioWorklet`. Three tiers:

1. **We vendor into the repo** → plain `app://editor/...`. **Zero serve
   changes.** (The Atari MVP.)
2. **User drops a bundle under `userData`** (already allowlisted at boot) →
   referenced via a `__host__` URL. **Zero serve changes.** A
   `~/…/Godot/vendor/<bundle>/` convention makes "drop a folder, register six
   lines" real.
3. **Arbitrary directory anywhere** → the one real gap: `allowHostDir()` is
   only called for the repo + `userData` at startup. Authorizing an arbitrary
   path at runtime needs a small `ipcMain.handle('host:allow-dir', …)`. Phase
   4+.

## Phasing

- **Phase 1** — generic `<element-view>` kind + `open-element-view!` +
  module-URL resolver + keyboard-grab; wire `element` into `app.js` once.
  *(The real work; touches the fragile mount path — needs a live smoke pass.)*
- **Phase 2** — `define-element-view` macro + `register-element-view!` +
  docs. *(Small.)*
- **Phase 3** — Atari as first client: vendor the 6 files, the 6-line Lisp,
  **GPLv2 attribution** (`ATTRIBUTION.md` + `licenses/Stella-GPLv2.txt`),
  live-test keyboard + audio + ROM load. *(Small.)*
- **Phase 4+** — `element-call` / `element-on` (drive the element's API /
  forward its events to Lisp); `:asset-dir`/userData drop-in + runtime
  `allowHostDir` IPC.

## Open items / decisions

- **GPLv2**: Stella is GPLv2. Ship it in the beta with attribution, or keep
  element-views as the *mechanism* and Atari as a local-only first client. The
  mechanism itself is licence-neutral.
- **Keyboard default**: `'grab'` (game owns all keys while focused) vs
  `'share'` (let `C-`/`M-` chords through). Default `'grab'`.
- **AudioWorklet under `app://`**: CSP/origin say yes; confirm in the Phase 3
  live smoke. *(One window-level caveat: the keyboard-grab assumes Godot's key
  router is bubble-phase at `window`; verify if grab leaks.)*

## Future work (ideas, not yet scheduled)

- **`:no-focus` / non-focusing views.** A spec flag marking a view that should
  **never grab focus** — a helper view whose whole purpose is to act on the
  *active* view (a HUD, a live inspector, a control surface), so opening it
  doesn't steal the point/keyboard from the buffer the user is editing. This
  generalises beyond element-views into the pane/focus model
  (`setCurrentPaneId`, the focus-follows-mount assumptions in `VIEWS.md`); it
  wants its own design pass. Captured here so it isn't lost. (Jason's idea,
  2026-06-15.)
- **`element-call` / `element-on`** — drive an embedded element's methods and
  subscribe to its events from Lisp (the `pdf-extract-text` pattern). Turns the
  six-line drop-in into a fully scriptable surface.
- **User-bundle tiers 2–3** — the `userData` drop-in convention and the
  runtime `allowHostDir` IPC for arbitrary directories.
