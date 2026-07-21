Title: Godot Productivity Commands
Author: J. McKenzie Alexander
Date: 2026-06-11
---

## Productivity commands

This document describes Godot's productivity features — the editing
amplifiers that go beyond ordinary text manipulation: multiple cursors,
snippet expansion, sticky notes, and inline evaluation. The first two
are ordinary Lisp in the standard library
(`packages/stdlib/lisp/multi-cursor.lisp`, `snippets.lisp`,
`snippets-parser.lisp`, `snippets-keymap.lisp`), built on the buffer
primitives. Sticky notes and inline evaluation are commands defined by
the server itself: each sticky-note command sends one directive to the
window, whose sticky-note manager performs the whole operation, and the
inline-eval commands evaluate the form in the server's Lisp session and
push the result back as an overlay pill.

Entries follow the convention of `commands.md`: a *command* is a
procedure runnable by name with `M-x` and usually bound to a key. See
`index.md` for how to read an entry. Key bindings are given in the
manual's notation: `C-` is Control, `M-` is Command (the Meta of Emacs
custom), `A-` is Option, `S-` is Shift. The task-oriented walk-through
of these features is the manual's *Productivity* chapter.

---

### Multiple cursors

Defined in `multi-cursor.lisp`. Sublime/VSCode-style multiple cursors,
built on the buffer-layer primitives `add-selection!`,
`collapse-to-primary!`, `cursor-count` and `selections`. Each new cursor
is created with both ends set, so its match is selected — and once the
set exists, ordinary editing applies at *every* cursor: typing replaces
each selected match, deletion deletes at each caret, movement moves them
all in step.

Two ways out of a cursor set: cmd(keyboard-quit) (`C-g`) collapses it
back to the primary cursor, while cmd(deselect) (`escape`, documented in
`search-and-edit.md`) drops the selections to bare carets at every match
*without* collapsing the set — the move you want when the matches are
selected and you'd rather append to each than replace it.

:::function{name="add-cursor-next" path="reference/productivity/add-cursor-next.html"}
#### `add-cursor-next`
`(add-cursor-next)`

