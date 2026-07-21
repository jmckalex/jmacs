## Keys and commands

Everything the editor does is a *command* — a named Lisp procedure
declared with `defcommand`. Most commands take no arguments; one that
does carries an *interactive specification* naming where its arguments
come from — the point, the active region, a minibuffer prompt — and
dispatch gathers them before the call (cmd(upcase-region) receives the
region's bounds this way; cmd(goto-line) receives a prompted line
number). The *Extending Godot* chapter covers `defcommand` and
`interactive`. You reach a command in one of two ways: press a key
bound to it, or call it by name with `M-x`. This chapter explains how a
key is named, how a multi-key sequence is read, how `M-x` works, and
the single path every keystroke travels to become an action.

The bindings described here are the editor's *defaults*, defined in
Lisp (`packages/stdlib/lisp/keymap.lisp`). None of them is baked into
the host — they are a map you can edit, and a key you bind takes effect
on the next keystroke. This chapter describes the map as shipped; the
*Extending Godot* chapter explains how to change it.

### How a key is named

The renderer reports each keystroke to the Lisp as a single normalised
string. The rule is simple:

- A bare printable key is *itself* — `"a"`, `"A"`, `"("`, `" "`. These
  are the keys that self-insert as text. Note that the space bar
  belongs here: unmodified, it is the one-character string `" "`, not
  a named key.
