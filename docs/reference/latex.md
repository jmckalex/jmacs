Title: Godot LaTeX & RefTeX Commands
Author: J. McKenzie Alexander
Date: 2026-07-21
---

## LaTeX and RefTeX commands

This document describes the commands `latex-mode` adds for authoring
LaTeX — the AUCTeX-style compile/view loop, smart insertion, math,
navigation and filling — together with the RefTeX layer for labels,
cross-references and citations, and closes with the *settings*
(`defcustom` variables) that govern them. They are ordinary Lisp,
defined across `packages/stdlib/lisp/latex*.lisp` and `reftex*.lisp`,
built on the buffer primitives, the LaTeX/SyncTeX/citation host
primitives, and the completing minibuffer. The LaTeX chapter of the
manual covers the same ground as a workflow; this file is the
per-command reference. The JMarkdown authoring stack
(`jmarkdown-compile.lisp`, `jmarkdown-insert.lisp`,
`jmarkdown-nav.lisp`, `jmarkdown-ref.lisp`) deliberately mirrors these
commands for `.jmd` buffers — see the JMarkdown chapter.

Almost every binding lives under the `C-c` prefix of `latex-mode-map`,
so these commands are active only in a LaTeX buffer; that mode keymap
shadows the global keymap for LaTeX buffers. A few commands bind a
top-level key (`M-RET`, `"`, `M-q`). Commands without a binding are
reachable by name with `M-x` and from the structured LaTeX menu
(`latex-menu.lisp`). See `commands.md` for how to read an entry and
what the conventions mean.

Key bindings are given in the manual's notation: `C-` is Control,
`M-` is Command (the Cmd key), `A-` is Option, `S-` is Shift. `M-RET`
is Command+Return — the renderer's name for the key is `M-enter`. The
literal backtick key is written `` ` ``.

---

### Compiling and viewing

Defined in `latex-compile.lisp` — AUCTeX's `TeX-command-master` loop.
The build runs `*latex-command*` (a token list; default `latexmk -pdf
-synctex=1 -interaction=nonstopmode`) in the source file's directory
via `run-process!`; the log lands in a *TeX output* tab and the parsed
diagnostics in a *TeX errors* tab in the utility dock. Each *TeX
errors* row is occur-style `FILE:LINE: message` (warnings carry a
`warning:` prefix), for example:

    paper.tex:42: Undefined control sequence.

The file built is `(latex-master-file)` — the document's master, not
necessarily the current buffer. With RefTeX loaded (`reftex.lisp`, the
normal case) the master is found by a detection ladder: the
`*reftex-master*` override when set (a relative path resolves against
the current file's directory); else a `% !TEX root = …` magic comment
in the current file; else the current file itself when it contains a
`\documentclass`; else who-includes-me — a sibling or parent `.tex`
that `\input`s this file (a single unambiguous hit, preferring one
with `\documentclass`); else the current file is its own master.

:::function{name="latex-compile" path="reference/latex/latex-compile.html"}
#### `latex-compile`
`(latex-compile)`

Save the buffer and build the LaTeX document with `*latex-command*`,
routing the log into a *TeX output* view and the parsed diagnostics
into *TeX errors*. On a clean build the open PDF preview is reloaded in
place. If the configured program is not on `PATH`, retries once with a
single `pdflatex` pass — one pass only, with no auto-rerun for
references and no bibtex; set `*latex-command*` explicitly for full
control of a pdflatex workflow. Bound to `C-c C-c`. See also
cmd(latex-view) and cmd(latex-next-error).
:::

:::function{name="latex-view" path="reference/latex/latex-view.html"}
#### `latex-view`
`(latex-view)`

Open the built PDF for `(latex-master-file)` beside the source, or
reload it if already open, then forward-search to the current source
line and flash a highlight there (the SyncTeX integration folds forward
search into this command). The PDF path is the `.tex` with its
extension swapped to `.pdf` in the same directory; run cmd(latex-compile)
first if it does not exist. The PDF view it opens persists across a
relaunch by default (`*latex-pdf-restore*`, default `#t`), so
reopening the editor restores the source-beside-PDF split. Bound to
`C-c C-v`. See also cmd(latex-forward-search).
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
(`*synctex-command*`, default `synctex`). The compile emits
`-synctex=1`, so the `.synctex.gz` sits beside the PDF.

