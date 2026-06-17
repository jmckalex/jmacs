;;; directory-columns.lisp — the `directory-columns` command.
;;;
;;; Opens a Finder-style columns-view buffer rooted at a directory
;;; chosen in the minibuffer (TAB completes against the filesystem),
;;; seeded at the current directory. Each column is one directory's
;;; listing; clicking a subfolder spawns a new column to its right;
;;; clicking a file replaces the trailing column with a preview pane.
;;; Double-clicking a file opens it in whichever view its suffix maps
;;; to (text editor, image, audio, video). The view itself lives in
;;; `packages/renderer/src/directory-columns-view.js`. The path-taking
;;; opener is the `open-directory-columns!` host primitive.

(define (-directory-columns-deliver path)
  "Minibuffer submit handler: open a columns-view rooted at PATH, after
   tilde expansion. Empty input (cancel) is a no-op."
  (cond ((nil? path) nil)
        ((equal? path "") nil)
        (else (open-directory-columns! (-expand-tilde path)))))

(defcommand directory-columns ()
  "Open a Finder-style column browser, choosing the root in the
   minibuffer with TAB completion against the filesystem (seeded at the
   current directory). Click a folder to drill in (spawns a column to
   its right). Click a file to preview it in the trailing column.
   Double-click a file to open it as its own buffer. q dismisses the
   buffer."
  ;; `-initial-find-file-value` (files.lisp) seeds the prompt with the
  ;; current buffer's directory and a trailing '/', home as a fallback.
  (open-completing-minibuffer! "Directory columns: " (-initial-find-file-value))
  (set! *minibuffer-reader* -directory-columns-deliver))
