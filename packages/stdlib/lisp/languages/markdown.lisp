;;; markdown.lisp — extra suffix mappings for Markdown.
;;;
;;; `markdown-mode` itself is defined in `modes.lisp` (it pre-dates
;;; the tree-sitter integration, since the editor has a hand-tokenized
;;; Markdown fallback). That definition already binds `.md` and `.jmd`.
;;; This file is the conventional drop-in that pairs with the JS
;;; registration in `packages/renderer/src/languages/markdown.js`:
;;; it lives here so the language is "complete" from one directory's
;;; point of view, and adds the `.markdown` long-form suffix that the
;;; original mode definition did not cover.
;;;
;;; `markdown-mode` declares `:highlight :markdown`; the tree-sitter
;;; highlighter registered under the `markdown` tag takes precedence
;;; over the hand tokenizer when its wasm loads.

(register-mode ".markdown" markdown-mode)
