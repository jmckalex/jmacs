;;; sticky-notes.lisp — sticky notes overlaid on the buffer.
;;;
;;; A sticky note is a resizable rectangle drawn on top of the text,
;;; holding JMarkdown source whose rendered HTML is shown in the note.
;;; Notes are anchored into the document and scroll with it; they
;;; persist to a companion <file>.jmacs-metadata file.
;;;
;;; The notes themselves are managed by host primitives (note-create!,
;;; note-delete!, …). These commands are the keyboard surface, bound
;;; under the M-n prefix (see keymap.lisp). Notes are also fully
;;; scriptable: the primitives are ordinary Lisp procedures.

;; *jmarkdown-command* is a customisable setting (see custom.lisp): the
;; shell command that renders a note's JMarkdown source to HTML — jmacs
;; feeds the source on stdin and shows the command's stdout. Change it
;; through the customisation UI, or directly, e.g.
;;   (custom-apply! '*jmarkdown-command* "pandoc -f markdown -t html")
(defgroup 'sticky-notes 'jmacs "Sticky notes overlaid on the buffer.")

(defcustom *jmarkdown-command* "multimarkdown -s" :string
  :group 'sticky-notes
  :doc "Shell command that renders a sticky note's JMarkdown source to HTML; the source is fed on stdin, the HTML read from the command's stdout.")

(define (add-sticky-note)
  "Create a sticky note at the cursor and open it for editing."
  (note-edit! (note-create!)))

(define (edit-sticky-note)
  "Edit the sticky note nearest the cursor."
  (let ((id (note-at-point)))
    (if (nil? id)
        (println "No sticky note near the cursor.")
        (note-edit! id))))

(define (delete-sticky-note)
  "Delete the sticky note nearest the cursor."
  (let ((id (note-at-point)))
    (if (nil? id)
        (println "No sticky note near the cursor.")
        (note-delete! id))))

(define (next-sticky-note)
  "Move the cursor to the next sticky note in the buffer."
  (note-next!))

(define (previous-sticky-note)
  "Move the cursor to the previous sticky note in the buffer."
  (note-prev!))

(define (toggle-sticky-notes)
  "Show or hide every sticky note in the buffer."
  (notes-toggle!))
