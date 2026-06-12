## Writing prose and Markdown

jmacs is as much a tool for writing as for code. Open a file ending in
`.md` and the editor enters `markdown-mode`, a major mode that turns the
familiar editing surface into a writing surface: a `C-c` prefix of
formatting commands, a menu of the same on the menu bar, a live HTML
preview, and — for technical prose — typeset mathematics rendered in
place. This chapter covers all of it. The commands emit *JMarkdown*, the
Markdown dialect used across this project (`*strong*`, `/emphasis/`,
`==highlight==`, `\cite{}`, footnotes), so what you write here flows
straight into the book pipeline.

Throughout, `C-` is Control or Command, `M-` is Option, and `S-` is
Shift.

### Markdown mode

A buffer enters `markdown-mode` automatically when its name ends in
`.md` — the major mode is chosen from the filename suffix, so no setup
is needed. The mode's defining feature is the `C-c` prefix: a key map
of writing commands that is active only in a Markdown buffer, so it can
claim short keys like `C-c b` without disturbing anything global. Every
command below is ordinary Lisp in `markdown.lisp`, so every one is
yours to rebind or redefine.

#### Inline formatting

These wrap the active region; with no region, they insert the markup
pair and leave the cursor between the delimiters, ready to type.

| Key | Command | Inserts |
|-----|---------|---------|
| `C-c b` | cmd(markdown-bold) | `*strong*` |
| `C-c i` | cmd(markdown-italic) | `/emphasis/` |
| `C-c c` | cmd(markdown-code) | `` `inline code` `` |
| `C-c h` | cmd(markdown-highlight) | `==highlight==` |

Note the JMarkdown convention: emphasis is slashes, not underscores or
single asterisks, and a single `*…*` is *strong*. This is deliberate —
it is the dialect the book is written in.

#### Links, citations, footnotes

| Key | Command | Action |
|-----|---------|--------|
| `C-c l` | cmd(markdown-insert-link) | Insert `[text](url)`, region as the text, cursor in the URL slot |
| `C-c k` | cmd(markdown-insert-cite) | Insert a JMarkdown `\cite{}`, cursor inside the braces |
| `C-c f` | cmd(markdown-insert-footnote) | Insert a JMarkdown footnote `[^: ]`, cursor in the body |

cmd(markdown-insert-link) is the most useful of the three when a region
is active: select the words that should become the link text, press
`C-c l`, and the cursor lands in the empty URL parentheses so you can
paste or type the address straight away.

#### Headings and blocks

These act on the current line, prepending the relevant Markdown marker
and leaving your cursor where it was relative to the text.

| Key | Command | Action |
|-----|---------|--------|
| `C-c 1` … `C-c 6` | cmd(markdown-heading-1) … cmd(markdown-heading-6) | Make the line a heading of that level (`#` … `######`) |
| `C-c q` | cmd(markdown-blockquote) | Make the line a blockquote (`> `) |
| `C-c -` | cmd(markdown-list-item) | Make the line a list item (`- `) |

Press a heading key a second time and you simply get a deeper marker —
the commands prepend rather than toggle, so `C-c 2` on a line already
beginning `# ` yields `## #`. Demote by editing, or undo with `C-z`.

#### The Markdown menu

Whenever a Markdown buffer is current, the menu bar carries a **Markdown**
menu listing these commands grouped into submenus — *Format*, *Insert*,
*Headings*, *Blocks*, and *Preview & Math* — each entry showing the key
that runs it. The menu is built by the host from a structured
registration in `markdown.lisp` (`register-mode-menu!`), so it stays in
step with the keymap: add a binding to the mode and it appears in the
menu with its key and docstring. The menu is the discoverable face of
the mode — a way to find a command you have not memorised the key for,
and a reminder of the key once you pick it.

### The Markdown preview

`C-c v` (`markdown-preview`) opens a live preview pane that renders
the current buffer to HTML through the JMarkdown pipeline and refreshes
as you edit. Press `C-c v` again to close it. The preview is the
fastest way to see how your prose will actually look — headings,
emphasis, links, and citations resolved — without leaving the editor.

The preview renders into an isolated iframe, so it can carry its own CSS
without touching, or being touched by, the editor's own styling. Two
variables control its appearance, both meant for your `init.lisp`:

