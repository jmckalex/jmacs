;;; system.lisp — editor-level commands.

;; --- crash-recovery autosave ------------------------------------------
;; The host (recovery-controller.js) snapshots every unsaved buffer to
;; <userData>/recovery/ so a crash can be recovered on the next launch
;; (the *Recover* view). These read live: the host checks them on each
;; autosave, so toggling or retuning takes effect without a restart.

(defcustom *autosave-recovery* #t :boolean
  :group 'editing
  :doc "Write crash-recovery snapshots of unsaved buffers (debounced
        after edits, on window blur). Turn off to disable autosave
        entirely — note that a crash will then lose unsaved work.
        Existing snapshots are cleared on a clean quit regardless.")

(defcustom *autosave-recovery-interval* 1000 :number
  :group 'editing
  :doc "Milliseconds to wait after an edit before writing a
        crash-recovery snapshot (the autosave debounce). Lower values
        snapshot more eagerly; higher values write less often.")

(defcommand recover-session ()
  "Open the *Recover* view: scan for crash-recovery snapshots left by a
   previous run and offer to recover or discard each. Runs automatically
   at startup when snapshots are present; this is the manual entry point."
  (recover-session!))

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
