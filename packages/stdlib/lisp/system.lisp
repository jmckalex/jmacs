;;; system.lisp — editor-level commands.

(defcommand reload-stdlib ()
  "Re-evaluate the standard library, picking up any edits to it.
   Because commands are bound by name and resolved late, the running
   editor switches to the new definitions at once — hot reload."
  (reload-stdlib!))

(defcommand quit-editor ()
  "Quit the editor (C-x C-c)."
  (quit-editor!))

(defcommand toggle-repl ()
  "Show or hide the REPL panel (C-x p)."
  (toggle-repl!))
