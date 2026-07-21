Title: Godot JMarkdown Authoring Commands
Author: J. McKenzie Alexander
Date: 2026-07-21
---

## JMarkdown authoring commands

This document describes the commands `jmarkdown-mode` adds for
authoring JMarkdown (`.jmd`) documents — the AUCTeX-style compile/view
loop over the `jmarkdown` CLI, completing and templated insertion of
the dialect's environments and directives, structural navigation, and
the RefTeX-style layer for labels, cross-references, citations and the
index — and closes with the *settings* (`defcustom` variables) that
govern them. They are ordinary Lisp, defined across
`packages/stdlib/lisp/jmarkdown-compile.lisp`, `jmarkdown-insert.lisp`,
`jmarkdown-nav.lisp` and `jmarkdown-ref.lisp`, with the mode map, menu
and fill in `languages/jmarkdown.lisp` — all built on the buffer
primitives, `run-process!`, the citation bridge and the completing
minibuffer. The stack deliberately mirrors the LaTeX/RefTeX commands
(same keys, same shapes, retargeted at JMarkdown syntax) — see
`latex.md`. The JMarkdown chapter of the manual covers the same ground
as a workflow; this file is the per-command reference.

Almost every binding lives under the `C-c` prefix of
`jmarkdown-mode-map`, so these commands are active only in a JMarkdown
buffer; that mode keymap shadows the global keymap there. A few
commands bind a top-level key (`M-RET`, `M-q`, `TAB`, `S-TAB`).
Commands without a binding are reachable by name with `M-x` and from
the structured JMarkdown menu (registered in `languages/jmarkdown.lisp`).
The mode also binds the shared Markdown commands — `markdown-bold`
(`C-c b`), `markdown-insert-link` (`C-c l`), `markdown-preview`
(`C-c v`), cmd(toggle-math-mode) (`C-c m`) and friends — which are
documented in `commands.md`; this file covers only the
JMarkdown-specific family. See `index.md` for how to read an entry.

Key bindings are given in the manual's notation: `C-` is Control,
`M-` is Command (the Cmd key), `A-` is Option, `S-` is Shift. `M-RET`
is Command+Return — the renderer's name for the key is `M-enter`. The
literal backtick key is written `` ` ``.

---

### Compiling and viewing

Defined in `jmarkdown-compile.lisp` — AUCTeX's `TeX-command-master`
loop, for JMarkdown. The build runs `*jmarkdown-command*` (a token
list; default `jmarkdown process`) in the source file's directory via
`run-process!`; the whole log lands in a *JMarkdown output* tab and the
parsed diagnostics in a *JMarkdown errors* tab in the utility dock.
JMarkdown signals failure by a non-zero exit code; non-fatal warnings
(unresolved `:ref`s, duplicate labels, orphan index marks) arrive as an
end-of-run stderr summary. A log line of the shape `path:line: message`
becomes a jumpable diagnostic; other lines mentioning warning / error /
unresolved / duplicate become message-only ones. Unlike LaTeX there is
no master-file ladder: the file built is always the current view's own
file. The live watch-preview pane (`markdown-preview`, `C-c v`) is the
separate rendered-HTML view; this loop is the one-shot export + PDF.

:::function{name="jmarkdown-compile" path="reference/jmarkdown/jmarkdown-compile.html"}
#### `jmarkdown-compile`
`(jmarkdown-compile)`

Save the buffer and build the JMarkdown document, routing the log into
the *JMarkdown output* dock tab and the parsed diagnostics into
*JMarkdown errors*, then echoing a one-line summary (built /
warnings / FAILED). The format is `*jmarkdown-compile-format*`
(default `html`); with a prefix argument (`C-u C-c C-c`) a minibuffer
prompt chooses html / latex / pdf for that one build (an unrecognised
answer falls back to html). HTML and LaTeX are one CLI call each
(`--to latex` added for LaTeX); PDF builds HTML first and then prints
it with headless Chrome (`*jmarkdown-chrome*`) — the HTML step's
warnings are merged into the log so Chrome's near-empty output does
not hide them. On a clean build an already-open PDF artifact is
reloaded in place. When the `jmarkdown` program cannot be spawned the
status line says so — under a Finder-launched app it may simply not
be on `PATH` (see `*jmarkdown-command*`). Bound to `C-c C-c`. See
also cmd(jmarkdown-view-output) and cmd(jmarkdown-next-error).
:::

:::function{name="jmarkdown-compile-html" path="reference/jmarkdown/jmarkdown-compile-html.html"}
#### `jmarkdown-compile-html`
`(jmarkdown-compile-html)`

Build the current document to HTML, regardless of
`*jmarkdown-compile-format*` — cmd(jmarkdown-compile) with the format
pinned. Unbound by default — run it with `M-x` or from the JMarkdown
menu's *Compile & View* group.
:::

:::function{name="jmarkdown-compile-latex" path="reference/jmarkdown/jmarkdown-compile-latex.html"}
#### `jmarkdown-compile-latex`
`(jmarkdown-compile-latex)`

Build the current document to LaTeX (`jmarkdown process --to latex`),
producing a `.tex` beside the source. Unbound by default — `M-x` or
the JMarkdown menu.
:::

:::function{name="jmarkdown-compile-pdf" path="reference/jmarkdown/jmarkdown-compile-pdf.html"}
#### `jmarkdown-compile-pdf`
`(jmarkdown-compile-pdf)`

Build the current document to PDF: build the HTML, then print it with
headless Chrome (`*jmarkdown-chrome*`, flags `--headless
--print-to-pdf --no-pdf-header-footer`) — the zero-dependency PDF
route. When Chrome is not found the status line says which setting to
fix, and the HTML is still produced. Unbound by default — `M-x` or the
JMarkdown menu.
:::

:::function{name="jmarkdown-view-output" path="reference/jmarkdown/jmarkdown-view-output.html"}
#### `jmarkdown-view-output`
`(jmarkdown-view-output)`

Open the built artifact for the current file beside the source (a
horizontal split), or reload it if already open (in-place reload
exists only for PDFs — HTML/TeX are text views). The artifact matches
the last successful build's format, or `*jmarkdown-compile-format*`
when nothing has been built this session; a missing artifact gets a
"build with C-c C-c" status instead. Whether the opened view persists
across a relaunch is `*jmarkdown-view-restore*`. Bound to `C-c C-o`.
:::

:::function{name="jmarkdown-next-error" path="reference/jmarkdown/jmarkdown-next-error.html"}
#### `jmarkdown-next-error`
`(jmarkdown-next-error)`

Visit the next JMarkdown diagnostic from the last build: echo its
message, and when it carries a `file:line` location, open the file
(resolved against the current document's directory) and jump to the
line. Clamps at the end with a "no more diagnostics" message. Run
cmd(jmarkdown-compile) first to populate the list. Bound to
`` C-c ` ``. See also cmd(jmarkdown-previous-error).
:::

