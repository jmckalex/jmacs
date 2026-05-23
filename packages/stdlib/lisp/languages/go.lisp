;;; go.lisp — the Go major mode.

(define-mode go-mode
  :name "Go"
  :comment-prefix "// "
  :highlight :go)

(register-mode ".go" go-mode)
