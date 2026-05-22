# languages/

Per-language major modes, loaded by `loadStdlib` after the ordered core
`STDLIB_FILES`. The directory is globbed at startup, so any `.lisp`
file dropped in here becomes a language without editing the loader.

Each file defines one major mode and registers the filename suffixes
that pick it. Three files migrated here as the templates:

- `javascript.lisp`
- `html.lisp`
- `python.lisp`

## How to add a language

A language has two halves: this Lisp file (the mode + suffix mapping)
and a JS module that registers the tree-sitter grammar. For a language
called `<tag>` (e.g. `rust`, `json`, `bash`):

1. **Vendor the grammar.** Drop the prebuilt `tree-sitter-<tag>.wasm`
   into `packages/renderer/vendor/`.

2. **Write the JS registration.** Create
   `packages/renderer/src/languages/<tag>.js`. Copy `javascript.js` as
   the template. The JS module declares the grammar filename, the
   highlight query, and the file suffixes. See
   `packages/renderer/src/languages/README.md`.

3. **Write the Lisp mode.** Create `<tag>.lisp` in this directory. The
   template:

   ```lisp
   ;;; <tag>.lisp — the <Language> major mode.

   (define-mode <tag>-mode
     :name "<Language>"
     :comment-prefix "// "        ;; optional, omit if not applicable
     :highlight :<tag>)            ;; must match the JS tag

   (register-mode ".<ext>" <tag>-mode)
   ```

   The `:highlight` keyword is the same string as the JS module's
   `tag`. The view turns the mode's `:highlight` into a lookup key for
   the highlighter the JS module registered.

4. **Drop in. Done.** Nothing else is touched: `STDLIB_FILES`,
   `treesitter.js`, `app.js`, `highlight.js` and `index.js` are all
   *closed* to per-language change. Adding or removing a language is a
   matter of adding or removing these three files.

## Load order

Files in this directory load **after** `STDLIB_FILES` (the ordered
core, ending in `keymap.lisp`) and **before** the user's `init.lisp`.
Languages are mutually independent — load order among them is
unspecified. If two languages claim the same suffix, the last to load
wins.
