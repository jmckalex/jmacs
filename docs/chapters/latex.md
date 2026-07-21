## LaTeX: AUCTeX and RefTeX

Open a file ending in `.tex` or `.latex` and the editor puts the buffer
into *latex-mode* — a major mode that brings with it a compile-and-view
loop, a set of insertion helpers, two-way SyncTeX between the source and
the typeset PDF, and the RefTeX machinery for labels, cross-references
and citations. The whole suite is modelled on Emacs's AUCTeX and RefTeX,
but it is written in the editor's own Lisp, on top of the buffer
primitives, and every command and key below is an ordinary definition
you can inspect, rebind or redefine while the editor runs.

latex-mode's commands all hang off the `C-c` prefix, with a few
top-level keys (`M-q`, `M-RET`, `"`) for the things you do constantly.
The convention follows AUCTeX closely enough that the muscle memory
carries over. The five sections below walk the workflow in the order you
meet it: compile a document and look at the result, jump between source
and PDF, write the markup, attach labels and refer back to them, and
cite the literature. The stack also has a sibling: jmarkdown-mode
carries a deliberate port of these same layers — compile loop,
completing inserts, navigation, labels, references and citations — for
`.jmd` documents; see the *JMarkdown* chapter.

Throughout, `C-` is Control, `M-` is Command, `A-` is Option and `S-` is
Shift — the editor's standard notation, set out in the *Keys and
commands* chapter. `M-RET` here means Command held with Return; in a
binding string it is written `"M-enter"`.

### Compiling and viewing

The build loop is three commands on the `C-c` map.

cmd(latex-compile) — `C-c C-c` — saves the buffer and runs the
configured toolchain on the document. The command it runs is the list
`*latex-command*`, which defaults to

```
latexmk -pdf -synctex=1 -interaction=nonstopmode
```

latexmk subsumes the usual multi-pass rerun-and-bibtex dance itself, so
one invocation suffices. The command is a *list* of tokens — program
followed by flags — not a shell string: the build is spawned without a
shell, and the `.tex` filename is appended at run time. If `latexmk` is
not on your `PATH`, the command falls back automatically to a single
`pdflatex -synctex=1 -interaction=nonstopmode` pass (one pass only — no
automatic rerun for references or the bibliography; set `*latex-command*`
to `pdflatex` explicitly if you want full control of that workflow).

The build is spawned in the directory of the file you compile from,
with the master's bare filename appended — for a single-directory
document, the common case, that *is* the document's own directory. A
master that lives in a *different* directory from the chapter you are
editing is not yet handled: `latexmk main.tex` run from the chapter's
directory will not find it, so in that layout start the compile from
the master itself or a file beside it.

The build's output is *not* streamed into a pane. When the toolchain
exits, the whole log lands in a read-only **TeX output** tab in the
utility dock — the tabbed strip along the bottom of the window, also
home to the Lisp REPL; the *Extending* chapter introduces it, and
`C-x p` shows or hides it by hand — and the log is parsed into
diagnostics that populate a **TeX errors** tab. A compile reveals the
dock when it is hidden but never steals a pane or moves focus. The
echo area summarises the outcome — `LaTeX: success`,
`LaTeX: success (3 warnings)`, or ``LaTeX: 2 errors — C-c ` to visit``.

cmd(latex-view) — `C-c C-v` — shows the built PDF. The PDF path is the
`.tex` with its extension swapped to `.pdf`, in the same directory. If
the PDF is not already on screen, the source pane is split to the right
and the PDF opened in the new pane, so source and output sit side by
side; then the view forward-searches to the line you are on (see the
next section). A PDF already on screen is deliberately left as it is:
after a clean build cmd(latex-compile) reloads the open PDF's bytes
itself, so the output beside your source stays current as you
recompile, and a second reload from `C-c C-v` would only re-render the
view and fight the forward-search scroll. Run `C-c C-c` first if there
is no PDF yet — `latex-view` will tell you so rather than open an empty
pane.

When a build reports errors, walk them with cmd(latex-next-error),
bound to the backtick key under the mode prefix (`` C-c ` ``).
It visits the next diagnostic from the last build, opening its file,
jumping to its line, and echoing the message. Its
companion cmd(latex-previous-error) steps backward (bound by name,
reachable via `M-x`); cmd(latex-show-output) brings the raw
**TeX output** tab forward when you want to read the unparsed log.