Add a cursor at the next match of the word at point (or the active
region's text). Bound to `C-c d` — Godot's analogue of Sublime and
VSCode's `Cmd+D`. On the first press with no region, the current word
becomes selected as the primary cursor; the next press adds a cursor at
the next match, and repeated presses keep adding cursors. Each press
searches from just past the last-added cursor's range, so a sequence of
presses walks the matches in order.
:::

:::function{name="select-all-matches" path="reference/productivity/select-all-matches.html"}
#### `select-all-matches`
`(select-all-matches)`

Add a cursor at every occurrence of the current selection (or the word
at point), each one selecting the match. Bound to `C-c D`. With no
region active, the word at point becomes the primary cursor's region
(point at the word's end, mark at its start), then a cursor is added
for every other match in document order.
:::

### Snippets

Defined in `snippets.lisp` (the engine) and `snippets-parser.lisp` (the
file-format reader); the key bindings live in `snippets-keymap.lisp`.
A snippet is a yasnippet-style template with tab stops (`$N`,
`${N:default}`, `$0` for the exit point, `$$` for a literal dollar) and
mirrors. While a snippet is active, `tab` walks the fields, `S-tab`
steps back, and `escape` or `C-g` cancels; the modeline shows the
progress as `[snippet: 2/4]`.

**Discovery.** Snippets are gathered per major mode from three sources,
highest priority first: the directories listed in
`*snippet-directories*`, the user's `~/.godot/snippets/<mode>/`
directory (the config home; `$GODOT_HOME` overrides its location), and
a built-in starter set. An earlier source shadows a later one on the
same trigger. A mode falls through to parent modes' snippets: a
`.yas-parents` file in the mode's directory (whitespace-separated mode
names) declares the parents explicitly; without one, `js-mode`,
`python-mode` and `lisp-mode` fall through to `prog-mode` then
`fundamental-mode`, and every other mode to `fundamental-mode`.

**File format.** A snippet file is yasnippet-style: `# key: value`
header lines (`# key:` sets the trigger, `# name:` the display name), a
`# --` separator, then the body in the field syntax above. A file with
no `# key:` header uses its filename as the trigger. The body may also
use three backtick tokens — `` `date` ``, `` `datetime` `` and
`` `year` `` — which expand to live values; full embedded-code
evaluation is deliberately not supported.

**The starter set.** Out of the box, every buffer (via
`fundamental-mode`) has `date`, `datetime`, `sig`, `todo`, `fixme`,
`copyright` and `link`; programming modes add `shebang`, `if`, `while`
and `for`; JavaScript buffers add `fn`, `afn`, `try`, `imp` and `log`.
A user snippet with the same trigger shadows the built-in.

**Mirrors.** A field number that appears more than once in a body makes
the extra occurrences *mirrors*. Arriving at such a field installs a
multi-cursor set over the field and its mirrors (see the multiple
cursors section above), so typing updates every occurrence live. Four
faces paint the machinery — `snippet-active-face` (the field the cursor
is on), `snippet-inactive-face` (fields not yet reached),
`snippet-mirror-face` and `snippet-exit-face` — all adjustable through
the face customization described in `help-and-config.md`.

**Soft commit.** Moving point outside the active snippet's extent
abandons it: the inserted text stays, but field navigation stops and
the field's selection (plus any mirror cursors) is dropped, so the next
keystroke inserts at point instead of replacing a stale field. This is
why a snippet "stops tabbing" after you click elsewhere — it committed.

:::function{name="snippet-tab" path="reference/productivity/snippet-tab.html"}
#### `snippet-tab`
`(snippet-tab)`

The snippet-aware `tab` key. Bound to `tab`. When a snippet is active,
advance to its next field; otherwise, if the word before point is a
known trigger and `*snippet-expand-key*` is `"tab"`, expand it;
otherwise fall through to cmd(insert-tab) (see `commands.md`). Defined
in `snippets-keymap.lisp`.
:::

:::function{name="snippet-shift-tab" path="reference/productivity/snippet-shift-tab.html"}
#### `snippet-shift-tab`
`(snippet-shift-tab)`

Step to the previous snippet field when a snippet is active. Bound to
`S-tab`. A no-op otherwise. Defined in `snippets-keymap.lisp`; delegates
to cmd(snippet-prev-field).
:::

:::function{name="snippet-expand" path="reference/productivity/snippet-expand.html"}
#### `snippet-expand`
`(snippet-expand)`

Expand the snippet whose trigger is the word before point, as a live
template. Reachable through cmd(snippet-tab) (the `tab` key) and via
`M-x`. Removes the trigger word and inserts the snippet's parsed body,
moving to the first field. Returns `#t` when a snippet was expanded, `#f`
otherwise.
:::

:::function{name="snippet-insert" path="reference/productivity/snippet-insert.html"}
#### `snippet-insert`
`(snippet-insert key)`

Pick a snippet by name from the current mode's set and insert it at
point, expanding it as a live template. `key` is read in the minibuffer
at the prompt `Snippet: `, with completion against the current mode's
trigger list (`snippet-keys-for-mode`). Run by name with `M-x` (no
default key binding).
:::

:::function{name="snippet-list" path="reference/productivity/snippet-list.html"}
#### `snippet-list`
`(snippet-list)`

Show the snippet triggers available in the current buffer's mode, in the
echo area — `Snippets (js-mode): afn  fn  imp …`, or `No snippets for
<mode>`. Run by name with `M-x` (no default key binding).
:::

:::function{name="snippet-reload" path="reference/productivity/snippet-reload.html"}
#### `snippet-reload`
`(snippet-reload)`

Rescan the snippet directories, discarding the cached store. Run by name
with `M-x` (no default key binding). Use after adding or editing snippet
files.
:::

:::function{name="snippet-next-field" path="reference/productivity/snippet-next-field.html"}
#### `snippet-next-field`
`(snippet-next-field)`

Advance to the next snippet field, selecting its text (and installing
mirror cursors when the field has mirrors). On the last field, jump to
the exit (`$0`) and commit the snippet. Reached through cmd(snippet-tab)
(`tab`) while a snippet is active; also runnable with `M-x`.
:::

:::function{name="snippet-prev-field" path="reference/productivity/snippet-prev-field.html"}
#### `snippet-prev-field`
`(snippet-prev-field)`

Move to the previous snippet field. Reached through cmd(snippet-shift-tab)
(`S-tab`) while a snippet is active; also runnable with `M-x`. Stops at
the first field; does not wrap or commit.
:::

:::function{name="snippet-cancel" path="reference/productivity/snippet-cancel.html"}
#### `snippet-cancel`
`(snippet-cancel)`

Cancel the active snippet. Reached through the snippet-aware wrappers on
`escape` (cmd(deselect)) and `C-g` (cmd(keyboard-quit)) — a single press
while a snippet is active cancels it first, before the key's usual job.
The inserted text stays; field navigation stops, any mirror cursors are
collapsed, and point is left at the exit.
:::

The remaining entries are the engine's settings — defcustoms in the
`snippets` customization group, adjustable live through the
customization UI (`help-and-config.md`) or `custom-apply!`.

:::function{name="*snippet-directories*" path="reference/productivity/*snippet-directories*.html"}
#### `*snippet-directories*`

Extra root directories searched for snippets, in priority order; each
holds a `<mode>/` subdirectory per major mode. `nil` (the default)
means only the user snippet directory (`~/.godot/snippets`), which is
always searched. Earlier directories win a trigger collision; the user
directory wins over the built-in starter set.
:::

:::function{name="*snippet-expand-key*" path="reference/productivity/*snippet-expand-key*.html"}
#### `*snippet-expand-key*`

The key that expands a trigger word. Default `"tab"`. Set to `nil` to
disable the `tab` trigger entirely — snippets stay reachable via
`M-x snippet-expand` and `M-x snippet-insert`, and `tab` still navigates
an already-active snippet.
:::

:::function{name="*snippet-mirror-multi-cursor*" path="reference/productivity/*snippet-mirror-multi-cursor*.html"}
#### `*snippet-mirror-multi-cursor*`

When `#t` (the default), arriving at a field that has mirrors installs
a multi-cursor set over the field and its mirrors, so typing updates
every occurrence live. When `#f`, mirrors render the field's default at
expansion but do not update as the field is edited.
:::

:::function{name="*snippet-mode-aliases*" path="reference/productivity/*snippet-mode-aliases*.html"}
#### `*snippet-mode-aliases*`

An alist normalising mode-directory names to a canonical snippet-store
name — by default `javascript-mode` and `typescript-mode` map to
`js-mode`, `emacs-lisp-mode` to `lisp-mode`, and `text-mode` to
`fundamental-mode` — so a Godot mode and an imported yasnippet
collection's directory resolve to the same snippet set. Names not in
the table are used unchanged.
:::

### Sticky notes

A *sticky note* is a resizable rectangle overlaid on the buffer,
holding Markdown source whose rendered HTML is shown in the note. The
renderer is chosen by the `*markdown-interpreter*` setting (below); the
default is the bundled marked.js library. Notes are anchored to a
character offset, so they ride the text as it scrolls and as it is
edited; on a file-visiting buffer they persist to the file's hidden
companion sidecar, `.NAME.godot-metadata` (a pre-rename visible
`NAME.jmacs-metadata` file is still read as a fallback and migrates on
the next write).

The notes themselves live window-side: each command here sends a single
directive to the window, whose sticky-note manager performs the whole
operation — create, find-at-point, delete, navigate, toggle. These
commands are the keyboard surface, bound under the `M-n` prefix. Notes
are also mouse-draggable and mouse-resizable in place.

:::function{name="add-sticky-note" path="reference/productivity/add-sticky-note.html"}
#### `add-sticky-note`
`(add-sticky-note)`

Create a sticky note at the cursor and open it for editing. Bound to
`M-n n`.
:::

:::function{name="edit-sticky-note" path="reference/productivity/edit-sticky-note.html"}
#### `edit-sticky-note`
`(edit-sticky-note)`

Edit the sticky note nearest the cursor. Bound to `M-n e`. Reports
`No sticky note near the cursor.` in the echo area when there is none.
:::

:::function{name="delete-sticky-note" path="reference/productivity/delete-sticky-note.html"}
#### `delete-sticky-note`
`(delete-sticky-note)`

Delete the sticky note nearest the cursor. Bound to `M-n d`. Reports
`No sticky note near the cursor.` in the echo area when there is none.
:::

:::function{name="next-sticky-note" aliases="previous-sticky-note" path="reference/productivity/next-sticky-note.html"}
#### `next-sticky-note` / `previous-sticky-note`
`(next-sticky-note)` / `(previous-sticky-note)`

Move the cursor to the next / previous sticky note in the buffer. Bound
to `M-n f` / `M-n b`.
:::

:::function{name="toggle-sticky-notes" path="reference/productivity/toggle-sticky-notes.html"}
#### `toggle-sticky-notes`
`(toggle-sticky-notes)`

Show or hide every sticky note in the buffer. Bound to `M-n t`.
:::

:::function{name="*markdown-interpreter*" path="reference/productivity/*markdown-interpreter*.html"}
#### `*markdown-interpreter*`

The Markdown renderer used for sticky notes (and the live docstring
pages of the documentation viewer). The default, `"marked"`, selects
the bundled marked.js library — CommonMark plus GFM, no external
programs. Any other string is treated as a shell command that reads
Markdown on stdin and prints HTML on stdout, for users who want
JMarkdown or pandoc features:

    (custom-apply! '*markdown-interpreter* "pandoc -f markdown -t html")

Change it through the customization UI (`help-and-config.md`) or
directly as above.
:::

### Inline evaluation

CIDER-style inline evaluation: a command evaluates a single Lisp form
from the current buffer and shows the result as a coloured pill next to
the form — green for a value, red for an error (the pill reads
`! <message>`; there is no separate stack trace). The form is evaluated
in the editor's one Lisp world — the same session your `init.lisp` and
`M-x` commands run in — so a `define` evaluated inline persists for the
rest of the session. Result labels longer than 200 characters are
truncated with an ellipsis. The pill fades out after a few seconds, and
disappears immediately if the buffer changes.

:::function{name="eval-expression-before-point" path="reference/productivity/eval-expression-before-point.html"}
#### `eval-expression-before-point`
`(eval-expression-before-point)`

Evaluate the Lisp form immediately before point — the form whose closing
bracket sits just before the cursor — and show the result beside it.
Bound to `C-x C-e`. Reports `eval: no form before point` in the echo
area when there is no form before the cursor.
:::

:::function{name="eval-expression-at-point" path="reference/productivity/eval-expression-at-point.html"}
#### `eval-expression-at-point`
`(eval-expression-at-point)`

Evaluate the Lisp form enclosing point and show the result beside its
closing bracket. Bound to `C-enter` (Control-Return). Reports
`eval: no form at point` in the echo area when the cursor is not within
a form.
:::
