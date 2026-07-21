## Customization from Lisp

The *Customization* chapter walks through the customize buffer as a
user sees it: widgets, Apply and Save buttons, colour pickers. This
chapter sits on the other side of that glass. Every row in that buffer
exists because a line of Lisp declared it — a `defcustom` for a
setting, a `defface` for a colour — and the same declarations are
available to you in `init.lisp`, on exactly the same footing as the
standard library's. By the end you can declare a setting with a type
and a live `:on-change` hook, group it so it is findable, give a face
per-theme defaults, attach it to a syntax construct, and know
precisely which changes persist where.

> *A setting is not a variable the editor happens to read; it is a
> variable that has been introduced to the editor — with a type, a
> home, and a story about what changing it should do.*

The model has three parts. A declaration: `defcustom` defines an
ordinary global variable *and* records it in a registry
(`*custom-registry*`) with its type, default, group, documentation,
and an optional change hook. A renderer: the customize buffer
(`M-x customize`, cmd(customize)) reads the registry and turns each
entry into the right widget. And persistence: a saved setting is
written to `custom.lisp` as one small Lisp form, replayed at the next
launch. Code that *uses* a setting touches none of this — it just
reads the variable; the registry exists so the UI, the persistence,
and the hook all derive from one declaration. For the user-facing tour
of the buffer and its states, see *Customization*; everything below is
the author's seat.

### Declaring a Setting with defcustom

```lisp
(defcustom *name* DEFAULT TYPE
  :group 'GROUP                          ; defaults to 'godot
  :doc "What the setting does."
  :options '(a b c)                      ; for :choice only
  :on-change (lambda (name value) …))    ; optional live hook
```

`defcustom` is a macro. The variable name is written bare (it is not
evaluated); `DEFAULT`, `TYPE`, and every keyword value *are* evaluated
— so `:group` takes a quoted symbol, `:options` a quoted list, and
`:on-change` a `lambda` form that becomes a closure. The expansion
registers the setting, then defines the variable — to the *registered*
value, not the literal default, so re-evaluating a `defcustom`
(`C-enter` on the form, say) refreshes the metadata while a value the
user has customised survives. Like `define`, the form returns the
variable's name.

Setting names wear *earmuffs* — `*theme*`, `*tab-width*`,
`*auto-pair*` — the dialect's convention for user-visible global
state. The asterisks are part of the name, not syntax; they tell a
reader "this binding is configuration" (see *Lisp Style and Pitfalls*).

Two stdlib declarations show the range. From `jukebox.lisp`, a string
whose hook re-renders the jukebox rows the moment the template
changes:

```lisp
(defcustom *jukebox-track-format* "\"{title}\", {artist}, {album}" :string
  :group 'jukebox
  :on-change (lambda (name value) (refresh-jukebox-labels!))
  :doc "Template used by `format-track` to render each row in a jukebox
   buffer. …")
```

And a `:choice` from `panes.lisp`, where the value is one of an
enumerated set of symbols:

```lisp
(defcustom *placeholder-default-action* 'clone :choice
  :group 'panes
  :options '(open clone new command none)
  :doc "What Enter does in a fresh split's placeholder chooser: one of
   'open (find a file), 'clone (duplicate the originating view — the
   default), 'new (a fresh *scratch* view), …")
```

Your own declarations go in `init.lisp` and look exactly the same:

```lisp
(defcustom *manuscript-width* 72 :number
  :group 'godot
  :doc "The column width my manuscript tooling wraps prose at.")
*manuscript-width*   ; ⇒ 72 — afterwards, just a variable
```

#### The Five Setting Types

`TYPE` is a keyword. Five are in use across the standard library, and
each determines the widget the customize buffer renders:

| Type | Value shape | Widget |
|------|-------------|--------|
| `:boolean` | `#t` / `#f` | a checkbox |
| `:number` | a number | a one-line text field |
| `:string` | a string | a one-line text field |
| `:choice` | one symbol from `:options` | a dropdown of the options |
| `:list` | a list | a one-line text field |

A `:choice` declares its vocabulary with `:options`, a quoted list of
symbols; the machinery coerces a stale string from an old save file
back to the matching symbol, so `(eq? *theme* 'dark)` keeps working
downstream. The widget honesty: only `:boolean` (a real checkbox) and
`:choice` (a real dropdown) get structured widgets — the renderer's
widget switch has no case for `:number`, `:string`, or `:list`, so
all three share the same plain text field. For `:number` and
`:string` that is merely plain; for `:list` it cannot round-trip a
list at all, so treat list-valued settings (`*latex-command*`,
`*snippet-directories*`) as code territory — declare them so they are
documented and discoverable, change them from Lisp. (The customize
buffer's row also shows each setting's *state* — `standard`, `set`,
or `saved`, computed by `custom-state` from the registry; a `set!`
that bypasses the registry leaves both the displayed value and the
state stale, which is the desync the next section warns about.)

