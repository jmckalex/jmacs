;;; themes.lisp — colour themes that swap the editor's chrome
;;; variables and register the per-theme face defaults.
;;;
;;; A theme is two things together:
;;;
;;;   1. A hash-map of CSS-custom-property name → value, applied to
;;;      `document.documentElement` for editor chrome (`--bg`, `--fg`,
;;;      `--accent`, …). The CSS variables themselves are declared in
;;;      `:root` in styles.css; this file just chooses values.
;;;
;;;   2. A set of face defaults — `defface` calls below register the
;;;      :default-light / :default-dark / :default-midnight blocks for
;;;      every token face (`@keyword`, `@string`, …). The renderer
;;;      paints those by generating a `<style id="face-overrides">`
;;;      element, not by writing CSS variables.
;;;
;;; Switching the theme triggers `apply-theme!`, which (i) writes the
;;; new chrome variables and (ii) regenerates `face-overrides` so any
;;; user override is reapplied under the new theme.

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

;; --- the three shipped themes (chrome variables only) -----------------
;; Token colours live in the `defface` calls below — one face per token,
;; with per-theme defaults. The chrome here is what changes when a user
;; switches theme but does not customise individual faces.

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
   "--selection"    "rgba(102, 153, 204, 0.27)"))

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
   "--selection"    "rgba(38, 139, 210, 0.20)"))

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
   "--selection"    "rgba(88, 166, 255, 0.22)"))

;; --- face defaults — one defface per token face ------------------------
;; The 13 built-in token faces, each with three per-theme defaults.
;; @comment is italicised in all three themes (Sublime/VSCode convention).

(defface 'comment
  :doc "Source comments — slash-slash, hash, percent — italicised."
  :default-light    (face :foreground "#93a1a1" :slant :italic)
  :default-dark     (face :foreground "#7c8f9e" :slant :italic)
  :default-midnight (face :foreground "#8b949e" :slant :italic))

(defface 'string
  :doc "String literals: double, single, backtick."
  :default-light    (face :foreground "#859900")
  :default-dark     (face :foreground "#99c794")
  :default-midnight (face :foreground "#a5d6ff"))

(defface 'number
  :doc "Numeric literals — integers, floats, hex, etc."
  :default-light    (face :foreground "#cb4b16")
  :default-dark     (face :foreground "#f9ae58")
  :default-midnight (face :foreground "#79c0ff"))

(defface 'keyword
  :doc "Language keywords (if, return, def, let, lambda, …)."
  :default-light    (face :foreground "#859900")
  :default-dark     (face :foreground "#c594c5")
  :default-midnight (face :foreground "#ff7b72"))

(defface 'constant
  :doc "True, false, nil and other named constants."
  :default-light    (face :foreground "#b58900")
  :default-dark     (face :foreground "#5fb4b4")
  :default-midnight (face :foreground "#79c0ff"))

(defface 'function
  :doc "Function names — definitions and calls."
  :default-light    (face :foreground "#268bd2")
  :default-dark     (face :foreground "#6699cc")
  :default-midnight (face :foreground "#d2a8ff"))

(defface 'type
  :doc "Type names, class names, type-position identifiers."
  :default-light    (face :foreground "#b58900")
  :default-dark     (face :foreground "#fac863")
  :default-midnight (face :foreground "#ffa657"))

(defface 'tag
  :doc "HTML / XML tags and similar markup tags."
  :default-light    (face :foreground "#dc322f")
  :default-dark     (face :foreground "#ec5f67")
  :default-midnight (face :foreground "#7ee787"))

(defface 'operator
  :doc "Operators (+ - * / && || == …). Contrast-bumped to a clear
        teal/cyan accent the rest of the palette avoids — without it,
        operators in tree-sitter-highlit code read as default text."
  :default-light    (face :foreground "#2aa198")
  :default-dark     (face :foreground "#62b3b2")
  :default-midnight (face :foreground "#56d4dd"))

(defface 'paren
  :doc "Punctuation: parentheses, brackets, braces. Pushed distinctly
        dimmer than text so paren-soup reads as structure, not noise."
  :default-light    (face :foreground "#b8c4c4")
  :default-dark     (face :foreground "#6b7785")
  :default-midnight (face :foreground "#6e7681"))

(defface 'heading
  :doc "Markup headings (Markdown #, HTML h1, …)."
  :default-light    (face :foreground "#268bd2" :weight :bold)
  :default-dark     (face :foreground "#fac863" :weight :bold)
  :default-midnight (face :foreground "#ffa657" :weight :bold))

(defface 'code
  :doc "Inline code spans in prose markup."
  :default-light    (face :foreground "#2aa198")
  :default-dark     (face :foreground "#99c794")
  :default-midnight (face :foreground "#a5d6ff"))

(defface 'link
  :doc "Hyperlinks in prose markup."
  :default-light    (face :foreground "#268bd2" :underline #t)
  :default-dark     (face :foreground "#6699cc" :underline #t)
  :default-midnight (face :foreground "#58a6ff" :underline #t))

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
  "A flat alist ((\"--bg\" . \"#…\") …) for the host to apply.
   Only chrome variables now — token colours come from `defface`
   resolution and are written into `<style id=\"face-overrides\">` by
   the renderer."
  (let ((vars (theme-vars *theme*)))
    (map (lambda (k) (cons k (get vars k "")))
         (keys vars))))