:::function{name="jmarkdown-previous-error" path="reference/jmarkdown/jmarkdown-previous-error.html"}
#### `jmarkdown-previous-error`
`(jmarkdown-previous-error)`

Visit the previous JMarkdown diagnostic from the last build, the
companion to cmd(jmarkdown-next-error). Clamps at the first. Unbound
by default — `M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-show-output" path="reference/jmarkdown/jmarkdown-show-output.html"}
#### `jmarkdown-show-output`
`(jmarkdown-show-output)`

Bring the *JMarkdown output* dock tab forward with the last build's
full log, if any. A convenience for inspecting raw CLI output. Bound
to `C-c C-w`.
:::

:::function{name="toggle-jmarkdown-math-preview" path="reference/jmarkdown/toggle-jmarkdown-math-preview.html"}
#### `toggle-jmarkdown-math-preview`
`(toggle-jmarkdown-math-preview)`

Toggle live inline MathJax typesetting for the current JMarkdown
buffer: math segments render typeset in place of their source and flip
back to source for editing when point enters them. An alias of the
general `math-preview-mode`, scanning with the JMarkdown provider.
Bound to `C-c C-p`, and in the `C-c C-t` toggle sub-map as
`C-c C-t x`. Off by default; `*jmarkdown-math-preview-default*`
records the intended default.
:::

### Completing inserts

Defined in `jmarkdown-insert.lisp` — the completing minibuffer pickers,
a faithful port of the `latex-insert.lisp` machinery (TAB
hook-chaining, cursor-sentinel templates, region capture) retargeted at
JMarkdown syntax. With a region active the pickers wrap it as the
body/title; with none they insert a template with point at the natural
editing spot.

:::function{name="jmarkdown-environment" path="reference/jmarkdown/jmarkdown-environment.html"}
#### `jmarkdown-environment`
`(jmarkdown-environment)`

Insert an `@begin(NAME) … @end(NAME)` environment chosen in the
minibuffer with TAB completion over `*jmarkdown-environments*` merged
with the `@begin(…)` names already used in the buffer. The body is
templated per kind: floats (figure / subfigure / table / listing) get
`[caption]{id=fig:}`-style openers with point in the caption and a
kind stub body (an image link, a table skeleton, an empty fence;
subfigure adds `width=0.45`); the theorem family and `equation` get
`{id=thm:}` / `{id=eq:}` with point on the body line (an equation body
is raw math — no `$$`); `game` gets a 2×2 strategic-form matrix
skeleton; everything else a plain body. An active region is wrapped as
the body, the opener still carrying its `{id=…}` for numbered kinds.
The completing counterpart to the quick cmd(jmarkdown-insert-environment)
(`C-c @`). Bound to `C-c C-e`.
:::

:::function{name="jmarkdown-directive" path="reference/jmarkdown/jmarkdown-directive.html"}
#### `jmarkdown-directive`
`(jmarkdown-directive)`

Insert a `:::NAME` … `:::` container directive chosen in the
minibuffer with TAB completion over `*jmarkdown-directives*` merged
with the directive names already used in the buffer. An active region
becomes the body; otherwise point lands on the empty body line. The
completing counterpart to the quick cmd(jmarkdown-insert-directive)
(`C-c d`). Bound to `C-c C-m`.
:::

:::function{name="jmarkdown-insert-section" path="reference/jmarkdown/jmarkdown-insert-section.html"}
#### `jmarkdown-insert-section`
`(jmarkdown-insert-section)`

Insert an ATX heading, choosing the level (1–6) in the minibuffer
(default 2; an empty answer means 2). The `#`-run and a space are
inserted at point; an active region becomes the title, otherwise point
lands after the `#`s to type it. Bound to `C-c C-s`. The fixed-level
`markdown-heading-1` … `markdown-heading-6` wraps remain on
`C-c 1` … `C-c 6`.
:::

