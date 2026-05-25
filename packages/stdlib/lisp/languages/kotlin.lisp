;;; kotlin.lisp — the Kotlin major mode.

(define-mode kotlin-mode
  :name "Kotlin"
  :comment-prefix "// "
  :highlight :kotlin)

(register-mode ".kt"  kotlin-mode)
(register-mode ".kts" kotlin-mode)
