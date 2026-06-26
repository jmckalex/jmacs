;;; element-view-notebook-js.lisp — the JavaScript notebook as a view.
;;;
;;; `M-x notebook-js` opens an Observable-like notebook in a pane: a column
;;; of cells, each a JavaScript snippet that runs as an `AsyncFunction`
;;; (top-level `await` for free) and produces a rich output — the cell's
;;; value, console logs, or error, rendered as text / json / table / html.
;;; See packages/renderer/src/notebook-js-view.js + notebook-js-engine.js.
;;;
;;; The `<notebook-js-view>` custom element is bundled with the renderer
;;; (registered from packages/renderer/src/index.js), so `:module` is the
;;; empty string — there is nothing extra to import; the generic
;;; element-view wrapper just creates the already-registered tag.
;;;
;;; `:keyboard 'share` so a cell's `<textarea>` receives plain typing while
;;; C-/M-/A- editor chords still pass through (so M-x / C-x b work); the
;;; view runs a cell on Shift-Enter.
;;;
;;; This is the FLAG-OFF MVP: cells evaluate in the renderer's own context
;;; with the view's built-in local facade. The Model-B port — evaluating in
;;; the SERVER's Node session alongside the Lisp interpreter — swaps the
;;; view's local `runCell` for a message round-trip (the engine and the
;;; output descriptors are unchanged). See plans/NOTEBOOK-JS.md.

(define-element-view notebook-js
  :title    "JS Notebook"
  :module   ""
  :tag      "notebook-js-view"
  :fit      'fill
  :keyboard 'share)
