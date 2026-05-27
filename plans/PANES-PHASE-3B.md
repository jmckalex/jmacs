# Phase 3b — tabline-view, per pane

Design notes for moving the tabline from window chrome to a view kind
that sits inside a pane. Per `plans/PANES.md` (Q11), tabs are not
window-level chrome at all — they're a view kind, and a pane that
wants tabs holds a tabline-view containing N child views. Phase 3a
landed the split / delete / navigate machinery; phase 3b finishes
the view-as-primary shift by giving tabs the same treatment.

This file follows `plans/PANES.md`'s style: model + open questions
first. Once Jason resolves the open questions, the file-by-file
implementation brief lands at the bottom — same pattern as
phase 1 / 2 / 3a.

## Why now

The phase-3a live test surfaced the problem concretely: with two or
three panes on screen, the single top-of-window tab strip shows
**every** view but doesn't say which pane is showing which. Clicking
a tab acts on whichever pane has focus — usable, but not what a user
wants when a tab "belongs" to a specific pane. Independent per-pane
tab lists are how every IDE works (VS Code editor groups, JetBrains
splitter tabs, Sublime view groups). PANES.md Q11 already settled the
shape; phase 3b is the work.

## The model

A **tabline-view** is a view, not chrome. It has:

```
tabline view = {
  id,                   ; the usual view id
  kind: 'tabline',
  name,                 ; modeline label (e.g. "tabs", or derived from active)
  tabs:    View[],      ; child views; never another tabline-view directly
  active:  number,      ; index into tabs
  edge:    'top' | 'right' | 'bottom' | 'left'
}
```

A pane's leaf may hold *either* an ordinary view (text, shell, image,
…) *or* a tabline-view. The pane still has exactly one view; the
tabline-view *contains* further views as a list.

### What gets rendered in a tabline pane

The pane's div sized by `relayoutPanes` is the bounding rect. Inside
it the tabline-view's kind-registry mount does two things:

1. Render a thin **tab strip** on the configured `edge` of the
   pane's rect. Strip thickness is constant (say 28 px); for
   `top`/`bottom` the strip is horizontal and full-width, for
   `left`/`right` it is vertical and full-height.

2. Render a **content area** filling the remaining rect, and
   recursively mount `tabs[active]` into it via
   `kindRegistry.mount(tabs[active], contentEl)`.

When the active tab changes, the registry's dispose hook on the
previously-active child runs (text views unmount their editor-view
instance for that pane; non-text singletons get hidden / detached);
then the new active child is mounted into the same content area.

### Focus resolution through a tabline-view

PANES.md (Tabline as a container view) already wrote this down:

> When focus is in a tabline-view, the focus indicator shades the
> outer pane border, but `(current-view)` returns the **active
> child**, not the tabline wrapper, and keymap dispatch goes into
> the active child.

So `(current-pane).view` is the tabline-view, but `(current-view)` is
`(current-pane).view.tabs[(current-pane).view.active]`. The
`view-primitives` resolution path updates accordingly: when the
focused pane's view is a tabline-view, peek through to the active
child for `(current-view)`. The tabline-view itself is still
addressable for tab-management commands (`(current-tabline)` or
similar).

## What changes versus today

### Removed

- `<div id="tabline-host">` in `index.html`. The chrome above the
  editor area goes away.
- `apps/desktop/src/tabline.js`'s role as "the global tab strip" —
  the **rendering** logic (DOM, drag, click, close button) survives,
  but it gets called from the tabline-view kind's mount hook with a
  parent element supplied by the pane, not from a fixed-position
  chrome host.
- The `host.tabline.refresh()` call site that fires on every
  `notifyViewsChanged()`. Tab strips re-render per-pane, driven by
  the tabline-view they belong to.

### Added

- The tabline kind's real mount/dispose hooks in the kind registry.
- Per-pane tabline-view membership (replaces the global flat list as
  *the* tabs source).
- Lisp surface: `(make-tabline-view tabs edge)`, `(add-tab! tlv view
  [index])`, `(remove-tab! tlv index)`, `(activate-tab! tlv index)`,
  `(tabline-edge tlv)`, `(set-tabline-edge! tlv edge)`,
  `(current-tabline)`, `(promote-to-tabline! pane)`.
- Auto-promote-on-open semantics (see Q2 below).
- Session schema v2 (see Q8).
- CSS for tab strips on each of the four edges.

### Kept

- The view list grows the same way it does today. The view list is
  still the global "view pool" — tabline-views *reference* views by
  identity, not by copying them.
- `apps/desktop/src/tabline.js`'s rendering core — `createTabline`
  remains a small DOM module, but it takes a per-tabline-view
  options shape (the `getViews` it reads is `() => tablineView.tabs`,
  not the global `views`), and the `onSelect` / `onClose` / `onReorder`
  callbacks operate on the tabline-view's tabs array, not the global
  list.
- `apps/desktop/src/session.js`'s *purpose*. The serialised shape
  grows; the role doesn't.

## Open questions

Resolve these before the implementation brief. Pattern matches
`plans/PANES.md`: my recommended lean is given; Jason's call wins.

