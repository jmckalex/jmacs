;;; swift.lisp — the Swift major mode.

(define-mode swift-mode
  :name "Swift"
  :comment-prefix "// "
  :highlight :swift)

(register-mode ".swift" swift-mode)
