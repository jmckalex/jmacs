;;; occur.lisp — list the matching lines of the current view's buffer.
;;;
;;; `M-s o` (the `occur` command) prompts for a literal substring and
;;; opens a *Occur: <pattern>* view listing every line of the current
;;; view's buffer that contains it, prefixed by its source line number.
;;; With no matches the results view says so rather than being empty.
;;;
;;; Matching is plain literal substring; no regex. The whole thing is
;;; pure Lisp on top of `buffer-text`, `new-view!` and `insert!` — the
;;; results view is just a freshly-created text view the command writes
;;; into. (A future version could open the results in a side panel or
;;; jump to a match on Enter.)

;; --- pure helpers ------------------------------------------------------
;;
;; The matching and formatting are separated from the command body so
;; they can be unit-tested without touching the host's buffer list.

(define (-pad-number n width)
  "N as a decimal string, left-padded with spaces to WIDTH."
  (let* ((s (number->string n))
         (need (- width (string-length s))))
    (if (<= need 0) s (str (make-spaces need) s))))

(define (make-spaces n)
  "A string of N spaces."
  (if (<= n 0) "" (str " " (make-spaces (- n 1)))))

(define (occur-matching-lines pattern text)
  "A list of (line-number . line-text) pairs for every line of TEXT that
   contains PATTERN as a substring. Line numbers are 1-based."
  (-occur-walk pattern (string-split text "\n") 1 '()))

(define (-occur-walk pattern lines lineno acc)
  (cond
    ((nil? lines) (reverse acc))
    ((string-contains? (car lines) pattern)
     (-occur-walk pattern (cdr lines) (+ lineno 1)
                  (cons (cons lineno (car lines)) acc)))
    (else
     (-occur-walk pattern (cdr lines) (+ lineno 1) acc))))

(define (occur-result-text pattern text)
  "The full text for the *Occur* buffer when searching TEXT for PATTERN.
   Each match line is `<lineno>: <line-text>`; the header lists the
   pattern and the match count; an empty result is reported in words."
  (let* ((matches (occur-matching-lines pattern text))
         (count (length matches))
         (width (string-length (number->string
                                 (if (nil? matches)
                                     1
                                     (car (last matches))))))
         (header (str count " match"
                      (if (= count 1) "" "es")
                      " for \"" pattern "\":\n\n")))
    (if (nil? matches)
        (str header "(no matches)\n")
        (str header (-format-matches matches width)))))

(define (-format-matches matches width)
  (if (nil? matches)
      ""
      (let ((pair (car matches)))
        (str (-pad-number (car pair) width) ": " (cdr pair) "\n"
             (-format-matches (cdr matches) width)))))

(define (occur-buffer-name pattern)
  "The name to give the results view for PATTERN."
  (str "*Occur: " pattern "*"))

;; --- the command -------------------------------------------------------

(defcommand occur (pattern)
  "List every line of the current view's buffer containing PATTERN, a
   literal substring, in a fresh *Occur: PATTERN* view."
  (interactive (string "Occur: "))
  (let ((result (occur-result-text pattern (buffer-text)))
        (name (occur-buffer-name pattern)))
    ;; The source text is captured first; only then do we switch views
    ;; and write the result into the freshly-created results view.
    (new-view! name)
    (insert! result)))
