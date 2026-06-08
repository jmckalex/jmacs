# The split placeholder — a chooser view for new panes

Design note for replacing split's silent auto-clone with a "placeholder"
chooser view. Pre-implementation; settle here, then build on a branch.

**Status:** drafted 2026-06-03 from a design conversation with Jason. The
decisions below are **[settled]**; one interpretation (placeholder ↔
`views`) is flagged for confirmation.

## Why

Splitting a pane currently calls `buildDuplicateViewForSplit`
(`app.js:664`): it silently mints a *duplicate* view (text → shared
buffer + fresh cursor; non-text → a fresh `*scratch*`) and drops it in
the new pane. Those duplicates accumulate as orphans once the user
repurposes the pane — the root cause of the "four copies in the View
List" bug (see the swap/permute investigation). The fix is to **stop
auto-cloning**: a fresh split shows a *placeholder* that asks the user
what the pane should hold. Cloning becomes one explicit option, not a
silent default. This also unifies text and non-text splits (no more
surprise `*scratch*`).

## What the user sees

On split, the new pane shows a centred prompt:

> **Do you want to … _o_pen a file, _c_lone the previous view, _s_tart a
> new file, or _r_un a command?**

with the four accelerators underlined. **Focus moves to the new pane**, so:

- `o` → the `find-file` minibuffer flow; the chosen file opens *in this
  pane*, replacing the placeholder.
- `c` → clone the originating pane's view into this pane (see "Clone
  semantics").
- `s` → a fresh empty text view (`*scratch*`-like) in this pane.
- `r` → the four chips are replaced by a **bare centred text input**
  below the prompt; type a command name (e.g. `gnuplot`), Enter runs it
  via `run-command`, and whatever view it produces lands in this pane.
  Escape returns to the chooser.
- **Enter** (no letter) performs the **default action**, customisable via
  `*placeholder-default-action*` (default: `clone`).
- Escape from the chooser is a no-op in v1 (the pane keeps the
  placeholder until filled; close the pane to discard it).

## Settled decisions

1. **Focus moves to the new placeholder pane on split.** This changes the
   current "the originating pane keeps focus" contract for
   `split-horizontal!` / `split-vertical!` / add-pane. Their docstrings
   and any focus-asserting tests must be updated. **[settled]**
2. **The placeholder is ephemeral, with no residue. [settled]** Chosen
   implementation (flag if you want it strictly out of `views`): the
   placeholder is a transient `views` entry *internally* — so
   `currentViewIndex = views.indexOf(focused)` and the modeline keep
   working — but it is:
   - **excluded** from the View List (`viewListRecords` / `list-views`
     filter out `kind === 'placeholder'`),
   - **skipped** by `next-view` / `previous-view` cycling,
   - **not persisted** (added to the ephemeral-kinds set in `session.js`),
   - **spliced out of `views`** the instant it is replaced by a real
     view *or* its pane is closed/collapsed.
   The modeline shows a placeholder-specific label (e.g. `(choose a
   view)`) rather than a `9/7`-style count.
3. **Enter defaults to the configured action; default is `clone`,
   customisable. [settled]** New defcustom `*placeholder-default-action*`
   ∈ `{open, clone, new, command, none}`, default `clone`.
4. **Clone = a new instance at the same target. [settled]** See below.
5. **Scope = split paths only for v1** (`C-x 2`/`C-x 3` and the `C-x +`
   add-pane macro): fully replace `buildDuplicateViewForSplit`. The
   general "empty pane ⇒ chooser" case (e.g. killing the last view, where
   there's no previous view to clone) is **out of v1**. **[settled]**
6. **The command input is a bare text field for v1** — no completion or
   hints. **[settled]**

## Clone semantics (the `c` action and the `clone` default)

Clone duplicates the *originating pane's* view (remembered on the
placeholder at split time) as a **new instance at the same target**:

