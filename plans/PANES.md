# Panes, views, windows — guide notes

Pre-design notes for an editor reshape that does three coupled things:

1. Make **view**, not buffer, the thing a pane holds.
2. Replace the current single-window pane code with a real **pane tree**,
   so a window can be split into arbitrary tiled regions.
3. Allow **multiple OS windows**, each hosting its own pane tree over a
   shared editor model.

**Status:** Jason settled all the open questions on 2026-05-26 (see
the section at the end). The body of the document is updated inline to
reflect those decisions; Jason's ALL CAPS answers are preserved as the
historical record of how each call was made. A detailed implementation
plan can be drafted from here.

## Why now

The current model carries an Emacs accident: every on-screen thing must
be a buffer. We escape it partially (ten view kinds now), but the
buffer is still the addressable handle and the pane discriminator
(`buffer.kind` is what `switchToBuffer` dispatches on). For text
editing that fit is correct — markers, overlays, edit history are
real machinery on real text. For jukebox / image / directory-tree /
audio / video / shell, the buffer is vestigial scaffolding that
exists so the rest of the system has something to switch to.

The fix is small conceptually: **view becomes the addressable
top-level thing; buffer becomes the data substrate of views that
happen to edit text.** That decouples "what's on screen here" from
"what is the text data model," which is what we wanted all along.

The pane and multi-window pieces are mechanical once the view/buffer
relationship is settled. They're worth bundling because:

- The `agent-session` branch (queued) ships a tabline + session
  restore that embeds assumptions about "tabs point to buffers."
  Better to settle the view question before merging it.
- The `agent-reactive-notebook` branch is a natural canary for
  view-without-buffer — the reactive notebook is its own state, not a
  text buffer.
- HANDOVER.md flagged `plans/PANES.md` as the next architectural piece
  worth doing first.

This document supersedes ARCHITECTURE.md's "It's not multi-window"
non-goal. The non-goal was right for week one; we're past week one.

## The reshape, in one picture

```
Window (OS frame; single HTML page)
  └── Pane tree (recursive splits; leaves hold one view each)
        ├── Pane (split node: horizontal | vertical | leaf)
        └── ...
              └── View (kind, name, keymap, modeline payload, focus state)
                    └── (optional) Buffer  ← L2 data model, when the view edits text
```

Three new vocabulary items at the renderer/Lisp boundary:

- **window** — an OS-level frame. One Electron `BrowserWindow`. One
  HTML page.
- **pane** — a rectangular region in a window. A pane is either a
  split node (two child panes + an orientation) or a leaf (one view).
- **view** — what a pane shows. Has a kind, a name, a keymap, modeline
  data. A text-editing view contains a buffer; other views contain
  their own state.

The buffer keeps its current role. What it loses is universality.

## The DOM shape

Jason's instinct in the question that prompted this doc:

> A window is a single HTML page, whose top-level elements are all
> `<div class="pane">` elements.

That's exactly the right shape. Concretely:

```html
<body>
  <div class="pane" data-pane-id="p1" style="left:0;top:0;width:50%;height:100%">…view…</div>
  <div class="pane" data-pane-id="p2" style="left:50%;top:0;width:50%;height:50%">…view…</div>
  <div class="pane" data-pane-id="p3" style="left:50%;top:50%;width:50%;height:50%">…view…</div>
  <!-- splitter handles, minibuffer, modeline overlay live here too -->
</body>
```

The pane *tree* is a JavaScript data structure; the DOM is just the
flat list of leaves, each absolute-positioned from the tree's layout
computation. The tree is the source of truth; the DOM mirrors only
its leaves.

### Why flat leaves rather than nested split-divs

Two options were on the table:

1. **Flat leaves + virtual tree.** Each pane is a top-level div
   absolute-positioned by JS layout.
2. **Mirrored tree.** Each split node is a flex/grid container div;
   leaves are inside.

Flat-leaves wins on:

- **Mental model.** Pane is the only first-class DOM thing. The
  layout algorithm runs in JS where the tree already lives.
