# Views: architecture and invariants

A reference for myself (Claude) and future versions of myself. The pane
and view code is the part of this codebase that's bitten me most often,
and the bugs share a small set of root causes. This document is the
condensed playbook of what holds, where each responsibility lives, and
which operations are safe in which order.

Read `docs/ARCHITECTURE.md` first for the broader picture. This
document narrows to the runtime data structures and the rules that
govern them.

---

## The big picture

A **view** is a runtime handle for something the user is looking at —
a text file, an image, a video, a browser, a directory listing, a
shell, etc. Views are the unit of buffer + cursor + chrome.

A **pane tree** carves the editor area into rectangles. Each leaf in
the tree holds a view. Splits are purely structural. Some leaves hold
a **tabline-view** instead of a direct view; a tabline contains
several views as tabs and shows one at a time.

The DOM mirrors this: one `<div class="pane">` per leaf, optionally a
`<tabline-view>` inside, and inside that the per-tab view elements
(`<text-view>`, `<browser-view>`, etc.). Custom elements give every
view its own DOM identity.

---

## Data structures and where they live

### Globals (`apps/desktop/src/app.js`)

| Name | Type | Purpose |
|---|---|---|
| `views` | `View[]` | Global list of every live view. Order is user-visible (next/previous cycling, *Buffer List*). |
| `currentViewIndex` | `number` | Index into `views` of what the focused pane is showing. Must stay synchronised with the pane tree's focused leaf. |
| `currentTextBuffer` | `Buffer \| null` | Cached buffer of the focused text view. Used by the modeline's text branch and by sticky-notes. **Separate cached reference from `views[currentViewIndex]` — they must agree but are not the same variable.** |
| `rootPane` | `Pane` | Root of the pane tree. |
| `currentPaneId` | `string` | Id of the focused leaf. |
| `paneElements` | `Map<leafId, .pane element>` | DOM mirror of the pane tree's leaves. |
| `editorViewByPaneId` | `Map<leafId, <text-view>>` | The per-leaf `<text-view>` instance for leaf-direct text leaves. |
| `tablineStateByView` | `Map<View, TablineState>` | Per-tabline state: container, strip widget, contentEl, `editorByChild`. |
| `SINGLETON_VIEWS` | `Array` | **Legacy.** Module-level singleton view-elements (browser, pdf, image, audio, video, etc.). Mostly vestigial under per-view-instance; kept hidden by `hideInactiveSingletons`. |
| `rootTablineView` | `View \| null` | The boot-time root tabline, kept so the kill path can replace it with `*scratch*` rather than collapse the root. |

### Pane tree (`packages/pane/src/`)

- `Leaf { kind: 'leaf', id, view }` — holds one view. `view` may be a
  text/image/video/etc. view directly ("leaf-direct" case) or a
  `tabline-view` containing tabs ("tabline" case).
- `Split { kind: 'split', id, orientation, ratio, first, second }` —
  purely structural; no view.
- `replacePane`, `insertAtSplit`, `insertAtRootBorder` —
  copy-on-write tree mutations. Always re-assign `rootPane` to the
  return value.

### Tabline state (per `tablineStateByView` entry)

| Field | Purpose |
|---|---|
| `container` | The `<tabline-view>` custom element parented in the leaf's pane. |
| `stripEl` | `<div class="tabline-strip">` (host-managed mode). |
| `contentEl` | `<div class="tabline-content">` — every tab's view-element lives here. |
| `strip` | The strip widget from `createTabline` — has `refresh()` and `setEdge()`. **`refresh()` calls `element.replaceChildren()`** — see "DOM detachment hazard" below. |
| `editorByChild` | `Map<View, Element>` — per-tab view-element. The authoritative ownership map for tab visibility. |
| `activeEditor` | The text-view instance bound to the active tab (when the active tab is text). |

### View kinds and their elements

Each kind has:

1. A **View object** (`{kind, name, buffer?, extras?, ...}`) created
   via `createView` from `packages/view/src/view.js`.
2. A **custom element** (`<text-view>`, `<browser-view>`, …) defined
   in `packages/renderer/src/`.
3. A **configure factory** in `apps/desktop/src/app.js`
   (`configureBrowserView`, `configureTextView`, …) returning the
   per-mount options the renderer needs.
