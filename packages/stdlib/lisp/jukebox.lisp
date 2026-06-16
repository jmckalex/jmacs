;;; jukebox.lisp — open a jukebox view for a directory.
;;;
;;; The jukebox lives in Layer 4 (see packages/renderer/src/jukebox-view.js):
;;; cover art, an <audio> element, a real <ol> track list. This file is
;;; the thin Lisp surface — a single command, plus the host hand-off
;;; for the directory picker. The view owns playback state; the host
;;; primitive `open-jukebox-buffer!` creates the buffer and switches
;;; to it.
;;;
;;; The old jukebox was a text-buffer mode that re-painted an ASCII
;;; panel after every command. That fought the editor for SPC/RET and
;;; smuggled paint code through buffer text — see docs/CUSTOM-VIEWS.md
;;; for the post-mortem. The contents that file used to hold — track
;;; rendering, panel layout, the panel keymap, the shuffle helpers —
;;; are gone; their job moved into the view.

(define (jukebox . args)
  "Open a jukebox for a directory full of audio files.

   With no argument, opens the directory picker. With a path argument,
   opens that directory directly. The buffer that appears is shown
   through the L4 jukebox view (not the text editor view); use SPC to
   play/pause, RET to play the focused track, n/p to step, s for
   shuffle, R to randomise, g to refresh, q to quit, and M-RET to open
   the album-art file as an image buffer."
  (if (nil? args)
      (prompt-directory!)
      (open-jukebox-buffer! (car args))))

(define (jukebox-on-directory-chosen path)
  "Called by the host when the user picks a directory from the
   directory-picker dialog. Bridges the dialog's callback into the
   `open-jukebox-buffer!` primitive."
  (open-jukebox-buffer! path))

;;; --- track display formatting --------------------------------------------
;;; The jukebox view shows one row per audio file. By default that row
;;; reads `"Title", Artist, Album` — pulled from the file's embedded
;;; tags via the (audio-metadata path) primitive. The format is a
;;; template string with `{placeholders}` the user can customise:
;;;   {title}    {artist}   {album}    {track}
;;;   {year}     {genre}    {filename} (the bare filename, no extension)
;;; Missing fields render as the empty string; an untagged or
;;; unsupported file falls back to the bare filename.

(defgroup 'jukebox 'godot "Jukebox view: how audio files are listed.")

(defcustom *jukebox-track-format* "\"{title}\", {artist}, {album}" :string
  :group 'jukebox
  :on-change (lambda (name value) (refresh-jukebox-labels!))
  :doc "Template used by `format-track` to render each row in a jukebox
   buffer. Supported placeholders, in `{braces}`:
       {title}    the song title
       {artist}   the performing artist
       {album}    the album name
       {track}    the track number
       {year}     the release year
       {genre}    the genre
       {filename} the bare filename without its extension
   Missing fields render as the empty string. A file with no usable
   metadata (no ID3 tag, unsupported container, …) falls back to its
   bare filename regardless of the template.")

(define (-jukebox-basename path)
  "The bare filename component of PATH (everything after the last `/`)."
  (let ((parts (string-split path "/")))
    (car (reverse parts))))

(define (-jukebox-drop-last items)
  "ITEMS without its final element. Used to strip the suffix from a
   dotted-split filename."
  (cond ((nil? items) (list))
        ((nil? (cdr items)) (list))
        (else (cons (car items) (-jukebox-drop-last (cdr items))))))

(define (-jukebox-join-with parts separator)
  "Concatenate PARTS, interleaving SEPARATOR between adjacent
   elements. `'(\"a\" \"b\" \"c\") \".\"` → `\"a.b.c\"`."
  (cond ((nil? parts) "")
        ((nil? (cdr parts)) (car parts))
        (else
         (string-append (car parts) separator
                        (-jukebox-join-with (cdr parts) separator)))))

(define (-jukebox-strip-suffix name)
  "NAME without its trailing dotted suffix, if any. `foo.mp3` → `foo`,
   `weird.name.flac` → `weird.name`, `noext` → `noext`."
  (let ((parts (string-split name ".")))
    (if (< (length parts) 2)
        name
        (-jukebox-join-with (-jukebox-drop-last parts) "."))))

(define (-jukebox-field meta key)
  "Render the value of METADATA at KEY for the template — nil and
   non-strings come out as the empty string."
  (let ((value (get meta key nil)))
    (cond ((nil? value) "")
          ((string? value) value)
          (else (str value)))))

(define (-jukebox-apply-template template meta filename-stem)
  "Substitute every {placeholder} in TEMPLATE with the matching field
   from METADATA (or the filename stem for {filename}). Sequential
   rewrites — each builds on the prior. Plain and readable beats fancy
   here."
  (let* ((s template)
         (s (string-template-replace s "{title}"
                                     (-jukebox-field meta :title)))
         (s (string-template-replace s "{artist}"
                                     (-jukebox-field meta :artist)))
         (s (string-template-replace s "{album}"
                                     (-jukebox-field meta :album)))
         (s (string-template-replace s "{track}"
                                     (-jukebox-field meta :track)))
         (s (string-template-replace s "{year}"
                                     (-jukebox-field meta :year)))
         (s (string-template-replace s "{genre}"
                                     (-jukebox-field meta :genre)))
         (s (string-template-replace s "{filename}" filename-stem)))
    s))

(define (string-template-replace text needle replacement)
  "Replace every occurrence of NEEDLE in TEXT with REPLACEMENT.
   A non-string REPLACEMENT is rendered via (str …)."
  (let ((parts (string-split text needle))
        (rep (if (string? replacement) replacement (str replacement))))
    (-jukebox-join-with parts rep)))

(define (-jukebox-meta-usable? meta)
  "True when METADATA carries at least a title or an artist — the
   bare minimum that makes a formatted row more useful than the
   filename."
  (and (not (nil? meta))
       (or (and (string? (get meta :title nil))
                (not (equal? (get meta :title nil) "")))
           (and (string? (get meta :artist nil))
                (not (equal? (get meta :artist nil) ""))))))

(define (format-track path)
  "The display string for the jukebox row at PATH. Reads the file's
   embedded tag metadata and substitutes it into the
   `*jukebox-track-format*` template. Falls back to the bare filename
   (without extension) when the metadata is missing or unusable."
  (let* ((filename (-jukebox-basename path))
         (stem (-jukebox-strip-suffix filename))
         (meta (audio-metadata path)))
    (if (-jukebox-meta-usable? meta)
        (-jukebox-apply-template *jukebox-track-format* meta stem)
        filename)))