Several settings tune the loop. `*latex-command*` and the fallback are
described above; `*latex-bibtex-command*` is the seam for an explicit
bibliography pass; `*latex-view*` selects the viewer (only the built-in
`pdf-view` is supported in this version — the seam for external viewers
such as Skim or evince is present but unwired); `*latex-pdf-restore*`
(on by default) makes the output PDF reappear beside its source after a
relaunch; and `*latex-clean*` lists the auxiliary extensions a future
`latex-clean` will remove (the command itself awaits a host file-delete
primitive — the setting documents the intent for now).

In a multi-file document, the file that gets built is the *master*, not
necessarily the buffer you are in. A chapter that is `\input` into a
book's `main.tex` builds `main.tex`. Master detection is RefTeX's job;
it is described under *Labels and references* below, and both
cmd(latex-compile) and cmd(latex-view) follow it automatically.

### SyncTeX

Because the build passes `-synctex=1`, latexmk (or pdflatex) leaves a
`<master>.synctex.gz` beside the PDF, and the editor uses the `synctex`
command-line tool to map between source positions and typeset positions
in both directions.

**Forward — source to PDF.** cmd(latex-view) (`C-c C-v`) does more than
put the PDF on screen: once it is showing, the command runs a forward
search from point — `synctex view` on the current line and column — and
scrolls the PDF to the corresponding page, flashing a transient
highlight over the typeset spot. So `C-c C-v` is both
"show me the output" and "show me *this line* in the output". The same
jump is available on its own as cmd(latex-forward-search) (via `M-x`),
which scrolls an already-open PDF to the current line without
re-opening anything.

**Inverse — PDF to source.** Option-click anywhere in the PDF view and
the editor runs `synctex edit` on that page and point, parses the
resulting file and line, and reveals the source there. The source always
lands in a *source* pane — never in the PDF's own pane — recentred so the
line sits mid-screen, with a transient highlight to draw the eye. If the
file is already displayed in a pane, focus returns to it; otherwise it is
surfaced or opened in a text pane beside the PDF. SyncTeX (under
pdflatex) reports no column, so the cursor lands at the start of the
matched line.

Both directions need the `synctex` program on the path the editor
inherited. On a macOS GUI launch that path can miss
`/Library/TeX/texbin`; if the bare name is not found, set
`*synctex-command*` to the full path, e.g.
`'("/Library/TeX/texbin/synctex")`. Like `*latex-command*`, it is a
token list, not a shell string.

### Writing LaTeX (AUCTeX)

The insertion commands are the daily-authoring layer. Most wrap the
active region when there is one and otherwise drop in the markup with
point where the text goes — so they serve equally for "make this
selection bold" and "start a bold span here".

**Fonts and emphasis.** The quick font wraps live both on the `C-c`
single-letter map and on a dedicated font sub-map under `C-c C-f`,
matching AUCTeX's scheme where the plain letter and its control form do
the same thing (so `C-c C-f e` and `C-c C-f C-e` both insert `\emph{}`):

| Key (quick) | `C-c C-f` | Command | Inserts |
|-------------|-----------|---------|---------|
| `C-c b` | `b` | cmd(latex-textbf) | `\textbf{…}` |
| `C-c i` | `i` | cmd(latex-textit) | `\textit{…}` |
| `C-c e` | `e` | cmd(latex-emph) | `\emph{…}` |
| — | `t` | cmd(latex-texttt) | `\texttt{…}` (monospace) |
| — | `c` | cmd(latex-textsc) | `\textsc{…}` (small caps) |
| — | `s` | cmd(latex-textsl) | `\textsl{…}` (slanted) |
| — | `r` | cmd(latex-textrm) | `\textrm{…}` (roman) |
| — | `f` | cmd(latex-textsf) | `\textsf{…}` (sans serif) |
| — | `m` | cmd(latex-textmd) | `\textmd{…}` (medium weight) |

