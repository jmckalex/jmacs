Title: jmacs LaTeX & RefTeX Commands
Author: J. McKenzie Alexander
Date: 2026-06-11
---

## LaTeX and RefTeX commands

This document describes the commands `latex-mode` adds for authoring
LaTeX — the AUCTeX-style compile/view loop, smart insertion, math,
navigation and filling — together with the RefTeX layer for labels,
cross-references and citations. They are ordinary Lisp, defined across
`packages/stdlib/lisp/latex*.lisp` and `reftex*.lisp`, built on the
buffer primitives, the LaTeX/SyncTeX/citation host primitives, and the
completing minibuffer.

Almost every binding lives under the `C-c` prefix of `latex-mode-map`,
so these commands are active only in a LaTeX buffer; that mode keymap
shadows the global keymap for LaTeX buffers. A few commands bind a
top-level key (`M-RET`, `"`, `M-q`). Commands without a binding are
reachable by name with `M-x` and from the structured LaTeX menu
(`latex-menu.lisp`). See `commands.md` for how to read an entry and
what the conventions mean.

Key bindings are given in the manual's notation: `C-` is Control or
Command, `M-` is Option, `S-` is Shift. The literal backtick key is
written `` ` ``.

---

### Compiling and viewing

Defined in `latex-compile.lisp` — AUCTeX's `TeX-command-master` loop.
The build runs `*latex-command*` (a token list, default `latexmk`) in
the source file's directory via `run-process!`; the log lands in a
*TeX output* tab and the parsed diagnostics in a *TeX errors* tab in
the utility dock. The file built is `(latex-master-file)` — under
RefTeX (`reftex.lisp`) this is the detected master, not necessarily the
current buffer.

:::function{name="latex-compile" path="reference/latex/latex-compile.html"}
#### `latex-compile`
`(latex-compile)`

Save the buffer and build the LaTeX document with `*latex-command*`,
routing the log into a *TeX output* view and the parsed diagnostics
into *TeX errors*. On a clean build the open PDF preview is reloaded in
place. If the configured program is not on `PATH`, retries once with a
single `pdflatex` pass. Bound to `C-c C-c`. See also cmd(latex-view)
and cmd(latex-next-error).
:::

:::function{name="latex-view" path="reference/latex/latex-view.html"}
#### `latex-view`
`(latex-view)`

Open the built PDF for `(latex-master-file)` beside the source, or
reload it if already open, then forward-search to the current source
line and flash a highlight there (the SyncTeX integration folds forward
search into this command). The PDF path is the `.tex` with its
extension swapped to `.pdf` in the same directory; run cmd(latex-compile)
first if it does not exist. Bound to `C-c C-v`. See also
cmd(latex-forward-search).
:::

:::function{name="latex-next-error" path="reference/latex/latex-next-error.html"}
#### `latex-next-error`
`(latex-next-error)`

Visit the next LaTeX diagnostic from the last build: open its file,
jump to its line, and echo the message. Clamps at the end with a "no
more errors" message. Run cmd(latex-compile) first to populate the
list. Bound to `` C-c ` ``. See also cmd(latex-previous-error).
:::

:::function{name="latex-previous-error" path="reference/latex/latex-previous-error.html"}
#### `latex-previous-error`
`(latex-previous-error)`

Visit the previous LaTeX diagnostic from the last build, the companion
to cmd(latex-next-error). Clamps at the start. Unbound by default —
run it with `M-x` or from the LaTeX menu.
:::

:::function{name="latex-show-output" path="reference/latex/latex-show-output.html"}
#### `latex-show-output`
`(latex-show-output)`

Bring the *TeX output* tab forward in the utility dock with the last
build's full toolchain log, if any. A convenience for inspecting raw
output. Unbound by default — run it with `M-x` or from the LaTeX menu.
:::

### SyncTeX

Defined in `latex-synctex.lisp` — two-way sync between the `.tex`
source and the in-app PDF viewer via the `synctex` CLI
(`*synctex-command*`). The compile emits `-synctex=1`, so the
`.synctex.gz` sits beside the PDF.

