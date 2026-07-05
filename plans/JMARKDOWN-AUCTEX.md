# JMarkdown AUCTeX — an authoring environment for jmarkdown-mode

"AUCTeX + RefTeX, for JMarkdown." A comprehensive authoring layer over the
existing `jmarkdown-mode`: smart insertion of every JMarkdown construct,
structural navigation, a reference manager (cross-references, citations,
footnotes, an outline/TOC navigator), and a compile/preview loop targeting
HTML, LaTeX, and PDF — all on AUCTeX-style `C-c C-<letter>` keys AND in the
grouped mode menu, fully documented in the in-app manual (`C-h d`).

Requested 2026-07-04 (build autonomously). Architect's choices: full
construct surface · full RefTeX analog · AUCTeX-style keys · HTML/LaTeX/PDF.

## STATUS

- **Branch:** `jmarkdown-auctex`, off `auto-fill-mode` (includes the recent
  fill work; merge `auto-fill-mode` first, then this). Off `main` @ `75d621e6`.
- **State:** in progress (autonomous build).
- **Merge:** await the architect's live pass (`feedback_test_before_merge`).

## Architecture decision — pure Lisp, minimal spine footprint

The whole feature is **pure Lisp over primitives that already exist**, so it
is unit-testable and adds essentially nothing to the untestable server layer:

- **Reference scanning** is done in Lisp (mirroring the pure `-jmd-*` fill
  planner already in `jmarkdown.lisp`), NOT a new JS scanner primitive — the
  scan helpers are pure `(text) -> records` functions, exhaustively unit-tested.
- **All completion** rides `open-completing-minibuffer!` + the tab-complete
  hook-chaining idiom copied from `latex-insert.lisp` (capture the current
  `minibuffer-tab-complete`, delegate when our hook is unset). No new picker
  channel, no spine row-providers.
- **Compile** rides `run-process!` (HTML/LaTeX via the `jmarkdown` CLI, PDF via
  headless Chrome over the built HTML) with an on-exit callback writing to the
  utility dock via `utility-output-set` — the `latex-compile.lisp` pattern.
- **View** rides `open-file-in-split!`; **citations** ride the existing
  `citation-parse-lenient`/`citation-entries` primitives + `read-file-text!`.

**Only spine/index edit:** add the four new `.lisp` files to `STDLIB_FILES`
(packages/stdlib/src/index.js) and `SPINE_STDLIB` (apps/desktop/mwb/spine.js).
No new host primitives.

## Module layout

Four **top-level** stdlib files (loaded before the `languages/` glob, so they
must NOT reference `jmarkdown-mode-map` at load — they only define commands,
defcustoms and pure helpers):

- `packages/stdlib/lisp/jmarkdown-compile.lisp` — compile/view/error-nav.
- `packages/stdlib/lisp/jmarkdown-insert.lisp` — smart insertion of every construct.
- `packages/stdlib/lisp/jmarkdown-nav.lisp` — sections, matching env/directive, insert-item, outline.
- `packages/stdlib/lisp/jmarkdown-ref.lisp` — the reference manager (scan DB + label/reference/citation/index).

The **keymap chords + font/toggle sub-maps + extended mode menu + `M-enter`**
are appended to `packages/stdlib/lisp/languages/jmarkdown.lisp` (a language
file → loaded LAST → `jmarkdown-mode-map` exists, and the new command symbols
resolve late). This is the ONLY safe home for the wiring: a separate
`languages/jmarkdown-auctex.lisp` would sort *before* `jmarkdown.lisp`
alphabetically (`-` < `.`) and crash on the unbound map.

Docs: `docs/chapters/jmarkdown-authoring.md` + an include line in
`docs/MANUAL.jmd` + `node scripts/build-docs.js`.

## Keymap (AUCTeX-style, additive via `assoc`; existing single-letter C-c kept)

Existing `jmarkdown-c-c-map` single letters (b i e u c h l k f r a d @ t g q -
1-6 m v) and `C-v`/`C-p` are untouched. New (all under the `C-c` prefix):

