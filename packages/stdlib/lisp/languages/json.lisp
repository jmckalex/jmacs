;;; json.lisp — the JSON major mode.

(define-mode json-mode
  :name "JSON"
  :highlight :json)

(register-mode ".json" json-mode)
