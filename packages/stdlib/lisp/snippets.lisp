;;; snippets.lisp — the snippet engine: discovery, expansion, navigation.
;;;
;;; Builds on `snippets-parser.lisp` (the file-format reader and body
;;; parser). This file owns:
;;;
;;;   * the snippet store — a per-mode index of (key -> snippet record),
;;;     populated from a small built-in starter set plus the user's
;;;     `<user-data>/snippets/<mode>/` directories, with `.yas-parents`
;;;     parent fallthrough;
;;;   * the commands — `snippet-expand`, `snippet-insert`,
;;;     `snippet-list`, `snippet-reload`, and the field-navigation
;;;     commands `snippet-next-field` / `snippet-prev-field` /
;;;     `snippet-cancel`;
;;;   * the active-snippet record — buffer-local, one per buffer,
;;;     tracking the inserted range, the field list and the current
;;;     navigation index, so TAB walks the fields and ESC cancels;
;;;   * the defcustoms, defgroup and deffaces the feature contributes;
;;;   * a modeline getter (`snippet-modeline-indicator`) the host appends.
;;;
;;; yasnippet-compatible body syntax only ($N, ${N:default}, $0).
;;; Transformations, embedded code and conditions are out of scope here
;;; (Phase 4 in plans/SNIPPETS.md).
;;;
;;; Host primitives this file relies on (all already exposed except
;;; `snippet-user-directory`, added for this feature):
;;;   read-file-text!         (path -> string | nil)
;;;   list-directory-paths    (path -> list of (name . :file/:directory))
;;;   snippet-user-directory  (-> "<user-data>/snippets" | "")
;;;   point / goto! / set-mark! / clear-mark! / insert! / delete-region!
;;;   buffer-text / buffer-substring / region-active? / buffer-major-mode

;; ----------------------------------------------------------------------
;; Settings and faces
;; ----------------------------------------------------------------------

(defgroup 'snippets 'godot
  "Snippet expansion — yasnippet-style templates with tab stops.")

