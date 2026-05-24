;;; themes.lisp — colour themes that swap the editor's CSS variables.
;;;
;;; A theme is a hash-map of CSS-custom-property name → value. The host
;;; applies a theme by writing each entry to document.documentElement's
;;; inline style. The CSS variables themselves are declared in :root in
;;; styles.css; this file just chooses values for them.

(define *themes* {})

(define (define-theme name doc vars)
  "Register a theme: NAME (a symbol), DOC, and a hash-map VARS of
   CSS-variable strings (e.g. \"--bg\") to value strings."
  (set! *themes*
        (assoc *themes* name
               (hash-map :name name :doc doc :vars vars))))

(define (registered-themes)
  "The names of every registered theme."
  (keys *themes*))

(define (theme-vars name)
  "The :vars hash-map of theme NAME, or the dark theme's as a fallback."
  (let ((entry (get *themes* name nil)))
    (if (nil? entry)
        (get (get *themes* 'dark {}) :vars {})
        (get entry :vars {}))))

;; --- the three shipped themes ------------------------------------------

(define-theme 'dark
  "Mariana — the calm default dark scheme. The editor opens in this."
  (hash-map
   "--bg"           "#2b333b"
   "--bg-chrome"    "#262d34"
   "--bg-editor"    "#303841"
   "--bg-repl"      "#2b333b"
   "--fg"           "#d8dee9"
   "--fg-dim"       "#7c8f9e"
   "--accent"       "#6699cc"
   "--result"       "#99c794"
   "--error"        "#ec5f67"
   "--selection"    "rgba(102, 153, 204, 0.27)"
   "--tok-comment"  "#7c8f9e"
   "--tok-string"   "#99c794"
   "--tok-number"   "#f9ae58"
   "--tok-keyword"  "#c594c5"
   "--tok-constant" "#5fb4b4"
   "--tok-function" "#6699cc"
   "--tok-type"     "#fac863"
   "--tok-tag"      "#ec5f67"
   "--tok-operator" "#62b3b2"
   "--tok-paren"    "#6b7785"
   "--tok-heading"  "#fac863"
   "--tok-code"     "#99c794"
   "--tok-link"     "#6699cc"))

(define-theme 'light
  "Solarized Light — easy on the eyes in daylight."
  (hash-map
   "--bg"           "#fdf6e3"
   "--bg-chrome"    "#eee8d5"
   "--bg-editor"    "#fdf6e3"
   "--bg-repl"      "#eee8d5"
   "--fg"           "#586e75"
   "--fg-dim"       "#93a1a1"
   "--accent"       "#268bd2"
   "--result"       "#859900"
   "--error"        "#dc322f"
   "--selection"    "rgba(38, 139, 210, 0.20)"
   "--tok-comment"  "#93a1a1"
   "--tok-string"   "#859900"
   "--tok-number"   "#cb4b16"
   "--tok-keyword"  "#859900"
   "--tok-constant" "#b58900"
   "--tok-function" "#268bd2"
   "--tok-type"     "#b58900"
   "--tok-tag"      "#dc322f"
   "--tok-operator" "#2aa198"
   "--tok-paren"    "#b8c4c4"
   "--tok-heading"  "#268bd2"
   "--tok-code"     "#2aa198"
   "--tok-link"     "#268bd2"))

(define-theme 'midnight
  "A second dark theme — higher-contrast, near-black background."
  (hash-map
   "--bg"           "#0d1117"
   "--bg-chrome"    "#0a0e14"
   "--bg-editor"    "#0d1117"
   "--bg-repl"      "#0a0e14"
   "--fg"           "#c9d1d9"
   "--fg-dim"       "#8b949e"
   "--accent"       "#58a6ff"
   "--result"       "#7ee787"
   "--error"        "#ff7b72"
   "--selection"    "rgba(88, 166, 255, 0.22)"
   "--tok-comment"  "#8b949e"
   "--tok-string"   "#a5d6ff"
   "--tok-number"   "#79c0ff"
   "--tok-keyword"  "#ff7b72"
   "--tok-constant" "#79c0ff"
   "--tok-function" "#d2a8ff"
   "--tok-type"     "#ffa657"
   "--tok-tag"      "#7ee787"
   "--tok-operator" "#56d4dd"
   "--tok-paren"    "#6e7681"
   "--tok-heading"  "#ffa657"
   "--tok-code"     "#a5d6ff"
   "--tok-link"     "#58a6ff"))

;; --- the user-facing setting -------------------------------------------

(defgroup 'appearance 'jmacs "Editor appearance.")

(defcustom *theme* 'dark :choice
  :group 'appearance
  :options '(dark light midnight)
  :on-change (lambda (name value) (apply-theme!))
  :doc "The colour theme. Applied on Apply or Save in the customisation
   buffer, and re-applied on startup. Three themes ship: dark (Mariana),
   light (Solarized Light) and midnight (a near-black dark).")

;; --- the symbol-string protocol exposed to the host --------------------
;; The host reads `(current-theme-css-vars)` and writes each pair onto
;; document.documentElement.style — no native bridge needed.

(define (current-theme-css-vars)
  "A flat alist ((\"--bg\" . \"#…\") …) for the host to apply."
  (let ((vars (theme-vars *theme*)))
    (map (lambda (k) (cons k (get vars k "")))
         (keys vars))))
