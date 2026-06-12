## Productivity

Beyond moving the cursor and killing text, jmacs carries a handful of
power-user features that earn their keep when you are editing in
earnest: several cursors at once, template expansion with tab stops,
notes pinned to the text, and the ability to run a Lisp form and see its
value where you wrote it. Each is ordinary Lisp in the standard library,
so each is yours to rebind, redefine, or drive from a script. This
chapter describes them in turn.

Throughout, `C-` is Control or Command, `M-` is Option, and `S-` is
Shift.

### Multiple cursors

Multiple cursors let one keystroke edit several places at once — the
Sublime and VS Code idiom. You build a set of cursors over matching
text, then type, and every cursor types in lockstep.

There are two ways in. cmd(add-cursor-next), bound to `C-c d`, works
match by match. Place the cursor on a word and press `C-c d`: the word
becomes selected as the primary cursor. Press `C-c d` again and jmacs
finds the *next* occurrence of that word and adds a cursor selecting it.
Keep pressing to keep adding cursors, one occurrence at a time — each
press searches past the last cursor it placed, so a run of presses walks
forward through the document. With a region already active, the region's
text is what gets matched instead of the word at point.

cmd(select-all-matches), bound to `C-c D` (that is `C-c S-d`), does the
whole document in one stroke: it adds a cursor at *every* occurrence of
the current selection — or the word at point, if nothing is selected —
each one selecting its match.

With the set built, every cursor selects its match, so typing replaces
each one and editing proceeds in parallel. `ESC` (cmd(deselect)) drops
the selections to bare carets on every cursor without collapsing the set
— handy when you want to position within each match rather than replace
it, or to type a prefix. `C-g` (cmd(keyboard-quit)) collapses the set
back to the single primary cursor, ending the multi-cursor edit.

A worked example. Suppose a file mentions `widget` three times and you
want them all to read `gadget`:

```
the widget, that widget, every widget
```

Put the cursor on the first `widget`, then press `C-c D`. All three are
now selected, each with its own cursor. Type `gadget`, and all three
change together:

```
the gadget, that gadget, every gadget
```

Press `C-g` when you are done to return to one cursor. Had you wanted
only the first two, you would have used `C-c d` twice instead — once to
select the first `widget`, once more to add the second — and left the
third untouched.

### Snippets

A *snippet* is a short trigger that expands into a larger template, with
the cursor stepping through the blanks you need to fill. The engine is
yasnippet-compatible in its body syntax, so existing yasnippet
collections drop in.

**Expanding.** Type a trigger word and press `TAB`. If the word before
the cursor names a snippet for the current mode, it expands; otherwise
`TAB` does its ordinary job (cmd(insert-tab), two spaces). For instance,
in a JavaScript buffer, type `fn` and press `TAB` to get a function
skeleton:

```
function name(args) {

}
```

The cursor lands on the first field — `name`, selected — so you can type
the function's name straight away.

You can also insert a snippet by name with cmd(snippet-insert)
(`M-x snippet-insert`), which prompts in the minibuffer and completes
against the snippets available in the buffer's mode. cmd(snippet-list)
shows those triggers in the echo area, and cmd(snippet-expand) is the
plain expand-the-word-before-point command that `TAB` calls.

**Moving between fields.** Once a snippet is active, `TAB`
(cmd(snippet-next-field)) advances to the next field, selecting its
default text; `S-TAB` (cmd(snippet-prev-field)) steps back. On the last
field, `TAB` jumps to the snippet's exit point and commits. `ESC` or
`C-g` (cmd(snippet-cancel)) cancels: the inserted text stays, but field
navigation stops. The whole expansion is a single undo step, so one
`C-z` removes the body wholesale. The modeline shows `[snippet: 2/4]`
while you navigate, counting the current field against the total.

A field that appears more than once is a *mirror*: edit the field and
every occurrence updates live, because arriving at it installs a
multi-cursor set over the field and its mirrors. The `for` snippet uses
this — its loop variable `i` is one field mirrored three times:

```
for (let i = 0; i < n; i++) {

}
```

Type `row` into the first `i` and all three become `row` at once. (This
behaviour is governed by `*snippet-mirror-multi-cursor*`, on by default;
set it to `#f` to have mirrors render the default once and not track
edits.)

**The body syntax.** A snippet body is yasnippet field syntax:

| Form | Meaning |
|------|---------|
| `$N` | a tab stop, numbered `N` |
| `${N:default}` | a tab stop with default text |
| `$0` | the exit point — where the cursor lands on commit |
| `$$` | a literal dollar sign |

A repeated `$N` is a mirror of field `N`. The starter set's `try`
snippet shows both a field and its mirror: `${1:err}` names the error,
and `$1` echoes it into the handler body.

**Where snippets come from.** Three sources, in priority order:

1. The directories listed in `*snippet-directories*` (empty by default).
2. Your user snippet directory, always searched —
   `<user-data>/snippets/`.
3. A small built-in starter set, so the feature works before you write a
   single file.

A user file shadows a same-keyed built-in; among directories, an earlier
one wins a collision. Each source holds a `<mode>/` subdirectory per
major mode — `js-mode/`, `prog-mode/`, `fundamental-mode/`, and so on.
Lookup falls through a mode's parents: a programming mode falls through
to `prog-mode` and then `fundamental-mode`, so a snippet defined in
`fundamental-mode` is available everywhere. A `.yas-parents` file in a
mode directory overrides that chain.

