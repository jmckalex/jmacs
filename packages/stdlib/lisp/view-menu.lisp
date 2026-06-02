;;; view-menu.lisp — the *View List*.
;;;
;;; `C-x C-b` opens the *View List*: a clickable HTML table of every open
;;; view, replacing the old fixed-width text *Buffer List*. The table is a
;;; `view-list`-kind view rendered by the host
;;; (packages/renderer/src/view-list-view.js): clicking a row switches to
;;; that view and the trailing ✕ kills it, so the row-level keymap the old
;;; text menu needed (RET/d/u/x/g/q, buffer-menu-mode) is gone. The host
;;; keeps the table live as views open, close and switch.
;;;
;;; The kind column now reads correctly — a browser view shows "Browser",
;;; a gnuplot view "Gnuplot", and so on — fixing the old menu, which
;;; labelled every non-text view "Fund". That logic lives in `kindLabel`
;;; in the renderer.
;;;
;;; `view-list` is the command; `buffer-menu` is kept as an alias for
;;; muscle memory, and `C-x C-b` (keymap.lisp) still points at it.

(defcommand view-list ()
  "Open the *View List* — a clickable table of every open view. Click a
   row to switch to that view; the row's ✕ kills it. The list refreshes
   live as views open and close. Bound to `C-x C-b`."
  (open-view-list!))

(defcommand buffer-menu ()
  "Alias for `view-list`, kept for Emacs muscle memory (`C-x C-b`)."
  (open-view-list!))
