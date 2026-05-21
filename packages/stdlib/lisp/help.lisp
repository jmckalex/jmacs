;;; help.lisp — the editor describes itself.
;;;
;;; Every command keeps its docstring (see define's self-documentation).
;;; These commands surface it; their output goes to the REPL.

(define (describe-key)
  "Describe the command bound to the next key pressed (C-h k)."
  (println "Describe key — press a key:")
  (read-next-key
    (lambda (key)
      (let ((binding (get the-keymap key nil)))
        (cond
          ((nil? binding)
           (println (str "  " key " is unbound")))
          ((map? binding)
           (println (str "  " key " is a prefix key")))
          (else
            (println (str "  " key " runs " (symbol->string binding)))
            (let ((info (doc (eval binding))))
              (when (string? info)
                (println (str "    " info))))))))))

(define (describe-named-command name)
  "Print the documentation of the command called NAME."
  (let ((info (doc (eval (string->symbol name)))))
    (println (str name ":"))
    (println (str "  " (if (string? info) info "(no documentation)")))))

(define (describe-command)
  "Prompt for a command by name and show its documentation (C-h f)."
  (start-describe-command!))
