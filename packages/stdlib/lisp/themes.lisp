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
   "--bg-editor"    "#2e3842"
   "--bg-repl"      "#2b333b"
   "--fg"           "#d8dee9"
   "--fg-dim"       "#7c8f9e"
   "--accent"       "#6699cc"
   "--result"       "#99c794"
   "--error"        "#ec5f67"
   "--selection"    "rgba(102, 153, 204, 0.27)"
   ;; ANSI palette — Mariana-style, slightly muted so a coloured prompt
   ;; doesn't fight the editor chrome. Repeats :root's defaults so a
   ;; theme switch back from light/midnight resets cleanly.
   "--ansi-black"          "#4a5460"
   "--ansi-red"            "#ec5f67"
   "--ansi-green"          "#99c794"
   "--ansi-yellow"         "#fac863"
   "--ansi-blue"           "#6699cc"
   "--ansi-magenta"        "#c594c5"
   "--ansi-cyan"           "#5fb4b4"
   "--ansi-white"          "#d8dee9"
   "--ansi-bright-black"   "#6b7785"
   "--ansi-bright-red"     "#f08080"
   "--ansi-bright-green"   "#b8d8a8"
   "--ansi-bright-yellow"  "#fcd49a"
   "--ansi-bright-blue"    "#8cb4e0"
   "--ansi-bright-magenta" "#d8a8d8"
   "--ansi-bright-cyan"    "#9fd0d0"
   "--ansi-bright-white"   "#ffffff"))

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
   ;; ANSI palette — Solarized's accent colours, tuned for a light bg.
   "--ansi-black"          "#073642"
   "--ansi-red"            "#dc322f"
   "--ansi-green"          "#859900"
   "--ansi-yellow"         "#b58900"
   "--ansi-blue"           "#268bd2"
   "--ansi-magenta"        "#d33682"
   "--ansi-cyan"           "#2aa198"
   "--ansi-white"          "#eee8d5"
   "--ansi-bright-black"   "#586e75"
   "--ansi-bright-red"     "#cb4b16"
   "--ansi-bright-green"   "#586e75"
   "--ansi-bright-yellow"  "#657b83"
   "--ansi-bright-blue"    "#839496"
   "--ansi-bright-magenta" "#6c71c4"
   "--ansi-bright-cyan"    "#93a1a1"
   "--ansi-bright-white"   "#fdf6e3"))

(define-theme 'bright
  "Dark chrome with a punchier syntax palette — same background as
   `dark` but the token colours are saturated and luminous so they
   read as vivid rather than muted. Test bed for the customisation
   feature and a counterpoint to the calm Mariana default."
  (hash-map
   "--bg"           "#2b333b"
   "--bg-chrome"    "#262d34"
   "--bg-editor"    "#323e4a"
   "--bg-repl"      "#2b333b"
   "--fg"           "#e8eef5"
   "--fg-dim"       "#8aa0b3"
   "--accent"       "#82aaff"
   "--result"       "#a3d977"
   "--error"        "#ff5370"
   "--selection"    "rgba(130, 170, 255, 0.28)"
   ;; Bumped-saturation ANSI palette. Same hues as `dark`, brighter
   ;; and more chromatic so coloured prompts pop on the slightly
   ;; lighter background.
   "--ansi-black"          "#4a5460"
   "--ansi-red"            "#ff5370"
   "--ansi-green"          "#a3d977"
   "--ansi-yellow"         "#ffd866"
   "--ansi-blue"           "#82aaff"
   "--ansi-magenta"        "#d56bff"
   "--ansi-cyan"           "#56e0e0"
   "--ansi-white"          "#e8eef5"
   "--ansi-bright-black"   "#7a8696"
   "--ansi-bright-red"     "#ff7d8f"
   "--ansi-bright-green"   "#bfe88f"
   "--ansi-bright-yellow"  "#ffe39a"
   "--ansi-bright-blue"    "#a5c2ff"
   "--ansi-bright-magenta" "#e297ff"
   "--ansi-bright-cyan"    "#88f0f0"
   "--ansi-bright-white"   "#ffffff"))

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
   ;; ANSI palette — GitHub-dim style, brighter to read on near-black.
   "--ansi-black"          "#484f58"
   "--ansi-red"            "#ff7b72"
   "--ansi-green"          "#7ee787"
   "--ansi-yellow"         "#d29922"
   "--ansi-blue"           "#58a6ff"
   "--ansi-magenta"        "#bc8cff"
   "--ansi-cyan"           "#39c5cf"
   "--ansi-white"          "#b1bac4"
   "--ansi-bright-black"   "#6e7681"
   "--ansi-bright-red"     "#ffa198"
   "--ansi-bright-green"   "#a5d6a7"
   "--ansi-bright-yellow"  "#e3b341"
   "--ansi-bright-blue"    "#79b8ff"
   "--ansi-bright-magenta" "#d2a8ff"
   "--ansi-bright-cyan"    "#56d4dd"
   "--ansi-bright-white"   "#f0f6fc"))

;; --- face defaults — one defface per token face ------------------------
;; The 14 built-in token faces, each with three per-theme defaults.
;; @comment is italicised in all three themes (Sublime/VSCode convention).

