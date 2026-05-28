# Snippets — guide notes

Design document for a snippet expansion system, shipped as a
package on top of the substrate `plans/PACKAGES.md` defines. The
intent is the same as that document: surface the design choices,
phase the implementation, name the risks. **Plan, not
implementation.** No code lands until the open questions at the
end have answers.

The reference point is Emacs's yasnippet. The intent is to provide
all the functionality a yasnippet user expects, without making
yasnippet-compatibility itself a goal — we'll be compatible where
it costs nothing and divergent where the editor's character calls
for it.

## Motivation

Snippets are productivity 101 — every serious editor has them.
yasnippet, VS Code's User Snippets, JetBrains Live Templates,
Sublime's snippet format. They're the single most-cited
productivity feature in onboarding surveys for any editor that
has them.

For Godot specifically, snippets are the **first substantial test
of the package system**. They exercise:

- `defcommand` (`snippet-expand`, `snippet-next-field`,
  `snippet-cancel`).
- `defcustom` (`*snippet-directories*`, key-binding overrides).
- `defface` (active-field background, mirror-field background,
  exit marker).
- Mode integration (per-mode snippet directories with
  fallthrough).
- Multi-cursor coordination (mirrors are multi-cursor selections
  in disguise — see "Mirrors" below).
- Non-Lisp assets (the snippet files themselves are data the
  package bundles).
- Keymap contributions, including the politically-fraught
  TAB key.

A snippets package is also the natural **first thing a Godot user
wants to write themselves** — almost every developer has a small
collection of personal snippets. A frictionless path from "I have
an idea for a snippet" to "it's bound to a key and working" is
exactly the kind of value that gets users to stay.

The waiting, again, has a productive shape: while the user waits
for tab stops to navigate, useful work happens.

## What a snippet is

A snippet is a **template** with marked positions the user fills
in interactively. Concretely:

```
for (let ${1:i} = 0; $1 < ${2:n}; $1++) {
  ${3:body}
}
$0
```

When this snippet expands at point:

1. The template body replaces the trigger (e.g. `for` plus TAB).
2. Cursor lands on `i` (the first tab stop), with `i` selected.
3. TAB moves the cursor to `n` (the second tab stop). Mirrors of
   `$1` (the two extra `$1` references) update live as the user
   types in the first field.
4. TAB again moves to `body` (selected).
5. TAB once more moves to `$0` (the exit point); the snippet
   commits, mirrors detach, normal editing resumes.

The mechanics:

- **Tab stops** (`$N` or `${N:default}`) are positions the cursor
  visits in numeric order on TAB.
- **Mirrors** are repeated references to the same `$N`; they
  update live as the user types in the field, but they aren't
  separately editable. Reaching `$N` via TAB places point on the
  first occurrence; the others mirror it.
- **Default values** (`${N:text}`) seed the field; if the user
  hits TAB without editing, the default is kept.
- **`$0`** is the exit position. When TAB lands there, the
  snippet commits and the cursor sits at that point.
- **Transformations** (`${1:$(form)}` in yasnippet syntax) compute
  the default or mirror value from an expression. Power tool;
  Phase 4.
- **Embedded code** (`` `(form)` `` in yasnippet syntax) is
  evaluated at expansion time, producing literal text. Date /
  filename / user-name kinds of things.

## File format and on-disk layout

Each snippet is a file. The file's name is its trigger; the
file's contents are its body (plus a header).

```
<snippets-dir>/
  text-mode/
    .yas-parents       ← fundamental-mode      (modes to fall through to)
    sig                ← snippet file: trigger is `sig`
    date
    todo
  js-mode/
    .yas-parents       ← prog-mode
    for
    fn
    cls
    import
  prog-mode/
    if
    while
  fundamental-mode/
    (typically empty; the root of mode fallthrough)
```

A snippet file's structure:

```
# -*- mode: snippet -*-
# key: for
# name: for-loop
# group: control-flow
# condition: (at-beginning-of-line?)
# --
for (let ${1:i} = 0; $1 < ${2:n}; $1++) {
  ${3:body}
}
$0
```