- Every other key has a *name*: `"left"`, `"right"`, `"up"`, `"down"`,
  `"enter"`, `"backspace"`, `"delete"`, `"tab"`, `"home"`, `"end"`,
  `"escape"`. Names are lowercase. (When this manual says "press
  Return", it means the key whose string is `enter`.)
- A key held with a modifier gets a *prefix*, and so picks up a name
  even when it is a printable character: `"C-z"`, `"M-x"`, `"S-left"` —
  and `space` appears here as the base of chords like `C-space`
  (cmd(set-mark-command)) and `M-space` (cmd(just-one-space)), even
  though the bare space bar self-inserts.

The modifier prefixes, in the order they are written:

- `C-` — **Control**, and Control alone. `C-f` is Control-F.
- `M-` — **Command** (the Meta of Emacs custom). `M-x` is Command-X.
- `A-` — **Option / Alt**. An `A-` chord the keymap does not bind
  falls through to inserting the character Option composed, so binding
  an Option key costs exactly that one composition — the rest of
  Option's typing (curly quotes, accents) is untouched. The default
  map itself uses this: the four Option-bracket chords `A-[`, `A-]`,
  `A-S-[`, `A-S-]` are claimed for typographic quotes
  (cmd(insert-single-open-quote) and family), overriding the macOS
  compositions on those four chords and nothing else — a claimed chord
  beats the compose fallthrough.
- `S-` — **Shift**. Usually only named on non-printable keys —
  `S-left`, `S-end` — since a shifted letter is already its own
  character.

When more than one modifier is held they stack in that fixed order —
`C-M-A-S-`: Control, Meta, Option, Shift. So Control-Shift-Z is
`"C-S-z"` and Control-Option-S is `"C-A-s"`.

Two details are worth knowing. First, a modified key takes its base
name from the *physical* key, not the character the OS would compose.
On macOS, Option-X composes `≈`, but a binding still sees `"A-x"`,
because the base name comes from the key's position rather than its
output. Second, some keys you might think of as punctuation arrive
*shifted* and so carry an `S-`: `M-<` is `"M-S-comma"` and `M-%` is
`"M-S-5"`, because `<` and `%` are Shift of `,` and `5`. The default
keymap binds those normalised forms directly, so you never have to
think about it unless you are writing a binding of your own.

For a binding of your own, the general rule for a modified key's base
name: a letter key is the lowercase letter, a digit key is the digit,
and any other key is the lowercased name of the physical key — with
the two bracket keys special-cased to `[` and `]` so a binding can say
`M-[` rather than `M-bracketleft`. In practice:

| Key | Base name | A shipped binding |
|-----|-----------|-------------------|
| `,` | `comma` | `M-S-comma` (`M-<`, cmd(beginning-of-buffer)) |
| `/` | `slash` | `C-slash` (`C-/`, cmd(undo)) |
| `-` | `minus` | `C-S-minus` (`C-_`, cmd(undo)) |
| `=` | `equal` | `C-equal` (cmd(expand-region)) |
| `5` | `5` | `M-S-5` (`M-%`, cmd(query-replace)) |
| `[` `]` | `[` `]` | `M-[` / `M-]` (cmd(outdent-region) / cmd(indent-region)) |

> A note for the curious: the normalisation lives in
> `packages/renderer/src/keymap.js` (`keyEventToString`). `Enter` becomes
> `enter`, the arrows become `left`/`right`/`up`/`down`, `Ctrl+M` is
> `C-m` (no folding to a control character), and Option-Return is
> `A-enter`. The Lisp keymap is written entirely in these strings.

### Prefix keys and chords

A key in a keymap can be bound to a *nested keymap* instead of a
command. Such a key is a *prefix*: pressing it does not act, it begins a
*key sequence* (a "chord"). The next key you press is looked up in the
nested map. This is how `C-x C-f` opens a file — `C-x` selects the
`c-x-keymap`, then `C-f` within it runs cmd(find-file).

While a chord is in progress the keys you have typed so far are echoed
in the minibuffer's status line with a trailing dash — `C-x-` after you
press `C-x` — so you can always see that the editor is waiting for more.
cmd(keyboard-quit) (`C-g`) aborts a partial sequence and clears the
echo; an unbound continuation simply ends the sequence quietly.

The standing prefixes in the default keymap are:

| Prefix | What lives under it |
|--------|---------------------|
| `C-x` | Editor, file, buffer and pane commands (cmd(find-file), cmd(save-buffer), the pane splits, and more). |
| `C-x r` | The bookmark/register family — `C-x r m` to set a bookmark, `C-x r b` to jump, `C-x r l` to list. |
| `C-x 5` | Windows (frames) — `C-x 5 2` opens another window, `C-x 5 0` closes this one, `C-x 5 1` closes every other window. |
| `C-h` | Help — the "describe" commands (cmd(describe-key), cmd(describe-command)), cmd(apropos-doc), and the manual (`C-h d`, cmd(open-manual)). |
| `C-c` | Editor-wide commands such as folding and multi-cursor. In a major mode, `C-c` is usually rebound to that mode's own writing commands, which shadow this map for the mode's buffers. |
| `M-n` | Sticky notes — add, edit, delete, navigate. |
| `M-s` | Search-related commands — `M-s o` cmd(occur), `M-s h` cmd(highlight-matches), `M-s u` cmd(unhighlight-all). |

A prefix can itself nest a prefix: `C-x r` is the `r` key inside the
`C-x` map bound to a further keymap, so `C-x r m` is a three-key
sequence. There is no depth limit; each key in turn just narrows to the
next map.

Prefixes resolve through the buffer's mode chain the same way single
keys do (see below), so a major or minor mode can add its own prefix —
or extend a global one — for its buffers only. When a mode's prefix map
does not bind the key you press, the lookup *falls through* to the
global map: pressing `C-c d` in a Markdown buffer, where the mode's
`C-c` map has no `d`, still reaches the global cmd(add-cursor-next).

### The universal argument — `C-u`

One key modifies the *next* command rather than running one of its own.
`C-u` (cmd(universal-argument)) sets the variable `*prefix-arg*` and
echoes `C-u-`; the next command may consult that variable to vary its
behaviour, and dispatch clears it as soon as that command has run.
The pane splits are the flagship users: `C-u C-x 2` splits the pane
above instead of below, and `C-u C-x 3` to the left instead of right.
A command that does not consult the prefix simply ignores it, and
cmd(keyboard-quit) (`C-g`) discards a pending one.

Numeric arguments are not supported yet — there is no `C-u 4` repeat
count. A single `C-u` is a plain "argument present" flag (`#t`).

### Running a command by name — `M-x`

Not every command has a key, and you will not remember the keys for the
ones that do. `M-x` (cmd(execute-command)) is the answer to both. It
opens a minibuffer prompt: type a command name and press Return. You do
not need the whole name — an exact name always wins, and otherwise the
*shortest* command name *containing* what you typed runs, so a
distinctive fragment is enough: `goto` runs cmd(goto-line). No
candidate list is offered while you type — completion in the `M-x`
prompt is not wired up yet — so when you are unsure what a command is
called, cmd(apropos-doc) (`C-h a`) searches names and documentation,
and cmd(describe-key) (`C-h k`) works backwards from a key.

The candidate set is every *registered* command — everything declared
with `defcommand`, whether or not any key binds it — plus the commands
announced by the window's element views (the one JavaScript route into
`M-x`). A name that matches no registered command is offered to the
window's element views as a last resort; failing that, the minibuffer
reports `No command`. `M-x` is therefore two things at once: the way to
run commands that have no binding, and — together with the help
commands — a way to *discover* the editor by rummaging in it. When you
have found a command you use often, the *Extending Godot* chapter shows
how to give it a key.

