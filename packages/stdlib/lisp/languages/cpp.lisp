;;; cpp.lisp — the C++ major mode.

(define-mode cpp-mode
  :name "C++"
  :comment-prefix "// "
  :highlight :cpp)

(register-mode ".cpp" cpp-mode)
(register-mode ".cc"  cpp-mode)
(register-mode ".cxx" cpp-mode)
(register-mode ".hpp" cpp-mode)
(register-mode ".hh"  cpp-mode)
(register-mode ".hxx" cpp-mode)
