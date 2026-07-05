;;; jmarkdown-nav.lisp — structural navigation for jmarkdown-mode.
;;;
;;; AUCTeX/RefTeX-style motion over a JMarkdown document:
;;;
;;;   C-c C-n  jmarkdown-next-section      — next heading
;;;   C-c C-u  jmarkdown-previous-section  — previous heading
;;;   C-c C-j  jmarkdown-goto-matching     — @begin(x) <-> @end(x), ::: <-> :::
;;;   M-enter  jmarkdown-insert-item       — continue the enclosing list
;;;   C-c =    jmarkdown-toc               — pick a heading and jump (outline)
;;;
;;; Pure offset-finders over `(buffer-text)` + thin `goto!` commands (the
;;; latex-nav.lisp shape). A TOP-LEVEL stdlib file: commands + pure helpers,
;;; no keymap (wired in languages/jmarkdown.lisp). Helper prefix `-jmnav-`
;;; keeps it clear of jmarkdown.lisp's `-jmd-*` fill helpers. Loaded after
;;; jmarkdown-insert.lisp (reuses its completing-minibuffer for the TOC).

;; --- pure: heading offsets --------------------------------------------

(define (-jmnav-hash-run text i)
  "The count of consecutive `#` in TEXT starting at I. Pure."
  (if (and (< i (string-length text)) (equal? (substring text i (+ i 1)) "#"))
      (+ 1 (-jmnav-hash-run text (+ i 1)))
      0))

(define (-jmnav-atx-heading? text i)
  "Whether offset I in TEXT begins an ATX heading (1–6 `#` then a space)."
  (let ((h (-jmnav-hash-run text i)))
    (and (>= h 1) (<= h 6)
         (< (+ i h) (string-length text))
         (equal? (substring text (+ i h) (+ i h 1)) " "))))

(define (-jmnav-line-end text i)
  "The offset of the newline ending the line at I in TEXT, or the length."
  (let ((nl (string-index-of text "\n" i)))
    (if (< nl 0) (string-length text) nl)))

(define (-jmnav-heading-offsets text)
  "The offsets of every ATX heading line-start in TEXT, in order. Pure."
  (-jmnav-heading-scan text 0 (list)))

(define (-jmnav-heading-scan text i acc)
  (if (>= i (string-length text))
      (reverse acc)
      (-jmnav-heading-scan text (+ (-jmnav-line-end text i) 1)
                           (if (-jmnav-atx-heading? text i) (cons i acc) acc))))

(define (-jmnav-first-greater offsets n)
  "The first offset in OFFSETS strictly greater than N, or nil. Pure."
  (cond ((nil? offsets) nil)
        ((> (car offsets) n) (car offsets))
        (else (-jmnav-first-greater (cdr offsets) n))))

(define (-jmnav-last-less offsets n)
  "The last offset in OFFSETS strictly less than N, or nil. Pure."
  (-jmnav-last-less-loop offsets n nil))

(define (-jmnav-last-less-loop offsets n best)
  (cond ((nil? offsets) best)
        ((< (car offsets) n) (-jmnav-last-less-loop (cdr offsets) n (car offsets)))
        (else best)))

(define (-jmnav-heading-title text i)
  "The heading text at offset I (after the `#`s and space), trimmed of a
   trailing `:label[…]`. Pure."
  (let* ((h (-jmnav-hash-run text i))
         (start (+ i h 1))
         (end (-jmnav-line-end text start)))
    (-jmnav-strip-heading-suffix (substring text start end))))

(define (-jmnav-strip-heading-suffix s)
  "S with a trailing `:label[…]` removed (its key is not part of the title).
   Pure — best-effort."
  (let ((lab (string-index-of s ":label[")))
    (if (>= lab 0) (-jmnav-rtrim (substring s 0 lab)) (-jmnav-rtrim s))))

(define (-jmnav-rtrim s)
  (let ((n (string-length s)))
    (cond ((= n 0) s)
          ((or (equal? (substring s (- n 1) n) " ")
               (equal? (substring s (- n 1) n) "\t"))
           (-jmnav-rtrim (substring s 0 (- n 1))))
          (else s))))

;; --- commands: section motion -----------------------------------------

