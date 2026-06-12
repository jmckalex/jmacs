## Editing Text from Lisp

This is the chapter where the Lisp meets the document. The preceding
chapters treat the language on its own terms; from here on it has
something to talk about — the buffer in front of you. Everything below
is runnable as you read it: open the REPL with `C-x p` (or evaluate
forms in place with `C-x C-e`) and each example acts on the visible
document, the same loop the editor's own standard library was written
in.

> *The buffer primitives operate on the current buffer, so a form you
> evaluate in the REPL edits the document you are looking at.*

### Buffers, Views, and the Current Buffer

A *buffer* holds text and its editing state — the cursor, the mark, the
major and minor modes, the undo history. A *view* is the on-screen
presentation of a buffer: the addressable thing with a name in the
modeline and a place in a pane. The user-manual chapter *Views* lays
out the full model.

The primitives in this chapter are *host primitives*: procedures the
desktop application registers into the Lisp when it boots. They take no
buffer argument — every one resolves "the buffer" through the focused
pane. There is no `with-current-buffer`, no way to address a buffer you
are not looking at. What you evaluate is what you see.

One naming note for readers of older material: the old spec's
`buffer-name` is now `view-name` — names belong to the on-screen thing.
`(view-name)` returns the current view's modeline label;
`(set-view-name! s)` renames it.

This chapter teaches the working subset — enough to write real editing
commands. The complete catalog, one page per primitive, is the
<a href="nodes/jmacs-buffer--host-primitives.html" data-jmacs-doc="jmacs-buffer--host-primitives">Buffer &amp; Host Primitives</a>
reference book.

### Point, the Mark, and Moving Around

Positions in a buffer are *offsets*: 0-based character counts from the
top, with a newline counting as one character. Offset 0 is before the
first character; `(buffer-length)` is after the last. The cursor's
offset is the *point*.

```lisp
(point)            ; ⇒ 1042 — the cursor's offset
(buffer-length)    ; ⇒ 5630 — the buffer's size in characters
(goto! 0)          ; ⇒ nil — point is now at the top of the buffer
```

`(goto! n)` moves point to offset `n` and returns `nil` — like nearly
every mutating primitive, it is evaluated for its effect, not its
value. Offsets are the native coordinate, but lines are often the
natural one. The line primitives all describe the line point is on:

```lisp
(line-start)       ; ⇒ 1031 — offset where the cursor's line begins
(line-end)         ; ⇒ 1100 — offset of its end, before the newline
(line-indent)      ; ⇒ "  " — the line's leading whitespace, as a string
(buffer-line-count); ⇒ 184
(point-line-col)   ; ⇒ (14 . 12) — 1-based (line . column) pair
(goto-line! 14)    ; ⇒ nil — jump to the start of line 14 (1-based)
```

Note the convention split: offsets are 0-based, but `point-line-col` and
`goto-line!` speak the 1-based line numbers the status bar shows.
Motion by unit comes as a pair of layers: `word-forward-offset`,
`word-backward-offset`, `sentence-forward-offset`, and
`sentence-backward-offset` are *pure* — each returns the offset such a
motion would reach, without moving anything. Moving is then your
decision: `(goto! (word-forward-offset))` steps point over a word.

The *mark* is the buffer's second remembered position, and the *region*
is the stretch between mark and point. `(set-mark!)` anchors the mark
at point (give it an offset to anchor elsewhere); once the mark is set,
every motion — including `goto!` — extends the region rather than
abandoning it.

```lisp
(set-mark!)              ; ⇒ nil — anchor a region at point
(goto! (+ (point) 5))    ; point moves; the region now covers 5 characters
(region-active?)         ; ⇒ #t
(region-text)            ; ⇒ "lemma" — the region's text ("" when none)
(clear-mark!)            ; ⇒ nil — deactivate the region
```

Mark and point come in either order, so code that needs the region's
bounds normalises them — `(min (mark) (point))` and
`(max (mark) (point))`, guarded by `(region-active?)` since `(mark)`
is `nil` when unset. This is exactly the computation a command's
`(interactive region)` clause performs on your behalf.

### Reading the Buffer's Text

Three primitives read text without touching it. `(buffer-text)` returns
the whole buffer as one string. `(buffer-substring a b)` returns the
half-open range `[a, b)` — start inclusive, end exclusive, the same
convention as every range in this chapter. `(region-text)` you have
already met. The current line is just a substring of the line bounds,
`(buffer-substring (line-start) (line-end))` — an idiom common enough
that the standard library names it: `line-ops.lisp` defines
`current-line-text`, along with `line-column` (point's offset within
its line), `first-line?`, and `last-line?` — ordinary Lisp functions,
not primitives.

Reading plus the string library is enough for analysis. A word counter
for the region — split on spaces line by line, discarding the empty
strings a double space produces:

