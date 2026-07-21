## Writing prose and Markdown

Godot is as much a tool for writing as for code. Open a file ending in
`.md` and the editor enters `markdown-mode`, a major mode that turns the
familiar editing surface into a writing surface: a `C-c` prefix of
formatting commands, a menu of the same on the menu bar, a live HTML
preview, and — for technical prose — typeset mathematics rendered in
place. This chapter covers all of it. The commands emit *JMarkdown*, the
Markdown dialect used across this project (`*strong*`, `/emphasis/`,
`==highlight==`, `\cite{}`, footnotes), so what you write here flows
straight into the book pipeline. For `.jmd` files there is more still:
`jmarkdown-mode` layers a full authoring environment — a compile loop,
completing insertion, structural navigation, and a reference manager —
on top of what this chapter describes. See the **Authoring in
JMarkdown** chapter.

Throughout, `C-` is Control, `M-` is Command (the Meta of Emacs
custom), `A-` is Option, and `S-` is Shift. The *Keys and commands*
chapter has the full notation.

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
| `C-c l` | cmd(markdown-insert-link) | Insert `[text]()` — region as the text, cursor in the empty URL slot |
| `C-c k` | cmd(markdown-insert-cite) | Insert a JMarkdown `\cite{}`, cursor inside the braces |
| `C-c f` | cmd(markdown-insert-footnote) | Insert a JMarkdown footnote `[^: ]`, cursor in the label slot |

cmd(markdown-insert-link) is the most useful of the three when a region
is active: select the words that should become the link text, press
`C-c l`, and the cursor lands in the empty URL parentheses so you can
paste or type the address straight away. With no region it inserts
`[]()` and leaves the cursor between the brackets, in the text slot.

JMarkdown footnotes are inline — `[^label: body]` — and
cmd(markdown-insert-footnote) leaves the cursor before the colon, in
the label slot: type the label, step past the `: `, and write the body.
(A footnote can also go unlabelled; just step past the colon.)

#### Headings and blocks

These act on the current line, prepending the relevant Markdown marker
and leaving your cursor where it was relative to the text.

| Key | Command | Action |
|-----|---------|--------|
| `C-c 1` … `C-c 6` | cmd(markdown-heading-1) … cmd(markdown-heading-6) | Make the line a heading of that level (`#` … `######`) |
| `C-c q` | cmd(markdown-blockquote) | Make the line a blockquote (`> `) |
| `C-c -` | cmd(markdown-list-item) | Make the line a list item (`- `) |

The heading commands *prepend* a marker; they do not toggle or replace
one already there, so `C-c 2` on a line beginning `# ` yields `## # `.
To change a heading's level, delete the old marker — or undo with `C-z`
(cmd(undo)) — and apply the new one.

#### The Markdown menu

Whenever a Markdown buffer is current, the menu bar carries a
**Markdown** menu listing these commands grouped into submenus —
*Format*, *Insert*, *Headings*, *Blocks*, and *Preview & Math* — each
entry showing the key that runs it. The menu is built by the host from
a structured registration in `markdown.lisp` (`register-mode-menu!`).
The *list* of commands is fixed by that registration, but the key and
docstring shown for each entry are resolved live from the mode's
keymaps, so a rebinding shows up the next time you look. (A mode with
no structured registration gets the flat automatic menu instead —
every command its keymaps bind, in keymap order. So if you add a
command of your own to `markdown-mode-map` and want it in the grouped
menu, add it to the registration too.) The menu is the discoverable
face of the mode — a way to find a command you have not memorised the
key for, and a reminder of the key once you pick it.

### Prose editing beyond the mode

Markdown mode supplies the markup; the prose muscles are global, and
they matter more in a writing buffer than anywhere else. The full
treatment is in the *Basic editing* chapter — this table is the
writer's shortlist:

| Key | Command | Action |
|-----|---------|--------|
| `M-a` / `M-e` | cmd(backward-sentence) / cmd(forward-sentence) | Move by sentence |
| `M-k` | cmd(kill-sentence) | Kill to the end of the sentence |
| `M-{` / `M-}` | cmd(backward-paragraph) / cmd(forward-paragraph) | Move by paragraph |
| `M-h` | cmd(mark-paragraph) | Select the paragraph around point |
| `M-@` | cmd(mark-word) | Select the next word |
| `M-u` / `M-l` / `M-c` | cmd(upcase-word) / cmd(downcase-word) / cmd(capitalize-word) | Case the word (or region) |
| `M-t` | cmd(transpose-words) | Swap the words around point |
| `A-[` / `A-]` | cmd(insert-single-open-quote) / cmd(insert-single-close-quote) | Typographic single quotes ‘ ’ |
| `A-S-[` / `A-S-]` | cmd(insert-double-open-quote) / cmd(insert-double-close-quote) | Typographic double quotes “ ” |

