;;; math-preview.lisp — the general live math-preview minor mode.
;;;
;;; A mode-agnostic per-buffer minor mode: when on, each math segment
;;; ($…$, \(…\), $$…$$, \[…\]) is shown typeset in place of its source,
;;; flipping back to editable source when point enters it. *Which*
;;; constructs are recognised is chosen by the buffer's MAJOR mode on the
;;; host side (the renderer's math-preview provider registry — LaTeX
;;; recognises \begin…\end environments, Markdown / the common config does
;;; not). This file only supplies the general on/off switch; the
;;; scan/typeset/cache and the replaced-range rendering live in the
;;; renderer (packages/renderer/src/math-preview.js and
;;; math-preview-providers.js).
;;;
;;; Loaded before markdown.lisp and latex.lisp so those files can build
;;; their mode-specific toggles on top of this general mode. OFF by
;;; default — opt in per buffer with `toggle-math-preview` (M-x), or per
;;; major mode with the mode-specific toggles those files bind.

;; The mode carries no keymap of its own; it is a pure display toggle.
;; The host watches its membership in the buffer's minor modes (checked on
;; the renderer's update path) and supplies / withholds the math
;; replaced-ranges accordingly, scanning per the buffer's major-mode
;; provider.
(define-mode math-preview-mode
  :name "MathPreview"
  :priority 5)

(defcommand toggle-math-preview ()
  "Toggle live inline MathJax typesetting for the current buffer. Works in
   any major mode that has a math provider (LaTeX, Markdown, …). With it
   on, math segments render typeset in place of their source and flip back
   to source for editing when point enters them."
  (if (member math-preview-mode (minor-modes))
      (disable-minor-mode math-preview-mode)
      (enable-minor-mode math-preview-mode)))

;; NB: the *math-tooltip-scale* defcustom lives in the spine's renderer-config
;; block (apps/desktop/mwb/spine.js), alongside the other renderer-consumed
;; settings — it needs an :on-change that calls push-renderer-config! (a spine
;; host primitive) so a live customize edit reaches the renderer.
