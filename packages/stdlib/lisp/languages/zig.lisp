;;; zig.lisp — the Zig major mode.

(define-mode zig-mode
  :name "Zig"
  :comment-prefix "// "
  :highlight :zig)

(register-mode ".zig" zig-mode)
(register-mode ".zon" zig-mode)