- **Focus and event bubbling.** No intermediate containers to
  interpose. Keyboard pane navigation talks to leaves directly.
- **Per-pane chrome.** Modeline, headline, status badges all live
  inside the pane div with the view, sized by the pane's rect.
- **Animation.** Animating a resize is a single coordinated style
  mutation per leaf, not a cascade through flex containers.
- **Exact pixel control.** We size each leaf to integer pixels, which
  matters for terminal grids and image views.

The cost — writing our own layout — is trivial. Splitting a rect into
two rects is six lines of arithmetic per node; the tree walk is six
more. We're not reinventing CSS grid; we're computing rects in a tree
and writing them out.

### Shape: rectangular, full stop

The pane primitive is a rectangle. Non-rectangular tilings — clip-path
polygons, hex grids, L-shapes — are explicitly out of scope as a layout
primitive. Reasons:

- **The content is rectangular.** Text grid, terminal grid, image,
  video, directory list. Forcing them into non-rect regions wastes
  pixels at the corners.
- **The math is solved.** A binary tree of horizontal/vertical splits
  resizes in O(log n) per drag with predictable behaviour. Arbitrary
  shapes turn that into a geometry problem.
- **Focus adjacency is well-defined.** "Move focus left" maps to a
  spatial query in a rect tiling; in arbitrary shapes it becomes
  arbitrary.
- **Every editor that works does this.** Emacs windows, Vim splits,
  VS Code editor groups, tmux, every tiling WM.

CSS `clip-path` remains available for **chrome** — rounded corners, a
notch where a tab sits, a tab-overlap decoration. It's a paint-time
detail, not a layout primitive. The pane's bounding rect stays
rectangular even if its border art doesn't.

The Windows precedent Jason named — non-rect windows nobody uses —
applies here for the same reason. List it as a non-goal and move on.

## Tabline as a container view

A tabline is **not** window chrome. It's a *kind of view* that can sit
in any pane and contain other views, with the tab strip configurable on
top, right, bottom, or left of the pane it occupies. The view
abstraction stays uniform — panes still hold exactly one view — and
the tabline-view is just a container view that happens to wrap N
children and render one at a time.

```
tabline view = {
  tabs:   View[],
  active: number,
  edge:   'top' | 'right' | 'bottom' | 'left'
}
```

This lets users build project-style layouts like:

```
window:
  split horizontal (ratio 0.25)
    left:  leaf  → directory-tree
    right: split vertical (ratio 0.6)
      top:    leaf → tabline { [editor-a, editor-b], active:0, edge:top }
      bottom: leaf → tabline { [shell-1, shell-2],   active:0, edge:top }
```

Three things fall out of this design:

- The directory-tree pane doesn't need tabs — it's a plain leaf with
  one view. No "1-tab tab-group" weirdness; not every pane is forced
  to render a tab strip.
- Tabs can be on any edge per group, so a vertical tab strip on the
  right of a wide pane is just as natural as a horizontal tab strip on
  top. Choice of edge is per-tabline-view, not a global setting.
- The pane *tree* still has only `split` and `leaf` kinds. The
  recursion that makes tab-groups composable lives inside the view
  abstraction, where it's cordoned off.

**Focus resolution.** When focus is in a tabline-view, the focus
indicator (see "Window as OS frame") shades the outer pane border, but
`(current-view)` returns the **active child**, not the tabline
wrapper, and keymap dispatch goes into the active child. Otherwise
users couldn't run text commands inside an editor tab.

**Empty tablines.** Closing the last tab in a tabline-view makes the
view empty, and the pane containing it collapses into its sibling —
same rule as Emacs `C-x 0`.

**Recursion.** Nesting a tabline-view inside another tabline-view is
technically allowed (the type system permits it; commands work). It's
discouraged — there's no `make-nested-tablines!` command — but
nothing forbids a user who wants it from building it via Lisp.