| Key | Command | AUCTeX analog |
|---|---|---|
| `C-c C-c` | jmarkdown-compile (format prompt / saved default) | C-c C-c |
| `C-c C-o` | jmarkdown-view-output (open built HTML/PDF/TeX in a split) | C-c C-v |
| `C-c \`` | jmarkdown-next-error | C-c \` |
| `C-c C-w` | jmarkdown-show-output (bring the output/errors dock forward) | C-c C-l |
| `C-c C-e` | jmarkdown-insert-environment (completing @begin picker) | C-c C-e |
| `C-c C-m` | jmarkdown-insert-directive (completing ::: picker) | C-c C-m |
| `C-c C-s` | jmarkdown-insert-section (level completion + label) | C-c C-s |
| `C-c C-f` | **font sub-map** → C-b bold / C-i italic / C-e intense / C-u underline / C-h highlight / C-c code | C-c C-f |
| `C-c C-t` | **toggle sub-map** → C-p preview pane / C-m math symbols / C-x math preview | C-c C-t |
| `C-c C-n` | jmarkdown-next-section | (outline) |
| `C-c C-u` | jmarkdown-previous-section | (outline) |
| `C-c C-j` | jmarkdown-goto-matching (env/`:::` open↔close) | % |
| `M-enter` | jmarkdown-insert-item (continue list / description) | M-RET |
| `C-c (` | jmarkdown-label | reftex-label |
| `C-c )` | jmarkdown-reference (→ :ref/:cref/:Cref) | reftex-reference |
| `C-c [` | jmarkdown-citation (→ \cite family) | reftex-citation |
| `C-c =` | jmarkdown-toc (outline navigator, jump) | reftex-toc |
| `C-c /` | jmarkdown-index (insert :index mark) | reftex-index |

Everything else (floats, tables, code, math, alerts, diagrams, lists,
collection markers, emoji/icons, anchors, comments, extension skeletons) is
reachable from the mode menu and `M-x`; the frequently-used ones also sit
inside `jmarkdown-insert-environment` / `-directive` completion.

## Command inventory

### Compile & view (`jmarkdown-compile.lisp`)
- `jmarkdown-compile` — save, then `run-process!` `jmarkdown process <file>
  [--to latex]` (HTML/LaTeX) or the PDF path; `C-u` prompts the format, else
  `*jmarkdown-compile-format*`. On exit: write stdout/stderr to the `jmd-output`
  dock tab, parse the end-of-run warning summary into `*jmarkdown-error-list*`,
  echo a status summary, reload an open built artifact.
- `jmarkdown-compile-html` / `-latex` / `-pdf` — the explicit one-shots.
- `jmarkdown-view-output` — `open-file-in-split!` the built `.html`/`.pdf`/`.tex`
  (reload in place if already shown).
- `jmarkdown-next-error` / `-previous-error` — walk the parsed warnings.
- `jmarkdown-show-output` — activate the output dock tab.
- Defcustoms: `*jmarkdown-command*` (token list, default `("jmarkdown"
  "process")`), `*jmarkdown-compile-format*` (`:choice` html/latex/pdf, default
  html), `*jmarkdown-pdf-command*` (token list; default the headless-Chrome
  print over the built HTML), `*jmarkdown-view-restore*`.
- PDF path: build HTML first, then Chrome `--headless --print-to-pdf` (zero
  extra deps; fall back with a clear status if Chrome/puppeteer absent).

### Smart insertion (`jmarkdown-insert.lisp`)
- `jmarkdown-insert-environment` (C-c C-e) — completing over `@begin` names
  (built-ins: theorem/lemma/corollary/proposition/definition/example/remark,
  proof, equation, figure/subfigure/table/listing, game, abstract/feedback,
  comment + scanned + `Optionals:` header names), wraps the region, inserts the
  right template per kind (float → `[caption]{id=fig:}`, theorem → `{id=thm:}`,
  equation → raw-math body no `$$`, proof → bare, game → matrix stub, custom →
  name-mirrored `@begin(x)…@end(x)`), cursor placed by a NUL sentinel.
- `jmarkdown-insert-directive` (C-c C-m) — completing over container-directive
  names (note/aside/abstract/feedback/TeX/HTML/mermaid/TiKZ/game/comment/
  markdown-demo/Optionals/HTML-tags), inserts `:::name … :::`.
- `jmarkdown-insert-section` (C-c C-s) — heading level completion (`#`..`######`)
  + optional trailing `:label[sec:…]`.
- Quick inserts (menu/M-x): `-insert-table` (RxC + alignment prompt),
  `-insert-figure`/`-table-float`/`-listing`/`-subfigure` (float shells),
  `-insert-code-block` (hljs language completion), `-insert-math`
  (inline/display/equation), `-insert-alert` (7-variant completion),
  `-insert-mermaid`/`-tikz`/`-game`, `-insert-description-item`,
  `-insert-task-item`, `-insert-ordered-list` (letter/roman),
  `-insert-emoji`/`-icon`, `-insert-anchor` (⚓️), `-comment-region`,
  `-insert-toc`/`-lof`/`-lot`/`-lol`/`-index-block`/`-bibliography` (collection
  markers), `-insert-extension`/`-script-block`/`-target`/`-source`
  (extension/scripting skeletons), `-insert-footnote` (reuse markdown's).
- Reuses the `latex-insert.lisp` machinery, ported: candidate list + hook
  chaining + LCP tab-complete + NUL-sentinel templates + region capture.

### Navigation (`jmarkdown-nav.lisp`)
- `jmarkdown-next-section` / `-previous-section` — pure heading-offset finders.
- `jmarkdown-goto-matching` — jump between an `@begin(x)`/`@end(x)` pair (name-
  matched, nesting-aware) or a `:::`/`:::` fence pair (colon-count stack).
- `jmarkdown-insert-item` (M-enter) — continue the enclosing `-`/`*`/`1.`/`a.`
  list or `term::` description; else a plain newline.
- `jmarkdown-toc` (C-c =) — scan headings (+ captioned floats/theorems) →
  completing-minibuffer → jump to the chosen node.

### Reference manager (`jmarkdown-ref.lisp`)
Pure Lisp scanners over `(buffer-text)` (unit-tested), plus thin commands:
- `-jmd-scan-labels` — every `:label[key]` and `{id=key}` (on `@begin`) with its
  kind (from the enclosing env or the key prefix) → the numbered/ref universe.
- `-jmd-scan-headings` — every `#`..`######` with level, text, `toc-`slug.
- `-jmd-scan-anchors` — every `⚓️name`.
- `jmarkdown-label` (C-c `(`) — suggest a key (slug of the heading/env at point,
  type-prefixed, uniquified), confirm via completing-minibuffer, insert
  `:label[key]` (on a heading line → appended; on an `@begin` → `{id=key}`).
- `jmarkdown-reference` (C-c `)`) — completing over the label/id universe →
  insert `:ref` / `:cref` / `:Cref` (a second tiny prompt chooses which; default
  `:cref`).
- `jmarkdown-citation` (C-c `[`) — find the `.bib` from the front-matter
  `Bibliography:` key (resolve relative to the file dir), `read-file-text!` +
  `citation-parse-lenient` + `citation-entries` → completing-minibuffer over
  `key — Author (year) Title` → insert `\cite`/`\citep`/`\citet` (variant
  prompt; multi-key by comma).
- `jmarkdown-index` (C-c `/`) — insert `:index[entry]`, completing over
  previously-used entry texts.

## Documentation (`C-h d`)
A new manual chapter `docs/chapters/jmarkdown-authoring.md` (`## JMarkdown
authoring` + prose), included in `docs/MANUAL.jmd` after the other chapters,
documenting every command, its key, its menu path, and the JMarkdown construct
it builds — grouped Compile/Insert/Navigate/Reference/Fonts. Rebuilt with
`node scripts/build-docs.js`. Cross-links via `cmd(name)`.

## Assumptions (architect to confirm)
1. **PDF via headless Chrome** over the built HTML (zero extra deps, matches the
   `init -m` Makefile route). If Chrome isn't found the command fails with a
   clear status; a `*jmarkdown-pdf-command*` defcustom lets you point at
   puppeteer's `print.js` instead.
2. **`jmarkdown` on PATH.** The dev launch (`electron .` from a terminal)
   inherits the login PATH, so `run-process! "jmarkdown"` resolves. A packaged
   app would need PATH augmentation (out of scope; note in the doc).
3. **Single-file documents.** The reference scan covers the current buffer;
   `[[file.md]]` include-expansion for a whole-book target universe is a noted
   follow-up (most `.jmd` are self-contained).
4. **Completion, not a floating picker.** Cross-ref/citation/TOC use the
   completing-minibuffer (functional RefTeX), not the bespoke floating panel
   (which isn't wired to Model B). A grouped floating picker is a future
   enhancement on the generic picker channel.
5. **Emphasis commands emit JMarkdown syntax** (single `*` = bold, `**` =
   intense) via the existing `markdown-*`/`jmarkdown-*` commands — the font
   sub-map just groups them AUCTeX-style.

## Live-verify checklist (full quit + relaunch — spine + language files)
1. `C-c C-c` in a `.jmd` → HTML build; output/errors in the dock; `C-c C-o`
   opens the built `.html` beside the source. Set `*jmarkdown-compile-format*`
   to latex/pdf and retry.
2. `C-c C-e` → complete `theorem` → a `@begin(theorem){id=thm:}…@end(theorem)`
   skeleton; `C-c C-m` → `note` → a `:::note … :::`.
3. `C-c (` on a heading → `:label[sec:…]` appended; `C-c )` → pick the label →
   `:cref[sec:…]`; `C-c [` → pick a bib entry → `\citep{key}`.
4. `C-c =` → outline of headings → jump; `C-c C-n`/`C-c C-u` step sections;
   `C-c C-j` on `@begin` jumps to its `@end`; `M-enter` in a list continues it.
5. The **JMarkdown menu** shows the new Compile/Insert/Navigate/Reference/Fonts
   groups; `C-h d` → the new "JMarkdown authoring" chapter.
</content>
