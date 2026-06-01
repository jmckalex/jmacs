;;; snippets-keymap.lisp — the snippet TAB / S-TAB / cancel key bindings.
;;;
;;; Loaded after keymap.lisp and multi-cursor.lisp so it can rebind TAB
;;; and wrap the existing ESC / C-g behaviour. The precedence order when
;;; TAB is pressed (per plans/SNIPPETS.md, minus the not-yet-existing
;;; autocomplete branch):
;;;
;;;   1. A snippet is active  -> advance to the next field.
;;;   2. The word before point is a known trigger for the current mode
;;;      AND `*snippet-expand-key*` is TAB -> expand the snippet.
;;;   3. Otherwise            -> the existing TAB behaviour (insert-tab).
;;;
;;; S-TAB moves to the previous field while a snippet is active, else
;;; falls through (S-TAB is unbound globally today, so it is a no-op).
;;; ESC and C-g cancel an active snippet before their usual job.

;; --- TAB --------------------------------------------------------------

(defcommand snippet-tab ()
  "The TAB key, snippet-aware. Advances the active snippet's field, else
   expands a trigger word, else falls through to `insert-tab`. Honours
   `*snippet-expand-key*`: when it is not \"tab\", the expand branch is
   skipped and TAB only navigates an already-active snippet."
  (cond
    ((snippet-active?) (snippet-next-field))
    ((and (-snippet-tab-trigger?) (snippet-expand)) #t)
    (else (insert-tab))))

(define (-snippet-tab-trigger?)
  "True when TAB is configured as the snippet expand key."
  (let ((k *snippet-expand-key*))
    (and (not (nil? k)) (string? k) (string=? k "tab"))))

(defcommand snippet-shift-tab ()
  "Shift-TAB: step to the previous snippet field when a snippet is
   active. A no-op otherwise (S-TAB has no global binding)."
  (when (snippet-active?)
    (snippet-prev-field)))

;; --- ESC / C-g cancel -------------------------------------------------
;; `deselect` (ESC) and `keyboard-quit` (C-g) both gain a snippet-cancel
;; step ahead of their existing behaviour, so a single ESC or C-g while a
;; snippet is active discards the active record (the text stays).

(define -snippet-deselect-base deselect)

(defcommand deselect ()
  "Clear the selection on every cursor (ESC). While a snippet is active,
   cancel it first."
  (when (snippet-active?) (snippet-cancel))
  (-snippet-deselect-base))

(define -snippet-keyboard-quit-base keyboard-quit)

(defcommand keyboard-quit ()
  "Abort a partial key sequence, clear the selection, collapse cursors
   (C-g). While a snippet is active, cancel it first."
  (when (snippet-active?) (snippet-cancel))
  (-snippet-keyboard-quit-base))

;; --- bind the keys ----------------------------------------------------
;; TAB and S-TAB are rebound in the global keymap. ESC and C-g keep their
;; existing bindings (to `deselect` / `keyboard-quit`, now wrapped above).

(set! the-keymap (assoc the-keymap "tab" 'snippet-tab))
(set! the-keymap (assoc the-keymap "S-tab" 'snippet-shift-tab))