The `agent-session` branch's "tabline at the top of the window"
becomes "root pane = leaf with a tabline-view, edge:top." That
branch's data model needs reconciling before it merges, but the
visual result lines up cleanly.

## View as primary

### What changes

- The discriminator moves from `buffer.kind` to `view.kind`.
- A view has its own name (the modeline label), keymap, modeline
  template, mode (or "view-mode") slot, and life-cycle hooks.
- For text-editing views, the view *contains* a buffer. The
  buffer keeps everything it currently has: markers, overlays, text
  properties, edit history, point, mark, modes.
- For non-text views, no buffer exists. The view holds its own state
  (jukebox: cwd + track list; image: path + zoom; shell: session id;
  reactive notebook: cell list + reactive graph; tabline: child views
  + active index + edge).

### What stays

- The L2 buffer API. Markers, overlays, text properties, edit history,
  point/mark/modes are all unchanged. We're not redesigning L2; we're
  giving views the right to exist without one.
- All existing text-editing primitives. They operate on the current
  view's buffer, just as they do today on the "current buffer." The
  call site changes from `(current-buffer)` → `(view-buffer
  (current-view))`, with a compatibility shim — see below.
- File-on-disk semantics for text views. Open / save / dirty-state are
  view-level operations that happen to delegate to the buffer.

### The Lisp surface

The migration is the largest concrete cost of this reshape. The
stdlib leans on `(current-buffer)`, `(buffer-name)`,
`(switch-to-buffer)`, `(buffer-list)`, `(other-buffer)` etc.

Two migration shapes are plausible:

1. **Flag day.** Rename everything in one pass. `current-buffer`
   becomes `current-view`, `buffer-name` becomes `view-name`,
   `(view-buffer view)` retrieves the underlying buffer when present.
   `(current-buffer)` either disappears or stays as a thin alias that
   errors on non-text views. Pre-1.0; no external users.
2. **Dual surface.** Both `(current-buffer)` and `(current-view)` live.
   `(current-buffer)` returns the current view's buffer or `nil` for
   buffer-less views. Stdlib slowly migrates.

Flag day is simpler and matches the project's stage. The actual cost
is grepping the stdlib and rewriting; the buffer ops themselves are
fine.

A reasonable concrete naming layer:

```
;; Views — the new primary
(current-view)            ; the focused view
(view-list)               ; all open views
(view-name view)
(view-kind view)
(view-buffer view)        ; the underlying buffer, or nil
(view-mode view)
(switch-to-view name)
(kill-view! view)
(other-view ...)          ; for the next-view operations

;; Buffers — unchanged, addressed through views or the buffer pool
(buffer-of view)          ; alias for (view-buffer view)
(point) (mark) (insert ...) (delete ...)  ; all operate on the
                                          ; current view's buffer
```

The "current view's buffer" is the default operand for buffer ops.
Calling `(insert ...)` from a shell view raises a condition — no
buffer to insert into.

## Window as OS frame

### What changes from today

Today's L4 implicitly assumes one renderer process, one window. The
shift:

- Each OS window is an Electron `BrowserWindow` with its own renderer.
- Each renderer hosts one pane tree and projects views from the
  shared model.
- Window-local state: pane tree, focused pane, window geometry.
- Globally shared state: view list, buffer pool, lisp VM, mode
  definitions, themes, keymaps.

This puts the architecture squarely in the same shape as VS Code's
multi-window: the main process owns the model; renderers project it.

### Where the lisp VM lives

The interesting architectural call. Today the VM runs in the renderer.
With N windows we have three options:

**(a) One VM in the main process; renderers are dumb.**
Renderers ferry every command to the main process; main process
evaluates and broadcasts state diffs to relevant renderers. Cleanest
model; matches the L0–L4 layering. Cost: refactoring the VM out of
renderer-land, plus a real IPC protocol for every primitive.

**(b) One privileged renderer + shadow renderers.**
The first window hosts the VM. Additional windows are "view-only"
renderers that subscribe through the main process to the privileged
one. Cheaper to build; but the privileged renderer dying takes the
others down with it, and the asymmetry leaks into user-visible
behaviour (closing the "first" window does something different from
closing the "second").

