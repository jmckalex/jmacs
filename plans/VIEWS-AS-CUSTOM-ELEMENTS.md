# Views as custom elements — guide notes

Design document for a foundational refactor of the editor's view
system: make `View` a custom HTML element rather than a plain JS
object with a parallel renderer module. **Plan, not implementation.**

## Priority

**Highest priority work item.** All other branches and feature
threads pause until this lands on `main`. Branches in flight that
build on the current view system will need rebasing or rewriting;
that is an accepted cost. The conviction is that getting the core
addressing model right *now* is cheaper than carrying the parallel-
browser invariant through every future extension.

In-flight work that this blocks or affects:
- `agent-package-system-phase-1` — has Phase 1 + 2 of the package
  system + the modal palette redesign + the session-restore /
  cursor / minibuffer fixes. **Does not merge to main** until the
  refactor lands. Phase 2 work re-applies on top after the refactor.
- `plans/SNIPPETS.md` — design only, unaffected. The snippets *
  implementation* would consume the new view model.
- `agent-reactive-notebook`, `agent-lsp`, `agent-file-nav` —
  unchanged on disk; each will need a once-over against the new
  view base class before merging.

## Why now

The bug surface has a pattern. The same shape recurs:

1. The editor *intends* "one View handle is parented in exactly one
   pane" (Q9 of `plans/PANES.md`, resolved May 26).
2. The code doesn't enforce it at the structural mutations
   (`addTabToTabline`, `promoteToTablineOnPane`, session restore).
3. A path lets the same View land in two places.
4. A close / kill / mount operation does the documented "right
   thing for a singly-parented View" — and the doubly-parented case
   yanks the second pane out from under the user.

