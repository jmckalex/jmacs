;;; java.lisp — the Java major mode.

(define-mode java-mode
  :name "Java"
  :comment-prefix "// "
  :highlight :java)

(register-mode ".java" java-mode)
