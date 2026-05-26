;;; erlang.lisp — the Erlang major mode.

(define-mode erlang-mode
  :name "Erlang"
  :comment-prefix "% "
  :highlight :erlang)

(register-mode ".erl"     erlang-mode)
(register-mode ".hrl"     erlang-mode)
(register-mode ".escript" erlang-mode)