(defface 'comment
  :doc "Source comments — slash-slash, hash, percent — italicised."
  :default-light    (face :foreground "#93a1a1" :slant :italic)
  :default-dark     (face :foreground "#7c8f9e" :slant :italic)
  :default-bright   (face :foreground "#8aa0b3" :slant :italic)
  :default-midnight (face :foreground "#8b949e" :slant :italic))

(defface 'string
  :doc "String literals: double, single, backtick."
  :default-light    (face :foreground "#859900")
  :default-dark     (face :foreground "#99c794")
  :default-bright   (face :foreground "#a3d977")
  :default-midnight (face :foreground "#a5d6ff"))

(defface 'number
  :doc "Numeric literals — integers, floats, hex, etc."
  :default-light    (face :foreground "#cb4b16")
  :default-dark     (face :foreground "#f9ae58")
  :default-bright   (face :foreground "#ffb86c")
  :default-midnight (face :foreground "#79c0ff"))

(defface 'keyword
  :doc "Language keywords (if, return, def, let, lambda, …)."
  :default-light    (face :foreground "#859900")
  :default-dark     (face :foreground "#c594c5")
  :default-bright   (face :foreground "#d56bff")
  :default-midnight (face :foreground "#ff7b72"))

(defface 'constant
  :doc "True, false, nil and other named constants."
  :default-light    (face :foreground "#b58900")
  :default-dark     (face :foreground "#5fb4b4")
  :default-bright   (face :foreground "#56e0e0")
  :default-midnight (face :foreground "#79c0ff"))

(defface 'function
  :doc "Function names — definitions and calls."
  :default-light    (face :foreground "#268bd2")
  :default-dark     (face :foreground "#6699cc")
  :default-bright   (face :foreground "#82aaff")
  :default-midnight (face :foreground "#d2a8ff"))

(defface 'variable
  :doc "Variable names in declaration position — function parameters,
        catch bindings, and similar. Sublime-style: only declarations
        get a face; references in the body read as default text."
  :default-light    (face :foreground "#b07d3c")
  :default-dark     (face :foreground "#e8a87c")
  :default-bright   (face :foreground "#f9a872")
  :default-midnight (face :foreground "#ffcb6b"))

(defface 'type
  :doc "Type names, class names, type-position identifiers."
  :default-light    (face :foreground "#b58900")
  :default-dark     (face :foreground "#fac863")
  :default-bright   (face :foreground "#ffd866")
  :default-midnight (face :foreground "#ffa657"))

(defface 'tag
  :doc "HTML / XML tags and similar markup tags."
  :default-light    (face :foreground "#dc322f")
  :default-dark     (face :foreground "#ec5f67")
  :default-bright   (face :foreground "#ff5370")
  :default-midnight (face :foreground "#7ee787"))

(defface 'operator
  :doc "Operators (+ - * / && || == …). Contrast-bumped to a clear
        teal/cyan accent the rest of the palette avoids — without it,
        operators in tree-sitter-highlit code read as default text."
  :default-light    (face :foreground "#2aa198")
  :default-dark     (face :foreground "#62b3b2")
  :default-bright   (face :foreground "#82eaff")
  :default-midnight (face :foreground "#56d4dd"))

(defface 'paren
  :doc "Punctuation: parentheses, brackets, braces. Pushed distinctly
        dimmer than text so paren-soup reads as structure, not noise."
  :default-light    (face :foreground "#b8c4c4")
  :default-dark     (face :foreground "#6b7785")
  :default-bright   (face :foreground "#8b9aab")
  :default-midnight (face :foreground "#6e7681"))

(defface 'heading
  :doc "Markup headings (Markdown #, HTML h1, …)."
  :default-light    (face :foreground "#268bd2" :weight :bold)
  :default-dark     (face :foreground "#fac863" :weight :bold)
  :default-bright   (face :foreground "#ffd866" :weight :bold)
  :default-midnight (face :foreground "#ffa657" :weight :bold))

(defface 'code
  :doc "Inline code spans in prose markup."
  :default-light    (face :foreground "#2aa198")
  :default-dark     (face :foreground "#99c794")
  :default-bright   (face :foreground "#a3d977")
  :default-midnight (face :foreground "#a5d6ff"))

(defface 'link
  :doc "Hyperlinks in prose markup."
  :default-light    (face :foreground "#268bd2" :underline #t)
  :default-dark     (face :foreground "#6699cc" :underline #t)
  :default-bright   (face :foreground "#82aaff" :underline #t)
  :default-midnight (face :foreground "#58a6ff" :underline #t))

;; --- the user-facing setting -------------------------------------------

(defgroup 'appearance 'jmacs "Editor appearance.")

(defcustom *theme* 'dark :choice
  :group 'appearance
  :options '(dark bright light midnight)
  :on-change (lambda (name value) (apply-theme!))
  :doc "The colour theme. Applied on Apply or Save in the customisation
   buffer, and re-applied on startup. Four themes ship: dark (Mariana),
   bright (dark chrome with a punchier syntax palette), light
   (Solarized Light) and midnight (a near-black dark).")

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