**(c) Per-renderer VMs with synchronised state.**
Each window has its own VM. State changes propagate via the main
process. Worst of all worlds: complexity of (a) plus consistency
hazards. Listed for completeness; not recommended.

The honest recommendation is (a). It's also the most work, and it's
the kind of work that pays off compounding-ly for every later feature
(remote VM, headless evaluation, multi-process safety). Worth doing
once and well.

### Focus indication

Each window has at most one focused pane; each focused pane has at
most one focused view (the active child, in a tabline-view; the only
view, in a leaf). The focused pane shows its focus with a **subtle
border shading** — distinct enough to spot at a glance, quiet enough
not to compete with content.

**Click-anywhere-to-focus.** Clicking any control inside a pane
focuses that pane: clicking a jukebox transport gives the jukebox
focus; clicking inside a code editor's text area focuses the editor.
The keymap dispatches to whatever the focused view's mode binds.

Across windows: the OS owns window-level focus, and jmacs respects
it — the focused pane is "the focused pane *of the focused window*."
`(current-pane)` and `(current-view)` resolve through that chain.

### Window-local state — what each window owns

- A pane tree (the splits).
- A focus pointer (which pane is active).
- A minibuffer + its echo area.
- A REPL? — see open question below.
- A tabline (the `agent-session` branch) — per window seems right.
- Window geometry (size + position; persisted on close).

### Globally shared state