4. **Optionally** a singleton instance in `SINGLETON_VIEWS`.

Per-tab elements are created by **`ensureTabElement(state, child)`**.
Leaf-direct text-views are created by
**`ensureEditorViewForLeaf(leaf)`**.

---

## Critical Q-numbered design decisions (from `plans/PANES.md`)

- **Q2** — Per-view-point: each view owns its own cursor. Two views over
  the same buffer have independent point/mark.
- **Q6** — Empty tabline auto-collapses its pane. The root pane
  substitutes a fresh `*scratch*` instead of vanishing.
- **Q9** — *No same View object in two visible positions.* Two text
  views over the same buffer (auto-duplicate) must be **separate
  objects**. `views.indexOf` and `tabs.indexOf` use reference equality;
  the wrong identity means closing one closes the other.
- **Q10** — Nested tablines are allowed; peel through to the deepest
  active child when resolving "what the user is editing".
- **Q15** — Pane-creating commands return handles so callers can
  compose against the result.

---

## The per-view-instance shift (architectural context)

Originally each view kind had a single DOM element ("singleton")
created at boot, parented to the first leaf's pane element. Switching
to an image: re-parent the singleton, `setBuffer(view)`, show.

This broke when:
- A tabline had multiple non-text tabs (you needed N singletons).
- Two panes showed the same kind (you'd re-parent on every focus change).
- A browser tab's navigation state needed to survive a tab switch
  (you couldn't reuse one webview across tabs).

The fix is **per-view-instance**: each View has its own DOM element,
created lazily by `ensureTabElement` (per tab) or
`ensureEditorViewForLeaf` (per leaf-direct text leaf).

`SINGLETON_VIEWS` still exists. Its instances sit hidden under
`#editor-host` and are largely vestigial. **They are not the
authoritative DOM representation of a view anymore** — that's the
per-tab / leaf-direct element. The only thing the singleton list is
still used for is `hideInactiveSingletons` (which ensures they stay
hidden when no leaf shows their kind directly).

---

## Key flows

### Opening a file (`openFileByPath` in `app.js`)

1. Read content from host.
2. `existing = views.findIndex(v => viewFilePath(v) === path)`.
3. If `existing >= 0` and the focused pane is **different** from where
   `existingView` lives → **auto-duplicate** (Q9): create a new View
   over the same buffer with its own point/mark, push to `views`,
   switch to it.
4. Else if `existing >= 0` and the focused pane already has it →
   return existing (no-op).
5. Else create a fresh View, push to `views`, switch.

`forceDuplicate: true` is used by **session restore** so each blob
gets its own View handle — without it, restoring a session with the
same path in two tablines would collapse to one shared View and
closing either tab would kill both.

### Switching views (`switchToViewIndex` in `app.js`)

Two branches based on what the focused leaf holds:

- **Tabline branch** (`focused.view` is a tabline-view): if the target
  view isn't already in `tlv.tabs`, push it; then
  `activateTabInTabline(tlv, tabIndex)`; updateModeline.
- **Non-tabline branch** (leaf-direct case): `focused.view = view`,
  re-parent the kind's singleton if applicable,
  `hideInactiveRendererViews(view.kind)`, `mountKindView(view)`,
  updateModeline.

### Activating a tab (`activateTabInTabline` in `app.js`)

1. `tlv.active = idx`.
2. `state.strip.refresh()` — **this calls `element.replaceChildren()`
   on the strip's `<div class="tabline">`**, detaching every existing
   tab element and creating new ones. See "DOM detachment hazard".
3. `mountTablineActiveChild(tlv)` — see below.
4. If this tabline is in the focused leaf, sync `currentViewIndex` to
   the new active tab's index in `views` and call `updateModeline`.
   *(Necessary because openFileInTabAdjacent / directory-tree
   double-click and other callers go through here without
   `switchToViewIndex`.)*

### Mounting a tabline's active child (`mountTablineActiveChild` in `app.js`)

1. Eagerly create elements for **non-text** tabs (so they're already
   in `contentEl` and don't pop in lazily).
2. Read the active child from `tlv.tabs[tlv.active]`.
3. Orphan sweep on `contentEl`: any `-view` element not in
   `editorByChild` is destroyed and removed.
4. **Display loop**: iterate `editorByChild`; set `display: ''` on the
   active child's element, `display: 'none'` on every other. **This is
   the single source of truth for per-tab visibility.**
5. Branch by kind:
   - `text`: `hideInactiveSingletons`, `ensureTabElement`, set
     `display: ''`, `applyTextMountSideEffects`.
   - `tabline` (nested): `hideInactiveSingletons`, recurse via
     `mountKindView`.
   - other (browser/video/image/…): `hideInactiveSingletons`, focus
     the per-tab element.

### Killing a view (`killViewAtIndex` in `app.js`)

1. `disposeKindView(victim)` — shell pty kill, audio/video teardown.
2. `views.splice(target, 1)`.
3. `removeViewFromAllTablines(victim)` — strips the View from every
   tabline that contained it (uses reference equality).
4. Auto-collapse panes whose tabline went empty; the root pane
   substitutes `*scratch*` (Q6).
5. If `wasCurrent`, `switchToViewIndex(next)`.

### Focus changes

`focusPaneFromEvent` is registered on `editorHostEl`'s **mousedown
and click in capture phase** (see "DOM detachment hazard"). It finds
`event.target.closest('.pane')` and calls
`setCurrentPaneId(paneEl.dataset.paneId)`.

`setCurrentPaneId(nextId)` is the **single entry point for focus
changes**. It:

- Updates `currentPaneId` and refreshes the `.pane--focused` CSS class.
- Peels the leaf's view through any tabline to the editable child.
- Syncs `currentViewIndex = views.indexOf(peeled)`.
- Rebinds the buffer's cursor to the new focused view (Q2).
- Re-points `editorView` to the focused leaf's editor instance.
- Updates the modeline.

---

## Invariants

### Identity

- **A View is its object reference.** Two text views over the same
  buffer are two distinct objects. `views.indexOf` and
  `tabs.indexOf` are reference-equality lookups; the wrong identity
  means closing one closes the other (Bug 2).
- **Each leaf has a stable `id`** preserved across tree mutations.
  `paneElements` keys on it.

### Containment

- **A view-element is in at most one parent at any time** — the DOM
  single-parent invariant gives Q9 by construction at the element
  level. Moving a view between tablines is
  `tablineB.addTab(viewElement)`; the DOM removes it from tablineA
  automatically.
- **All tab elements live inside
  `tablineStateByView.get(tlv).contentEl`**. Never append them
  elsewhere.
- **Leaf-direct text-views are direct children of `.pane`**. Use
  `:scope > text-view` to address them — a bare `text-view` selector
  matches tabline-nested tabs too and is the root cause of the
  multi-visible-text-view family of bugs.

### Visibility ownership

This is the part that's bitten me most often. **Every view-element's
display state has a single owner**:

| Element | Owner | Updates on |
|---|---|---|
| Per-tab view-element inside `.tabline-content` | `mountTablineActiveChild`'s display loop | Tab activation |
| Leaf-direct text-view (direct child of `.pane`) | `switchToViewIndex`'s non-tabline branch | The leaf's `.view` changes to/from text |
| Singleton view-element in `SINGLETON_VIEWS` | `hideInactiveSingletons` | Any time the set of leaf-direct view kinds changes |

**Do not cross these lines.** Specifically:

- **Do not** use `hideInactiveRendererViews` from
  `mountTablineActiveChild`. That function toggles the *focused
  pane's* leaf-direct text-view based on its `activeKind` parameter
  — but in a cross-pane click the focused pane hasn't changed, only
  the activated tab in some other pane has. Use
  `hideInactiveSingletons`, which only manages the singleton list.
- **Do not** reach into `.tabline-content` with a bare `text-view`
  query from outside `mountTablineActiveChild`. The tabline owns its
  tab visibility.
- **Do not** poke a per-tab element's `style.display` from outside
  the display loop. If you need to show or hide a tab, change
  `tlv.active` and re-run the mount.

### State synchronisation

- After every **`views.splice`**, `currentViewIndex` must still be
  a valid index. Decrement when the splice removed something at a
  lower index; clamp to `views.length - 1`.
- After **`setCurrentPaneId`**, `currentViewIndex` must equal
  `views.indexOf(peelTabline(focused.view))`.
- After **`activateTabInTabline`** where the tabline is in the
  focused leaf, `currentViewIndex` must equal
  `views.indexOf(tablineActiveChild(tlv))`.
- The modeline reads from *both* `views[currentViewIndex]` *and*
  `currentTextBuffer`. They are separate cached references — both
  must reflect the same logical state. A `9/7` modeline (count
  beyond length) is the signature of `currentViewIndex` outliving
  the splice that shrank `views`.

### Ephemerality and session restore

These view kinds are **ephemeral** (not persisted across restarts):
browser, pdf, jukebox, shell, customize, doc. `viewToBlob` returns
`null` for them; restore won't recreate them.

This has a knock-on effect on `currentViewIndex` because:

- The focused view at save time is often a browser-view.
- On restore, the focused leaf takes whatever non-browser view ended
  up at its active-tab slot.
- `installRootPane` sets `currentViewIndex` against that.
- The boot-time welcome/scratch **seeds** that pre-loaded into
  `views` then get spliced out (they're useless when a saved tabline
  is the authoritative tab list).
- **That splice must update `currentViewIndex`.** Otherwise you get
  a modeline like `9/7`.

### DOM detachment hazard

`state.strip.refresh()` (in `tabline.js`) calls
`element.replaceChildren()` to update the `is-current` class. This
*detaches every existing tab element and creates fresh ones*. The
clicked tab is gone from the DOM by the time the strip refresh
returns.

Consequences:

- A `mousedown` handler on a tab triggers a synchronous strip
  refresh. By the time the event bubbles to ancestors,
  `event.target` is an orphan with no `.pane` ancestor —
  `target.closest('.pane')` returns `null`.
- **`focusPaneFromEvent` is registered in capture phase** so it
  runs before the tab handler. Bubble-phase registration would miss
  the focus change.
- Any other "where was this clicked" logic that runs after the tab
  handler will have the same problem. Either move to capture phase,
  or capture the answer before the tab handler fires.

---

## Known bug catalogue (cautionary tales)

These are the bugs this codebase has shipped. Each is a violation of
one of the invariants above — recognising the pattern makes the next
one faster to fix.

| Symptom | Root cause | Invariant violated |
|---|---|---|
| Multi-visible text-views in tabline | `hideInactiveRendererViews` used a bare `text-view` selector that matched tabline-nested tabs | Visibility ownership (per-tab) |
| Tabline strip vanishes after browser→text-tab switch | Same as above; defensively masked by `overflow: hidden` on `.tabline-content` | (defence in depth) |
| `9/7` modeline state | seed-splice didn't update `currentViewIndex` | State synchronisation |
| Directory-tree double-click doesn't update modeline | `activateTabInTabline` didn't sync `currentViewIndex` | State synchronisation |
| Close-one-closes-both in two tablines | Same View object in two `tabs[]` (auto-duplicate didn't fire) | Q9 / identity |
| Cross-pane tab click hides focused leaf's text-view | `hideInactiveRendererViews` called from `mountTablineActiveChild` toggled the *focused* leaf's text-view based on a *non-focused* tab's kind | Visibility ownership (leaf-direct) |
| Cross-pane tab click doesn't move focus | Strip refresh detaches the tab mid-event; bubble-phase `focusPaneFromEvent` finds an orphaned target | DOM detachment hazard |
| Jukebox / audio / video kill via synthetic C-x k doesn't fire | Smoke arm dispatched on the wrapper element, but the keydown listener is on an inner root div | (smoke arm bug, not production) |

---

## When in doubt

- **Before mutating display state**, ask: who owns this element's
  visibility? Match the table above. If you're not the owner, don't
  touch it.

- **Before adding a view to a tabline**, ask: is this View object
  already in another tabline? If yes, you need auto-duplicate.

- **Before splicing `views`**, ask: where else does the old length
  matter? Update `currentViewIndex` *in the same step*.

- **Before adding a click-target listener**, ask: does the handler
  mutate the DOM in a way that breaks the bubble path? If yes, use
  capture phase or capture the answer pre-handler.

- **Before introducing a new view kind**, ask: does it need a
  singleton, or is per-view-instance sufficient? Per-view-instance
  is the default for tabline-friendly kinds. Singletons are legacy
  and should be hidden in normal operation.

- **Before calling `hideInactiveRendererViews`**, ask: is this code
  path one where the focused leaf's view just changed? If not, use
  `hideInactiveSingletons`.