One macOS gotcha up front: a GUI-launched app inherits a `PATH` that
may lack `/Library/TeX/texbin`, so the bare `synctex` can be "not
found" even though it works in a terminal. Set `*synctex-command*` to
a full path — `'("/Library/TeX/texbin/synctex")` — if the status line
reports `synctex not found`.

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
in the pdf-view invokes the Lisp procedure `latex-synctex-inverse`
through the viewer's click hook, which runs `synctex edit` and reveals
the source line in a text pane — never in the PDF's own pane.
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

When the innermost open environment at point is a list (itemize /
enumerate / description), open a new line indented to the current line
and insert `\item ` (for `description`, `\item[] ` with point inside
the brackets). The test is the *innermost* environment: `M-RET` in an
itemize nested inside a figure inserts an `\item`, but with some other
environment open inside the list — a `minipage`, say — it does not.
Outside a list, fall back to a plain newline-and-indent. Bound to
`M-RET`.
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
`*latex-math-abbrev-prefix*`) arms cmd(latex-math-insert-symbol) — a
one-key read that inserts a LaTeX math macro from
`*latex-math-symbols*` (`` `a `` → `\alpha`, `` `> `` → `\geq`, …).
Bound to `C-c ~`. Off by default; `*latex-math-mode-default*` records
the intended default.
:::

:::function{name="latex-math-insert-symbol" path="reference/latex/latex-math-insert-symbol.html"}
#### `latex-math-insert-symbol`
`(latex-math-insert-symbol)`

Read one key and insert the LaTeX math macro it names from
`*latex-math-symbols*`. The prefix key typed again (`` ` `` then
`` ` ``) inserts a literal prefix character; an unmapped key opens a
completing prompt over the macro names, so a symbol can also be picked
by name. This is the command the math mode's prefix key arms, but it
is a command in its own right — `M-x latex-math-insert-symbol` works
even with the mode off. No key of its own (the prefix in
`latex-math-mode-map` is its binding).
:::

:::function{name="toggle-latex-math-preview" path="reference/latex/toggle-latex-math-preview.html"}
#### `toggle-latex-math-preview`
`(toggle-latex-math-preview)`

Toggle live inline MathJax typesetting for the current LaTeX buffer:
math segments render typeset in place of their source and flip back to
source for editing when point enters them. An alias of the general
`math-preview-mode` — see cmd(toggle-math-preview) in `commands.md`
and the Writing chapter for the mode-agnostic engine. Bound to
`C-c C-p`. Off by default; `*latex-math-preview-default*` records the
intended default.
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
after whitespace / line start / an opening delimiter (`(`, `[`, `{`,
`<`) / a dash `-` / a tie `~`, and `''` (close) otherwise. A
double-press — typing `"` right after a `"`, `` ` `` or `'` — inserts
a single straight `"`, so a literal quote stays reachable (AUCTeX's
`TeX-insert-quote`). Bound to `"` in latex-mode. The decision looks
only at the character before point — it does not detect math or
verbatim context.
:::

:::function{name="latex-fill-paragraph" path="reference/latex/latex-fill-paragraph.html"}
#### `latex-fill-paragraph`
`(latex-fill-paragraph)`

Re-wrap the paragraph around point AUCTeX-style. Prose fills to the
LaTeX fill column — 72, fixed to match the editor's generic fill (it
is not a defcustom) — and every line of the enclosing block re-indents
by its environment depth: `*latex-indent-level*` (default 2) spaces
per level, `\item` lines pulled back by `*latex-item-indent*` (default
-2). Environments named in `*latex-non-indenting-environments*`
(default: `document`) add no level. Bound to `M-q` in latex-mode,
overriding the global cmd(fill-paragraph).

Structural lines (`\begin`/`\end`/`\item`/display math) are
re-indented in place, never merged into prose. A paragraph command
(`\caption{…}`, `\section{…}`, …) is its own fill unit spanning the
macro's extent — gathered to its closing `}` and re-wrapped;
`\noindent`/`\newblock` lead in an ordinary prose paragraph.

