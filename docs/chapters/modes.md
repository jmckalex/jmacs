## Modes

A *mode* is a tagged behavioural configuration for a buffer. A buffer
has exactly one **major mode** — its primary character — and zero or
more **minor modes** — orthogonal, toggleable behaviours layered on
top. Major and minor modes are the same kind of value: a plain Lisp
map. You rarely set a mode by hand; the editor chooses the major mode
from the buffer's name and turns on the appropriate minor modes for
you. This chapter is about *using* modes — how one is chosen, how it is
shown, and how you switch and toggle them. Writing your own mode is the
subject of the Extending chapter.

### What a major mode gives you

The major mode is what makes a `.lisp` buffer feel like Lisp and a
`.tex` buffer feel like LaTeX. From it a buffer draws:

- a **display name** — what the modeline shows ("Lisp", "Markdown",
  "LaTeX");
- a **comment syntax** — the prefix cmd(comment-line) inserts (`;; ` in
  Lisp, `% ` in LaTeX, `# ` in a Makefile);
- a **syntax-highlighting** hint — which highlighter or tree-sitter
  grammar colours the text;
- an optional **keymap** of mode-specific commands, consulted ahead of
  the global bindings;
- a **mode menu** in the menu bar, built from that keymap; and
- **editing preferences** that override the global settings for this
  mode's buffers: `:indent-tabs?` and `:tab-width` beat
  `*indent-tabs-mode*` and `*tab-width*` (`makefile-mode` pins
  `:indent-tabs?` on, because a Makefile recipe must start with a real
  tab), `:fill-column` beats `*fill-column*`, a
  `:fill-indent-function` tells auto-fill how to indent continuation
  lines (`jmarkdown-mode` supplies one so wrapped list items stay
  aligned), and `:indent-guides #f` turns off the vertical indent-guide
  lines (the Markdown modes do — their three-space list indents don't
  sit on the tab-width grid; cmd(toggle-indent-guides) overrides per
  buffer).

The shipped major modes include `fundamental-mode` (the fallback, with
no special behaviour), `lisp-mode`, `markdown-mode`, `jmarkdown-mode`
(the `.jmd` dialect, with a chapter of its own), `latex-mode` and
`makefile-mode`, alongside a large catalogue of tree-sitter language
modes — `javascript-mode`, `python-mode`, `html-mode`, `c-mode`,
`rust-mode`, `go-mode`, `ruby-mode`, and many more, each a drop-in file
that registers itself. A non-text view — a shell, an image, the
customize buffer — has no major mode at all: it is shown through its
own view rather than the editor's text view, and its modeline names the
view's *kind* instead (see below).

### How the major mode is chosen

The major mode is selected from the buffer's *name* by a registry —
`*mode-registry*` — that maps filename suffixes to modes. Opening
`notes.md` gives you `markdown-mode` and `paper.jmd` gives
`jmarkdown-mode`; `init.lisp` gives `lisp-mode`; `thesis.tex` gives
`latex-mode`. Matching is a plain string-suffix test, not an extension
parse, which is how a file named `Makefile` — no dot, no extension —
gets `makefile-mode`: the whole name is the registered suffix. A name
that matches no registered suffix gets `fundamental-mode`. Selection is
by name only: there is no detection from a shebang line or file
contents.

The choice is not a one-off. `choose-major-mode!` runs when a buffer
first appears, and again every time the buffer comes back into focus —
on a buffer switch, a tab click, a window change, a session restore —
re-deriving the mode from the name each time. The mode is a pure
function of the buffer's name, freshly computed rather than stored.
Two consequences follow. First, saving a buffer under a new name *does*
take effect: the next selection sees the new name and picks the new
mode. Second, an explicit `(switch-major-mode python-mode)` from the
REPL works, but only until the next re-derivation quietly puts the
registered mode back — useful for a quick experiment, wrong for
anything durable.

The durable way to change which mode a name gets is to change the
registry, with `register-mode` in your `init.lisp`:

```lisp
(register-mode ".md" jmarkdown-mode)
```

Newer registrations shadow older ones — `register-mode` adds to the
front of the registry, and lookup takes the first match — so a line
like this re-claims `.md` from `markdown-mode` without touching
anything. The same call registers a brand-new suffix
(`(register-mode ".notes" markdown-mode)`) just as happily. The core
registers only a handful of suffixes; each language mode registers its
own from its drop-in file. The Customization chapter covers
`init.lisp` itself.

### Reading the modeline

The modeline leads with a one-glyph save state, then the buffer name,
the cursor position, and the major mode's name last, in parentheses:

