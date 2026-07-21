## Authoring in JMarkdown

`jmarkdown-mode` is the major mode for `.jmd` files — the Markdown dialect
behind *The Rise of Computational Philosophy* and its toolkit. On top of the
editing basics it carries a full **authoring environment**, built in the
spirit of Emacs's AUCTeX and RefTeX: a compile/preview loop, completing
insertion of every JMarkdown construct, structural navigation, and a
reference manager for cross-references, citations and an outline. Nearly
everything here is reachable two ways — from the **JMarkdown menu** in the
menu bar, and from an AUCTeX-style key under the `C-c` prefix (the daily
commands as `C-c C-<letter>` chords, the RefTeX quartet as punctuation:
`C-c (` and friends). The templated rich-block and Advanced inserts are the
exception: menu and `M-x` only, by design — reached rarely enough that keys
would be clutter. This chapter is the tour; the exact docstring for any
command is a `C-h f` (cmd(describe-command)) away in the running editor.

The layer sits beside the constructs the mode already gave you — the
emphasis commands (`*strong*`, `/italics/`, `**intense**`, `==highlight==`),
the JMarkdown-aware fill (`M-q`), the live preview pane (`C-c v`), and the
math-symbol minor mode — all covered in the Writing chapter. It adds the
*structural* half of authoring, and it is a deliberate port of the LaTeX
stack: if you know the AUCTeX/RefTeX layer from the LaTeX chapter, every
key here lands on the analogous command.

### Compiling and viewing

The compile loop mirrors AUCTeX's `C-c C-c`. Press `C-c C-c`
(cmd(jmarkdown-compile)) and the buffer is saved and built with the
`jmarkdown` command-line tool; the toolchain's output lands in a
**JMarkdown output** tab in the utility dock, any warnings in a
**JMarkdown errors** tab, and a one-line summary in the echo area.

Which format you get is the `*jmarkdown-compile-format*` setting — `html`
(the default), `latex`, or `pdf`. To pick a format for a single build, give a
prefix argument: `C-u C-c C-c` prompts for it. The three explicit commands
cmd(jmarkdown-compile-html), cmd(jmarkdown-compile-latex) and
cmd(jmarkdown-compile-pdf) are on the menu.

- **HTML** and **LaTeX** run `jmarkdown process` directly (LaTeX adds
  `--to latex`), producing `doc.html` / `doc.tex` beside the source.
- **PDF** builds the HTML first and then prints it with headless Chrome
  (`*jmarkdown-chrome*` names the browser). If Chrome is not found the HTML is
  still built and the echo area says so; point `*jmarkdown-chrome*` at your
  browser, or build to LaTeX and run your own `latexmk`.

Once built, `C-c C-o` (cmd(jmarkdown-view-output)) opens the artifact beside
the source — a PDF renders in the built-in viewer; an HTML or `.tex` file
opens as text. (Whether that split is restored across a relaunch is the
`*jmarkdown-view-restore*` setting — see Settings.) If a warning or error
was reported, `` C-c ` `` (cmd(jmarkdown-next-error)) walks the diagnostics
forward and cmd(jmarkdown-previous-error) — on the menu, unbound — walks
them back; a diagnostic carrying a `file:line` location jumps there, the
rest just echo their message. `C-c C-w` (cmd(jmarkdown-show-output)) brings
the raw build log forward.

> [!NOTE]
> The compile loop is the *one-shot export*. For a live, continuously-updating
> rendered preview while you write, use the preview pane on `C-c v` — the two
> are complementary. The preview pane belongs to the Writing chapter.

### Inserting structure

Two completing commands cover JMarkdown's two block mechanisms, exactly as
AUCTeX's `C-c C-e` covers LaTeX environments:

- **`C-c C-e`** (cmd(jmarkdown-environment)) inserts an `@begin(NAME) … @end(NAME)`
  environment. Type the first letters of a name and press `TAB` to complete
  against the built-in environments *and* the ones already used in the buffer.
  The template is chosen by kind: a float (`figure`/`table`/`listing`/
  `subfigure`) gets a `[caption]{id=…}` skeleton, a theorem-family environment
  or `equation` gets a `{id=…}` key, `game` its payoff-matrix skeleton, and
  everything else a plain body. With a region selected, the region becomes
  the body (a numbered environment still gets its `{id=…}` opener).

  ```
  @begin(theorem){id=thm:}
    ▮
  @end(theorem)
  ```

- **`C-c C-m`** (cmd(jmarkdown-directive)) inserts a `:::NAME … :::` container
  directive, completing the name (note, aside, TeX, HTML, mermaid, TiKZ, and
  your own).

`TAB` in these pickers behaves like a shell: it extends what you have typed
to the longest unambiguous prefix, and when more than one candidate remains
it lists the survivors in the echo area. In the environment picker, `t TAB`
extends nothing and echoes `theorem  table` (both survive); `th TAB`
completes straight to `theorem`; a prefix matching nothing echoes
`(no matches)` and leaves your text alone.

The older quick forms are still there for muscle memory: `C-c @` drops an
`@begin()/@end()` pair with a mirrored cursor (type the name once, it appears
in both), and `C-c d` a bare `:::` block.

Headings go in with **`C-c C-s`** (cmd(jmarkdown-insert-section)): choose a
level 1–6 and the `#` run is inserted *at point* — a selected region becomes
the heading title; with no region, point lands right after the `#`s, ready
for the title. Note the difference from the `C-c 1` … `C-c 6` quick
commands, which prepend the marker at the start of the current line wherever
point is: to convert an existing line, select its text first or use the
quick commands.

