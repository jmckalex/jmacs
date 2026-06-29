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

(define (smallest-covering-capture captures pos)
  "Return the smallest-range capture in CAPTURES whose [start, end)
   covers POS, or `nil` when none does. CAPTURES is a list of
   (START END FACE) lists. On a tie the first such capture wins —
   tree-sitter emits captures in document order, so the outer-grammar
   range comes first and would win without further intervention, but
   for `describe-face-at-point` the smaller range is what the user
   wants to see.

   Implemented with `reduce` rather than recursion: a real buffer
   yields thousands of captures, and the interpreter has no TCO."
  (reduce
    (lambda (best candidate)
      (cond
        ((not (-face-info-covers? candidate pos)) best)
        ((nil? best) candidate)
        ((< (-face-info-range-width candidate)
            (-face-info-range-width best))
         candidate)
        (else best)))
    nil
    captures))

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
    "```\n" snippet "\n```\n\n"
    "### Change it live\n\n"
    "- **Recolour this face:** `M-x customize-face` "
    "(or `(set-face-attribute '" face " :foreground \"#…\")`); add "
    "`:mode \"…\"` to recolour it in this major mode only.\n"
    "- **Reassign this construct to a different face:** press "
    "`C-h C-f` (`highlight-construct-at-point`) here.\n"))

(define (-face-info-render-ancestors ancestors)
  "Render ANCESTORS (immediate parent first) as a left-arrowed chain,
   or `(none)` when the list is empty."
  (cond
    ((nil? ancestors) "(none)")
    (else
      (reduce (lambda (acc next) (str acc " ← " next))
              (car ancestors)
              (cdr ancestors)))))

(define (-face-info-render-no-capture
          lang node-type start end ancestors snippet)
  "Build the Markdown body for the no-capture diagnostic page. Used
   when tree-sitter has parsed the construct under the cursor but no
   query rule fires on it — the user gets the node type, the parent
   chain, and the one-step `C-h C-f` flow to face it live."
  (begin
    (str
      "**No face here** — tree-sitter parsed this construct but no "
      "query rule in the `" lang "` highlighter fires on it. The "
      "diagnostic below is the raw node info you'd write a rule against.\n\n"
      "**Node type:** `" node-type "`\n\n"
      "**Ancestor chain:** `"
      (-face-info-render-ancestors ancestors) "`\n\n"
      "**Language:** `" lang "`\n\n"
      "**Range:** `[" (number->string start)
      ", " (number->string end) ")`\n\n"
      "**Text:**\n\n"
      "```\n" snippet "\n```\n\n"
      "### Face it live — no file editing\n\n"
      "Press **`C-h C-f`** (`highlight-construct-at-point`) with the "
      "cursor here. You'll be asked to:\n\n"
      "1. **name a face** — an existing one (`keyword`, `function`, "
      "`variable`, `type`, `constant`, …) or a new name;\n"
      "2. if it's new, **pick its colour** (a new face is created on the "
      "spot);\n"
      "3. **choose a scope** — *this major mode only* (the default, `m`) "
      "or *everywhere for the language* (`l`).\n\n"
      "The rule maps the node type `" node-type "` -> your face and "
      "applies **immediately**; it is remembered across restarts. The "
      "rule layers on top of the built-in `" lang "` grammar query — it "
      "never edits the language's `.js` file.\n\n"
      "(Power users: the equivalent Lisp is "
      "`(add-highlight-rule! 'mode \"<Mode>\" \"" node-type
      "\" '<face>)`; remove with `remove-highlight-rule!`.)\n")))

;; --- the command ------------------------------------------------------

(defcommand describe-face-at-point ()
  "Open a `*Face at point*` doc buffer describing the tree-sitter
   capture under the cursor: face name, CSS class, the active theme's
   resolved colour, the captured range, and the text it covers. When
   no capture covers point but tree-sitter has parsed the construct,
   fall back to surfacing the raw node type and parent chain so the
   user knows what query rule they'd write to face it. The user's
   diagnostic tool when customising the colour theme. Bound to
   `C-h F`; aliased as `describe-syntax-at-point`."
  ;; Tree-sitter runs render-side (WASM), so the spine asks the renderer for the
  ;; focused buffer's captures + node at point, then runs the rest here (Model B).
  (with-tree-sitter-info
    (lambda (lang captures node)
      (cond
        ((nil? lang)
         (println "no tree-sitter language for this buffer"))
        (else
          (let* ((pos (point))
                 (chosen (smallest-covering-capture captures pos)))
            (cond
              ((nil? chosen)
               (cond
                 ((nil? node)
                  (println (str "no capture covers point ("
                                (number->string pos)
                                ") in this " lang " buffer")))
                 (else
                   (let* ((node-type (get node :type ""))
                          (start (get node :start 0))
                          (end (get node :end 0))
                          (ancestors (get node :ancestors nil))
                          (snippet (-face-info-clip (buffer-text) start end))
                          (body (-face-info-render-no-capture
                                  lang node-type start end
                                  ancestors snippet)))
                     (open-docstring-page! "Face at point" body)))))
              (else
                (let* ((start (car chosen))
                       (end (cadr chosen))
                       (face (caddr chosen))
                       (color (face-color-for face))
                       (snippet (-face-info-clip (buffer-text) start end))
                       (body (-face-info-render
                               lang face start end color snippet)))
                  (open-docstring-page! "Face at point" body))))))))))

