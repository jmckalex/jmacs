;;; face-info.lisp — diagnostic info about the syntax-highlighting
;;; face under point.
;;;
;;; A user customising the editor's colour theme wants to know, at a
;;; glance, which face produced the colour at the cursor and which CSS
;;; variable they have to override. `describe-face-at-point` answers
;;; that — open a `*Face at point*` doc buffer naming the face, its
;;; CSS class, the resolved colour from the active theme, the range,
;;; and the captured text.
;;;
;;; Aliased to `describe-syntax-at-point` for users who think of it
;;; that way (the face is just the surface of the tree-sitter capture).
;;; Bound to `C-h F`.

;; --- pure helper -------------------------------------------------------
;;
;; Picking the right capture for the cursor is the one piece of logic
;; with non-trivial structure: many captures may straddle a point — a
;; broad `@string` and a narrower `@operator` for the `${` inside it,
;; say — and the user wants the most specific one. "Most specific"
;; means "smallest range that covers the point". Extracted as a pure
;; function so the test suite exercises it without a tree-sitter
;; runtime.

(define (-face-info-range-width capture)
  "Width of a (START END FACE) capture's range."
  (- (cadr capture) (car capture)))

(define (-face-info-covers? capture pos)
  "True when CAPTURE's [start, end) covers POS."
  (and (>= pos (car capture)) (< pos (cadr capture))))

(define (-face-info-pick rest best pos)
  "Worker for `smallest-covering-capture`. Picks the narrowest covering
   capture from REST against the current BEST (`nil` or a capture)."
  (cond
    ((nil? rest) best)
    ((not (pair? rest)) best)
    (else
      (let ((candidate (car rest)))
        (cond
          ((not (-face-info-covers? candidate pos))
           (-face-info-pick (cdr rest) best pos))
          ((nil? best)
           (-face-info-pick (cdr rest) candidate pos))
          ((< (-face-info-range-width candidate)
              (-face-info-range-width best))
           (-face-info-pick (cdr rest) candidate pos))
          (else (-face-info-pick (cdr rest) best pos)))))))

(define (smallest-covering-capture captures pos)
  "Return the smallest-range capture in CAPTURES whose [start, end)
   covers POS, or `nil` when none does. CAPTURES is a list of
   (START END FACE) lists. On a tie the first such capture wins —
   tree-sitter emits captures in document order, so the outer-grammar
   range comes first and would win without further intervention, but
   for `describe-face-at-point` the smaller range is what the user
   wants to see."
  (-face-info-pick captures nil pos))

;; --- text rendering ----------------------------------------------------

(define (-face-info-clip text start end)
  "Substring of TEXT for [START, END), shortened to ~80 chars with an
   ellipsis when longer. The result goes inside a fenced code block,
   so embedded newlines are left as-is."
  (let* ((raw (substring text start end))
         (limit 80))
    (cond
      ((> (string-length raw) limit)
       (str (substring raw 0 limit) "…"))
      (else raw))))

(define (-face-info-render lang face start end color snippet)
  "Build the Markdown body for the *Face at point* doc page. Kept
   separate from the command so a test can assert the shape without
   intercepting the doc primitive."
  (str
    "**Face:** `" face "`\n\n"
    "**CSS class:** `tok-" face "`\n\n"
    "**CSS variable:** `--tok-" face "`\n\n"
    "**Resolved colour:** `" color "`\n\n"
    "**Language:** `" lang "`\n\n"
    "**Range:** `[" (number->string start)
    ", " (number->string end) ")`\n\n"
    "**Text:**\n\n"
    "```\n" snippet "\n```\n"))

;; --- the command ------------------------------------------------------

(defcommand describe-face-at-point ()
  "Open a `*Face at point*` doc buffer describing the tree-sitter
   capture under the cursor: face name, CSS class, the active theme's
   resolved colour, the captured range, and the text it covers. The
   user's diagnostic tool when customising the colour theme. Bound
   to `C-h F`; aliased as `describe-syntax-at-point`."
  (let ((info (tree-sitter-captures-for-buffer!)))
    (cond
      ((nil? info)
       (println "no tree-sitter language for this buffer"))
      (else
        (let* ((lang (car info))
               (captures (cdr info))
               (pos (point))
               (chosen (smallest-covering-capture captures pos)))
          (cond
            ((nil? chosen)
             (println (str "no capture covers point ("
                           (number->string pos)
                           ") in this " lang " buffer")))
            (else
              (let* ((start (car chosen))
                     (end (cadr chosen))
                     (face (caddr chosen))
                     (color (face-color-for face))
                     (snippet (-face-info-clip (buffer-text) start end))
                     (body (-face-info-render
                             lang face start end color snippet)))
                (open-docstring-page! "Face at point" body)))))))))

(defcommand describe-syntax-at-point ()
  "Alias of `describe-face-at-point` — open a doc page describing the
   tree-sitter capture at point. Same key, same output."
  (describe-face-at-point))
