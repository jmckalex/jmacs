;;; sql.lisp — the SQL major mode.

(define-mode sql-mode
  :name "SQL"
  :comment-prefix "-- "
  :highlight :sql)

(register-mode ".sql" sql-mode)