In every wrapped unit (prose, `\item` text, paragraph commands),
continuation lines indent `*latex-brace-indent-level*` (default 2)
spaces per brace still open at the break — AUCTeX's
`TeX-brace-indent-level` — so a mid-paragraph `\footnote{…}` spanning
lines brace-indents like a caption, dedenting after the closing `}`.

Comment paragraphs fill behind their `%`-run prefix; a code line's
trailing comment ends its fill unit and stays glued, unfilled.

Inline `\(…\)`/`\[…\]` math never breaks across lines while
`*latex-fill-break-at-separators*` is on (the default), and a `\verb`
group never breaks at all. `*latex-sentence-end-double-space*`
(default off) enables Emacs's two-space sentence joins.

A verbatim / tabular / math-alignment environment inside the block
passes through byte-identical, and point stays at its position in the
prose. A blank line, or point inside such an environment, leaves the
buffer unchanged.
:::

### Labels and references

Defined in `reftex.lisp` (the multi-file document model) and
`reftex-refs.lisp` (the daily label/reference commands and the
`*RefTeX Select*` picker). The document model detects the master file
(see the ladder under *Compiling and viewing*), resolves
`\input`/`\include` transitively, and builds a cross-file database of
labels, sections, refs and cites that these commands query.

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
originating point, `SPC` peeks at the source, `t` cycles the type
filter, typing filters, `q` cancels. The macro is chosen by the
label's type (`\eqref` for equations, else `\ref`). Bound to `C-c )`.
For the know-the-key minibuffer flow, see
cmd(reftex-reference-minibuffer).
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
`*reftex-cite-style*` CSL style, default `harvard1`) purely as a
picking aid, while the inserted text is always the `\cite`-family
macro over the bib keys.

:::function{name="reftex-citation" path="reference/latex/reftex-citation.html"}
#### `reftex-citation`
`(reftex-citation)`

Insert a citation. Choose a cite format (`\cite` / `\citep` / `\citet`
/ … from `*reftex-cite-format*`) in a bottom format menu, then pick one
or more entries in the cite picker (`m` marks several, `RET` inserts
`<macro>{k1,k2}` at the origin). A no-op with a status message when no
readable bibliography is found. Bound to `C-c [`.
:::

### Settings

These are `defcustom` variables, not procedures — user-facing settings
you can change live (`(custom-apply! 'name value)`), persist
(`(custom-apply-and-save! 'name value)`), or edit through `M-x
customize`. Each entry's signature line shows the default value. They
live in the `latex` and `reftex` customize groups except where noted;
`help-and-config.md` documents the customization machinery itself.

:::function{name="*latex-command*" path="reference/latex/latex-command.html"}
#### `*latex-command*`
`(default '("latexmk" "-pdf" "-synctex=1" "-interaction=nonstopmode"))`

The LaTeX build command as a list of strings — program followed by
flags; the source `.tex` filename is appended at build time.
`run-process!` spawns with no shell, so this is a token list, never a
single shell string. The default `latexmk` handles the multi-pass
rerun/bibtex dance itself; when it is not on `PATH`,
cmd(latex-compile) falls back to a single `pdflatex` pass. Group:
`latex`. Defined in `latex-compile.lisp`.
:::

:::function{name="*latex-bibtex-command*" path="reference/latex/latex-bibtex-command.html"}
#### `*latex-bibtex-command*`
`(default '("bibtex"))`

The bibliography command as a list of strings (program + flags).
Unused by the default build — `latexmk` runs bibtex/biber itself; this
is the configuration seam for an explicit bibliography pass (see *Not
yet implemented*). Group: `latex`. Defined in `latex-compile.lisp`.
:::

:::function{name="*latex-view*" path="reference/latex/latex-view-setting.html"}
#### `*latex-view*`
`(default 'pdf-view)`

The PDF viewer cmd(latex-view) uses. Only the built-in `'pdf-view`
(open / reload in a split beside the source) is supported; the setting
is the seam for external viewers (Skim, evince, …) later. Group:
`latex`. Defined in `latex-compile.lisp`.
:::