### Inserting rich blocks

The **Insert Block** menu (and `M-x`) reach the templated inserts for
JMarkdown's richer constructs — deliberately keyless — each dropping a
ready-to-fill skeleton with the cursor on the first field:

| Command | Inserts |
|---|---|
| cmd(jmarkdown-insert-table) | a GFM table, prompting for `rowsxcols` |
| cmd(jmarkdown-insert-figure) | an `@begin(figure)[caption]{id=fig:}` float |
| cmd(jmarkdown-insert-table-float) | a captioned, numbered `@begin(table)` |
| cmd(jmarkdown-insert-listing) | a captioned code `@begin(listing)` |
| cmd(jmarkdown-insert-code-block) | a fenced code block (completes the language) |
| cmd(jmarkdown-insert-math) | inline `$…$`, display `$$…$$`, or a numbered equation |
| cmd(jmarkdown-insert-alert) | a `> [!TYPE]` admonition (completes the type) |
| cmd(jmarkdown-insert-game) | a strategic-form `@begin(game)` payoff matrix |
| cmd(jmarkdown-insert-description-item) | a `term:: description` pair |
| cmd(jmarkdown-insert-task-item) | a `- [ ]` checkbox item |

Diagrams reuse the mode's existing cmd(jmarkdown-insert-mermaid) and
cmd(jmarkdown-insert-tikz) (also on `C-c g` and `C-c t`).

One more insert lives on the plain **Insert** menu: **Inline Comment**
(cmd(jmarkdown-comment-region)) wraps the region in an
`@begin(comment) … @end(comment)` block — prose that stays in the source but
is dropped from the built output unless the block carries `{include=true}`.
With no region it inserts an empty comment block with point inside. The
reviewer's margin, kept in the manuscript.

### Cross-references, citations and the index

This is the RefTeX half. JMarkdown numbers and cross-references headings,
figures, tables, listings, theorem-family environments and equations; the
reference manager scans the document for the targets and completes them for
you.

- **`C-c (`** (cmd(jmarkdown-label)) inserts a label. On a heading line it
  suggests a key from the heading text (`sec:the-big-idea`), uniquifies it
  against the labels already in the document, and appends `:label[key]` at the
  end of the line. For a numbered `@begin` float the `{id=key}` attribute on
  the opener is the preferred form — the smart-insert templates put it there
  for you.

- **`C-c )`** (cmd(jmarkdown-reference)) inserts a cross-reference. It completes
  the key against every `:label[…]` and `{id=…}` in the document, then asks for
  the form: `cref` (typed, lower-case — "figure 1", the default), `Cref`
  (sentence-start — "Figure 1"), or `ref` (the bare number).

