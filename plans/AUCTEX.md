# AUCTeX-style LaTeX authoring for jmacs

Design note for bringing AUCTeX's LaTeX *workflow* — compile/view loop,
smart insertion, math symbol abbrevs, reference/citation completion,
navigation — to jmacs's `latex-mode`. Pre-implementation; settle the open
questions, then build (phased) on a branch.

**Status:** drafted 2026-06-03 from a design conversation with Jason and
a read-only capability sweep (findings inline). Open questions at the end.

## Framing: what we're porting (and what's already done)

AUCTeX is the Emacs LaTeX suite. We don't want a clone — we want its
*authoring workflow* on jmacs's foundations. Two of its pillars already
ship here, so the plan skips them:

- **`preview-latex` (inline typeset math)** → **done** — the math-preview
  we just built (`$…$`, `$$…$$`, `\[…\]`, and `\begin{…}\end{…}`
  environments render in place, with the reveal/edit cycle).
- **font-lock (syntax highlighting)** → **done** — tree-sitter `:latex`.

What remains, in AUCTeX terms: `TeX-command-master` (the compile/view
loop), environment/macro/section/font **insertion**, `LaTeX-math-mode`
(symbol abbrevs), RefTeX-style **label/ref/cite** completion + an outline,
and section/`\begin`-`\end` **navigation** (+ optional `TeX-fold`).

## Grounding — what exists vs must-build

| Need | Status | Notes |
|---|---|---|
| `latex-mode` + `latex-mode-map` (`C-c` prefix) | **exists** | `latex.lisp`; `C-c b/i/e/m/M/s/S/l/n/C-p` taken — `C-c C-c`, `C-c C-e`, `C-c C-v`, … all free (a chord ≠ its plain key). |
| Run an external program, capture stdout/stderr/exit | **must-build** | No Lisp-callable runner. The shell (`shell.js` pty) and gnuplot views are the IPC template: `window.host.*` → `ipcMain.handle` `spawn()` → `webContents.send`. |
| Minibuffer completion over a candidate list | **exists** | `open-completing-minibuffer!` + the `minibuffer-tab-complete` hook + `minibuffer-read`/`minibuffer-delivered` callback. |
| PDF view | **exists** (reload must-build) | `open-file-path!` on a `.pdf` opens a `pdf-view`; needs a `pdf-reload!` for after-recompile refresh. |
| Citation / BibTeX keys | **exists** | `citation-parse` / `citation-keys` (+ `cite.lisp`, `*citation-bib-path*`) → drives `\cite{}` completion directly. |
| Current view's file path / dir | **must-build** | `view.extras.filePath` isn't exposed; add `view-file-path`. |
| List-of-locations → jump (errors, outline) | **partial** | `occur` builds a text results view but doesn't jump; need a small "click a row → go to file:line" view (reuse the view-list / occur pattern). |
| Folding | **exists** (RO) | `toggle-fold`/`fold-all`/`unfold-all`; fold *ranges* are renderer/grammar-driven — `TeX-fold` of macros/envs would need grammar or JS work. |
| Snippets / tab-through fields | **design-only** | `plans/SNIPPETS.md`, not implemented. Insertion v1 uses cursor placement; upgrades to fields when snippets land. |

## New primitives (the only host-side work)

1. **`run-process!`** — a *general* async process runner (LaTeX is the
   first consumer, but it's reusable): `(run-process! program args cwd
   callback)` spawns via Node `spawn`/`execFile` and calls back with
   `{stdout, stderr, code}` (or streams lines). Built by copying the
   shell/gnuplot IPC plumbing (`ipcMain.handle` + `webContents.send`).
   *(Powerful = a little dangerous; see open question 5.)*
2. **`view-file-path`** — `(view-file-path view)` → the view's
   `extras.filePath` (and a `dirname` helper) so a command knows which
   `.tex` to build and where.
3. **`pdf-reload!`** — refresh an open `pdf-view` for a path after a
   recompile (else re-`open-file-path!`).

Everything else is Lisp (`latex.lisp` + new `latex-compile.lisp`,
`latex-math-abbrev.lisp`, `latex-refs.lisp`) on the existing primitives.

## Phased plan

### Phase 0 — foundations
The three primitives above. Unit-testable parts: the pure output/error
*parser* (pdflatex log → `[{file,line,message}]`) and the `dirname`/path
logic. The IPC + PDF reload need live smoke.

### Phase 1 — the compile / view loop (the headline)
AUCTeX's `TeX-command-master`:
- **`C-c C-c`** runs a build (see open question 2 for "suggest next" vs
  "just build" vs "prompt"). Runs the configured command via
  `run-process!` in the `.tex`'s directory, streaming output to a
  **`*TeX output*`** view.
- **Error navigation**: parse the log into a **`*TeX errors*`** list;
  **`C-c \``** (next-error) and RET/click jump to `file:line`. (Pragmatic
  parse of `! …` + `l.NN` + the `(file …)` stack — a subset of AUCTeX's
  parser.)
- **`C-c C-v`** (View): open / `pdf-reload!` the built PDF, ideally
  **split side-by-side** (we have panes).
- **defcustoms**: `*latex-command*` (e.g. `latexmk -pdf -synctex=1
  -interaction=nonstopmode`, or `pdflatex …`), `*latex-bibtex-command*`
  (`bibtex`/`biber`), `*latex-view*` (internal pdf view by default),
  `*latex-clean*`.

### Phase 2 — smart insertion (daily authoring)
- **`C-c C-e`** insert-environment: prompt (completion over a known-env
  list + envs already in the buffer) → `\begin{ENV}…\end{ENV}` with
  content templates (itemize→`\item`; tabular→column-spec prompt;
  figure→`\centering`/`\caption`/`\label`; equation/align→math). **`C-c
  ]`** closes the innermost open environment.
