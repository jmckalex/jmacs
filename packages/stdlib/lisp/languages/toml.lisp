;;; toml.lisp — the TOML major mode.

(define-mode toml-mode
  :name "TOML"
  :comment-prefix "# "
  :highlight :toml)

(register-mode ".toml" toml-mode)