:::function{name="*latex-pdf-restore*" path="reference/latex/latex-pdf-restore.html"}
#### `*latex-pdf-restore*`
`(default #t)`

Whether the PDF cmd(latex-view) opens persists across a relaunch. `#t`
(the default) restores the latexed-output PDF beside its source on
relaunch; `#f` makes it transient like a generic PDF. Independent of
the global `*pdf-restore-default*`, which governs all *other* PDFs.
Group: `latex`. Defined in `latex-compile.lisp`.
:::

:::function{name="*latex-clean*" path="reference/latex/latex-clean.html"}
#### `*latex-clean*`
`(default '(".aux" ".log" ".out" ".synctex.gz" ".fdb_latexmk" ".fls" ".toc" ".bbl" ".blg"))`

Auxiliary file extensions a `latex-clean` command would delete — the
build by-products latexmk / pdflatex leave beside the source `.tex`.
The command itself is not yet implemented (see *Not yet implemented*);
the setting records the intended list. Group: `latex`. Defined in
`latex-compile.lisp`.
:::

:::function{name="*synctex-command*" path="reference/latex/synctex-command.html"}
#### `*synctex-command*`
`(default '("synctex"))`

The SyncTeX program as a list of strings (program + flags), used for
both forward (`synctex view`) and inverse (`synctex edit`) search.
Like `*latex-command*`, a token list — `run-process!` takes no shell.
On a macOS GUI launch the inherited `PATH` may miss
`/Library/TeX/texbin`; set this to a full path (e.g.
`'("/Library/TeX/texbin/synctex")`) if the bare name is not found.
Group: `latex`. Defined in `latex-synctex.lisp`.
:::

:::function{name="*latex-environments*" path="reference/latex/latex-environments.html"}
#### `*latex-environments*`
`(default: a 26-name list — itemize, enumerate, description, figure, table, equation, align, theorem, …)`

Candidate environment names offered by cmd(latex-insert-environment)
(`C-c C-e`), merged at prompt time with the `\begin{NAME}`
environments already used in the buffer. Add your document's recurring
environments here so they complete without first appearing in the
text. Group: `latex`. Defined in `latex-insert.lisp`.
:::

:::function{name="*latex-macros*" path="reference/latex/latex-macros.html"}
#### `*latex-macros*`
`(default: a 35-name list — textbf, emph, ref, cite, label, footnote, frac, sqrt, …)`

Candidate macro names (no leading backslash) offered by
cmd(latex-insert-macro) (`C-c C-m`), merged at prompt time with the
`\macro`s already used in the buffer. Group: `latex`. Defined in
`latex-insert.lisp`.
:::

:::function{name="*latex-section-insert-label*" path="reference/latex/latex-section-insert-label.html"}
#### `*latex-section-insert-label*`
`(default #f)`

