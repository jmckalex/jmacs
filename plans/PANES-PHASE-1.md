# Phase 1 — view/buffer split

Concrete implementation brief for phase 1 of `plans/PANES.md`. Read
PANES.md first; this doc assumes its decisions (binary tree;
per-window-point; flag-day rename; tabline as a view kind; click-to-
focus; constructors return handles; etc.) are locked.

## Scope

- **One window. One pane.** No splits, no multi-window, no tabline-
  view rendering. The pane *concept* arrives, but the user can't
  create more than one yet. End-state: jmacs looks and behaves
  identically to today, but underneath, every on-screen thing flows
  through a `View` rather than a buffer-with-a-kind.

- **Lisp surface flag-day.** `(current-buffer)` → `(current-view)`,
  `(switch-to-buffer)` → `(switch-to-view!)`, `(buffer-list)` →
  `(view-list)`, etc. One pass; no compatibility shims (per Q4).

- **Kind registry.** The hand-wired switch statement in
  `apps/desktop/src/app.js` (`switchToBuffer` and `mountView`)
  becomes a proper registry keyed by view-kind, with each view kind
  contributing a factory + display routine. The bonus from PANES's
  "Companion changes."

- **Tabline view kind: registered, but unused by default.** Add the
  view kind to the registry so phase 3 can render it; do not yet
  expose Lisp commands to construct tabline-views. (Type system
  permits it; no UI entry point.)

## What stays unchanged

- The L2 `Buffer` class in `packages/buffer/src/buffer.js`. Markers,
  overlays, text properties, point, mark, modes, edit history — all
  untouched. The buffer keeps `majorMode` / `minorModes`; views with
  buffers inherit those at creation.
- The buffer Lisp primitives that operate on text content
  (`point`, `mark`, `insert`, `delete`, `buffer-text`, `buffer-line-
  count`, `buffer-substring`, `cursor-buffer-start!`, etc.). These
  still operate on "the current buffer," which is now resolved as
  "`(view-buffer (current-view))`, or raise a condition if the
  current view has no buffer."
- All the view modules (`packages/renderer/src/<name>-view.js`).
  Their `setBuffer` method may get renamed to `setView` or accept
  both for one commit, but their internals are untouched.
- The smoke test's structure. Individual arms get their `submit` /
  assertion lines updated for renamed primitives, but the harness
  doesn't move.

## The new `View` abstraction

Lives at L2 in `packages/view/` as a new workspace package (sibling
to `packages/buffer/`), or — if creating a workspace feels heavy —
in `packages/buffer/src/view.js` alongside `Buffer`. Pick whichever is
faster; I lean toward a new workspace package for the territory
clarity the L0–L4 model wants.

```js
// packages/view/src/view.js (sketch)
export function createView({ kind, name, buffer = null, state = {}, modeline = null }) {
  return {
    kind,                    // string discriminator
    name,                    // modeline label
    buffer,                  // null for non-text views
    state,                   // per-view-kind state (image: {path, zoom},
                             //   jukebox: {cwd, tracks}, shell: {sessionId}, …)
    modeline,                // payload for the modeline renderer
    // life-cycle slots filled in by the kind registry:
    //   majorMode, minorModes, keymap (typically delegate to buffer for
    //   text views; live on the view directly for non-text views).
  };
}
```

Key invariants:

- `view.buffer` is set for text-editing kinds (`text`, `customize` if
  it edits text, `doc` if it edits source, …). Audit each existing
  kind to decide.
- Operations that need a buffer (`(insert ...)`, `(point)`, etc.)
  read it as `(view-buffer (current-view))`. If null, raise a
  condition `'no-buffer-here`.
- A view can be in at most one pane (Q9 resolved); two views over the
  same buffer are allowed (Q9 probe).

### Audit of existing kinds — which get a buffer

Existing ten kinds, with the expected `view.buffer` value:

| kind                | buffer? | non-buffer state |
|---------------------|---------|------------------|
| `text`              | yes     | — |
| `customize`         | maybe   | settings map; check if it edits text or just renders forms |
| `image`             | no      | `{ path, zoom }` |
| `doc`               | maybe   | a doc page may or may not be backed by file text; check the current code |
| `jukebox`           | no      | `{ cwd, tracks }` |
| `audio`             | no      | `{ path, …player state }` |
| `video`             | no      | `{ path, …player state }` |
| `directory-tree`    | no      | `{ root, expanded set }` |
| `directory-columns` | no      | `{ cols stack }` |
| `shell`             | no      | `{ sessionId, pty }` |
| `tabline` (new)     | no      | `{ tabs: View[], active: number, edge }` |