**Sections.** `C-c s` (cmd(latex-section)) and `C-c S`
(cmd(latex-subsection)) are quick wraps in `\section{}` and
`\subsection{}`. For the full ladder, cmd(latex-insert-section) —
`C-c C-s` — prompts in the minibuffer with TAB completion over
`part`, `chapter`, `section`, `subsection`, `subsubsection`, `paragraph`
and `subparagraph` (empty defaults to `section`); an active region
becomes the title. When `*latex-section-insert-label*` is on (it is off
by default), a `\label{}` is dropped on the next line, pre-seeded with
the section prefix.

**Environments.** cmd(latex-insert-environment) — `C-c C-e` — reads an
environment name in the minibuffer, completing over the
`*latex-environments*` list merged with the `\begin{…}`s already used
in the buffer — so a document's own environments complete even before
you add them to the setting — and inserts a `\begin{ENV}…\end{ENV}`
block templated to the kind: `itemize` and `enumerate` get an `\item`;
`description` gets `\item[]`; `figure` and `table` get `\centering`,
`\caption{}` and a `\label{}` pre-seeded with the RefTeX type prefix
(`fig:` / `tab:` — a customised `*reftex-label-prefixes*` is honoured,
so the insert layer and RefTeX agree on key style); `tabular` and
`array` prompt for a column spec; the math environments get a body
line. Point lands on the content line. An active region is wrapped as
the body. The quick stubs cmd(latex-itemize) (`C-c l`) and
cmd(latex-enumerate) (`C-c n`) remain for the two common lists. Add
your document's recurring environments to `*latex-environments*` so
they complete without first appearing in the text.

cmd(latex-close-environment) — `C-c ]` — closes the innermost open
environment: it scans from the top of the buffer to point, finds the
unmatched innermost `\begin{X}`, and inserts a correctly-indented
`\end{X}` at point, echoing which environment it closed.

**Macros.** cmd(latex-insert-macro) — `C-c C-m` — inserts an arbitrary
`\NAME{}` chosen in the minibuffer, completing over the `*latex-macros*`
list (macro names without the leading backslash) merged with the
`\macro`s already in the buffer. Point lands inside
the braces; an active region is wrapped as the argument. A leading
backslash you type is stripped, so `emph` and `\emph` both work.
(Multi-argument macros get a single `{}` — further arguments are typed by
hand.)

**Math markup.** `C-c m` (cmd(latex-math-inline)) wraps the region in
`$…$`; `C-c M` (cmd(latex-math-display)) wraps it in `\[ … \]`.

