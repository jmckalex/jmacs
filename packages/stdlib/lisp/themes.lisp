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
;;;   2. A set of face defaults — `defface` calls below register one
;;;      `:default-<theme>` block per theme (`:default-dark`,
;;;      `:default-solarized-light`, `:default-nova`, …) for every token
;;;      face (`@keyword`, `@string`, …). The renderer paints those by
;;;      generating a `<style id="face-overrides">` element, not by
;;;      writing CSS variables. A theme with no block for a given face
;;;      falls back to that face's `:default-dark` (see `-face-own-default`
;;;      in faces.lisp), so a new theme only needs blocks where it wants
;;;      to diverge from the dark defaults.
;;;
;;; Switching the theme triggers `apply-theme!`, which (i) writes the
;;; new chrome variables and (ii) regenerates `face-overrides` so any
;;; user override is reapplied under the new theme.
;;;
;;; Adding a theme is two local edits: a `define-theme` for its chrome,
;;; and a `:default-<theme>` block on each face it wants to colour. The
;;; theme then appears in the customize picker automatically (the
;;; `*theme*` setting reads its options from `registered-themes`), and
;;; resolution finds its face blocks by name — no dispatch to update.

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

;; --- the shipped themes (chrome variables only) -----------------------
;; Token colours live in the `defface` calls below — one face per token,
;; with per-theme defaults. The chrome here is what changes when a user
;; switches theme but does not customise individual faces.