The header is yasnippet-style: hash-prefixed lines, key/value, a
`# --` separator before the body. Compatibility with existing
yasnippet collections is a real win at this layer; the actual
*syntax of the body* is where compatibility matters less (see
Decision 1 below).

### Locations

Snippets live in three layered directories, searched in order:

1. **User snippets**: `<user-data>/snippets/<mode>/...`. The
   user's personal collection; takes precedence over everything
   else. Edits via `M-x snippet-edit` write here.
2. **Package snippets**: any installed package may contribute
   snippets in its own `snippets/` subdirectory. The package
   loader registers these on `require!`.
3. **Bundled snippets** (Phase 1 may skip this): a small built-in
   collection that ships with the snippets package itself.

Earlier locations win on key collisions. The user can always
shadow a package-provided snippet by writing one with the same
key in their own snippets directory.

## Per-mode lookup and inheritance

Snippets register against a mode symbol. When the user invokes
expansion in a buffer whose major mode is `js-mode`:

1. Look in `<dir>/js-mode/` for a snippet keyed by the trigger.
2. If none, walk `.yas-parents` (or its Godot equivalent — see
   Decision 4) to find parent modes (`prog-mode`, then
   `fundamental-mode`) and try each.
3. If still none, the trigger is left in the buffer as ordinary
   text (no expansion).

Mode-name compatibility: yasnippet's collections use Emacs mode
names (`js-mode`, `python-mode`, `web-mode`). Godot's modes are
mostly Emacs-shaped (`js-mode`, `python-mode`); a small alias
table fills the gaps.

## Expansion mechanism

Triggered three ways:

- **TAB at a trigger word.** The most common path. Looks up the
  word-before-point as a key in the current mode's snippet
  directory; if found, expands. (See "The TAB key politics" below
  — this is the design's biggest collision risk.)
- **`M-x snippet-expand`** with an explicit key. Useful when the
  trigger heuristic is undesirable or the user wants to expand
  by a key the auto-trigger wouldn't catch.
- **`M-x snippet-insert`** opens a completing-read of available
  snippets for the current mode; the user picks by name.

Expansion process:

1. Read the snippet file (cached after first read).
2. Parse the body into a tree:
   - Literal text spans.
   - Tab stops with their index, optional default, optional
     transformation.
   - Mirrors (occurrences of `$N` not at the primary position).
   - Embedded code spans (Phase 4+).
3. Compute the inserted text (literal spans plus default values
   plus computed code).
4. Replace the trigger word in the buffer with the computed text.
5. Build the **active snippet** record: an overlay anchored at
   the inserted range, listing the field positions, mirrors,
   and current navigation index.
6. Move point to the first tab stop. Select its default value if
   present, so typing replaces it.

The active snippet is buffer-local. Only one snippet active per
buffer at a time (Phase 1 invariant; nested expansion is Phase 5
material).

## Field navigation

While a snippet is active:

- **TAB** advances to the next field. If on the last field, jumps
  to `$0` (or just past the snippet body if `$0` is absent) and
  commits.
- **Shift-TAB** moves to the previous field. Stops at the first
  field; doesn't wrap.
- **ESC** or **C-g** cancels the snippet — the inserted text
  stays, but the active record is discarded, tab stops disappear,
  mirrors stop updating.
- **Moving point outside the snippet's overlay** (e.g. arrow keys
  away, mouse click) is treated as a soft commit: the active
  record is discarded but the text stays.

The active field is highlighted with `snippet-active-face`;
mirrors get `snippet-mirror-face`; the exit marker (`$0`) gets a
faint `snippet-exit-face` indicator (optional, since `$0` becomes
just a position once reached).

## Mirrors via multi-cursor

This is where the editor's existing multi-cursor surface earns
its keep.

A snippet field with mirrors looks like multiple positions that
update in sync. The editor already does that — it's exactly what
multi-cursor edit mode is. A natural implementation:

- When TAB lands on field `$N` with mirrors, install a cursor set:
  primary cursor at the canonical position, secondary cursors at
  each mirror.
- The user types; the multi-cursor machinery propagates edits to
  all cursors.
- When TAB advances past `$N`, drop the cursor set: only the
  primary becomes the new point; mirrors become inert.