```lisp
(define (count-words s)
  "How many space-separated words S contains."
  (reduce + 0
          (map (lambda (line)
                 (length (filter (lambda (w) (not (equal? w "")))
                                 (string-split line " "))))
               (string-split s "\n"))))

(count-words (region-text))   ; ⇒ 42, with a region active
```

### Inserting and Deleting Text

`(insert! s)` inserts the string `s` at point; point ends up after the
inserted text. `(delete-backward!)` and `(delete-forward!)` delete one
character to either side of point — except when a region is active, in
which case either deletes the region; the standard library leans on
that, spelling "delete the selection" as `(delete-backward!)`.
`(delete-region! a b)` deletes the range between two offsets, in either
order, and leaves point at its start. All of them return `nil`.

Two more, for bigger surgery: `(replace-range! a b s)` swaps the range
`[a, b)` for the string `s` in one call, and `(set-buffer-text! s)`
replaces the entire buffer.

The canonical small editing function is the standard library's
`surround` (`markdown.lisp`) — every Markdown formatting command,
`markdown-bold` to `markdown-code`, is one call to it:

```lisp
(define (surround opener closer)
  "Wrap the selection in OPENER and CLOSER, or — with no selection —
   insert the pair and place the cursor between them."
  (if (region-active?)
      (let ((text (region-text)))
        (atomic-change-group
          (delete-backward!)
          (insert! (str opener text closer))))
      (begin
        (insert! (str opener closer))
        (goto! (- (point) (string-length closer))))))
```

Read the region branch: capture the text, delete the selection, insert
the wrapped version. Read–delete–insert is *the* shape of a
transforming edit. A second example, transforming the current line:

```lisp
(defcommand upcase-line ()
  "Replace the current line with its upper-case self."
  (let ((start (line-start))
        (text  (current-line-text))
        (col   (line-column)))
    (delete-region! start (line-end))
    (insert! (string-upcase text))
    (goto! (+ start col))))
```

This works — but press `C-z` afterwards and undo takes two steps: the
insertion comes back out, then the deletion. The fix is the next
section, and the `atomic-change-group` already sitting in `surround`.

### One Undo Step: atomic-change-group

A command that edits the buffer more than once should undo as one step:
the user pressed one key, so "undo" should mean "that didn't happen",
not "rewind my command edit by edit". The wrapper is a macro from
`editing.lisp`:

```lisp
(atomic-change-group body…)
```

Every buffer edit made while the body runs — however many, through
whatever functions — lands on the undo stack as a single entry, and the
body's value is returned. The group is closed even when the body raises
an error: the edits made before the failure still form one undo step,
and the error propagates on to the caller.

The rule of thumb is simple: **any command that makes more than one
buffer mutation wraps them in `atomic-change-group`.** The standard
library follows it everywhere — `surround` above, `join-line`,
`indent-region`, the JMarkdown block templates. Here it is in
`line-ops.lisp`, inside `move-line-up` (comments trimmed):

```lisp
      (atomic-change-group
        ;; Remove the line and the newline that precedes it.
        (delete-region! (- start 1) end)
        (let ((above (line-start)))
          (goto! above)
          (insert! (str text "\n"))
          (goto! (+ above col))))
```

The repaired `upcase-line` is the same function with its
`delete-region!` and `insert!` wrapped in exactly this way.

Under the macro sit two host primitives, `begin-change-group!` and
`end-change-group!`; call the macro, not the pair — it is what closes
the group on error. The grouping is re-entrant (nested groups fold into
the outermost one), an empty group records nothing, and `undo!` and
`redo!` are deliberately no-ops while a group is open. The
`fill-paragraph!` primitive groups its own delete-and-insert
internally, so `M-q` already undoes atomically.

### Searching and Replacing from Lisp

The interactive search on `C-s` is a host-driven loop — the
`start-search!` family of primitives opens it for the user but returns
nothing useful to Lisp. Programmable searching is three pure matchers,
each returning a `(start . end)` pair of offsets or `nil` for no match:

```lisp
(find-string-forward "TODO" 0)          ; ⇒ (210 . 214) — first literal match
(find-regexp-forward "TODO|FIXME" (point))   ; first match at or after point
(find-regexp-backward "[0-9]+" (point))      ; last match before point
```

The pattern syntax is JavaScript's regular-expression dialect; an
invalid pattern yields `nil` rather than an error. Remember that the
Lisp reader has its own escapes, so a pattern's backslash is written
doubled: `"\\d+"`. Walking matches is ordinary recursion — search, act,
search again from the match's end:

```lisp
(define (goto-next-todo)
  "Move point to the next TODO after it, if any."
  (let ((hit (find-string-forward "TODO" (point))))
    (when (not (nil? hit))
      (goto! (car hit)))))
```