**Math symbols by mnemonic.** latex-mode also offers a *LaTeX-math* minor
mode — a port of AUCTeX's `LaTeX-math-list`. Toggle it with `C-c ~`
(cmd(toggle-latex-math-mode)). With it on, a configurable prefix key
(the backtick `` ` `` by default, set in `*latex-math-abbrev-prefix*`)
followed by one key inserts a math macro: `` `a `` → `\alpha`,
`` `G `` → `\Gamma`, `` `> `` → `\geq`, `` `8 `` → `\infty`, and so on.
Lowercase letters give lowercase Greek by first letter, capitals give
uppercase Greek or the big operators and quantifiers, and the variant
forms sit on the capitals whose Greek letter has no distinct uppercase
glyph — `` `V `` → `\varepsilon`, `` `U `` → `\vartheta`,
`` `B `` → `\varrho`, `` `R `` → `\varsigma`, `` `K `` → `\varpi`,
`` `C `` → `\varkappa` — plus two spare lowercase keys,
`` `v `` → `\nabla` and `` `j `` → `\varphi`. Pressing the prefix twice
inserts a literal prefix character; an unmapped key opens a completion
prompt over the macro names so you can pick a symbol by name. Changing
the prefix in Customize rebuilds the keymap live.

The math-abbrev mode is distinct from the *math-preview* minor mode,
which typesets math in place as you read. Toggle the latter with `C-c C-p`
(cmd(toggle-latex-math-preview)); it is the LaTeX face of the general
preview engine, and is covered in the Writing chapter — see there for how
inline and display math render and flip back to source when point enters
them. Both minor modes start off in a fresh LaTeX buffer. The paired
settings `*latex-math-mode-default*` and `*latex-math-preview-default*`
record an intent to default them on, but the automatic enable is not
yet wired — toggle them per buffer for now.

**Navigation and typing niceties.** cmd(latex-next-section) (`C-c C-n`)
and cmd(latex-previous-section) (`C-c C-r`) jump between sectioning
commands, echoing each title; these scan the buffer directly, so they
work without a built RefTeX document. cmd(latex-goto-matching-env)
(`C-c %`) jumps between a `\begin{X}` and its matching `\end{X}`,
respecting nested same-name environments. cmd(latex-insert-item) on
`M-RET` opens a new `\item` when point is inside a list environment
(`\item[]` inside a `description`), and falls back to a plain
newline-and-indent elsewhere. cmd(latex-smart-quote) on the `"` key
inserts context-sensitive TeX quotes — `` `` `` after whitespace or an
opening delimiter, `''` otherwise; type `"` straight after a quote
character to get a single literal `"`.

cmd(latex-fill-paragraph) on `M-q` re-wraps the paragraph around point
the way AUCTeX's `LaTeX-fill-paragraph` does, filling prose to the fill
column and re-indenting the enclosing block by its environment depth.
Structural lines (`\begin`/`\end`, `\item`, sectioning, display math)
are re-indented in place, never merged into prose; point inside a
`verbatim`, `tabular` or math-alignment environment leaves the buffer
untouched, and one of those environments sitting *inside* the paragraph
passes through byte-for-byte. A paragraph command like `\caption{…}` or
`\section{…}` is its own fill unit spanning the macro's extent: a long
caption wraps at the fill column. In every wrapped unit — a caption's
argument, plain prose with a spanning `\footnote{…}`, `\item` text —
continuation lines indent extra for each unclosed `{`, dropping back
once the closing `}` is passed. Comments fill too: a run of `%` lines
wraps behind its `%`-prefix (a `%%` header never merges with a `%`
body), and a comment trailing code stays glued to its line, unfilled.
Inline `\(…\)`/`\[…\]` math never breaks across lines, a `\verb` group
never breaks at all, and point stays on the word it was on.

The fill and indent behaviour is governed by a family of settings, each
mirroring an AUCTeX option (named once here — the `*latex-…*` name is
the one you customise):

- `*latex-fill-column*` — the wrap column, 72. A plain variable, not a
  Customize option: change it with `set!` from your init file.
- `*latex-indent-level*` — spaces of indentation per enclosing
  environment. Default 2 (AUCTeX `LaTeX-indent-level`).
- `*latex-item-indent*` — extra indent for an `\item` line relative to
  the environment body. Default −2, so the item line sits at the list's
  body level and its continuations indent one level deeper (AUCTeX
  `LaTeX-item-indent`).
- `*latex-brace-indent-level*` — extra spaces per unclosed `{` on
  wrapped continuation lines. Default 2 (AUCTeX
  `TeX-brace-indent-level`); set it to 0 for flat continuations.
- `*latex-fill-break-at-separators*` — on by default: never break a
  line inside an inline math group; the whole group moves to the next
  line when it straddles the fill column (AUCTeX
  `LaTeX-fill-break-at-separators`).
- `*latex-sentence-end-double-space*` — off by default; turn it on for
  Emacs's two-spaces-after-a-sentence rule when lines merge
  (`sentence-end-double-space`).
- `*latex-non-indenting-environments*` — environments whose body gains
  no indentation level. Default `("document")`, so text directly inside
  `\begin{document}` stays flush-left (AUCTeX `LaTeX-document-regexp`).

A grouped **LaTeX** menu collects all of these into submenus — Compile &
View, Insert, Fonts, Math, References, Navigation — so the commands are
discoverable without memorising the keys. And the keys in this chapter
are defaults, not law: `C-h k` reports what a key is bound to *right
now*, mode map included — the quick way to check a chord you may have
rebound.

### Labels and references (RefTeX)

RefTeX models the document as a whole — including everything reached
through `\input`, `\include`, `\subfile` and `\import` — so that labels,
sections and citations from every file in the project are available
wherever you are editing.

**The master file.** RefTeX detects the document's *master* (its root
`.tex`) by a ladder: an explicit `*reftex-master*` setting; a
`% !TEX root = …` magic comment in the current file; the current file
itself if it carries a `\documentclass`; a single unambiguous sibling or
parent file that `\input`s the current one (preferring one with a
`\documentclass`); and finally the current file as its own master. This
same detection is what cmd(latex-compile) and cmd(latex-view) build and
view, so a compile from any chapter builds the book. If detection guesses
wrong in an unusual layout, pin the master with the `*reftex-master*`
setting or a `% !TEX root` comment.