A snippet file is yasnippet-style — header lines, a `# --` separator,
then the body:

```
# key: hello
# name: greeting
# --
Hello, ${1:name}! Welcome to ${2:place}.$0
```

The `key` is the trigger; absent, the filename is used. After dropping
files in, run cmd(snippet-reload) (`M-x snippet-reload`) to rescan the
directories and discard the cached store.

The built-in starter set includes, among others: `date`, `datetime` and
`copyright` (which fill in live dates) everywhere; `if`, `while`, `for`
and `shebang` in programming modes; and `fn`, `afn`, `try`, `imp` and
`log` in JavaScript. `M-x snippet-list` enumerates what the current
buffer can reach.

The expand key itself is configurable through `*snippet-expand-key*`
(default `"tab"`). Set it to `nil` to disable the `TAB` trigger
entirely, leaving snippets reachable only through `M-x snippet-expand`
and `M-x snippet-insert`.

### Sticky notes

A *sticky note* is a small resizable rectangle drawn on top of the text,
holding Markdown whose rendered HTML shows in the note. A note is
anchored to a position in the document and rides the text as it scrolls
and as you edit around it. Notes persist to a hidden companion sidecar
named `.<file>.godot-metadata` beside the document (the same per-file
metadata file that holds bookmarks), so they survive reopening.

The note commands live under the `M-n` prefix:

| Key | Command | Action |
|-----|---------|--------|
| `M-n n` | cmd(add-sticky-note) | Create a note at the cursor and open it for editing |
| `M-n e` | cmd(edit-sticky-note) | Edit the note nearest the cursor |
| `M-n d` | cmd(delete-sticky-note) | Delete the note nearest the cursor |
| `M-n f` | cmd(next-sticky-note) | Move to the next note (by anchor order) |
| `M-n b` | cmd(previous-sticky-note) | Move to the previous note |
| `M-n t` | cmd(toggle-sticky-notes) | Show or hide every note in the buffer |

The notes are fully scriptable too — the underlying primitives
(`note-create!`, `note-delete!`, and the rest) are ordinary Lisp
procedures.

**The body.** Double-click a note to edit it in place; the body turns
into a small text area. Type Markdown; on blur (`ESC` cancels), the note
re-renders. The renderer is set by `*markdown-interpreter*`, which
defaults to `"marked"` — the bundled marked.js (CommonMark plus GFM),
which needs no external program. Any other value is treated as a shell
command that reads Markdown on stdin and writes HTML on stdout, so you
can route notes through pandoc or JMarkdown instead:

```lisp
(custom-apply! '*markdown-interpreter* "pandoc -f markdown -t html")
```

Drag the title bar to move a note (it re-anchors to the line it lands
on); drag the corner grip to resize it.

**Collapsing.** The minimise button on a note's bar shrinks it to a
single draggable icon, so a busy buffer is not buried under note bodies.
Double-click the icon to expand the note again. The collapsed state is
saved with the note.

**The metadata header.** A note's source may begin with a YAML-style
header — a `---` line, `key: value` lines, and a closing `---` — that
sets properties of the note itself rather than appearing in the rendered
body. The first colon on each line separates key from value, so an
`rgba(…)` colour survives intact. The recognised keys:

| Key | Effect |
|-----|--------|
| `color` | The note's background (any CSS colour); the text colour is chosen automatically for contrast |
| `icon` | The Font Awesome glyph shown when the note is collapsed |
| `icon-size` | The collapsed icon's size in pixels (clamped to 12–256) |

The `icon` value is forgiving: a bare name (`star`), an `fa-`-prefixed
name (`fa-star`), an explicit style word (`regular star`), and trailing
utility classes (`star fa-spin`) all work. A value with no style word
defaults to the solid face. For example, a yellow note that collapses to
a large lightbulb:

```
---
color: #fff6c0
icon: regular lightbulb
icon-size: 40
---
Remember to **profile** before optimising.
```

**Mathematics.** A note body may contain TeX, which MathJax typesets
once it has loaded — so `$E = mc^2$` (or a display `$$…$$`) renders as
mathematics in the note, the same as in the document.

### Inline evaluation

Inline evaluation runs a single Lisp form from the buffer and shows its
value as a coloured pill beside the form — the CIDER idiom. The pill is
green for a value and red for an error; an error also surfaces in the
REPL with its full stack trace.

Two commands pick the form for you:

- cmd(eval-expression-before-point), bound to `C-x C-e`, evaluates the
  form whose closing bracket sits just before the cursor.
- cmd(eval-expression-at-point), bound to `C-RET`, evaluates the form
  *enclosing* the cursor.

So to evaluate a definition you have just typed, leave the cursor after
its closing paren and press `C-x C-e`; to evaluate the form your cursor
is sitting inside, press `C-RET`. For example, with the cursor anywhere
inside

```lisp
(+ (* 6 7) 1)
```

`C-RET` shows `43` in a green pill beside the closing bracket. Type a
form that errors instead, and the pill is red and the REPL carries the
trace.

cmd(show-eval-log) (`M-x show-eval-log`) opens the `*Eval log*` buffer, a
running record of recent inline evaluations — one entry per evaluation.
