;;; sticky-notes.lisp — sticky notes overlaid on the buffer.
;;;
;;; A sticky note is a resizable rectangle drawn on top of the text,
;;; holding JMarkdown source whose rendered HTML is shown in the note.
;;; Notes are anchored into the document and scroll with it; they
;;; persist to a hidden companion .<file>.godot-metadata file.
;;;
;;; The notes themselves are managed by host primitives (note-create!,
;;; note-delete!, …). These commands are the keyboard surface, bound
;;; under the M-n prefix (see keymap.lisp). Notes are also fully
;;; scriptable: the primitives are ordinary Lisp procedures.

;; *markdown-interpreter* is a customisable setting (see custom.lisp):
;; the Markdown renderer used for both sticky notes and the live
;; docstring path in the documentation viewer. The default is "marked"
;; — the bundled marked.js library, a known-working CommonMark+GFM
;; renderer that requires no external programs. Any other string is
;; treated as a shell command: Godot feeds the source on stdin and
;; shows the command's stdout (the original integration path, kept
;; for users who want JMarkdown or pandoc features). Change it
;; through the customisation UI, or directly:
;;   (custom-apply! '*markdown-interpreter* "pandoc -f markdown -t html")
(defgroup 'sticky-notes 'godot "Sticky notes overlaid on the buffer.")

(defcustom *markdown-interpreter* "marked" :string
  :group 'sticky-notes
  :doc "Markdown renderer for sticky notes and live docstrings. \"marked\" selects the bundled marked.js library; any other string is a shell command that reads Markdown on stdin and prints HTML on stdout.")

(defcommand add-sticky-note ()
  "Create a sticky note at the cursor and open it for editing."
  (note-edit! (note-create!)))

(defcommand edit-sticky-note ()
  "Edit the sticky note nearest the cursor."
  (let ((id (note-at-point)))
    (if (nil? id)
        (println "No sticky note near the cursor.")
        (note-edit! id))))

(defcommand delete-sticky-note ()
  "Delete the sticky note nearest the cursor."
  (let ((id (note-at-point)))
    (if (nil? id)
        (println "No sticky note near the cursor.")
        (note-delete! id))))

(defcommand next-sticky-note ()
  "Move the cursor to the next sticky note in the buffer."
  (note-next!))

(defcommand previous-sticky-note ()
  "Move the cursor to the previous sticky note in the buffer."
  (note-prev!))

(defcommand toggle-sticky-notes ()
  "Show or hide every sticky note in the buffer."
  (notes-toggle!))
