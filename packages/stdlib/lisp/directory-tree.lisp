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

(defgroup 'directory-tree 'godot "The directory tree-view sidebar.")

(defcustom *directory-tree-open-target* 'editing-pane :choice
  :group 'directory-tree
  :options '(editing-pane other-pane this-pane)
  :doc "Where a file opens when double-clicked (or Enter-activated) in a
   directory tree-view:
     'editing-pane — the main editing area: a tabline / text pane that
        isn't the tree or another sidebar. For a project this is the
        middle tabline. The default.
     'other-pane   — the next editing pane after the tree.
     'this-pane    — the tree's own pane (promoted to a tabline); the
        original behaviour.")

(define (directory-tree-open-file path)
  "Open PATH from a directory tree-view. Prefers the dir-tree's wired target
   pane — a leaf id `open-project` sets so files land in the project's editing
   tabline (bulletproof: no guessing which pane is the editing area). Falls
   back to `*directory-tree-open-target*` when no pane is wired (a standalone
   `directory-tree`). The tree-view calls this on a file double-click / Enter;
   redefine it to customise the routing entirely."
  (let ((wired (current-directory-tree-target)))
    (open-file-from-tree!
     path
     (if (nil? wired) *directory-tree-open-target* wired))))

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