### Templated inserts

The one-shot inserts: the quick block/inline commands from
`languages/jmarkdown.lisp` (bound under `C-c`), then the templated
constructs from `jmarkdown-insert.lisp` (mostly unbound — reachable
with `M-x` and from the JMarkdown menu's *Insert*, *Insert Block*,
*References* and *Advanced* groups). The quick block commands wrap an
active selection as the body; the dialect's emphasis wraps
(cmd(jmarkdown-intense), cmd(jmarkdown-underline)) also sit in the
AUCTeX-style `C-c C-f` font sub-map, where the plain letter and its
control form select the same command (`C-c C-f e` and `C-c C-f C-e`
are both intense; b/i/h/c in that sub-map are the shared
`markdown-bold` / `markdown-italic` / `markdown-highlight` /
`markdown-code`).

:::function{name="jmarkdown-insert-environment" path="reference/jmarkdown/jmarkdown-insert-environment.html"}
#### `jmarkdown-insert-environment`
`(jmarkdown-insert-environment)`

Insert an `@begin()`/`@end()` pair around the selection with a cursor
inside *both* parens — a multi-cursor set mirrors typed input, so the
name is typed once and lands in the `@begin(…)` and `@end(…)`
together; `ESC` (or `C-g`) collapses back to a single cursor. The
quick, type-the-name-yourself form; the completing, templating form is
cmd(jmarkdown-environment) (`C-c C-e`). Bound to `C-c @`.
:::

:::function{name="jmarkdown-insert-directive" path="reference/jmarkdown/jmarkdown-insert-directive.html"}
#### `jmarkdown-insert-directive`
`(jmarkdown-insert-directive)`

Insert a `:::` … `:::` directive block around the selection; with no
selection, point is left right after the opening `:::` to type the
directive name. The quick form of cmd(jmarkdown-directive)
(`C-c C-m`). Bound to `C-c d`.
:::

:::function{name="jmarkdown-insert-tikz" path="reference/jmarkdown/jmarkdown-insert-tikz.html"}
#### `jmarkdown-insert-tikz`
`(jmarkdown-insert-tikz)`

Insert a `:::TiKZ` block around the selection, with point on the
(LaTeX) body line. Bound to `C-c t`.
:::

:::function{name="jmarkdown-insert-mermaid" path="reference/jmarkdown/jmarkdown-insert-mermaid.html"}
#### `jmarkdown-insert-mermaid`
`(jmarkdown-insert-mermaid)`

Insert a `:::mermaid` block around the selection, with point on the
diagram body line. Bound to `C-c g`.
:::

:::function{name="jmarkdown-insert-ref" path="reference/jmarkdown/jmarkdown-insert-ref.html"}
#### `jmarkdown-insert-ref`
`(jmarkdown-insert-ref)`

Insert a bare `:ref[]` cross-reference with point between the
brackets, ready for a key. The know-the-key fast path; the completing,
form-choosing flow is cmd(jmarkdown-reference) (`C-c )`). Bound to
`C-c r`.
:::

:::function{name="jmarkdown-insert-label" path="reference/jmarkdown/jmarkdown-insert-label.html"}
#### `jmarkdown-insert-label`
`(jmarkdown-insert-label)`

