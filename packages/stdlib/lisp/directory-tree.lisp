;;; directory-tree.lisp — the `(directory-tree)` command.
;;;
;;; Opens a tree-view buffer rooted at a directory. Folders expand and
;;; collapse on click (or Enter / Space when keyboard-navigated);
;;; files route through the host's open-file-path so they land in
;;; whichever view their suffix maps to (text editor, image, audio,
;;; video). The view itself lives in
;;; `packages/renderer/src/directory-tree-view.js`; this file is just
;;; the Lisp surface for invoking it.

(define (directory-tree path)
  "Open a directory tree-view rooted at PATH.

   The buffer that appears is shown through the L4 directory-tree
   view (not the text editor view); click a folder row to
   expand/collapse, click a file to open it, arrow up/down to
   navigate, Enter to activate the selected row, q to dismiss the
   buffer."
  (open-directory-tree! path))
