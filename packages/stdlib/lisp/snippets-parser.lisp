;;; snippets-parser.lisp — the snippet file-format reader and body parser.
;;;
;;; A snippet file is yasnippet-style: a block of `# key: value` header
;;; lines, a `# --` separator, then the body. The body uses yasnippet
;;; field syntax:
;;;
;;;   $N            a tab stop (numeric index N)
;;;   ${N:default}  a tab stop with a default value
;;;   $0            the exit point (where point lands when the snippet
;;;                 commits)
;;;   $$            a literal dollar sign
;;;
;;; This file is pure data-in / data-out — no buffer access, no I/O — so
;;; the parser is exercised directly by the test suite.
;;;
;;; The two public entry points:
;;;
;;;   (parse-snippet-file TEXT)  -> a snippet record (a hash-map) with
;;;                                 :key :name :group :condition :body
;;;                                 (:body is the raw body string).
;;;   (parse-snippet-body BODY)  -> a hash-map {:text :fields :exit
;;;                                 :mirrors}. See `parse-snippet-body`.

;; --- small string helpers ---------------------------------------------
;; The core Lisp has no string-trim or single-char read; build the few
;; we need here. `char-at` returns a one-character string (or "" past
;; the end), which composes with `string=?` cleanly.

(define (char-at s i)
  "The one-character string at index I of S, or \"\" when out of range."
  (if (and (>= i 0) (< i (string-length s)))
      (substring s i (+ i 1))
      ""))

(define (-digit? ch)
  "True when the one-character string CH is an ASCII digit."
  (and (string? ch)
       (= (string-length ch) 1)
       (>= (string-index-of "0123456789" ch) 0)))

(define (-whitespace? ch)
  (or (string=? ch " ") (string=? ch "\t")
      (string=? ch "\r") (string=? ch "\n")))

(define (-trim-left-loop s i)
  (if (and (< i (string-length s)) (-whitespace? (char-at s i)))
      (-trim-left-loop s (+ i 1))
      (substring s i (string-length s))))

(define (-string-trim-left s)
  (-trim-left-loop s 0))

(define (-trim-right-loop s i)
  (if (and (> i 0) (-whitespace? (char-at s (- i 1))))
      (-trim-right-loop s (- i 1))
      (substring s 0 i)))

(define (-string-trim-right s)
  (-trim-right-loop s (string-length s)))

(define (string-trim s)
  "S with leading and trailing ASCII whitespace removed."
  (-string-trim-right (-string-trim-left s)))

;; --- header parsing ---------------------------------------------------

(define (-header-line? line)
  "True when LINE is a `# key: value` header line (starts with '#')."
  (string-prefix? "#" (string-trim line)))

(define (-separator-line? line)
  "True when LINE is the `# --` body separator."
  (string=? (string-trim line) "# --"))

(define (-parse-header-line line)
  "Parse a `# key: value` line into a (key . value) pair of strings, or
   nil when the line carries no `key:` (e.g. the `# -*- mode … -*-`
   modeline). KEY is downcased; VALUE is trimmed."
  (let* ((trimmed (string-trim line))
         (body (string-trim (substring trimmed 1 (string-length trimmed))))
         (colon (string-index-of body ":")))
    (if (< colon 0)
        nil
        (cons (string-downcase (string-trim (substring body 0 colon)))
              (string-trim (substring body (+ colon 1)
                                      (string-length body)))))))

(define (-split-header-body-loop lines header-acc)
  (cond
    ((nil? lines) (cons (reverse header-acc) (list)))
    ((-separator-line? (car lines))
     (cons (reverse header-acc) (cdr lines)))
    ((-header-line? (car lines))
     (-split-header-body-loop (cdr lines) (cons (car lines) header-acc)))
    ;; A non-header, non-separator line before any `# --` means this
    ;; file has no header block at all — everything is body.
    (else (cons (list) lines))))

(define (-split-header-body lines)
  "Split LINES (a list of strings) at the `# --` separator into a pair
   (header-lines . body-lines). With no separator the whole input is
   the body — a bare snippet file with no header is valid."
  (-split-header-body-loop lines (list)))