Three concrete bugs this session traced to that pattern:
- *Linked tablines on close-X* (right pane's cats.html killed left
  pane's cats.html). The fix was `forceDuplicate` in session
  restore — necessary but a *symptom* fix.
- *Many copies of one file in a tabline* after restart. Two
  upstream fixes were needed; the deeper issue was unchecked
  accumulation in the auto-duplicate path.
- *Directory-view file-open overlay* (still unresolved, now a
  documented heisenbug). The cross-pane element-sharing inside
  `editor-host` is the candidate root.

Each fix has so far been a downstream patch. We're effectively
reinventing the DOM's parent-child invariant in JS, badly. The
browser already enforces it — for free, by spec, at every mutation.

## The proposal in one paragraph

Replace `View` (the plain JS object created by `createView` in
`packages/view/src/view.js`) with a custom element class per view
kind: `<text-view>`, `<image-view>`, `<shell-view>`,
`<tabline-view>`, and so on. The element is the View; its `parentElement`
is the structural owner; its `connectedCallback` /
`disconnectedCallback` are the mount / unmount hooks. The renderer
view modules (`createEditorView`, `createImageView`, …) become the
class implementations. The `kindRegistry` mechanism that ties the
two together today disappears.

## What this collapses

A short list of code that exists *only* to simulate what the DOM
already does, and which goes away under the new model:

- `kindRegistry` in `apps/desktop/src/app.js` — the
  `mount` / `dispose` / `modeline` / `hasBuffer` spec dispatch.
  Replaced by `connectedCallback` / `disconnectedCallback` and
  per-class getters.
- `mountTablineActiveChild`, `mountTablineActiveChild`'s "non-text
  child re-parents the singleton into the tabline content area"
  branch, `singletonElementForKind`. A `<tabline-view>` *is* a DOM
  element; its children are its tabs; activating a tab is a
  per-element attribute toggle.
- `hideInactiveRendererViews`. Visibility of non-focused elements
  is per-element CSS; we don't need a sweep.
- `inheritExistingEditorIntoTabline`. Moving a custom element
  preserves state automatically.
- `removeViewFromAllTablines`. An element can only be in one
  place; nothing to scan.
- `editorViewByPaneId` (mostly). The editor instance *is* the
  element parented in the pane; `pane.querySelector('text-view')`
  is the lookup.
- `singletonElementForKind` and the boot-time "directory tree
  singleton parented in the first leaf" workaround. Each view kind
  is its own element; there's no shared singleton to re-parent.

The deletion list alone is meaningful. Most of those modules exist
because we're maintaining an out-of-band map between View handles
and DOM elements.

## What it gives us (positive consequences)

- **Q9 enforced by the platform.** A View in two panes is
  unrepresentable; the DOM single-parent invariant catches it at
  the second `appendChild`.
- **Move-not-clone is free.** Moving a `<text-view>` between
  pane containers fires `disconnectedCallback` then
  `connectedCallback`; internal state lives on instance fields and
  survives the move. The `inheritExistingEditorIntoTabline` dance
  goes away.
- **Devtools-greppable structure.** `document.querySelector('text-view[buffer-id="42"]')`
  works; `<div class="editor">` doesn't. Same for the smoke arm.
- **Per-kind encapsulation.** Each view kind is one class with its
  own state, methods and lifecycle. No more separate "renderer
  module" that maintains its own private state plus a "spec object"
  that wires it to the kind registry.
- **Closer to the platform.** Custom Elements is a Web Platform
  standard. Fewer bespoke abstractions for new contributors to
  learn.

## The five decisions

These need answers before any code lands. Each is a real fork.

### 1. Where does cursor state live?

Currently `view.point`, `view.mark`, `view.cursors[]` are top-level
fields on the View object — accessible from JS and Lisp via plain
property reads.

Options for a custom element:

- **(1a) Instance fields**: `this.cursors`, `this.point`,
  `this.mark`. Plain property access works for Lisp via the host
  bridge. Not visible in DevTools' Elements panel, but visible in
  the JS console / debugger as `$0.cursors`. **Recommended for
  high-frequency state.**
- **(1b) Private fields**: `#cursors`, with accessors. More
  encapsulated; requires Lisp to call methods rather than read
  properties (or keep public getter/setter pairs).
- **(1c) Attributes**: `<text-view data-point="100">`. Observable
  in DevTools and serialisable for free, but stringly-typed,
  triggers `attributeChangedCallback` on every cursor move (a hot
  path), and requires parsing on read.

Recommendation: **(1a) instance fields for cursors / point / mark
/ scroll**; **(1c) attributes for identity (`kind` via `tagName`,
`name`, `buffer-id`)**. Hybrid is fine and idiomatic.

### 2. How does a text view reach its buffer?

Today: `view.buffer` is a direct reference to a `Buffer` object.

Options:

- **(2a) Direct reference**: `this.buffer` is the buffer instance.
  Set via `setBuffer(buffer)`. Simple.
- **(2b) Attribute + registry**: `<text-view buffer-id="42">`,
  the editor maintains a `Map<id, Buffer>`. Serialisation-friendly
  but indirect.

Recommendation: **(2a)** direct reference, with `setBuffer` as the
mutator. The buffer pool stays a JS-side data structure; the
relationship between views and buffers is a JS reference, not an
attribute.

### 3. What's "hidden but not unmounted"?

Today, non-active singletons are kept in the DOM with `display:
none`. Their JS state survives because the DOM node survives.

In the custom-elements world, two semantics matter:

- **DOM tree changes** fire `connectedCallback` /
  `disconnectedCallback`. Used for true mount / unmount.
- **Visibility changes** (CSS `display`, the `hidden` attribute)
  do not fire lifecycle. Element stays in the tree.

Options:

- **(3a) `display: none` for hide; detach for true unmount.**
  Tab-switch in a tabline = toggle visibility of children. Lifecycle
  fires only for real mount / unmount. **Recommended.**
- **(3b) Detach on hide.** Every visibility change fires lifecycle.
  More uniform but means tab switches re-fire mount hooks
  needlessly, and per-tab state must survive detach (it does, via
  instance fields).

(3a) preserves the current "expensive setup once, cheap toggle"
property of tab switching.

### 4. How does a tabline-view manage its tabs?

A `<tabline-view>` contains child view elements. Two options for
what's actually in the DOM tree:

- **(4a) All N tabs are children at all times; one has `[active]`
  attribute; CSS hides the others.** Cheap switch; matches the
  current keep-instances-alive model in `mountTablineActiveChild`.
  Tab close = `removeChild`. Tab add = `appendChild`. Tab reorder
  = `insertBefore`. **Recommended.**
- **(4b) Only the active tab is in the DOM; switching detaches
  current and attaches next.** Lifecycle fires on every switch;
  per-tab state must be preserved in a JS-side map and re-applied
  on attach.

(4a) is closer to current behaviour, simpler, and uses the DOM as
the source of truth for tab membership.

### 5. What does the migration of renderer view modules look like?

The biggest scope item. Each of these becomes a class extending
`HTMLElement`:

- `createEditorView` → `class TextView extends HTMLElement`
- `createImageView` → `class ImageView extends HTMLElement`
- `createAudioView` → `class AudioView extends HTMLElement`
- `createVideoView` → `class VideoView extends HTMLElement`
- `createShellView` → `class ShellView extends HTMLElement`
- `createJukeboxView` → `class JukeboxView extends HTMLElement`
- `createDirectoryTreeView` → `class DirectoryTreeView extends HTMLElement`
- `createDirectoryColumnsView` → `class DirectoryColumnsView extends HTMLElement`
- `createCustomizeView` → `class CustomizeView extends HTMLElement`
- `createDocView` → `class DocView extends HTMLElement`
- `createPackagePalette` (overlay, not a view) — keep as a class
  but distinct from the kind hierarchy.
- (new) `class TablineView extends HTMLElement`

Each gets:
- A no-arg constructor (custom-elements requires this).
- `connectedCallback()` / `disconnectedCallback()` for lifecycle.
- A `setBuffer(buffer)` / `setView(view)` / `setEntries(entries)`
  method for initial population (called after construction).
- Instance fields for state.
- `attributeChangedCallback` for the observed attributes (the
  identity / config ones).

`customElements.define('text-view', TextView)` registers the
element; `document.createElement('text-view')` constructs one.

## Suggested phasing

Each phase ends with the app running.

### Phase 0 — Decisions

Answer the five questions above. Each shapes every class.

### Phase 1 — Infrastructure

- A tiny module — `packages/renderer/src/view-elements.js` —
  with shared helpers (the registration bootstrap, attribute
  coercion helpers). **No base class.** Each view kind extends
  `HTMLElement` directly; the discipline (a `destroy()` method,
  the lifecycle conventions) lives in documentation, not in
  inheritance.
- A small desktop-side module —
  `apps/desktop/src/view-warehouse.js` — for the warehouse-
  lookup and move-to-warehouse helpers.
- The `<div id="view-warehouse" hidden>` element in
  `apps/desktop/index.html`.
- Pure-helper tests for the attribute coercion (`numAttr`,
  `strAttr`, `boolAttr`, `setBoolAttr`).

**Lifecycle test harness deferred.** The original Phase 1 plan
mentioned jsdom for a custom-element lifecycle harness; the repo
deliberately has no jsdom (renderer tests are pure functions over
mocks; DOM components are exercised by the smoke arm). The
deferred choice: continue the smoke + pure-function pattern, and
only introduce jsdom (or happy-dom) if a per-kind unit test for a
lifecycle subtlety becomes necessary. The lifecycle conventions
themselves are surfaced in
`packages/renderer/src/view-elements.js`'s file-level
documentation.

### Phase 2 — TextView + TablineView

The two highest-traffic kinds. Done together because tabline
contains text views, and the contract between them is the most
subtle.

Specifics:
- `TextView` wraps the existing `createEditorView` logic. The
  closures become class fields. `setBuffer(buffer)` /
  `setView(view)` replace the existing entry points.
- `TablineView` contains its tabs as children. The active tab has
  `[active]`; CSS toggles visibility. Strip rendering happens in
  Shadow DOM (optional but clean).
- `app.js` stops using `kindRegistry` for these kinds; uses
  `document.createElement('text-view')` / `'tabline-view'` instead.
- `mountTablineActiveChild` deletes its text-and-tabline branches.

Tests: the existing renderer tests for the pure helpers
(`filterPackageRows`, `nextSelectionRow`, etc.) keep working. New
tests cover the lifecycle: `connectedCallback` runs on
`appendChild`, instance state survives `disconnectedCallback` +
re-`appendChild`, the `<tabline-view>` active-attribute toggle
shows the right child.

### Phase 3 — Sweep the remaining kinds

In order of independence (least-coupled first):
- image, audio, video — file-backed, simple.
- shell — has the pty integration; needs care that
  `disconnectedCallback` doesn't kill the child process (we want
  hide-not-kill semantics, per Decision 3).
