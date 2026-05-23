;;; rust.lisp — the Rust major mode.

(define-mode rust-mode
  :name "Rust"
  :comment-prefix "// "
  :highlight :rust)

(register-mode ".rs" rust-mode)