(define (-collect-header-loop pairs acc)
  (cond
    ((nil? pairs) acc)
    ((nil? (car pairs)) (-collect-header-loop (cdr pairs) acc))
    (else
     (-collect-header-loop
      (cdr pairs)
      (assoc acc (string->keyword (car (car pairs))) (cdr (car pairs)))))))

(define (-collect-header pairs)
  "Fold a list of (key . value) header pairs into a hash-map keyed by
   keyword."
  (-collect-header-loop pairs {}))

(define (-join-lines lines)
  "Join LINES with newlines (inverse of splitting on \"\\n\")."
  (cond
    ((nil? lines) "")
    ((nil? (cdr lines)) (car lines))
    (else (str (car lines) "\n" (-join-lines (cdr lines))))))

(define (parse-snippet-file text)
  "Parse a yasnippet-style snippet file TEXT into a snippet record (a
   hash-map): {:key :name :group :condition :body}. :body is the raw
   body string (still containing field markers). Any header key absent
   from the file is nil. A file with no `# --` separator is all body."
  (let* ((lines (string-split text "\n"))
         (split (-split-header-body lines))
         (header (-collect-header
                  (map -parse-header-line
                       (filter (lambda (l) (not (-separator-line? l)))
                               (car split)))))
         (body (-join-lines (cdr split))))
    (hash-map
     :key       (get header :key nil)
     :name      (get header :name nil)
     :group     (get header :group nil)
     :condition (get header :condition nil)
     :body      body)))

;; --- body parsing -----------------------------------------------------
;; Two passes. Pass 1 tokenises the body into a flat list of tokens
;; (no offsets yet): literal runs, field references, and the exit
;; marker. Pass 2 resolves each index's default (the first occurrence
;; that carries one wins) and lays the tokens down into the output text,
;; computing offsets and distinguishing the canonical field from mirrors.
;;
;; Splitting the work this way lets a mirror render its index's resolved
;; default at expansion time — a bare `$1` after `${1:x}` shows "x", and
;; the mirror range is sized to that text — matching yasnippet.

;; A token is one of:
;;   (:literal . text)
;;   (:field index has-default? . default-text)
;;   (:exit . default-text)        ; $0 or ${0:text}

