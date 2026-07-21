;;; latex-math.lisp — AUCTeX Phase 3: LaTeX-math-mode, a minor mode where
;;; a configurable prefix (default backtick `) followed by a key inserts a
;;; LaTeX math-symbol macro (`a -> \alpha, `> -> \geq, …). This is Godot's
;;; richer, LaTeX-specific, configurable port of AUCTeX's `LaTeX-math-list`.
;;;
;;; Loaded after latex-insert.lisp (AUCTeX Phase 2): it reuses that file's
;;; shared completion dispatch (`*latex-insert-candidates*` /
;;; `*latex-insert-tab-complete*` over `minibuffer-tab-complete`) for the
;;; completion fallback, and softly extends `latex-c-c-map`.
;;;
;;; NOTE: this is the math-ABBREV mode (type a macro by mnemonic), distinct
;;; from latex.lisp's math-PREVIEW mode (typeset display). They are separate
;;; minor modes and compose independently.
;;;
;;; The markdown.lisp `*math-symbols*` / `math-insert-symbol` pair is the
;;; near-precedent; this is the fuller table plus a completion fallback for
;;; an unknown key and a configurable prefix.

;; --- the symbol table -------------------------------------------------
;; Single-key (one-character string) -> LaTeX macro string. The key scheme
;; mirrors AUCTeX's `LaTeX-math-list` mnemonics:
;;
;;   * lowercase letter -> lowercase Greek by first letter (a \alpha,
;;     b \beta, g \gamma, …) — the same letter assignments markdown's
;;     *math-symbols* uses, so muscle memory carries over. "v" is \nabla
;;     and "j" is \varphi (both as in markdown / a free letter).
;;   * uppercase letter -> uppercase Greek where a distinct glyph exists
;;     (G \Gamma, D \Delta, …); the remaining capitals carry the variant
;;     Greek (those have no uppercase glyph, so the keys are free) and big
;;     operators / quantifiers (I \int, A \forall, E \exists, …), as
;;     markdown's table did.
;;   * variant Greek -> reached by a CAPITAL key with no uppercase Greek
;;     glyph: V \varepsilon, U \vartheta, B \varrho, R \varsigma,
;;     K \varpi, C \varkappa (amssymb). \varphi is "j" (above). This is the
;;     documented answer to "how do I reach \varphi/\varepsilon".
;;   * digits / punctuation -> operators, relations, arrows, sets, dots.
;;     Where markdown already chose a key (8 \infty, + \sum, * \prod,
;;     6 \partial, 0 \emptyset, < \leq, > \geq, ~ \approx, = \equiv,
;;     . \cdot) we keep it.
;;
;; Every key is a single character and every value starts with "\\"; the
;; table is conflict-free (no key appears twice) — both invariants are
;; unit-tested. The prefix key typed twice inserts a literal prefix (see
;; `latex-math-insert-symbol`), so the prefix is intentionally NOT a table
;; key (the backtick "`" here -> \angle is reachable only after the prefix).
(define *latex-math-symbols*
  {;; lowercase Greek (first-letter mnemonic; matches markdown's set)
   "a" "\\alpha"    "b" "\\beta"     "g" "\\gamma"    "d" "\\delta"
   "e" "\\epsilon"  "z" "\\zeta"     "h" "\\eta"      "q" "\\theta"
   "i" "\\iota"     "k" "\\kappa"    "l" "\\lambda"   "m" "\\mu"
   "n" "\\nu"       "x" "\\xi"       "p" "\\pi"       "r" "\\rho"
   "s" "\\sigma"    "t" "\\tau"      "u" "\\upsilon"  "f" "\\phi"
   "c" "\\chi"      "y" "\\psi"      "w" "\\omega"    "o" "\\omicron"
   "v" "\\nabla"    "j" "\\varphi"
   ;; variant Greek (capitals with no distinct uppercase glyph)
   "V" "\\varepsilon" "U" "\\vartheta" "B" "\\varrho"  "R" "\\varsigma"
   "K" "\\varpi"      "C" "\\varkappa"
   ;; uppercase Greek (distinct glyphs)
   "G" "\\Gamma"    "D" "\\Delta"    "Q" "\\Theta"    "L" "\\Lambda"
   "X" "\\Xi"       "P" "\\Pi"       "S" "\\Sigma"    "F" "\\Phi"
   "Y" "\\Psi"      "W" "\\Omega"
   ;; big operators / quantifiers
   "I" "\\int"      "A" "\\forall"   "E" "\\exists"   "T" "\\partial"
   "8" "\\infty"    "+" "\\sum"      "*" "\\prod"     "6" "\\partial"
   "0" "\\emptyset" "O" "\\oint"     "N" "\\nabla"
   "&" "\\wedge"    "|" "\\vee"      "!" "\\neg"
   ;; relations
   "<" "\\leq"      ">" "\\geq"      "=" "\\equiv"    "~" "\\approx"
   "/" "\\neq"      "{" "\\subset"   "}" "\\supset"   "[" "\\subseteq"
   "]" "\\supseteq" "(" "\\in"       ")" "\\notin"    "$" "\\sim"
   "%" "\\simeq"    "#" "\\cong"     "^" "\\propto"   "," "\\ll"
   ";" "\\gg"
   ;; products / unions / signs
   "." "\\cdot"     "_" "\\pm"       "-" "\\mp"       "Z" "\\cap"
   "J" "\\cup"      "M" "\\setminus" "H" "\\times"
   ;; arrows
   "@" "\\to"       "1" "\\rightarrow"   "2" "\\leftarrow"
   "3" "\\Rightarrow"  "4" "\\Leftarrow"  "5" "\\leftrightarrow"
   "7" "\\mapsto"
   ;; dots / misc
   "?" "\\ldots"    ":" "\\cdots"    "'" "\\prime"    "`" "\\angle"})

;; --- helpers ----------------------------------------------------------

(define (latex-math-lookup key)
  "The LaTeX macro string `*latex-math-symbols*` maps KEY to, or nil when
   KEY is unmapped."
  (get *latex-math-symbols* key nil))

(define (latex-math-macros)
  "The list of macro strings in `*latex-math-symbols*` — the candidate set
   the completion fallback completes over. Order follows the table's key
   order."
  (map (lambda (k) (get *latex-math-symbols* k)) (keys *latex-math-symbols*)))

;; --- the configurable prefix ------------------------------------------

;; The mode keymap is rebuilt from the prefix whenever the prefix changes
;; (via Customize or a programmatic `custom-apply!`). Declared before the
;; defcustom so its :on-change hook can name this procedure.
(define (latex-math-rebuild-keymap! . _)
  "(Re)build `latex-math-mode-map` from the current
   `*latex-math-abbrev-prefix*`: a one-entry map binding the prefix key to
   `latex-math-insert-symbol`. Run at load and by the defcustom's
   :on-change hook, so changing the prefix takes effect live without a
   restart. Variadic so it serves both as a plain call and as the
   (name value) :on-change callback."
  (set! latex-math-mode-map
        (hash-map *latex-math-abbrev-prefix* 'latex-math-insert-symbol)))

(defcustom *latex-math-abbrev-prefix* "`" :string
  :group 'latex
  :doc "The prefix key for LaTeX-math-mode: pressing it then a symbol key
   inserts the corresponding LaTeX math macro (see *latex-math-symbols*).
   Default is the backtick `. Pressing the prefix twice inserts a literal
   prefix. Changing this rebuilds the mode keymap live (no restart)."
  ;; Pass the procedure value (not a quoted symbol): custom-apply! runs
  ;; the hook only when `(procedure? hook)`. Mirrors themes.lisp /
  ;; jukebox.lisp, which pass an unquoted lambda.
  :on-change latex-math-rebuild-keymap!)

;; Whether to enable LaTeX-math-mode automatically in LaTeX buffers. Off by
;; default — opt in per buffer with `toggle-latex-math-mode`. NOTE: like
;; `*latex-math-preview-default*` in latex.lisp, this records the *intent*;
;; there is no major-mode entry-hook seam in the stdlib to act on it from
;; Lisp (mutating `latex-mode` would break its identity for `member`
;; checks), so auto-enable is not wired here. The flag is registered so the
;; default is discoverable/persisted and a host or init can consult it.
(defcustom *latex-math-mode-default* #f :boolean
  :group 'latex
  :doc "When #t, LaTeX-math-mode is intended to be on by default for LaTeX
   buffers. Off by default — opt in per-buffer with `toggle-latex-math-mode`.
   (Records intent; auto-enable is not wired from Lisp — see the comment in
   latex-math.lisp and the parallel *latex-math-preview-default*.)")

;; --- the insert command + completion fallback -------------------------

(define (-latex-math-complete-deliver chosen)
  "Minibuffer submit handler for the completion fallback: insert the CHOSEN
   macro string (nil / empty cancels). Clears the shared completion hook so
   the next unrelated prompt completes normally."
  (set! *latex-insert-tab-complete* nil)
  (cond
    ((nil? chosen) nil)
    ((string=? chosen "") nil)
    (else
     (insert! chosen)
     (show-status! (str "Inserted " chosen)))))

(define (-latex-math-complete-unknown key)
  "The completion fallback for an unmapped KEY: open a completing
   minibuffer over the math macro names (reusing latex-insert's shared
   third completion source) so the user can pick a symbol by macro name,
   which is then inserted."
  (set! *latex-insert-candidates* (latex-math-macros))
  (set! *latex-insert-tab-complete* -latex-insert-name-tab-complete)
  (open-completing-minibuffer! (str "Math symbol (" key " unmapped): ") "\\")
  (set! *minibuffer-reader* -latex-math-complete-deliver))

(defcommand latex-math-insert-symbol ()
  "Read one key and insert the LaTeX math macro it names. The prefix key
   typed again (e.g. ` then `) inserts a literal prefix. An unmapped key
   opens a completion prompt over the math macro names so the symbol can be
   picked by name. Armed by the prefix in `latex-math-mode-map`."
  (read-next-key
    (lambda (key)
      (cond
        ;; prefix twice -> a literal prefix character
        ((string=? key *latex-math-abbrev-prefix*)
         (insert! *latex-math-abbrev-prefix*))
        (else
         (let ((macro (latex-math-lookup key)))
           (if (nil? macro)
               (-latex-math-complete-unknown key)
               (insert! macro))))))))

;; --- the mode ---------------------------------------------------------

;; Declared empty; `latex-math-rebuild-keymap!` fills it from the prefix.
(define latex-math-mode-map {})
(latex-math-rebuild-keymap!)

(define-mode latex-math-mode
  :name "LaTeXMath"
  :keymap 'latex-math-mode-map
  :priority 10)

(defcommand toggle-latex-math-mode ()
  "Toggle the LaTeX math symbol-insertion minor mode for the current
   buffer. With it on, the prefix key (default `) arms a one-key read that
   inserts a LaTeX math macro."
  (if (member latex-math-mode (minor-modes))
      (disable-minor-mode latex-math-mode)
      (enable-minor-mode latex-math-mode)))

;; --- keybinding for the toggle ----------------------------------------
;; latex.lisp built latex-c-c-map; latex-compile, reftex-refs and
;; latex-insert extended it. Currently-bound C-c slots: b i e m M s S l n
;; C-p (latex.lisp), C-c C-v ` (latex-compile), ( ) (reftex-refs),
;; C-e ] C-m C-s C-f (latex-insert). "~" is free and mnemonic (the tilde is
;; the math active char), so bind the toggle to C-c ~. `assoc` returns a
;; fresh map; we add the slot and re-install under "C-c", not re-editing the
;; prior installs.
(set! latex-c-c-map (assoc latex-c-c-map "~" 'toggle-latex-math-mode))
(set! latex-mode-map (assoc latex-mode-map "C-c" latex-c-c-map)) ;; extend, never replace (see latex.lisp)