(defcustom *snippet-directories* nil :list
  :group 'snippets
  :doc "Root directories searched for snippets, in priority order. Each
        holds a `<mode>/` subdirectory per major mode. nil (the default)
        means: use only the user snippet directory
        (`<user-data>/snippets`), which is always searched. Earlier
        directories win on a key collision; the user directory wins over
        the built-in starter set.")

(defcustom *snippet-expand-key* "tab" :string
  :group 'snippets
  :doc "The key that expands the word before point when it is a known
        snippet trigger, and that advances to the next field while a
        snippet is active. Default \"tab\". Set to nil to disable the
        TAB trigger entirely (snippets are still reachable via
        `M-x snippet-expand` / `snippet-insert`).")

(defcustom *snippet-mirror-multi-cursor* #t :boolean
  :group 'snippets
  :doc "When #t (the default), arriving at a field that has mirrors
        (a `$N` that appears more than once) installs a multi-cursor set
        over the field and its mirrors, so typing updates every
        occurrence live (Policy A — mirrors are multi-cursors). When #f,
        mirrors render the field's default at expansion but do not update
        as the field is edited.")

(defcustom *snippet-mode-aliases*
  (list (cons "javascript-mode" "js-mode")
        (cons "typescript-mode" "js-mode")
        (cons "emacs-lisp-mode" "lisp-mode")
        (cons "text-mode" "fundamental-mode"))
  :list
  :group 'snippets
  :doc "Normalises mode-directory names to a canonical snippet-store
        name, so both a Godot mode whose name maps to `javascript-mode`
        and an existing yasnippet collection's `js-mode/` directory
        resolve to the same `js-mode` snippet set. The car is the name as
        derived from the buffer's major mode (or a yasnippet dir name);
        the cdr is the canonical name used to key the store. Names not in
        the table are used unchanged.")

(defface 'snippet-active-face
  :doc "The snippet field the cursor is currently on."
  :default-solarized-light (face :background "#cfe8ff")
  :default-dark    (face :background "#244a63")
  ;; `bright` is a DARK-background theme with a light syntax palette, so
  ;; its pill must be dark too — a light fill leaves the light text
  ;; unreadable (white-on-light).
  :default-bright  (face :background "#234f6e")
  :default-midnight (face :background "#1c3a4f"))

(defface 'snippet-inactive-face
  :doc "Forthcoming snippet fields the cursor has not yet reached. Tinted
        amber so the upcoming tab stops read as 'pending', distinct from
        the blue active field and the purple mirrors."
  :default-solarized-light (face :background "#fdeecb")
  :default-dark    (face :background "#4a3f24")
  ;; Dark amber for the dark-background `bright` theme (see active-face).
  :default-bright  (face :background "#514321")
  :default-midnight (face :background "#3a3018"))

(defface 'snippet-mirror-face
  :doc "Mirror occurrences of the active field (live-updating echoes)."
  :default-solarized-light (face :background "#e6dcff")
  :default-dark    (face :background "#3a2c5a")
  ;; Dark purple for the dark-background `bright` theme (see active-face).
  :default-bright  (face :background "#3c2c62")
  :default-midnight (face :background "#2c2148"))

(defface 'snippet-exit-face
  :doc "The snippet exit marker ($0)."
  :default-solarized-light (face :background "#f0f0f0")
  :default-dark    (face :background "#333a40")
  ;; Dark grey for the dark-background `bright` theme (see active-face).
  :default-bright  (face :background "#2b333b")
  :default-midnight (face :background "#262c31"))

;; ----------------------------------------------------------------------
;; The snippet store
;; ----------------------------------------------------------------------
;; A snippet record is the hash-map `parse-snippet-file` returns, with
;; the trigger key filled in (from the `# key:` header or, lacking that,
;; the filename). The store is a hash-map mode-name (a string) ->
;; (hash-map key (a string) -> snippet record). It is rebuilt by
;; `snippet-reload` and lazily on first use.

(define *snippet-store* nil)        ; nil until first load
(define *snippet-store-loaded?* #f)

(define (-snippet-store)
  "The snippet store, loaded on first use."
  (unless *snippet-store-loaded?* (snippet-load!))
  *snippet-store*)

;; --- the built-in starter set -----------------------------------------
;; A handful of universal snippets so the feature works out of the box,
;; before the user adds any files. Each is (mode key name body). These
;; are shadowed by any user snippet with the same (mode, key).

(define *snippet-builtins*
  (list
   ;; fundamental-mode — available everywhere via parent fallthrough.
   (list "fundamental-mode" "date" "current date"
         "`date`")
   (list "fundamental-mode" "datetime" "date and time"
         "`datetime`")
   (list "fundamental-mode" "sig" "signature"
         "-- ${1:Your Name}\n${2:you@example.com}$0")
   (list "fundamental-mode" "todo" "TODO marker"
         "TODO(${1:author}): ${2:describe the task}$0")
   (list "fundamental-mode" "fixme" "FIXME marker"
         "FIXME: ${1:what is broken}$0")
   ;; A copyright / licence header.
   (list "fundamental-mode" "copyright" "copyright header"
         "Copyright (c) `year` ${1:Author}. All rights reserved.$0")
   ;; An inline Markdown link — two fields on one line.
   (list "fundamental-mode" "link" "markdown link"
         "[${1:text}](${2:url})$0")
   ;; prog-mode — common across programming languages.
   (list "prog-mode" "shebang" "shebang line"
         "#!/usr/bin/env ${1:bash}\n$0")
   (list "prog-mode" "if" "if block"
         "if (${1:condition}) {\n  $0\n}")
   (list "prog-mode" "while" "while loop"
         "while (${1:condition}) {\n  $0\n}")
   (list "prog-mode" "for" "for loop"
         "for (let ${1:i} = 0; $1 < ${2:n}; $1++) {\n  $0\n}")
   ;; js-mode — a small JS-specific set on top of prog-mode.
   (list "js-mode" "fn" "function"
         "function ${1:name}(${2:args}) {\n  $0\n}")
   (list "js-mode" "afn" "arrow function"
         "const ${1:name} = (${2:args}) => {\n  $0\n}")
   ;; try / catch — the `$1` error name is mirrored into the handler body.
   (list "js-mode" "try" "try / catch"
         "try {\n  $0\n} catch (${1:err}) {\n  console.error($1);\n}")
   (list "js-mode" "imp" "import"
         "import { ${1:names} } from '${2:module}';$0")
   (list "js-mode" "log" "console.log"
         "console.log(${1:value})$0")))

(define (-builtin->record entry)
  "Turn a builtin (mode key name body) list into a snippet record."
  (let ((key (cadr entry))
        (name (caddr entry))
        (body (car (cdr (cdr (cdr entry))))))
    (hash-map :key key :name name :group nil :condition nil :body body
              :source :builtin)))

(define (-builtins-for-mode mode)
  "The builtin (key . record) pairs for MODE (a string)."
  (map (lambda (e) (cons (cadr e) (-builtin->record e)))
       (filter (lambda (e) (string=? (car e) mode)) *snippet-builtins*)))

;; --- directory walking -------------------------------------------------

(define (-snippet-roots)
  "The snippet root directories to search, in priority order: the
   configured `*snippet-directories*` first, then the user directory."
  (let ((user (snippet-user-directory)))
    (append (if (nil? *snippet-directories*) (list) *snippet-directories*)
            (if (or (nil? user) (string=? user "")) (list) (list user)))))

(define (-path-join a b)
  "Join path segments A and B with a single '/'."
  (cond
    ((string=? a "") b)
    ((string-suffix? "/" a) (str a b))
    (else (str a "/" b))))

(define (-read-snippet-file path key)
  "Read and parse the snippet file at PATH, filling in KEY when the file
   carries no `# key:` header. Returns the record, or nil on read
   failure."
  (let ((text (read-file-text! path)))
    (if (nil? text)
        nil
        (let* ((record (parse-snippet-file text))
               (file-key (get record :key nil)))
          (assoc (assoc record :source :file)
                 :key (if (nil? file-key) key file-key))))))

(define (-list-snippet-files dir)
  "The non-directory entries of DIR, as a list of (name . path) pairs.
   Hidden files (including `.yas-parents`) are excluded by the host
   listing; they are read by exact name where needed."
  (let ((entries (list-directory-paths dir)))
    (if (nil? entries)
        (list)
        (map (lambda (e) (cons (car e) (-path-join dir (car e))))
             (filter (lambda (e) (eq? (cdr e) :file)) entries)))))

(define (-load-mode-dir dir)
  "Load every snippet file in DIR into a (key -> record) hash-map."
  (-fold-into-map
   (map (lambda (np)
          (let ((record (-read-snippet-file (cdr np) (car np))))
            (if (nil? record) nil (cons (get record :key (car np)) record))))
        (-list-snippet-files dir))
   {}))

(define (-fold-into-map pairs acc)
  "Fold (key . value) PAIRS into ACC. Earlier pairs win — a later pair
   for a key already present is ignored (so directory order encodes
   priority)."
  (cond
    ((nil? pairs) acc)
    ((nil? (car pairs)) (-fold-into-map (cdr pairs) acc))
    ((contains? acc (car (car pairs))) (-fold-into-map (cdr pairs) acc))
    (else (-fold-into-map (cdr pairs)
                          (assoc acc (car (car pairs)) (cdr (car pairs)))))))

(define (-read-yas-parents dir)
  "Read DIR's `.yas-parents` file (whitespace/newline-separated parent
   mode names) into a list of strings, or nil when absent."
  (let ((text (read-file-text! (-path-join dir ".yas-parents"))))
    (if (nil? text)
        nil
        (filter (lambda (s) (not (string=? s "")))
                (map string-trim (-split-ws text))))))

(define (-split-ws text)
  "Split TEXT on any run of whitespace into a list of tokens."
  (filter (lambda (s) (not (string=? (string-trim s) "")))
          (string-split (-normalise-ws text) " ")))

(define (-normalise-ws text)
  "Replace every newline/tab/CR in TEXT with a space."
  (-replace-chars text "\n\t\r" " "))

(define (-replace-chars text from-chars to)
  "Replace each character of TEXT that appears in FROM-CHARS with TO."
  (-replace-chars-loop text from-chars to 0 ""))

(define (-replace-chars-loop text from-chars to i acc)
  (if (>= i (string-length text))
      acc
      (let ((ch (char-at text i)))
        (-replace-chars-loop
         text from-chars to (+ i 1)
         (str acc (if (>= (string-index-of from-chars ch) 0) to ch))))))

;; --- per-mode merge with parent fallthrough ----------------------------

(define (-collect-mode-snippets mode roots)
  "Every snippet for MODE (a string) across ROOTS, merged so an earlier
   root wins a key collision. Builtins for MODE seed the result at the
   lowest priority."
  (-fold-into-map
   (append
    ;; File snippets across the roots, in priority order.
    (-flatten-pairs
     (map (lambda (root) (-mode-dir-pairs (-path-join root mode))) roots))
    ;; Builtins last (lowest priority — user files shadow them).
    (-builtins-for-mode mode))
   {}))

(define (-mode-dir-pairs dir)
  "The (key . record) pairs from a single mode directory DIR."
  (map (lambda (key) (cons key (get (-load-mode-dir dir) key nil)))
       (keys (-load-mode-dir dir))))

(define (-flatten-pairs list-of-lists)
  (cond
    ((nil? list-of-lists) (list))
    (else (append (car list-of-lists) (-flatten-pairs (cdr list-of-lists))))))

(define (-mode-parents mode roots)
  "MODE's parent mode names, read from the first `.yas-parents` found
   across ROOTS, or the built-in default chain when none is on disk."
  (let ((from-disk (-first-yas-parents mode roots)))
    (if (nil? from-disk) (-default-parents mode) from-disk)))

(define (-first-yas-parents mode roots)
  (cond
    ((nil? roots) nil)
    (else
     (let ((parents (-read-yas-parents (-path-join (car roots) mode))))
       (if (nil? parents) (-first-yas-parents mode (cdr roots)) parents)))))

(define (-default-parents mode)
  "The built-in parent chain for MODE when no `.yas-parents` exists:
   programming modes fall through to prog-mode then fundamental-mode;
   everything else falls through to fundamental-mode."
  (cond
    ((string=? mode "fundamental-mode") (list))
    ((string=? mode "prog-mode") (list "fundamental-mode"))
    ((-member-string? mode (list "js-mode" "python-mode" "lisp-mode"))
     (list "prog-mode" "fundamental-mode"))
    (else (list "fundamental-mode"))))

(define (-member-string? s lst)
  (cond ((nil? lst) #f)
        ((string=? s (car lst)) #t)
        (else (-member-string? s (cdr lst)))))

;; --- the store load ----------------------------------------------------

(define (snippet-load!)
  "Rebuild the snippet store from the built-in set and the snippet
   directories. Cheap enough to call on demand; `snippet-reload` exposes
   it as a command."
  (set! *snippet-store* {})
  (set! *snippet-store-loaded?* #t)
  *snippet-store*)

(define (-mode-store mode)
  "The merged (key -> record) map for MODE, with its parent chain folded
   in (the mode's own snippets win over a parent's). Cached in
   `*snippet-store*` per mode name."
  (let ((cached (get (-snippet-store) mode nil)))
    (if (not (nil? cached))
        cached
        (let* ((roots (-snippet-roots))
               (own (-collect-mode-snippets mode roots))
               (merged (-merge-with-parents own (-mode-parents mode roots)
                                            roots)))
          (set! *snippet-store* (assoc *snippet-store* mode merged))
          merged))))

(define (-merge-with-parents own parents roots)
  "Fold each parent mode's snippets under OWN — OWN wins a key collision.
   Parents are walked transitively (a parent's own parents too)."
  (cond
    ((nil? parents) own)
    (else
     (-merge-with-parents
      (-merge-maps own (-collect-mode-snippets (car parents) roots))
      (append (cdr parents) (-mode-parents (car parents) roots))
      roots))))

(define (-merge-maps primary secondary)
  "PRIMARY layered over SECONDARY: every key of SECONDARY not already in
   PRIMARY is added."
  (-fold-into-map
   (append (map (lambda (k) (cons k (get primary k nil))) (keys primary))
           (map (lambda (k) (cons k (get secondary k nil))) (keys secondary)))
   {}))

;; ----------------------------------------------------------------------
;; Lookups
;; ----------------------------------------------------------------------

(define (-current-mode-name)
  "The current buffer's canonical snippet-store mode name (a string).
   Derived from the major mode's display name (`Lisp` -> `lisp-mode`,
   `JavaScript` -> `javascript-mode`) and then normalised through
   `*snippet-mode-aliases*` (`javascript-mode` -> `js-mode`). Falls back
   to fundamental-mode for a buffer with no major mode."
  (let ((m (buffer-major-mode)))
    (if (nil? m)
        "fundamental-mode"
        (-apply-mode-alias
         (str (string-downcase (get m :name "Fundamental")) "-mode")))))

(define (-apply-mode-alias name)
  "Normalise mode NAME through `*snippet-mode-aliases*`, returning the
   canonical store name (NAME unchanged when no alias matches)."
  (-assoc-string *snippet-mode-aliases* name name))

(define (-assoc-string alist key default)
  "The cdr of the first (key-string . value) pair in ALIST whose car
   string=? KEY, or DEFAULT."
  (cond
    ((nil? alist) default)
    ((and (pair? (car alist)) (string=? (car (car alist)) key))
     (cdr (car alist)))
    (else (-assoc-string (cdr alist) key default))))

(define (snippet-lookup key)
  "The snippet record for trigger KEY in the current buffer's mode (with
   parent fallthrough), or nil."
  (get (-mode-store (-current-mode-name)) key nil))

(define (snippet-keys-for-mode mode)
  "Every trigger key available in MODE (a string), as a list of strings,
   sorted."
  (-sort-strings (keys (-mode-store mode))))

(define (-sort-strings strs)
  (-snip-insertion-sort strs (lambda (a b) (< (-strcmp a b) 0))))

(define (-snip-insertion-sort items less?)
  (if (nil? items)
      (list)
      (-snip-insert (car items) (-snip-insertion-sort (cdr items) less?) less?)))

(define (-snip-insert x sorted less?)
  (cond
    ((nil? sorted) (list x))
    ((less? x (car sorted)) (cons x sorted))
    (else (cons (car sorted) (-snip-insert x (cdr sorted) less?)))))

(define (-strcmp a b)
  "Three-way string comparison: negative, zero, positive."
  (cond
    ((string=? a b) 0)
    ((-string<? a b) -1)
    (else 1)))

(define (-string<? a b)
  "True when A sorts before B (lexicographic by character code)."
  (-string<?-loop a b 0))

(define (-string<?-loop a b i)
  (cond
    ((>= i (string-length a)) (< (string-length a) (string-length b)))
    ((>= i (string-length b)) #f)
    (else
     (let ((ca (char-at a i)) (cb (char-at b i)))
       (cond
         ((string=? ca cb) (-string<?-loop a b (+ i 1)))
         (else (< (-char-code ca) (-char-code cb))))))))

(define (-char-code ch)
  "A stable numeric code for a one-character string — its index in a
   reference alphabet, or a large constant for characters outside it so
   sorting stays total. Good enough for ordering snippet keys."
  (let ((idx (string-index-of
              "\t\n !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"
              ch)))
    (if (< idx 0) 9999 idx)))

;; ----------------------------------------------------------------------
;; The active snippet record (buffer-local; one per buffer)
;; ----------------------------------------------------------------------
;; The renderer model has no buffer-local Lisp slot exposed yet, so the
;; active snippet is held in a module variable keyed by nothing — there
;; is one active snippet at a time across the editor, which matches the
;; one-snippet-per-buffer invariant in single-buffer interactive use.
;; (Switching buffers mid-snippet is a soft-commit; see
;; `snippet-soft-commit-if-outside`.)
;;
;; The record is a hash-map:
;;   :origin   the buffer offset where the inserted body begins
;;   :fields   list of field records {:index :start :end} — :start/:end
;;             are offsets RELATIVE to :origin, kept current as the user
;;             edits the active field
;;   :mirrors  list of mirror records {:index :start :end} (relative)
;;   :exit     the exit offset (relative to :origin)
;;   :current  the index into :fields of the active field, or -1 before
;;             the first navigation
;;   :length   the current length of the inserted body (absolute extent
;;             is [:origin, :origin + :length))

(define *active-snippet* nil)

(define (snippet-active?)
  "True when a snippet is currently being navigated."
  (not (nil? *active-snippet*)))

(define (-as-get key default) (get *active-snippet* key default))
(define (-as-set! key value)
  (set! *active-snippet* (assoc *active-snippet* key value)))

(define (-abs offset) (+ (-as-get :origin 0) offset))

;; ----------------------------------------------------------------------
;; Expansion
;; ----------------------------------------------------------------------

(define (-expand-record! record origin)
  "Insert RECORD's parsed body at ORIGIN (point is assumed to be at
   ORIGIN with the trigger word already removed), build the active
   snippet, and move to the first field. With no fields, point lands at
   the exit and no active record is kept (static expansion — Phase 1)."
  (let* ((parsed (parse-snippet-body (-resolve-embedded (get record :body ""))))
         (text (get parsed :text ""))
         (fields (get parsed :fields (list)))
         (mirrors (get parsed :mirrors (list)))
         (exit (get parsed :exit (string-length text))))
    (goto! origin)
    (insert! text)
    (cond
      ((nil? fields)
       ;; Static snippet — drop point at the exit and commit immediately.
       (goto! (+ origin exit))
       (set! *active-snippet* nil))
      (else
       (set! *active-snippet*
             (hash-map :origin origin
                       :fields fields
                       :mirrors mirrors
                       :exit exit
                       :current -1
                       :length (string-length text)))
       (snippet-next-field)))))

(define (-resolve-embedded body)
  "Resolve the handful of backtick embedded-code forms the starter set
   uses (`date`, `datetime`, `year`). Full embedded-code evaluation is
   Phase 4; this is a deliberately tiny allow-list so the built-in
   snippets produce live values without opening the eval surface."
  (-replace-token
   (-replace-token
    (-replace-token body "`date`" (snippet-today-string))
    "`datetime`" (snippet-now-string))
   "`year`" (snippet-year-string)))

(define (-replace-token text token replacement)
  "Replace every occurrence of literal TOKEN in TEXT with REPLACEMENT."
  (let ((idx (string-index-of text token)))
    (if (< idx 0)
        text
        (str (substring text 0 idx)
             replacement
             (-replace-token (substring text (+ idx (string-length token))
                                        (string-length text))
                             token replacement)))))

;; Date helpers route through the host `snippet-date-string` primitive
;; (the desktop app formats `date`, `datetime` and `year`; the test
;; harness stubs it). The primitive is part of the standard host surface
;; that snippets.lisp loads against, so it is always bound here.
(define (snippet-today-string) (snippet-date-string "date"))
(define (snippet-now-string) (snippet-date-string "datetime"))
(define (snippet-year-string) (snippet-date-string "year"))

;; --- word-before-point trigger ----------------------------------------

(define (-word-before-point)
  "The (start . word) of the run of word characters ending at point, or
   nil when point is not immediately after a word character."
  (let* ((p (point))
         (start (word-backward-offset)))
    (if (or (>= start p) (= start p))
        nil
        (let ((w (buffer-substring start p)))
          (if (string=? w "") nil (cons start w))))))

(defcommand snippet-expand ()
  "Expand the snippet whose trigger is the word before point. Returns #t
   when a snippet was expanded, #f otherwise — `snippet-tab` consults the
   return value to decide whether TAB should fall through to its default
   behaviour. (In this Lisp only #f is false, so the false case must be
   #f, not nil, for the keymap's `and` to short-circuit correctly.)"
  (let ((wb (-word-before-point)))
    (if (nil? wb)
        #f
        (let* ((start (car wb))
               (word (cdr wb))
               (record (snippet-lookup word)))
          (if (nil? record)
              #f
              (begin
                ;; Remove the trigger word, then expand at its start.
                (delete-region! start (point))
                (goto! start)
                (-expand-record! record start)
                #t))))))

(defcommand snippet-insert (key)
  "Pick a snippet by name from the current mode's set and insert it at
   point, expanding it as a live template. KEY is read from the
   minibuffer (the host completes against `snippet-keys-for-mode`)."
  (interactive (string "Snippet: "))
  (snippet-insert-by-key key))

;; The body is split out so the engine (and tests) can drive it directly
;; without the minibuffer round-trip.
(define (snippet-insert-by-key key)
  "Insert the snippet named KEY (a string) at point, expanding it as a
   live template. Returns #t on success, #f when KEY is unknown in the
   current mode."
  (let ((record (snippet-lookup key)))
    (if (nil? record)
        #f
        (let ((origin (point)))
          (-expand-record! record origin)
          #t))))

(defcommand snippet-list ()
  "Show the snippet triggers available in the current buffer's mode."
  (let ((mode (-current-mode-name))
        (keys (snippet-keys-for-mode (-current-mode-name))))
    (show-status!
     (if (nil? keys)
         (str "No snippets for " mode)
         (str "Snippets (" mode "): " (-join-strings keys "  "))))))

(define (-join-strings strs sep)
  (cond
    ((nil? strs) "")
    ((nil? (cdr strs)) (car strs))
    (else (str (car strs) sep (-join-strings (cdr strs) sep)))))

(defcommand snippet-reload ()
  "Rescan the snippet directories, discarding the cached store."
  (set! *snippet-store* {})
  (set! *snippet-store-loaded?* #t)
  (show-status! "Snippets reloaded"))

;; ----------------------------------------------------------------------
;; Field navigation
;; ----------------------------------------------------------------------

(define (-field-at fields i)
  "The I-th field record in FIELDS (0-based), or nil."
  (cond
    ((nil? fields) nil)
    ((= i 0) (car fields))
    (else (-field-at (cdr fields) (- i 1)))))

(define (-select-field! field)
  "Move point to FIELD and select its current text, so typing replaces
   it. The field's default occupies [:start, :end) relative to :origin.
   When the field has mirrors and `*snippet-mirror-multi-cursor*` is on,
   install a secondary cursor over each mirror too (Policy A), so typing
   updates every occurrence live."
  (let ((start (-abs (get field :start 0)))
        (end (-abs (get field :end 0))))
    ;; Drop any prior multi-cursor set before re-selecting.
    (collapse-to-primary!)
    (goto! start)
    (if (> end start)
        (begin (set-mark! start) (goto! end))
        (begin (clear-mark!) (goto! start)))
    (when *snippet-mirror-multi-cursor*
      (-install-mirror-cursors (get field :index -1)))))

(define (-install-mirror-cursors index)
  "Add a secondary cursor selecting each mirror of field INDEX, so a
   multi-cursor edit propagates the typed text to every occurrence."
  (for-each
   (lambda (m)
     (let ((ms (-abs (get m :start 0)))
           (me (-abs (get m :end 0))))
       (if (> me ms)
           (add-selection! me ms)
           (add-selection! ms))))
   (-mirrors-of-index index)))

(define (-mirrors-of-index index)
  "The active snippet's mirror records whose :index is INDEX."
  (filter (lambda (m) (= (get m :index -1) index))
          (-as-get :mirrors (list))))

(defcommand snippet-next-field ()
  "Advance to the next snippet field, selecting its text. On the last
   field, jump to the exit and commit the snippet."
  (when (snippet-active?)
    (let* ((fields (-as-get :fields (list)))
           (next (+ (-as-get :current -1) 1)))
      (if (>= next (length fields))
          (snippet-commit)
          (begin
            (-as-set! :current next)
            (-select-field! (-field-at fields next)))))))

(defcommand snippet-prev-field ()
  "Move to the previous snippet field. Stops at the first field; does
   not wrap or commit."
  (when (snippet-active?)
    (let ((prev (- (-as-get :current 0) 1)))
      (when (>= prev 0)
        (-as-set! :current prev)
        (-select-field! (-field-at (-as-get :fields (list)) prev))))))

(define (snippet-commit)
  "Finish the active snippet: drop any multi-cursor set and selection,
   place point at the exit, and clear the active record. The inserted
   text stays."
  (when (snippet-active?)
    (let ((exit (-abs (-as-get :exit 0))))
      (collapse-to-primary!)
      (clear-mark!)
      (goto! exit)
      (set! *active-snippet* nil))))

(defcommand snippet-cancel ()
  "Cancel the active snippet (ESC / C-g). The inserted text stays; the
   active record is discarded and field navigation stops. Point is left
   at the exit position. (The whole expansion is one undo step, so a
   single undo removes the inserted body.)"
  (when (snippet-active?)
    (let ((exit (-abs (-as-get :exit 0))))
      (collapse-to-primary!)
      (clear-mark!)
      (goto! exit)
      (set! *active-snippet* nil))))

;; --- edit tracking -----------------------------------------------------
;; While a snippet is active the user types in the selected field. The
;; field offsets are stored relative to :origin; after each edit the
;; active field's :end (and every later field/mirror/exit offset) shifts
;; by the change in the active field's length. `snippet-after-edit!` is
;; called by the host on every buffer change while a snippet is active.

(define (snippet-after-edit!)
  "Re-derive the active field's length from the primary cursor and reflow
   every stored offset. Called by the host after a buffer edit while a
   snippet is active. The active field runs from its :start to the
   current primary point; the same length is applied to each of the
   field's mirror occurrences (they were edited in lockstep by the
   multi-cursor `insert`), and every offset after each occurrence shifts
   by the per-occurrence delta."
  (when (snippet-active?)
    (let* ((fields (-as-get :fields (list)))
           (cur (-as-get :current -1)))
      (when (and (>= cur 0) (< cur (length fields)))
        (let* ((field (-field-at fields cur))
               (old-len (- (get field :end 0) (get field :start 0)))
               (new-len (- (-primary-point) (-as-get :origin 0)
                           (get field :start 0)))
               (delta (- new-len old-len)))
          (if (< new-len 0)
              ;; The edit landed before the active field (e.g. C-a then C-k
              ;; cleared the line) — the snippet is destroyed; drop it so a
              ;; fresh trigger can expand instead of the next TAB advancing a
              ;; dead record.
              (begin (collapse-to-primary!) (set! *active-snippet* nil))
              (unless (= delta 0)
                (-reflow-occurrences! (get field :index -1) old-len delta))))))))

(define (-primary-point)
  "The primary cursor's absolute offset. With a multi-cursor set the
   primary is the first selection; `point` already reports it, but this
   name documents the intent at the reflow call site."
  (point))

;; The reflow walks every occurrence of the edited field's index (the
;; canonical field plus its mirrors) in document order. Each occurrence
;; grew by DELTA; offsets at or after an occurrence's old end shift by
;; DELTA, and the cumulative shift carries forward so a later occurrence's
;; own start is already shifted by the earlier occurrences.

(define (-occurrence-starts index)
  "Every occurrence start (relative) of INDEX — the canonical field plus
   its mirrors — sorted ascending."
  (-sort-numbers
   (append
    (map (lambda (f) (get f :start 0))
         (filter (lambda (f) (= (get f :index -1) index))
                 (-as-get :fields (list))))
    (map (lambda (m) (get m :start 0)) (-mirrors-of-index index)))))

(define (-reflow-occurrences! index old-len delta)
  "Apply DELTA at each occurrence of INDEX. OLD-LEN is each occurrence's
   length before the edit. Processes occurrences left-to-right so the
   cumulative shift is consistent."
  (-reflow-occurrences-loop (-occurrence-starts index) old-len delta 0))

(define (-reflow-occurrences-loop starts old-len delta shift)
  "STARTS are the original (pre-edit) occurrence starts ascending. SHIFT
   is the accumulated shift from occurrences already processed. For each
   occurrence at original START, its old end was (START + OLD-LEN); after
   accounting for the running SHIFT that boundary is at
   (START + OLD-LEN + SHIFT). Every stored offset at or after that
   boundary moves by DELTA."
  (cond
    ((nil? starts) nil)
    (else
     (let ((boundary (+ (car starts) old-len shift)))
       (-shift-all-after! boundary delta)
       (-reflow-occurrences-loop (cdr starts) old-len delta
                                 (+ shift delta))))))

(define (-shift-all-after! boundary delta)
  "Shift every stored offset (field starts/ends, mirror starts/ends, the
   exit, and the total length) that sits at or after BOUNDARY by DELTA.
   An offset exactly at BOUNDARY is the end of the just-grown occurrence
   text, so it moves with the text."
  (-as-set! :fields (-reflow-ranges (-as-get :fields (list)) boundary delta))
  (-as-set! :mirrors (-reflow-ranges (-as-get :mirrors (list)) boundary delta))
  (-as-set! :exit (-shift-after (-as-get :exit 0) boundary delta))
  (-as-set! :length (+ (-as-get :length 0) delta)))

(define (-shift-after offset boundary delta)
  "Shift OFFSET by DELTA when it sits at or after BOUNDARY."
  (if (>= offset boundary) (+ offset delta) offset))

(define (-reflow-ranges ranges boundary delta)
  (map (lambda (r) (-shift-range r boundary delta)) ranges))

(define (-shift-range range boundary delta)
  "Shift a {:start :end …} range past BOUNDARY by DELTA. The range's
   :start moves only when strictly after BOUNDARY (an occurrence whose
   text grew keeps its start but extends its end); its :end moves when at
   or after BOUNDARY."
  (assoc (assoc range :start
                (if (> (get range :start 0) boundary)
                    (+ (get range :start 0) delta)
                    (get range :start 0)))
         :end (-shift-after (get range :end 0) boundary delta)))

;; --- soft commit on point leaving the snippet --------------------------

(define (snippet-soft-commit-if-outside)
  "If point has moved outside the active snippet's extent, soft-commit:
   discard the active record but keep the text. Called by the host on
   cursor moves that aren't field navigation."
  (when (snippet-active?)
    (let ((origin (-as-get :origin 0))
          (end (+ (-as-get :origin 0) (-as-get :length 0)))
          (p (point)))
      (when (or (< p origin) (> p end))
        (set! *active-snippet* nil)))))

;; ----------------------------------------------------------------------
;; Modeline + face data for the host
;; ----------------------------------------------------------------------

(define (snippet-modeline-indicator)
  "The modeline fragment for an active snippet, e.g. \"[snippet: 2/4]\",
   or an empty string when no snippet is active. Field numbers are
   1-based; the count is the number of tab stops."
  (if (not (snippet-active?))
      ""
      (let ((current (+ (-as-get :current -1) 1))
            (total (length (-as-get :fields (list)))))
        (str "[snippet: " (max current 1) "/" total "]"))))

(define (snippet-active-region)
  "The active field's absolute (start . end) range, or nil. The host can
   paint `snippet-active-face` over it; the selection already covers it
   so this is a convenience for a future overlay path."
  (if (not (snippet-active?))
      nil
      (let* ((fields (-as-get :fields (list)))
             (cur (-as-get :current -1)))
        (if (or (< cur 0) (>= cur (length fields)))
            nil
            (let ((f (-field-at fields cur)))
              (cons (-abs (get f :start 0)) (-abs (get f :end 0))))))))

(define (snippet-mirror-regions)
  "The active snippet's mirror ranges as absolute (start . end) pairs,
   for the host to paint with `snippet-mirror-face`. Empty when none."
  (if (not (snippet-active?))
      (list)
      (map (lambda (m) (cons (-abs (get m :start 0)) (-abs (get m :end 0))))
           (-as-get :mirrors (list)))))

(define (-snippet-forthcoming-acc fields i cur acc)
  "Accumulate fields whose index is strictly after CUR as absolute
   (start . end) pairs — the not-yet-reached tab stops. Order is
   irrelevant (each paints as its own box), so there is no final reverse."
  (if (nil? fields)
      acc
      (-snippet-forthcoming-acc
        (cdr fields) (+ i 1) cur
        (if (> i cur)
            (cons (cons (-abs (get (car fields) :start 0))
                        (-abs (get (car fields) :end 0)))
                  acc)
            acc))))

(define (snippet-forthcoming-regions)
  "The not-yet-reached tab-stop fields (those after the current one) as
   absolute (start . end) pairs, for the host to paint with
   `snippet-inactive-face` so forthcoming stops show as pills. Empty when
   no snippet is active or point is on the last field."
  (if (not (snippet-active?))
      (list)
      (-snippet-forthcoming-acc
        (-as-get :fields (list)) 0 (-as-get :current -1) (list))))