Insert a bare `:label[]` anchor with point between the brackets. The
type-it-yourself form; cmd(jmarkdown-label) (`C-c (`) suggests and
uniquifies a key for you. Bound to `C-c a`.
:::

:::function{name="jmarkdown-intense" path="reference/jmarkdown/jmarkdown-intense.html"}
#### `jmarkdown-intense`
`(jmarkdown-intense)`

Wrap the selection in `**…**` — JMarkdown's *intense* (bold italic;
in this dialect single `*` is bold and `/…/` italic). Bound to
`C-c e` and `C-c C-f e`.
:::

:::function{name="jmarkdown-underline" path="reference/jmarkdown/jmarkdown-underline.html"}
#### `jmarkdown-underline`
`(jmarkdown-underline)`

Wrap the selection in `__…__` (underline). Bound to `C-c u` and
`C-c C-f u`.
:::

:::function{name="jmarkdown-insert-table" path="reference/jmarkdown/jmarkdown-insert-table.html"}
#### `jmarkdown-insert-table`
`(jmarkdown-insert-table)`

Insert a GFM table skeleton, prompting for its size as `ROWSxCOLS`
(default `2x2`; `3X2` parses too). The skeleton is a header row, a
`---` separator row, and ROWS empty body rows; point lands in the
first header cell. Unbound — `M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-figure" path="reference/jmarkdown/jmarkdown-insert-figure.html"}
#### `jmarkdown-insert-figure`
`(jmarkdown-insert-figure)`

Insert an `@begin(figure)[caption]{id=fig:}` float with point in the
caption and an image-link stub body; an active region becomes the body
instead. A fixed-name shortcut through cmd(jmarkdown-environment)'s
template. Unbound — `M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-table-float" path="reference/jmarkdown/jmarkdown-insert-table-float.html"}
#### `jmarkdown-insert-table-float`
`(jmarkdown-insert-table-float)`

Insert an `@begin(table)[caption]{id=tab:}` float wrapping a table
skeleton (or the active region) — the *numbered, captioned* table, as
opposed to cmd(jmarkdown-insert-table)'s bare grid. Unbound — `M-x` or
the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-listing" path="reference/jmarkdown/jmarkdown-insert-listing.html"}
#### `jmarkdown-insert-listing`
`(jmarkdown-insert-listing)`

Insert an `@begin(listing)[caption]{id=lst:}` float wrapping an empty
code fence (or the active region) — the numbered, captioned code
block. Unbound — `M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-code-block" path="reference/jmarkdown/jmarkdown-insert-code-block.html"}
#### `jmarkdown-insert-code-block`
`(jmarkdown-insert-code-block)`

Insert a fenced code block, choosing the language hint in the
minibuffer with TAB completion over `*jmarkdown-code-languages*` (any
highlight.js language name works; an empty answer gives a bare fence).
Point lands on the empty code line. Unbound — `M-x` or the JMarkdown
menu.
:::

:::function{name="jmarkdown-insert-math" path="reference/jmarkdown/jmarkdown-insert-math.html"}
#### `jmarkdown-insert-math`
`(jmarkdown-insert-math)`

Insert math, choosing the kind in the minibuffer: `inline` (the
default) → `$…$` with point between the dollars; `display` → a `$$`
block with point on the body line; `equation` → a numbered
`@begin(equation){id=eq:}` environment. Unbound — `M-x` or the
JMarkdown menu.
:::

:::function{name="jmarkdown-insert-alert" path="reference/jmarkdown/jmarkdown-insert-alert.html"}
#### `jmarkdown-insert-alert`
`(jmarkdown-insert-alert)`

Insert a GitHub-style alert blockquote (`> [!TYPE]` with a `> ` body
line, point on it), choosing the type in the minibuffer over
`*jmarkdown-alert-types*` (the five GitHub types plus JMarkdown's
QUESTION and SUGGESTION; default NOTE). Unbound — `M-x` or the
JMarkdown menu.
:::

:::function{name="jmarkdown-insert-game" path="reference/jmarkdown/jmarkdown-insert-game.html"}
#### `jmarkdown-insert-game`
`(jmarkdown-insert-game)`

Insert a strategic-form `@begin(game)` matrix skeleton — a 2×2 game
with `L`/`R` columns, `T`/`B` rows and `(1,1)`-style payoff cells,
point before the first column label. An active region becomes the body
instead. Unbound — `M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-description-item" path="reference/jmarkdown/jmarkdown-insert-description-item.html"}
#### `jmarkdown-insert-description-item`
`(jmarkdown-insert-description-item)`

