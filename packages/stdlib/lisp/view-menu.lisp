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
;;; `view-list!` is the command that OPENS the list — it has a side
;;; effect, so it takes the `!` suffix; `list-views` is the view-vocab
;;; command name, and `C-x C-b` (keymap.lisp) points at `list-views`.
;;; IMPORTANT: the bare `view-list` name belongs to the host PRIMITIVE
;;; that returns the array of open view handles. The command must NOT be
;;; called `view-list`, or it shadows that primitive and Lisp callers that
;;; enumerate views (latex/reftex) open the GUI instead of getting the
;;; data. Hence the `!`.

(defcommand view-list! ()
  "Open the *View List* — a clickable table of every open view. Click a
   row to switch to that view; the row's ✕ kills it. The list refreshes
   live as views open and close. Also reachable as `list-views` / `C-x
   C-b`. (The `!` marks the side effect and keeps the name clear of the
   `(view-list)` primitive that returns the view-handle array.)"
  (open-view-list!))

(defcommand list-views ()
  "List the open views and pick one (`C-x C-b`). The keyboard-facing name
   for `view-list!`; a *view* is the general surface (only text views have a
   buffer), so the vocabulary is view-centric, not buffer-centric."
  (open-view-list!))
