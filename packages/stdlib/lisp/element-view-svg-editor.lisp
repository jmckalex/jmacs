;;; element-view-svg-editor.lisp — the Inkscape-like SVG editor as a view.
;;;
;;; `M-x svg-edit` opens a blank vector-drawing canvas in a pane: rect /
;;; ellipse / line / plain-text and LaTeX math boxes, with select / move /
;;; resize. The standout feature is the math box: type LaTeX, it renders
;;; through the editor's existing MathJax-SVG pipeline and embeds as crisp
;;; vector glyphs (see packages/renderer/src/svg-editor-view.js).
;;;
;;; The `<svg-editor-view>` custom element is bundled with the renderer
;;; (registered from packages/renderer/src/index.js), so `:module` is the
;;; empty string — there is nothing extra to import; the generic
;;; element-view wrapper just creates the already-registered tag.
;;;
;;; `.svg` files still open as the read-only image view by default; this is
;;; the explicit editor entry point. The default-handler question (open
;;; `.svg` in the editor vs. the image view) is left for Jason — see
;;; architect-notes.md.
;;;
;;; Save in this MVP path downloads the serialised, cleaned `.svg`
;;; (data-godot-* stripped). Host file-backed save + open-existing wiring
;;; is the next phase (a server-owned svg-document data-source).

(define-element-view svg-edit
  :title    "SVG Editor"
  :module   ""
  :tag      "svg-editor-view"
  :fit      'fill
  :keyboard 'share)
