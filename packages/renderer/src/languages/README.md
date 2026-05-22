# languages/

JS-side language registrations. Each file in this directory is a
self-contained tree-sitter language: it imports `registerLanguage` from
`../language-registry.js` and calls it at module top level with a
grammar filename, a highlight query, and the file suffixes that should
open in this language. Loading the module is what registers it.

## How to add a language

To add a language called `<tag>` (e.g. `rust`, `json`, `bash`):

1. **Vendor the grammar.** Drop the prebuilt `tree-sitter-<tag>.wasm`
   into `packages/renderer/vendor/` and add a row to that directory's
   `README.md`.

2. **Write the JS registration.** Create
   `packages/renderer/src/languages/<tag>.js`. Copy `javascript.js` as
   the template. Fill in:

   - `tag` — the key the view uses to look up the highlighter and the
     value `languageForName` returns for matching buffers. Lowercase,
     unique.
   - `grammar` — the `.wasm` filename in `../vendor/`.
   - `query` — a tree-sitter highlight query (an S-expression). Capture
     nodes onto these face names — they are what the theme styles:
     `@comment`, `@string`, `@number`, `@keyword`, `@constant`,
     `@function`, `@type`, `@tag`, `@paren`, `@operator`. A capture
     outside that set still renders, but with no style applied.
   - `suffixes` — an array of filename suffixes (`['.rs']`) — anything
     `String.prototype.endsWith` matches.

3. **Write the Lisp mode.** Create
   `packages/stdlib/lisp/languages/<tag>.lisp`. It defines the major
   mode and the suffix-to-mode mapping. The template:

   ```lisp
   ;;; <tag>.lisp — the <Language> major mode.

   (define-mode <tag>-mode
     :name "<Language>"
     :comment-prefix "// "        ;; optional, omit if not applicable
     :highlight :<tag>)            ;; must match the JS tag

   (register-mode ".<ext>" <tag>-mode)
   ```

4. **Drop in. Done.** The host app discovers the new JS module and the
   new Lisp file at startup. No other file is touched.

   - `packages/renderer/src/treesitter.js` — never edited per language.
   - `packages/renderer/src/highlight.js` — never edited per language.
   - `packages/renderer/src/index.js` — never edited per language.
   - `apps/desktop/src/app.js` — never edited per language.
   - `packages/stdlib/src/index.js` — never edited per language.

## What the registry does

`../language-registry.js` is a *data* registry. It holds the spec for
each language. The host app calls `loadLanguageHighlighters(create)`
once at startup, where `create(grammar, query)` is the tree-sitter
factory in `../treesitter.js`. Each language is instantiated
independently — a missing grammar disables only that language; the rest
still highlight.

`languageForFilename(name)` consults the registry's suffix tables; the
view's `languageForName` falls back to it for any tag not in its
built-in table (the Lisp dialect, Markdown, LaTeX and Makefile — the
hand-tokenized languages without a tree-sitter grammar).

## A note on the line-tokenizer fallback

`packages/renderer/src/highlight.js` keeps a hand-written line
tokenizer for each tag it knows about. For a language registered here,
that fallback fires *only* if the grammar's `.wasm` fails to load (or
the page is offline). The three migrated languages —
`javascript`, `html` and `python` — still have their fallback
tokenizers there. A *new* language need not provide one; without it,
the buffer is shown as plain text when the grammar is missing. That is
acceptable for v0.
