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
modeline and a place in a pane. The user-manual chapter
<a href="nodes/views.html" data-godot-doc="views">Views</a> lays
out the full model.

The primitives in this chapter are *host primitives*: procedures the
editor's Lisp server — the spine — registers into the Lisp when it
boots. They take no buffer argument — every one resolves "the buffer"
through the focused pane. There is no `with-current-buffer`, no way to
address a buffer you are not looking at. What you evaluate is what you
see.

One naming note for readers of older material: the old spec's
`buffer-name` is now `view-name` — names belong to the on-screen thing.
`(view-name)` returns the current view's modeline label;
`(set-view-name! s)` renames it.

This chapter teaches the working subset — enough to write real editing
commands. The complete catalog, one page per primitive, is the
<a href="nodes/godot-buffer--host-primitives.html" data-godot-doc="godot-buffer--host-primitives">Buffer &amp; Host Primitives</a>
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
decision: `(goto! (word-forward-offset))` steps point over a word, and
`(goto! (sentence-forward-offset))` over a sentence — which is the
entire body of the cmd(forward-sentence) command on `M-e`, just as its
backward twin on `M-a` is one `goto!` around
`sentence-backward-offset`.

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
`(max (mark) (point))`, guarded by `(region-active?)`. When no mark is
set, `(mark)` returns `#f` — the miss convention, and this chapter's
own `#f`-versus-`nil` lesson in one primitive: offset 0 is a perfectly
good mark, so absence must be the one falsy value. A bare
`(when (mark) …)` is therefore a safe guard, while the tempting
`(when (not (nil? (mark))) …)` passes on the miss and hands `#f` to
your arithmetic. The normalisation is exactly the computation a
command's `(interactive region)` clause performs on your behalf.

One refinement to "the" cursor: a buffer can carry several. The
multi-cursor commands (`C-c d` cmd(add-cursor-next), `C-c D`
cmd(select-all-matches)) are ordinary Lisp in `multi-cursor.lisp`,
built on four primitives this chapter otherwise leaves alone:
`(add-selection! point mark?)` adds a cursor, `(selections)` returns
every cursor as a list of `(point . mark-or-nil)` pairs,
`(cursor-count)` counts them, and `(collapse-to-primary!)` drops back
to one. The reading primitives above — `point`, `mark`, `region-text`
— answer for the *primary* cursor; code that means all of them walks
`(selections)` itself.

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

Typing, incidentally, *is* `insert!`: a printable key with no binding
becomes an `(insert! key)` call in the dispatcher — and after that
insertion the dispatcher runs `*post-self-insert-hook*`, the seam
"electric" behaviours hang from (auto-fill-mode wraps the line there).
The hook fires on self-inserting *keystrokes*, not on programmatic
`insert!` calls, so your editing functions never trigger it by
accident. *Writing Modes and Hooks* covers registering one.

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
and the error propagates on to the caller. The guarantee covers even a
raw JavaScript exception from a faulting host primitive — the wrapper
is built on `try`'s `finally` clause, which runs on that path too (see
<a href="nodes/errors-and-error-handling.html" data-godot-doc="errors-and-error-handling">Errors and Error Handling</a>).

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
internally, so `M-q` already undoes atomically. (That primitive's fill
column is a host-side constant, 72. The fills that live in Lisp are
configurable: auto-fill-mode's wrap-as-you-type honours the
`*fill-column*` customization — default 70, `C-x f` to set — and the
mode-specific `M-q` replacements carry their own knobs.)

### The Kill Ring Is a List

Cut and paste is not a host service with an API — it is a Lisp list.
`kill.lisp` defines

```lisp
(define *kill-ring* (list))
```

and every kill command — cmd(kill-region) on `C-w`, cmd(kill-line) on
`C-k`, cmd(kill-word), the rest of the family — funnels its text
through one function, `kill-ring-add!`, which conses the string onto
that list and mirrors it out through the `clipboard-set-text!`
primitive. Reading the ring is `car` and `nth`; from the REPL,
`(car *kill-ring*)` is the text `C-y` would insert.