### Grouping Settings with defgroup

```lisp
(defgroup 'name 'parent "What the group collects.")
```

`defgroup` is an ordinary procedure (both symbols are quoted),
evaluated for its effect on the group table. Groups form a tree: the
root is `godot` (registered with parent `nil`), and the stdlib hangs
`appearance`, `editing`, `faces`, `latex`, `snippets`, `panes`,
`jmarkdown`, `reftex`, and a dozen others off it. The customize
buffer scoped to a group shows its documentation, a link for each
registered subgroup, and a row for each setting whose `:group` names
it — the tree is also the navigation. From Lisp,
`(customize-group 'latex)` opens the buffer scoped to one group, and
`(customize-variable '*theme*)` to a single setting.

Register a group before filing settings under it: browsing starts at
`godot` and follows only registered links, so a setting filed under an
unregistered group name still works but is invisible to top-down
browsing. Copy `jukebox.lisp`'s pattern — the `defgroup` sits
immediately above the first `defcustom` that uses it.

### Reading and Changing Settings from Code

Reading is nothing: the setting *is* a binding, so `*tab-width*` in
any expression yields its current value; `(custom-value '*tab-width*)`
reads the registry's copy instead — normally the same value, and the
one the customize buffer displays. Writing has two paths, and the
difference matters:

```lisp
(set! *tab-width* 8)                  ; the blunt path
(custom-apply! '*tab-width* 8)        ; the registered path
```

`set!` changes the variable and nothing else: code reading the
variable sees the new value, but the registry still holds the old one
— the customize buffer now lies about the setting's value and state —
and the `:on-change` hook does **not** run. `custom-apply!` updates
the registry *and* the variable, then runs the hook. Use
`custom-apply!`; reserve `set!` for plain variables that were never
`defcustom`ed. Around it sit three relatives: `custom-apply-and-save!`
applies and then persists to `custom.lisp`; `custom-reset!` applies
the default again; `custom-set-saved!` is the form the persistence
file is written in (you read it, you do not write it). All three route
through `custom-apply!`, so all three fire `:on-change`.

The hook's firing rules, precisely: it receives the setting's name (a
symbol) and the new value, and runs every time `custom-apply!` runs —
from the customize buffer's Apply and Save, from `custom-reset!`, and
from the `custom-set-saved!` replay at startup, so write it to
tolerate running at load time. It runs unconditionally, even when the
new value equals the old; it does **not** run at declaration time —
`defcustom` registers the default without "applying" it.

One boundary to know about: settings whose *consumer* is renderer
JavaScript rather than Lisp — `*math-tooltip-scale*`,
`*jukebox-track-format*`, and a handful more — are declared in the
server's renderer-config block (`RENDERER_CONFIG_VARS` in
`apps/desktop/mwb/spine.js`), with an `:on-change` that pushes the
new value to every window. A setting you declare in `init.lisp` can
drive any *Lisp* consumer live through its own `:on-change`, but it
cannot reach renderer-side JS that way — that channel is host
territory (`math-preview.lisp`'s closing comment points at the
pattern).

### custom.lisp and the Order of Loading