- jukebox — owns its own track list.
- directory-tree, directory-columns — the most-changed kinds in
  this session. The singleton-re-parenting bug we couldn't pin
  down goes away by construction.
- customize, doc — utility kinds, simple.

Each conversion deletes one `kindRegistry.register(...)` entry.

### Phase 4 — Delete the parallel infrastructure

After every kind is a custom element, the following are dead:
- `kindRegistry` (the module + the register calls).
- `singletonElementForKind`.
- `hideInactiveRendererViews`.
- `inheritExistingEditorIntoTabline`.
- The "directory tree singleton parented in the first leaf" block
  at boot.
- Most of `editorViewByPaneId` (replaced by
  `pane.querySelector('text-view')`).

Each deletion is its own commit. Tests stay green throughout.

### Phase 5 — Session restore validation

Under the new model, session restore *cannot* leave a View in two
panes (the DOM refuses). The `forceDuplicate` fix from this
session becomes the natural model: each blob → its own element,
optionally sharing a buffer with another element. Re-examine the
session schema for any leftover wart.

### Phase 6 — Re-apply the held branches

`agent-package-system-phase-1`'s feature commits get cherry-picked
or re-implemented on top of the new view base. The mechanical
work is non-zero but most of the package code lives outside the
view system.

## Effort estimate