1. **Default startup layout.** After phase 3b, when the editor boots
   and restores a saved session, does the root pane hold:
   - (a) a **tabline-view** containing the restored views (matches
     today's UX visually — strip on top, tabs are tabs), or
   - (b) the **first restored view** as a plain leaf, with the rest
     hidden until the user explicitly composes them?
   
   Lean: **(a)**. Today's user opens five files and sees five tabs
   above the editor; that should still happen post-3b. Tab strip is
   the default; users compose more or split them up via Lisp / `C-x
   2`/`3`/etc.

   I THINK (A). THE RESTORED VIEW SHOULD BE AS CLOSE AS POSSIBLE
   TO WHAT WAS CLOSED.

2. **Auto-promote on open.** When the user runs `(open-file-path!)`
   / `C-x C-f` and the current pane is a **plain leaf** (no
   tabline-view), do we:
   - (a) **auto-promote** the leaf to a tabline-view containing
     `[old-view, new-view]` and switch to `new-view`,
   - (b) **replace** the leaf's view with `new-view` and drop the
     old view from screen (it stays in the view list, accessible
     via `C-x b` etc.), or
   - (c) **error**: tell the user "this pane already shows a view;
     promote to tabline first or split"?
   
   Lean: **(a)**. Matches today's UX where opening a file creates a
   new tab. Replace-the-leaf (b) is what `(switch-to-view!)` does
   explicitly; (c) is too pedantic for the default file-open path.

   I THNK (B) - OPENING A NEW FILE FROM THE CURRENT PANE SHOULD
   REPLACE THE VIEW IN THE PANE WITH THE APPROPRIATE VIEW FOR THE
   FILE SELECTED.

3. **Auto-promote on auto-duplicate (Q9 path).** Phase 3a's
   auto-duplicate: opening a file already in another pane creates a
   fresh view over the same buffer and puts it in the current pane.
   If the current pane is a plain leaf, does (Q3) follow the same
   rule as (Q2) — auto-promote?
   
   I DON'T UNDERSTAND THIS QUESTION.

   Lean: **yes**. Consistent rule: opening any file into a plain
   leaf auto-promotes. Tabline-view present → add a tab.

4. **`C-x b` (switch-view) scope.** Today: fuzzy-find across the
   global view list. After 3b:
   - (a) **current pane's tabs only** (most local),
   - (b) **all views globally**, raising the Q9 collision error on
     selecting a view already shown in another pane,
   - (c) **all views globally**, *moving* the chosen view into the
     current pane (deleting it from the source) on selection,
   - (d) **all views globally**, with the picker hiding views shown
     in other panes so you can't pick one.
   
   Lean: **(d)**. Same muscle memory ("switch to a view by name")
   without the collision-error surprise. A view in another pane is
   not switchable-to; if you want it here, you split or open-file
   it (auto-duplicate gives you a fresh view over the same buffer).
   
   (D)

   Note: (d) means the picker's source set is `viewList -
   (views_visible_in_other_panes)`. Implementation is a one-line
   filter.

5. **`C-x ←` / `C-x →` (previous-view / next-view) scope.**
   Today: cycle the global view list. After 3b:
   - (a) **cycle the current pane's tabs**,
   - (b) **cycle the global view list** (Q4-style filter applies).
   
   Lean: **(a)**. The tab strip's whole purpose is "the tabs in
   this pane"; arrow-cycling should match. Cycling globally feels
   unrelated to what the user is looking at.

   SURE - LET'S TRY THIS.

6. **`C-x k` (kill-view) UX.** Today: kills the current view.
   After 3b:
   - If the current pane is a **plain leaf** with one view: kill
     the view. Pane becomes empty leaf → ??? (auto-collapse to
     sibling, per `delete-pane!` semantics, or leave an empty leaf
     showing `*scratch*`?).
   - If the current pane is a **tabline-view** with multiple tabs:
     kill the active tab; the previous tab becomes active.
   - If the current pane is a **tabline-view** with one tab: kill
     the tab; pane becomes ??? (collapse to leaf with `*scratch*`,
     or auto-collapse pane to sibling).

  NO - IF THE CURRENT VIEW IS A PLAIN LEAF, KILL THE VIEW
  AND REMOVE THE PANE.

  THE ISSUE ABOUT TABLINE-VIEWS SHOULD NEVER ARISE: THE KILL-VIEW
  COMMAND SHOULD BE HANDLED BY THE VIEW IN THE TABLINE WHICH HAS FOCUS,
  AND IT SHOULD DIE. IF THERE IS ONLY ONE VIEW IN THE TABLINE, THEN THAT
  VIEW SHOULD DIE ALONGSIDE THE TABLINE.
   
   Lean: killing the last view in a pane **auto-collapses the pane
   into its sibling** (the same rule as `delete-pane!`). This
   matches Emacs's `C-x 0` behaviour: a window with nothing to show
   goes away. A pane with the only file open also goes away,
   unifying the rules. If the root pane is the only pane left and
   has nothing to show, fall back to `*scratch*` (the editor
   always has at least one editable surface).

7. **Tab close (×) button.** Same as `C-x k`? Yes — the × on a tab
   kills *that* tab (not necessarily the active one). Middle-click
   does the same. Confirm.
   
   Lean: **yes, confirm**.

   AGREED

8. **Persistence — session schema v2.** Today's `session.json`:
   ```
   { "buffers": [{ "path", "point", "mark" }], "currentPath": ... }
   ```
   Phase 3b adds: pane tree topology, per-pane tabline-view
   membership, active tab index, edge, focused pane id.
   
   Schema v2 sketch:
   ```
   {
     "version": 2,
     "rootPane": <pane-blob>,
     "currentPaneId": "pane-leaf-3"
   }
   pane-blob (leaf):
     { "kind": "leaf", "id", "view": <view-blob> }
   pane-blob (split):
     { "kind": "split", "id", "orientation", "ratio", "first":<pane>, "second":<pane> }
   view-blob (text):
     { "kind": "text", "path", "point", "mark" }
   view-blob (tabline):
     { "kind": "tabline", "edge", "active", "tabs": [<view-blob>...] }
   ```
   Non-text views stay ephemeral (not persisted; their pane gets
   `*scratch*` on restore).
   
   Migration: load v1 schema (today's `buffers` flat list) by
   wrapping it as `{ version: 2, rootPane: { kind: 'leaf', view: {
   kind: 'tabline', edge: 'top', active: <currentIndex>, tabs:
   [<each as text view-blob>] } }, currentPaneId: <root leaf id>
   }`. Save in v2 going forward.
   
   Lean: **migrate v1→v2 transparently**. Pre-1.0 we could just
   wipe session.json on first launch, but Jason has working sessions
   today and the migration is small.

   I DON'T UNDERSTAND, BUT AM INCLINED TO GO WITH YOUR RECOMMENDATION FOR NOW.

9. **Single-tab tabline-views — render the strip?** When a tabline-
   view has only one tab, does the strip still render (so the user
   sees they're in a tab group)?
   - (a) **always render** the strip (consistent visual; matches
     VS Code),
   - (b) **hide** the strip when there's one tab (more screen
     real estate),
   - (c) **collapse** the tabline-view into a plain leaf when
     reduced to one tab (auto-demote — inverse of auto-promote in
     Q2).
   
   Lean: **(a)**. Predictable; the user always knows whether
   they're in a tabline pane. The strip is 28 px; not a real
   real-estate cost. (c) sounds clever but means the pane's view
   identity changes invisibly, which makes `(current-view)` resolve
   differently in surprising ways.

   YES, (A)

10. **Nested tabline-views — allowed?** PANES.md says technically
    yes, discouraged. After 3b, does `(add-tab! tlv another-tlv)`:
    - (a) **error** (refuse to nest),
    - (b) **allow** (the tab strip renders, the active child is
      itself a tabline-view rendering its own strip).
    
    Lean: **(a) error**. The discouraged path becomes a footgun
    when the auto-promote rules interact. If a user really wants
    nested tabs they can author the kind themselves.

    ALLOW (B). IT'S UGLY BUT WE SHOULDN'T PREVENT.

11. **Tab reorder — within strip only, or across panes?** Today's
    drag-reorder swaps positions within the strip. After 3b, can
    the user drag a tab *from* one pane's tabline *to* another
    pane's tabline (moving the view across)?
    - (a) **within-strip only** for 3b; cross-pane drag deferred,
    - (b) **cross-pane drag** lands in 3b too.
    
    Lean: **(a) within-strip only**. Cross-pane drag is a real
    workflow but it's its own design problem (drop targets, visual
    feedback, what happens to the source pane if it becomes
    empty). Defer; phase 3c material.

    DEFER: IF WE CAN DO ACROSS PANE, THAT WOULD BE NICE. DON'T WORRY
    ABOUT IT FOR NOW.

12. **`C-x C-b` buffer-menu scope.** Today: lists every view.
    After 3b: still global (it's *the* "show me everything"
    surface), but with a column or marker showing which pane the
    view is in?
    
    Lean: **global, with a column**. The buffer-menu's job is the
    inventory; per-pane context is useful but doesn't redefine
    the menu's purpose.

    YES, SHOW ALL VIEWS.

13. **The tabline-view's `name`.** The view abstraction insists
    every view has a `name`. What does a tabline-view's name look
    like?
    - (a) the **active child's** name (changes when tabs switch),
    - (b) a **synthetic** like `"*tabs (3)*"` or `"tabline-1"`,
    - (c) **null** / empty (let the modeline render the active
      child directly).
    
    Lean: **(a)** — the modeline already reads `(current-view).name`,
    and `(current-view)` resolves to the active child (see "Focus
    resolution"). The tabline-view itself rarely needs a
    user-visible name; the few places that do (e.g. error
    messages) can synthesise one.

    I DON'T UNDERSTAND THIS QUESTION.

14. **Naming: `(promote-to-tabline! pane)`.** The explicit
    operation that wraps a plain leaf in a tabline-view (used by
    auto-promote internally and exposed for Lisp users).
    Alternative names: `(wrap-in-tabline! pane)`, `(group-pane!
    pane)`, `(tabify-pane! pane)`.
    
    Lean: **`(promote-to-tabline! pane)`**. Most descriptive.
    Confirm.

    I DON'T UNDERSTAND THIS QUESTION.

15. **Where the tab-strip renders inside the pane div.** Two
    layout strategies:
    - (a) **flexbox inside the pane div**: a row/column flex
      container with the strip and the content area as children.
      Simple CSS, no JS layout math.
    - (b) **absolute-positioned inside the pane div**: the strip
      and the content area each get explicit pixel rects, written
      by the kind's mount hook.
    
    Lean: **(a) flexbox**. The pane itself is absolute-positioned
    by `relayoutPanes`; once inside the pane, CSS flex is the
    obvious tool. The content area inherits the editor view's
    existing `setSize`-style behaviour (it doesn't care if its
    parent uses flex or absolute).

    LET'S GO WITH FLEXBOX, FOR NOW, AND CHANGE IF NEEDED.

## Sketch of stdlib surface (illustrative)

Resolved once the Qs above are settled; sketch for orientation:

```
;; Tabline-view construction (returns the tabline-view handle)
(make-tabline-view tabs edge)             ; ⇒ tabline-view
(promote-to-tabline! pane)                ; ⇒ tabline-view (wraps existing leaf)
(demote-tabline! tabline-view)            ; ⇒ pane (collapses to plain leaf)

;; Tab membership (returns the tabline-view for composition)
(add-tab!       tlv view [index])         ; ⇒ tlv
(remove-tab!    tlv index)                ; ⇒ tlv
(activate-tab!  tlv index)                ; ⇒ tlv

;; Tab strip configuration
(tabline-edge        tlv)                 ; ⇒ symbol
(set-tabline-edge!   tlv edge)            ; ⇒ tlv

;; Current-thing accessors
(current-tabline)                         ; ⇒ tabline-view in current pane, or nil
(current-view)                            ; ⇒ active child (already true for non-
                                          ;   tabline panes; now resolves through)
```

Auto-promote-on-open is a host-side behaviour, not a Lisp primitive
(or rather: a *flag* and the open-file primitives consult it). A
config slot like `*auto-tabline-on-open*` (default `#t`) lets users
turn it off if they want explicit composition.

## Non-goals for 3b

- Cross-pane drag-and-drop of tabs (deferred per Q11).
- Pinned tabs / unsaved-changes indicators beyond what today's
  tabline does.
- Tab grouping / hierarchical tabs (a tab containing other tabs).
- Per-tab modeline payloads. The modeline still reads the active
  child's modeline; the tab itself shows the same info today's
  tabs show (basename + close button).
- The OUTER UI (REPL pane, modeline, minibuffer, markdown-preview
  splitter) staying as chrome. Same boundary as 3a.
- Tabline-views in nested layouts inside another tabline-view
  (deferred per Q10).

## Risks worth flagging

- **Auto-promote-on-open changes the meaning of `views` (the global
  list).** Today `views[i].kind` is a leaf-kind; after 3b a view in
  the list may be a tabline-view whose tabs are also in the list.
  The `*Buffer List*` menu (Q12) and any code that iterates `views`
  needs auditing.

- **Session restore order matters.** When restoring a v2 blob the
  pane tree comes up *before* the views are added to `views`. The
  restore loop has to: (i) open each leaf-view's file (in order)
  producing the View handle, (ii) thread the right handle into the
  right tabline-view's tabs array, (iii) install the pane tree,
  (iv) focus the saved `currentPaneId`. Today's session restore is
  flat — this is a real complexity bump.

- **Recursive kind-registry mount.** The tabline-view's mount calls
  `kindRegistry.mount(activeChild, contentEl)`. Make sure dispose
  paths don't double-dispose when the pane itself is being torn
  down.

- **The DOM relocation.** `#tabline-host` is currently a sibling of
  `#editor-host` in `index.html`; its CSS positions it above the
  workspace. Phase 3b removes it. Any selector or pointer-event
  handler reading `#tabline-host` directly breaks (search the
  source).

- **Modeline doesn't know about tabline-views.** It reads
  `(current-view).name`; with the focus-resolution shift through
  the tabline-view (active child), it should Just Work — but
  verify; the modeline runs on every key.

## Resolved (2026-05-26)

Jason's calls, settled inline above; summary table:

| Q  | Answer                                                                 |
|----|------------------------------------------------------------------------|
| 1  | (a) root tabline-view containing restored views                        |
| 2  | (b) **tabline-view: add tab + activate**; **plain leaf: swap view**    |
| 3  | same rule as Q2 (tabline → add tab; plain leaf → replace)              |
| 4  | (d) all views globally; picker hides views in other panes              |
| 5  | (a) cycle current pane's tabs only                                     |
| 6  | kill the focused tab; tabline empties → pane auto-collapses            |
| 7  | × on a tab = `kill-view!` for that tab                                 |
| 8  | schema v2; migrate v1→v2 transparently                                 |
| 9  | (a) always render the strip                                            |
| 10 | (b) **allow** nested tabline-views (ugly but not forbidden)            |
| 11 | within-strip only for 3b; cross-pane drag deferred                     |
| 12 | global with a pane column                                              |
| 13 | (a) tabline-view's `name` = active child's name                        |
| 14 | `(promote-to-tabline! pane)` / `(demote-tabline! tlv)`                 |
| 15 | flexbox inside the pane div                                            |

Note on Q2/Q3 asymmetry: a **plain leaf** opens-file-in-place
(no auto-promote — the old view stays in the view list, not in any
pane). A **tabline-view** opens-file-as-new-tab. The user reaches a
plain leaf by splitting (the new sibling pane is a leaf containing
the duplicated view); the rest of the time they're in a tabline-view
since startup wraps restored views in one.

Note on Q4: tabline-views are *not* in the global view list (see
"Implementation: data model" below). The C-x b picker source is the
flat list of leaf-kind views (text/shell/image/...) minus those
visible in some *other* pane.

## Implementation brief

### Scope

- **The tabline kind's real mount/dispose hooks** in the kind
  registry. Replaces the phase-2 stub at
  `apps/desktop/src/app.js` ~line 3124.
- **Per-pane tabline-view membership.** Tabline-views are
  *structural* — they live only inside pane handles, not in the
  global `views[]`. The global list is leaf-kind views only.
- **Lisp surface**: `(make-tabline-view tabs edge)`,
  `(promote-to-tabline! pane)`, `(demote-tabline! tlv)`,
  `(add-tab! tlv view [index])`, `(remove-tab! tlv index)`,
  `(activate-tab! tlv index)`, `(tabline-edge tlv)`,
  `(set-tabline-edge! tlv edge)`, `(current-tabline)`. Plus a
  `view-primitives` resolution shift so `(current-view)` peeks
  through a tabline-view to its active child.
- **Auto-add-tab on open** when current pane is a tabline-view
  (Q2). Swap-view-in-leaf when current pane is a plain leaf.
- **Per-pane tab cycling** (`C-x ←` / `C-x →` operate on current
  pane's tabs only).
- **`C-x k` kills the focused tab**; auto-collapses pane when
  tabline empties.
- **`C-x b` picker** filters out views already shown in other
  panes.
- **Session schema v2** + v1→v2 migration.
- **Remove the global `#tabline-host` chrome**. The root pane's
  tabline-view (per Q1's startup) replaces it visually.
- **CSS for tab strips on top/right/bottom/left edges** via
  flexbox inside the pane div.

### Data model

A tabline-view is a view, of kind `'tabline'`, with extra fields
on the view handle:

```
{
  id:     'view-tabline-1',
  kind:   'tabline',
  name:   <derived from active child>,
  buffer: null,           // no L2 buffer
  tabs:   [<View>...],    // child views; leaf-kind in practice
  active: 0,              // index into tabs
  edge:   'top',          // 'top' | 'right' | 'bottom' | 'left'
}
```

`createView` already spreads `extras` onto the result. Make tabline
the same shape: `createView({ kind: 'tabline', extras: { tabs,
active, edge } })`. The `name` derives via the kind registry's
`viewName(view)` hook (a new optional hook on the spec) — for
tabline, return `view.tabs[view.active]?.name ?? '*tabs*'`.

**Tabline-views are NOT in the global `views[]`.** They live
*only* inside pane handles. Auto-promote / `make-tabline-view`
create them; the global list grows only with leaf-kind views.
This keeps `(view-list)`, the buffer-menu, find-view, the
isEphemeral check, and the session restore loop's leaf-view
iteration clean. The serializer walks the pane tree and emits
tabline-view blobs as part of the pane-blob structure (see
"Session schema v2").

### Focus resolution change

Today: `viewHost.currentView()` returns `paneHost.currentPane()?.view`.
After 3b: when `paneHost.currentPane()?.view.kind === 'tabline'`,
peel one layer — return `view.tabs[view.active] ?? null`. Tabline-
views never appear as `(current-view)` to Lisp; their active child
does. This is the focus-resolution shift PANES.md called out under
"Tabline as a container view."

Add `(current-tabline)` to pane-primitives: returns the tabline-view
in the focused pane *if* the focused pane holds one, else `nil`.

### Auto-add-tab vs swap-in-leaf

The two open-file paths are `openFileByPath` (used by find-file,
session restore, doc-link clicks) and `openFileInteractive` (used
by the OS file dialog). Both end up appending the new View to
`views[]` and calling `switchToView(view)`.

Rewrite the switch path:

- `paneHost.currentPane()?.view.kind === 'tabline'` → call
  `addTab(currentTabline, newView)` + `activateTab(currentTabline,
  newView)`.
- Otherwise (plain leaf): set `currentPane.view = newView` and
  re-mount through the kind registry. (Same as today's
  `switchToViewIndex` minus the index bookkeeping — the global
  `currentViewIndex` is becoming obsolete in 3b; see "Things to
  unwind" below.)

The Q3 (auto-duplicate) path follows the same rule because it
ultimately calls the same switch logic with a freshly-minted
duplicate view.

### Tab strip rendering — CSS shape

Inside the pane div (which is absolute-positioned by
`relayoutPanes`), the tabline kind's mount inserts a single
flex container:

```html
<div class="tabline-pane" data-edge="top">
  <div class="tabline-strip">…tabs…</div>
  <div class="tabline-content">…active child mount target…</div>
</div>
```

Flex direction depends on `edge`:

```css
.tabline-pane { display: flex; width: 100%; height: 100%; }
.tabline-pane[data-edge="top"]    { flex-direction: column; }
.tabline-pane[data-edge="bottom"] { flex-direction: column-reverse; }
.tabline-pane[data-edge="left"]   { flex-direction: row; }
.tabline-pane[data-edge="right"]  { flex-direction: row-reverse; }
.tabline-pane .tabline-strip  { flex: 0 0 auto; }
.tabline-pane .tabline-content {
  flex: 1 1 auto; min-height: 0; min-width: 0;
  position: relative;       /* anchor for absolute children */
}
```

For top/bottom edges the strip is the existing horizontal
`createTabline` rendering. For left/right edges, the strip is
a vertical stack — tabs become wider than tall, with the label
written left-to-right (no rotated text); for 3b just stack
vertically with normal text. The vertical case is the less-loved
edge; aim for usable, not fancy.

### File-by-file

#### `packages/view/src/view.js`

- Update the JSDoc to acknowledge `kind: 'tabline'` as a valid
  kind with the `tabs` / `active` / `edge` fields on the result.
- No code change beyond comments; `createView`'s `extras`
  spread already handles it.
- Update `view.test.js` with a tabline-view shape test.

#### `packages/view/src/index.js`

- Tiny helper `isTablineView(value)` exported alongside `isView`.
- Tiny helper `tablineActiveChild(view)` — returns
  `view.tabs[view.active]` or `null`. Used by the focus-resolution
  shift.

#### `apps/desktop/src/tabline.js` (refactor)

- Change the constructor's options shape:
  - `getTabs: () => View[]` (replaces `getViews`).
  - `getActiveIndex: () => number` (replaces `getCurrentIndex`).
  - `onSelect(index)`, `onClose(index)`, `onReorder(from, to)` —
    unchanged signature, but the callers update the tabline-view's
    `active` / `tabs` rather than the global view list.
- Drop the `<div class="tabline">` outer wrapper assumption —
  the caller passes the `tabline-strip` element directly.
- New: an `edge` option ('top' | 'right' | 'bottom' | 'left').
  Drives whether the strip's internal layout is row or column.
  Default 'top'.

#### `apps/desktop/styles.css`

- Move the existing `.tabline` rules (and the `.tabline-host`
  rule at ~line 128) under `.tabline-pane` / `.tabline-strip` /
  `.tabline-content`. The visual look of a top-strip is
  identical; only the parent changes.
- Add the four `data-edge` direction rules above.
- Remove `.tabline-host` (its host element is gone).

#### `apps/desktop/index.html`

- Delete `<div id="tabline-host" class="tabline-host"></div>` (line 67).

#### `apps/desktop/src/app.js`

This file is the bulk of the change.

- **Replace the phase-2 tabline stub** in the kind registry
  (~line 3124):
  ```js
  kindRegistry.register('tabline', {
    hasBuffer: false,
    viewName: (view) => view.tabs[view.active]?.name ?? '*tabs*',
    mount: (view, paneEl) => {
      // Build the tabline-pane container if not present.
      // Insert the strip via createTabline against view.tabs / view.active.
      // Mount view.tabs[view.active] into the content div by recursing
      // into kindRegistry.mount(activeChild, contentEl).
    },
    dispose: (view, paneEl) => {
      // Recursively dispose the active child via kindRegistry.dispose.
      // Remove the tabline-pane container.
    },
  });
  ```
  Per-pane state (the strip's `refresh` callback, the active
  child's mount target, etc.) lives in a `WeakMap<View, PerPaneState>`
  or directly on `paneEl.dataset` — pick the cleaner one. The
  per-pane state tracks: the strip's `refresh()`, the content
  div, the currently-mounted child kind (so dispose can route
  correctly).

- **Auto-add-tab vs swap-leaf** in `switchToViewIndex` /
  `switchToView`:
  - Detect whether `currentPane().view` is a tabline-view.
  - Tabline path: `view.tabs.push(newView); view.active = view.tabs.length - 1;` (or insert next to the current active for "open beside current" UX — Jason can tune); call the strip's `refresh()` and re-mount the content.
  - Leaf path: `leaf.view = newView`; call kindRegistry.dispose(oldView, paneEl); kindRegistry.mount(newView, paneEl).

- **Remove the singleton tabline at the top.** Delete the
  `createTabline(document.getElementById('tabline-host'), ...)`
  block (~line 4184). Replace the `tabline.refresh()` call sites
  with a `refreshPaneTabStrips()` that walks every pane and calls
  the per-pane tabline-view's strip `refresh()` if any.

- **`C-x ←` / `C-x →` cycle pane's tabs (Q5).**
  Today's `nextView`/`previousView` host methods cycle the global
  `views[]`. Rewrite to operate on the focused pane:
  - Tabline-view: `view.active = (view.active ± 1) mod tabs.length`;
    refresh + remount content.
  - Plain leaf: no-op (only one view in the pane; cycling has no
    meaning). Or beep / show "no other tabs."

- **`C-x k` kills the focused tab (Q6).**
  `killView` rewrites:
  - Tabline-view: remove `view.tabs[view.active]`, adjust active to
    the previous tab. If `view.tabs.length === 0` afterwards, kill
    the tabline-view itself and auto-collapse the pane (calling
    `deletePane(currentPane)`).
  - Plain leaf: remove the leaf's view and auto-collapse the pane
    (same as `delete-pane!`). Root-pane case: substitute `*scratch*`.

- **`C-x b` picker filter (Q4).** The viewHost's `viewList()`
  surface keeps returning every leaf-kind view (tabline-views
  aren't in the global list anyway). The filter applied by the
  switch-view UI: drop views currently visible in some *other*
  pane. Helper: `viewsVisibleInOtherPanes(currentPane)` — walks
  the pane tree, collects every active child of every other pane.

- **Buffer-menu (`C-x C-b`) gains a pane column (Q12).**
  `listViewRecords` adds a `:pane` field per view: the id of the
  pane where the view is visible (or `nil` if it's in no pane, i.e.,
  buried under inactive tabs somewhere or only in the view list).

- **`viewHost.currentView` peels tablines.** When the current
  pane's view is a tabline-view, return the active child.

- **Add `paneHost.currentTabline()`** — returns the tabline-view
  in the focused pane, or null.

- **Add host methods** `promoteToTabline(pane)`,
  `demoteTabline(tlv)`, `addTab(tlv, view, index)`,
  `removeTab(tlv, index)`, `activateTab(tlv, index)`,
  `setTablineEdge(tlv, edge)`.

#### `packages/stdlib/src/pane-primitives.js`

Add the new primitives that go through `paneHost`:

- `(current-tabline)` → returns the tabline-view handle in the
  focused pane, or nil.
- `(promote-to-tabline! [pane])` → returns the new tabline-view
  handle.
- `(demote-tabline! [tlv])` → returns the surviving leaf view
  (the sole remaining tab's view).
- `(make-tabline-view tabs edge)` → returns a fresh tabline-view
  handle, not yet attached to any pane.
- `(add-tab! tlv view [index])` → returns the tabline-view.
- `(remove-tab! tlv index)` → returns the tabline-view.
- `(activate-tab! tlv index)` → returns the tabline-view.
- `(tabline-edge tlv)` → returns the edge as a keyword.
- `(set-tabline-edge! tlv edge)` → returns the tabline-view.

#### `packages/stdlib/lisp/tabline.lisp` (new)

Defcommands and (re-)bind:

- `(defcommand promote-to-tabline ...)` etc., each calling the
  matching primitive on `(current-pane)` / `(current-tabline)`.
- No new key bindings beyond what the existing C-x prefix already
  binds (the keymap doesn't need to know about tablines — the
  existing `kill-view`, `next-view`, `previous-view`,
  `switch-view` commands change their underlying behaviour, not
  their bindings).

Add `'tabline.lisp'` to `STDLIB_FILES` in
`packages/stdlib/src/index.js`.

#### `apps/desktop/src/session.js`

- **Schema v2 reader/writer.** New top-level shape:
  ```js
  {
    "version": 2,
    "rootPane": <pane-blob>,
    "currentPaneId": <string | null>
  }
  ```
  Pane-blob and view-blob shapes per the design doc.

- **v1 → v2 migration on load.** If `parsed.version` is undefined
  *and* `parsed.buffers` is present, treat it as v1 and wrap:
  ```js
  {
    version: 2,
    rootPane: {
      kind: 'leaf',
      id: 'pane-leaf-restored',
      view: {
        kind: 'tabline',
        edge: 'top',
        active: indexOfCurrentPath,
        tabs: parsed.buffers.map(b => ({ kind: 'text', path: b.path, point: b.point, mark: b.mark })),
      },
    },
    currentPaneId: 'pane-leaf-restored',
  }
  ```

- **Restore loop refactor.** Today's loop iterates the flat list
  of buffer entries and opens each by path. After v2, walk the
  pane tree: for each leaf-pane-blob (a) build the View handles
  (each leaf's view-blob → either a text view by opening the file,
  or a tabline-view recursively built from its tabs), (b) assemble
  the pane tree, (c) install the tree as `rootPane`, (d) set
  `currentPaneId` from the saved value.

- **Save loop.** Walk `rootPane`; serialize each pane-blob; each
  view-blob via kind dispatch (text views serialize as today;
  tabline-views serialize their `tabs` recursively; non-text views
  return null and are skipped — their pane gets `*scratch*` on
  restore, per "Non-text views stay ephemeral").

#### `packages/stdlib/test/`

- Pane-primitives tests grow with the new tabline primitives.
- `tabline.lisp` tests for the defcommands' wiring.

#### `apps/desktop/scripts/smoke.js`

New arms:

- Startup with a session of 3 files → root pane is a tabline-view
  with 3 tabs; the persisted active tab is active.
- Open a 4th file → new tab added, activated.
- `C-x ←` cycles to previous tab; `C-x →` returns to it.
- `C-x k` kills the active tab; previous tab becomes active.
- Kill until 1 tab left, then kill it → root pane becomes
  `*scratch*` (the "root pane with nothing to show" fallback).
- Split horizontally (`C-x 3`) → left pane keeps the tabline-view,
  right pane gets a plain leaf with a duplicate of the previously
  active tab's view.
- Open a file in the right pane (plain leaf) → leaf swaps to the
  new view; the old view is dropped from the pane (still in the
  global view list — `C-x b` finds it).

### Things NOT to do this phase

- **No cross-pane drag-and-drop of tabs.** (Q11 deferred.)
- **No pinned tabs / unsaved-changes indicators** beyond what the
  current `tabline-tab` rendering shows.
- **Don't fold the OUTER UI** (REPL pane, modeline, minibuffer,
  markdown-preview splitter) into the pane tree. Same boundary
  as phase 3a.
- **Don't change the modeline contents.** It already reads
  `(current-view).name` — with the focus-resolution shift, it
  Just Works.
- **Don't touch tabs' visual design** beyond what's needed for
  the four-edge support. Same close-button, same drag-reorder
  affordance, same `is-current` accent.

### Pitfalls

- **The recursive kind-registry mount.** A tabline-view's mount
  calls `kindRegistry.mount(activeChild, contentEl)`. Make sure
  dispose paths don't double-dispose:
  - When the pane itself goes away (delete-pane), dispose runs
    on the *pane's* view (the tabline-view). The tabline's
    dispose recurses into the active child's dispose. Don't
    dispose the active child a second time.
  - When the active tab changes, dispose runs on the *old* active
    child only; the tabline-view itself stays alive.

- **Nested tabline-views (Q10).** Allowed (Jason's call). The
  recursion handles them naturally — a tab's view can itself be a
  tabline-view. Make sure dispose doesn't infinite-loop and the
  focus-resolution peeks through *one* layer per `(current-view)`
  call, not multiple. (Or peels all the way through — pick one
  and document it. Lean: peel all the way through, since user
  intent for nested tabs is "the deepest active child is what I'm
  editing.")

- **`#tabline-host` selectors.** Removing the chrome element
  breaks any CSS rule or DOM query that targeted it. Grep for
  `tabline-host` across `styles.css`, `index.html`, and `src/`.

- **`currentViewIndex` is obsolete.** Today's app.js threads a
  global "currently focused view's index in `views[]`" through
  many places. With per-pane state being authoritative, the
  global index loses meaning — except for the legacy session
  schema's `currentPath`. Audit every read of `currentViewIndex`
  and either delete or replace with a pane-rooted lookup.

- **`onViewsChanged`** today fires `tabline.refresh()` on every
  list change. After 3b: the new equivalent is to refresh each
  pane's tab strip (if any). Build a `refreshAllPaneStrips()` and
  wire it in.

- **The `viewList()` host method.** Today returns every view in
  `views[]`. After 3b: keep returning the global leaf-kind list
  (so `(view-list)` semantics don't break). Tabline-views aren't
  in it.

- **Restore order.** The v2 restore loop must (a) materialise
  view handles (some need IPC for file content), (b) thread them
  into tabline-view tabs, (c) install the pane tree, (d) mount.
  If (c) runs before (a)/(b) completes, the tabline-view's
  `tabs` are partial / wrong. Await all openByPath promises
  before building the tree.

- **`session.flush()` on pagehide.** The schema-v2 serialiser
  walks the pane tree — verify it's synchronous (it should be;
  the serialisation is pure data).

### Branch + commit shape

- Branch: `agent-tabline-view` (from main).
- Suggested commit cadence (each green on `pnpm test` + smoke):

  1. `feat(view): tabline kind shape + isTablineView helper` —
     `packages/view/`. The view shape grows tabs/active/edge fields
     when kind is 'tabline'. Helpers `isTablineView`,
     `tablineActiveChild`. Pure data; no rendering yet.

  2. `feat(tabline): real tabline kind in the registry + per-pane
     strip` — `apps/desktop/src/app.js` kind registry stub
     replaced with the recursive mount/dispose; `tabline.js`
     refactored to per-tabline-view options; CSS for the four-edge
     flexbox layout; nested-tabline support per Q10. Existing
     `#tabline-host` chrome still in place for this commit (we
     remove it in commit 3); a tabline-view in a pane renders
     correctly when constructed manually via the Lisp REPL.

  3. `refactor(desktop): drop the global tabline chrome` —
     remove `<div id="tabline-host">` from `index.html`, the
     `createTabline(...)` call site in `app.js`, the `.tabline-host`
     CSS rule. Wire the startup path so the editor boots with a
     root pane holding a tabline-view containing the restored
     views (plus a fallback for "no session yet" = root leaf with
     a tabline-view containing `*scratch*` only, so the strip
     still appears).

  4. `feat(lisp): tabline-view primitives + commands` —
     `pane-primitives.js` grows the new primitives;
     `tabline.lisp` lands with defcommand wrappers; STDLIB_FILES
     updated. `(current-tabline)` plumbed through paneHost.

  5. `refactor(desktop): open-file / kill-view / cycle scopes per
     Q2 / Q5 / Q6` — the switch-view path branches on
     tabline-vs-leaf; the cycle and kill paths route through the
     focused pane; `C-x b` picker filter applied. The
     `(current-view)` focus-resolution peels through tabline-views.

  6. `feat(session): schema v2 — pane tree + tabline membership` —
     v2 reader/writer + v1→v2 migration. Restore loop refactored
     to build the pane tree.

  7. `feat(smoke): tabline arms` — new arms; existing 18 stay
     green.

- Merge as `--no-ff` with sub-commit history preserved.

### Test gate

Before each commit:

- `pnpm test` — all packages green. New tests in
  `packages/view/test/`, `packages/stdlib/test/`,
  `apps/desktop/test/`.
- `pnpm --filter @editor/desktop smoke` — PASS, all arms.

Before merge: live test, with focus on:

- Startup: tabs visible at the top of the editor, identical to
  today's UX.
- Open file: new tab added; old tabs survive.
- Split: right pane is a plain leaf (no tab strip).
- Open file in the right pane: leaf swaps; no new tab strip on
  the right.
- `(promote-to-tabline!)` on the right pane via REPL: strip
  appears with one tab; subsequent open-file adds a tab.
- `(set-tabline-edge! (current-tabline) 'left)` via REPL: tabs
  re-render on the left edge of the pane.

### When to stop and write to `architect-notes.md`

- The recursive mount/dispose for nested tabline-views (Q10)
  has subtle bugs you can't isolate after three tries.
- The v1→v2 session migration loses data on a real session.json
  in the user's profile directory.
- The auto-add-tab vs swap-leaf rule (Q2) gives a confusing UX
  edge case you can't think your way out of (e.g., an open-file
  triggered from a deeply nested call site).
- A test failure suggests the brief itself is wrong, not the
  code.

### Effort estimate

Roughly half a focused day — substantially smaller than 3a (no
per-view-point refactor, no per-pane editor-view instancing).
Commits 2 and 5 are the largest; the others are mechanical or
small. The session migration (commit 6) is fiddly but isolated.
