;;; browser.lisp — the `browser-view` command.
;;;
;;; Opens a web browser inside a Godot pane: an Electron <webview> wrapped
;;; in a thin toolbar (back / forward / reload / editable URL bar / stop).
;;; The page is renderer-side per-instance state (its own Chromium history /
;;; scroll), but the SERVER owns the view as a `browser` DATA-SOURCE carrying
;;; the URL — so it gets a pane slot, a tab, and rides the PANE_TREE like any
;;; other view. The path-less opener is the `open-browser-view!` spine
;;; primitive (mwb/spine.js openBrowserSource); the <browser-view> element
;;; lives in packages/renderer/src/browser-view.js.

(defgroup 'browser 'godot "The in-editor web browser view.")

(defcommand browser-view (url)
  "Open a web browser view at URL, chosen in the minibuffer. Leave the
   prompt empty to open the home page (about:blank) and type the address
   into the view's own URL bar instead. The page shows in the focused pane
   with a back / forward / reload toolbar; navigate it like any browser.
   Close it with C-x k or the tab's × (which tears the webview down)."
  (interactive (string "Browse URL: "))
  (open-browser-view! url))