The "maybe" rows (`customize`, `doc`) need the sub-agent to look at
the existing view modules and decide. If a kind currently uses
`buffer.text` for anything, that's a hint it has a buffer.

## File-by-file walkthrough

### `packages/view/` (new) or `packages/buffer/src/view.js` (alternative)

The `View` factory + the kind registry. Skeleton:

```js
const kindRegistry = new Map();

export function registerViewKind(kind, spec) {
  // spec: { mount(view, container), unmount(view, container),
  //         setView(view), needsBuffer, persister?, modeline? }
  kindRegistry.set(kind, spec);
}

export function getViewKindSpec(kind) {
  return kindRegistry.get(kind);
}
```

This drives `app.js`'s mount/switch logic (see below) — replaces the
ten-way if/else.

### `apps/desktop/src/app.js`

- Rename `buffers` → `views` (the array of open things).
- Rename `currentIndex` accessor → expose `currentView()`.
- `mountView(kind)` becomes a loop over the registry, hiding all
  view containers and showing the one whose kind matches.
- `switchToBuffer(index)` → `switchToView(index)`. Body becomes:
  ```js
  const view = views[index];
  const spec = getViewKindSpec(view.kind);
  if (!spec) throw new Error(`unknown view kind: ${view.kind}`);
  mountView(view.kind);
  spec.setView(view);
  spec.focus?.();
  updateModeline();
  notifyViewsChanged();
  ```
- `killBufferAtIndex` → `killViewAtIndex`; uses spec hooks (e.g.,
  `spec.destroyOnKill?.(view)`) instead of the
  `if (victim.kind === 'audio' || ...)` chain.
- All the `buffer.kind === 'X'` predicates in app.js (lines 318, 326,
  398, 409, 448, 480, 493, 535, etc.) become `view.kind === 'X'`.
- Buffer-creating call sites (`buffers.push({ kind: 'X', ... })`)
  become `views.push(createView({ kind: 'X', buffer: ..., state: ... }))`.

### `packages/stdlib/src/buffer-primitives.js`

Two changes:

1. The session indirection (`{ current: Buffer }`) becomes a view
   session (`{ currentView: View }`) and the buffer helper resolves
   as `view.buffer` with a null check:

   ```js
   const buffer = () => {
     const v = session.currentView;
     if (!v) raiseLisp('no-current-view');
     if (!v.buffer) raiseLisp('no-buffer-here', `view "${v.name}" has no buffer`);
     return v.buffer;
   };
   ```

2. Rename: `'buffer-name'` → keep the alias? No — flag day. Remove
   `'buffer-name'`; add `'view-name'` that returns `session.currentView.name`.
   Same for other addressing primitives.

   **Keep as buffer-* (operate on the buffer of the current view):**
   `point`, `mark`, `buffer-text`, `buffer-length`, `buffer-line-count`,
   `buffer-substring`, `line-start`, `line-end`, `line-indent`,
   `buffer-major-mode`, `buffer-minor-modes`, `word-forward-offset`,
   `word-backward-offset`, `region-active?`, `cursor-buffer-start!`,
   `cursor-buffer-end!`, `set-buffer-text!`. These all reach through
   `view.buffer`.

   **Rename to view-* (operate on the view itself):**
   `buffer-name` → `view-name`,
   `set-buffer-name!` → `set-view-name!`.

3. Add new view primitives in a new
   `packages/stdlib/src/view-primitives.js`:
   `current-view`, `view-list`, `view-kind`, `view-buffer`,
   `switch-to-view!`, `kill-view!`, `other-view`, `find-view`.

### Lisp stdlib files

Affected (per grep): `buffers.lisp`, `buffer-menu.lisp`,
`keymap.lisp`, `modes.lisp`, `occur.lisp`.

- Rename `(current-buffer)` → `(current-view)` everywhere it means
  "the focused thing" (most call sites). Audit: some call sites may
  genuinely mean "the underlying buffer of the focused thing" — those
  become `(view-buffer (current-view))`.
