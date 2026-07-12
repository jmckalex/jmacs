## Authoring in JMarkdown

`jmarkdown-mode` is the major mode for `.jmd` files — the Markdown dialect
behind *The Rise of Computational Philosophy* and its toolkit. On top of the
editing basics it carries a full **authoring environment**, built in the
spirit of Emacs's AUCTeX and RefTeX: a compile/preview loop, completing
insertion of every JMarkdown construct, structural navigation, and a
reference manager for cross-references, citations and an outline. Everything
here is reachable two ways — from the **JMarkdown menu** in the menu bar, and
from an AUCTeX-style `C-c C-<letter>` key. This chapter is the tour; the exact
docstring for any command is a `C-h f` (describe-command) away in the running
editor.

The layer sits beside the constructs the mode already gave you — the emphasis
commands (`*strong*`, `/italics/`, `**intense**`, `==highlight==`), the
JMarkdown-aware fill (`M-q`), the live preview pane (`C-c v`), and the
math-symbol minor mode. It adds the *structural* half of authoring.

### Compiling and viewing

The compile loop mirrors AUCTeX's `C-c C-c`. Press `C-c C-c` and the buffer is
saved and built with the `jmarkdown` command-line tool; the toolchain's output
lands in a **JMarkdown output** tab in the utility dock, any warnings in a
**JMarkdown errors** tab, and a one-line summary in the echo area.

Which format you get is the `*jmarkdown-compile-format*` setting — `html`
(the default), `latex`, or `pdf`. To pick a format for a single build, give a
prefix argument: `C-u C-c C-c` prompts for it. The three explicit commands
`jmarkdown-compile-html`, `jmarkdown-compile-latex` and `jmarkdown-compile-pdf`
are on the menu.

- **HTML** and **LaTeX** run `jmarkdown process` directly (LaTeX adds
  `--to latex`), producing `doc.html` / `doc.tex` beside the source.
- **PDF** builds the HTML first and then prints it with headless Chrome
  (`*jmarkdown-chrome*` names the browser). If Chrome is not found the HTML is
  still built and the echo area says so; point `*jmarkdown-chrome*` at your
  browser, or build to LaTeX and run your own `latexmk`.