- The view list. A view can be shown in multiple windows simultaneously;
  the modeline and any view-level state are shared. (Per-pane state
  like scroll position and point may need to be pane-local; see
  Emacs's per-window-point semantics.)
- The buffer pool. Same buffer can underlie multiple text-views.
- The Lisp VM and its loaded modules.
- Themes, faces, keymaps, mode definitions.

## Persistence

Today: `agent-session` ships per-buffer session restore. With the
reshape:

- **Per window**: pane tree topology + per-pane view-id + focus pointer
  + window geometry.
- **Per view**: kind, name, plus a kind-specific blob (text view = file
  path, point, mark, scroll; jukebox = cwd; image = path + zoom;
  directory-tree = root path; shell = nothing or just cwd; notebook =
  source file path).
- **Globally**: open file list, modified buffers (autosave?).

Each view kind needs a `(serialize-view view)` / `(restore-view blob)`
pair. The schema is the union of "things needed to recreate this
view" — usually small.

The `agent-session` branch's data model will need a once-over here.
Conservative move: settle the new view model first, then rewrite the
serialization layer on top of it.

## Sequencing

Best read as a stack of mergeable phases. Each phase ends with the app
running.

1. **View/buffer split.** Rename, add the view primary, migrate the
   stdlib. No UI change. Single window, single pane (the whole window).
   This is the heavy conceptual lift; everything else is mechanical
   after it lands.

2. **Pane tree, single pane.** Replace the current "buffer fills the
   window" rendering with a pane tree that happens to have one leaf.
   New DOM model (flat leaves), new layout code, new focus model.
   Split commands not exposed yet. Tests prove the one-pane case
   still works exactly like today.

3. **Splits.** Expose `split-horizontal`, `split-vertical`,
   `delete-pane`, `delete-other-panes`, `other-pane`, focus-direction,
   `balance-panes`. Bind `C-x 2 / 3 / 0 / 1 / o` etc. Settle
   per-pane vs per-buffer point/mark/scroll.

4. **Multi-window.** Spawn additional `BrowserWindow`s; settle the VM
   hosting question (recommend (a)); plumb the IPC. New commands:
   `make-window`, `delete-window`, `other-window`, focus-window.

Each phase is testable and shippable. Each unlocks a real capability.
The intermediate states are all useful.

## Open questions

All settled 2026-05-26 except Q8 and Q13, which are deferred to the
phase where they bite. Jason's original ALL CAPS answers are kept as
the historical record; **Resolved:** lines summarise the call.

1. **Pane tree topology.** Binary (one split = two children) or n-ary
   (one split = N children with weights)? Binary is simpler and what
   Emacs/Vim use; n-ary saves a level of nesting in the common
   horizontal-row case. Lean: binary, since drag-resize gestures are
   inherently binary anyway.

   LET'S GO WITH BINARY

   **Resolved:** binary.

2. **Point and mark — per-pane or per-buffer?**
   Two views of the same text buffer can have their own cursors
   (Emacs's per-window-point), or share a single cursor that jumps
   when focus switches (the simpler model). Emacs gets this right at
   the cost of complexity.

   GO WITH COMPLEXITY - THE PER-WINDOW-POINT. IT'S THE RIGHT MODEL.

   **Resolved:** per-window-point — a view in a window has its own
   point/mark/scroll for that window; the same view in a different
   window has its own.

3. **Pane sizing under resize.** Each split node holds a ratio
   (between 0 and 1) for its first child; window resize scales
   everything proportionally; drag-resize updates one node's ratio.
   Alternative: pixel-fixed sizes that the user has to maintain
   manually. Ratio is cheaper for the user.

   I DON'T UNDERSTAND WHAT IS AT STAKE HERE.

   **Resolved (after rephrase):** proportional / ratio-based. Each
   split node stores a ratio between 0 and 1 for its first child;
   resizing the OS window scales both halves proportionally;
   drag-resizing a splitter updates the one node's ratio.

4. **Migration strategy for the Lisp surface.** Flag day vs dual
   surface (see "Lisp surface" above). Lean: flag day.

   FLAG DAY, SINCE NO ONE IS USING THIS WE DON'T NEED TO WORRY
   ABOUT MIGRATION

   **Resolved:** flag day. Rename in one pass; no dual surface, no
   compatibility aliases. `(current-view)` is primary;
   `(current-buffer)` either disappears entirely or errors on
   non-text views (detailed plan to settle).

5. **Multi-window VM hosting.** Options (a), (b), (c) above.
   Lean: (a), the most work, but architecturally clean.

   LET'S GO WITH (A)

   **Resolved:** option (a). Lisp VM lives in the main process;
   renderers ferry commands through IPC and receive state diffs.
   Most work, but architecturally clean and matches L0–L4.

6. **Per-window vs global REPL?** Emacs's `*Lisp REPL*` is a global
   buffer that any window can show. The lisp VM is global; the REPL
   *view* should follow suit — one REPL view in the view list, shown
   in whatever pane the user chose. (This argues for "view list is
   global" by itself.)

   GLOBAL. THE APP STATE IS SHARED ACROSS ALL WINDOWS, SO THIS IS THE
   ONLY OPTION THAT MAKES SENSE. WINDOWS ARE FOR ORGANISATION AND
   EASE OF USE, NOT TO CREATE FRAGMENTED MEMORY-SEPARATED WORLDS.

   **Resolved:** global. One REPL view in the view list, displayable
   in whatever pane the user chooses. Guiding principle from Jason:
   *"windows are for organisation and ease of use, not to create
   fragmented memory-separated worlds."* That principle applies more
   broadly — view list, buffer pool, lisp VM, mode definitions all
   live globally; windows are just viewports onto the shared model.

7. **Minibuffer placement.** Emacs has a single global minibuffer
   per frame; each window has its own. We follow per-window:
   each window has its own minibuffer, since commands are window-
   scoped (which pane is the focused command applied to?).

   WE'LL NEED A SUBTLE BORDER SHADING TO INDICATE WHICH PANE IN A WINDOW
   HAS FOCUS. FOR EXAMPLE, CLICKING ON A JUKEBOX CONTROL GIVES FOCUS
   TO THE JUKEBOX, AND CLICKING IN A CODE EDITOR GIVES FOCUS TO THE EDITOR.

   **Resolved (minibuffer):** per-window. Each window has its own
   minibuffer at the bottom; commands run in window scope.
   **Bonus content captured separately:** the focus-indicator
   requirement is folded into the new "Focus indication" subsection
   above (subtle border shading + click-anywhere-to-focus semantics).

8. **Modeline composition.** Per-view-kind template? A global format
   that interpolates view-level data? Lean: each view kind declares
   its own modeline payload (a Lisp value); a global format renders
   them uniformly with per-kind extensions.

   I DON'T UNDERSTAND THIS QUESTION.

   **Deferred:** revisit when modeline rework lands. The question is
   whether each view kind declares its own modeline template (with a
   global renderer interpolating it), or whether the modeline format
   is a single global Lisp form that pulls per-view data. Not
   load-bearing for the view/buffer split or pane work; settle at
   modeline time.

9. **The same view in two panes.** Allowed? If yes, the per-pane vs
   per-buffer point question above tightens. If no, simpler model
   but loses the legitimately useful "two views of the same file at
   different positions."

   NOT ALLOWED. SINCE A WINDOW IS ALWAYS TOTALLY VISIBLE, THERE'S
   NO WORLD IN WHICH THIS WOULD BE USEFUL.

   **Resolved:** the same *view* in two panes is not allowed.
   *Probe answered:* two *views of the same buffer* are allowed.
   `open-file` always creates a fresh view; the same buffer can
   underlie N text-views, each with its own per-window
   point/mark/scroll. The side-by-side-same-file workflow works via
   duplicate views over a shared buffer.

10. **The same view in two windows.** Allowed by symmetry with (9).
    Likely yes; required by the global view-list claim.

    THIS IS ALLOWED. I CAN IMAGINE USE CASES WHERE THIS IS HELPFUL

    **Resolved:** allowed. A view can appear in panes in two different
    windows simultaneously. Per-window-point (Q2) means each window
    keeps its own point/mark/scroll for that view.

11. **Tabline scope.** The `agent-session` branch ships a tabline.
    Per pane, per window, or one global tabline at the top of the
    "primary" window? Lean: per window, listing the views currently
    shown in any pane of that window, plus a global "recent views"
    bucket. Needs the branch's design checked.

    I DON'T UNDERSTAND THIS QUESTION.

    **Resolved (reframed):** the question dissolved. The tabline is
    not window-level chrome at all — it's a view kind (see "Tabline
    as a container view" above). A pane that wants tabs holds a
    tabline-view; the tabline-view contains N child views and renders
    a tab strip on a configurable edge. There's no per-window or
    per-pane "tabline" concept to scope; users place tabline-views
    where they want them.

12. **Window chrome / title bar.** OS title bar above each window?
    Custom chrome? jmacs is currently bare-chrome; staying that way
    is probably right.

    STAY BARE-CHROME.

    **Resolved:** OS title bar above each window; no custom chrome.

13. **Persistence schema versioning.** Cross-version compatibility
    for the session blob, or "best effort, ignore unknown"?

    I DON'T UNDERSTAND THIS QUESTION.

    **Deferred:** revisit when the session-restore work picks up.
    The question is whether session blobs on disk carry a schema
    version so a newer app can migrate older saves forward, or whether
    we just "best-effort, ignore unknown fields, fill in defaults."
    Pre-1.0; best-effort is the obvious lean but not load-bearing yet.

14. **Focus restoration on launch.** When session restore brings up N
    windows, which one is focused? Persist last-focused-window;
    restore it.

    YES.

    **Resolved:** persist last-focused window; restore that window's
    focus on launch.

15. **What does "current view" mean across windows?** The view in the
    focused pane of the focused window. `(current-view)` returns
    that. Commands that need a specific window/pane take an explicit
    handle.

    YES, THIS IS THE RIGHT WAY FORWARD. COMMANDS THAT NEED A WINDOW/PANE
    TAKE A HANDLE, AND WE HAVE LISP FUNCTIONS WHICH GENERATE/RETURN
    HANDLES.  FOR EXAMPLE, THE LISP COMMAND (split-horizontal 80 20) WHICH
    SPLITS THE CURRENT PANE WITH A 80% AND 20% WIDTH DISTRIBUTION WILL RETURN
    A LIST OF THE FORM (handleLeft, handleRight) WHICH CAN BE USED.

    **Resolved:** `(current-view)` is the active view in the focused
    pane of the focused window (with tabline-view active-child
    resolution per the section above). Commands that need a specific
    pane or window take an explicit handle. **Pane-creating
    commands return handles**, so they compose:
    `(split-horizontal 80 20)` returns `(handleLeft handleRight)`,
    and either can be passed to subsequent commands. The same
    convention applies to `(make-window!)`, `(make-tabline-view ...)`,
    etc. — every constructor returns the handle(s) it creates.

## Non-goals

- Non-rectangular pane shapes (see "Shape").
- Floating panes (overlapping non-tiled rects). Picture-in-picture
  is a future chrome feature, not a pane primitive.
- Cross-window pane drag. (Maybe later; not for the first cut.)
- Resizable inter-window splits — `BrowserWindow`s are independent
  OS objects; we don't pretend they're tiled together.
- Per-pane theme. Themes are global.

## Sketch of stdlib surface (illustrative, not final)

Constructors return the handle(s) they create (per Q15 resolution); a
caller can immediately compose, or discard the return value when
acting on `(current-pane)` is enough.

```
;; Pane and split — constructors return handles
(current-pane)                                 ; → pane handle
(other-pane)                                   ; → pane handle
(split-horizontal! ratio)                      ; → (left-handle right-handle)
(split-vertical!   ratio)                      ; → (top-handle  bottom-handle)
(delete-pane! pane)                            ; collapses into sibling
(delete-other-panes! [pane])                   ; Emacs `C-x 1`
(focus-pane-direction! 'left|'right|'up|'down)
(balance-panes!)

;; Tabline view — also a constructor; returns the tabline-view handle
(make-tabline-view tabs edge)                  ; edge ∈ 'top|'right|'bottom|'left
(add-tab! tabline-view view [index])           ; → tab index
(remove-tab! tabline-view index)
(activate-tab! tabline-view index)
(tabline-edge tabline-view)
(set-tabline-edge! tabline-view edge)

;; View
(current-view)                                 ; → view handle (active child of
                                               ;   the focused pane if a tabline)
(view-list)                                    ; → list of view handles
(view-buffer view)                             ; nil for non-text views
(view-kind view)
(switch-to-view! view-or-name)
(display-view-in-pane! pane view)
(kill-view! view)

;; Window
(current-window)                               ; → window handle
(window-list)                                  ; → list of window handles
(make-window!)                                 ; → new window handle
(delete-window! window)
(other-window)                                 ; → window handle
(focus-window! window)
```

Flag-day rename (Q4 resolution): `(current-buffer)`,
`(switch-to-buffer)`, `(buffer-list)`, etc. all go away in one pass.
Buffer ops (`point`, `insert`, `delete`, etc.) keep their names but
now operate on `(view-buffer (current-view))`; calling them in a
non-text view raises a condition.

## Companion changes worth bundling

Three other tidy-ups that drop out cleanly from this reshape:

- **The `kind` registry.** Today view kinds are hand-wired in
  `apps/desktop/src/app.js`'s switch statement. Promote it to a
  proper registry keyed by kind name, with `(register-view-kind!
  name spec)` exposed to Lisp. Each view kind contributes a factory
  + a modeline payload + an optional persister.

- **`docs/CUSTOM-VIEWS.md` rewrite.** The current doc walks through
  "add a view kind" assuming the buffer wrapper. After this reshape
  it can drop the buffer-wrapping discussion entirely for views
  that don't need one.

- **`agent-session` reconciliation.** The branch's tab and session
  model need a once-over. If it merges as-is and we then do the
  reshape, we'll be unwinding tab-points-to-buffer assumptions. If
  the reshape lands first, the branch can be revised on top of it
  before merge.
