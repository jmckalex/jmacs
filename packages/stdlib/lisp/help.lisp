;;; help.lisp — the editor describes itself.
;;;
;;; Every command keeps its docstring (see define's self-documentation).
;;; These commands surface it; their output goes to the REPL.

(defcommand describe-key ()
  "Describe the command bound to the next key pressed (C-h k). When
   the bound command has a documentation page (see `docs.lisp`),
   opens the page in a doc buffer; otherwise prints the docstring
   to the REPL."
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
            (let ((name (symbol->string binding)))
              (println (str "  " key " runs " name))
              (if (doc-known? name)
                  (open-doc! name)
                  (let ((info (doc (eval binding))))
                    (when (string? info)
                      (println (str "    " info))))))))))))

(define (describe-named-command name)
  "Show the documentation of the command called NAME. Opens the
   doc page when one exists; otherwise prints the docstring to
   the REPL."
  (if (doc-known? name)
      (open-doc! name)
      (let ((info (doc (eval (string->symbol name)))))
        (println (str name ":"))
        (println (str "  " (if (string? info) info "(no documentation)"))))))

(defcommand describe-command ()
  "Prompt for a command by name and show its documentation (C-h f)."
  (start-describe-command!))