- **`C-c [`** (cmd(jmarkdown-citation)) inserts a citation. It reads the `.bib`
  named by the `Bibliography:` key in your front-matter (resolved relative to
  the file), lists the entries as `key — Author (year)`, and inserts
  `\citep{key}` for the one you pick.

- **`C-c /`** (cmd(jmarkdown-index)) inserts an `:index[…]` mark, completing over
  the index entries you have already used.

(The quick, non-completing `:ref[]` and `:label[]` inserts remain on
`C-c r` and `C-c a`.)

The **References** menu also inserts the collection markers — `{{TOC}}`,
`{{LOF}}`, `{{LOT}}`, `{{LOL}}`, an `::Index` block and a `::Bibliography`
line — and an `⚓️` anchor.

### Advanced inserts

The **Advanced** menu group (menu and `M-x` only) covers JMarkdown's
document-engineering constructs — the ones you reach for when a manuscript
grows moving parts:

- cmd(jmarkdown-insert-include) — a `[[file.md]]` file-inclusion directive,
  point in the path slot: the named file is spliced into the document at
  build time.
- cmd(jmarkdown-insert-target) and cmd(jmarkdown-insert-source) — the
  write-here-appears-there pair. `:target[id]` marks the *location*; a
  `:::source{target="id"} … :::` block elsewhere holds the *content*, which
  the build moves into the matching target. (The required attribute is
  `target=`, not `key=` — the inserts get it right so you need not
  remember.)
- cmd(jmarkdown-insert-extension) — a metadata-header **Extension** skeleton
  for defining your own inline delimiter (`Extension name: OPEN CLOSE …`
  plus its HTML template). It belongs inside the `---` metadata header at
  the top of the file.
- cmd(jmarkdown-insert-script-block) — a `<script data-type="jmarkdown">`
  block for defining directives and environments inline in the document.

### Navigating

- **`C-c C-n`** / **`C-c C-u`** (cmd(jmarkdown-next-section) /
  cmd(jmarkdown-previous-section)) jump forward and back through headings.
- **`C-c =`** (cmd(jmarkdown-toc)) shows an outline of every heading, indented by
  level; pick one to jump straight to it — the document's table of contents as
  a navigator.
- **`C-c C-j`** (cmd(jmarkdown-goto-matching)) jumps between the `@begin(NAME)`
  and `@end(NAME)` on the current line, matching by name and respecting
  nesting.
- **`M-RET`** (cmd(jmarkdown-insert-item)) continues the enclosing list: it
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
  math-symbol minor mode, `x` the inline math preview. (The `C-` forms work
  here too.)

### Settings

The authoring layer's behaviour is customisable (`M-x customize`, the
`jmarkdown` group — the Customization chapter covers the interface):

- `*jmarkdown-compile-format*` — the default build format (`html`/`latex`/`pdf`).
- `*jmarkdown-command*` — the build command as a token list (default
  `jmarkdown process`). There is no shell in the loop, so it must be a list
  of program + flags; and under a Finder-launched app `jmarkdown` may not be
  on `PATH` — give an absolute path here if so.
- `*jmarkdown-chrome*` — the browser used for HTML→PDF printing (default
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).
- `*jmarkdown-view-restore*` — whether the artifact `C-c C-o` opens is
  restored across a relaunch (default on; mainly relevant for a PDF sitting
  beside its source).
- `*jmarkdown-environments*` / `*jmarkdown-directives*` — the completion
  candidate lists (merged with what the buffer already uses).
- `*jmarkdown-alert-types*` / `*jmarkdown-code-languages*` — the alert and
  code-fence completion lists.

All of these are consulted when the command runs, not at load time: a `set!`
or a customize edit takes effect on the next build or insert, no reload
required.

### Key reference