Insert a description-list item `term:: description` — the `:: `
separator is inserted with point on the (empty) term before it.
Unbound — `M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-task-item" path="reference/jmarkdown/jmarkdown-insert-task-item.html"}
#### `jmarkdown-insert-task-item`
`(jmarkdown-insert-task-item)`

Insert a task-list checkbox item `- [ ] ` at the start of the current
line, with point after it. Unbound — `M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-anchor" path="reference/jmarkdown/jmarkdown-insert-anchor.html"}
#### `jmarkdown-insert-anchor`
`(jmarkdown-insert-anchor)`

Insert an anchor `⚓️name` with point in the name slot — the
link-target form, distinct from a numbered `:label[…]`. Unbound —
`M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-toc" path="reference/jmarkdown/jmarkdown-insert-toc.html"}
#### `jmarkdown-insert-toc`
`(jmarkdown-insert-toc)`

Insert a `{{TOC}}` table-of-contents placeholder on its own line —
expanded at build time. (Not to be confused with cmd(jmarkdown-toc),
the outline *navigator*.) Unbound — `M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-list-of-figures" path="reference/jmarkdown/jmarkdown-insert-list-of-figures.html"}
#### `jmarkdown-insert-list-of-figures`
`(jmarkdown-insert-list-of-figures)`

Insert a `{{LOF}}` list-of-figures placeholder. Unbound — `M-x` or the
JMarkdown menu.
:::

:::function{name="jmarkdown-insert-list-of-tables" path="reference/jmarkdown/jmarkdown-insert-list-of-tables.html"}
#### `jmarkdown-insert-list-of-tables`
`(jmarkdown-insert-list-of-tables)`

Insert a `{{LOT}}` list-of-tables placeholder. Unbound — `M-x` or the
JMarkdown menu.
:::

:::function{name="jmarkdown-insert-list-of-listings" path="reference/jmarkdown/jmarkdown-insert-list-of-listings.html"}
#### `jmarkdown-insert-list-of-listings`
`(jmarkdown-insert-list-of-listings)`

Insert a `{{LOL}}` list-of-listings placeholder. Unbound — `M-x` or
the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-index-block" path="reference/jmarkdown/jmarkdown-insert-index-block.html"}
#### `jmarkdown-insert-index-block`
`(jmarkdown-insert-index-block)`

Insert an `::Index{title="Index"}` block — where the back-of-book
index renders — with point in the title attribute. Populate the index
with cmd(jmarkdown-index) marks. Unbound — `M-x` or the JMarkdown
menu.
:::

:::function{name="jmarkdown-insert-bibliography" path="reference/jmarkdown/jmarkdown-insert-bibliography.html"}
#### `jmarkdown-insert-bibliography`
`(jmarkdown-insert-bibliography)`

Insert a `::Bibliography` marker on its own line — where the reference
list renders, from the `.bib` named in the front-matter (see
cmd(jmarkdown-citation)). Unbound — `M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-insert-include" path="reference/jmarkdown/jmarkdown-insert-include.html"}
#### `jmarkdown-insert-include`
`(jmarkdown-insert-include)`

Insert a `[[file.md]]` file-inclusion directive with point in the path
slot (before the `.md`). Unbound — `M-x` or the JMarkdown menu's
*Advanced* group.
:::

:::function{name="jmarkdown-insert-extension" path="reference/jmarkdown/jmarkdown-insert-extension.html"}
#### `jmarkdown-insert-extension`
`(jmarkdown-insert-extension)`

Insert a simple-extension skeleton — an `Extension name: OPEN CLOSE
false 1` line plus its tab-indented `<span>${content1}</span>`
replacement-HTML line, point on the name. This defines a custom inline
delimiter and belongs *inside* the document's `---` metadata header.
Unbound — `M-x` or the JMarkdown menu's *Advanced* group.
:::

:::function{name="jmarkdown-insert-script-block" path="reference/jmarkdown/jmarkdown-insert-script-block.html"}
#### `jmarkdown-insert-script-block`
`(jmarkdown-insert-script-block)`

Insert an HTML `script` element tagged `data-type="jmarkdown"`, with
point on the body line — the place to define directives and
environments inline in the document. (The literal tag cannot be
printed here: jmarkdown executes such blocks while building this very
manual.) Unbound — `M-x` or the JMarkdown menu's *Advanced* group.
:::

:::function{name="jmarkdown-insert-target" path="reference/jmarkdown/jmarkdown-insert-target.html"}
#### `jmarkdown-insert-target`
`(jmarkdown-insert-target)`

Insert an inline `:target[id]` placeholder with point on the id — the
LOCATION into which the content of a matching source block (see
cmd(jmarkdown-insert-source)) is spliced at build time. Unbound —
`M-x` or the JMarkdown menu's *Advanced* group.
:::

:::function{name="jmarkdown-insert-source" path="reference/jmarkdown/jmarkdown-insert-source.html"}
#### `jmarkdown-insert-source`
`(jmarkdown-insert-source)`

Insert a `:::source{target="id"}` … `:::` block, point in the target
attribute, whose content is moved into the matching `:target[id]`
placeholder at build time. The required attribute is `target=`, not
`key=`. Unbound — `M-x` or the JMarkdown menu's *Advanced* group.
:::

### Navigation

Defined in `jmarkdown-nav.lisp` — the small daily motions, as pure
offset-finders over the buffer text (the `latex-nav.lisp` shape), so
they need no build and no document database.

:::function{name="jmarkdown-next-section" path="reference/jmarkdown/jmarkdown-next-section.html"}
#### `jmarkdown-next-section`
`(jmarkdown-next-section)`

Move point to the next ATX heading (1–6 `#` then a space), recenter,
and echo the heading title (a trailing `:label[…]` is stripped from
the echo). Reports "no next heading" at the last one. Bound to
`C-c C-n`. See also cmd(jmarkdown-previous-section).
:::

