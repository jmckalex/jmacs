;;; latex.lisp — drop-in pair for the LaTeX tree-sitter language.
;;;
;;; `latex-mode` itself is defined in `modes.lisp` — it pre-dates the
;;; tree-sitter integration, since the editor has a hand-tokenized LaTeX
;;; fallback in `packages/renderer/src/highlight.js`. That definition
;;; already binds `.tex` and `.latex`. This file is the conventional
;;; drop-in that pairs with the JS registration in
;;; `packages/renderer/src/languages/latex.js`: it lives here so the
;;; language is "complete" from one directory's point of view.
;;;
;;; `latex-mode` declares `:highlight :latex`; the tree-sitter
;;; highlighter registered under the `latex` tag takes precedence over
;;; the hand tokenizer when its wasm loads.
