## Keys and commands

Everything the editor does is a *command* — an ordinary Lisp procedure
of no arguments. You reach a command in one of two ways: press a key
bound to it, or call it by name with `M-x`. This chapter explains how a
key is named, how a multi-key sequence is read, how `M-x` works, and the
single path every keystroke travels to become an action.

The bindings described here are the editor's *defaults*, defined in
Lisp (`packages/stdlib/lisp/keymap.lisp`). None of them is baked into
the host — they are a map you can edit, and a key you bind takes effect
on the next keystroke. This chapter describes the map as shipped; the
[Extending jmacs](extending.md) chapter explains how to change it.

### How a key is named

The renderer reports each keystroke to the Lisp as a single normalised
string. The rule is simple:

- A bare printable key is *itself* — `"a"`, `"A"`, `"("`, `" "`. These
  are the keys that self-insert as text.
- Every other key has a *name*: `"left"`, `"right"`, `"up"`, `"down"`,
  `"enter"`, `"backspace"`, `"delete"`, `"tab"`, `"home"`, `"end"`,
  `"escape"`, `"space"`. Names are lowercase.
- A key held with a modifier gets a *prefix*, and so picks up a name
  even when it is a printable letter: `"C-z"`, `"M-x"`, `"S-left"`.

The modifier prefixes, in the order they are written:

- `C-` — **Control or Command**. The two are treated alike, so the
  editor is usable on a Mac (where Command is the natural reach) and on
  a PC keyboard (where Control is). `C-f` is Control-F *or* Command-F.
- `M-` — **Option / Alt** (the "Meta" key). `M-x` is Option-X.
- `S-` — **Shift**. Usually only named on non-printable keys —
  `S-left`, `S-end` — since a shifted letter is already its own
  character.

When more than one modifier is held they stack in that fixed order:
Control, then Option, then Shift. So Control-Shift-Z is `"C-S-z"` and
Control-Option-S is `"C-M-s"`.

Two details are worth knowing. First, a modified key takes its base
name from the *physical* key, not the character the OS would compose.
On macOS, Option-X composes `≈`, but the editor still sees `"M-x"`,
because the base name comes from the key's position rather than its
output. Second, some keys you might think of as punctuation arrive
*shifted* and so carry an `S-`: `M-<` is `"M-S-comma"` and `M-%` is
`"M-S-5"`, because `<` and `%` are Shift of `,` and `5`. The default
keymap binds those normalised forms directly, so you never have to
think about it unless you are writing a binding of your own.

> A note for the curious: the normalisation lives in
> `packages/renderer/src/keymap.js` (`keyEventToString`). `Enter` becomes
> `enter`, the arrows become `left`/`right`/`up`/`down`, `Ctrl+M` is
> `C-m` (no folding to a control character), and Option-Return is
> `M-enter`. The Lisp keymap is written entirely in these strings.

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
| `C-h` | Help — the "describe" commands (cmd(describe-key), cmd(describe-command)). |
| `C-c` | Editor-wide commands such as folding and multi-cursor. In a major mode, `C-c` is usually rebound to that mode's own writing commands, which shadow this map for the mode's buffers. |
| `M-n` | Sticky notes — add, edit, delete, navigate. |
| `M-s` | Search-related commands (cmd(occur)). |

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

### Running a command by name — `M-x`

Not every command has a key, and you will not remember the keys for the
ones that do. `M-x` (cmd(execute-command)) is the answer to both. It
opens the *command palette* in the minibuffer: start typing a command
name and the palette offers matches, with fuzzy matching, so `efp`
finds `eval-expression-at-point` and you do not have to type or even
recall the exact name. Press Return to run the highlighted command.

The palette offers every command reachable from the keymap — the set
computed by cmd(command-names) — which is essentially the editor's whole
public surface. `M-x` is therefore two things at once: the way to run
commands that have no binding, and a way to *discover* the editor by
browsing what is there. When you have found a command you use often, the
[Extending jmacs](extending.md) chapter shows how to give it a key.

### How a keystroke is dispatched

Every keystroke in the editor goes through one Lisp procedure:
cmd(handle-key). The host's only job is to normalise the event to a key
string (above) and hand it to cmd(handle-key); everything after that —
self-insertion, command dispatch, chord tracking — is Lisp you can read
and change. There is one dispatch path, and this is it.

cmd(handle-key) resolves the key in this order:

1. **A pending key-reader wins.** A command such as cmd(describe-key)
   needs to read the *next* raw key rather than act on it; it registers
   a reader with cmd(read-next-key). If one is pending, the keystroke
   goes to it and nothing else happens.
2. **Otherwise the key is looked up.** At rest, the lookup runs through
   the buffer's *keymap chain* (cmd(keymap-chain)): the active
   minor-mode keymaps first, in priority order, then the major-mode
   keymap, then the global cmd(the-keymap). The first map that binds the
   key wins — which is how a mode shadows a global binding for its own
   buffers without touching anyone else's. Mid-chord, the lookup instead
   descends into the prefix maps the chord opened.
3. **The binding decides what happens.** If it is a nested keymap, the
   key was a prefix: the editor records the chord and waits for the next
   key. If it is a command name (a symbol), the editor returns to rest
   and runs the command. If nothing is bound and a single character was
   typed, it self-inserts as text. Anything else is left unhandled.

Two consequences are worth drawing out. Commands are bound *by name* — a
symbol — and resolved *late*, every time the key is pressed. That is why
redefining a command takes effect immediately, with no rebinding, and
why the keymap can name a command that does not exist yet. And because
the whole path is one Lisp procedure over plain-data keymaps, the
editor's response to any key is something you can inspect with
cmd(describe-key) (`C-h k` — press a key, and the editor tells you the
command it runs and that command's documentation) and change from inside
the running editor.

> One current limitation: editor keybindings fire only while the editing
> surface itself has focus — not while the REPL or a minibuffer input is
> focused. Click back into the text to restore key handling.