:::function{name="jmarkdown-previous-section" path="reference/jmarkdown/jmarkdown-previous-section.html"}
#### `jmarkdown-previous-section`
`(jmarkdown-previous-section)`

Move point to the previous ATX heading, the companion to
cmd(jmarkdown-next-section). It looks before the current *line* start,
so repeated presses walk up even from a heading line. Bound to
`C-c C-u`.
:::

:::function{name="jmarkdown-goto-matching" path="reference/jmarkdown/jmarkdown-goto-matching.html"}
#### `jmarkdown-goto-matching`
`(jmarkdown-goto-matching)`

When the current line holds an `@begin(NAME)`, jump to its matching
`@end(NAME)` — and vice versa — respecting nested same-name
environments (the match is name-aware, so an inner
`@begin(figure)` … `@end(figure)` does not derail an outer theorem).
A status message when the line holds neither. Bound to `C-c C-j`.
:::

:::function{name="jmarkdown-insert-item" path="reference/jmarkdown/jmarkdown-insert-item.html"}
#### `jmarkdown-insert-item`
`(jmarkdown-insert-item)`

Continue the enclosing list: insert a newline and the next marker at
the current line's indentation — an unordered bullet (`-`/`*`/`+`)
repeated, an ordered marker (`1.` / `2)`) incremented, a lettered
marker (`a.` / `b)`) advanced to the next letter (`z` stays `z`). On a
non-list line it is a plain indented newline. Bound to `M-RET`.
:::

:::function{name="jmarkdown-toc" path="reference/jmarkdown/jmarkdown-toc.html"}
#### `jmarkdown-toc`
`(jmarkdown-toc)`

Show an outline of the document's headings in the minibuffer — each
candidate indented by its level, TAB completes — and jump to the
chosen one (recentering). Duplicate titles are disambiguated with a
` (N)` suffix. The RefTeX-`C-c =` analog; the *placeholder* that
renders a TOC in the output is cmd(jmarkdown-insert-toc). Bound to
`C-c =`.
:::

### References and citations

Defined in `jmarkdown-ref.lisp` — the RefTeX-style layer, over a
document scanned in pure Lisp. The completion universe for references
is every `:label[…]` key plus every `{id=…}` attribute value in the
buffer; citations reuse the citation bridge (citation.js) over the
`.bib` named in the document's front-matter.

:::function{name="jmarkdown-label" path="reference/jmarkdown/jmarkdown-label.html"}
#### `jmarkdown-label`
`(jmarkdown-label)`

Insert a cross-reference label with a suggested key, confirmed in the
minibuffer: on a heading line the suggestion is `sec:` plus a slug of
the title, elsewhere a plain `label` stem — either way uniquified
against the document's existing keys (`-2`, `-3`, … suffixes). The
`:label[key]` is appended at the end of a heading line, or inserted at
point elsewhere. For a numbered `@begin` float the `{id=key}`
attribute on the opener is the preferred form —
cmd(jmarkdown-environment)'s templates put it there for you. Bound to
`C-c (`. See also cmd(jmarkdown-reference).
:::

:::function{name="jmarkdown-reference" path="reference/jmarkdown/jmarkdown-reference.html"}
#### `jmarkdown-reference`
`(jmarkdown-reference)`

Insert a cross-reference: pick a target in the minibuffer (TAB
completes over every `:label[…]` key and `{id=…}` value in the
document), then a second prompt chooses the form — `cref` (typed,
lower-case; the default), `Cref` (sentence-start), or `ref` (bare
number) — and the `:cref[key]` / `:Cref[key]` / `:ref[key]` is
inserted at point. A status message when the document has no labels or
ids yet. Bound to `C-c )`.
:::