When `#t`, cmd(latex-insert-section) (`C-c C-s`) inserts a `\label{}`
right after the sectioning macro (with a `sec:` key prefix, reusing
RefTeX's section prefix when RefTeX is loaded). Off by default — the
heading is inserted alone, and cmd(reftex-label) (`C-c (`) is the
richer way to add a label. Group: `latex`. Defined in
`latex-insert.lisp`.
:::

:::function{name="*latex-math-abbrev-prefix*" path="reference/latex/latex-math-abbrev-prefix.html"}
#### `*latex-math-abbrev-prefix*`
``(default "`")``

The prefix key for LaTeX-math-mode: pressing it then a symbol key
inserts the corresponding math macro (see
cmd(latex-math-insert-symbol)). Pressing the prefix twice inserts a
literal prefix character. Changing this rebuilds the mode keymap live
— no restart. Group: `latex`. Defined in `latex-math.lisp`.
:::

:::function{name="*latex-math-mode-default*" path="reference/latex/latex-math-mode-default.html"}
#### `*latex-math-mode-default*`
`(default #f)`

When `#t`, LaTeX-math-mode is *intended* to be on by default for LaTeX
buffers. Off by default — opt in per-buffer with
cmd(toggle-latex-math-mode). The flag records intent: auto-enable is
not wired from Lisp (there is no major-mode entry-hook seam), so the
setting exists to make the default discoverable and persistent.
Group: `latex`. Defined in `latex-math.lisp`.
:::

:::function{name="*latex-math-preview-default*" path="reference/latex/latex-math-preview-default.html"}
#### `*latex-math-preview-default*`
`(default #f)`

When `#t`, typeset math inline automatically for LaTeX buffers. Off by
default — opt in per-buffer with cmd(toggle-latex-math-preview), or
set this in your init / customisation to default it on. Group:
`godot` (not `latex`). Defined in `latex.lisp`.
:::

:::function{name="*latex-indent-level*" path="reference/latex/latex-indent-level.html"}
#### `*latex-indent-level*`
`(default 2)`

Number of spaces of indentation added for each enclosing LaTeX
environment (each unmatched `\begin`), mirroring AUCTeX's
`LaTeX-indent-level`. cmd(latex-fill-paragraph) (`M-q`) re-indents the
paragraph's lines by their environment depth times this value, using
spaces (never tabs). Group: `latex`. Defined in `latex-fill.lisp`.
:::

:::function{name="*latex-item-indent*" path="reference/latex/latex-item-indent.html"}
#### `*latex-item-indent*`
`(default -2)`

Extra indentation for an `\item` line relative to the environment
body, mirroring AUCTeX's `LaTeX-item-indent` (the negative of
`LaTeX-indent-level`). With the default, an `\item` line sits at the
list's body level and its wrapped continuation lines indent one
`*latex-indent-level*` deeper. Group: `latex`. Defined in
`latex-fill.lisp`.
:::

:::function{name="*latex-brace-indent-level*" path="reference/latex/latex-brace-indent-level.html"}
#### `*latex-brace-indent-level*`
`(default 2)`

Extra spaces of indentation per unclosed `{` for wrapped continuation
lines in cmd(latex-fill-paragraph) — AUCTeX's
`TeX-brace-indent-level`. Applies to every wrapped fill unit: a
paragraph command's argument, plain prose with a group spanning lines,
and `\item` text. Comment paragraphs are exempt (a `{` in comment text
is not a TeX group). Set 0 for flat continuations. Group: `latex`.
Defined in `latex-fill.lisp`.
:::

:::function{name="*latex-fill-break-at-separators*" path="reference/latex/latex-fill-break-at-separators.html"}
#### `*latex-fill-break-at-separators*`
`(default #t)`

When on, cmd(latex-fill-paragraph) never breaks a line inside an
inline `\(…\)` or `\[…\]` math group: the break lands before the
opening or after the closing delimiter, the whole group moving to the
next line when it straddles the fill column. Mirrors AUCTeX's
`LaTeX-fill-break-at-separators`. A `\verb` group is never broken
regardless of this option. Group: `latex`. Defined in
`latex-fill.lisp`.
:::

:::function{name="*latex-sentence-end-double-space*" path="reference/latex/latex-sentence-end-double-space.html"}
#### `*latex-sentence-end-double-space*`
`(default #f)`

When on, cmd(latex-fill-paragraph) puts *two* spaces after a
sentence-ending word when joining lines, and preserves an existing run
of two-or-more spaces between words — Emacs's
`sentence-end-double-space` fill rule, which AUCTeX inherits. Off by
default (Emacs defaults it on): with it off, all inter-word whitespace
collapses to a single space when filling. Group: `latex`. Defined in
`latex-fill.lisp`.
:::

:::function{name="*latex-non-indenting-environments*" path="reference/latex/latex-non-indenting-environments.html"}
#### `*latex-non-indenting-environments*`
`(default '("document"))`

Environment names whose body does *not* gain a level of indentation
from cmd(latex-fill-paragraph), mirroring AUCTeX's
`LaTeX-document-regexp`. With the default, content directly inside
`\begin{document}` stays at column 0. Add names here to treat other
wrapper environments the same way. Group: `latex`. Defined in
`latex-fill.lisp`.
:::

:::function{name="*reftex-master*" path="reference/latex/reftex-master.html"}
#### `*reftex-master*`
`(default "")`

