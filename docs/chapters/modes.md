## Modes

A *mode* is a tagged behavioural configuration for a buffer. A buffer
has exactly one **major mode** — its primary character — and zero or
more **minor modes** — orthogonal, toggleable behaviours layered on
top. Major and minor modes are the same kind of value: a plain Lisp
map. You rarely set a mode by hand; the editor chooses the major mode
from the file's name and turns on the appropriate minor modes for you.
This chapter is about *using* modes — how one is chosen, how it is
shown, and how you switch and toggle them. Writing your own mode is the
subject of the Extending chapter.

### What a major mode gives you

The major mode is what makes a `.lisp` buffer feel like Lisp and a
`.tex` buffer feel like LaTeX. From it a buffer draws:

- a **display name** — what the modeline shows ("Lisp", "Markdown",
  "LaTeX");
- a **comment syntax** — the prefix `comment-line` inserts (`;; ` in
  Lisp, `% ` in LaTeX, `# ` in a Makefile);
- a **syntax-highlighting** hint — which highlighter or tree-sitter
  grammar colours the text;
- an optional **keymap** of mode-specific commands, consulted ahead of
  the global bindings; and
- a **mode menu** in the menu bar, built from that keymap.

The shipped major modes include `fundamental-mode` (the fallback, with
no special behaviour), `lisp-mode`, `markdown-mode`, `latex-mode` and
`makefile-mode`, alongside a large catalogue of tree-sitter language
modes — `javascript-mode`, `python-mode`, `html-mode`, `c-mode`,
`rust-mode`, `go-mode`, `ruby-mode`, and many more, each a drop-in file
that registers itself. A handful of modes exist only to label a
non-text view in the modeline — `shell-mode` for a shell, `gnuplot-mode`
for a Gnuplot notebook — because those buffers are shown through their
own view, not the editor's text view, and so carry no text keymap.

### How the major mode is chosen

The major mode is selected from the buffer's *name* by a registry that
maps filename suffixes to modes. Opening `notes.md` gives you
`markdown-mode` and `paper.jmd` gives `jmarkdown-mode`; `init.lisp`
gives `lisp-mode`; `thesis.tex` gives `latex-mode`; a file named
`Makefile` gives `makefile-mode`. A name that matches no registered
suffix gets `fundamental-mode`.

The choice is made automatically when a buffer first appears with no
mode — `choose-major-mode!` is run for you and the modeline updates to
match. Selection is by name only: there is no detection from a shebang
line or file contents. Once chosen, the mode sticks: renaming a buffer
or saving it under a new name does not re-run selection. To change a
buffer's mode after the fact, switch it explicitly —
`(switch-major-mode python-mode)` from the REPL.

### Reading the modeline

The major mode's name appears in the modeline, after the buffer name
and before the line/column readout:

```
notes.md   Markdown   Ln 12, Col 3
```

When a buffer has minor modes active, each one's name follows the major
mode's, so you can see the full stack at a glance:

```
notes.md   Markdown  Math   Ln 12, Col 3
```

A leading `●` marks an unsaved buffer, and a transient tag such as
`[snippet: 2/4]` can appear while you are stepping through a snippet. A
non-text view — an image, a shell, the customize buffer — shows just its
name and no mode, because it has no point and no major mode.

### Minor modes

Minor modes stack on top of the major mode. Each one is independent and
can be turned on or off without disturbing the others. Where they
overlap with existing keys, precedence is decided by an explicit
`:priority`: the active minor modes are consulted highest-priority
first, then the major mode's keymap, then the global keymap. The first
map that binds a key wins, so a minor mode can shadow a binding for the
buffers it is active in without affecting any other buffer.

Enabling or disabling a minor mode runs its setup and teardown hooks, so
toggling one is a complete operation — turning it off undoes what
turning it on set up.

Some minor modes are turned on automatically in every text buffer. The
bookmark minor mode is one such: it rides along in all text buffers so
that bookmarks track edits everywhere, and you never enable it by hand.
Others are opt-in and bound to a toggle command:

- cmd(toggle-math-mode) — in Markdown, the **Math** symbol-insertion
  minor mode (`C-c m`): with it on, a backtick followed by a letter
  inserts the corresponding LaTeX symbol. Covered in the Writing
  chapter.
- cmd(toggle-latex-math-mode) — the LaTeX equivalent, **LaTeXMath**,
  for `.tex` buffers. Covered in the LaTeX chapter.
- cmd(toggle-math-preview) — the **MathPreview** minor mode, which
  typesets math fragments inline.

Toggling is idempotent and per-buffer: a minor mode you enable in one
buffer stays off in the others until you enable it there too.

### The mode menu

Each major mode contributes a menu to the menu bar, titled with the
mode's name. The menu lists the mode's own commands — the ones its
keymap (and any active minor mode's keymap) binds — each shown with the
key sequence that runs it. The global commands are deliberately left
out; the mode menu is for what is specific to *this* buffer's mode. A
mode may present its commands as one flat list or as grouped submenus;
Markdown and LaTeX, for instance, group theirs into Format, Insert,
Headings and the like. The menu is the discoverable face of a mode: open
it to see what the current buffer can do and which keys do it.

### Modes are Lisp

A mode is not a built-in primitive; it is ordinary Lisp data — a map you
can inspect, copy and modify in the REPL like anything else. That is why
the editor ships dozens of language modes as small drop-in files, and
why you can change how a mode behaves without recompiling anything. The
registry that maps suffixes to modes, the keymaps each mode carries, the
priority that orders minor modes, the hooks that fire on enable and
disable — all of it is Lisp you can read and redefine live.

Defining your own major or minor mode — `define-mode`, registering a
filename suffix, adding hooks with `add-hook`, and registering a default
text minor mode — is covered under "writing a mode" in the Extending
chapter. The Markdown and Math modes are worked through in the Writing
chapter, and LaTeX mode in its own chapter; this chapter has stayed with
how modes are chosen, shown and switched while you work.
