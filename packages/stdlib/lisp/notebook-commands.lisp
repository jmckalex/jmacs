;;; notebook-commands.lisp — the user-facing commands for the reactive
;;; Lisp notebook. The reactive engine lives in notebook.lisp; this thin
;;; layer holds the `defcommand`s (and, later, keybindings) so the engine
;;; file stays loadable in a bare interpreter for its unit tests.

(defcommand notebook ()
  "Open a new reactive Lisp notebook — a sheet of named `(cell NAME EXPR)`
   cells where editing one recomputes everything downstream."
  (open-notebook-buffer!))

(defcommand rename-notebook ()
  "Rename the current notebook (its display name, not the file on disk)."
  (minibuffer-read "Rename notebook to: "
    (lambda (name)
      (when (and (not (nil? name)) (not (= name "")))
        (rename-notebook! name)))))

(defcommand next-notebook ()
  "Switch to the next open notebook."
  (next-notebook!))

(defcommand previous-notebook ()
  "Switch to the previous open notebook."
  (previous-notebook!))