(defcommand describe-syntax-at-point ()
  "Alias of `describe-face-at-point` — open a doc page describing the
   tree-sitter capture at point. Same key, same output."
  (describe-face-at-point))

;;; --- the one-step "face this construct" flow (C-h C-f) ----------------
;;;
;;; `describe-face-at-point` (C-h F) is the diagnostic; this is the
;;; ACTION. Point at a construct the grammar parses, run the flow, and:
;;;   1. name a face (an existing one, or a new one you colour on the spot)
;;;   2. assign the construct's tree-sitter node type -> that face
;;;   3. choose scope: this major mode only (default) or everywhere
;;;      (this language)
;;;   4. see it apply LIVE — no file editing, no restart.
;;;
;;; Keyboard-driven via the minibuffer; built on the highlight-rules.lisp
;;; override layer and faces.lisp's `create-face!`.

(define (-hcap-pattern node-type)
  "The tree-sitter pattern for NODE-TYPE — the bare node type, which
   `add-highlight-rule!` wraps as `(node-type) @face`."
  node-type)

(define (-hcap-add-rule! scope key node-type face-name)
  "Add the construct->face rule for NODE-TYPE in SCOPE/KEY and report it."
  (add-highlight-rule! scope key (-hcap-pattern node-type) face-name)
  (println (str "faced `" node-type "` -> `" (symbol->string face-name)
                "` (" (if (eq? scope 'mode) "mode " "language ") key ")")))

(define (-hcap-choose-scope node-type face-name lang mode)
  "Prompt for the rule scope, then add it. Default (empty / 'm') is the
   major mode; 'l' is the whole language."
  (minibuffer-read
    (str "Scope — [m] this mode (" mode ") or [l] everywhere (" lang ")? ")
    (lambda (answer)
      (unless (nil? answer)
        (if (or (string=? answer "l") (string=? answer "L"))
            (-hcap-add-rule! 'language lang node-type face-name)
            (-hcap-add-rule! 'mode mode node-type face-name))))))

(define (-hcap-with-face node-type face-name lang mode)
  "Given a chosen FACE-NAME (a symbol): if it is already registered, go
   straight to the scope prompt; otherwise prompt for a colour, create
   the face, then the scope prompt."
  (if (face-registered? face-name)
      (-hcap-choose-scope node-type face-name lang mode)
      (minibuffer-read
        (str "New face `" (symbol->string face-name)
             "` — foreground colour (e.g. #c792ea): ")
        (lambda (color)
          (cond
            ((nil? color) nil)
            ((= (string-length color) 0)
             (println "no colour given — face not created"))
            (else
              (create-face! face-name color)
              (println (str "created face `" (symbol->string face-name)
                            "` = " color))
              (-hcap-choose-scope node-type face-name lang mode)))))))

(define (-hcap-prompt-face node-type lang mode)
  "Prompt for the face name, then continue the flow."
  (minibuffer-read
    (str "Face for `" node-type "` (existing or new name): ")
    (lambda (name)
      (cond
        ((nil? name) nil)
        ((= (string-length name) 0) (println "no face name given"))
        (else
          (-hcap-with-face node-type (string->symbol name) lang mode))))))

(defcommand highlight-construct-at-point ()
  "Face the construct under the cursor in one step: name (or create +
   colour) a face, assign the construct's tree-sitter node type to it,
   pick a scope (this major mode, the default, or everywhere for the
   language), and apply it LIVE. The action companion to
   `describe-face-at-point` (C-h F); bound to `C-h C-f`."
  ;; Same render-side round-trip as describe-face-at-point: fetch the node at
  ;; point, then run the (server-side) face/rule flow.
  (with-tree-sitter-info
    (lambda (lang captures node)
      (cond
        ((nil? lang)
         (println "no tree-sitter language for this buffer"))
        ((nil? node)
         (println (str "no construct at point (" (number->string (point))
                       ") in this " lang " buffer")))
        (else
          (let ((node-type (get node :type ""))
                (mode (major-mode-name)))
            (if (= (string-length node-type) 0)
                (println "the construct at point has no node type")
                (-hcap-prompt-face node-type lang mode))))))))
