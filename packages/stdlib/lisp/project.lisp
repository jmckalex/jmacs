;;; project.lisp — the `open-project` / `close-project` commands.
;;;
;;; A *project* is a directory opened as a Nova-style workspace: a
;;; three-column layout — a directory-tree (left) rooted at the project,
;;; an editing tabline (middle), and the bookmark outline (right). Each
;;; project carries its own save-state: the files open in the editing
;;; tabline are written to `<root>/.godot/project.json` and restored when
;;; the project is reopened.
;;;
;;; The model is *additive* — the always-on global session is the "home"
;;; state. `open-project` saves home (or whichever project is current),
;;; then switches into the chosen project; `close-project` writes the
;;; project's state back and returns to home. The window reconfigures in
;;; place (single-window); a later phase adds the visual Project Chooser.
;;;
;;; The views, the layout assembly, and the per-project save-state all
;;; live host-side; this file is just the Lisp surface. The picker-opener
;;; is `open-project!`, the path-taking opener `open-project-at!`, and the
;;; closer `close-project!`.

(defcommand open-project ()
  "Choose a directory and open it as a project workspace: a directory-tree
   on the left, an editing tabline in the middle, and the bookmark outline
   on the right. The files left open in the project are restored on its
   next open. Saves the current workspace (home, or another project)
   first."
  (open-project!))

(define (-open-project-deliver path)
  "Minibuffer submit handler for `find-project`: open PATH as a project,
   after tilde expansion. Empty input (cancel) is a no-op. A non-directory
   path is reported on the status line by the host (`open-project-at!`)."
  (cond ((nil? path) nil)
        ((equal? path "") nil)
        (else (open-project-at! (-expand-tilde path)))))

(defcommand find-project ()
  "Open a project workspace, choosing the directory in the minibuffer with
   find-file-style TAB completion against the filesystem (seeded at the
   current directory). The keyboard counterpart to `open-project`, which
   pops the native directory picker."
  ;; `-initial-find-file-value` (files.lisp) seeds the prompt with the
  ;; current buffer's directory and a trailing '/', home as a fallback —
  ;; so TAB immediately lists that directory's entries.
  (open-completing-minibuffer! "Open project: " (-initial-find-file-value))
  (set! *minibuffer-reader* -open-project-deliver))

(defcommand close-project ()
  "Close the open project — saving its open-file layout to
   `<root>/.godot/project.json` — and return to the home session. A no-op
   when no project is open."
  (close-project!))
