# RefTeX for jmacs

Companion design to `plans/AUCTeX.md`. The AUCTeX plan sketches
references/citations as a "RefTeX-lite" Phase 4; this document replaces
that sketch with a full RefTeX design. Build it as an independent track —
**RefTeX needs none of AUCTeX Phase 0's `run-process!`**; it is pure
buffer/file scanning + the existing minibuffer + the citation bridge, plus
two new interactive views.

**Status:** drafted 2026-06-03 from a design conversation with Jason and a
read-only capability sweep (findings inline). Scope settled below; a short
list of open questions at the end.

## Settled scope (2026-06-03)

From the design conversation:

1. **Full RefTeX**, not lite. Beyond the daily core (labels, refs, cite,
   TOC, crossref) this includes `\index` support, a label-uniqueness DB
   with **rename-label** across the document, and **TOC-driven section
   reorganization** (promote / demote / move).
2. **Multi-file from the start.** A *document* is a master file plus its
   transitively `\input`/`\include`d files. The scanner, the DB, and every
   command operate over the whole document set, not the current buffer.
3. **Dual picker, selection-first.** The signature `*RefTeX Select*`
   context-showing selection view is the primary path; a minibuffer
   fast-path is available when you already know the key. ("Halfway between
   Python and Perl": the capable abstraction is the default, the quick way
   is allowed.)

## The core abstraction: the document model

Everything keys off one structure, the **document**, identified by its
**master file** path. RefTeX is fundamentally a multi-file engine — the DB
spans files, and the views/commands read from it.

### Master detection (in order)

1. **`% !TEX root = …`** magic comment in the current file (TeXShop /
   TeXworks / VS Code convention), resolved relative to the current file's
   directory.
2. The current file itself, if it contains `\documentclass`.
3. A sibling/ancestor `.tex` that `\input`/`\include`s the current file, or
   that has `\documentclass` (single unambiguous hit → use it).
4. **Prompt** for the master when ambiguous, and cache the answer
   (`*reftex-master*` per-document, plus a `% !TEX root` insert offer).
5. Fallback: the current buffer is its own master (degenerate single-file).

### Transitive scan

From the master, resolve `\input{f}` / `\include{f}` / `\subfile{f}` /
`\import{dir}{f}`, each relative to the master's directory (append `.tex`
when no extension), recurse, guard against cycles. The result is an
**inclusion tree** plus a flat file list in document order.

### The DB (one record per document, cached)

Built by scanning every file in the document, in inclusion order:

| Table | Fields | Source |
|---|---|---|
| **labels** | `name, type, file, line, context, parentSection` | `\label{…}`; *type* from prefix (`eq:`→equation) refined by enclosing environment/macro (`\caption`→figure/table, display-math env→equation, `\section`→section) |
| **sections** | `level, title, file, line, label?, children` | `\part…\subparagraph`; the TOC tree |
| **refs** | `name, macro, file, line` | `\ref/\eqref/\pageref/\autoref/\cref{…}` — for crossref + rename |
| **cites** | `keys, macro, file, line` | `\cite/\citep/\citet/\parencite{…}` — for crossref |
| **index** | `entry, file, line` | `\index{…}` (Full) |
| **inputs** | `kind, path, line, file` | the inclusion tree |
| **bib** | `paths[]` | `\bibliography{…}` / `\addbibresource{…}` + `*citation-bib-path*` |

### DB lifecycle

