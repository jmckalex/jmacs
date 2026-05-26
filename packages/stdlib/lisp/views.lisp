;;; views.lisp — commands for working with the open views.
;;;
;;; The editor holds a list of views with one current. A text-editing
;;; view contains an L2 buffer; image / shell / jukebox / directory-
;;; tree / etc. views hold their own state. Commands here wrap the
;;; host primitives that change which view is current and re-mount the
;;; matching renderer view.

(defcommand next-view ()
  "Switch to the next view in the list."
  (next-view!))

(defcommand previous-view ()
  "Switch to the previous view in the list."
  (previous-view!))

(defcommand new-view ()
  "Create a fresh empty text view and switch to it."
  (new-view!))

(defcommand switch-view ()
  "Switch to a view chosen by name, with completion."
  (start-buffer-switcher!))

(defcommand kill-view ()
  "Remove the current view from the list and switch to the next one.
   Killing the last view creates a fresh empty `*scratch*` text view
   so the list is never empty. Bound to `C-x k`."
  (kill-view!))