(defcommand jmarkdown-next-section ()
  "Move point to the next ATX heading, or report the last one. Bound to
   C-c C-n."
  (let ((target (-jmnav-first-greater (-jmnav-heading-offsets (buffer-text)) (point))))
    (if (nil? target)
        (show-status! "No next heading")
        (begin (goto! target) (recenter!)
               (show-status! (-jmnav-heading-title (buffer-text) target))))))

(defcommand jmarkdown-previous-section ()
  "Move point to the previous ATX heading, or report the first one. Bound to
   C-c C-u."
  ;; From point, jump to the last heading before the current LINE start, so
  ;; repeated presses walk up even when point sits on a heading.
  (let ((target (-jmnav-last-less (-jmnav-heading-offsets (buffer-text)) (line-start))))
    (if (nil? target)
        (show-status! "No previous heading")
        (begin (goto! target) (recenter!)
               (show-status! (-jmnav-heading-title (buffer-text) target))))))

;; --- pure: @begin/@end and ::: matching -------------------------------

(define (-jmnav-line-start text i)
  "The offset of the start of the line containing I in TEXT. Pure."
  (-jmnav-line-start-loop text i))

(define (-jmnav-line-start-loop text i)
  (cond ((<= i 0) 0)
        ((equal? (substring text (- i 1) i) "\n") i)
        (else (-jmnav-line-start-loop text (- i 1)))))

(define (-jmnav-env-markers text)
  "Every `@begin(NAME)` / `@end(NAME)` in TEXT as records
   (:which begin|end :name NAME :offset O), in document order. Pure."
  (-jmnav-env-scan text 0 (list)))

