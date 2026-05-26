;;; lua.lisp — the Lua major mode.

(define-mode lua-mode
  :name "Lua"
  :comment-prefix "-- "
  :highlight :lua)

(register-mode ".lua" lua-mode)
