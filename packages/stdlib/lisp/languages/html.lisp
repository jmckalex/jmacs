;;; html.lisp — the HTML major mode.

(define (html-surround opener closer)
  "Wrap the selection in OPENER and CLOSER, or — with no selection —
   insert the pair and place the cursor between them."
  (if (region-active?)
      (let ((text (region-text)))
        (delete-backward!)
        (insert! (str opener text closer)))
      (begin
        (insert! (str opener closer))
        (goto! (- (point) (string-length closer))))))

(define (html-insert-at-line-start text)
  "Insert TEXT at the start of the current line."
  (let ((p (point)))
    (goto! (line-start))
    (insert! text)
    (goto! (+ p (string-length text)))))

(defcommand html-bold ()
  "Wrap the selection in <strong>…</strong>."
  (html-surround "<strong>" "</strong>"))

(defcommand html-italic ()
  "Wrap the selection in <em>…</em>."
  (html-surround "<em>" "</em>"))

(defcommand html-code ()
  "Wrap the selection in <code>…</code>."
  (html-surround "<code>" "</code>"))

(defcommand html-link ()
  "Wrap the selection in an <a href=''>…</a> with the cursor in the href."
  (if (region-active?)
      (let ((text (region-text)))
        (delete-backward!)
        (insert! (str "<a href=\"\">" text "</a>"))
        (goto! (- (point) (string-length text) (string-length "\"></a>"))))
      (begin
        (insert! "<a href=\"\"></a>")
        (goto! (- (point) (string-length "\"></a>"))))))

(defcommand html-paragraph ()
  "Wrap the selection in <p>…</p> on its own lines."
  (html-surround "<p>" "</p>"))

(defcommand html-heading-1 () "Wrap the selection in <h1>…</h1>." (html-surround "<h1>" "</h1>"))
(defcommand html-heading-2 () "Wrap the selection in <h2>…</h2>." (html-surround "<h2>" "</h2>"))
(defcommand html-heading-3 () "Wrap the selection in <h3>…</h3>." (html-surround "<h3>" "</h3>"))
(defcommand html-comment-line ()
  "Wrap the selection (or the rest of the line) in an <!-- … --> comment."
  (html-surround "<!-- " " -->"))

(define html-c-c-map
  {"b" 'html-bold
   "i" 'html-italic
   "c" 'html-code
   "l" 'html-link
   "p" 'html-paragraph
   "/" 'html-comment-line
   "1" 'html-heading-1
   "2" 'html-heading-2
   "3" 'html-heading-3})

(define html-mode-map {"C-c" html-c-c-map})

(define-mode html-mode
  :name "HTML"
  :keymap 'html-mode-map
  :highlight :html)

(register-mode ".html" html-mode)
(register-mode ".htm"  html-mode)
