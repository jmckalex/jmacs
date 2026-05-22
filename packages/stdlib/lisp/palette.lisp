;;; palette.lisp — the command palette (M-x).
;;;
;;; Loaded after keymap.lisp, so it can read `the-keymap`. The palette
;;; offers every command; the interactive matching loop runs in the
;;; minibuffer (host code).

(define (-keymap-commands keymap)
  "Collect command names from a keymap and any nested keymaps."
  (reduce (lambda (names binding)
            (cond
              ((symbol? binding) (cons (symbol->string binding) names))
              ((map? binding) (append (-keymap-commands binding) names))
              (else names)))
          (list)
          (vals keymap)))

(define (command-names)
  "Every command name M-x offers — those in the command registry plus
   any still reachable only from the keymap. The two overlap while the
   defcommand migration is in progress; the caller de-duplicates."
  (append (registered-command-names)
          (-keymap-commands the-keymap)))

(defcommand execute-command ()
  "Prompt for a command by name and run it — the M-x command."
  (start-command-palette!))
