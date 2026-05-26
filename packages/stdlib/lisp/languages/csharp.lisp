;;; csharp.lisp — the C# major mode.

(define-mode csharp-mode
  :name "C#"
  :comment-prefix "// "
  :highlight :csharp)

(register-mode ".cs"  csharp-mode)
(register-mode ".csx" csharp-mode)