RefTeX keeps a database of the document — labels, sections, references,
citations, index entries, the `\input` graph and bibliography paths —
in a per-master cache. The freshness rule matters in practice: whenever
the file you are editing belongs to the document (the normal case),
each RefTeX command rebuilds the database — your buffer is read live,
the other files re-read from disk — so a *saved* edit to a sibling file
is picked up automatically by the next command. What no scan can see
are *unsaved* edits sitting in another buffer: files other than the one
you are in are always read from disk, so save the sibling first. The
cache is served only when the current view is not one of the document's
own files. cmd(reftex-reparse) clears the cache and rebuilds
unconditionally, echoing how many files and labels it scanned — a quick
sanity check that RefTeX is seeing what you think it is (it is RefTeX's
`g`, reachable via `M-x`).

The database records more than labels: per file it also collects the
`\ref`/`\eqref` and `\cite` occurrences, `\index` entries, the
`\input`/`\include`/`\subfile`/`\import` records themselves, and the
bibliography paths. An `\input` whose target file does not exist is
skipped and noted rather than aborting the scan — the document builds
from what is present, which is what you want mid-restructure when a
chapter file has not been created yet.

**Inserting labels.** cmd(reftex-label) — `C-c (` — inserts a
`\label{KEY}` with a smart, unique key. The label's *type* is inferred
from the innermost enclosing environment — `equation`, `align` and the
other math environments give an `eq:` key, `figure` gives `fig:`,
`table` gives `tab:`, and so on — or, when the line point is on opens
with a sectioning command, `sec:`. The section inference looks at
*point's own line*: run `C-c (` at the end of the `\section{…}` line
itself; on the line below, the label gets no prefix. The stem comes
from the nearest `\caption{}` (for figures and tables) or the enclosing
section title, slugified, and the whole key is made unique against the
labels already in the document (`-2`, `-3`, … as needed).
`*reftex-label-confirm*` is on by default: the suggested key is offered
in the minibuffer for you to edit before it is inserted; either way
uniqueness is enforced on what you finally accept. The prefixes are
configurable through `*reftex-label-prefixes*` and
`*reftex-label-default-prefix*`.

**Inserting references.** cmd(reftex-reference) — `C-c )` — is RefTeX's
*selection-first* picker. It opens a picker palette centred over the
dimmed editor, listing the document's labels, each row showing a
context line — the label's own source line, or its enclosing section.
Typing narrows the list; the arrow keys (or `C-n`/`C-p`, or
PageUp/PageDown for eight rows at a time) move the selection; `RET`
inserts the reference at the point you started from; `ESC` cancels and
returns there. The macro is chosen from the label's type: equations get
`\eqref`, everything else `\ref` (`*reftex-ref-macro-by-type*` /
`*reftex-ref-macro-default*`).

Three affordances of RefTeX's classic select buffer — rows grouped
under type headings, `SPC` to peek at a label's source without leaving
the picker, and a cycling type filter — belong to a bespoke select
panel that is not yet wired in; the shipped picker is choose-or-cancel.
When the document has no labels yet, `C-c )` says so in the echo area
and stops.

When you already know the key, cmd(reftex-reference-minibuffer) (via
`M-x`) is the fast path: it reads the label name in the minibuffer with
TAB completion over the document's labels and inserts the same
type-chosen macro.

### Citations

cmd(reftex-citation) — `C-c [` — inserts a citation, following RefTeX's
*format-first* flow, in two picker steps.

First a **format menu** lists the citation commands from
`*reftex-cite-format*` — `\cite` first, then `\citep`, `\citet`
(natbib), `\parencite`, `\textcite` (biblatex), `\citeauthor` and
`\citeyear`, each with a one-line description. It is the same centred
picker as everywhere else: `RET` on opening takes the first row,
`\cite`, so the default format costs a single keystroke; otherwise
filter or arrow to a format and `RET`. Picking a format opens the
**cite picker**: the document's bibliography entries, one row per entry
showing the bib key, author, year and title, with the filter matching
any of those. `RET` inserts `<macro>{key}` at the point you started
from; `ESC` cancels back there.

