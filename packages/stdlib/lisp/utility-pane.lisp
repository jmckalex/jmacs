;;; utility-pane.lisp — Lisp surface for the tabbed utility dock.
;;;
;;; The utility pane is the chrome region at the bottom of the window (the
;;; space the REPL occupies; see app.js `createUtilityDock`). The REPL is its
;;; resident tab; commands, tools, and processes open additional tabs here
;;; instead of overlaying the editor or spawning throwaway pane-tree views.
;;;
;;; Panels are JS DOM factories registered by name on the host side; Lisp
;;; addresses them by that name through the `utility-panel-*!` primitives:
;;;   (utility-panel-open!     name [title])   ; open/reuse a tab (no focus steal)
;;;   (utility-panel-activate! id)             ; bring a tab forward + focus it
;;;   (utility-panel-append!   id text)        ; stream text into a log panel
;;;   (utility-panel-set!      id text)        ; replace a panel's content
;;;   (utility-panel-close!    id)             ; close a tab
;;;   (utility-panel-focus!)                   ; focus the active tab
;;;   (utility-cycle-tab!      [delta])        ; cycle tabs (wraps)
;;; The tab id is the panel name (single instance per name).

;; Show/hide the whole dock. `toggle-repl` (system.lisp, bound C-x p) already
;; does this; this is the discoverable alias under the new name.
(defcommand toggle-utility-dock ()
  "Show or hide the utility dock (the REPL + any tool tabs)."
  (toggle-repl!))

(defcommand focus-utility-pane ()
  "Focus the active tab in the utility dock."
  (utility-panel-focus!))

(defcommand utility-next-tab ()
  "Switch to the next tab in the utility dock."
  (utility-cycle-tab! 1))

(defcommand utility-previous-tab ()
  "Switch to the previous tab in the utility dock."
  (utility-cycle-tab! -1))

;; Helpers for tools that produce text output. `utility-output` appends
;; (streaming); `utility-output-set` replaces. Both open/reuse the named
;; panel first. These are plain functions (not commands) — building blocks
;; for command/process flows like the LaTeX compile loop.
(define (utility-output name text)
  "Open (or reuse) the named output panel and append TEXT to it."
  (utility-panel-open! name)
  (utility-panel-append! name text))

(define (utility-output-set name text)
  "Open (or reuse) the named output panel and replace its content with TEXT."
  (utility-panel-open! name)
  (utility-panel-set! name text))
