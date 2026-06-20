;;; minimap.lisp — the code minimap companion pane.
;;;
;;; `M-x toggle-minimap` attaches (or removes) a narrow minimap pane
;;; beside the focused editor pane — a Nova / VS-Code-style zoomed-out
;;; rendering of the text that reflects the scroll position and is
;;; click/drag-able to navigate. The minimap mirrors whatever text the
;;; target pane currently shows (a bare text-view, or the active text tab
;;; of a tabline) and follows tab switches; a non-text view shows a
;;; not-supported message.
;;;
;;; The rendering + navigation live in the renderer's <minimap-view>
;;; element; the host wires the companion pane and bridges it to the
;;; target's live editor (apps/desktop/src/app.js). This file is just the
;;; user-facing knobs + the command.

(defgroup 'minimap 'godot "The code minimap companion pane.")

(defcustom *minimap-side* 'right :choice
  :group 'minimap
  :options '(left right)
  :doc "Which side of the editor pane the minimap attaches to: 'left or
   'right (the default).")

(defcustom *minimap-width-fraction* 0.16 :number
  :group 'minimap
  :doc "The minimap pane's share of the split, as a fraction of the
   editor pane's width. Clamped to [0.05, 0.45] by the host. Default 0.16.")

(defcommand toggle-minimap ()
  "Toggle a minimap pane beside the focused editor pane. If the pane
   already has a minimap, remove it; otherwise attach one on
   `*minimap-side*` (default right), `*minimap-width-fraction*` wide.

   The minimap mirrors the pane's active text content and follows tab
   switches; a non-text view shows a not-supported message. Unbound by
   default — bind it in your keymap or run it via M-x."
  (toggle-minimap! *minimap-side* *minimap-width-fraction*))