Explicit master `.tex` path for RefTeX, overriding auto-detection.
Empty (the default) means auto-detect via the ladder described under
*Compiling and viewing*: `% !TEX root` magic comment, then
`\documentclass`, then who-includes-me, then the current file itself.
A relative value is resolved against the current file's directory;
`.tex` is appended when missing. Group: `reftex`. Defined in
`reftex.lisp`.
:::

:::function{name="*reftex-label-prefixes*" path="reference/latex/reftex-label-prefixes.html"}
#### `*reftex-label-prefixes*`
`(default: :equation→"eq:", :figure→"fig:", :table→"tab:", :section→"sec:", :listing→"lst:", :theorem→"thm:", :definition→"def:")`

Alist mapping a label's inferred `:type` to the prefix used when
cmd(reftex-label) suggests a key. A type not listed here uses
`*reftex-label-default-prefix*`. Group: `reftex`. Defined in
`reftex-refs.lisp`.
:::

:::function{name="*reftex-label-default-prefix*" path="reference/latex/reftex-label-default-prefix.html"}
#### `*reftex-label-default-prefix*`
`(default "")`

The label-key prefix cmd(reftex-label) uses when the type at point is
not in `*reftex-label-prefixes*` (an unrecognised environment, a bare
paragraph). Empty (the default) means the suggested key is just the
slugified stem. Group: `reftex`. Defined in `reftex-refs.lisp`.
:::

:::function{name="*reftex-ref-macro-by-type*" path="reference/latex/reftex-ref-macro-by-type.html"}
#### `*reftex-ref-macro-by-type*`
`(default: :equation→"\eqref")`

Alist mapping a label's `:type` to the reference macro
cmd(reftex-reference) inserts. A type not listed uses
`*reftex-ref-macro-default*`. Group: `reftex`. Defined in
`reftex-refs.lisp`.
:::

:::function{name="*reftex-ref-macro-default*" path="reference/latex/reftex-ref-macro-default.html"}
#### `*reftex-ref-macro-default*`
`(default "\ref")`

The reference macro cmd(reftex-reference) inserts for a label whose
`:type` is not in `*reftex-ref-macro-by-type*` (the common case).
Group: `reftex`. Defined in `reftex-refs.lisp`.
:::

:::function{name="*reftex-cite-macro*" path="reference/latex/reftex-cite-macro.html"}
#### `*reftex-cite-macro*`
`(default "\cite")`

The default citation macro RefTeX inserts. Group: `reftex`. Defined in
`reftex-refs.lisp`.
:::

:::function{name="*reftex-label-confirm*" path="reference/latex/reftex-label-confirm.html"}
#### `*reftex-label-confirm*`
`(default #t)`

When `#t` (the default), cmd(reftex-label) shows the suggested label
key in the minibuffer for confirmation/editing before inserting; when
`#f` it inserts the suggestion directly. Either way the key is made
unique against the document's existing labels. Group: `reftex`.
Defined in `reftex-refs.lisp`.
:::

:::function{name="*reftex-cite-style*" path="reference/latex/reftex-cite-style.html"}
#### `*reftex-cite-style*`
`(default "harvard1")`

The CSL style the citation picker formats each reference with: a
built-in id (`"apa"`, `"vancouver"`, `"harvard1"`) or the path to a
`.csl` file for any other style (registered with citation.js on first
use). Display only — the inserted text is still the `\cite`-family
macro over the bib keys. Distinct from `*citation-style*`, used by the
inline-citation commands. Group: `reftex`. Defined in
`reftex-cite.lisp`.
:::

:::function{name="*reftex-cite-format*" path="reference/latex/reftex-cite-format.html"}
#### `*reftex-cite-format*`
`(default: 7 rows — RET→\cite, p→\citep, t→\citet, P→\parencite, x→\textcite, a→\citeauthor, y→\citeyear)`

The citation formats the cmd(reftex-citation) format menu offers, as a
list of `(KEY MACRO DESCRIPTION)` rows. KEY is the keystroke that
picks the format (`"enter"` for the RET default; single characters for
the rest); MACRO is the LaTeX command inserted around the chosen keys.
The default set covers the common natbib + biblatex commands; narrow
it to one package family by customising this. Group: `reftex`.
Defined in `reftex-cite.lisp`.
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