:::function{name="jmarkdown-citation" path="reference/jmarkdown/jmarkdown-citation.html"}
#### `jmarkdown-citation`
`(jmarkdown-citation)`

Insert a citation. The `.bib` is the one named on the front-matter's
`Bibliography:` line (searched case-insensitively in the first ~60
lines, a leading YAML `- ` dash allowed), resolved against the
document's directory and parsed with the citation bridge; entries
complete in the minibuffer as `key — Author (year)`, and choosing one
inserts `\citep{key}`. When no readable bibliography is found the
status line says what to add to the front-matter. Bound to `C-c [`.
:::

:::function{name="jmarkdown-index" path="reference/jmarkdown/jmarkdown-index.html"}
#### `jmarkdown-index`
`(jmarkdown-index)`

Insert an index mark `:index[entry]` at point, TAB-completing over the
index entries already used in the document — so recurring entries stay
consistently spelled. The index itself renders where
cmd(jmarkdown-insert-index-block) put its block. Bound to `C-c /`.
:::

### Fill and comment

Defined in `languages/jmarkdown.lisp` — the JMarkdown-aware fill (the
`latex-fill.lisp` pattern: a pure, unit-tested planner behind a thin
buffer command), the comment wrap, and the region-aware Tab keys. The
mode also installs `jmarkdown-fill-indent` as its
`:fill-indent-function`, so `auto-fill-mode` continuation lines get
the same hanging prefixes as `M-q` — the two always agree.

:::function{name="jmarkdown-fill-paragraph" path="reference/jmarkdown/jmarkdown-fill-paragraph.html"}
#### `jmarkdown-fill-paragraph`
`(jmarkdown-fill-paragraph)`

Re-wrap the paragraph at point, JMarkdown-aware, to the fill column —
72, fixed to match the editor's generic fill (it is not a defcustom).
Structural lines — `@begin`/`@end`, `:::` directives, ATX headings,
code fences, dash rules — bound the paragraph instead of being
swallowed into it, and the re-wrapped text keeps the paragraph's
indent. A list / ordered / description-list paragraph gets a hanging
indent (the marker replaced by spaces on continuation lines); a
blockquote's `>` markers are repeated on every line. A flush-right
(`>>`) or centred (`>>` … `<<`) block reflows keeping its sigils on
every line, the centred `<<` re-aligned to the fill column. With point
on a too-long `@begin(…)` opener, the `@begin(name)` keeps its line
and each `[label]` / `{attributes}` part wraps onto its own line,
indented one tab-width further. The `---` metadata front-matter
(whitespace-significant extension definitions) and fenced code are
never filled. Bound to `M-q`, overriding the global generic fill.
:::

:::function{name="jmarkdown-comment-region" path="reference/jmarkdown/jmarkdown-comment-region.html"}
#### `jmarkdown-comment-region`
`(jmarkdown-comment-region)`

Wrap the active region in an `@begin(comment)` … `@end(comment)`
block — hidden from the built output unless the opener is given
`{include=true}`. With no region, insert an empty comment block with
point inside. Unbound — `M-x` or the JMarkdown menu.
:::

:::function{name="jmarkdown-tab" path="reference/jmarkdown/jmarkdown-tab.html"}
#### `jmarkdown-tab`
`(jmarkdown-tab)`

The mode's `TAB`: with a region active (and no snippet running),
indent the selected lines one level (cmd(indent-region), as on `M-]`);
otherwise the normal TAB — snippet field navigation, trigger
expansion, or a plain tab insert. Snippet navigation wins because an
active snippet field is usually selected. Bound to `TAB`.
:::

:::function{name="jmarkdown-backtab" path="reference/jmarkdown/jmarkdown-backtab.html"}
#### `jmarkdown-backtab`
`(jmarkdown-backtab)`

The mode's `S-TAB`: with a region active (and no snippet running),
outdent the selected lines one level (cmd(outdent-region), as on
`M-[`); otherwise step to the previous snippet field (a no-op when no
snippet is active). Bound to `S-TAB`.
:::

### Settings

These are `defcustom` variables, not procedures — user-facing settings
you can change live (`(custom-apply! 'name value)`), persist
(`(custom-apply-and-save! 'name value)`), or edit through `M-x
customize`. Each entry's signature line shows the default value. They
live in the `jmarkdown` customize group except where noted;
`help-and-config.md` documents the customization machinery itself.

:::function{name="*jmarkdown-command*" path="reference/jmarkdown/jmarkdown-command.html"}
#### `*jmarkdown-command*`
`(default '("jmarkdown" "process"))`

The JMarkdown build command as a list of strings — program followed by
flags; the source filename is appended at build time, and `--to latex`
is added for a LaTeX build. `run-process!` spawns with no shell, so
this is a token list, never a single shell string. Under a
Finder-launched app `jmarkdown` may not be on `PATH` — launch from a
terminal or give an absolute path here. Group: `jmarkdown`. Defined in
`jmarkdown-compile.lisp`.
:::

