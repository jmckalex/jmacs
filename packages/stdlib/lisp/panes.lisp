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

(defcommand split-horizontal ()
  "Split the current pane side-by-side. The originating pane becomes
   the left child and keeps focus; the right child gets a duplicate
   view over the same buffer (text views) or the `*scratch*` view
   (non-text views). Bound to `C-x 3`."
  (split-horizontal!))

(defcommand split-vertical ()
  "Split the current pane top-and-bottom. The originating pane becomes
   the top child and keeps focus; the bottom child gets a duplicate
   view (text) or `*scratch*` (non-text). Bound to `C-x 2`."
  (split-vertical!))

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
  (other-pane))

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
