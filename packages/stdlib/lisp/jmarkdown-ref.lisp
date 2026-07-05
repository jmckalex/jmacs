;;; jmarkdown-ref.lisp — the RefTeX-style reference manager for jmarkdown-mode.
;;;
;;; Cross-references, citations, footnotes and an index, over a document
;;; scanned in pure Lisp (no JS scanner primitive):
;;;
;;;   C-c (   jmarkdown-label      — insert :label / {id=} with a suggested key
;;;   C-c )   jmarkdown-reference  — pick a target, insert :ref / :cref / :Cref
;;;   C-c [   jmarkdown-citation   — pick a .bib entry, insert \cite
;;;   C-c /   jmarkdown-index      — insert :index[…], completing prior entries
;;;
;;; The scanners (`-jmref-*`) are pure `(text) -> records` functions,
;;; unit-tested without a buffer. The commands gather text/point, scan, and
;;; complete through the minibuffer machinery jmarkdown-insert.lisp installed
;;; (`*jmarkdown-insert-candidates*` / `-tab-complete*`). Citations reuse the
;;; existing `citation-parse-lenient` / `citation-entries` primitives over the
;;; `.bib` named in the document's front-matter. All Lisp over existing
;;; primitives. A TOP-LEVEL stdlib file loaded after jmarkdown-insert.lisp;
;;; keybindings are wired in languages/jmarkdown.lisp.

;; --- pure: label / id scanning ----------------------------------------

(define (-jmref-dedup lst) (-jmref-dedup-loop lst (list) (list)))
(define (-jmref-dedup-loop lst seen acc)
  (cond
    ((nil? lst) (reverse acc))
    ((-jmref-member? (car lst) seen) (-jmref-dedup-loop (cdr lst) seen acc))
    (else (-jmref-dedup-loop (cdr lst) (cons (car lst) seen) (cons (car lst) acc)))))
(define (-jmref-member? x lst)
  (cond ((nil? lst) #f) ((string=? (car lst) x) #t) (else (-jmref-member? x (cdr lst)))))

(define (-jmref-scan-bracketed text marker close)
  "Every substring between MARKER (e.g. \":label[\") and the next CLOSE
   (\"]\") in TEXT. Pure."
  (-jmref-scan-bracketed-loop text marker close 0 (list)))

(define (-jmref-scan-bracketed-loop text marker close from acc)
  (let ((hit (string-index-of text marker from)))
    (if (< hit 0)
        (reverse acc)
        (let* ((start (+ hit (string-length marker)))
               (end (string-index-of text close start)))
          (if (< end 0)
              (reverse acc)
              (-jmref-scan-bracketed-loop
               text marker close (+ end 1)
               (cons (substring text start end) acc)))))))

(define (-jmref-scan-ids text)
  "Every `id=VALUE` attribute value in TEXT (on `@begin` openers / directives),
   VALUE running to space / `}` / `\"`, quotes stripped. Pure."
  (-jmref-scan-ids-loop text 0 (list)))

(define (-jmref-scan-ids-loop text from acc)
  (let ((hit (string-index-of text "id=" from)))
    (if (< hit 0)
        (reverse acc)
        (if (-jmref-id-boundary? text hit)
            (let* ((start (+ hit 3))
                   (val (-jmref-id-value text start)))
              (-jmref-scan-ids-loop text (+ hit 3)
                                    (if (string=? val "") acc (cons val acc))))
            ;; `id=` is the tail of grid=/uuid=/valid= or a URL param — skip it.
            (-jmref-scan-ids-loop text (+ hit 3) acc)))))

(define (-jmref-id-boundary? text hit)
  "Whether the `id=` at HIT starts an attribute (at the buffer start, or after
   a non-identifier char), not the tail of `grid=` / a `?…&id=` URL param. Pure."
  (or (= hit 0)
      (let ((c (substring text (- hit 1) hit)))
        (or (equal? c " ") (equal? c "{") (equal? c "(")
            (equal? c "\n") (equal? c "\t")))))

(define (-jmref-id-value text start)
  "The id value in TEXT beginning at START: a `\"quoted\"` run, else up to the
   next space / `}` / newline. Pure."
  (if (and (< start (string-length text)) (equal? (substring text start (+ start 1)) "\""))
      (let ((q (string-index-of text "\"" (+ start 1))))
        (if (< q 0) "" (substring text (+ start 1) q)))
      (substring text start (-jmref-id-end text start))))

(define (-jmref-id-end text i)
  (cond
    ((>= i (string-length text)) i)
    ((let ((c (substring text i (+ i 1))))
       (or (equal? c " ") (equal? c "}") (equal? c "\n") (equal? c "\t"))) i)
    (else (-jmref-id-end text (+ i 1)))))

(define (-jmref-label-keys text)
  "Every cross-reference target key in TEXT: `:label[key]` keys plus `id=`
   attribute values, deduped. Pure — the completion universe for :ref/:cref."
  (-jmref-dedup (append (-jmref-scan-bracketed text ":label[" "]")
                        (-jmref-scan-ids text))))

;; --- pure: key suggestion (slug + prefix + uniquify) ------------------

(define *jmref-alnum* "abcdefghijklmnopqrstuvwxyz0123456789")

(define (-jmref-slug s)
  "Lowercase S, non-alphanumeric runs collapsed to single `-`, trimmed. Pure."
  (-jmref-slug-trim (-jmref-slug-loop s 0 "" #f)))

(define (-jmref-slug-loop s i acc prev-dash?)
  (if (>= i (string-length s))
      acc
      (let* ((c (substring s i (+ i 1)))
             (lc (-jmref-downcase1 c)))
        (if (>= (string-index-of *jmref-alnum* lc) 0)
            (-jmref-slug-loop s (+ i 1) (str acc lc) #f)
            (-jmref-slug-loop s (+ i 1) (if prev-dash? acc (str acc "-")) #t)))))

(define (-jmref-downcase1 c)
  (let ((u (string-index-of "ABCDEFGHIJKLMNOPQRSTUVWXYZ" c)))
    (if (< u 0) c (substring "abcdefghijklmnopqrstuvwxyz" u (+ u 1)))))

(define (-jmref-slug-trim s)
  "Strip a leading/trailing `-` from a slug. Pure."
  (let* ((a (if (and (> (string-length s) 0) (equal? (substring s 0 1) "-"))
                (substring s 1 (string-length s)) s))
         (n (string-length a)))
    (if (and (> n 0) (equal? (substring a (- n 1) n) "-"))
        (substring a 0 (- n 1)) a)))

(define (-jmref-uniquify key taken)
  "KEY, or KEY-2 / KEY-3 / … until it is not in TAKEN. Pure."
  (if (-jmref-member? key taken)
      (-jmref-uniquify-loop key taken 2)
      key))

(define (-jmref-uniquify-loop key taken n)
  (let ((cand (str key "-" (number->string n))))
    (if (-jmref-member? cand taken)
        (-jmref-uniquify-loop key taken (+ n 1))
        cand)))

;; --- pure: heading detection at point (for the label prefix) ----------

(define (-jmref-line-at text offset)
  "The text of the line containing OFFSET in TEXT. Pure."
  (let ((ls (-jmref-bol text offset)))
    (substring text ls (-jmref-eol text ls))))

(define (-jmref-bol text i)
  (cond ((<= i 0) 0)
        ((equal? (substring text (- i 1) i) "\n") i)
        (else (-jmref-bol text (- i 1)))))

(define (-jmref-eol text i)
  (let ((nl (string-index-of text "\n" i)))
    (if (< nl 0) (string-length text) nl)))

(define (-jmref-heading-line? line)
  "Whether LINE is an ATX heading (`#`..`######` then a space). Pure."
  (and (> (string-length line) 1)
       (equal? (substring line 0 1) "#")
       (-jmref-heading-run line 0)))

(define (-jmref-heading-run line i)
  (cond
    ((>= i (string-length line)) #f)
    ((equal? (substring line i (+ i 1)) "#") (-jmref-heading-run line (+ i 1)))
    ((and (> i 0) (<= i 6) (equal? (substring line i (+ i 1)) " ")) #t)
    (else #f)))

(define (-jmref-heading-text line)
  "The title text of a heading LINE (after the `#`s), for slugging. Pure."
  (-jmref-ltrim (-jmref-drop-hashes line)))

(define (-jmref-drop-hashes line)
  (cond ((string=? line "") line)
        ((equal? (substring line 0 1) "#") (-jmref-drop-hashes (substring line 1 (string-length line))))
        (else line)))

(define (-jmref-ltrim s)
  (cond ((string=? s "") s)
        ((or (equal? (substring s 0 1) " ") (equal? (substring s 0 1) "\t"))
         (-jmref-ltrim (substring s 1 (string-length s))))
        (else s)))

(define (-jmref-suggest-key text offset)
  "Suggest a unique label key for the target at OFFSET: `sec:` + slug of the
   heading title when on a heading line, else `label`, uniquified against
   the document's existing keys. Pure."
  (let* ((line (-jmref-line-at text offset))
         (base (if (-jmref-heading-line? line)
                   (str "sec:" (-jmref-slug (-jmref-heading-text line)))
                   "label")))
    (-jmref-uniquify (if (string=? base "sec:") "sec:section" base)
                     (-jmref-label-keys text))))

;; --- command: jmarkdown-label (C-c () ---------------------------------

(define (-jmref-insert-label key)
  "Insert `:label[KEY]`: appended at end of a heading line, else at point."
  (let ((line (-jmref-line-at (buffer-text) (point))))
    (if (-jmref-heading-line? line)
        (begin (goto! (line-end)) (insert! (str " :label[" key "]")))
        (insert! (str ":label[" key "]")))))

(defcommand jmarkdown-label ()
  "Insert a cross-reference label. Suggests a key (`sec:` + heading slug on a
   heading line), confirmed in the minibuffer; inserts `:label[key]` at the
   end of a heading line or at point. For a numbered `@begin` float the
   `{id=key}` attribute on the opener is preferred — see the manual. Bound to
   C-c (."
  (let ((suggestion (-jmref-suggest-key (buffer-text) (point))))
    (open-completing-minibuffer! "Label key: " suggestion)
    (set! *minibuffer-reader*
          (lambda (key)
            (unless (or (nil? key) (string=? key ""))
              (let ((k (-jmref-uniquify key (-jmref-label-keys (buffer-text)))))
                (-jmref-insert-label k)
                (show-status! (str "Inserted :label[" k "]"))))))))

;; --- command: jmarkdown-reference (C-c )) -----------------------------

(define (-jmref-ref-macro form)
  "The reference directive name for a FORM string: cref (default), Cref, ref."
  (cond ((string=? form "ref") ":ref[")
        ((string=? form "Cref") ":Cref[")
        (else ":cref[")))

(defcommand jmarkdown-reference ()
  "Insert a cross-reference to a label/id chosen in the minibuffer (TAB
   completes over every `:label[]` key and `{id=}` value in the document),
   then a second prompt chooses the form — cref (typed, lower-case; default),
   Cref (sentence-start), or ref (bare number). Bound to C-c )."
  (let ((keys (-jmref-label-keys (buffer-text))))
    (if (nil? keys)
        (show-status! "No labels/ids in this document")
        (begin
          (set! *jmarkdown-insert-candidates* keys)
          (set! *jmarkdown-insert-tab-complete* -jmarkdown-insert-name-tab-complete)
          (open-completing-minibuffer! "Reference key: " "")
          (set! *minibuffer-reader*
                (lambda (key)
                  (set! *jmarkdown-insert-tab-complete* nil)
                  (unless (or (nil? key) (string=? key ""))
                    (open-completing-minibuffer! "Form (cref/Cref/ref): " "cref")
                    (set! *minibuffer-reader*
                          (lambda (form)
                            (let ((f (if (or (nil? form) (string=? form "")) "cref" form)))
                              (insert! (str (-jmref-ref-macro f) key "]"))
                              (show-status! (str "Inserted :" f "[" key "]"))))))))))))

;; --- command: jmarkdown-citation (C-c [) ------------------------------
;; Find the .bib named in the front-matter, parse it via the citation bridge,
;; and complete over its keys (shown with author/year). Insert `\citep{key}`.

(define (-jmref-bib-declaration text)
  "The `Bibliography:` value from TEXT's front-matter (first ~60 lines,
   case-insensitive), trimmed, or nil. Pure."
  (-jmref-bib-scan (-jmref-first-lines text 60) 0))

(define (-jmref-first-lines text n)
  "The first N lines of TEXT as a list. Pure."
  (-jmref-take (string-split text "\n") n))

(define (-jmref-take lst n)
  (if (or (nil? lst) (<= n 0)) (list) (cons (car lst) (-jmref-take (cdr lst) (- n 1)))))

(define (-jmref-bib-scan lines i)
  (cond
    ((nil? lines) nil)
    ((-jmref-bib-line? (car lines)) (-jmref-bib-value (car lines)))
    (else (-jmref-bib-scan (cdr lines) (+ i 1)))))

(define (-jmref-bib-line? line)
  "Whether LINE is a `Bibliography:` header line (case-insensitive, allowing
   a leading `- ` YAML dash). Pure."
  (let ((l (-jmref-downcase (-jmref-ltrim line))))
    (or (string-prefix? "bibliography:" l)
        (string-prefix? "- bibliography:" l))))

(define (-jmref-bib-value line)
  "The value after the first `:` in a Bibliography line, trimmed."
  (let ((c (string-index-of line ":")))
    (if (< c 0) nil (-jmref-trim (substring line (+ c 1) (string-length line))))))

(define (-jmref-downcase s)
  (-jmref-downcase-loop s 0 ""))
(define (-jmref-downcase-loop s i acc)
  (if (>= i (string-length s)) acc
      (-jmref-downcase-loop s (+ i 1) (str acc (-jmref-downcase1 (substring s i (+ i 1)))))))

(define (-jmref-trim s) (-jmref-rtrim (-jmref-ltrim s)))
(define (-jmref-rtrim s)
  (let ((n (string-length s)))
    (cond ((= n 0) s)
          ((or (equal? (substring s (- n 1) n) " ") (equal? (substring s (- n 1) n) "\t")
               (equal? (substring s (- n 1) n) "\r"))
           (-jmref-rtrim (substring s 0 (- n 1))))
          (else s))))

;; display "key — Author (year)" -> key map, for the citation picker.
(define *jmref-cite-keys* {})

(define (-jmref-entry-label entry)
  "A picker label for a citation ENTRY hash-map: `key — Author (year)`. Guards
   author/year for nil — citation-entries stores those keys with a NIL value
   for author-less / year-less entries (@manual, @misc), so a `(get … \"\")`
   default does NOT fire and `(string=? nil …)` would throw."
  (let ((key (get entry :key ""))
        (author (get entry :author nil))
        (year (get entry :year nil)))
    (str key
         (if (or (nil? author) (string=? author "")) "" (str " — " author))
         (if (nil? year) "" (str " (" year ")")))))

(define (-jmref-register-cite-entries entries)
  "Build the display-label list for ENTRIES and the label->key map. Returns
   the label list."
  (set! *jmref-cite-keys* {})
  (-jmref-register-cite-loop entries (list)))

(define (-jmref-register-cite-loop entries acc)
  (cond
    ((nil? entries) (reverse acc))
    (else
     (let* ((e (car entries))
            (label (-jmref-entry-label e)))
       (set! *jmref-cite-keys* (assoc *jmref-cite-keys* label (get e :key "")))
       (-jmref-register-cite-loop (cdr entries) (cons label acc))))))

(define (-jmref-bib-entries)
  "The citation entries for the current document's .bib, or nil. Resolves the
   front-matter Bibliography path relative to the file's directory, reads it,
   and parses it with the citation bridge. Guarded — returns nil on any
   failure or when no bib / bridge is available."
  (try
   (let ((decl (-jmref-bib-declaration (buffer-text)))
         (src (view-file-path (current-view))))
     (if (or (nil? decl) (nil? src))
         nil
         (let ((path (path-resolve (path-dirname src) decl)))
           (if (not (file-exists? path))
               nil
               (let ((text (read-file-text! path)))
                 (if (nil? text)
                     nil
                     (let ((parsed (citation-parse-lenient text)))
                       (citation-entries (get parsed :handle nil)))))))))
   (catch _e nil)))

(defcommand jmarkdown-citation ()
  "Insert a citation. Reads the `.bib` named in the document's front-matter
   (`Bibliography:`), lets you pick an entry in the minibuffer (TAB completes;
   entries show as `key — Author (year)`), and inserts `\\citep{key}`. Bound
   to C-c [."
  (let ((entries (-jmref-bib-entries)))
    (if (or (nil? entries) (nil? (-jmref-safe-first entries)))
        (show-status!
         "No bibliography found — add `Bibliography: refs.bib` to the front-matter")
        (begin
          (set! *jmarkdown-insert-candidates* (-jmref-register-cite-entries entries))
          (set! *jmarkdown-insert-tab-complete* -jmarkdown-insert-name-tab-complete)
          (open-completing-minibuffer! "Citation: " "")
          (set! *minibuffer-reader*
                (lambda (label)
                  (set! *jmarkdown-insert-tab-complete* nil)
                  (unless (or (nil? label) (string=? label ""))
                    (let ((key (get *jmref-cite-keys* label label)))
                      (insert! (str "\\citep{" key "}"))
                      (show-status! (str "Inserted \\citep{" key "}"))))))))))

(define (-jmref-safe-first lst)
  "The first element of LST, or nil for an empty list (nil is truthy, so a
   plain `(car (list))` guard is unsafe)."
  (if (nil? lst) nil (car lst)))

;; --- command: jmarkdown-index (C-c /) ---------------------------------

(defcommand jmarkdown-index ()
  "Insert an index mark `:index[entry]` at point, TAB-completing over the
   index entries already used in the document. Bound to C-c /."
  (set! *jmarkdown-insert-candidates* (-jmref-scan-bracketed (buffer-text) ":index[" "]"))
  (set! *jmarkdown-insert-tab-complete* -jmarkdown-insert-name-tab-complete)
  (open-completing-minibuffer! "Index entry: " "")
  (set! *minibuffer-reader*
        (lambda (entry)
          (set! *jmarkdown-insert-tab-complete* nil)
          (unless (or (nil? entry) (string=? entry ""))
            (insert! (str ":index[" entry "]"))
            (show-status! (str "Inserted :index[" entry "]"))))))