Wholesale replacement has dedicated primitives. `(replace-all! from to)`
replaces every literal occurrence in the buffer and echoes a count to
the REPL. `(replace-regexp-all! pat repl)` does the same for a regexp —
the replacement honours `$1`…`$N`, `$&`, and `$$` — and returns the
number of replacements, or `-1` for an invalid pattern:

```lisp
(replace-regexp-all! "(\\d+)px" "$1 px")   ; ⇒ 7 — replacements made
```

The surgical one you have already met: `replace-range!`, which is how
the interactive `query-replace` swaps in each confirmed match. Indeed
`occur` and `query-replace` are ordinary Lisp built on exactly these
primitives — `occur.lisp` and `regex-search.lisp` are worth reading
whole. (And since `(buffer-text)` is just a string, the core string
library — `string-index-of`, `string-contains?` — is often the shorter
spelling for a one-off check.)

### What the Lisp Does Not Expose

Readers arriving from Emacs Lisp will reach for three things that are
not here. Stating this plainly saves you an evening.

**There is no `save-excursion`.** The idiom — used throughout the
standard library — is to capture point and restore it yourself:
`(let ((p (point))) … (goto! p))`. If the middle might fail, restore in
both arms of a `try` (the form is covered in *Errors and Error
Handling*):

```lisp
(let ((p (point)))
  (try
    (begin (risky-edit) (goto! p))
    (catch err
      (goto! p)
      (error (get err :message)))))
```

Be aware of what the idiom does not give you: `p` is a plain number, so
if the body inserts or deletes text *before* that offset, the restored
point lands in shifted text. Which leads to the second gap —

**there is no Lisp-level marker or overlay API.** Markers (positions
that ride along under edits) and overlays (ranges with metadata) exist
in the editor's host layer — bookmarks, snippet fields, and the inline
eval pills are built on them — but Lisp code cannot create one today.
Features that need a durable position reach them through their own
primitives, such as `bookmark-set!`.

**There is no buffer targeting.** Every primitive acts on the current
buffer; nothing lets a function address another buffer behind the
scenes.

### Files and Saving from Lisp

The file surface splits, as it so often does in jmacs, into commands
that carry the policy and primitives that do the work.

Opening: `C-x C-f` runs cmd(find-file), a Lisp command in `files.lisp`
that prompts with TAB completion, seeding the prompt with the directory
of the file the current buffer is visiting (falling back to your home
directory). A path that names no existing file opens an empty buffer
visiting it; the file is created on first save — the `find-file-new!`
primitive. Programmatic opening skips the prompt:
`(open-file-path! "/etc/hosts")`. To read a file *without* visiting it,
`(read-file-text! path)` returns its contents as a string (`nil` on
failure), with `(file-exists? path)` answering the obvious question.

Saving: `C-x C-s` runs cmd(save-buffer), a one-line command wrapping the
`save-buffer!` primitive, which writes the current buffer to its file.
`(view-modified?)` reports whether the current buffer has unsaved
changes — the same dirty flag the modeline dot and the quit guard read.

Closing shows the command/primitive split at its clearest. The
`kill-view!` primitive destroys the current view, unconditionally. The
`kill-view` *command* (`C-x k`) first asks `(view-modified?)` and, when
the buffer is dirty, demands a `y` before it will call the primitive.
The primitive does the work; the command owns the policy. Write your
own automation against whichever layer you mean. Sessions, autosave,
and recovery are user-manual territory — see *Files and buffers*.

### A Complete Editing Function

The capstone assembles the chapter: read a region, transform it with
the string library, and write it back as one atomic edit. (There is no
`sort` in the core library, so the transformation here is reversing
the region's lines — the structure is identical for any line-wise
transform.)

```lisp
(define (reverse-region-lines start end)
  "Reverse the order of the lines in [START, END)."
  (let* ((text    (buffer-substring start end))
         (lines   (string-split text "\n"))
         (flipped (string-join (reverse lines) "\n")))
    (atomic-change-group
      (delete-region! start end)
      (insert! flipped)
      (goto! start))))
```

Walk it through. `buffer-substring` reads the range; `string-split`,
`reverse`, and `string-join` rebuild the flipped text. Then the edit:
`delete-region!` removes the old text and leaves point at `start`,
`insert!` puts the new text there, and the final `goto!` leaves point
at the top of the transformed region. The delete-and-insert pair is
wrapped in `atomic-change-group`, so one `C-z` restores the original.

Try it from the REPL: set the mark, move point down a few lines, then
evaluate
`(reverse-region-lines (min (mark) (point)) (max (mark) (point)))`.

What remains is to make it a first-class citizen: a named command that
gathers those bounds itself through an `(interactive region)` clause,
appears in `M-x`, and sits on a key of your choosing. That is the
subject of the next chapter, *Commands, Keymaps, and the Minibuffer*.
