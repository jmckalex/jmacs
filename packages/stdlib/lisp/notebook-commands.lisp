;;; notebook-commands.lisp — the user-facing commands for the reactive
;;; Lisp notebook. The reactive engine lives in notebook.lisp; this thin
;;; layer holds the `defcommand`s (and, later, keybindings) so the engine
;;; file stays loadable in a bare interpreter for its unit tests.

(defcommand notebook ()
  "Open a new reactive Lisp notebook — a sheet of named `(cell NAME EXPR)`
   cells where editing one recomputes everything downstream."
  (open-notebook-buffer!))