| Origin kind | Clone produces |
|---|---|
| text | a new text view over the **same buffer**, fresh point, mark cleared (today's `buildDuplicateViewForSplit` text path — independent cursor, Q2/Q9) |
| browser | a new browser view at the **same URL** |
| pdf / image / audio / video | a new view of the **same file** |
| shell | a **fresh shell** (a pty's scrollback can't be cloned; "same target" = a new shell) |
| notebook / directory-tree / gnuplot / other | a new instance of the same kind/target where meaningful; fall back to a fresh `*scratch*` when there's no sensible clone |

Implemented as a per-kind `cloneViewForPlaceholder(originView)` with a
text default and a small switch for the non-text kinds, falling back to
scratch.

## The placeholder view kind

Standard view-kind skeleton (per `docs/VIEWS.md` / `docs/CUSTOM-VIEWS.md`):

- **Custom element** `<placeholder-view>` in
  `packages/renderer/src/placeholder-view.js` (per-instance): renders the
  prompt, four accelerator chips, and the command-mode input; exposes
  `onKey`-style handling and `configure({ onOpen, onClone, onNewFile,
  onRunCommand, defaultAction, cloneLabel, cloneEnabled })`.
- **Configure factory** `configurePlaceholderView()` in `app.js`, wired
  into `perKindConfigureFactory`; **per-instance** (each split = its own
  placeholder), not a singleton.
- **Host actions** the factory passes down:
  - `onOpen` → `openFileInteractive()` targeted at this pane.
  - `onClone` → `cloneViewForPlaceholder(prevView)` → place in this pane.
  - `onNewFile` → fresh text view in this pane.
  - `onRunCommand(text)` → `run-command` the typed name (the focused pane
    is this one, so view-opening commands land here).
  - each of these calls `replacePlaceholder(leaf, newView)` (below).
- **`buildPlaceholderForSplit(originView)`** replaces
  `buildDuplicateViewForSplit`: returns a `placeholder`-kind view whose
  `extras.previousView = originView` (for the clone action), pushes it to
  `views` (transient), and the split path focuses the new leaf.

### Replacing the placeholder (no residue)

`replacePlaceholder(leaf, newView)`:
1. set `leaf.view = newView` and mount it in the leaf's pane element;
2. **splice the placeholder out of `views`** and `notifyViewsChanged()`;
3. fix `currentViewIndex` to the new view; update the modeline.

The placeholder is also removed from `views` when its pane is closed /
collapsed without being filled (hook into the delete-pane / collapse
path). These two paths are the whole of "leaves no residue."

## Key handling

The placeholder element captures `o`/`c`/`s`/`r`/Enter/Escape when its
pane is focused (the same `onKey` pattern the view-list and
directory-tree views use, routed through the global dispatcher). In
command mode the centred `<input>` takes focus and keeps its own keys —
the established browser-URL-bar pattern — with Escape returning to the
chooser. `*placeholder-default-action* = command` makes Enter jump
straight to the input.

## Customisation

```lisp
(defcustom *placeholder-default-action* 'clone
  "What Enter does in a fresh split's placeholder: one of
   'open 'clone 'new 'command 'none.")
```
The host reads this value when the placeholder handles Enter.

## Main implementation risk

The editor assumes **every `leaf.view` is in `views`** and that the
focused leaf's view has a valid `currentViewIndex`. The placeholder
honours this (decision 2 keeps it in `views`), but every spot that
*enumerates or switches* views must tolerate the placeholder kind:
`switchToViewIndex`, `setCurrentPaneId`'s peel, `next/previous-view`,
`killViewAtIndex`, the modeline branch, session save, and both
view-record builders. Audit each against the placeholder before calling
it done — this is the `9/7`-family hazard.

## Testing

- **Pure / unit:** `cloneViewForPlaceholder` per kind (text shares
  buffer + fresh point; browser same URL; shell fresh; fallback scratch).
  The default-action resolution from `*placeholder-default-action*`.
  View-list / `list-views` exclude `placeholder` kind. `next/previous-view`
  skip placeholders.
- **Manual / smoke (hand off, per test-before-merge):** split → focus
  lands on the placeholder; `o`/`c`/`s`/`r` each fill the pane and leave
  **no residue** in the View List; Enter = clone (and tracks the
  defcustom); command mode runs `gnuplot` and lands a gnuplot view;
  closing an unfilled placeholder pane leaves no orphan; clone of a
  browser/pdf/shell yields a correct new instance.

## Open / naming notes

- Kind name: `placeholder` (internal); element `<placeholder-view>`.
- The placeholder↔`views` interpretation (decision 2) — confirm whether
  the transient-in-`views` approach is acceptable, or it must be strictly
  out of `views`.