(define (-jmnav-env-scan text from acc)
  (let ((b (string-index-of text "@begin(" from))
        (e (string-index-of text "@end(" from)))
    (cond
      ((and (< b 0) (< e 0)) (reverse acc))
      ((or (< e 0) (and (>= b 0) (< b e)))
       (-jmnav-env-scan text (+ b 7)
                        (cons (-jmnav-env-marker text b (+ b 7) 'begin) acc)))
      (else
       (-jmnav-env-scan text (+ e 5)
                        (cons (-jmnav-env-marker text e (+ e 5) 'end) acc))))))

(define (-jmnav-env-marker text offset name-start which)
  (let ((close (string-index-of text ")" name-start)))
    (hash-map :which which :offset offset
              :name (if (< close 0) "" (substring text name-start close)))))

(define (-jmnav-match-offset text offset)
  "If OFFSET's line holds an `@begin(NAME)` / `@end(NAME)`, the offset of its
   matching partner (nesting-aware, name-matched), else nil. Pure."
  (let* ((markers (-jmnav-env-markers text))
         (here (-jmnav-marker-on-line text markers offset)))
    (cond
      ((nil? here) nil)
      ((eq? (get here :which nil) 'begin)
       (-jmnav-find-close markers (get here :name "") (get here :offset 0) 0 nil))
      (else
       (-jmnav-find-open (reverse markers) (get here :name "") (get here :offset 0) 0 nil)))))

(define (-jmnav-marker-on-line text markers offset)
  "The marker whose offset is on the same line as OFFSET, or nil. Pure."
  (let ((ls (-jmnav-line-start text offset))
        (le (-jmnav-line-end text (-jmnav-line-start text offset))))
    (-jmnav-marker-in-range markers ls le)))

(define (-jmnav-marker-in-range markers lo hi)
  (cond
    ((nil? markers) nil)
    ((let ((o (get (car markers) :offset -1))) (and (>= o lo) (<= o hi))) (car markers))
    (else (-jmnav-marker-in-range (cdr markers) lo hi))))

(define (-jmnav-find-close markers name start depth found)
  "Scan MARKERS forward from START for the depth-0 `@end(NAME)`. Pure."
  (cond
    ((nil? markers) found)
    (else
     (let* ((m (car markers)) (o (get m :offset -1)))
       (if (<= o start)
           (-jmnav-find-close (cdr markers) name start depth found)
           (if (string=? (get m :name "") name)
               (if (eq? (get m :which nil) 'begin)
                   (-jmnav-find-close (cdr markers) name start (+ depth 1) found)
                   (if (= depth 0)
                       o
                       (-jmnav-find-close (cdr markers) name start (- depth 1) found)))
               (-jmnav-find-close (cdr markers) name start depth found)))))))

(define (-jmnav-find-open rev-markers name start depth found)
  "Scan REV-MARKERS (reversed) backward from START for the depth-0
   `@begin(NAME)`. Pure."
  (cond
    ((nil? rev-markers) found)
    (else
     (let* ((m (car rev-markers)) (o (get m :offset -1)))
       (if (>= o start)
           (-jmnav-find-open (cdr rev-markers) name start depth found)
           (if (string=? (get m :name "") name)
               (if (eq? (get m :which nil) 'end)
                   (-jmnav-find-open (cdr rev-markers) name start (+ depth 1) found)
                   (if (= depth 0)
                       o
                       (-jmnav-find-open (cdr rev-markers) name start (- depth 1) found)))
               (-jmnav-find-open (cdr rev-markers) name start depth found)))))))

(defcommand jmarkdown-goto-matching ()
  "Jump between the `@begin(NAME)` and `@end(NAME)` on the current line
   (nesting-aware, name-matched). Bound to C-c C-j."
  (let ((target (-jmnav-match-offset (buffer-text) (point))))
    (if (nil? target)
        (show-status! "No @begin/@end on this line")
        (begin (goto! target) (recenter!) (show-status! "Jumped to match")))))

;; --- command: insert-item (M-enter) -----------------------------------

(define *jmnav-name-alpha* "abcdefghijklmnopqrstuvwxyz")

(define (-jmnav-item-prefix line)
  "The continuation prefix for a list/description LINE: the leading indent
   plus the next list marker (unordered repeated, ordered/alpha incremented),
   or just the indent for a description / plain line. Pure."
  (let* ((indent (-jmnav-leading-ws line))
         (rest (substring line (string-length indent)))
         (ordered (-jmnav-ordered-marker rest)))
    (cond
      ;; Unordered bullet: repeat it.
      ((and (>= (string-length rest) 2)
            (-jmnav-member? (substring rest 0 1) (list "-" "*" "+"))
            (equal? (substring rest 1 2) " "))
       (str indent (substring rest 0 2)))
      ;; Ordered: digits or a single letter, then . or ), then space.
      ((not (eq? ordered #f)) (str indent ordered))
      ;; Otherwise (description body, plain line): keep the indent only.
      (else indent))))

(define (-jmnav-ordered-marker rest)
  "If REST opens with an ordered-list marker (`N.`/`N)`/`a.`/`a)` + space),
   the NEXT marker string (incremented), else #f. Pure."
  (let ((d (-jmnav-digit-run rest 0)))
    (cond
      ;; digits then delim then space -> increment the number.
      ((and (> d 0) (< (+ d 1) (string-length rest))
            (-jmnav-member? (substring rest d (+ d 1)) (list "." ")"))
            (equal? (substring rest (+ d 1) (+ d 2)) " "))
       (str (number->string (+ 1 (string->number (substring rest 0 d))))
            (substring rest d (+ d 1)) " "))
      ;; single letter then delim then space -> next letter.
      ((and (>= (string-length rest) 3)
            (>= (string-index-of *jmnav-name-alpha* (-jmnav-downcase1 (substring rest 0 1))) 0)
            (-jmnav-member? (substring rest 1 2) (list "." ")"))
            (equal? (substring rest 2 3) " "))
       (str (-jmnav-next-letter (substring rest 0 1)) (substring rest 1 2) " "))
      (else #f))))

(define (-jmnav-digit-run s i)
  (if (and (< i (string-length s))
           (>= (string-index-of "0123456789" (substring s i (+ i 1))) 0))
      (-jmnav-digit-run s (+ i 1)) i))

(define (-jmnav-downcase1 c)
  (let ((u (string-index-of "ABCDEFGHIJKLMNOPQRSTUVWXYZ" c)))
    (if (< u 0) c (substring *jmnav-name-alpha* u (+ u 1)))))

(define (-jmnav-next-letter c)
  "The letter after C (a→b, z→z, A→B), preserving case. Pure."
  (let ((lo (string-index-of *jmnav-name-alpha* c)))
    (if (>= lo 0)
        (if (>= (+ lo 1) 26) c (substring *jmnav-name-alpha* (+ lo 1) (+ lo 2)))
        (let ((up (string-index-of "ABCDEFGHIJKLMNOPQRSTUVWXYZ" c)))
          (if (and (>= up 0) (< (+ up 1) 26))
              (substring "ABCDEFGHIJKLMNOPQRSTUVWXYZ" (+ up 1) (+ up 2))
              c)))))

(define (-jmnav-leading-ws s)
  (substring s 0 (- (string-length s) (string-length (-jmnav-ltrim s)))))

(define (-jmnav-ltrim s)
  (cond ((string=? s "") s)
        ((or (equal? (substring s 0 1) " ") (equal? (substring s 0 1) "\t"))
         (-jmnav-ltrim (substring s 1 (string-length s))))
        (else s)))

(define (-jmnav-member? x lst)
  (cond ((nil? lst) #f) ((equal? (car lst) x) #t) (else (-jmnav-member? x (cdr lst)))))

(defcommand jmarkdown-insert-item ()
  "Continue the enclosing list: insert a newline and the next list marker
   (unordered repeated, ordered/lettered incremented), matching the current
   line's indentation. On a non-list line it is a plain indented newline.
   Bound to M-enter."
  (let ((line (buffer-substring (line-start) (line-end))))
    (insert! (str "\n" (-jmnav-item-prefix line)))))

;; --- command: TOC / outline navigator (C-c =) -------------------------

(define (-jmnav-toc-entries text)
  "A list of (offset . label) pairs — one per heading, the label indented by
   level for a readable outline. Pure."
  (map (lambda (o)
         (cons o (str (string-repeat "  " (- (-jmnav-hash-run text o) 1))
                      (-jmnav-heading-title text o))))
       (-jmnav-heading-offsets text)))

;; The TOC candidate labels, and a parallel map label->offset for the jump.
(define *jmnav-toc-offsets* {})

(defcommand jmarkdown-toc ()
  "Show an outline of the document's headings in the minibuffer (TAB
   completes); choosing one jumps to it. The RefTeX-`C-c =` analog. Bound to
   C-c =."
  (let* ((text (buffer-text))
         (entries (-jmnav-toc-entries text)))
    (if (nil? entries)
        (show-status! "No headings")
        (begin
          ;; Build label->offset and the candidate list; disambiguate equal
          ;; labels by appending an index.
          (set! *jmnav-toc-offsets* {})
          (set! *jmarkdown-insert-candidates* (-jmnav-toc-register entries 0 (list)))
          (set! *jmarkdown-insert-tab-complete* -jmarkdown-insert-name-tab-complete)
          (open-completing-minibuffer! "Go to heading: " "")
          (set! *minibuffer-reader*
                (lambda (label)
                  (set! *jmarkdown-insert-tab-complete* nil)
                  (unless (or (nil? label) (string=? label ""))
                    (let ((off (get *jmnav-toc-offsets* label nil)))
                      (unless (nil? off)
                        (goto! off) (recenter!))))))))))

(define (-jmnav-toc-register entries i acc)
  "Register each (offset . label) in *jmnav-toc-offsets*, returning the
   ordered label list. A label already taken gets a ` (N)` suffix — probing
   the ACTUAL candidate label (not just the base) so a heading whose title
   already looks like `Foo (2)` cannot collide."
  (cond
    ((nil? entries) (reverse acc))
    (else
     (let* ((e (car entries))
            (label (-jmnav-free-label (cdr e) 0)))
       (set! *jmnav-toc-offsets* (assoc *jmnav-toc-offsets* label (car e)))
       (-jmnav-toc-register (cdr entries) (+ i 1) (cons label acc))))))

(define (-jmnav-free-label base n)
  "The first of BASE, `BASE (2)`, `BASE (3)`, … not already a key in
   *jmnav-toc-offsets*."
  (let ((cand (if (= n 0) base (str base " (" n ")"))))
    (if (nil? (get *jmnav-toc-offsets* cand nil))
        cand
        (-jmnav-free-label base (if (= n 0) 2 (+ n 1))))))