Once built, `C-c C-o` (`jmarkdown-view-output`) opens the artifact beside the
source — a PDF renders in the built-in viewer; an HTML or `.tex` file opens as
text. If a warning or error was reported, `` C-c ` `` (`jmarkdown-next-error`)
walks the diagnostics, and `C-c C-w` (`jmarkdown-show-output`) brings the raw
build log forward.

> [!NOTE]
> The compile loop is the *one-shot export*. For a live, continuously-updating
> rendered preview while you write, use the preview pane on `C-c v` — the two
> are complementary.

### Inserting structure

Two completing commands cover JMarkdown's two block mechanisms, exactly as
AUCTeX's `C-c C-e` covers LaTeX environments:

- **`C-c C-e`** (`jmarkdown-environment`) inserts an `@begin(NAME) … @end(NAME)`
  environment. Type the first letters of a name and press `TAB` to complete
  against the built-in environments *and* the ones already used in the buffer.
  The template is chosen by kind: a float (`figure`/`table`/`listing`/
  `subfigure`) gets a `[caption]{id=…}` skeleton, a theorem-family environment
  or `equation` gets a `{id=…}` key, and everything else a plain body. With a
  region selected, the region becomes the body.

  ```
  @begin(theorem){id=thm:}
    ▮
  @end(theorem)
  ```

- **`C-c C-m`** (`jmarkdown-directive`) inserts a `:::NAME … :::` container
  directive, completing the name (note, aside, TeX, HTML, mermaid, TiKZ, and
  your own).

The older quick forms are still there for muscle memory: `C-c @` drops an
`@begin()/@end()` pair with a mirrored cursor (type the name once, it appears
in both), and `C-c d` a bare `:::` block.

Headings go in with **`C-c C-s`** (`jmarkdown-insert-section`): choose a level
1–6, and the current line becomes an ATX heading (a selected region becomes
the title). The `C-c 1` … `C-c 6` quick commands remain.

### Inserting rich blocks

The **Insert Block** menu (and `M-x`) reach the templated inserts for
JMarkdown's richer constructs, each dropping a ready-to-fill skeleton with the
cursor on the first field:

| Command | Inserts |
|---|---|
| `jmarkdown-insert-table` | a GFM table, prompting for `rowsxcols` |
| `jmarkdown-insert-figure` | an `@begin(figure)[caption]{id=fig:}` float |
| `jmarkdown-insert-table-float` | a captioned, numbered `@begin(table)` |
| `jmarkdown-insert-listing` | a captioned code `@begin(listing)` |
| `jmarkdown-insert-code-block` | a fenced code block (completes the language) |
| `jmarkdown-insert-math` | inline `$…$`, display `$$…$$`, or a numbered equation |
| `jmarkdown-insert-alert` | a `> [!TYPE]` admonition (completes the type) |
| `jmarkdown-insert-game` | a strategic-form `@begin(game)` payoff matrix |
| `jmarkdown-insert-description-item` | a `term:: description` pair |
| `jmarkdown-insert-task-item` | a `- [ ]` checkbox item |

Diagrams reuse the mode's existing `jmarkdown-insert-mermaid` and
`jmarkdown-insert-tikz`.

### Cross-references, citations and the index

This is the RefTeX half. JMarkdown numbers and cross-references headings,
figures, tables, listings, theorem-family environments and equations; the
reference manager scans the document for the targets and completes them for
you.

- **`C-c (`** (`jmarkdown-label`) inserts a label. On a heading line it
  suggests a key from the heading text (`sec:the-big-idea`), uniquifies it
  against the labels already in the document, and appends `:label[key]` at the
  end of the line. For a numbered `@begin` float the `{id=key}` attribute on
  the opener is the preferred form — the smart-insert templates put it there
  for you.

- **`C-c )`** (`jmarkdown-reference`) inserts a cross-reference. It completes
  the key against every `:label[…]` and `{id=…}` in the document, then asks for
  the form: `cref` (typed, lower-case — "figure 1", the default), `Cref`
  (sentence-start — "Figure 1"), or `ref` (the bare number).

- **`C-c [`** (`jmarkdown-citation`) inserts a citation. It reads the `.bib`
  named by the `Bibliography:` key in your front-matter (resolved relative to
  the file), lists the entries as `key — Author (year)`, and inserts
  `\citep{key}` for the one you pick.

- **`C-c /`** (`jmarkdown-index`) inserts an `:index[…]` mark, completing over
  the index entries you have already used.

The **References** menu also inserts the collection markers — `{{TOC}}`,
`{{LOF}}`, `{{LOT}}`, `{{LOL}}`, an `::Index` block and a `::Bibliography`
line — and an `⚓️` anchor.

### Navigating

- **`C-c C-n`** / **`C-c C-u`** (`jmarkdown-next-section` /
  `jmarkdown-previous-section`) jump forward and back through headings.
- **`C-c =`** (`jmarkdown-toc`) shows an outline of every heading, indented by
  level; pick one to jump straight to it — the document's table of contents as
  a navigator.
- **`C-c C-j`** (`jmarkdown-goto-matching`) jumps between the `@begin(NAME)`
  and `@end(NAME)` on the current line, matching by name and respecting
  nesting.
- **`M-RET`** (`jmarkdown-insert-item`) continues the enclosing list: it
  repeats a `-`/`*`/`+` bullet and increments an ordered `1.` or lettered `a.`
  marker, matching the current indentation. On an ordinary line it is just an
  indented newline.

### Fonts and toggles

Two sub-maps group the emphasis and toggle commands AUCTeX-style:

- **`C-c C-f`** then a letter — the font map: `b` bold, `i` italic, `e` intense
  (bold-italic), `u` underline, `h` highlight, `c` inline code. (Both the plain
  letter and its `C-` form work, as in AUCTeX.) Remember that in JMarkdown a
  single `*` is bold and `**` is *intense* — the commands emit the right
  markers so you need not.
- **`C-c C-t`** then a letter — the toggle map: `p` the preview pane, `m` the
  math-symbol minor mode, `x` the inline math preview.

### Settings

The authoring layer's behaviour is customisable (`M-x customize`, the
`jmarkdown` group):

- `*jmarkdown-compile-format*` — the default build format (`html`/`latex`/`pdf`).
- `*jmarkdown-command*` — the build command as a token list (default
  `jmarkdown process`).
- `*jmarkdown-chrome*` — the browser used for HTML→PDF printing.
- `*jmarkdown-environments*` / `*jmarkdown-directives*` — the completion
  candidate lists (merged with what the buffer already uses).
- `*jmarkdown-alert-types*` / `*jmarkdown-code-languages*` — the alert and
  code-fence completion lists.

### Key reference

| Key | Command |
|---|---|
| `C-c C-c` | compile (format prompt with `C-u`) |
| `C-c C-o` | view the built artifact |
| `` C-c ` `` | next diagnostic |
| `C-c C-w` | show the build output |
| `C-c C-e` | insert an environment (completing) |
| `C-c C-m` | insert a directive (completing) |
| `C-c C-s` | insert a heading |
| `C-c C-f` *k* | font sub-map (b/i/e/u/h/c) |
| `C-c C-t` *k* | toggle sub-map (p/m/x) |
| `C-c C-n` / `C-c C-u` | next / previous heading |
| `C-c C-j` | jump to matching `@begin`/`@end` |
| `M-RET` | continue the current list |
| `C-c (` | insert a label |
| `C-c )` | insert a cross-reference |
| `C-c [` | insert a citation |
| `C-c =` | outline / go to heading |
| `C-c /` | insert an index mark |

The single-letter `C-c` commands the mode already had — `C-c b/i/e/u/c/h`
(formatting), `C-c l/k/f` (link/cite/footnote), `C-c 1`–`C-c 6` (headings),
`C-c @`/`C-c d` (quick block inserts), `C-c v` (preview) — are unchanged and
sit alongside these.
