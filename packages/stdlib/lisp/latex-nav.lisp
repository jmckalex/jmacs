;;; latex-nav.lisp — AUCTeX Phase 5: navigation & niceties for latex-mode.
;;;
;;; Phase 5 of plans/AUCTeX.md: the small daily-motion + typing niceties
;;; that round out latex-mode. All of it is Lisp on existing primitives —
;;; no new host primitives, no new view kinds. The commands:
;;;
;;;   C-c C-n  latex-next-section       — jump to the next sectioning macro
;;;   C-c C-r  latex-previous-section   — jump to the previous one
;;;   C-c %    latex-goto-matching-env  — \begin{X} <-> matching \end{X}
;;;   M-RET    latex-insert-item        — \item inside a list, else newline
;;;   "        latex-smart-quote        — `` / '' / literal " by context
;;;
;;; The comment-toggle nicety the plan also mentions already ships as the
;;; global C-c ; (comment-line); Phase 5 leaves it untouched.
;;;
;;; Loaded AFTER latex-math.lisp (AUCTeX Phase 3): it extends `latex-c-c-map`
;;; further (C-c C-n / C-c C-r / C-c %) and adds TWO top-level keys to
;;; `latex-mode-map` (M-RET, "). It reuses latex-insert.lisp's
;;; `-latex-innermost-open-env` for the list-environment detection, so it
;;; loads after that file too.
;;;
;;; ## Design — the pure core
;;;
;;; Everything that can be a pure function is one, so it is unit-testable
;;; without a buffer, a view, or the minibuffer (see latex-nav.test.js):
;;;
;;;   * `next-section-offset` / `prev-section-offset` — (text, from)->offset
;;;     or nil : the offset of the next / previous sectioning macro. The
;;;     commands read `(buffer-text)` + `(point)`, call these, and `goto!`,
;;;     so the scan logic has a single, tested source of truth.
;;;   * `latex-match-offset` — (text, offset)->offset or nil : the matching
;;;     \begin/\end delimiter for the one at OFFSET (nesting-aware).
;;;   * `smart-quote-for` — (prev-char)->"``" | "''" | "\"" : the
;;;     open/close/literal decision for the smart-quote command.
;;;   * `latex-list-env-at` — (text, offset)->env-or-nil : the innermost
;;;     enclosing list environment (itemize/enumerate/description), or nil,
;;;     reusing latex-insert's `-latex-innermost-open-env`.
;;;
;;; The commands are thin impure wrappers that gather text/offset, call the
;;; pure core, and `goto!` / `insert!`. The point-movement and insert
;;; round-trips themselves are live-smoke.

;; --- pure: the sectioning macros --------------------------------------
;; The sectioning commands Phase 5 navigates between, longest-first so a
;; prefix scan never mistakes \subsection for \section. Starred forms are
;; matched by allowing an optional `*` after the name (handled in the
;; matcher, not the list).

(define *latex-section-macros*
  (list "\\subsubsection" "\\subsection" "\\section"
        "\\subparagraph" "\\paragraph"
        "\\chapter" "\\part"))

(define (-latex-section-macro-at text i)
  "If a sectioning macro begins exactly at index I in TEXT, the macro's
   full length (including a trailing `*` and so that the NEXT char is not a
   letter — i.e. it is a real control word, not a prefix of a longer one);
   else 0. PURE."
  (-latex-section-macro-at-loop text i *latex-section-macros*))

(define (-latex-section-macro-at-loop text i macros)
  (cond
    ((nil? macros) 0)
    (else
     (let ((len (-latex-section-macro-match text i (car macros))))
       (if (> len 0) len (-latex-section-macro-at-loop text i (cdr macros)))))))

(define (-latex-section-macro-match text i macro)
  "The matched length if MACRO occurs at I in TEXT as a complete control
   word (next char after the name is not a letter; an optional `*` is part
   of the match), else 0."
  (let ((mlen (string-length macro)))
    (if (and (<= (+ i mlen) (string-length text))
             (string=? (substring text i (+ i mlen)) macro)
             (not (-latex-nav-letter-at? text (+ i mlen))))
        ;; A complete control word. Absorb a trailing `*` (starred form).
        (if (and (< (+ i mlen) (string-length text))
                 (string=? (substring text (+ i mlen) (+ i mlen 1)) "*"))
            (+ mlen 1)
            mlen)
        0)))

(define (-latex-nav-letter-at? text i)
  "Whether the character at index I in TEXT is an ASCII letter (so a
   sectioning name isn't matched as a prefix of a longer macro like
   \\sectioning). Out-of-range is #f."
  (if (>= i (string-length text))
      #f
      (-latex-nav-letter? (substring text i (+ i 1)))))

