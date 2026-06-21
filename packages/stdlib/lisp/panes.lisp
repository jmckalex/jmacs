;;; panes.lisp — interactive commands for the pane tree.
;;;
;;; Phase 3a of plans/PANES.md exposes the editor area as a tree of
;;; splittable panes. Each leaf pane holds one view; splits divide the
;;; area horizontally or vertically. These commands wrap the host
;;; primitives that mutate the tree (`split-horizontal!`,
;;; `delete-pane!`, etc.) — interactive callers don't compose handles,
;;; so the wrappers ignore the primitive's return value.
;;;
;;; Key bindings live in keymap.lisp (under the C-x prefix map for
;;; the Emacs-style C-x 2 / 3 / 0 / 1 / o bindings, and on
;;; C-x C-{left,right,up,down} for spatial pane navigation).

;; --- split placeholder -------------------------------------------------
;; Splitting a pane no longer silently clones the current view into the
;; new pane (the root of the "four copies in the View List" bug).
;; Instead the new pane shows a *placeholder* chooser asking what it
;; should hold: open a file (o), clone the previous view (c), start a new
;; file (s), or run a command (r). Enter performs the default action,
;; which this setting controls.
(defgroup 'panes 'godot "Pane splitting and the split placeholder.")
(defcustom *placeholder-default-action* 'clone :choice
  :group 'panes
  :options '(open clone new command none)
  :doc "What Enter does in a fresh split's placeholder chooser: one of
   'open (find a file), 'clone (duplicate the originating view — the
   default), 'new (a fresh *scratch* view), 'command (drop into the
   run-command input), or 'none (Enter does nothing).")

;; --- pane focus border -------------------------------------------------
;; Whether the active pane draws a focus border. In a custom UI where one
;; pane always has focus (e.g. a project: passive sidebars + one editing
;; tabline) the border is just noise, so 'auto hides it unless there's a
;; real choice of focusable pane.
(defcustom *pane-focus-border* 'auto :choice
  :group 'panes
  :options '(auto on off)
  :doc "When to draw the focus border on the active pane:
     'auto — only when more than one pane is focusable, so a single
        editing surface (a project with passive sidebars, an unsplit
        window) shows none. The default.
     'on   — always draw it.
     'off  — never draw it.")

;; Read by the host (the focus-indicator refresh) on demand; redefine to
;; override the policy entirely.
(define (pane-focus-border-setting) *pane-focus-border*)

(defcommand add-pane ()
  "Enter the visual add-pane macro. An overlay over the editor area
   highlights every splitter and the four outer borders; click one to
   insert a fresh pane at that location. The new pane shows a
   *placeholder* chooser (open a file / clone the previous view / start
   a new file / run a command) and **takes focus**, so the keyboard is
   ready to answer it.

   A click on a splitter inserts a new sibling along that split's axis
   (three equal panes from the original two). A click on a border wraps
   the existing layout in a new outer split and the fresh pane occupies
   that side. Escape — or re-pressing the entry chord — cancels
   without inserting. Bound to `C-x +`."
  (enter-add-pane-mode!))

(defcommand split-horizontal ()
  "Split the current pane side-by-side. **Focus moves to the new pane**,
   which shows a placeholder chooser asking what it should hold (open a
   file, clone the previous view, start a new file, or run a command);
   Enter performs `*placeholder-default-action*` (clone by default).

   With no prefix-arg (the default) the new pane appears to the
   *right*. With `C-u` prefix it appears to the *left*. Bound to
   `C-x 3`."
  (let ((side (if (nil? *prefix-arg*) 'after 'before)))
    (split-horizontal! 0.5 side)))

(defcommand split-vertical ()
  "Split the current pane top-and-bottom. **Focus moves to the new
   pane**, which shows a placeholder chooser asking what it should hold;
   Enter performs `*placeholder-default-action*` (clone by default).

   With no prefix-arg (the default) the new pane appears *below*.
   With `C-u` prefix it appears *above*. Bound to `C-x 2`."
  (let ((side (if (nil? *prefix-arg*) 'after 'before)))
    (split-vertical! 0.5 side)))

(defcommand delete-pane ()
  "Delete the current pane — collapse its parent split into its
   sibling. No-op when the current pane is the only one in the
   window. Bound to `C-x 0`."
  (delete-pane!))

(defcommand delete-other-panes ()
  "Make the current pane fill the editor area, disposing every
   other pane. Bound to `C-x 1`."
  (delete-other-panes!))

(defcommand other-pane ()
  "Cycle focus to the next pane in display order. Bound to `C-x o`."
  (other-pane!))

(defcommand balance-panes ()
  "Reset every split's ratio to 0.5 so panes share their parent's
   space evenly."
  (balance-panes!))

(defcommand focus-pane-left ()
  "Focus the pane immediately to the left of the current one, if any."
  (focus-pane-direction! 'left))

(defcommand focus-pane-right ()
  "Focus the pane immediately to the right of the current one, if any."
  (focus-pane-direction! 'right))

(defcommand focus-pane-up ()
  "Focus the pane immediately above the current one, if any."
  (focus-pane-direction! 'up))

(defcommand focus-pane-down ()
  "Focus the pane immediately below the current one, if any."
  (focus-pane-direction! 'down))

;; --- close-vs-kill aliases --------------------------------------------
;; jmacs's split between `delete-pane!` (collapses a pane; the view stays
;; in the global list, reachable via `switch-view` / buffer-menu) and
;; `kill-view!` (removes the view entirely) is the same distinction
;; Emacs makes between `C-x 0` (delete-window) and `C-x k` (kill-buffer).
;; These aliases give the everyday name the lighter sense — "close this
;; but don't throw it away" — for users coming from a non-Emacs editor.

(defcommand close-pane ()
  "Close the current pane (collapse its parent split into its sibling)
   while keeping every view alive in the global list. Same as
   `delete-pane`; the view is reachable via `switch-view` or the
   buffer-menu afterwards. To remove the view itself, use `kill-view`."
  (delete-pane!))

(defcommand close-tab ()
  "Close the active tab in the focused tabline-view. The view leaves
   the strip but stays alive in the global list (reachable via
   `switch-view`). When it was the LAST tab, the pane collapses into its
   sibling (`close-pane`) — the view still stays alive; at the sole root
   pane there is nothing to collapse into, so the last tab stays put. To
   remove the view itself, use `kill-view`."
  (let ((tlv (current-tabline)))
    (when (not (nil? tlv))
      (if (> (length (tabline-tabs tlv)) 1)
          (remove-tab! tlv (tabline-active tlv))
          (close-pane)))))

;; --- moving views between panes ---------------------------------------
;; Three workflows the user wanted:
;;   1. Move the focused view to the OTHER pane.
;;   2. Move the focused tab to the OTHER pane's tabline.
;;   3. Swap views between two panes.
;; The "other pane" is whichever leaf `other-pane!` picks — i.e., the
;; next leaf in display order. The commands fall through to a no-op when
;; there's only one pane in the window.

(define (-other-leaf-pane)
  "The next leaf-pane in display order, or nil when only one leaf
   exists. Used by send-view-to-other-pane / swap-with-other-pane to
   find the target pane without changing focus."
  (let* ((before (current-pane))
         (next (begin (other-pane!) (current-pane))))
    ;; Restore focus to the originating pane.
    (when (and (not (nil? before)) (not (eq? before next)))
      (other-pane!))
    (if (or (nil? next) (eq? before next)) nil next)))

(defcommand send-view-to-other-pane ()
  "Send the focused view to the next pane in display order. Both ends
   are promoted to tabline-views (idempotent — a pane that's already
   a tabline is left alone) and the focused tab moves across via
   `move-tab!`. The view becomes the active tab in the destination.
   If the source had only this one tab, its strip becomes empty
   afterwards — `(close-pane)` will collapse it.
   No-op when there's only one pane in the window."
  (let* ((src-pane (current-pane))
         (dst-pane (-other-leaf-pane)))
    (when (and (not (nil? src-pane)) (not (nil? dst-pane)))
      (let* ((src-tlv (promote-to-tabline! src-pane))
             (dst-tlv (promote-to-tabline! dst-pane)))
        (when (and (not (nil? src-tlv)) (not (nil? dst-tlv)))
          (move-tab! src-tlv (tabline-active src-tlv) dst-tlv))))))

(defcommand send-tab-to-other-pane ()
  "Send the focused tab to the next pane's tabline. Alias for
   `send-view-to-other-pane` — both promote-to-tabline as needed and
   move the active tab."
  (send-view-to-other-pane))

(defcommand swap-with-other-pane ()
  "Swap the views shown in the current pane and the next pane in
   display order. Both panes keep their identity; only their views
   exchange. No-op when there's only one pane."
  (let* ((src-pane (current-pane))
         (dst-pane (-other-leaf-pane)))
    (when (and (not (nil? src-pane))
               (not (nil? dst-pane)))
      (swap-panes! src-pane dst-pane))))

;; --- numbered swap / permute (plans/PANES-SWAP-PERMUTE.md) -------------
;; These number every pane with a badge (clockwise spiral from the
;; top-left pane) and read pane numbers from the keyboard. The move is a
;; frame-move — panes keep their sizes, contents trade places, and a
;; browser/pdf/shell pane survives. Reachable from the View menu too,
;; since a focused <webview> swallows C-x chords.

(defcommand swap-views ()
  "Swap which view two panes show. Numbers every pane with a badge in its
   top-left corner; type the two pane numbers, then Enter to swap them.
   Space confirms an ambiguous number, Delete undoes, Escape cancels.
   The panes keep their sizes — only their contents trade places. No-op
   with fewer than two panes."
  (if (< (length (panes-in-spiral-order)) 2)
      (show-status! "swap-views: need at least two panes")
      (enter-move-views-mode! 'swap)))

(defcommand permute-views ()
  "Rearrange which view every pane shows. Numbers every pane, then reads
   a destination for pane 1, pane 2, … in turn (the last is filled in
   automatically). Enter applies the whole rearrangement at once; Delete
   steps back; Escape cancels. Panes keep their sizes; contents move.
   No-op with fewer than two panes."
  (if (< (length (panes-in-spiral-order)) 2)
      (show-status! "permute-views: need at least two panes")
      (enter-move-views-mode! 'permute)))