When a setting is saved — from the buffer or by
`custom-apply-and-save!` — the editor rewrites `custom.lisp` in the
config home (`~/.godot`, or `$GODOT_HOME` when set; the *Customization*
chapter's persistence section has the full story): a comment header
and one line per saved setting,

```lisp
(custom-set-saved! (quote *theme*) (quote midnight))
```

The file is machine-written, and wholly so: every save regenerates it
from the registry, so a hand-edit survives only until the next save;
anything you want to say in code belongs in `init.lisp`.

At startup the editor loads the standard library, then `custom.lisp`,
then `init.lisp` (the full sequence is in *Modules and Program
Structure*). The order is deliberate — saved customisations apply
first, so a hand-written form in `init.lisp` has the last word — and
it has a corollary. A `defcustom` declared in `init.lisp` is not yet
registered when `custom.lisp` replays, and `custom-set-saved!` ignores
unregistered names, so a *saved* value for an init-declared setting is
dropped on a cold start. For your own settings, make the `defcustom`
default the value you want (or follow it with a `custom-apply!` line);
Save-persistence is for the settings the standard library declares.

### Declaring a Face with defface

A *face* names a bundle of text-display attributes; syntax
highlighting paints each recognised construct with the attributes of
the face assigned to it. The attributes: `:foreground` and
`:background` (hex colour strings), `:weight` (`:bold`), `:slant`
(`:italic`), `:underline` and `:strike-through` (booleans), plus
`:size` (a number) and `:family` (a CSS font-family string) — the
typography pair, carried in practice by the base `default` face
below. An attribute map is built with the `face` constructor, which
takes keyword pairs and tolerates any subset —
`(face :foreground "#e8a87c" :weight :bold)` evaluates to the
two-entry map `{:foreground "#e8a87c" :weight :bold}`. `defface`
registers a face with a docstring, an optional parent, and per-theme
default blocks, each keyed `:default-<theme>` after a registered
theme's name:

```lisp
(defface 'name
  :doc "…"
  :default-dark            (face …)   ; the fallback block
  :default-solarized-light (face …)
  :default-nova            (face …))  ; …one block per theme it colours

(defface 'name from 'parent :doc "…" …)   ; inheriting form
```

The block set is open-ended, not fixed: a face supplies a block for
each theme it cares about, and under a theme it has no block for it
falls back to its `:default-dark` block — which is why a
partially-themed face still resolves sensibly under any theme, and
why adding a theme needs no change to existing faces. Two syntactic
notes. The face name is *quoted* — `defface` evaluates the name
position, unlike `defcommand` and `defcustom`, which take bare names.
And `from` is a literal word between the name and the first keyword,
naming a single parent face. Here is `comment` from `themes.lisp`,
the file that declares the built-in token faces — fifteen of them,
`comment` through `link` — with a block per shipped theme:

```lisp
(defface 'comment
  :doc "Source comments — slash-slash, hash, percent — italicised."
  :default-solarized-light (face :foreground "#586e75" :slant :italic)
  :default-dark            (face :foreground "#7c8f9e" :slant :italic)
  :default-bright          (face :foreground "#8aa0b3" :slant :italic)
  :default-midnight        (face :foreground "#8b949e" :slant :italic)
  :default-solarized-dark  (face :foreground "#657b83" :slant :italic)
  :default-emacs           (face :foreground "#44b340" :slant :italic)
  :default-nova            (face :foreground "#729abb" :slant :italic))
```

> note: the theme names describe palettes, not backgrounds — `bright`
> is a *dark-background* theme with a saturated palette, and `emacs`
> puts classic font-lock colours on a dark slate ground. Of the seven
> shipped themes only `solarized-light` sits on a light background;
> every other block wants light foregrounds on a dark surface.

Like `defcustom`, a `defface` re-registers cleanly: re-evaluating it
rewrites the defaults while colours the user has chosen survive.

One face is special. The base face `default` (declared in
`themes.lisp` above the token faces) owns the editor's typography:
its `:size` and `:family` set the editing surface's font, and every
other face inherits them unless it overrides — so
`(set-face-attribute 'default :size 16)` resizes the whole editor
live, which is exactly what the customize buffer's font controls do.
Colours are deliberately *not* set on `default`; they stay
theme-owned.

#### Per-Theme Defaults, Overrides, and Inheritance

When the renderer asks what `comment` looks like, `resolve-face`
answers attribute by attribute, most specific source winning: the
user's per-mode override, then their per-theme override, then their
global override, then the `defface` default for the active theme (the
`:default-<theme>` block named after it, or the face's
`:default-dark` block when it has none) — and an attribute still
missing falls through to the parent face, resolved the same way (the
chain is walked to the top; a cycle is an error), so a child face
declares only what it changes. The override layers are what
cmd(customize-faces) and `set-face-attribute` write —
`(set-face-attribute 'comment :foreground "#ff5370")` globally, or
scoped with `:theme 'dark` or `:mode "LaTeX"`. The API around it:
`set-face!` replaces a face's override map wholesale (same `:theme`
keyword); `set-face-in-mode!` and `reset-face-in-mode!` do the same
for the per-mode layer; `reset-face` drops one face's override,
`reset-all-faces` every override in every layer; and
`(customize-face 'comment)` opens the customize buffer scoped to the
one face. The user-side story, with persistence to `faces.json`, is
in *Customization*.

### Attaching a Face to a Construct

A face does nothing until something wears it. The built-in assignments
live in each language's tree-sitter highlight query (JavaScript, in
`packages/renderer/src/languages/`); the Lisp-side surface is an
*override layer* of kind-to-face rules applied on top:

```lisp
(add-highlight-rule! 'mode "Markdown" "atx_heading" 'manuscript-heading)
```

The arguments: a scope — `'mode` (this major mode only, keyed by its
display name) or `'language` (everywhere the language appears, keyed
by its tag, e.g. `"markdown"`); the key; a pattern — a bare
tree-sitter node type, which the engine wraps as `(node-type) @face`,
or a small query fragment; and a registered face name. The rule takes
effect immediately (open buffers re-highlight) and persists to
`faces.json` on its own. `remove-highlight-rule!` deletes one rule,
`clear-highlight-rules!` all of them;
`(highlight-rules-for 'mode "Markdown")` returns a scope's rules as data.