The interesting machinery is *kill accumulation*: consecutive kills
grow one ring entry rather than each pushing its own, so `C-k C-k C-y`
reinserts both lines. "Consecutive" is judged by `*last-command*` — the
dispatcher's record of the previous command, covered in *Commands,
Keymaps, and the Minibuffer* — and the same variable is how
cmd(yank-pop) (`M-y`) knows it directly follows a yank. cmd(yank)
itself first pulls the `clipboard-text` primitive's current value onto
the ring when it holds something new (paste from outside), then
inserts the ring's top and records where, so a following `M-y` can
swap the insertion for an older kill.

The two clipboard primitives — `(clipboard-set-text! s)` and
`(clipboard-text)` — are the system-integration seam: everything the
ring shares with the outside world passes through them. (In the
current server they are backed by an editor-local store: the ring
round-trips fully inside Godot, and the OS-clipboard bridge is the
seam's next occupant.) Because every kill funnels through
`kill-ring-add!`, redefining that one function observes — or rewrites
— the whole cut/copy family at once.

### Searching and Replacing from Lisp

Searching needs no special machinery: the incremental search on `C-s`
and `C-r` is itself ordinary Lisp — `search.lisp`, a state machine
over `read-next-key` that owns the keyboard until you exit — built on
the same pure matchers this section teaches. (Only the *regexp*
isearch starters, `C-M-s`/`C-M-r`, remain host stubs awaiting their
port.) Programmable searching is four pure matchers, each returning a
`(start . end)` pair of offsets or `#f` for no match (absence is `#f`,
so the result is safe as a bare test):

```lisp
(find-string-forward "TODO" 0)          ; ⇒ (210 . 214) — first literal match
(find-string-backward "TODO" (point))   ; last match starting at or before point
(find-regexp-forward "TODO|FIXME" (point))   ; first match at or after point
(find-regexp-backward "[0-9]+" (point))      ; last match before point
```

The string pair scans for literal text — `find-string-backward` is the
backward isearch step, returning the last match whose *start* is at or
before the given offset. Its natural companion is `(point-max)`, the
largest valid offset (the buffer length): searching backward "from the
end" is `(find-string-backward q (point-max))`, which is exactly how
isearch wraps past the top of the buffer.

The regexp pair speaks JavaScript's regular-expression dialect; an
invalid pattern yields `#f` rather than an error — the same value as a
miss, since these back incremental interfaces where a half-typed
regexp matches nothing. Remember that the Lisp reader has its own
escapes, so a pattern's backslash is written doubled: `"\\d+"`.
Walking matches is ordinary recursion — search, act, search again from
the match's end:

```lisp
(define (goto-next-todo)
  "Move point to the next TODO after it, if any."
  (let ((hit (find-string-forward "TODO" (point))))
    (when hit
      (goto! (car hit)))))
```

A bare `(when hit …)` is exactly right here: a miss is `#f`, which the
`when` skips, and a match is a truthy pair. The tempting
`(when (not (nil? hit)) …)` would be a bug — `(nil? #f)` is `#f`, so
its guard passes on a miss and `(car #f)` then errors.

Wholesale replacement has dedicated primitives. `(replace-all! from to)`
replaces every literal occurrence in the buffer and echoes a count to
the echo area, returning `nil`. `(replace-regexp-all! pat repl)` does
the same for a regexp — the replacement honours `$1`…`$N`, `$&`, and
`$$` — and returns the number of replacements, or `-1` for an invalid
pattern:

```lisp
(replace-regexp-all! "(\\d+)px" "$1 px")   ; ⇒ 7 — replacements made
```

The surgical one you have already met: `replace-range!`, which is how
the interactive `query-replace` swaps in each confirmed match. Indeed
`query-replace` is ordinary Lisp built on exactly these primitives —
`find-string-forward` to locate each match, `replace-range!` to swap
the confirmed ones — and `search.lisp` and `regex-search.lisp` are
worth reading whole: they are the best real-world study of the
matchers, and of the `read-next-key` continuation style the next
chapter teaches. `occur` (`M-s o`) makes the opposite point — it needs
none of the matchers, just literal `string-contains?` over
`(buffer-text)` split into lines, because a buffer's text is only a
string and the core string library — `string-index-of`,
`string-contains?` — is often the shorter spelling for a one-off
check.

### Markers: Positions That Survive Edits

An offset is a snapshot, and the obvious idiom for "do something and
come back" shows the crack. Capture point, restore it in a `finally`
clause so even a failure puts it back (the form is covered in *Errors
and Error Handling*):

```lisp
(let ((p (point)))
  (try (risky-edit)
    (finally (goto! p))))
```

`p` is a plain number, so if `risky-edit` inserts or deletes text
*before* that offset, the restored point lands in shifted text. A
*marker* is the durable version: an edit-tracking position in a buffer
— the same machinery under bookmarks and snippet fields, surfaced to
Lisp as an opaque handle.

`(make-marker)` creates one in the current buffer at point — give it
an offset to anchor elsewhere — and `(marker-position m)` reads its
current offset:

```lisp
(define m (make-marker 5))
(goto! 0) (insert! "abc")
(marker-position m)     ; ⇒ 8 — the marker rode the insertion
m                       ; the REPL prints #<marker 8 in notes.md>
```

The handle prints as `#<marker OFFSET in BUFFER-NAME>` (or
`#<marker released>` once released) — worth knowing when a marker
turns up in REPL output mid-debugging.

Edits before the marker shift it — insertions push it along, deletions
pull it back, and a deletion spanning it collapses it to the edit
point. Edits after it leave it alone. Undo and redo count too: every
change to the buffer's text keeps every marker honest.
`(set-marker! m n)` moves a marker to a new offset, where it resumes
tracking.

The ownership rules fit in one sentence: **read anywhere, move only at
home, release or leak.** The handle remembers which buffer it belongs
to, so `(marker-position m)` answers correctly even when that buffer
is no longer current; but `(set-marker! m n)` refuses to move a marker
whose buffer is not current — `(marker-buffer-current? m)` tests for
that. And each live marker costs the buffer a little work on every
later edit, so a forgotten one is a slow leak: release it with
`(release-marker! m)` when you are done. Releasing twice is harmless;
every *other* operation on a released marker raises a loud error —
deliberately, because the polite alternative, a `nil` position, is
*truthy* here and would flow into arithmetic and fail far from the
bug.

An obligation to release on every exit is exactly the shape `finally`
was made for, so `editing.lisp` packages it:

```lisp
(with-marker (m offset?) body…)
```

binds `m` to a fresh marker — at point, or at the optional offset —
runs the body, and releases the marker on the way out, whether the
body returned or raised; the body's value is returned. Reach for it
instead of a bare `make-marker` unless the marker must outlive the
form.

One level up sits the form this section opened by hand-rolling:

```lisp
(save-excursion body…)
```

evaluates the body and puts point back where it was, on normal return
and on error alike — through a marker, so edits before the saved spot
no longer skew the restore — and returns the body's value. Point only:
an active mark is deliberately left alone.

```lisp
;; in "hello world", with point at 6 — before "world"
(save-excursion (goto! 0) (insert! "say "))
(point)     ; ⇒ 10 — still before "world", not mid-"hello" at 6
```

Nested excursions restore inside-out, each level through its own
marker.

### Overlays: Decorated Ranges

A marker is one durable position; an *overlay* is a durable range with
a face — the mechanism behind "highlight every match", snippet fields,
and their kin. Three primitives cover it:

```lisp
(add-overlay! start end face kind?)   ; ⇒ an id string
(clear-overlays! kind?)               ; ⇒ nil — drop all, or one kind
(overlay-count)                       ; ⇒ the buffer's live overlay count
```

`(add-overlay! start end face kind?)` decorates `[start, end)` with
the named face (a string — `"search-match"`, `"isearch"`, or any face
from the face system; see *Customization from Lisp*). The endpoints
are pinned with markers, so the decorated range rides edits exactly as
the previous section describes. Overlays belong to the buffer, not the
window: every window showing the buffer draws them.

The optional `kind` is a tag for bulk removal. Untagged overlays get
the kind `"overlay"`; a feature that creates overlays should tag its
own — `(clear-overlays! "my-feature")` then clears yours and nobody
else's, while a bare `(clear-overlays!)` is the scorched-earth
version.

The working example ships in the editor: `M-s h`
(cmd(highlight-matches)) paints every occurrence of the word at point
— or of the region's text — with `search-match` overlays, and `M-s u`
(cmd(unhighlight-all)) clears them. Its heart is a five-line walk that
pairs a string search with overlay creation:

```lisp
(define (-add-match-overlays text needle n from)
  "Add a search overlay at every occurrence of NEEDLE (length N) in
   TEXT at or after FROM. Tail-recursive."
  (let ((found (string-index-of text needle from)))
    (cond
      ((< found 0) nil)
      (else
        (add-overlay! found (+ found n) "search-match" "search")
        (-add-match-overlays text needle n (+ found n))))))
```

Note the discipline: every overlay is tagged `"search"`, so both
commands begin with `(clear-overlays! "search")` and never disturb an
overlay some other feature owns.

### What the Lisp Does Not Expose

One gap remains, and readers arriving from Emacs Lisp deserve it
stated plainly: **there is no buffer targeting.** Every primitive acts
on the current buffer; nothing lets a function address another buffer
behind the scenes. (Markers stretch this the polite distance — reading
`(marker-position m)` works from anywhere — but moving one, like every
edit, happens only in the buffer in front of you.)

### Files and Saving from Lisp

The file surface splits, as it so often does in Godot, into commands
that carry the policy and primitives that do the work.

Opening: `C-x C-f` runs cmd(find-file). The prompt starts at a
sensible directory — the directory of the file the current buffer is
visiting, falling back to your home directory — and TAB completes
paths; on submit the server reads the file and switches the window to
it. (The prompt's fulfilment is host-side: the server recognises the
`Find file: ` prompt and does the disk I/O itself, which is also why a
directory path opens a directory view rather than a buffer.) A path
that names no existing file is an error — `find-file: cannot open …`
in the echo area — not an invitation to create one. Programmatic
opening skips the prompt: `(open-file-path! "/etc/hosts")`. To read a
file *without* visiting it, `(read-file-text! path)` returns its
contents as a string (`nil` on any failure), with
`(file-exists? path)` answering the obvious question.

Saving: `C-x C-s` runs cmd(save-buffer), a Lisp command over the
`save-buffer!` primitive. The primitive writes the current buffer to
its file and reports a status string; the command owns the policy that
string drives — `"ok"` echoes a confirmation, `"no-path"` (a buffer
that has never been saved) falls back to cmd(write-file), the
`C-x C-w` save-as prompt, exactly as Emacs's `C-x C-s` behaves on a
new buffer, and `"error"` surfaces the failed write. The primitive
does the work; the command decides what the situation means. Write
your own automation against whichever layer you mean.

Closing: `C-x k` runs cmd(kill-view), which removes the current view
and switches to another — the registry refuses to drop the last
buffer, so the window is never empty. There is no per-kill
are-you-sure prompt; the guard against losing unsaved work lives in
the quit path instead, where `C-x C-c` walks every dirty buffer across
all windows with a per-buffer y/n/!/q prompt (save-some-buffers
style). Sessions, autosave, and recovery are user-manual territory —
see <a href="nodes/files-and-buffers.html" data-godot-doc="files-and-buffers">Files and buffers</a>.

### A Complete Editing Function

The capstone assembles the chapter: read a region, transform it with
the string library, and write it back as one atomic edit. The
transformation here reverses the region's lines, but the structure is
identical for any line-wise transform — put `sort` where the `reverse`
is and you have the heart of the standard library's line sorter.

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

The standard library's cmd(sort-lines) command (`line-ops.lisp`; reach
it as `M-x sort-lines`) is this same shape grown to production. The
transformation is `(sort …)` instead of `(reverse …)`, and around it
sit the details a shipped command owes its user: the range is snapped
*outward* to whole lines — start back to its line's start, end forward
to its line's end, except that an end at column 0 leaves that line
alone, the same rule `indent-region` follows — an already-sorted block
is recognised and left unedited, so no empty step pollutes the undo
stack, and point lands at the start of the sorted block either way.
Read it beside `reverse-region-lines` and you can see exactly what a
chapter example leaves out.

What remains is to make it a first-class citizen: a named command that
gathers those bounds itself through an `(interactive region)` clause,
appears in `M-x`, and sits on a key of your choosing. That is the
subject of the next chapter, *Commands, Keymaps, and the Minibuffer*.
