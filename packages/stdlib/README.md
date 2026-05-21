# @editor/stdlib

The editor's standard library: its commands and keybindings, **written
in Lisp**. This is what makes the editor a Lisp editor rather than an
editor with a Lisp REPL attached — its behaviour lives in code you can
read and redefine.

## Layout

```
lisp/editing.lisp   editor commands (forward-char, delete-backward, …)
lisp/keymap.lisp     the default key bindings and key dispatch
src/buffer-primitives.js   the Lisp-to-buffer bridge (host procedures)
src/index.js               the loader
```

## How it fits together

1. The host builds buffer primitives for a buffer —
   `createBufferPrimitives(buffer)` — and installs them in an
   interpreter.
2. `loadStdlib` evaluates the Lisp files in order: `editing.lisp`
   defines commands on top of those primitives; `keymap.lisp` binds
   them to keys and defines `handle-key`.
3. On every keystroke the renderer reports a normalised key string and
   the host calls `(handle-key "…")`, which runs the bound command or
   self-inserts a character.

```js
import { createInterpreter } from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '@editor/stdlib';

const interpreter = createInterpreter({
  primitives: createBufferPrimitives(buffer),
});
await loadStdlib(interpreter, (name) => readSource(name));

interpreter.call('handle-key', 'right'); // runs forward-char
```

`loadStdlib` does not read files itself — the caller supplies the
source text, so it works both in the app (fetched over `app://`) and
in tests (read from disk).

## Current state

Movement, selection, editing, history and file commands, and a default
keymap with **key sequences** — a key can map to a nested keymap, so
`C-x C-f` works. A command palette (`M-x`) and a command registry with
metadata are next.

## Tests

```
npm test
```

Loads the real Lisp files against a buffer and exercises the keymap.