(define (-tok-literal text) (cons ':literal text))
(define (-tok-field index has-default? default)
  (cons ':field (cons index (cons has-default? default))))
(define (-tok-exit default) (cons ':exit default))

(define (-tok-kind tok) (car tok))
(define (-tok-field-index tok) (car (cdr tok)))
(define (-tok-field-has-default? tok) (car (cdr (cdr tok))))
(define (-tok-field-default tok) (cdr (cdr (cdr tok))))
(define (-tok-text tok) (cdr tok))

(define (-scan-digits body i)
  "The index just past the run of digits starting at I."
  (if (-digit? (char-at body i))
      (-scan-digits body (+ i 1))
      i))

(define (-find-brace-close body i depth)
  "The index of the `}` that closes the brace field whose default starts
   at I, honouring nested `{...}`. DEPTH is the current nesting. Returns
   -1 when no close is found."
  (cond
    ((>= i (string-length body)) -1)
    ((string=? (char-at body i) "{")
     (-find-brace-close body (+ i 1) (+ depth 1)))
    ((string=? (char-at body i) "}")
     (if (= depth 0) i (-find-brace-close body (+ i 1) (- depth 1))))
    (else (-find-brace-close body (+ i 1) depth))))

(define (-read-brace-field body i)
  "Parse `${N:default}` whose `{` is at index (- i 1); I points at the
   first index char. Returns (index default . next) or nil when the form
   is malformed (no closing brace / no digits). NEXT is the offset just
   past the closing `}`."
  (let* ((idx-end (-scan-digits body i))
         (digits (substring body i idx-end)))
    (if (= (string-length digits) 0)
        nil
        (let ((after (char-at body idx-end)))
          (cond
            ;; ${N} — no default.
            ((string=? after "}")
             (cons (string->number digits) (cons "" (+ idx-end 1))))
            ;; ${N:default}
            ((string=? after ":")
             (let ((close (-find-brace-close body (+ idx-end 1) 0)))
               (if (< close 0)
                   nil
                   (cons (string->number digits)
                         (cons (substring body (+ idx-end 1) close)
                               (+ close 1))))))
            (else nil))))))

(define (-tokenise-loop body i acc)
  "Pass 1: turn BODY into a reversed list of tokens. I is the read
   cursor; ACC the reversed token list."
  (if (>= i (string-length body))
      acc
      (let ((ch (char-at body i)))
        (cond
          ;; `$$` — a literal dollar.
          ((and (string=? ch "$") (string=? (char-at body (+ i 1)) "$"))
           (-tokenise-loop body (+ i 2) (cons (-tok-literal "$") acc)))
          ;; `${N…}` — a braced field.
          ((and (string=? ch "$") (string=? (char-at body (+ i 1)) "{"))
           (let ((parsed (-read-brace-field body (+ i 2))))
             (if (nil? parsed)
                 (-tokenise-loop body (+ i 1) (cons (-tok-literal "$") acc))
                 (let ((index (car parsed))
                       (default (car (cdr parsed)))
                       (next (cdr (cdr parsed))))
                   (-tokenise-loop
                    body next
                    (cons (if (= index 0)
                              (-tok-exit default)
                              (-tok-field index #t default))
                          acc))))))
          ;; `$N` — a bare field / exit.
          ((and (string=? ch "$") (-digit? (char-at body (+ i 1))))
           (let* ((idx-end (-scan-digits body (+ i 1)))
                  (index (string->number (substring body (+ i 1) idx-end))))
             (-tokenise-loop
              body idx-end
              (cons (if (= index 0)
                        (-tok-exit "")
                        (-tok-field index #f ""))
                    acc))))
          ;; Ordinary character — coalesce into the run already at the
          ;; head of ACC when that is a literal token.
          (else
           (-tokenise-loop body (+ i 1) (-push-char acc ch)))))))

(define (-push-char acc ch)
  "Append CH to the literal token at the head of ACC, or start a new
   literal token. Keeps the token list compact."
  (if (and (not (nil? acc)) (eq? (-tok-kind (car acc)) ':literal))
      (cons (-tok-literal (str (-tok-text (car acc)) ch)) (cdr acc))
      (cons (-tok-literal ch) acc)))

;; --- pass 2: resolve defaults and lay out offsets ----------------------

(define (-member-number? n lst)
  (cond ((nil? lst) #f)
        ((= n (car lst)) #t)
        (else (-member-number? n (cdr lst)))))

(define (-insert-sorted x sorted less?)
  (cond
    ((nil? sorted) (list x))
    ((less? x (car sorted)) (cons x sorted))
    (else (cons (car sorted) (-insert-sorted x (cdr sorted) less?)))))

(define (-insertion-sort items less?)
  (if (nil? items)
      (list)
      (-insert-sorted (car items) (-insertion-sort (cdr items) less?) less?)))

(define (-sort-numbers ns)
  (-insertion-sort ns (lambda (a b) (< a b))))

(define (-field-tokens tokens)
  "Just the :field tokens from TOKENS, in document order."
  (filter (lambda (tok) (eq? (-tok-kind tok) ':field)) tokens))

(define (-distinct-indices-loop field-tokens acc)
  (cond
    ((nil? field-tokens) acc)
    (else
     (let ((idx (-tok-field-index (car field-tokens))))
       (-distinct-indices-loop
        (cdr field-tokens)
        (if (-member-number? idx acc) acc (cons idx acc)))))))

(define (-distinct-indices field-tokens)
  "The distinct field indices across FIELD-TOKENS, ascending."
  (-sort-numbers (-distinct-indices-loop field-tokens (list))))

(define (-resolve-default field-tokens index)
  "The resolved default for INDEX: the first field token (document
   order) for INDEX that carries a default, else \"\"."
  (cond
    ((nil? field-tokens) "")
    ((and (= (-tok-field-index (car field-tokens)) index)
          (-tok-field-has-default? (car field-tokens)))
     (-tok-field-default (car field-tokens)))
    (else (-resolve-default (cdr field-tokens) index))))

;; The layout accumulator threaded through pass 2:
;;   :out      the output text built so far
;;   :fields   reversed list of canonical field records
;;   :mirrors  reversed list of mirror records
;;   :seen     list of indices whose canonical field is placed
;;   :exit     the exit offset, or nil
(define (-layout-init)
  (hash-map :out "" :fields (list) :mirrors (list) :seen (list) :exit nil))

(define (-layout-len acc) (string-length (get acc :out "")))

(define (-layout-emit acc s)
  (assoc acc :out (str (get acc :out "") s)))

(define (-layout-step acc tok defaults)
  "Lay one TOKEN into the layout accumulator. DEFAULTS maps each index
   to its resolved default (a hash-map index->string)."
  (cond
    ((eq? (-tok-kind tok) ':literal)
     (-layout-emit acc (-tok-text tok)))
    ((eq? (-tok-kind tok) ':exit)
     (let* ((start (-layout-len acc))
            (with-text (-layout-emit acc (-tok-text tok))))
       ;; The exit sits at the start of any default text it carries.
       (assoc with-text :exit start)))
    (else
     ;; A :field token. Emit this index's resolved default; record the
     ;; occurrence as canonical (first time) or as a mirror.
     (let* ((index (-tok-field-index tok))
            (default (get defaults index ""))
            (start (-layout-len acc))
            (with-text (-layout-emit acc default))
            (end (-layout-len with-text))
            (first? (not (-member-number? index (get acc :seen (list))))))
       (if first?
           (assoc
            (assoc with-text :seen (cons index (get with-text :seen (list))))
            :fields
            (cons (hash-map :index index :start start :end end
                            :default default)
                  (get with-text :fields (list))))
           (assoc with-text :mirrors
                  (cons (hash-map :index index :start start :end end)
                        (get with-text :mirrors (list)))))))))

(define (-layout-loop tokens acc defaults)
  (if (nil? tokens)
      acc
      (-layout-loop (cdr tokens)
                    (-layout-step acc (car tokens) defaults)
                    defaults)))

(define (-build-defaults field-tokens indices)
  "Build the index->resolved-default hash-map."
  (-build-defaults-loop field-tokens indices {}))

(define (-build-defaults-loop field-tokens indices acc)
  (if (nil? indices)
      acc
      (-build-defaults-loop
       field-tokens (cdr indices)
       (assoc acc (car indices)
              (-resolve-default field-tokens (car indices))))))

(define (-sort-fields-by-index fields)
  "Sort canonical field records ascending by :index."
  (-insertion-sort fields
                   (lambda (a b) (< (get a :index 0) (get b :index 0)))))

(define (parse-snippet-body body)
  "Parse a snippet BODY string into {:text :fields :exit :mirrors}.

   :text is the body with every field marker replaced by its resolved
     default value (mirrors render the same default as their field).
   :fields is the list of canonical fields, ascending by tab index, each
     {:index :start :end :default}. :start/:end bound the field's text
     in :text.
   :mirrors is the list of mirror ranges (later occurrences of an index
     already claimed by a canonical field), each {:index :start :end}.
   :exit is the offset of `$0`, or the length of :text when absent."
  (let* ((tokens (reverse (-tokenise-loop body 0 (list))))
         (field-tokens (-field-tokens tokens))
         (indices (-distinct-indices field-tokens))
         (defaults (-build-defaults field-tokens indices))
         (laid (-layout-loop tokens (-layout-init) defaults))
         (text (get laid :out ""))
         (exit (let ((e (get laid :exit nil)))
                 (if (nil? e) (string-length text) e))))
    (hash-map
     :text text
     :exit exit
     :fields (-sort-fields-by-index (reverse (get laid :fields (list))))
     :mirrors (reverse (get laid :mirrors (list))))))