Two affordances of classic RefTeX are not yet wired: marking several
entries with `m` — the picker inserts the single chosen key; add
further keys inside the braces by hand — and the formatted-reference
display. The `*reftex-cite-style*` setting (default `"harvard1"`; a
built-in CSL id such as `apa` or `vancouver`, or the path to any `.csl`
file) names the style that display will use when it lands. Display
formatting is in any case a *picking aid only*: the text inserted is
always the LaTeX `\cite`-family macro over the raw bib key, so BibTeX
or biblatex still owns the typeset result.

The bibliography is found from the document itself: the scan collects
every `\bibliography` and `\addbibresource` argument, and appends the
global `*citation-bib-path*` as a fallback. Of those paths, the *first*
that exists and reads is the one parsed — a document with several bib
files currently sees only the first. Entries the parser cannot handle —
some real-world TeX-accent forms throw — are skipped rather than
blanking the whole picker, and the echo area notes how many were
dropped. With no readable bibliography at all, `C-c [` says so and
stops.

The format set is fully configurable: narrow `*reftex-cite-format*` to a
single package family, or extend it, by customising that setting.

---

#### Command and key summary

**Compile and view**

| Key | Command | Purpose |
|---|---|---|
| `C-c C-c` | cmd(latex-compile) | save and build the document |
| `C-c C-v` | cmd(latex-view) | show the PDF, forward-search to point |
| `` C-c ` `` | cmd(latex-next-error) | visit the next diagnostic |
| — | cmd(latex-previous-error) | step back a diagnostic (`M-x`) |
| — | cmd(latex-show-output) | raise the raw **TeX output** tab (`M-x`) |

**SyncTeX**

| Key | Command | Purpose |
|---|---|---|
| `C-c C-v` | cmd(latex-view) | forward search folded in |
| — | cmd(latex-forward-search) | jump the open PDF to point (`M-x`) |
| Option-click in the PDF | — | inverse search to the source line |

**Insertion**

| Key | Command | Purpose |
|---|---|---|
| `C-c C-e` | cmd(latex-insert-environment) | completing `\begin…\end` block |
| `C-c ]` | cmd(latex-close-environment) | close the innermost open environment |
| `C-c C-m` | cmd(latex-insert-macro) | completing `\NAME{}` |
| `C-c C-s` | cmd(latex-insert-section) | completing sectioning ladder |
| `C-c l` | cmd(latex-itemize) | `itemize` stub |
| `C-c n` | cmd(latex-enumerate) | `enumerate` stub |
| `C-c s` | cmd(latex-section) | quick `\section{}` |
| `C-c S` | cmd(latex-subsection) | quick `\subsection{}` |

**Fonts** — quick `C-c b` / `C-c i` / `C-c e`, and the full `C-c C-f`
sub-map: see the table under *Writing LaTeX* above.

**Math**

| Key | Command | Purpose |
|---|---|---|
| `C-c m` | cmd(latex-math-inline) | wrap in `$…$` |
| `C-c M` | cmd(latex-math-display) | wrap in `\[ … \]` |
| `C-c ~` | cmd(toggle-latex-math-mode) | math-symbol abbrev mode |
| `C-c C-p` | cmd(toggle-latex-math-preview) | in-place math preview |

**Navigation and typing**

| Key | Command | Purpose |
|---|---|---|
| `C-c C-n` | cmd(latex-next-section) | next sectioning command |
| `C-c C-r` | cmd(latex-previous-section) | previous sectioning command |
| `C-c %` | cmd(latex-goto-matching-env) | jump `\begin` ↔ `\end` |
| `M-RET` | cmd(latex-insert-item) | new `\item` in a list |
| `"` | cmd(latex-smart-quote) | context-sensitive TeX quotes |
| `M-q` | cmd(latex-fill-paragraph) | fill and indent the paragraph |

**RefTeX**

| Key | Command | Purpose |
|---|---|---|
| `C-c (` | cmd(reftex-label) | insert a smart `\label{}` |
| `C-c )` | cmd(reftex-reference) | insert `\ref`/`\eqref` via the picker |
| — | cmd(reftex-reference-minibuffer) | reference by name (`M-x`) |
| `C-c [` | cmd(reftex-citation) | insert a citation |
| — | cmd(reftex-reparse) | rebuild the document database (`M-x`) |