- `*markdown-preview-css*` — a list of stylesheet paths the preview
  links. Point it at your book's stylesheet to preview prose in the
  finished typography:

  ```lisp
  (set! *markdown-preview-css* (list "~/book/style.css"))
  ```

  An absolute or `~` path is served as-is; a relative path resolves
  against the previewed file's own directory.

- `*markdown-preview-default-style*` — a `defcustom` (on by default)
  that links the built-in preview stylesheet. Turn it off when you want
  your own CSS to own the look completely.

### The math minor mode

Mathematical prose needs two distinct things, and jmacs gives them as
two independent minor modes that compose freely. The first, described
here, helps you *type* LaTeX symbols. The second, the next section,
*typesets* the math you have typed. Either can be on without the other.

`C-c m` (cmd(toggle-math-mode)) toggles `math-mode`, an AUCTeX-style
symbol-insertion minor mode. With it on, a backtick followed by a key
inserts the corresponding LaTeX symbol: `` ` `` then `a` gives
`\alpha`, `` ` `` then `8` gives `\infty`, `` ` `` then `>` gives
`\geq`. A backtick followed by an *unmapped* key inserts that key
literally — so `` ` `` `` ` `` types a single backtick. When `math-mode`
is active the modeline shows `Math` among the minor modes.

The mapping lives in the variable `*math-symbols*`, a plain map from a
key to a LaTeX string — `"a"` → `"\alpha"`, `"q"` → `"\theta"`,
`"+"` → `"\sum"`, and so on through the lowercase and uppercase Greek
letters and a selection of operators and relations. It is ordinary Lisp
state: edit or extend it to change the symbol set. cmd(math-insert-symbol)
is the command bound to `` ` `` that performs the lookup.

> LaTeX buffers have a richer, configurable cousin of this mode —
> `LaTeX-math-mode`, with a fuller table, a completion fallback for
> unknown keys, and a rebindable prefix. See the LaTeX chapter (AUCTeX
> and RefTeX). The two are separate modes that share the same muscle
> memory; the same letter keys map to the same Greek letters in both.

### Inline and display math preview

Typing `\alpha` is one thing; *seeing* it as α as you write is another.
The math **preview** mode does the latter. With it on, each math segment
in the buffer is shown typeset — by MathJax, rendered in place — instead
of as its LaTeX source. Move the cursor into a segment and it flips back
to editable source; move out and it re-typesets. The effect is a
document that reads as finished mathematics but edits as plain text.

In a Markdown buffer the toggle is `C-c C-p`
(`toggle-markdown-math-preview`). It is off by default; press
`C-c C-p` to turn it on for the current buffer, and again to turn it
off. It recognises the math delimiters common to prose — inline `$…$`
and `\(…\)`, display `$$…$$` and `\[…\]` — but *not* bare
`\begin…\end` environments, which are not display math in ordinary
writing. (LaTeX buffers, where they are, recognise them; that is the
major mode's choice, made on the host side.)

The granularity is the whole buffer: turning the mode on previews every
math segment, and the typeset/source flip happens automatically as the
cursor enters and leaves each one — there is no separate region or
single-segment command to learn. To have the preview on automatically
for every Markdown buffer, set the `defcustom`
`*markdown-math-preview-default*` to `#t` in your customisation.

Under the hood this is the same general engine LaTeX uses: a
mode-agnostic minor mode, `math-preview-mode`, whose general toggle is
`toggle-math-preview` (reachable as `M-x toggle-math-preview` in any
buffer whose major mode has a math provider). `C-c C-p` in Markdown is
the convenient per-mode wrapper around it. *Which* delimiters count is
decided by the buffer's major mode — Markdown uses the common set above;
LaTeX adds environments — so the same keystroke does the right thing in
each.

### Sticky notes

A Markdown buffer pairs naturally with *sticky notes* — small Markdown
panels pinned to a position in the text, their bodies typeset (math
included) by the same renderer. Notes are a general productivity feature,
not specific to Markdown mode, so they have their own treatment: see the
**Productivity** chapter for the `M-n` note commands, the metadata
header, and `*markdown-interpreter*`.
