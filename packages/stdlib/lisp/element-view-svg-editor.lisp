;;; element-view-svg-editor.lisp — the Inkscape-like SVG editor as a view.
;;;
;;; PARITY ONLY — this file is evaluated by the stdlib TEST harness, not
;;; by the running app. The LIVE registration is the plain-JS registry in
;;; apps/desktop/src/element-spec.js (ELEMENT_VIEW_SPECS['svg-edit']);
;;; keep the two in sync. (The renderer's Lisp interpreter is deleted;
;;; element-view commands are client-owned JS data under Model B.)
;;;
;;; `M-x svg-edit` opens a vector-drawing canvas in a pane: rect / ellipse /
;;; line / bezier paths / TikZ-style text+math nodes, with select / move /
;;; resize and a properties panel. The standout feature is the math node:
;;; type LaTeX, it renders through the editor's existing MathJax-SVG
;;; pipeline and embeds as crisp vector glyphs (see
;;; packages/renderer/src/svg-editor-view.js).
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

(define-element-view svg-edit
  :title    "SVG Editor"
  :module   ""
  :tag      "svg-editor-view"
  :fit      'fill
  :keyboard 'share)