:::function{name="latex-forward-search" path="reference/latex/latex-forward-search.html"}
#### `latex-forward-search`
`(latex-forward-search)`

Forward SyncTeX from point: jump the open PDF to the typeset spot of
the current source line and flash a highlight there. Runs `synctex
view` and reports a no-match or missing-PDF condition in the status
line. cmd(latex-view) calls this after ensuring the PDF is shown; it is
also a command in its own right (registered with `register-command!`),
so `M-x latex-forward-search` works. Unbound by default.

Inverse search (PDF → source) is not a named command: an Option-click
in the pdf-view fires the host-side `latex-synctex-inverse`, which runs
`synctex edit` and reveals the source line in a text pane.
:::

### Writing LaTeX

Defined in `latex.lisp` (the quick wraps and stub environments) and
`latex-insert.lisp` (the completing pickers). The wraps are built on
the `latex-surround` helper: with a region active they wrap it, with no
region they insert the pair and place point between the braces.

:::function{name="latex-insert-environment" path="reference/latex/latex-insert-environment.html"}
#### `latex-insert-environment`
`(latex-insert-environment)`

Insert a `\begin{ENV}…\end{ENV}` environment chosen in the minibuffer
with TAB completion over `*latex-environments*` merged with the
environments already used in the buffer. The body is templated per kind
(itemize/enumerate → `\item`; description → `\item[]`; figure/table →
`\centering`/`\caption`/`\label`; tabular → a column-spec prompt;
equation/align/… → a math body line), with point on the content line.
An active region is wrapped as the body. Bound to `C-c C-e`. See also
cmd(latex-close-environment).
:::

:::function{name="latex-close-environment" path="reference/latex/latex-close-environment.html"}
#### `latex-close-environment`
`(latex-close-environment)`

Close the innermost currently-open LaTeX environment: scan from the
buffer start to point tracking `\begin`/`\end` nesting, find the
unmatched innermost `\begin{X}`, and insert `\end{X}` (indented to the
current line). Reports and does nothing when no environment is open.
Bound to `C-c ]`.
:::

:::function{name="latex-insert-macro" path="reference/latex/latex-insert-macro.html"}
#### `latex-insert-macro`
`(latex-insert-macro)`

Insert a `\NAME{}` macro chosen in the minibuffer with TAB completion
over `*latex-macros*` merged with the `\macro`s already used in the
buffer. Point lands inside the braces; an active region is wrapped as
the argument. A leading backslash typed by the user is stripped. Bound
to `C-c C-m`.
:::

:::function{name="latex-insert-section" path="reference/latex/latex-insert-section.html"}
#### `latex-insert-section`
`(latex-insert-section)`

Insert a sectioning command chosen in the minibuffer with TAB
completion over the levels part/chapter/section/subsection/
subsubsection/paragraph/subparagraph (empty defaults to `section`).
Point lands in the braces; an active region is wrapped as the title.
When `*latex-section-insert-label*` is on, a `\label{}` follows. Bound
to `C-c C-s`. The quick wraps cmd(latex-section) and cmd(latex-subsection)
remain.
:::

:::function{name="latex-section" path="reference/latex/latex-section.html"}
#### `latex-section`
`(latex-section)`

Wrap the selection in `\section{…}` (or insert the pair with point
between the braces). The quick wrap, distinct from the completing
cmd(latex-insert-section). Bound to `C-c s`.
:::

:::function{name="latex-subsection" path="reference/latex/latex-subsection.html"}
#### `latex-subsection`
`(latex-subsection)`

Wrap the selection in `\subsection{…}` (or insert the pair with point
between the braces). Bound to `C-c S`.
:::

:::function{name="latex-itemize" path="reference/latex/latex-itemize.html"}
#### `latex-itemize`
`(latex-itemize)`

Insert a stub `itemize` environment with point after the first
`\item`. Bound to `C-c l`. The richer cmd(latex-insert-environment)
(`C-c C-e`) templates any environment.
:::

:::function{name="latex-enumerate" path="reference/latex/latex-enumerate.html"}
#### `latex-enumerate`
`(latex-enumerate)`

Insert a stub `enumerate` environment with point after the first
`\item`. Bound to `C-c n`.
:::