There's a subtlety: yasnippet treats mirrors as **read-only**
(the user can't edit them directly; they update from the canonical
field). Multi-cursor in Godot treats every cursor as
independently editable. Two policies:

- **Policy A**: snippet mirrors are multi-cursors. The user can
  click in a mirror and edit it directly; the canonical field
  updates too. Symmetric, simple.
- **Policy B**: snippet mirrors are read-only overlays that mirror
  the canonical field on a hook. yasnippet-compatible behaviour.
- **Policy C**: hybrid. Mirrors are multi-cursors but the visible
  affordance (different face) signals that they update with the
  canonical field; user can still edit them but the visual model
  is "primary plus echoes."

Decision deferred (see open question 7). The implementation cost
is roughly the same; the user model differs.

## Transformations and embedded code

Two distinct features, both Phase 4 candidates:

### Transformations

`${1:$(string-upcase yas-text)}` in yasnippet means "this field's
value is the upcased text of field 1." When the user types in
`$1`, this mirror displays the upcased version.

In Lisp form:

```
${1 :default "value"
    :mirror-of 1
    :transform (lambda (text) (string-upcase text))}
```

The transformation is a one-argument function that takes the
current value of the referenced field and returns the displayed
text.

### Embedded code

`` `(format "%d" (line-number-at-point))` `` in yasnippet means
"evaluate this Lisp form at expansion time; the result becomes
literal text in the body."

In Godot's dialect, the natural form is a small reader extension
or a dedicated marker:

```
@(format "~a" (line-number-at-point))
```

Or, if the manifest is already evaluated (Decision 8 of
PACKAGES.md), the snippet body itself could be Lisp:

```
(snippet
  :key "date"
  :name "today's date"
  :body (list "Today is " (current-date-string)))
```

The Lisp-form-snippet path is more powerful but loses yasnippet
file compatibility. See Decision 1 below.

## The user-facing surface

### Commands

```
M-x snippet-expand          ; expand the word before point
M-x snippet-insert          ; pick by name from a completing-read
M-x snippet-next-field      ; (also bound to TAB while active)
M-x snippet-prev-field      ; (also bound to S-TAB while active)
M-x snippet-cancel          ; (also bound to ESC / C-g while active)
M-x snippet-new             ; new snippet from selection
M-x snippet-edit            ; pick a snippet, open its file for editing
M-x snippet-reload          ; rescan snippet directories
M-x snippet-list            ; list available snippets for current mode
M-x snippet-describe        ; show a snippet's body + metadata
```

### Defcustoms

- `*snippet-directories*` — list of root directories searched in
  priority order. Defaults to `("<user-data>/snippets/")` plus
  whatever installed packages contribute.
- `*snippet-expand-key*` — the key that triggers expansion when
  the word-before-point is a known trigger. Default: TAB. Set to
  nil to disable the auto-expand path entirely (user can still
  expand via `M-x`).
- `*snippet-mode-aliases*` — assoc mapping yasnippet mode names
  to Godot mode symbols. Default covers the common ones.
- `*snippet-condition-eval*` — boolean. If `#t`, snippet header
  `# condition:` forms are evaluated to decide whether the
  snippet is eligible for expansion at point. If `#f`, the
  condition is ignored. Default: `#t`.

### Faces

- `snippet-active-face` — the currently-focused field.
- `snippet-mirror-face` — mirrors of the active field.
- `snippet-inactive-face` — fields the user hasn't reached yet.
- `snippet-exit-face` — the `$0` marker (faint).

### Modeline indicator

When a snippet is active, the modeline shows
`[snippet: 2/4]` — current field, total fields. Disappears on
commit / cancel.

## The TAB key politics

TAB is the most-contested key in any editor. In Godot today:

- TAB inserts a literal tab in modes that want hard tabs.
- TAB calls `indent-line-for-mode` in modes that want soft
  indent.
- (Future) TAB triggers LSP autocomplete when a completion popup
  is visible.
- (Future) TAB navigates fields when a snippet is active.
- (Future) TAB expands the trigger word when one is a known
  snippet key.

The order of consideration when TAB is pressed:

1. **If a snippet is active**: TAB navigates to the next field
   (this wins over everything; the user is mid-snippet).
