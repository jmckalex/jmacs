;;; auto-pair.lisp — automatic insertion of matching brackets and quotes.
;;;
;;; Typing an opening bracket or quote inserts its closing partner too,
;;; leaving the cursor between the pair. Typing a closing bracket when
;;; the next character already is that bracket steps the cursor past it
;;; rather than inserting a duplicate (the same for a quote against its
;;; own kind). Backspace between an empty pair deletes both characters.
;;;
;;; The whole behaviour is gated by the *auto-pair* setting; with it off
;;; the keys self-insert exactly as before.
;;;
;;; Loaded after keymap.lisp (it binds keys in the-keymap) and after
;;; custom.lisp (it declares a defcustom).

;; --- the setting -------------------------------------------------------

(defcustom *auto-pair* #t :boolean
  :group 'godot
  :doc "Insert the matching bracket or quote when an opener is typed.")

;; --- the pair table ----------------------------------------------------
;; opener -> closer. Quotes pair with themselves.
(define *auto-pairs*
  {"(" ")"
   "[" "]"
   "{" "}"
   "\"" "\""
   "`" "`"})

;; The closing characters, mapped to themselves. Used to recognise a
;; closing key and — for non-quote closers — to know it is a closer.
(define *auto-pair-closers*
  {")" ")"
   "]" "]"
   "}" "}"})

;; --- helpers -----------------------------------------------------------

(define (char-after)
  "The single character just after the cursor, or nil at buffer end."
  (let ((p (point)))
    (if (< p (buffer-length))
        (buffer-substring p (+ p 1))
        nil)))

(define (char-before)
  "The single character just before the cursor, or nil at buffer start."
  (let ((p (point)))
    (if (> p 0)
        (buffer-substring (- p 1) p)
        nil)))

(define (insert-pair! opener closer)
  "Insert OPENER and CLOSER, leaving the cursor between them."
  (insert! (str opener closer))
  (goto! (- (point) (string-length closer))))

(define (skip-over! ch)
  "Step the cursor one character past CH (the next character)."
  (goto! (+ (point) (string-length ch))))

;; --- opener insertion --------------------------------------------------

(define (auto-pair-open opener)
  "Handle a typed OPENER: with auto-pairing on insert the matching
   pair; with it off just self-insert the opener."
  (let ((closer (get *auto-pairs* opener nil)))
    (cond
      ;; Auto-pairing off, or an unknown opener: plain self-insert.
      ((or (not *auto-pair*) (nil? closer))
       (insert! opener))
      ;; A quote already in front of the cursor: step past it instead
      ;; of inserting a duplicate (the closing-quote case — a quote is
      ;; both opener and closer).
      ((and (equal? opener closer) (equal? (char-after) closer))
       (skip-over! closer))
      ;; Otherwise insert the pair, cursor between.
      (else
       (insert-pair! opener closer)))))

;; --- closer insertion --------------------------------------------------

(define (auto-pair-close closer)
  "Handle a typed CLOSER: with auto-pairing on, step past an existing
   matching closer rather than inserting a duplicate; otherwise (or
   with auto-pairing off) self-insert."
  (cond
    ((and *auto-pair* (equal? (char-after) closer))
     (skip-over! closer))
    (else
     (insert! closer))))

;; --- the bracket / quote commands --------------------------------------
;; Each is a defcommand so it is M-x-visible and rebindable; the keymap
;; binds the character to it, so the key no longer self-inserts.

(defcommand auto-pair-open-paren ()
  "Insert ( and its matching ) (or self-insert when off)."
  (auto-pair-open "("))

(defcommand auto-pair-open-bracket ()
  "Insert [ and its matching ] (or self-insert when off)."
  (auto-pair-open "["))

(defcommand auto-pair-open-brace ()
  "Insert { and its matching } (or self-insert when off)."
  (auto-pair-open "{"))

(defcommand auto-pair-quote ()
  "Insert a \" pair, or step past a closing \" (or self-insert when off)."
  (auto-pair-open "\""))

(defcommand auto-pair-backtick ()
  "Insert a ` pair, or step past a closing ` (or self-insert when off)."
  (auto-pair-open "`"))

(defcommand auto-pair-close-paren ()
  "Insert ) or step past an existing ) (or self-insert when off)."
  (auto-pair-close ")"))

(defcommand auto-pair-close-bracket ()
  "Insert ] or step past an existing ] (or self-insert when off)."
  (auto-pair-close "]"))

(defcommand auto-pair-close-brace ()
  "Insert } or step past an existing } (or self-insert when off)."
  (auto-pair-close "}"))

;; --- backspace between an empty pair -----------------------------------
;; Redefine delete-backward so that, with auto-pairing on and the cursor
;; sitting between a freshly-typed empty pair, one backspace removes both
;; characters. Every other case falls through to the ordinary behaviour.

(define (between-empty-pair?)
  "True when the cursor sits between an opener and its matching closer
   (e.g. \"()\" with the cursor in the middle)."
  (let ((before (char-before)))
    (and (not (nil? before))
         (let ((closer (get *auto-pairs* before nil)))
           (and (not (nil? closer))
                (equal? (char-after) closer))))))

(defcommand delete-backward ()
  "Delete the character before the cursor (or the selection). With
   auto-pairing on, a backspace between an empty pair deletes both
   the opener and its closer."
  (if (and *auto-pair* (between-empty-pair?))
      (delete-region! (- (point) 1) (+ (point) 1))
      (delete-backward!)))

;; --- key bindings ------------------------------------------------------
;; Bind the bracket and quote characters to their commands in the global
;; keymap. handle-key resolves a bound symbol before it would otherwise
;; self-insert a printable character, so this is how a typed "(" is
;; intercepted. A mode keymap can still shadow these bindings.

(set! the-keymap (assoc the-keymap "(" 'auto-pair-open-paren))
(set! the-keymap (assoc the-keymap "[" 'auto-pair-open-bracket))
(set! the-keymap (assoc the-keymap "{" 'auto-pair-open-brace))
(set! the-keymap (assoc the-keymap "\"" 'auto-pair-quote))
(set! the-keymap (assoc the-keymap "`" 'auto-pair-backtick))
(set! the-keymap (assoc the-keymap ")" 'auto-pair-close-paren))
(set! the-keymap (assoc the-keymap "]" 'auto-pair-close-bracket))
(set! the-keymap (assoc the-keymap "}" 'auto-pair-close-brace))
