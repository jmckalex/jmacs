;;; views.lisp — commands for working with the open views.
;;;
;;; The editor holds a list of views with one current. A text-editing
;;; view contains an L2 buffer; image / shell / jukebox / directory-
;;; tree / etc. views hold their own state. Commands here wrap the
;;; host primitives that change which view is current and re-mount the
;;; matching renderer view.

;; --- settings ----------------------------------------------------------

(defgroup 'views 'jmacs "Open views: persistence and switching.")

;; PDF views are ephemeral by default — a transient texdoc / consult doc
;; the user opened to read, gone on relaunch. Set this to #t to make
;; every freshly-opened PDF persist across a relaunch instead. (latex-
;; view marks its own output PDF persistent regardless, via
;; *latex-pdf-restore*; this is the global default for all other PDFs.)
;; The host's pdf-view creation path reads this when minting the view.
(defcustom *pdf-restore-default* #t :boolean
  :group 'views
  :doc "Whether a freshly-opened PDF view persists across a relaunch by
   default. #t (the default) restores every PDF on startup; set #f to keep
   generic / texdoc PDFs transient. latex-view's output PDF persists
   regardless (see *latex-pdf-restore*); use `toggle-pdf-persistent` to flip
   any one PDF's setting by hand.")

(defcommand next-view ()
  "Switch to the next view in the list."
  (next-view!))

(defcommand previous-view ()
  "Switch to the previous view in the list."
  (previous-view!))

(defcommand new-view ()
  "Create a fresh empty text view and switch to it."
  (new-view!))

(defcommand switch-view ()
  "Switch to a view chosen by name, with completion."
  (start-buffer-switcher!))

(defcommand kill-view ()
  "Remove the current view from the list and switch to the next one.
   Killing the last view creates a fresh empty `*scratch*` text view
   so the list is never empty. Bound to `C-x k`."
  (kill-view!))

(defcommand toggle-pdf-persistent ()
  "Flip whether the current PDF view survives a relaunch, echoing the
   new state. Use it to keep a PDF the editor would otherwise drop (a
   useful texdoc page) or to drop one it would keep. A no-op with a
   status note when the current view is not a PDF."
  (let ((v (current-view)))
    (if (and (not (nil? v)) (equal? (view-kind v) "pdf"))
        (let ((now (not (view-persistent? v))))
          (set-view-persistent! v now)
          (show-status!
           (str (view-name-of v) ": "
                (if now "will be restored on relaunch"
                    "will NOT be restored on relaunch"))))
        (show-status! "toggle-pdf-persistent: current view is not a PDF"))))
