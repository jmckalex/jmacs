;;; bookmarks.lisp — Emacs-style bookmarks: named, persistent positions
;;; in a text buffer that ride edits and survive across sessions. The
;;; positions are buffer markers (invisible, edit-tracking; see
;;; packages/buffer) named and persisted by the host engine
;;; (apps/desktop/src/bookmarks.js). Bound under the C-x r prefix.

;; A minor mode, on by default in every text buffer (see
;; *default-text-minor-modes* in modes.lisp). It carries no keymap of its
;; own — the set / jump / delete keys are global under C-x r — it just
;; marks the buffer as bookmark-capable and shows in the modeline.
(define-mode bookmark-minor-mode
  :name "Bookmark"
  :keymap nil
  :priority 5)

(register-default-text-minor-mode bookmark-minor-mode)

(defcommand bookmark-set (name)
  "Set (or move) a named bookmark at point. Re-using a name moves it.
   Bound to C-x r m."
  (interactive (string "Set bookmark: "))
  (bookmark-set! name))

(defcommand bookmark-jump (name)
  "Jump to a named bookmark. Bound to C-x r b."
  (interactive (string "Jump to bookmark: "))
  (bookmark-jump! name))

(defcommand bookmark-delete (name)
  "Delete a named bookmark. (No default key — C-x r d is Emacs's
   delete-rectangle; delete via M-x or the bookmark list.)"
  (interactive (string "Delete bookmark: "))
  (bookmark-delete! name))