(define *latex-nav-letters*
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")

(define (-latex-nav-letter? c)
  "Whether single-character string C is an ASCII letter."
  (>= (string-index-of *latex-nav-letters* c) 0))

(define (next-section-offset text from)
  "The offset of the next sectioning macro strictly AFTER FROM in TEXT, or
   nil when there is none. Scans forward for a `\\section`-family control
   word (starred forms included). PURE."
  (-latex-next-section-loop text (+ from 1)))

(define (-latex-next-section-loop text i)
  (cond
    ((>= i (string-length text)) nil)
    ((> (-latex-section-macro-at text i) 0) i)
    (else (-latex-next-section-loop text (+ i 1)))))

(define (prev-section-offset text from)
  "The offset of the previous sectioning macro strictly BEFORE FROM in
   TEXT, or nil when there is none. Scans backward for a `\\section`-family
   control word (starred forms included). PURE."
  (-latex-prev-section-loop text (- from 1)))

(define (-latex-prev-section-loop text i)
  (cond
    ((< i 0) nil)
    ((> (-latex-section-macro-at text i) 0) i)
    (else (-latex-prev-section-loop text (- i 1)))))

;; --- pure: the section title (for the echo) ---------------------------

(define (-latex-section-title text offset)
  "The `{…}` title of the sectioning macro that begins at OFFSET in TEXT,
   or the empty string when there is none (e.g. a starred section with no
   argument, or a `\\paragraph` run-in heading whose brace is elsewhere).
   PURE — the run from the macro's first `{` to its matching-ish next `}`."
  (let ((open (string-index-of text "{" offset)))
    (if (< open 0)
        ""
        (let ((close (string-index-of text "}" (+ open 1))))
          (if (< close 0) "" (substring text (+ open 1) close))))))

;; --- commands: section navigation -------------------------------------

(defcommand latex-next-section ()
  "Move point to the start of the next sectioning command
   (\\part/\\chapter/\\section/\\subsection/\\subsubsection/\\paragraph/
   \\subparagraph, starred forms included). Echoes the section title;
   clamps with a status message at the last section. Bound to C-c C-n.

   Self-contained: scans the current buffer's own text from point, so it
   works without a built RefTeX document DB."
  (let ((target (next-section-offset (buffer-text) (point))))
    (if (nil? target)
        (show-status! "No next section")
        (begin
          (goto! target)
          (let ((title (-latex-section-title (buffer-text) target)))
            (show-status! (if (string=? title "")
                              "Next section"
                              (str "Section: " title))))))))

(defcommand latex-previous-section ()
  "Move point to the start of the previous sectioning command (the
   companion to `latex-next-section`). Echoes the section title; clamps
   with a status message at the first section. Bound to C-c C-r."
  (let ((target (prev-section-offset (buffer-text) (point))))
    (if (nil? target)
        (show-status! "No previous section")
        (begin
          (goto! target)
          (let ((title (-latex-section-title (buffer-text) target)))
            (show-status! (if (string=? title "")
                              "Previous section"
                              (str "Section: " title))))))))