(`M-{`, `M-}` and `M-@` are written `M-S-[`, `M-S-]` and `M-S-2` in the
keymap — shifted punctuation carries an explicit `S-`; see *Keys and
commands*.)

#### Filling

Hard-wrapped prose stays tidy two ways. `M-q` (cmd(fill-paragraph))
re-wraps the paragraph around point after the fact. `M-x
auto-fill-mode` (cmd(auto-fill-mode)) toggles wrap-as-you-type: with it
on, typing past the fill column breaks the line at the previous word
boundary and indents the continuation the way the major mode wants.
The column is the defcustom `*fill-column*` (default 70), set
interactively with `C-x f` (cmd(set-fill-column)). One wrinkle worth
knowing: the generic `M-q` is a separate code path with a fixed width
of 72 and does not read `*fill-column*` — the variable governs
auto-fill.

To have auto-fill on in every Markdown buffer, hook the mode from your
`init.lisp`:

```lisp
(add-hook markdown-mode
  (lambda () (enable-minor-mode auto-fill-minor-mode)))
```

`.jmd` buffers get a JMarkdown-aware `M-q` on top of this — one that
respects list items, blockquotes and `@begin`/`@end` environments — see
*Authoring in JMarkdown*.

### The Markdown preview

`C-c v` (cmd(markdown-preview)) opens a live preview pane beside the
text. The pane is an embedded browser pointed at a real `jmarkdown
watch` server, started as a subprocess on the buffer's file — the same
command-line pipeline the book build uses. The rendering, stylesheet
and MathJax all come from that server's output, so the preview *is* the
finished artifact: headings, emphasis, links and citations resolved, in
the typography the pipeline ships. Press `C-c v` again to close it,
which also stops the watch subprocess.

Three operational facts you will meet immediately:

- **The buffer must be saved to a file.** `jmarkdown watch` watches a
  file on disk, so an unsaved, path-less buffer has nothing to preview
  — the editor reports `markdown-preview: save the file first`.
- **The pane is pinned to the file it was opened on.** Switching
  buffers does not re-point it; toggle `C-c v` off and on in the other
  buffer to preview that one instead.
- **The pane header has two buttons.** *Pop out* moves the preview to
  its own window — the pane closes, the window takes over the watch,
  and live refresh and cursor sync keep working there. *Close* ends the
  preview and stops the watch process, same as `C-c v`.

#### Live refresh

Saving (`C-x C-s`) rebuilds and live-reloads the preview. But you do
not need to save: while the preview is open, edits to the previewed
buffer are pushed — after a typing pause — to a shadow copy the watch
server reads, so the render refreshes as you type while the real file
on disk stays untouched. The pause is the defcustom
`*markdown-preview-debounce-ms*` (default 400): lower feels more live
but rebuilds more often; higher is calmer. It is not one of the
hot-pushed settings — a customize edit reaches an already-open window
with the next theme or face refresh, or at relaunch.

#### Preview ⇄ source sync

The preview and the source track each other in both directions:

- **Forward, automatic.** With the defcustom
  `*markdown-preview-follow-cursor*` on (the default), the preview
  scrolls — silently — to the block under point as the cursor moves.
  Turn it off if you prefer a still preview you position yourself.
- **Forward, explicit.** `C-c C-v` (cmd(markdown-preview-sync))
  scrolls the preview to the cursor's location *and flashes the spot*,
  regardless of the follow-cursor setting. It is the "where am I?"
  key; a no-op when no preview is open.
- **Inverse.** Command-click a spot in the preview and the editor
  cursor jumps to the corresponding source line. This works whether or
  not follow-cursor is on.

One historical note: the variables `*markdown-preview-css*` and
`*markdown-preview-default-style*` belong to a retired in-app preview
component and are not read by this preview — the watch server's build
owns the CSS. Setting them has no effect.

### The math minor mode

Mathematical prose needs two distinct things, and Godot gives them as
two independent minor modes that compose freely. The first, described
here, helps you *type* LaTeX symbols. The second, the next section,
*typesets* the math you have typed. Either can be on without the other.