A focused **4–7 days** of work. Best-case 4 (if the kinds convert
mechanically once the model is settled); worst-case 7 (if the
shell PTY interaction or the singleton-detach behaviour bite).

Phase 0 is half a day. Phase 1 is half a day. Phase 2 is two
days. Phase 3 is two days. Phases 4–6 are half a day each. Add
buffer for tests + smoke.

The pricing is conservative because every kind has its own
quirks: shell's pty, jukebox's track persistence, the directory
views' filesystem watching, the customize view's defcustom
rendering.

## Risks

- **Lisp interop surface.** Custom-element instances are plain JS
  objects from the interpreter's point of view. The
  property-access patterns work unchanged. **Risk**: the new
  classes expose all of `HTMLElement`'s methods/getters to Lisp;
  accidental access to `appendChild` / `insertBefore` from Lisp
  has weird side effects. Mitigation: document the convention
  (Lisp touches the data fields only) and add a Lisp-side wrapper
  if abuse appears.
- **Constructor restrictions.** Custom-element constructors must
  be no-arg and may not access children. State is set via methods
  called after construction. **Risk**: callers that today do
  `createEditorView(buffer, container, options)` need rewiring to
  `const el = document.createElement('text-view'); el.setBuffer(buffer);
  container.append(el);`. Tedious but mechanical.
- **`disconnectedCallback` semantics for processes.** Detaching a
  `<shell-view>` shouldn't kill the pty child process — the user
  may be re-mounting it elsewhere. We need explicit `destroy()` for
  true teardown; `disconnectedCallback` is just "I'm not currently
  in the tree." Same for audio / video.
- **The `editor-host` element.** Today it's a single container for
  all pane content with singletons re-parented around. Under the
  new model, each pane's `.pane` element is the container for that
  pane's view element. The `editor-host` element may not need to
  exist — each pane is its own subtree.