The missing ingredient is usually the node type, and the interactive
flows supply it: `C-h F` (cmd(describe-face-at-point)) names the face
and node type under the cursor, and the cmd(highlight-construct-at-point)
flow on `C-h C-f` runs the whole assignment — name or create a face,
pick the scope — through the minibuffer, calling `create-face!` and
`add-highlight-rule!` for you. Those walkthroughs are in
*Customization*; from Lisp you call the same two functions yourself.

All of this persists in one file. `faces.json` (in the config home,
next to `custom.lisp`) has three top-level keys, assembled by
`current-faces-file`: `:overrides` — the global, per-theme, and
per-mode attribute layers; `:userFaces` — every face created with
`create-face!`, which is why a face minted through the `C-h C-f` flow
survives a restart, re-registered at launch; and `:highlightRules` —
the rules above. Like `custom.lisp` it is machine-written; the Lisp
record of intent belongs in `init.lisp`.

### Themes as Lisp Data

A *theme* is registered by `define-theme`, an ordinary procedure in
`themes.lisp`:

```lisp
(define-theme 'dark
  "Mariana — the calm default dark scheme. The editor opens in this."
  (hash-map "--bg" "#2b333b" "--bg-chrome" "#262d34" …))
```

The map holds chrome CSS variables only — window background,
foreground, accent, selection, the terminal's ANSI palette. Token
colours deliberately live elsewhere, in the `defface` per-theme
defaults. The active theme is just the `*theme*` setting — a
`:choice` whose `:options` are `(registered-themes)`, seven as
shipped: `dark` (Mariana, the default), `bright`, `midnight`,
`solarized-light`, `solarized-dark`, `emacs`, and `nova` — and whose
`:on-change` calls the host's `apply-theme!`. So
`(custom-apply! '*theme* 'midnight)` switches live: the chrome
variables are rewritten and every face re-resolves under the new
theme, your overrides intact.

Can you author an eighth theme from Lisp? Yes — the machinery is
name-driven end to end. `themes.lisp`'s header calls it two local
edits, and they work equally from `init.lisp`: a `define-theme` for
the chrome, and a `:default-<yourtheme>` block on each face you want
to colour — every face you skip falls back to its `:default-dark`
block, so a partial palette is fine. Resolution builds the block key
from the theme's name, so no dispatch needs updating. One caveat for
`init.lisp` authors: the customize dropdown's options are snapshotted
when `themes.lisp` declares `*theme*` — at stdlib load, before
`init.lisp` runs — so a theme registered in `init.lisp` is adopted by
`(custom-apply! '*theme* 'mine)` but does not appear in the picker
until the theme is registered stdlib-side.

### A Setting That Takes Effect Live

The pieces compose into a working `init.lisp` fragment: a group, a
face that knows its place in each theme, and a setting whose hook
applies it on the spot.

```lisp
;; init.lisp — how loudly comments read.
(defgroup 'desk 'godot "Personal appearance switches for this machine.")

;; Blocks for the themes I actually use; any other theme falls back
;; to the :default-dark block (the rule from Declaring a Face).
(defface 'loud-comment from 'comment
  :doc "The palette comments take when *comment-loudness* is loud."
  :default-dark            (face :foreground "#e8a87c" :weight :bold)
  :default-bright          (face :foreground "#f9a872" :weight :bold)
  :default-midnight        (face :foreground "#ffcb6b" :weight :bold)
  :default-solarized-light (face :foreground "#b07d3c" :weight :bold))

(defcustom *comment-loudness* 'subtle :choice
  :group 'desk
  :options '(subtle loud)
  :on-change
  (lambda (name value)
    (if (eq? value 'loud)
        (set-face-attribute 'comment :foreground
                            (face-attribute 'loud-comment :foreground))
        (reset-face 'comment)))
  :doc "How loudly comments read: subtle keeps the theme's colour,
        loud copies loud-comment's colour over it.")
```

Evaluate the forms (`C-enter` on each, or restart) and try it at the
REPL:
`(custom-apply! '*comment-loudness* 'loud)` recolours every comment on
screen as the form returns — the hook's `set-face-attribute`
regenerates the face CSS at once — and
`(custom-reset! '*comment-loudness*)` puts the theme's colour back.
The UI roundtrip is the same machinery wearing widgets:
`(customize-group 'desk)` opens a buffer with a dropdown for the
setting, and choosing `loud` and pressing Apply recolours the comments
before your eyes. Save persists it to `custom.lisp` — though for an
init-declared setting, remember the corollary above and let
`init.lisp` itself state the value you want at startup.
