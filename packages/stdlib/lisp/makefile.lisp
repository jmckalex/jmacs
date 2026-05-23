;;; makefile.lisp — Makefile editing commands. Loaded after modes.lisp
;;; and keymap.lisp; it fills in makefile-mode-map.

(defcommand makefile-target ()
  "Insert a target stub: a name, deps and a tab-indented recipe."
  (insert! "target: deps\n\trecipe\n")
  ;; Place the cursor on the target name for a quick rename.
  (goto! (- (point) (string-length "target: deps\n\trecipe\n")))
  (let ((end (+ (point) (string-length "target"))))
    (set-mark! (point))
    (goto! end)))

(defcommand makefile-phony ()
  "Insert a .PHONY declaration."
  (insert! ".PHONY: ")
  (let ((p (point)))
    (insert! "\n")
    (goto! p)))

(defcommand makefile-variable ()
  "Insert a variable assignment stub."
  (insert! "VAR := value\n")
  (goto! (- (point) (string-length "VAR := value\n")))
  (let ((end (+ (point) (string-length "VAR"))))
    (set-mark! (point))
    (goto! end)))

(defcommand makefile-tab ()
  "Insert a literal tab — recipes must be tab-indented."
  (insert! "\t"))

(defcommand makefile-include ()
  "Insert an include directive."
  (insert! "include "))

(define makefile-c-c-map
  {"t" 'makefile-target
   "p" 'makefile-phony
   "v" 'makefile-variable
   "i" 'makefile-include
   "TAB" 'makefile-tab})

(set! makefile-mode-map {"C-c" makefile-c-c-map})
