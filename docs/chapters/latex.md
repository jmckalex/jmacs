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
cite the literature.

Throughout, `C-` is Control or Command, `M-` is Option, `S-` is Shift.

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

The build runs in the document's own directory, and its output is *not*
streamed into a pane. When the toolchain exits, the whole log lands in a
read-only **TeX output** tab in the utility dock, and the log is parsed
into diagnostics that populate a **TeX errors** tab. A compile never
steals a pane or moves focus. The echo area summarises the outcome —
`LaTeX: success`, `LaTeX: success (3 warnings)`, or
`LaTeX: 2 errors — C-c ` to visit`.

cmd(latex-view) — `C-c C-v` — shows the built PDF. The PDF path is the
`.tex` with its extension swapped to `.pdf`, in the same directory. If
the PDF is not already on screen, the source pane is split to the right
and the PDF opened in the new pane, so source and output sit side by
side; if it is already open, its bytes are reloaded in place. Run
`C-c C-c` first if there is no PDF yet — `latex-view` will tell you so
rather than open an empty pane. (In a document with SyncTeX, `C-c C-v`
also jumps the PDF to the line you are on; see the next section.)

You rarely need to refresh the preview by hand: after a clean build,
cmd(latex-compile) reloads an already-open PDF automatically, so the
output beside your source stays current as you recompile.

When a build reports errors, walk them with cmd(latex-next-error) —
`C-c ` ` — which visits the next diagnostic from the last build, opening
its file, jumping to its line, and echoing the message. Its companion
cmd(latex-previous-error) steps backward (bound by name, reachable via
`M-x`). cmd(latex-show-output) brings the raw **TeX output** tab forward
when you want to read the unparsed log.

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

**Forward — source to PDF.** With the PDF open, cmd(latex-view)
(`C-c C-v`) does more than reload: after the PDF is on screen it runs a
forward search from point — `synctex view` on the current line and
column — and scrolls the PDF to the corresponding page, flashing a
transient highlight over the typeset spot. So `C-c C-v` is both
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
becomes the title. When `*latex-section-insert-label*` is on, a
`\label{}` is dropped on the next line, pre-seeded with the section
prefix.

**Environments.** cmd(latex-insert-environment) — `C-c C-e` — reads an
environment name in the minibuffer, completing over a built-in list
merged with the `\begin{…}`s already used in the buffer, and inserts a
`\begin{ENV}…\end{ENV}` block templated to the kind: `itemize` and
`enumerate` get an `\item`; `description` gets `\item[]`; `figure` and
`table` get `\centering`, `\caption{}` and `\label{}`; `tabular` prompts
for a column spec; the math environments get a body line. Point lands on
the content line. An active region is wrapped as the body. The quick
stubs cmd(latex-itemize) (`C-c l`) and cmd(latex-enumerate) (`C-c n`)
remain for the two common lists.

cmd(latex-close-environment) — `C-c ]` — closes the innermost open
environment: it scans from the top of the buffer to point, finds the
unmatched innermost `\begin{X}`, and inserts a correctly-indented
`\end{X}` at point, echoing which environment it closed.

**Macros.** cmd(latex-insert-macro) — `C-c C-m` — inserts an arbitrary
`\NAME{}` chosen in the minibuffer, completing over a built-in macro
list merged with the `\macro`s already in the buffer. Point lands inside
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
uppercase Greek or the big operators and quantifiers, and the spare
capitals carry the variant forms (`` `V `` → `\varepsilon`,
`` `j `` → `\varphi`). Pressing the prefix twice inserts a literal
prefix character; an unmapped key opens a completion prompt over the
macro names so you can pick a symbol by name. Changing the prefix in
Customize rebuilds the keymap live.

The math-abbrev mode is distinct from the *math-preview* minor mode,
which typesets math in place as you read. Toggle the latter with `C-c C-p`
(cmd(toggle-latex-math-preview)); it is the LaTeX face of the general
preview engine, and is covered in the Writing chapter — see there for how
inline and display math render and flip back to source when point enters
them.

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
the way AUCTeX's `LaTeX-fill-paragraph` does, filling prose to
`*latex-fill-column*` and re-indenting the enclosing block by its
environment depth. Structural lines (`\begin`/`\end`, `\item`,
sectioning, display math) are re-indented in place, never merged into
prose; point inside a `verbatim`, `tabular` or math-alignment environment
leaves the buffer untouched.

A grouped **LaTeX** menu collects all of these into submenus — Compile &
View, Insert, Fonts, Math, References, Navigation — so the commands are
discoverable without memorising the keys.

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