### How a keystroke is dispatched

The window resolves nothing. The renderer's one job is to normalise the
DOM event to a key string (above) and send it up the wire to the
server, where `handle-key` — one Lisp procedure — dispatches it;
everything after the normalisation — self-insertion, command dispatch,
chord tracking — is Lisp you can read and change. There is one dispatch
path, and this is it. (The *Architecture* chapter follows a keystroke
around the full server round-trip.)

`handle-key` resolves the key in this order:

1. **A pending key-reader wins.** A command such as cmd(describe-key)
   needs to read the *next* raw key rather than act on it; it registers
   a reader with `read-next-key`. If one is pending, the keystroke
   goes to it and nothing else happens.
2. **Otherwise the key is looked up.** At rest, the lookup runs through
   the buffer's *keymap chain* (`keymap-chain`): the active
   minor-mode keymaps first, in priority order, then the major-mode
   keymap, then the global `the-keymap`. The first map that binds the
   key wins — which is how a mode shadows a global binding for its own
   buffers without touching anyone else's. Mid-chord, the lookup instead
   descends into the prefix maps the chord opened.
3. **The binding decides what happens.** If it is a nested keymap, the
   key was a prefix: the editor records the chord and waits for the next
   key. If it is a command name (a symbol), the editor returns to rest
   and runs the command — provided a command is actually *registered*
   under that name; a binding to a name with no command behind it shows
   *"⟨name⟩ is not available here"* in the echo area instead. If
   nothing is bound and a single character was typed, it self-inserts
   as text, and then `*post-self-insert-hook*` runs with the inserted
   key — the seam "electric" behaviours hang from; cmd(auto-fill-mode)
   uses it to wrap the line as you type (see the *Writing* chapter).
   Anything else is left unhandled.

Two consequences are worth drawing out. Commands are bound *by name* — a
symbol — and resolved *late*, every time the key is pressed. That is why
redefining a command takes effect immediately, with no rebinding, and
why the keymap can name a command that does not exist yet — you now
know what pressing such a key does: a quiet "not available here" rather
than an error. And because the whole path is one Lisp procedure over
plain-data keymaps, the editor's response to any key is something you
can inspect with cmd(describe-key) (`C-h k` — press a key, and the
editor tells you the command it runs and that command's documentation)
and change from inside the running editor.

Two carve-outs sit at the edges of the one path:

- **Media and element views.** With a non-text view focused — a video,
  an image, a custom element view — *bare* keys stay with the element
  (space is play/pause on a video, the arrows seek), while chords held
  with Control, Command, or Option are still routed to `handle-key` —
  so a command chord can always reach the editor from a video; a bare
  key cannot.
- **Native menu accelerators.** A few app-menu items carry native
  accelerators that never enter `handle-key` — the View menu's Reload
  on `Ctrl+Cmd+R`, the File menu's Open File… on `Cmd+O`. A `Cmd`
  chord the keymap claims never reaches the menu; an *unclaimed* one
  falls through to its menu role. This is also why cmd(describe-key)
  cannot see those keys: they are handled before the editor's dispatch
  begins.

### Where these tables live

Every table in this chapter is data on disk, not documentation of
something sealed away. The global map and all its prefix maps are in
`packages/stdlib/lisp/keymap.lisp` — the file *is* the keymap, and
reading it is the authoritative answer to "what is bound?". Mode-local
maps live in each mode's own file under
`packages/stdlib/lisp/languages/` (with the feature files —
`latex-insert.lisp`, the `jmarkdown-*.lisp` family — extending their
mode's `C-c` map). Changing any of it, from the REPL or permanently, is
the *Extending Godot* chapter's business.

> A note on focus: the REPL input and the minibuffer are native inputs
> and keep their own keys — while one of them is focused, editor
> bindings do not fire; click back into the text to resume. Everywhere
> else dispatch is forgiving: command chords reach the editor even when
> window focus has drifted off the text surface (and, per the carve-out
> above, even from a media view).