2. **If an autocomplete popup is visible** (LSP / find-file / …):
   TAB accepts the current candidate.
3. **If the word-before-point is a known snippet trigger AND
   `*snippet-expand-key*` is TAB**: TAB expands the snippet.
4. **Otherwise**: TAB indents / inserts a literal tab (mode-driven).

The first three are escape hatches over the fourth. Each has
its own `*…-key*` defcustom so a user who doesn't like TAB as
trigger can move it (e.g. `C-=`).

The expansion-trigger heuristic deserves care:

- "Word before point" is the chunk of `\w+` characters ending at
  point. For a snippet keyed `for`, the trigger fires when the
  user has typed `for` and point is immediately after the `r`.
- If the snippet body's `# condition:` form returns nil, the
  trigger is skipped — TAB falls through to indent.
- A snippet keyed `_xy_` (non-word characters in the key) is
  reachable only via `M-x snippet-insert`, not via the
  word-before-point path.

## What this plan deliberately doesn't do

- It doesn't define the exact syntax of the snippet body —
  Decision 1 (yasnippet-compatible vs Lisp-form) settles that
  before any code.
- It doesn't ship a snippet collection. The package defines the
  contract; the snippets themselves are a separate concern. A
  small starter set ships in the bundled-snippets directory; the
  rest are the user's to build.
- It doesn't pick a font / colour palette for the field faces.
  Theme-driven; defaults track the existing palette.
- It doesn't address snippet sharing / cloud sync. Users
  symlink, version-control, or copy as they wish.
- It doesn't support nested expansion in Phase 1 (snippet inside
  snippet); Phase 5 if there's demand.
- It doesn't support multi-cursor expansion (expand a snippet
  at every active cursor). Phase 5 if there's demand.

## Open questions

These need answers before Phase 1 is briefable.

1. **Body syntax — yasnippet-compatible, Lisp-form, or both?**
   yasnippet's `$1` / `${1:default}` / `` `code` `` syntax is
   widely understood; thousands of existing snippets work
   unchanged. Lisp-form is the editor's character. Both is
   possible but commits us to two parsers and two mental models.
   Recommendation: ship yasnippet syntax as the primary form;
   allow a Lisp-form alternative as a Phase 4+ option for power
   users who want the compute-the-body path. Confirm.

2. **Package name.** `godot-snippets` (utilitarian),
   `snippets` (assumes namespace), `pozzo` (Beckett character —
   Pozzo carries a bag with mysteries in it; thematically
   consistent with Vladimir's Chest), or something else?

3. **Should this ship as a baseline package** (Decision 5 of
   PACKAGES.md commits to a curated baseline; snippets is a
   strong candidate)? Or as user-installed only? Baseline means
   "every Godot user has snippets out of the box"; user-installed
   means "you opt in." Recommendation: ship as baseline; the
   feature is too useful to gate behind discovery.

4. **Mode inheritance file format.** yasnippet uses
   `.yas-parents` — a file with parent mode names. Reuse the
   same name (compatibility), or use `.godot-parents`
   (consistency)? Either way the format is identical. Lean
   toward `.yas-parents` for compatibility with existing
   collections.

5. **Snippet directory location for user snippets.**
   `<user-data>/snippets/` is the obvious answer and matches
   Decision 3 of PACKAGES.md (everything user-modifiable in the
   userData dir). Confirm.

6. **Condition form evaluation.** yasnippet's `# condition:` is
   a sandboxed Emacs Lisp form. We need to decide what
   primitives are available — `looking-back`, `at-beginning-of-line?`,
   buffer mode, etc. — and what's banned (file I/O, network,
   anything with side effects). Recommendation: a read-only
   sandbox env, similar to the package manifest sandbox.

7. **Mirror policy.** A (mirrors are multi-cursors, freely
   editable), B (mirrors are read-only echoes), or C (hybrid:
   editable but visually distinct)? A is the most idiomatic for
   Godot's existing multi-cursor surface; B matches yasnippet.
   Recommendation: A, with the per-face visual cue distinguishing
   primary from mirrors. Document the divergence from yasnippet.

