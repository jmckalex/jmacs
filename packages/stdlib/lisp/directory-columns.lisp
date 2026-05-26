;;; directory-columns.lisp — the `(directory-columns)` command.
;;;
;;; Opens a Finder-style columns-view buffer rooted at PATH. Each
;;; column is one directory's listing; clicking a subfolder spawns a
;;; new column to its right; clicking a file replaces the trailing
;;; column with a preview pane. Double-clicking a file opens it in
;;; whichever view its suffix maps to (text editor, image, audio,
;;; video). The view itself lives in
;;; `packages/renderer/src/directory-columns-view.js`.

(define (directory-columns path)
  "Open a Finder-style column-browser rooted at PATH.

   Click a folder to drill in (spawns a column to its right). Click a
   file to preview it in the trailing column. Double-click a file to
   open it as its own buffer in whichever view its suffix maps to.
   q dismisses the buffer."
  (open-directory-columns! path))
