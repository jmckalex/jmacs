;;; elixir.lisp — the Elixir major mode.

(define-mode elixir-mode
  :name "Elixir"
  :comment-prefix "# "
  :highlight :elixir)

(register-mode ".ex"  elixir-mode)
(register-mode ".exs" elixir-mode)