- **`C-c C-m`** insert-macro: prompt (completion) → macro with `{}`
  argument placeholders.
- **`C-c C-s`** insert-section: pick a level → `\section{…}` (+ optional
  `\label`). (The existing `C-c s`/`C-c S` quick-wraps stay.)
- **`C-c C-f` …** font sub-map (`C-b`/`C-i`/`C-e`/`C-t` → textbf/textit/
  emph/texttt), folding in the existing `C-c b/i/e`.
- Built on `latex-surround` + the completing minibuffer; cursor-placement
  now, tab-through fields once snippets exist.

### Phase 3 — math symbol abbreviations (`LaTeX-math-mode`)
A minor mode where a configurable prefix (default `` ` ``) + a key inserts
a symbol macro (`` `a ``→`\alpha`, `` `>`→`\geq`, `` `e ``→`\epsilon`, …) —
the AUCTeX `LaTeX-math-list`. Implemented as a transient: backtick arms a
one-key read that looks up a symbol table and inserts (with a completion
fallback for unknown keys). Toggle + `*latex-math-abbrev-prefix*`
defcustom. The table is pure and unit-testable.

### Phase 4 — references & citations (RefTeX)
> **Superseded by `plans/RefTeX.md`.** Jason chose the full RefTeX
> companion (multi-file document model, label DB + rename, TOC reorg,
> `\index`, a context-showing selection view) over the lite sketch below.
> RefTeX is an **independent track** — it needs none of Phase 0's
> `run-process!`. The sketch below is the original lite plan, kept for
> context; build to `plans/RefTeX.md` instead.

- **`\ref`/`\eqref`** (`C-c )`): scan the buffer for `\label{…}` →
  complete → insert `\ref{…}`. **`\label`** insertion with an
  auto-suggested key (`sec:`/`fig:`/`eq:`).
- **`\cite`** (`C-c [`): load `*citation-bib-path*` via `citation-keys`
  → complete over keys → insert `\cite{…}`. *(The citation bridge already
  exists — this is mostly wiring.)*
- **Outline / TOC** (`C-c =`): collect `\section`-family → a clickable
  jump list (the Phase-1 location-list view, reused).
- *Defer*: multi-file `\input` scanning, label-uniqueness DB.

### Phase 5 — navigation & niceties
Section next/prev and `\begin`↔`\end` matching jump; `M-RET`
insert-`\item` inside a list; smart `` `` ``/`` '' `` quotes; comment
(already have `C-c ;`). *Optional*: `TeX-fold` of environments/macros
(needs grammar or JS fold-range work).

### Phase 6 — SyncTeX forward & inverse search (post-v1, in-app)
Feasible in our own `pdf-view` (PDF.js) — we own the viewer, so we get
the click and control the render. Both directions ride on Phase 0's
`run-process!` + the `synctex` CLI (ships with TeX Live; falls back to a
JS `.synctex.gz` parser if absent). Compile already emits `-synctex=1`
(Phase 1), so the `.synctex.gz` is there.

- **Inverse (PDF → source):** capture a modifier-click on a page canvas;
  convert canvas-px → PDF point via PDF.js `viewport.convertToPdfPoint`;
  run `synctex edit -o <page>:<x>:<y>:<output.pdf>`; parse `Input:` +
  `Line:`; `open-file-path!` + goto the line.
- **Forward (source → PDF):** `synctex view -i <line>:<col>:<file.tex>
  -o <output.pdf>` → page + box; scroll the pdf-view to that page and
  draw a transient highlight (PDF point → canvas via
  `convertToViewportPoint`).
- **New host bits:** a page-click hook + measured PDF coords from
  `pdf-view`, and a scroll-to/highlight method on it. The
  coordinate-convention juggling (origin/units/DPR) is the only fiddly
  part — well-trodden by every SyncTeX viewer, not a blocker.
- *Skim fallback* only if the in-app coordinate math proves troublesome:
  it's actually more plumbing (Skim's inverse search shells out, so jmacs
  would need a CLI/listener for the callback) and loses the integrated
  split view — so in-app is preferred.

## Explicitly out of scope (v1)
- **SyncTeX forward & inverse search** — *promoted to Phase 6* (feasible
  in-app; see below), no longer out of scope, just post-v1.
- **Full RefTeX** (cross-file label DB, re-numbering, TOC buffer).
- **Package/style awareness** (parse `\usepackage`, load AUCTeX-style
  files to know each package's macros/envs) — large; v1 uses a static
  macro/env list + buffer-scanned names.
- **The snippet engine itself** — a separate feature (`SNIPPETS.md`);
  it *enhances* Phase 2 insertion but isn't a blocker.
- **`.bib`/BibTeX-mode editing.**

## Settled decisions (2026-06-03)
1. **Toolchain:** `latexmk -pdf -synctex=1 -interaction=nonstopmode` when
   `latexmk` is on `PATH`, else `pdflatex` (+ `bibtex`/`biber`). Both
   exposed as defcustoms (`*latex-command*`, `*latex-bibtex-command*`).
2. **`C-c C-c`:** build-by-default (run the configured command, latexmk
   subsuming the multi-pass dance), with a "prompt which command" form
   available.
3. **Viewer:** built-in `pdf-view`, split beside the source, auto-reload
   after a build. Forward/inverse search is **Phase 6, in-app** (below).
4. **Phase order:** 1 (compile/view) → 2 (insertion) → 3 (math abbrevs)
   → 4 (refs/cite) → 5 (nav) → 6 (SyncTeX).
5. **`run-process!` is general** — a reusable async process runner, driven
   by the LaTeX defcustoms (and available to other features later).
