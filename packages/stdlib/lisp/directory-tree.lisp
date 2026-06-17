;;; directory-tree.lisp — the `directory-tree` command.
;;;
;;; Opens a tree-view buffer rooted at a directory chosen in the
;;; minibuffer (TAB completes against the filesystem), seeded at the
;;; current directory. Folders expand and collapse on click (or Enter /
;;; Space when keyboard-navigated); files route through the host's
;;; open-file-path so they land in whichever view their suffix maps to
;;; (text editor, image, audio, video). The view itself lives in
;;; `packages/renderer/src/directory-tree-view.js`; this file is just
;;; the Lisp surface for invoking it. The path-taking opener is the
;;; `open-directory-tree!` host primitive.

(define (-directory-tree-deliver path)
  "Minibuffer submit handler: open a tree-view rooted at PATH, after
   tilde expansion. Empty input (cancel) is a no-op."
  (cond ((nil? path) nil)
        ((equal? path "") nil)
        (else (open-directory-tree! (-expand-tilde path)))))

(defcommand directory-tree ()
  "Open a directory tree-view, choosing the root in the minibuffer with
   TAB completion against the filesystem (seeded at the current
   directory). Click a folder row to expand/collapse, click a file to
   open it, arrow up/down to navigate, Enter to activate the selected
   row, q to dismiss the buffer."
  ;; `-initial-find-file-value` (files.lisp) seeds the prompt with the
  ;; current buffer's directory and a trailing '/', home as a fallback —
  ;; so TAB immediately lists that directory's entries.
  (open-completing-minibuffer! "Directory tree: " (-initial-find-file-value))
  (set! *minibuffer-reader* -directory-tree-deliver))
