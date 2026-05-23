;;; python.lisp — the Python major mode.

(defcommand python-insert-pass ()
  "Insert a `pass` statement on its own line."
  (let ((p (point)))
    (goto! (line-start))
    (insert! "pass\n")
    (goto! (+ p (string-length "pass\n")))))

(defcommand python-insert-self-dot ()
  "Insert `self.` (the common method-body opener)."
  (insert! "self."))

(defcommand python-insert-print ()
  "Insert `print()` with the cursor between the parentheses."
  (insert! "print()")
  (goto! (- (point) 1)))

(defcommand python-fstring ()
  "Wrap the selection in an f-string (f\"…\"), or insert f\"…\" with
   the cursor inside."
  (if (region-active?)
      (let ((text (region-text)))
        (delete-backward!)
        (insert! (str "f\"" text "\"")))
      (begin
        (insert! "f\"\"")
        (goto! (- (point) 1)))))

(defcommand python-shebang ()
  "Insert the standard Python shebang at the start of the buffer."
  (let ((p (point)))
    (goto! 0)
    (insert! "#!/usr/bin/env python3\n")
    (goto! (+ p (string-length "#!/usr/bin/env python3\n")))))

(define python-c-c-map
  {"p" 'python-insert-print
   "f" 'python-fstring
   "s" 'python-insert-self-dot
   "#" 'python-shebang
   "/" 'python-insert-pass})

(define python-mode-map {"C-c" python-c-c-map})

(define-mode python-mode
  :name "Python"
  :comment-prefix "# "
  :keymap 'python-mode-map
  :highlight :python)

(register-mode ".py" python-mode)
