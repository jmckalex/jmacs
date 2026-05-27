;;; tabline.lisp — interactive commands for tabline-views.
;;;
;;; Phase 3b of plans/PANES.md introduces the tabline-view: a
;;; structural view that wraps several leaf-kind views into a tab
;;; strip plus a content area, all inside a single pane. The host
;;; primitives `promote-to-tabline!`, `demote-tabline!`, `add-tab!`,
;;; `remove-tab!`, `activate-tab!`, `tabline-edge`, `set-tabline-edge!`
;;; and `current-tabline` live in pane-primitives.js; this file
;;; provides the user-facing `defcommand` wrappers.
;;;
;;; No new key bindings: the existing `kill-view`, `next-view`,
;;; `previous-view`, `switch-view` commands change their underlying
;;; behaviour (commit 5 of the 3b rollout), not their bindings. The
;;; commands here are exposed for explicit composition from `init.lisp`
;;; or the REPL — promotion / demotion is a deliberate user action,
;;; not something the editor does silently.

(defcommand promote-to-tabline ()
  "Wrap the current pane's view in a fresh tabline-view, with the
   existing view as the sole tab. When the pane already holds a
   tabline-view, this is a no-op (the existing tabline is returned).

   After promotion, opening more files in this pane appends them as
   tabs (commit 5 of phase 3b); switching between them uses the
   existing `next-view!` / `previous-view!` keys."
  (promote-to-tabline!))

(defcommand demote-tabline ()
  "Replace the current pane's tabline-view with its active child's
   view. The pane goes back to being a plain leaf. Other tabs are
   dropped from the pane (their views remain in the global view list
   — `C-x b` can switch back to them). No-op when the current pane
   doesn't hold a tabline-view."
  (demote-tabline!))

(defcommand tabline-edge-top ()
  "Render the current pane's tabline strip on the top edge of the
   pane (the default). No-op when the current pane doesn't hold a
   tabline-view."
  (let ((tlv (current-tabline)))
    (if (nil? tlv) nil (set-tabline-edge! tlv 'top))))

(defcommand tabline-edge-bottom ()
  "Render the current pane's tabline strip on the bottom edge of the
   pane. No-op when the current pane doesn't hold a tabline-view."
  (let ((tlv (current-tabline)))
    (if (nil? tlv) nil (set-tabline-edge! tlv 'bottom))))

(defcommand tabline-edge-left ()
  "Render the current pane's tabline strip on the left edge of the
   pane. The vertical-strip layout stacks tabs column-wise; labels
   stay normal-orientation (no rotated text). No-op when the current
   pane doesn't hold a tabline-view."
  (let ((tlv (current-tabline)))
    (if (nil? tlv) nil (set-tabline-edge! tlv 'left))))

(defcommand tabline-edge-right ()
  "Render the current pane's tabline strip on the right edge of the
   pane. The vertical-strip layout stacks tabs column-wise; labels
   stay normal-orientation. No-op when the current pane doesn't hold
   a tabline-view."
  (let ((tlv (current-tabline)))
    (if (nil? tlv) nil (set-tabline-edge! tlv 'right))))