| Key | Command |
|---|---|
| `C-c C-c` | cmd(jmarkdown-compile) — compile (format prompt with `C-u`) |
| `C-c C-o` | cmd(jmarkdown-view-output) — view the built artifact |
| `` C-c ` `` | cmd(jmarkdown-next-error) — next diagnostic |
| `C-c C-w` | cmd(jmarkdown-show-output) — show the build output |
| `C-c C-e` | cmd(jmarkdown-environment) — insert an environment (completing) |
| `C-c C-m` | cmd(jmarkdown-directive) — insert a directive (completing) |
| `C-c C-s` | cmd(jmarkdown-insert-section) — insert a heading |
| `C-c C-f` *k* | font sub-map (b/i/e/u/h/c, or their `C-` forms) |
| `C-c C-t` *k* | toggle sub-map (p/m/x, or their `C-` forms) |
| `C-c C-n` / `C-c C-u` | cmd(jmarkdown-next-section) / cmd(jmarkdown-previous-section) |
| `C-c C-j` | cmd(jmarkdown-goto-matching) — jump to matching `@begin`/`@end` |
| `M-RET` | cmd(jmarkdown-insert-item) — continue the current list |
| `C-c (` | cmd(jmarkdown-label) — insert a label |
| `C-c )` | cmd(jmarkdown-reference) — insert a cross-reference |
| `C-c [` | cmd(jmarkdown-citation) — insert a citation |
| `C-c =` | cmd(jmarkdown-toc) — outline / go to heading |
| `C-c /` | cmd(jmarkdown-index) — insert an index mark |

The commands with no key — menu and `M-x` only, by design:

**Compile** — cmd(jmarkdown-compile-html) · cmd(jmarkdown-compile-latex) ·
cmd(jmarkdown-compile-pdf) · cmd(jmarkdown-previous-error).

**Insert Block** — cmd(jmarkdown-insert-table) · cmd(jmarkdown-insert-figure)
· cmd(jmarkdown-insert-table-float) · cmd(jmarkdown-insert-listing) ·
cmd(jmarkdown-insert-code-block) · cmd(jmarkdown-insert-math) ·
cmd(jmarkdown-insert-alert) · cmd(jmarkdown-insert-game) ·
cmd(jmarkdown-insert-description-item) · cmd(jmarkdown-insert-task-item) ·
cmd(jmarkdown-comment-region).

**References** — cmd(jmarkdown-insert-toc) ·
cmd(jmarkdown-insert-list-of-figures) · cmd(jmarkdown-insert-list-of-tables)
· cmd(jmarkdown-insert-list-of-listings) · cmd(jmarkdown-insert-index-block)
· cmd(jmarkdown-insert-bibliography) · cmd(jmarkdown-insert-anchor).

**Advanced** — cmd(jmarkdown-insert-include) · cmd(jmarkdown-insert-extension)
· cmd(jmarkdown-insert-script-block) · cmd(jmarkdown-insert-target) ·
cmd(jmarkdown-insert-source).

The bindings the mode already had sit unchanged alongside these:

| Key | Command |
|---|---|
| `C-c b/i/e/u/h/c` | formatting: bold / italic / intense / underline / highlight / inline code |
| `C-c l` / `C-c k` / `C-c f` | cmd(markdown-insert-link) / cmd(markdown-insert-cite) / cmd(markdown-insert-footnote) |
| `C-c r` / `C-c a` | quick `:ref[]` / `:label[]` (cmd(jmarkdown-insert-ref) / cmd(jmarkdown-insert-label)) |
| `C-c 1` … `C-c 6` | make the line a heading of that level |
| `C-c @` / `C-c d` | quick `@begin()`/`@end()` with a mirrored cursor / bare `:::` block |
| `C-c t` / `C-c g` | cmd(jmarkdown-insert-tikz) / cmd(jmarkdown-insert-mermaid) diagram blocks |
| `C-c q` / `C-c -` | cmd(markdown-blockquote) / cmd(markdown-list-item) |
| `C-c m` | cmd(toggle-math-mode) — the math-symbol minor mode |
| `C-c v` / `C-c C-v` | cmd(markdown-preview) toggle / cmd(markdown-preview-sync) forward search |
| `C-c C-p` | cmd(toggle-jmarkdown-math-preview) — inline math preview |
| `M-q` | cmd(jmarkdown-fill-paragraph) — the JMarkdown-aware fill |
| `TAB` / `S-TAB` | with a region active (and no snippet mid-flight — snippet fields win): indent / outdent the selected lines (cmd(indent-region) / cmd(outdent-region), as on `M-]` / `M-[`); otherwise snippet field navigation, expansion, or a plain tab |

The formatting, link and preview commands are the Writing chapter's — see
there for the JMarkdown syntax each emits.