:::function{name="latex-insert-item" path="reference/latex/latex-insert-item.html"}
#### `latex-insert-item`
`(latex-insert-item)`

Inside a list environment (the innermost enclosing itemize / enumerate
/ description at point), open a new line indented to the current line
and insert `\item ` (for `description`, `\item[] ` with point inside
the brackets). Outside a list, fall back to a plain newline-and-indent.
Bound to `M-RET` (the renderer's `M-enter`).
:::

### Fonts

Defined in `latex.lisp` (bf/it/emph) and `latex-insert.lisp` (the rest).
All are `latex-surround` wraps. Beyond their own `C-c` keys they are
collected in the AUCTeX-style `C-c C-f` font sub-map, where both a plain
letter and its control form select the same command (so `C-c C-f e` and
`C-c C-f C-e` both insert `\emph{}`).

:::function{name="latex-textbf" path="reference/latex/latex-textbf.html"}
#### `latex-textbf`
`(latex-textbf)`

Wrap the selection in `\textbf{…}` (bold). Bound to `C-c b` and
`C-c C-f b`.
:::

:::function{name="latex-textit" path="reference/latex/latex-textit.html"}
#### `latex-textit`
`(latex-textit)`

Wrap the selection in `\textit{…}` (italic). Bound to `C-c i` and
`C-c C-f i`.
:::

:::function{name="latex-emph" path="reference/latex/latex-emph.html"}
#### `latex-emph`
`(latex-emph)`

Wrap the selection in `\emph{…}` (emphasis). Bound to `C-c e` and
`C-c C-f e`.
:::

:::function{name="latex-texttt" path="reference/latex/latex-texttt.html"}
#### `latex-texttt`
`(latex-texttt)`

Wrap the selection in `\texttt{…}` (monospace). Bound to `C-c C-f t`.
:::

:::function{name="latex-textsc" path="reference/latex/latex-textsc.html"}
#### `latex-textsc`
`(latex-textsc)`

Wrap the selection in `\textsc{…}` (small caps). Bound to `C-c C-f c`.
:::

:::function{name="latex-textsl" path="reference/latex/latex-textsl.html"}
#### `latex-textsl`
`(latex-textsl)`

Wrap the selection in `\textsl{…}` (slanted). Bound to `C-c C-f s`.
:::

:::function{name="latex-textrm" path="reference/latex/latex-textrm.html"}
#### `latex-textrm`
`(latex-textrm)`

Wrap the selection in `\textrm{…}` (roman). Bound to `C-c C-f r`.
:::

:::function{name="latex-textsf" path="reference/latex/latex-textsf.html"}
#### `latex-textsf`
`(latex-textsf)`

Wrap the selection in `\textsf{…}` (sans serif). Bound to `C-c C-f f`.
:::

:::function{name="latex-textmd" path="reference/latex/latex-textmd.html"}
#### `latex-textmd`
`(latex-textmd)`

Wrap the selection in `\textmd{…}` (medium weight). Bound to
`C-c C-f m`.
:::

### Math

Defined in `latex.lisp` (the math wraps and the inline-preview toggle)
and `latex-math.lisp` (the LaTeX-math abbreviation minor mode). The
abbreviation mode and the preview mode are independent minor modes that
compose freely.

:::function{name="latex-math-inline" path="reference/latex/latex-math-inline.html"}
#### `latex-math-inline`
`(latex-math-inline)`

Wrap the selection in `$…$` (or insert the pair with point between).
Bound to `C-c m`. See also cmd(latex-math-display).
:::

:::function{name="latex-math-display" path="reference/latex/latex-math-display.html"}
#### `latex-math-display`
`(latex-math-display)`

Wrap the selection in `\[ … \]` (or insert the pair with point
between). Bound to `C-c M`.
:::

:::function{name="toggle-latex-math-mode" path="reference/latex/toggle-latex-math-mode.html"}
#### `toggle-latex-math-mode`
`(toggle-latex-math-mode)`

Toggle the LaTeX math symbol-insertion minor mode in the current
buffer. With it on, the prefix key (default `` ` ``,
`*latex-math-abbrev-prefix*`) arms a one-key read that inserts a LaTeX
math macro from `*latex-math-symbols*` (`` `a `` → `\alpha`, `` `> `` →
`\geq`, …); the prefix typed twice inserts a literal prefix, and an
unmapped key opens a completion prompt over the macro names. Bound to
`C-c ~`. Off by default; `*latex-math-mode-default*` records the
intended default.
:::

:::function{name="toggle-latex-math-preview" path="reference/latex/toggle-latex-math-preview.html"}
#### `toggle-latex-math-preview`
`(toggle-latex-math-preview)`

Toggle live inline MathJax typesetting for the current LaTeX buffer:
math segments render typeset in place of their source and flip back to
source for editing when point enters them. An alias of the general
`math-preview-mode`. Bound to `C-c C-p`. Off by default;
`*latex-math-preview-default*` records the intended default.
:::

### Navigation

Defined in `latex-nav.lisp` — the small daily motions, plus the
context-sensitive quote on `latex-mode`. The section motions scan the
current buffer's own text, so they work without a built RefTeX document
database.

:::function{name="latex-next-section" path="reference/latex/latex-next-section.html"}
#### `latex-next-section`
`(latex-next-section)`

Move point to the start of the next sectioning command (part / chapter
/ section / subsection / subsubsection / paragraph / subparagraph,
starred forms included), echoing the section title. Clamps at the last
section. Bound to `C-c C-n`. See also cmd(latex-previous-section).
:::

:::function{name="latex-previous-section" path="reference/latex/latex-previous-section.html"}
#### `latex-previous-section`
`(latex-previous-section)`

Move point to the start of the previous sectioning command, the
companion to cmd(latex-next-section). Clamps at the first section.
Bound to `C-c C-r`.
:::

:::function{name="latex-goto-matching-env" path="reference/latex/latex-goto-matching-env.html"}
#### `latex-goto-matching-env`
`(latex-goto-matching-env)`

When point is on (or within the macro of) a `\begin{X}`, jump to its
matching `\end{X}`; when on an `\end{X}`, jump to the matching
`\begin{X}` — respecting nested same-name environments. Echoes the env
name; a no-op (with a status message) when point isn't on a begin/end
or the document is unbalanced. Bound to `C-c %`.
:::

:::function{name="latex-smart-quote" path="reference/latex/latex-smart-quote.html"}
#### `latex-smart-quote`
`(latex-smart-quote)`

Insert a context-sensitive LaTeX quote on the `"` key: ` `` ` (open)
after whitespace / line start / an opening delimiter, `''` (close)
otherwise. A double-press — typing `"` right after a `"`, `` ` `` or
`'` — inserts a single straight `"`, so a literal quote stays
reachable (AUCTeX's `TeX-insert-quote`). Bound to `"` in latex-mode.
The decision looks only at the character before point — it does not
detect math or verbatim context.
:::

:::function{name="latex-fill-paragraph" path="reference/latex/latex-fill-paragraph.html"}
#### `latex-fill-paragraph`
`(latex-fill-paragraph)`

Re-wrap the paragraph around point AUCTeX-style: fill prose to
`*latex-fill-column*` and re-indent every line of the enclosing block
by its environment depth (using `*latex-indent-level*` spaces per
level, `\item` lines pulled back by `*latex-item-indent*`). Structural
lines (`\begin`/`\end`/`\item`/display math) are re-indented in place,
never merged into prose. A paragraph command (`\caption{…}`,
`\section{…}`, …) is its own fill unit spanning the macro's extent —
gathered to its closing `}` and re-wrapped, continuation lines indented
`*latex-brace-indent-level*` per brace still open at the break
(AUCTeX's `TeX-brace-indent-level`); `\noindent`/`\newblock` lead in an
ordinary prose paragraph. Comment paragraphs fill
behind their `%`-run prefix; a code line's trailing comment ends its
fill unit and stays glued, unfilled. Inline `\(…\)`/`\[…\]` math never
breaks across lines when `*latex-fill-break-at-separators*` is on
(default), and a `\verb` group never breaks at all;
`*latex-sentence-end-double-space*` (default off) enables Emacs's
two-space sentence joins. A verbatim / tabular / math-alignment
environment inside the block passes through byte-identical, and point
stays at its position in the prose. A blank line, or point inside such
an environment, leaves the buffer unchanged. Bound to `M-q` in
latex-mode, overriding the global cmd(fill-paragraph).
:::

### Labels and references

Defined in `reftex.lisp` (the multi-file document model) and
`reftex-refs.lisp` (the daily label/reference commands and the
`*RefTeX Select*` picker). The document model detects the master file,
resolves `\input`/`\include` transitively, and builds a cross-file
database of labels, sections, refs and cites that these commands query.

:::function{name="reftex-label" path="reference/latex/reftex-label.html"}
#### `reftex-label`
`(reftex-label)`

Insert a `\label{KEY}` at point with a smart, unique key. The type is
inferred from the innermost enclosing environment (equation / figure /
table / listing / …) or a preceding sectioning command; the key is
`<prefix><slug-of-caption-or-title>`, made unique against the
document's existing labels. With `*reftex-label-confirm*` (the default)
the suggested key is offered in the minibuffer for editing. Bound to
`C-c (`. See also cmd(reftex-reference).
:::

:::function{name="reftex-reference" path="reference/latex/reftex-reference.html"}
#### `reftex-reference`
`(reftex-reference)`

Insert a reference to a label chosen in the `*RefTeX Select*` view —
RefTeX's selection-first picker. Rows are grouped by type and show a
context line; `n`/`p` move, `RET` inserts `<macro>{name}` at the
originating point, `SPC` peeks at the source, typing filters, `q`
cancels. The macro is chosen by the label's type (`\eqref` for
equations, else `\ref`). Bound to `C-c )`. For the know-the-key
minibuffer flow, see cmd(reftex-reference-minibuffer).
:::

:::function{name="reftex-reference-minibuffer" path="reference/latex/reftex-reference-minibuffer.html"}
#### `reftex-reference-minibuffer`
`(reftex-reference-minibuffer)`

Insert a `\ref`/`\eqref`/… to a label chosen in the minibuffer with TAB
completion over the document's label names — the know-the-key
fast-path. The macro is chosen by the label's type. This is the
alternative to cmd(reftex-reference)'s select view (and what to use
when there is no document to populate it). Unbound by default — run it
with `M-x` or from the LaTeX menu.
:::

:::function{name="reftex-reparse" path="reference/latex/reftex-reparse.html"}
#### `reftex-reparse`
`(reftex-reparse)`

Clear the RefTeX database cache and rebuild the current document's
model, echoing how many files and labels were scanned (RefTeX's
`r`/`g`). Run this after editing files other than the current buffer,
whose slice is always rebuilt live. Unbound by default — run it with
`M-x` or from the LaTeX menu.
:::

### Citations

Defined in `reftex-cite.lisp` — RefTeX's format-first citation flow.
The bibliography comes from the document's `\bibliography` /
`\addbibresource` (plus `*citation-bib-path*`); entries are shown as
professionally formatted references (citation.js + the
`*reftex-cite-style*` CSL style) purely as a picking aid, while the
inserted text is always the `\cite`-family macro over the bib keys.

:::function{name="reftex-citation" path="reference/latex/reftex-citation.html"}
#### `reftex-citation`
`(reftex-citation)`

Insert a citation. Choose a cite format (`\cite` / `\citep` / `\citet`
/ … from `*reftex-cite-format*`) in a bottom format menu, then pick one
or more entries in the cite picker (`m` marks several, `RET` inserts
`<macro>{k1,k2}` at the origin). A no-op with a status message when no
readable bibliography is found. Bound to `C-c [`.
:::

### Not yet implemented

A `latex-clean` command (delete the auxiliary build by-products listed
in `*latex-clean*` — `.aux`, `.log`, `.synctex.gz`, …) is **not yet
implemented**: the host exposes no Lisp-callable file-deletion
primitive. The `*latex-clean*` setting documents the intended extension
list until such a primitive lands. Likewise `*latex-bibtex-command*` is
only a configuration seam for an explicit bibliography pass — there is
no `latex-bibtex` command; the default `latexmk` build runs bibtex
itself.
