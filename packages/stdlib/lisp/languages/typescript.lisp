;;; typescript.lisp — the TypeScript major mode.

(define-mode typescript-mode
  :name "TypeScript"
  :comment-prefix "// "
  :highlight :typescript)

(register-mode ".ts" typescript-mode)