- Rename `(switch-to-buffer X)` → `(switch-to-view! X)`. (Note: also
  add the `!` since the new convention per the stdlib sketch in
  PANES.md is bang-suffixed mutators.)
- `(buffer-list)` → `(view-list)`.
- Rename `buffers.lisp` → `views.lisp`? Probably yes; the file's
  purpose is now the view-list management.
- `buffer-menu.lisp` → `view-menu.lisp`? The menu shows views now,
  not bare buffers.

### Smoke test (`apps/desktop/scripts/smoke.js`)

Every `submit('(current-buffer)…')` and similar gets renamed. The
shell arm's `(kill-buffer!)` becomes `(kill-view!)`. Look for any
arm that relies on `buffer.kind` being on the buffer — those
need the view-kind translation.

### Unit tests

Search for `current-buffer` / `buffer-list` / `switch-to-buffer` in
`packages/stdlib/test/`, `packages/buffer/test/`, `apps/desktop/test/`.
Update each to the new names. Tests that operate on `point` / `insert` /
text content don't need to change.

## Things NOT to do this phase

- **No DOM restructuring.** The flat-leaves `<div class="pane">`
  model lands in phase 2. Phase 1 keeps the existing layout exactly.
- **No pane tree.** There's one pane (the whole window). The
  `View` lives in that single pane; the pane data structure can be a
  minimal stub for now.
- **No multi-window. No window factory. No IPC for windows.** Phase 4.
- **No split commands.** Phase 3.
- **No tabline-view rendering UI.** Register the kind; no
  `make-tabline-view` Lisp command, no on-screen tab control. Phase 3
  exposes it.
- **No agent-session reconciliation.** That branch needs revising
  *on top of* this work, after it lands.
- **No compatibility shims for `current-buffer` etc.** Flag day means
  flag day. Pre-1.0; the rename happens once.

## Branch + commit shape

- Branch: `agent-view-buffer-split`.
- Suggested commit cadence (each passes `pnpm test` + smoke):
  1. `feat(view): introduce View abstraction + kind registry` — add
     `packages/view/` (or the alternative location) with the
     factory + registry + the ten kind specs. App.js still uses the
     old buffers array; the new code is dormant.
  2. `refactor(app): switch from buffer.kind to view.kind dispatch` —
     app.js's `switchToBuffer` / `mountView` / `killBufferAtIndex`
     migrate to the registry. Buffers array becomes views array. UI
     unchanged.
  3. `feat(lisp): add view primitives; flag-day rename of buffer
     addressing primitives` — `view-primitives.js`, the
     `buffer-primitives.js` session change, the surface rename in
     stdlib Lisp files.
  4. `refactor(stdlib): rename current-buffer/switch-to-buffer/etc.
     call sites` — sweep through buffers.lisp, buffer-menu.lisp,
     keymap.lisp, modes.lisp, occur.lisp.
  5. `test: update smoke + unit tests for the renamed Lisp surface`.
  6. `chore: rename buffers.lisp → views.lisp; buffer-menu →
     view-menu` (if you take that step).
- Merge as `--no-ff` with full sub-commit history preserved.

## Test gate

Before each commit:
- `pnpm test` — every package green.
- `pnpm --filter @editor/desktop smoke` — PASS.

The smoke is the integration check that says "you didn't break
buffer-switching, file-opening, kill-buffer, modes, faces, themes."
If any of those break, the rename has a missed call site.

## When to stop and write to architect-notes.md

Per CLAUDE.md:
- The `customize` / `doc` audit (do they edit text or just render?)
  may surface a real ambiguity — if so, stop and ask.
- If the View location decision (new package vs `packages/buffer/`
  sub-module) feels load-bearing in a way that wasn't anticipated.
- If the `majorMode` / `minorModes` semantics — currently buffer-
  level — turn out to need a view-level twin to support modes that
  apply to non-text views. (The image view, for example, has its
  own keymap today; how does that surface as "mode" in the new model?)
- If the smoke arms imply assumptions about the old surface that
  aren't trivially renameable.

Stop cleanly (committed, tests passing on what you've done) and write
the question. Don't guess and proceed.

## Effort estimate

A focused day's work — comparable to v4 in surface area. The conceptual
shift is the cost; the actual code is straightforward renaming once the
shape is clear. Test discipline is what catches missed call sites.
