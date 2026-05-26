;;; ruby.lisp — the Ruby major mode.

(define-mode ruby-mode
  :name "Ruby"
  :comment-prefix "# "
  :highlight :ruby)

(register-mode ".rb"      ruby-mode)
(register-mode ".rake"    ruby-mode)
(register-mode ".gemspec" ruby-mode)
