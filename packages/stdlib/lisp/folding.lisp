;;; folding.lisp — code folding commands.
;;;
;;; Folding is a *view* concern: the renderer tracks which lines are
;;; collapsed per buffer, and decides which lines to draw. The Lisp
;;; side only orchestrates — these commands call host primitives that
;;; the editor view exposes.
;;;
;;; Bindings live in keymap.lisp under the C-c prefix:
;;;   C-c TAB  → toggle-fold-at-point
;;;   C-c C-,  → fold-all
;;;   C-c C-.  → unfold-all

(defcommand toggle-fold-at-point ()
  "Toggle the fold at point. If point is on a foldable header, that
   fold toggles; otherwise the smallest enclosing fold toggles.
   No-op if the current buffer's language has no fold support."
  (toggle-fold-at-point!))

(defcommand fold-all ()
  "Fold every foldable scope in the current buffer."
  (fold-all!))

(defcommand unfold-all ()
  "Unfold every fold in the current buffer."
  (unfold-all!))