- **Smoke arm and existing tests.** Selectors like
  `document.querySelector('.editor')` need updating to
  `document.querySelector('text-view')`. Most other tests are at
  the buffer / lisp level and don't care.

## Non-goals

- Shadow DOM isolation. The editor's CSS reaches into all view
  elements today; Shadow DOM would force a reorganisation. Stay
  with light DOM unless a specific kind benefits.
- A View base class that all kinds extend beyond `HTMLElement`.
  Each kind gets its own behaviour; the discipline is uniform
  lifecycle method names, not inheritance.
- Reactive frameworks (Lit, Stencil, etc.). Plain custom-element
  classes are enough; the editor is small and the abstraction
  cost of a framework outweighs the convenience.

## Phase 0 decisions — SETTLED 2026-05-29

The five open questions, resolved in conversation.

### 1. Cursor state location — instance fields + identity attributes

High-frequency state (`point`, `mark`, `cursors[]`, scroll position)
lives as plain instance fields on the element class. Identity-like
state (name, kind via tagName, buffer-derived file path) lives as
attributes, with a `data-file-path` mirror used so the Elements
panel reveals which file each `<text-view>` shows.

**Why**: cursor moves happen tens of times per second; attribute
writes fire `attributeChangedCallback` on every change and incur
string-parse overhead. Instance fields are the same performance as
today's plain-object access. Attributes carry their weight only
where the Elements-panel visibility is worth the cost.

### 2. Buffer reference — direct, with `data-file-path` mirror

`this.buffer` is a direct JS reference to the buffer object,
written by `setBuffer(buffer)`. The buffer pool stays a JS-side
`Map<filePath, Buffer>` — buffers are L2 storage, not a DOM
concern. The `data-file-path` attribute mirrors `this.buffer.filePath`
read-only so DevTools shows what each view points at.

**Why**: there is no benefit to indirection through a
`buffer-id` registry. The view-buffer relationship is a runtime
JS reference, and the supposed serialisation win of an attribute-
based reference is hypothetical (session restore goes through JS,
not HTML).

### 3. Hide / mount / destroy — three-state lifecycle via a warehouse

A view's lifecycle is a state machine, not a binary attached /
detached:

```
[constructed]
     │  warehouse.appendChild(view)
     ▼
[warehoused] ←──────────────┐
     │                       │
     │  pane.appendChild(…)  │  warehouse.appendChild(…)
     ▼                       │  (e.g. owning pane is being torn down)
[live in pane]──────────────┘
     │  view.destroy() + view.remove()
     ▼
[destroyed]
```

The **warehouse** is a single hidden DOM element appended to
`<body>` at boot:

```html
<div id="view-warehouse" hidden></div>
```

`hidden` does the right thing: `display: none`, removed from the
accessibility tree, skipped by tab focus, zero layout cost. The
warehouse is where every view lives between "just created" and
"attached to a pane," and where surviving views go when their
pane is closed.

**Lifecycle rules:**
- `connectedCallback` fires every time the element joins a parent
  in the document. Used for "wire up DOM-relative state, start any
  cheap observers." Idempotent — called every move.
- `disconnectedCallback` fires every time the element leaves a
  parent. **It is allowed to be empty.** No load-bearing logic
  here. Movement (pane → warehouse, pane → another pane) is
  indistinguishable from teardown inside the callback.
- `destroy()` is the only place external handles are released —
  pty kill, audio/video tear-down, file handle close, timer
  cancellation. It is invoked explicitly by the editor (Lisp's
  `kill-view!`), never by the platform.

A view kind that releases a pty inside `disconnectedCallback`
breaks the moment the user moves the view from pane A to pane B.
Documentation for view-kind authors must make that mistake
trivially detectable.

**The save-on-quit prompt for unsaved file-backed buffers is
unchanged** — it lives at the buffer layer, not the view layer.
A view being warehoused doesn't bypass the save prompt; closing
the app does.

### 4. Tabline tab management — all-attached, `[active]` marks visible

A `<tabline-view>` element's children *are* its tabs, in display
order. The active tab carries `[active]`; CSS hides the rest:

```css
tabline-view > :not([active]) { display: none; }
```

Tab operations are DOM operations:
- Add tab: `tablineEl.appendChild(viewEl)`.
- Remove tab: `viewEl.remove()` (goes to GC unless something else
  grabbed it; the close-X path typically moves it to the warehouse
  instead — see Decision 3).
- Reorder: `tablineEl.insertBefore(viewEl, otherEl)`.
- Switch active: clear `[active]` from the current; set on the
  target.

**Why**: matches Decision 3 — visibility is a CSS concern,
lifecycle fires only for real mount / unmount. Tab switches are
cheap (no lifecycle, instance state untouched). The "two views
over one file" case is structural — two distinct elements
somewhere in the tree.

### 5. Constructor surface — no-arg + setters, optional helpers

Custom-element constructors must take no arguments. State is
configured after construction via setter methods:

```js
const el = document.createElement('text-view');
el.setBuffer(buffer);
warehouse.appendChild(el);  // or: pane.appendChild(el);
```

For the common case per kind, a one-line helper is friendlier:

```js
function createTextView(buffer) {
  const el = document.createElement('text-view');
  el.setBuffer(buffer);
  return el;
}
```

The discipline: every view class must be robust to "configuration
not yet set." `connectedCallback` cannot assume `this.buffer`
exists. Most kinds defer rendering until `setBuffer` /
`setEntries` / `setPath` is called.

### 3.1 — Warehouse persistence policy

The warehouse holds views the user has open but is not currently
viewing — the union of "every view minus what's in some pane."
The question is whether to persist it across a quit-relaunch.

**Decision: discard the warehouse by default; expose
`*persist-warehouse*` defcustom for users who want it sticky.**

```lisp
(defcustom *persist-warehouse* #f :boolean
  :group 'session
  :doc "When #t, the contents of the view warehouse — open views
   not currently in any pane — are saved to session.json on quit
   and restored on next launch. Default #f: only the pane tree is
   persisted; warehoused views are discarded on quit. Recommended
   only for users who treat the warehouse as 'tabs I haven't
   closed yet' rather than 'views I've forgotten about'.")
```

**Why**: most warehoused views will be non-text kinds (jukebox,
audio, video, shell, directory-*) whose state is genuinely
transient. Across many sessions, persisting them would
accumulate the Raiders warehouse — forgotten jukeboxes from
weeks ago, defunct directory views from deleted folders, shell
sessions whose ptys are long gone. The discard default keeps
relaunches lean.

**Safety**: text views with file paths and unsaved changes get
caught by the save-on-quit prompt at the buffer layer, regardless
of whether their view is currently warehoused. Discarding a
warehoused view that has been saved loses nothing — the file
opens again via find-file / recents.

Ephemeral text views (`*scratch*`, `*Customize: foo*`, names
matching `*…*`) are already filtered out of session persistence
today via `isEphemeral` and stay filtered out.

## Acceptance for the refactor

The refactor is "done" when:

- Every existing view kind is a custom element.
- The `kindRegistry` module is deleted.
- `hideInactiveRendererViews` is deleted.
- `inheritExistingEditorIntoTabline` is deleted.
- `removeViewFromAllTablines` is deleted.
- All existing tests pass (modulo the selector updates).
- The package palette and session-restore work from
  `agent-package-system-phase-1` is re-applied on top.
- A new test asserts the Q9 invariant: attempting to append a
  View element to a second container throws (the browser
  enforces it).
- Smoke arm passes (tree-view regression continues — that's a
  separate issue).

## Closing note

This refactor isn't glamorous — it's mostly the same UI doing
mostly the same things — but it removes an entire dimension of
bug surface. The editor's "two parallel structures kept manually
in sync" model is replaced by "the DOM tree *is* the structure,
and the lifecycle is the platform's." Every future feature that
adds a view kind costs less to integrate; every future bug
chase has a smaller graph to search.

The cost is now. The savings compound for the life of the
project.
