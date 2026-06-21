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
  "Open PATH from a directory tree-view, honouring
   `*directory-tree-open-target*`. The tree-view calls this when a file is
   double-clicked or Enter-activated; redefine it to customise the routing
   entirely (it's the policy layer over the `open-file-from-tree!` host
   primitive)."
  (open-file-from-tree! path *directory-tree-open-target*))

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