RefTeX builds a database — labels, sections, references, citations,
inputs and bibliography paths — once and caches it per master. The file
you are typing in is always rescanned live, so its labels are never
stale; other files are read from disk at build time. cmd(reftex-reparse)
clears the cache and rebuilds, echoing how many files and labels it
scanned — run it (RefTeX's `g`) after editing a file other than the
current buffer.

**Inserting labels.** cmd(reftex-label) — `C-c (` — inserts a
`\label{KEY}` with a smart, unique key. The label's *type* is inferred
from the innermost enclosing environment — `equation`, `align` and the
other math environments give an `eq:` key, `figure` gives `fig:`,
`table` gives `tab:`, and so on — or from a sectioning command on the
line above (`sec:`). The stem comes from the nearest `\caption{}` (for
figures and tables) or the enclosing section title, slugified, and the
whole key is made unique against the labels already in the document
(`-2`, `-3`, … as needed). By default (`*reftex-label-confirm*`) the
suggested key is offered in the minibuffer for you to edit before it is
inserted; either way uniqueness is enforced on what you finally accept.
The prefixes are configurable through `*reftex-label-prefixes*` and
`*reftex-label-default-prefix*`.

**Inserting references.** cmd(reftex-reference) — `C-c )` — is RefTeX's
signature *selection-first* picker. It opens the **RefTeX Select** view,
a drawer overlaid on the right edge of the editor with the document's
labels grouped by type, each row showing a context line — the label's
own source line, or its enclosing section. `n` and `p` move between
candidates, typing filters them, `t` cycles the type filter, `SPC`
*peeks* at a label's source (jumping the editor pane underneath without
dismissing the picker), `RET` inserts the reference at the point you
started from, and `q` cancels. The macro is chosen from the label's
type: equations get `\eqref`, everything else `\ref`
(`*reftex-ref-macro-by-type*` / `*reftex-ref-macro-default*`).

When you already know the key, cmd(reftex-reference-minibuffer) (via
`M-x`) is the fast path: it reads the label name in the minibuffer with
TAB completion over the document's labels and inserts the same
type-chosen macro. This is also what runs when there is no document
available to populate the select view.

### Citations

cmd(reftex-citation) — `C-c [` — inserts a citation, following RefTeX's
*format-first* flow.

First a small **format menu** opens in a bottom panel listing the
citation commands from `*reftex-cite-format*` — `\cite` (the `RET`
default), `\citep`, `\citet` (natbib), `\parencite`, `\textcite`
(biblatex), `\citeauthor`, `\citeyear` — each selectable on a single
key. Pick one and the panel swaps for the **cite picker**: the document's
bibliography entries, each rendered as a professionally formatted
reference, searchable by key, author, year or title, with `m` to mark
several. `RET` inserts `<macro>{key1,key2,…}` at the point you started
from.

The bibliography is the document's own — every `\bibliography` and
`\addbibresource` found while scanning, plus the global
`*citation-bib-path*` if it is set. The references in the picker are
formatted with the CSL style named by `*reftex-cite-style*` (a built-in
id such as `harvard1`, `apa` or `vancouver`, or the path to any `.csl`
file). That formatting is a *picking aid only*: the text actually
inserted is always the LaTeX `\cite`-family macro over the raw bib keys,
so BibTeX or biblatex still owns the typeset result. Entries that the
formatter cannot parse — some real-world TeX-accent forms throw — are
skipped rather than blanking the whole picker, and the echo area notes
how many were dropped.

The format set is fully configurable: narrow `*reftex-cite-format*` to a
single package family, or extend it, by customising that setting.

---

#### Command and key summary

**Compile and view** — cmd(latex-compile) `C-c C-c` · cmd(latex-view)
`C-c C-v` · cmd(latex-next-error) `C-c ` ` · cmd(latex-previous-error) ·
cmd(latex-show-output).

**SyncTeX** — forward search folded into cmd(latex-view) `C-c C-v`, also
cmd(latex-forward-search); inverse search on Option-click in the PDF
view.

**Insertion** — cmd(latex-insert-environment) `C-c C-e` ·
cmd(latex-close-environment) `C-c ]` · cmd(latex-insert-macro) `C-c C-m`
· cmd(latex-insert-section) `C-c C-s` · cmd(latex-itemize) `C-c l` ·
cmd(latex-enumerate) `C-c n` · cmd(latex-section) `C-c s` ·
cmd(latex-subsection) `C-c S`.

**Fonts** (`C-c C-f` sub-map, and quick `C-c b/i/e`) —
cmd(latex-textbf) · cmd(latex-textit) · cmd(latex-emph) ·
cmd(latex-texttt) · cmd(latex-textsc) · cmd(latex-textsl) ·
cmd(latex-textrm) · cmd(latex-textsf) · cmd(latex-textmd).

**Math** — cmd(latex-math-inline) `C-c m` · cmd(latex-math-display)
`C-c M` · cmd(toggle-latex-math-mode) `C-c ~` ·
cmd(toggle-latex-math-preview) `C-c C-p`.

**Navigation and typing** — cmd(latex-next-section) `C-c C-n` ·
cmd(latex-previous-section) `C-c C-r` · cmd(latex-goto-matching-env)
`C-c %` · cmd(latex-insert-item) `M-RET` · cmd(latex-smart-quote) `"` ·
cmd(latex-fill-paragraph) `M-q`.

**RefTeX** — cmd(reftex-label) `C-c (` · cmd(reftex-reference) `C-c )` ·
cmd(reftex-reference-minibuffer) · cmd(reftex-citation) `C-c [` ·
cmd(reftex-reparse).
