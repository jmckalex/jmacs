;;; inline-eval.lisp — CIDER-style inline evaluation.
;;;
;;; Two commands evaluate a single Lisp form in the current buffer
;;; and show the result as a coloured pill next to the form:
;;;
;;;   `eval-expression-before-point` (C-x C-e) — the form whose
;;;       closing bracket is just before the cursor.
;;;   `eval-expression-at-point`     (C-RET)   — the form enclosing
;;;       the cursor.
;;;
;;; The host primitives (`form-bounds-at-point!`,
;;; `form-bounds-before-point!`, `eval-region!`) do the heavy lifting:
;;; they understand the buffer's text, the cursor position, and the
;;; renderer's overlay layer. This file is the Lisp surface.

(defcommand eval-expression-at-point ()
  "Evaluate the Lisp form enclosing point and show the result
   beside its closing bracket. The pill is green for a value, red
   for an error; errors also surface in the REPL with the full
   stack trace. Bound to `C-RET`."
  (let ((bounds (form-bounds-at-point!)))
    (if (nil? bounds)
        (println "eval: no form at point")
        (eval-region! (car bounds) (cdr bounds)))))

(defcommand eval-expression-before-point ()
  "Evaluate the Lisp form immediately before point — the form
   whose closing bracket sits just before the cursor — and show
   the result. Bound to `C-x C-e`."
  (let ((bounds (form-bounds-before-point!)))
    (if (nil? bounds)
        (println "eval: no form before point")
        (eval-region! (car bounds) (cdr bounds)))))

(defcommand show-eval-log ()
  "Open the *Eval log* buffer — a record of recent inline
   evaluations (one entry per call to `eval-region!`)."
  (show-eval-log!))