(define-theme 'dark
  "Mariana — the calm default dark scheme. The editor opens in this."
  (hash-map
   "--bg"           "#2b333b"
   "--bg-chrome"    "#262d34"
   ;; Mariana's true editor background — matches Sublime Text exactly. (With
   ;; --force-color-profile=srgb in main.js, Chromium's ICC-profile transform
   ;; is off, so this hex renders raw like Sublime; the token palette below
   ;; matches too, with no per-colour pre-compensation.)
   "--bg-editor"    "#303841"
   "--bg-editor-focused" "#303841"
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

(define-theme 'solarized-light
  "Solarized Light — Ethan Schoonover's daylight scheme: a warm paper
   base (base3 #fdf6e3) under low-contrast, equiluminant accents. Pairs
   with `solarized-dark`, which shares the same accent palette."
  (hash-map
   "--bg"           "#fdf6e3"
   "--bg-chrome"    "#eee8d5"
   "--bg-editor"    "#fdf6e3"
   "--bg-editor-focused" "#fdf6e3"
   "--bg-repl"      "#eee8d5"
   "--fg"           "#073642"
   "--fg-dim"       "#586e75"
   "--accent"       "#2076b2"
   "--result"       "#687800"
   "--error"        "#dc322f"
   "--selection"    "rgba(38, 139, 210, 0.30)"
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
   ;; Editor surface matches Sublime Text's Mariana background exactly
   ;; (#303841), per Jason. Rendered raw thanks to --force-color-profile=srgb.
   ;; The FOCUSED pane sits a step darker (~10%) so the active editing
   ;; surface reads at a glance; idle panes keep the Mariana shade.
   "--bg-editor"    "#303841"
   "--bg-editor-focused" "#2b323a"
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
   "--bg-editor-focused" "#0d1117"
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

(define-theme 'solarized-dark
  "Solarized Dark — Ethan Schoonover's night scheme: the base03 #002b36
   ground under the same equiluminant accents as `solarized-light`. The
   ANSI palette is shared with the light variant (Solarized's accents are
   designed to read on either ground)."
  (hash-map
   "--bg"           "#073642"
   "--bg-chrome"    "#002b36"
   "--bg-editor"    "#002b36"
   "--bg-editor-focused" "#002b36"
   "--bg-repl"      "#073642"
   "--fg"           "#93a1a1"
   "--fg-dim"       "#657b83"
   "--accent"       "#3094da"
   "--result"       "#859900"
   "--error"        "#e56663"
   "--selection"    "rgba(38, 139, 210, 0.30)"
   ;; ANSI palette — identical accents to `solarized-light`; only the
   ;; ground differs (Solarized's whole premise).
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

(define-theme 'emacs
  "Classic Emacs — the wheat-on-darkslategray look (`(set-background-color
   \"darkslategray\")` / `(set-foreground-color \"wheat\")`) with the
   default font-lock accents: rosybrown strings, cyan keywords, sky-blue
   functions, palegreen types."
  (hash-map
   "--bg"           "#2f4f4f"
   "--bg-chrome"    "#293f3f"
   "--bg-editor"    "#2f4f4f"
   "--bg-editor-focused" "#2f4f4f"
   "--bg-repl"      "#293f3f"
   "--fg"           "#f5deb3"
   "--fg-dim"       "#8fbc8f"
   "--accent"       "#87cefa"
   "--result"       "#98fb98"
   "--error"        "#f08080"
   "--selection"    "rgba(70, 130, 180, 0.35)"
   ;; ANSI palette — classic terminal hues warmed toward the wheat/slate
   ;; ground so a coloured prompt sits in the same world as the chrome.
   "--ansi-black"          "#1c2e2e"
   "--ansi-red"            "#cd5c5c"
   "--ansi-green"          "#98fb98"
   "--ansi-yellow"         "#eedd82"
   "--ansi-blue"           "#87cefa"
   "--ansi-magenta"        "#dda0dd"
   "--ansi-cyan"           "#40e0d0"
   "--ansi-white"          "#f5deb3"
   "--ansi-bright-black"   "#5c7c7c"
   "--ansi-bright-red"     "#f08080"
   "--ansi-bright-green"   "#b4f8b4"
   "--ansi-bright-yellow"  "#f5e6a3"
   "--ansi-bright-blue"    "#a5d8ff"
   "--ansi-bright-magenta" "#eabfea"
   "--ansi-bright-cyan"    "#7fffd4"
   "--ansi-bright-white"   "#fffaf0"))

(define-theme 'nova
  "Nova — the built-in \"Dark\" theme from Panic's Nova editor: a
   near-black charcoal ground (#1b1d1f) under cool blue keywords, mint
   functions, salmon strings, gold numbers and purple identifiers.
   Colours are converted from the theme's Display-P3 source to sRGB (the
   editor's forced colour profile)."
  (hash-map
   "--bg"           "#1b1d1f"
   "--bg-chrome"    "#17181a"
   "--bg-editor"    "#1b1d1f"
   "--bg-editor-focused" "#1b1d1f"
   "--bg-repl"      "#17181a"
   "--fg"           "#ccdae7"
   "--fg-dim"       "#747b80"
   "--accent"       "#6ac1ff"
   "--result"       "#30e8ab"
   "--error"        "#ff5b4b"
   "--selection"    "rgba(96, 174, 235, 0.22)"
   ;; ANSI palette — derived from Nova Dark's syntax accents.
   "--ansi-black"          "#222526"
   "--ansi-red"            "#ff5b4b"
   "--ansi-green"          "#30e8ab"
   "--ansi-yellow"         "#efd282"
   "--ansi-blue"           "#60aeeb"
   "--ansi-magenta"        "#eb9dea"
   "--ansi-cyan"           "#00e9db"
   "--ansi-white"          "#ccdae7"
   "--ansi-bright-black"   "#5b6167"
   "--ansi-bright-red"     "#ff8f84"
   "--ansi-bright-green"   "#71ffcc"
   "--ansi-bright-yellow"  "#ffc373"
   "--ansi-bright-blue"    "#8aceff"
   "--ansi-bright-magenta" "#fed3fd"
   "--ansi-bright-cyan"    "#79f5eb"
   "--ansi-bright-white"   "#f1f9ff"))

;; --- the base face — editor typography all faces fall back to ----------
;; `default` is the root face: it owns the editor's base *typography*
;; (font size and family) — the two properties the theme system
;; deliberately leaves alone. Unlike the token faces it is NOT painted as
;; a `.tok-default` rule; the host paints its `:size`/`:family` onto the
;; editor surface (the `--font-size` / `--font-mono` CSS variables), so
;; every token face — and all plain unhighlighted text — inherits it
;; through the normal CSS cascade. Individual faces may override `:size`
;; or `:family` in their own rule, as needed. Colours stay theme-owned;
;; the base face does not set them. The same typography seeds every theme
;; (size and family are not theme-dependent); the dark-default fallback
;; covers any theme without its own block, so only the two equal blocks
;; below are needed to span all themes.
(define *base-font-family*
  "\"JetBrains Mono\", \"SF Mono\", \"Fira Code\", Menlo, Consolas, monospace")

(defface 'default
  :doc "The editor's base face. Its font size and family set the editor
        surface; every other face inherits them unless it overrides.
        Colours are theme-owned and not set here."
  :default-light    (face :size 14 :family *base-font-family*)
  :default-dark     (face :size 14 :family *base-font-family*))

;; --- face defaults — one defface per token face ------------------------
;; The 14 built-in token faces, each with per-theme defaults. A face only
;; needs a `:default-<theme>` block where it diverges from `:default-dark`
;; (the fallback). @comment is italicised in every theme
;; (Sublime/VSCode convention).
;;
;; Accent legend for the new themes:
;;   solarized-* — Schoonover's 8 accents (green keywords, cyan strings,
;;     magenta numbers, blue functions, yellow types, …) on base ground.
;;   emacs       — classic font-lock defaults (rosybrown strings, cyan
;;     keywords, sky-blue functions, palegreen types) on wheat/slate.
;;   nova        — Trevor Davis's muted pastels on blue-grey.

(defface 'comment
  :doc "Source comments — slash-slash, hash, percent — italicised."
  :default-solarized-light (face :foreground "#586e75" :slant :italic)
  :default-dark            (face :foreground "#7c8f9e" :slant :italic)
  :default-bright          (face :foreground "#8aa0b3" :slant :italic)
  :default-midnight        (face :foreground "#8b949e" :slant :italic)
  :default-solarized-dark  (face :foreground "#657b83" :slant :italic)
  :default-emacs           (face :foreground "#cd5c5c" :slant :italic)
  :default-nova            (face :foreground "#729abb" :slant :italic))

(defface 'string
  :doc "String literals: double, single, backtick."
  :default-solarized-light (face :foreground "#687800")
  :default-dark            (face :foreground "#99c794")
  :default-bright          (face :foreground "#a3d977")
  :default-midnight        (face :foreground "#a5d6ff")
  :default-solarized-dark  (face :foreground "#2aa198")
  :default-emacs           (face :foreground "#bc8f8f")
  :default-nova            (face :foreground "#ff8f84"))

(defface 'number
  :doc "Numeric literals — integers, floats, hex, etc."
  :default-solarized-light (face :foreground "#c44815")
  :default-dark            (face :foreground "#f9ae58")
  :default-bright          (face :foreground "#ffb86c")
  :default-midnight        (face :foreground "#79c0ff")
  :default-solarized-dark  (face :foreground "#dd629d")
  :default-emacs           (face :foreground "#ffa07a")
  :default-nova            (face :foreground "#efd282"))

(defface 'keyword
  :doc "Language keywords (if, return, def, let, lambda, …)."
  :default-solarized-light (face :foreground "#687800")
  :default-dark            (face :foreground "#c594c5")
  :default-bright          (face :foreground "#d56bff")
  :default-midnight        (face :foreground "#ff7b72")
  :default-solarized-dark  (face :foreground "#859900")
  :default-emacs           (face :foreground "#00ced1")
  :default-nova            (face :foreground "#60aeeb"))

(defface 'constant
  :doc "True, false, nil and other named constants."
  :default-solarized-light (face :foreground "#8f6c00")
  :default-dark            (face :foreground "#5fb4b4")
  :default-bright          (face :foreground "#56e0e0")
  :default-midnight        (face :foreground "#79c0ff")
  :default-solarized-dark  (face :foreground "#8488cd")
  :default-emacs           (face :foreground "#7fffd4")
  :default-nova            (face :foreground "#ca9fea"))

(defface 'function
  :doc "Function names — definitions and calls."
  :default-solarized-light (face :foreground "#2076b2")
  :default-dark            (face :foreground "#6699cc")
  :default-bright          (face :foreground "#82aaff")
  :default-midnight        (face :foreground "#d2a8ff")
  :default-solarized-dark  (face :foreground "#3094da")
  :default-emacs           (face :foreground "#87cefa")
  :default-nova            (face :foreground "#30e8ab"))

(defface 'variable
  :doc "Variable names in declaration position — function parameters,
        catch bindings, and similar. Sublime-style: only declarations
        get a face; references in the body read as default text."
  :default-solarized-light (face :foreground "#936932")
  :default-dark            (face :foreground "#e8a87c")
  :default-bright          (face :foreground "#f9a872")
  :default-midnight        (face :foreground "#ffcb6b")
  :default-solarized-dark  (face :foreground "#b58900")
  :default-emacs           (face :foreground "#eedd82")
  :default-nova            (face :foreground "#eb9dea"))

(defface 'type
  :doc "Type names, class names, type-position identifiers."
  :default-solarized-light (face :foreground "#8f6c00")
  :default-dark            (face :foreground "#fac863")
  :default-bright          (face :foreground "#ffd866")
  :default-midnight        (face :foreground "#ffa657")
  :default-solarized-dark  (face :foreground "#e8652e")
  :default-emacs           (face :foreground "#98fb98")
  :default-nova            (face :foreground "#00e9db"))

(defface 'tag
  :doc "HTML / XML tags and similar markup tags."
  :default-solarized-light (face :foreground "#da2825")
  :default-dark            (face :foreground "#ec5f67")
  :default-bright          (face :foreground "#ff5370")
  :default-midnight        (face :foreground "#7ee787")
  :default-solarized-dark  (face :foreground "#e56663")
  :default-emacs           (face :foreground "#f08080")
  :default-nova            (face :foreground "#30e8ab"))

(defface 'operator
  :doc "Operators (+ - * / && || == …). Contrast-bumped to a clear
        teal/cyan accent the rest of the palette avoids — without it,
        operators in tree-sitter-highlit code read as default text.
        (Solarized keeps operators a neutral structural tone — one notch
        off body text — as Schoonover's palette intends.)"
  :default-solarized-light (face :foreground "#586e75")
  :default-dark            (face :foreground "#62b3b2")
  :default-bright          (face :foreground "#82eaff")
  :default-midnight        (face :foreground "#56d4dd")
  :default-solarized-dark  (face :foreground "#839496")
  :default-emacs           (face :foreground "#b0c4de")
  :default-nova            (face :foreground "#92b3cf"))

(defface 'paren
  :doc "Punctuation: parentheses, brackets, braces. Pushed distinctly
        dimmer than text so paren-soup reads as structure, not noise."
  :default-solarized-light (face :foreground "#657b83")
  :default-dark            (face :foreground "#6b7785")
  :default-bright          (face :foreground "#8b9aab")
  :default-midnight        (face :foreground "#6e7681")
  :default-solarized-dark  (face :foreground "#657b83")
  :default-emacs           (face :foreground "#8fbc8f")
  :default-nova            (face :foreground "#92b3cf"))

(defface 'heading
  :doc "Markup headings (Markdown #, HTML h1, …)."
  :default-solarized-light (face :foreground "#2076b2" :weight :bold)
  :default-dark            (face :foreground "#fac863" :weight :bold)
  :default-bright          (face :foreground "#ffd866" :weight :bold)
  :default-midnight        (face :foreground "#ffa657" :weight :bold)
  :default-solarized-dark  (face :foreground "#3094da" :weight :bold)
  :default-emacs           (face :foreground "#ffd700" :weight :bold)
  :default-nova            (face :foreground "#ffa956" :weight :bold))

(defface 'code
  :doc "Inline code spans in prose markup."
  :default-solarized-light (face :foreground "#217d76")
  :default-dark            (face :foreground "#99c794")
  :default-bright          (face :foreground "#a3d977")
  :default-midnight        (face :foreground "#a5d6ff")
  :default-solarized-dark  (face :foreground "#2aa198")
  :default-emacs           (face :foreground "#98fb98")
  :default-nova            (face :foreground "#30e8ab"))

(defface 'link
  :doc "Hyperlinks in prose markup."
  :default-solarized-light (face :foreground "#2076b2" :underline #t)
  :default-dark            (face :foreground "#6699cc" :underline #t)
  :default-bright          (face :foreground "#82aaff" :underline #t)
  :default-midnight        (face :foreground "#58a6ff" :underline #t)
  :default-solarized-dark  (face :foreground "#3094da" :underline #t)
  :default-emacs           (face :foreground "#87cefa" :underline #t)
  :default-nova            (face :foreground "#6ac1ff" :underline #t))

;; --- the user-facing setting -------------------------------------------

(defgroup 'appearance 'godot "Editor appearance.")

(defcustom *theme* 'dark :choice
  :group 'appearance
  :options (registered-themes)
  :on-change (lambda (name value) (apply-theme!))
  :doc "The colour theme. Applied on Apply or Save in the customisation
   buffer, and re-applied on startup. The options are every registered
   theme (see `registered-themes`); the shipped set is dark (Mariana),
   bright (dark chrome with a punchier syntax palette), solarized-light,
   solarized-dark, midnight (a near-black dark), emacs (classic
   wheat-on-darkslategray) and nova (Trevor Davis's blue-grey).")

(defcustom *line-height* 1.35 :number
  :group 'appearance
  :on-change (lambda (name value) (set-css-line-height! value))
  :doc "The editor's line spacing, as a multiple of the font size (the
   surface's CSS line-height). 1.0 is tight; the default 1.35 is comfortable
   for code. Applied to the editor via the `--line-height` CSS variable —
   live on Apply, and re-applied on startup. Clamped to a sane range.")

;; --- one-time migration: `light` → `solarized-light` -------------------
;; The Solarized Light theme was originally registered as `light`; it is
;; now `solarized-light` (to pair with `solarized-dark`). A custom.lisp
;; saved before the rename selects the now-gone `light`, so the chrome
;; would fall back to dark and the picker would show a stale value. The
;; host calls this once, after custom.lisp loads, to rewrite and re-save
;; the setting. Safe to delete once no pre-rename custom.lisp can exist.
;; (Per-theme face *overrides* stored under the old `light` key are not
;; migrated — they simply stop applying; re-set them under solarized-light.)
(define (-migrate-stale-theme!)
  "Rewrite a persisted `*theme*` of `light` to `solarized-light`."
  (when (eq? *theme* 'light)
    (custom-apply-and-save! '*theme* 'solarized-light)))

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