:::function{name="*jmarkdown-compile-format*" path="reference/jmarkdown/jmarkdown-compile-format.html"}
#### `*jmarkdown-compile-format*`
`(default 'html)`

The default format cmd(jmarkdown-compile) (`C-c C-c`) builds: `'html`,
`'latex`, or `'pdf`. A prefix argument (`C-u C-c C-c`) prompts for the
format for one build instead of changing this. Group: `jmarkdown`.
Defined in `jmarkdown-compile.lisp`.
:::

:::function{name="*jmarkdown-chrome*" path="reference/jmarkdown/jmarkdown-chrome.html"}
#### `*jmarkdown-chrome*`
`(default "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")`

The Chrome / Chromium executable the PDF build uses to print the built
HTML (`--headless --print-to-pdf`) — the zero-dependency PDF route.
Point it at your browser if it lives elsewhere; when it is not found
the PDF step fails with a clear status and the HTML is still produced.
Group: `jmarkdown`. Defined in `jmarkdown-compile.lisp`.
:::

:::function{name="*jmarkdown-view-restore*" path="reference/jmarkdown/jmarkdown-view-restore.html"}
#### `*jmarkdown-view-restore*`
`(default #t)`

Whether the built artifact cmd(jmarkdown-view-output) opens persists
across a relaunch (mainly relevant for a PDF beside its source) — the
JMarkdown analog of `*latex-pdf-restore*`. Group: `jmarkdown`. Defined
in `jmarkdown-compile.lisp`.
:::

:::function{name="*jmarkdown-environments*" path="reference/jmarkdown/jmarkdown-environments.html"}
#### `*jmarkdown-environments*`
`(default: a 19-name list — theorem, lemma, corollary, proposition, definition, example, remark, proof, equation, figure, subfigure, table, listing, game, abstract, feedback, comment, TeX, HTML)`

Candidate `@begin(NAME)` environment names offered by
cmd(jmarkdown-environment) (`C-c C-e`), merged at prompt time with the
`@begin(…)` names already used in the buffer. Floats, theorems and
`equation` get a caption/id template; the rest a plain body. Add your
document's recurring environments here so they complete without first
appearing in the text. Group: `jmarkdown`. Defined in
`jmarkdown-insert.lisp`.
:::

:::function{name="*jmarkdown-directives*" path="reference/jmarkdown/jmarkdown-directives.html"}
#### `*jmarkdown-directives*`
`(default: a 15-name list — note, aside, abstract, feedback, TeX, HTML, mermaid, TiKZ, game, comment, markdown-demo, target, source, section, figure)`

Candidate `:::NAME` container-directive names offered by
cmd(jmarkdown-directive) (`C-c C-m`), merged at prompt time with the
`:::` names already used in the buffer. Group: `jmarkdown`. Defined in
`jmarkdown-insert.lisp`.
:::

:::function{name="*jmarkdown-alert-types*" path="reference/jmarkdown/jmarkdown-alert-types.html"}
#### `*jmarkdown-alert-types*`
`(default '("NOTE" "TIP" "IMPORTANT" "WARNING" "CAUTION" "QUESTION" "SUGGESTION"))`

The alert variants cmd(jmarkdown-insert-alert) offers for its
`> [!TYPE]` blockquotes: the five GitHub types plus JMarkdown's
QUESTION and SUGGESTION. Group: `jmarkdown`. Defined in
`jmarkdown-insert.lisp`.
:::

:::function{name="*jmarkdown-code-languages*" path="reference/jmarkdown/jmarkdown-code-languages.html"}
#### `*jmarkdown-code-languages*`
`(default: a 21-name list — javascript, js, typescript, python, bash, shell, json, html, css, c, cpp, java, rust, go, sql, latex, lisp, scheme, markdown, yaml, text)`

Common code-fence language hints offered by
cmd(jmarkdown-insert-code-block) — a completion convenience only; any
highlight.js language name works when typed. Group: `jmarkdown`.
Defined in `jmarkdown-insert.lisp`.
:::

:::function{name="*jmarkdown-math-preview-default*" path="reference/jmarkdown/jmarkdown-math-preview-default.html"}
#### `*jmarkdown-math-preview-default*`
`(default #f)`

When `#t`, typeset math inline automatically for JMarkdown buffers.
Off by default — opt in per-buffer with
cmd(toggle-jmarkdown-math-preview), or set this in your init /
customisation to default it on. Group: `godot` (not `jmarkdown`).
Defined in `languages/jmarkdown.lisp`.
:::