`C-c m` (cmd(toggle-math-mode)) toggles `math-mode`, an AUCTeX-style
symbol-insertion minor mode. With it on, a backtick followed by a key
inserts the corresponding LaTeX symbol: `` ` `` then `a` gives
`\alpha`, `` ` `` then `8` gives `\infty`, `` ` `` then `>` gives
`\geq`. A backtick followed by an *unmapped* key inserts that key
literally — so `` ` `` `` ` `` types a single backtick.

The mapping lives in the variable `*math-symbols*`, a plain map from a
key to a LaTeX string — `"a"` → `"\alpha"`, `"q"` → `"\theta"`,
`"+"` → `"\sum"`, and so on through the lowercase and uppercase Greek
letters and a selection of operators and relations. It is ordinary Lisp
state, and maps are immutable, so extend it by rebuilding — in
`init.lisp`:

```lisp
(set! *math-symbols* (assoc *math-symbols* "R" "\\mathbb{R}"))
```

adds `` ` `` `R` → `\mathbb{R}` to the table. cmd(math-insert-symbol)
is the command bound to `` ` `` that performs the lookup. Both commands
are ordinary commands, so `M-x toggle-math-mode` turns the mode on in
any buffer, Markdown or not.

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
(cmd(toggle-markdown-math-preview)). It is off by default; press
`C-c C-p` to turn it on for the current buffer, and again to turn it
off. It recognises everything MathJax typesets: inline `$…$` and
`\(…\)`, display `$$…$$` and `\[…\]`, and `\begin…\end` math
environments (`align`, `equation`, and friends). What is
Markdown-specific is the *masking*: a `$` inside a code span or fenced
code block is never read as math, and an escaped `\$` is just a dollar
sign.

The granularity is the whole buffer: turning the mode on previews every
math segment, and the typeset/source flip happens automatically as the
cursor enters and leaves each one — there is no separate region or
single-segment command to learn. To have the preview on automatically
for every Markdown buffer, hook the mode from `init.lisp`:

```lisp
(add-hook markdown-mode
  (lambda () (enable-minor-mode math-preview-mode)))
```

(The defcustom `*markdown-math-preview-default*` you may spot in the
customize UI records the same intent but is not yet wired to anything —
setting it currently has no effect. The hook is the working route.)

Under the hood this is the same general engine LaTeX uses: a
mode-agnostic minor mode, `math-preview-mode`, whose general toggle is
cmd(toggle-math-preview) (reachable as `M-x toggle-math-preview` in any
buffer whose major mode has a math provider). `C-c C-p` in Markdown is
the convenient per-mode wrapper around it. The *provider* — which text
to scan, what to mask — is chosen by the buffer's major mode, so the
same keystroke does the right thing in each; the Markdown and LaTeX
delimiter sets are currently identical, and the code masking above is
the Markdown difference. The LaTeX face of the mode is `C-c C-p`
(cmd(toggle-latex-math-preview)) — see *Writing LaTeX (AUCTeX)* in the
LaTeX chapter.

#### The live tooltip

Typeset math is no help mid-edit — the moment the cursor enters a
segment, the source is what you see. So while point is inside a math
construct, a small tooltip floats above it showing the live MathJax
render of what you are typing, refreshed on every keystroke. When the
body fails to parse mid-edit — as it constantly, harmlessly does — the
tooltip keeps the last valid render on screen with an error badge, and
recovers the moment the math typesets again. Leave the construct and
the tooltip vanishes as the segment re-typesets in place. The defcustom
`*math-tooltip-scale*` (default 1.5) sets how large the tooltip
renders, as a multiple of the base font size; it too is live — a
customize edit applies immediately.

### Sticky notes

A Markdown buffer pairs naturally with *sticky notes* — small Markdown
panels pinned to a position in the text, their bodies typeset (math
included) by the same renderer. Notes are a general productivity
feature, not specific to Markdown mode, so they have their own
treatment: see *Sticky notes* in the **Productivity** chapter for the
`M-n` note commands (`M-n n` — that is Cmd-n, n — creates a note at the
cursor), the metadata header, and `*markdown-interpreter*`.

### Command and key summary

Every `markdown-mode` binding, in one place. All live under the `C-c`
prefix; the prose and fill commands of the earlier tables are global.

| Key | Command |
|-----|---------|
| `C-c b` | cmd(markdown-bold) |
| `C-c i` | cmd(markdown-italic) |
| `C-c c` | cmd(markdown-code) |
| `C-c h` | cmd(markdown-highlight) |
| `C-c l` | cmd(markdown-insert-link) |
| `C-c k` | cmd(markdown-insert-cite) |
| `C-c f` | cmd(markdown-insert-footnote) |
| `C-c 1` … `C-c 6` | cmd(markdown-heading-1) … cmd(markdown-heading-6) |
| `C-c q` | cmd(markdown-blockquote) |
| `C-c -` | cmd(markdown-list-item) |
| `C-c v` | cmd(markdown-preview) |
| `C-c C-v` | cmd(markdown-preview-sync) |
| `C-c C-p` | cmd(toggle-markdown-math-preview) |
| `C-c m` | cmd(toggle-math-mode) |
