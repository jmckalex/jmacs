;;; element-view-notebook-cells.lisp — the Architecture-A cell notebook.
;;;
;;; `M-x notebook-cells` opens a notebook where ALL cells live in ONE real
;;; editor over a single unified buffer (one tree-sitter parse, the windowed
;;; renderer, full highlighting and editing) — the cells ARE the editor.
;;; Per-cell chrome (a header with a Run button, an output region) rides the
;;; existing block-replaced-range / widget layer.
;;;
;;; The <notebook-cells-view> custom element is bundled with the renderer
;;; (registered from packages/renderer/src/index.js), so `:module` is the
;;; empty string — the generic element-view wrapper just creates the
;;; already-registered tag.
;;;
;;; `:keyboard 'off` — the embedded editor self-drives editing/motion via the
;;; renderer's built-in keymap; command chords (M-x, C-x …) bubble to the
;;; host router (its `defaultPrevented` guard means no double-dispatch). The
;;; view runs a cell on Shift-Enter and exposes Run-all / +Cell on a toolbar.
;;;
;;; Cells evaluate in the spine's Node session under GODOT_SERVER=1 (the
;;; renderer can't — CSP forbids unsafe-eval), via the same NOTEBOOK_EVAL
;;; round-trip the JS notebook uses; flag-off falls back to local eval.
;;; v1 is JavaScript code cells; typed cells (heading/text/output) with
;;; prose-as-comments + group folds are the follow-on (plans/NOTEBOOK-ENV.md).

(define-element-view notebook-cells
  :title    "Notebook"
  :module   ""
  :tag      "notebook-cells-view"
  :fit      'fill
  :keyboard 'off)