8. **What happens when a mirror is manually edited.** Under
   Policy A: editing a mirror updates the canonical field (since
   they're symmetric multi-cursors). Under Policy B: editing a
   mirror is impossible without a user action that breaks
   read-only. Decide alongside #7.

9. **Snippet expansion in non-text views.** Should snippets
   work in the REPL? In a customize view? Recommendation: text
   buffers only in Phase 1. The REPL gets its own decision
   later.

10. **TAB as expansion trigger — opt-in or default?**
    Recommendation: default opt-in (`*snippet-expand-key*` is
    TAB), with `*snippet-disable-tab-trigger-modes*` for modes
    that need TAB for something else (a hypothetical terminal
    mode, perhaps).

11. **Transformation language.** yasnippet allows arbitrary
    Emacs Lisp in transformations. The Godot equivalent is
    arbitrary Godot Lisp — same trust model as the package
    system (Decision 8 of PACKAGES.md). Confirm.

12. **Snippet selection on ambiguous keys.** If two installed
    snippets share a key (say, both user snippet and package
    snippet for `for`), should the user-level shadow win
    silently, or offer a chooser? Recommendation: user shadows
    silently; `M-x snippet-list` shows what shadows what.

13. **Backup of the trigger word on cancel.** If the user types
    `for`, hits TAB, expands, then cancels — do we revert to the
    pre-expansion buffer state (re-inserting `for`)? Or leave the
    expanded body? Recommendation: revert. Cancel means cancel.

14. **History / undo integration.** The expansion is one undo
    step (so a single C-z reverts it); field navigation is not
    in the undo history (TAB-ing through fields isn't a thing
    to undo). Confirm.

## Suggested phasing

### Phase 1 — Static expansion (no tab stops)

The smallest useful version. Type `for`, hit TAB, the body
inserts at point. No tab stops, no mirrors. Point lands at the
end of the inserted body.

- Snippet file format reader.
- Directory walker for user / package snippet directories.
- Mode resolution + parent fallthrough.
- The `*snippet-directories*` defcustom.
- `M-x snippet-expand` (manual trigger).
- `M-x snippet-insert` (name picker).
- `M-x snippet-list` (browse).
- TAB binding in text-mode (with the precedence rules above —
  but without snippet-active and autocomplete-active branches
  since those don't yet exist).
- A small starter snippet collection in the package's
  `snippets/` directory (~10 universal entries: shebang lines,
  date stamps, signature, copyright header).

Tests: file parsing (header + body), mode resolution,
directory layering (user shadows package), TAB heuristic,
condition form evaluation.

This phase delivers the most-used 60% of yasnippet — most user
sessions only ever expand snippets without using tab stops.

### Phase 2 — Tab stops and default values

Adds the active-snippet record, field navigation, default-value
selection.

- The parser learns about `$N` and `${N:default}`.
- The active-snippet overlay machinery.
- TAB / S-TAB navigation.
- ESC / C-g cancel.
- Modeline indicator `[snippet: 2/4]`.
- `snippet-active-face` / `snippet-inactive-face` /
  `snippet-exit-face`.

Tests: parse correctness for `$N`/`${N:default}`/`$0`, TAB
sequence visits fields in numeric order, cancel reverts (per
Decision 13).

### Phase 3 — Mirrors

The visible delta on top of Phase 2: type in `$1`, watch the
other `$1`s update.

- Parser recognises repeated `$N` and marks the secondary
  positions as mirrors.
- On TAB-arrival at `$N`, install a cursor set covering the
  canonical position and the mirrors.
- `snippet-mirror-face` for the secondary positions.
- On TAB-departure, drop the cursor set.

Tests: mirror count matches occurrence count, simultaneous
edits propagate, mirrors detach on advance.

### Phase 4 — Transformations and embedded code

Adds the power-user features:

- `${1:$(form)}` syntax (transformations).
- `` `(form)` `` syntax (embedded expansion-time code).
- The condition-form mechanism (`# condition:`).
- The Lisp-form snippet alternative if Decision 1 allows.

Tests: transformation function called on field-edit, embedded
code evaluated once at expansion, conditions gate expansion
correctly.

### Phase 5 — Polish

- `M-x snippet-new` (capture current selection as a snippet).
- `M-x snippet-edit` (open snippet for editing).
- `M-x snippet-reload`.
- Nested expansion (snippet inside snippet's field).
- Multi-cursor expansion (one snippet at each cursor).
- Choose-from-list fields (`${1:$(choose '("a" "b" "c"))}`).

Each item in Phase 5 stands alone; they can ship in any order
based on user feedback.

## Risks

- **TAB politics**. The biggest risk is making TAB feel
  unpredictable. Mitigation: the precedence order is documented,
  defcustoms allow rebinding, and a status indicator names what
  TAB is about to do (autocomplete popup visible →
  `[tab: complete]`; snippet active → `[tab: snippet]`; etc.).
- **Multi-cursor interactions**. Mirrors-as-multi-cursor is
  elegant but the existing multi-cursor surface has its own
  invariants (per-view cursor sets, ESC deselect semantics). The
  mirror machinery has to play well with `M-x select-all-matches`
  while a snippet is active. Test thoroughly.
- **Cache invalidation**. Snippets are read from files; users
  edit those files. The reload story has to be obvious
  (`M-x snippet-reload`; file-watchers later). A stale cache
  silently using the wrong body is a confusing failure mode.
- **Trigger-word heuristics**. "Word before point" is intuitive
  in most cases but lossy near punctuation. The user types
  `}else<TAB>` expecting `else` to expand; the heuristic catches
  it, but `_else_` doesn't. Document; ship the obvious behaviour.
- **Compatibility ambition vs reality**. Promising
  "yasnippet-compatible" is a hostage to fortune. yasnippet has
  features no one uses, edge cases no one tests, and behaviours
  that emerged from twenty years of accretion. Promise
  "yasnippet-style" instead; document the deltas.
- **Performance**. Thousands of snippets in one mode directory
  is plausible (a large team's collection). Filesystem walks
  every expansion don't scale; an in-memory index keyed by
  (mode, key) is the obvious fix. Phase 1 can get away without;
  Phase 2 should add the index.

## What this package contributes (manifest sketch)

When packaged per `plans/PACKAGES.md`:

```lisp
(package godot-snippets             ; or whatever name Decision 2 picks
  :version "0.1.0"
  :author "Godot"
  :doc "Snippet expansion à la yasnippet."
  :godot-version ">= 0.5"           ; whatever Phase 1 ships under
  :depends ()                        ; no other-package deps
  :sources
    ("snippets.lisp"                 ; commands, navigation, expansion
     "snippets-parser.lisp"          ; the body parser
     "snippets-overlay.lisp"         ; active-snippet record + faces
     "snippets-keymap.lisp")         ; TAB bindings (loaded last)
  :autoload
    (snippet-expand snippet-insert snippet-list snippet-edit snippet-new)
  :eager? #t                         ; the TAB binding has to be live at boot
  :provides
    (:commands  (snippet-expand snippet-insert snippet-next-field
                 snippet-prev-field snippet-cancel snippet-new
                 snippet-edit snippet-reload snippet-list
                 snippet-describe)
     :modes     ()
     :keymaps   ()                    ; binds into existing keymap
     :faces     (snippet-active-face snippet-mirror-face
                 snippet-inactive-face snippet-exit-face)
     :settings  (*snippet-directories* *snippet-expand-key*
                 *snippet-mode-aliases* *snippet-condition-eval*)))
```

`:eager? #t` is the key bit: snippets need their TAB binding live
at boot, before the user does anything. An autoload-only path
would mean TAB doesn't trigger expansion until the user has
already invoked the snippets package via `M-x` once.

## Closing note

A snippet package isn't a frontier feature — yasnippet is twenty
years old. It is, instead, **table stakes** for a serious editor,
and a perfect first-substantial-package for Godot to ship. It
exercises everything the package system promises (autoload,
defcommand, defcustom, defface, keymap contribution, eager load,
non-Lisp assets). It demonstrates the editor's character (Lisp at
the seams, multi-cursor as substrate, faces as data). And it
ships a feature users miss the moment they encounter an editor
without it.

The waiting that Beckett's play makes its subject is, in the
editor's world, the waiting between typing `for` and seeing the
loop unfold. Godot's job is to make that waiting short.