```
–  notes.md   L12:C3  (Markdown)
```

The leading glyph is always present: `●` means unsaved changes, `–`
means the buffer is clean. `L12:C3` is the cursor's line and column
(lines count from one, columns from zero).
The parenthesised name is the major mode's display name — the quickest
way to confirm which mode you are actually in.

Minor modes do not appear in the modeline; it shows the major mode
only. To see the full stack, ask the REPL — `(minor-modes)` lists the
active minor modes of the current buffer.

A non-text view fills the same slots with what it has: no cursor
position, and the view's kind in place of a mode name. A shell shows
`–  *shell*   (shell)`; an image shows its filename and `(image)`. The
dash is the clean-flag — a view with no text buffer has nothing to be
unsaved.

### Minor modes

Minor modes stack on top of the major mode. Each one is independent and
can be turned on or off without disturbing the others. Where they
overlap with existing keys, precedence is decided by an explicit
`:priority` (default 0): the active minor modes are consulted
highest-priority first, then the major mode's keymap, then the global
keymap. The first map that binds a key wins, so a minor mode can shadow
a binding for the buffers it is active in without affecting any other
buffer. The shipped minor modes keep to a small scale — Math and
LaTeXMath carry priority 10, MathPreview and Bookmark 5. When you want
to know which map is actually claiming a key, `C-h k`
(cmd(describe-key)) resolves through the same minor → major → global
chain and reports what the key runs *here*.

Enabling or disabling a minor mode runs its setup and teardown hooks, so
toggling one is a complete operation — turning it off undoes what
turning it on set up.

Some minor modes are turned on automatically in every text buffer. The
bookmark minor mode is one such: it rides along in all text buffers so
that bookmarks track edits everywhere, and you never enable it by hand.
Others are opt-in and bound to a toggle command:

- cmd(auto-fill-mode) — the **Fill** wrap-as-you-type minor mode: with
  it on, typing past the fill column breaks the line at a word boundary
  and indents the continuation. Off by default; the column is
  `*fill-column*` (default 70, set interactively with `C-x f`). Covered
  in the Writing chapter.
- cmd(toggle-math-mode) — in Markdown, the **Math** symbol-insertion
  minor mode (`C-c m`): with it on, a backtick followed by a letter
  inserts the corresponding LaTeX symbol. Covered in the Writing
  chapter.
- cmd(toggle-latex-math-mode) — the LaTeX equivalent, **LaTeXMath**,
  for `.tex` buffers (`C-c ~`). Covered in the LaTeX chapter.
- cmd(toggle-math-preview) — the **MathPreview** minor mode, which
  typesets math fragments inline.

Toggling is idempotent and per-buffer: a minor mode you enable in one
buffer stays off in the others until you enable it there too. To have
one on everywhere a major mode is, hook the major mode from
`init.lisp`:

```lisp
(add-hook markdown-mode
          (lambda () (enable-minor-mode auto-fill-minor-mode)))
```

### The mode menu

Each major mode contributes a menu to the menu bar, titled with the
mode's name. The menu lists the mode's own commands — the ones its
keymap (and any active minor mode's keymap) binds — each shown with the
key sequence that runs it, in the notation the Keys chapter lays out.
The global commands are deliberately left out; the mode menu is for
what is specific to *this* buffer's mode. A mode may present its
commands as one flat list or as grouped submenus; Markdown and LaTeX,
for instance, group theirs into Format, Insert, Headings and the like.
A grouped menu ends with an **Other** submenu that collects any bound
command the groups did not place, so nothing a mode binds is ever
invisible. The menu is the discoverable face of a mode: open it to see
what the current buffer can do and which keys do it.

### Modes are Lisp

A mode is not a built-in primitive; it is ordinary Lisp data — a map you
can inspect, copy and modify in the REPL like anything else. That is why
the editor ships dozens of language modes as small drop-in files, and
why you can change how a mode behaves without recompiling anything. The
registry that maps suffixes to modes (`*mode-registry*`), the keymaps
each mode carries, the priority that orders minor modes, the hooks that
fire on enable and disable — all of it is Lisp you can read and
redefine live, most of it in one file: `packages/stdlib/lisp/modes.lisp`
in the source tree, with the full contract in `docs/spec/modes.md`.

Defining your own major or minor mode — `define-mode`, registering a
filename suffix, adding hooks with `add-hook`, and registering a default
text minor mode — is covered under "writing a mode" in the Extending
chapter. The Markdown and Math modes are worked through in the Writing
chapter, and LaTeX mode in its own chapter; this chapter has stayed with
how modes are chosen, shown and switched while you work.