;; --- pure: \begin <-> \end matching -----------------------------------
;; Given an offset known (or guessed) to sit on a \begin{X} or \end{X},
;; find the matching delimiter, respecting nested same-name envs. The
;; approach: locate the delimiter token covering OFFSET (the nearest
;; \begin{ or \end{ whose `{…}` name span contains OFFSET, or whose macro
;; starts at/just before OFFSET), read its kind + name, then scan forward
;; (for a begin) or backward (for an end) counting same-name nesting.

(define (-latex-delim-at text offset)
  "The begin/end delimiter token covering OFFSET in TEXT, as a record
   (:which 'begin|'end :name X :start S :end E) where S..E spans the whole
   `\\begin{X}` / `\\end{X}`, or nil when OFFSET isn't on one. `on` means
   OFFSET lies anywhere from the leading backslash through the closing
   brace. PURE."
  (-latex-delim-scan text 0 offset))

(define (-latex-delim-scan text from offset)
  "Walk begin/end tokens from FROM; return the one whose span contains
   OFFSET, or nil once all tokens start past OFFSET."
  (let ((b (string-index-of text "\\begin{" from))
        (e (string-index-of text "\\end{" from)))
    (cond
      ((and (< b 0) (< e 0)) nil)
      ((or (< e 0) (and (>= b 0) (< b e)))
       (let ((tok (-latex-delim-token text b (+ b 7) 'begin)))
         (-latex-delim-consider text tok b (+ b 7) offset)))
      (else
       (let ((tok (-latex-delim-token text e (+ e 5) 'end)))
         (-latex-delim-consider text tok e (+ e 5) offset))))))

(define (-latex-delim-consider text tok start next-from offset)
  "If TOK's span contains OFFSET return TOK; if TOK starts past OFFSET give
   up (nil — OFFSET wasn't on any delimiter); else keep scanning from
   NEXT-FROM."
  (cond
    ((nil? tok) (-latex-delim-scan text next-from offset))
    ((and (>= offset (get tok :start 0)) (<= offset (get tok :end 0))) tok)
    ((> start offset) nil)
    (else (-latex-delim-scan text next-from offset))))

(define (-latex-delim-token text start name-start which)
  "Build a delimiter record from START (the backslash) / NAME-START (just
   after `{`): the env name runs to the next `}`; :end is that `}`."
  (let ((close (string-index-of text "}" name-start)))
    (if (< close 0)
        nil
        (hash-map :which which
                  :name (substring text name-start close)
                  :start start
                  :end close))))

(define (latex-match-offset text offset)
  "The offset of the matching delimiter for the \\begin/\\end at OFFSET in
   TEXT: for a \\begin{X}, the start of its matching \\end{X}; for an
   \\end{X}, the start of its matching \\begin{X}. Nesting-aware (a nested
   \\begin{X}…\\end{X} inside is balanced). nil when OFFSET isn't on a
   delimiter, or when the match is missing (unbalanced — tolerated). PURE."
  (let ((tok (-latex-delim-at text offset)))
    (cond
      ((nil? tok) nil)
      ((eq? (get tok :which nil) 'begin)
       (-latex-find-close text (+ (get tok :end 0) 1)
                          (get tok :name "") 0))
      (else
       (-latex-find-open text (get tok :start 0) (get tok :name "") 0)))))

(define (-latex-find-close text from name depth)
  "Scan forward from FROM for the \\end{NAME} that closes an open
   \\begin{NAME}, counting nested \\begin{NAME} (DEPTH). Returns the
   matching \\end's start offset, or nil when unbalanced. PURE."
  (let ((nb (-latex-next-named text from "\\begin{" name))
        (ne (-latex-next-named text from "\\end{" name)))
    (cond
      ((nil? ne) nil)
      ((and (not (nil? nb)) (< nb ne))
       ;; A nested same-name \begin before the next \end: go deeper.
       (-latex-find-close text (+ nb 1) name (+ depth 1)))
      ((= depth 0) ne)
      (else (-latex-find-close text (+ ne 1) name (- depth 1))))))

(define (-latex-find-open text before name depth)
  "Scan backward from BEFORE for the \\begin{NAME} that opens the
   \\end{NAME} at BEFORE, counting nested \\end{NAME} (DEPTH). Returns the
   matching \\begin's start offset, or nil when unbalanced. PURE."
  (let ((pb (-latex-prev-named text before "\\begin{" name))
        (pe (-latex-prev-named text before "\\end{" name)))
    (cond
      ((nil? pb) nil)
      ((and (not (nil? pe)) (> pe pb))
       ;; A nested same-name \end before (after, scanning back) the \begin:
       ;; go deeper.
       (-latex-find-open text pe name (+ depth 1)))
      ((= depth 0) pb)
      (else (-latex-find-open text pb name (- depth 1))))))

(define (-latex-next-named text from marker name)
  "The offset of the next MARKER (\"\\begin{\" / \"\\end{\") at or after
   FROM in TEXT whose `{…}` argument equals NAME, or nil. PURE."
  (let ((hit (string-index-of text marker from)))
    (cond
      ((< hit 0) nil)
      ((-latex-named-here? text (+ hit (string-length marker)) name) hit)
      (else (-latex-next-named text (+ hit 1) marker name)))))

(define (-latex-prev-named text before marker name)
  "The offset of the last MARKER at or before BEFORE-1 in TEXT whose
   `{…}` argument equals NAME (i.e. strictly before BEFORE), or nil. PURE."
  (-latex-prev-named-loop text 0 (- before 1) marker name nil))

(define (-latex-prev-named-loop text from limit marker name best)
  (let ((hit (string-index-of text marker from)))
    (cond
      ((< hit 0) best)
      ((> hit limit) best)
      ((-latex-named-here? text (+ hit (string-length marker)) name)
       (-latex-prev-named-loop text (+ hit 1) limit marker name hit))
      (else (-latex-prev-named-loop text (+ hit 1) limit marker name best)))))

(define (-latex-named-here? text name-start name)
  "Whether the `{…}` run starting at NAME-START in TEXT equals NAME."
  (let ((close (string-index-of text "}" name-start)))
    (and (>= close 0)
         (string=? (substring text name-start close) name))))

;; --- command: \begin <-> \end matching jump ---------------------------

(defcommand latex-goto-matching-env ()
  "When point is on (or within the macro of) a `\\begin{X}`, jump to its
   matching `\\end{X}`; when on an `\\end{X}`, jump to its matching
   `\\begin{X}` — respecting nested same-name environments. Echoes the env
   name. A no-op (with a status message) when point isn't on a begin/end,
   or when the match is missing (an unbalanced document). Bound to C-c %."
  (let* ((text (buffer-text))
         (offset (point))
         (tok (-latex-delim-at text offset)))
    (cond
      ((nil? tok)
       (show-status! "Not on a \\begin or \\end"))
      (else
       (let ((target (latex-match-offset text offset)))
         (if (nil? target)
             (show-status! (str "No matching delimiter for {"
                                (get tok :name "") "}"))
             (begin
               (goto! target)
               (show-status!
                (str (if (eq? (get tok :which nil) 'begin)
                         "\\end{" "\\begin{")
                     (get tok :name "") "}")))))))))

;; --- pure: list-environment detection (for M-RET) ---------------------
;; Reuse latex-insert's innermost-open-env finder (it loads first), then
;; check whether that env is a list. Kept pure (text + offset in, env or
;; nil out) so M-RET's decision is unit-testable without a buffer.

(define (-latex-list-env? env)
  "Whether ENV (a name string, or nil) is a list environment whose items
   M-RET should extend: itemize / enumerate / description."
  (and (not (nil? env))
       (or (string=? env "itemize")
           (string=? env "enumerate")
           (string=? env "description"))))

(define (latex-list-env-at text offset)
  "The name of the innermost LIST environment open at OFFSET in TEXT
   (itemize / enumerate / description), or nil when the innermost open env
   isn't a list (or none is open). PURE — `-latex-innermost-open-env`
   over TEXT, no buffer."
  (let ((env (-latex-innermost-open-env text offset)))
    (if (-latex-list-env? env) env nil)))

;; --- command: M-RET insert \item --------------------------------------

(defcommand latex-insert-item ()
  "Inside a list environment (itemize / enumerate / description — the
   innermost enclosing env at point), open a new line indented to the
   current line and insert `\\item ` (for `description`, `\\item[] ` with
   point inside the brackets). Outside a list, fall back to a plain
   newline-and-indent (Emacs's M-RET as `newline`). Bound to M-RET
   (the renderer's \"M-enter\").

   The list test is the innermost enclosing environment, so a M-RET in a
   nested itemize inside a figure still inserts an \\item."
  (let ((env (latex-list-env-at (buffer-text) (point))))
    (cond
      ((nil? env)
       ;; Not in a list — a plain indented newline (M-RET ~ RET).
       (insert! (str "\n" (line-indent))))
      ((string=? env "description")
       ;; \item[] with point between the brackets.
       (let ((indent (line-indent)))
         (insert! (str "\n" indent "\\item["))
         (let ((p (point)))
           (insert! "] ")
           (goto! p))))
      (else
       (insert! (str "\n" (line-indent) "\\item "))))))

;; --- pure: smart quotes -----------------------------------------------
;; AUCTeX's TeX-insert-quote: the `"` key inserts `` (open) or '' (close)
;; by context, and a double-press (or a press right after an existing
;; `` / '') inserts a literal straight ". The decision is a pure function
;; of the character before point.

(define (-latex-open-context-char? c)
  "Whether single-character string C is a context after which a quote
   should OPEN: whitespace / newline / an opening delimiter ( [ { < or a
   dash. (An empty string — line/buffer start — is handled by the caller.)"
  (or (string=? c " ")
      (string=? c "\t")
      (string=? c "\n")
      (string=? c "(")
      (string=? c "[")
      (string=? c "{")
      (string=? c "<")
      (string=? c "-")
      (string=? c "~")))

(define (smart-quote-for prev-char)
  "The string `latex-smart-quote` should insert given PREV-CHAR (the
   single-character string before point, or \"\" at line/buffer start):

     * \"``\"  — OPEN: at line/buffer start, after whitespace, or after an
       opening delimiter;
     * \"\\\"\" — LITERAL straight quote: when PREV-CHAR is itself a quote
       character (a double-press: typing \" right after a \" / ` / ', as in
       AUCTeX's double-press-for-literal), so a real \" stays reachable;
     * \"''\"  — CLOSE: otherwise (after a word char, a closing delimiter,
       punctuation, …).

   PURE — the single testable decision core. v1 does NOT inspect math /
   verbatim context (see the command's note)."
  (cond
    ;; Double-press / right after an existing quote glyph -> literal.
    ((string=? prev-char "\"") "\"")
    ((string=? prev-char "`") "\"")
    ((string=? prev-char "'") "\"")
    ;; Line/buffer start or an open context -> open quotes.
    ((string=? prev-char "") "``")
    ((-latex-open-context-char? prev-char) "``")
    ;; Otherwise -> close quotes.
    (else "''")))

;; --- command: smart quote ---------------------------------------------

(define (-latex-char-before)
  "The single-character string immediately before point, or \"\" at the
   buffer start. (No `char-before` primitive exists; derive it from the
   one-char `buffer-substring` behind point.)"
  (let ((p (point)))
    (if (<= p 0) "" (buffer-substring (- p 1) p))))

(defcommand latex-smart-quote ()
  "Insert a context-sensitive LaTeX quote on the `\"` key: ` `` ` (open)
   after whitespace / line start / an opening delimiter, `''` (close)
   otherwise. A double-press — typing `\"` right after a `\"`, `` ` `` or
   `'` — inserts a single straight `\"`, so a literal quote stays reachable
   (AUCTeX's `TeX-insert-quote`). Bound to `\"` in latex-mode.

   LIMITATION (v1): the decision looks only at the character before point;
   it does not detect math (`$…$`) or verbatim context, where a straight
   `\"` is usually wanted. Use the double-press there, or type the glyph
   another way."
  (insert! (smart-quote-for (-latex-char-before))))

;; --- keybindings ------------------------------------------------------
;; latex.lisp built `latex-c-c-map`; latex-compile, reftex-refs,
;; latex-insert and latex-math extended it (mutating it in place via
;; successive `set!`s). We read its CURRENT value and `assoc` the three
;; Phase-5 chords onto it, so the whole accumulated chain survives. Then
;; we re-install latex-mode-map with the existing "C-c" prefix PLUS the two
;; new top-level keys (M-RET, ").
;;
;; Currently-bound C-c slots (do not collide): b i e m M s S l n C-p
;; (latex.lisp); C-c C-v ` (latex-compile); ( ) (reftex-refs);
;; C-e ] C-m C-s C-f (latex-insert); ~ (latex-math). Free, mnemonic slots
;; chosen here:
;;
;;   C-c C-n   latex-next-section       (n = next)
;;   C-c C-r   latex-previous-section   (r = reverse/previous; C-p is taken)
;;   C-c %     latex-goto-matching-env  (% = vim's match-paren mnemonic;
;;                                       also the TeX comment char, free here)
;;
;; `assoc` returns a fresh map; we re-install under "C-c". Note C-c C-n /
;; C-c C-r are mode-LOCAL three-key chords here (C-c is the prefix); the
;; global c-c-keymap binds plain "C-n"/"C-p" to notebook nav, but latex's
;; own C-c map shadows the global one for latex buffers, so these do not
;; collide. ("C-r" is unbound in the global c-c-keymap, so no shadow issue.)

(set! latex-c-c-map
  (assoc (assoc (assoc latex-c-c-map "C-n" 'latex-next-section)
                "C-r" 'latex-previous-section)
         "%" 'latex-goto-matching-env))

;; Re-install latex-mode-map: keep the (mutated) C-c prefix map, and add
;; the two top-level keys. Reading `latex-c-c-map` here means we don't
;; drop any of the chain's accumulated bindings.
;;
;; M-RET is normalised by the renderer as "M-enter", NOT "M-return":
;; keymap.js maps the Enter key's name to "enter" (NAMED_KEYS/NAMED_CODES),
;; so Alt+Return arrives as "M-enter" (jukebox-view.js relies on exactly
;; this). The Phase-5 brief said to bind "M-return"; that string is never
;; emitted, so it would be a dead binding. We bind the live name "M-enter"
;; so M-RET actually inserts an \item. (Flagged in architect-notes.md.)
(set! latex-mode-map
  {"C-c" latex-c-c-map
   "M-enter" 'latex-insert-item
   "\"" 'latex-smart-quote})