- **Lazy build** on first ref/label/cite/toc/index invocation.
- **Cache** keyed by master path. Invalidate a file's slice when its buffer
  is dirty or its mtime changed; rescan on demand (`reftex-reparse`,
  RefTeX's `r`/`g`).
- For an open file, scan the **buffer** text (live); for an unopened
  included file, scan the **file** text (`read-file-text!`).

## The scanner — one pure host primitive

The existing regex primitives (`find-regexp-forward`, …) are bound to the
**current buffer**, so they can't scan unopened included files. Multi-file
needs a scanner over arbitrary text. Make it **one pure JS host
primitive**, unit-tested, with the hot loop in JS and all policy in Lisp:

```
(latex-scan text) → {
  labels:   [{name, line, col, env}],
  sections: [{level, title, line, col}],
  refs:     [{name, macro, line}],
  cites:    [{keys, macro, line}],
  index:    [{entry, line}],
  inputs:   [{kind, path, line}],
  bib:      [{paths, line}]
}
```

Pure `(string) → records`. Line numbers computed inside the scanner (it has
the whole text). The document model, DB assembly, multi-file orchestration,
caching, and every command are **Lisp** over this primitive.

## The interactive views

Two new singleton view kinds (a third for the Full index), following the
**view-list / directory-tree** singleton pattern and the **placeholder-view**
element-level-keydown lifecycle (single keys captured natively on the
element; chords forwarded to the host). Each is created, mounted via
`mountKindView`, focused, and torn down without residue. Rows act on the
**originating** view via closures into Lisp.

### `*RefTeX Select*` — the label / cite picker

Rows grouped by type, each a one-line **context** (caption, enclosing
section, or surrounding text). Keys mirror RefTeX:

- `n`/`p` (and arrows) move · `RET` select+insert · `SPC` peek (jump to the
  source, keep the picker) · `t` cycle the type filter · typing filters by
  regex · `r`/`g` reparse · `c` toggle context · `q`/`ESC` cancel.
- Selecting inserts the reference/citation macro chosen by type/config.
- **Minibuffer fast-path**: the same candidate set is offered through
  `open-completing-minibuffer!` for the know-the-key case (a prefix arg or
  a sibling command).

### `*RefTeX TOC*` — the document outline

The section tree (optionally interleaving labels/figures/tables, toggle).
`n`/`p` move · `RET`/`SPC` jump to `file:line` (SPC stays) · `</>` or arrows
collapse/expand a level · `r`/`g` reparse · `q` quit. **Full RefTeX adds**
in-TOC editing: promote/demote a section's level and move a section
up/down, rewriting the source (see R5; the riskiest surface).

### `*RefTeX Index*` — (Full) the index list

`\index` entries with jump; insertion completes over existing entries.

## Exists vs must-build

| Need | Status |
|---|---|
| Buffer text, `insert!`, `goto!`, `point`, region ops | **exists** (`buffer-primitives.js`) |
| `goto-line!`, `open-file-path!` (→ file:line jump) | **exists** (`app.js:3675`, `:3118`) |
| Minibuffer completion (`open-completing-minibuffer!` + `minibuffer-delivered` + tab hook) | **exists** (`app.js:3912`; `files.lisp` find-file is the model) |
| `citation-keys` / `citation-parse` / `*citation-bib-path*` | **exists** (`cite.lisp`) |
| `read-file-text!` (~-expanding) | **exists** (`app.js:3038`) |
| `defcustom` / customize group | **exists** (`custom.lisp`) |
| Path split (dirname/basename), `~` expand | **exists** (`files.lisp` `-split-path`, `-expand-tilde`) |
| **`latex-scan` pure text scanner** | **must-build** — load-bearing (regex prims are current-buffer-bound) |
| **`file-exists?`, `path-resolve`/`path-join`** | **must-build** (small) — `\input` resolution relative to master |
| **`citation-entries`** (key→`{author,year,title}`) | **must-build** (small) — context lines in the cite picker |
| **`reftex-select` / `reftex-toc` (+ `reftex-index`) view kinds** | **must-build** — renderer element + `app.js` wiring + Lisp command (×N) |
| **`write-file-text!`** (wrap `host.saveFile`) | **must-build, R5 only** — rename / reorg writes |

## Phased plan (R0–R5)

### R0 — scanner + primitives
`latex-scan` (pure, **unit-tested**), `file-exists?`, `path-resolve`,
`citation-entries`. Verify-then-build: re-confirm each isn't already
present before adding. No UI; all testable.

### R1 — document model + DB
Master detection (the 5-step ladder), transitive `\input`/`\include`
resolution, unified DB assembly across files, caching + `reftex-reparse`.
Mostly pure Lisp over R0; heavily unit-testable (fixture trees of `.tex`).

### R2 — labels & references (the headline)
`reftex-label` (`C-c (`): insert `\label{…}` with a smart key — prefix from
context (`sec:`/`fig:`/`tab:`/`eq:`/`lst:`), stem slugified from the
caption/section title, **uniqueness-checked** against the DB; optional
confirm/edit. `reftex-reference` (`C-c )`): open `*RefTeX Select*` → choose
→ insert the type's macro (`\ref`/`\eqref`/`\pageref`/`\cref`, configurable).
The `*RefTeX Select*` view + the minibuffer fast-path. Defcustoms below.
**This is the daily RefTeX win; first live-testable milestone.**

### R3 — citations
`reftex-citation` (`C-c [`): detect the bib (`\bibliography`/`\addbibresource`
+ `*citation-bib-path*`), present the cite picker over keys with
author/year/title context (`citation-entries`), insert the cite macro
(`\cite`/`\citep`/`\citet`/`\parencite`, configurable); **multi-key**
select → `\cite{k1,k2}`.

### R4 — TOC + crossref
`*RefTeX TOC*` (`C-c =`): navigate/jump the section tree.
`reftex-view-crossref` (`C-c &`): from `\ref{x}` → `\label{x}` and back;
from `\label{x}` → list its `\ref` sites; from `\cite{k}` → show the
formatted bib entry (`format-citation`).

### R5 — Full extras (highest risk, last)
- **rename-label**: rename a label and rewrite every `\ref/\eqref/\pageref/
  \cref` site **across all files** — editing open buffers in place and
  unopened files on disk (`write-file-text!`). Document-wide, destructive →
  preview + confirm, regression tests per file kind.
- **TOC promote/demote/move**: re-level and re-order sections from the TOC,
  rewriting source. The spiciest edit; gate behind tests and confirmation.
- **`\index`** + `*RefTeX Index*` (`C-c /` insert, `C-c <`/`C-c >` show).

## Keybindings (the RefTeX `C-c` slots)

`latex-mode-map`'s `C-c` map already takes plain letters `b i e m M s S l n`
and `C-p` (`latex.lisp`). RefTeX uses **punctuation** slots, no collision
with those or with AUCTeX's planned `C-c C-<letter>` chords:

| Key | Command |
|---|---|
| `C-c (` | `reftex-label` |
| `C-c )` | `reftex-reference` |
| `C-c [` | `reftex-citation` |
| `C-c =` | `reftex-toc` |
| `C-c &` | `reftex-view-crossref` |
| `C-c /` | `reftex-index` (Full) |
| `C-c <` / `C-c >` | index display (Full) |

## Defcustoms

- `*reftex-label-prefixes*` — alist `type → prefix` (`equation`→`eq:`, …).
- `*reftex-ref-macro-by-type*` — alist `type → macro` (`equation`→`\eqref`,
  default→`\ref`).
- `*reftex-cite-macro*` — default cite macro (`\cite`).
- `*reftex-master*` — explicit master path override (else auto-detect).
- `*reftex-label-context-lines*`, `*reftex-toc-include-labels*` — picker/TOC
  display toggles.

## Out of scope (v1)

- **Style/package awareness** (parse `\usepackage` to learn each package's
  label-bearing environments) — v1 uses a static env table + buffer-scanned
  names. Shared with AUCTeX's out-of-scope list.
- **AMS `\eqref` auto vs manual numbering display** beyond type→macro.
- **`.bib` editing / BibTeX-mode.**

## Open questions for the architect

1. **Rename / TOC-reorg write policy (R5):** edit unopened files **on disk**
   directly (`write-file-text!`), or **open** each into a buffer first so
   every change is undoable in-app? On-disk is simpler; open-first is safer
   and uniformly undoable. Leaning open-first.
2. **Master ambiguity:** when detection is ambiguous, **prompt + cache** vs
   require an explicit `% !TEX root` / `*reftex-master*`? Leaning
   prompt-and-offer-to-insert-`% !TEX root`.
3. **Cite picker context depth:** author/year/title only, or a fuller
   formatted preview line via `format-citation`? Leaning author/year/title
   (cheap) with a `SPC`-peek to the full entry.
