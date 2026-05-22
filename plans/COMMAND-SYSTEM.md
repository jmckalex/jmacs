# Plan — the command system (`defcommand`)

**Status: shipped** (phases 1–3). Phase 4 — the `prefix` source — is
deferred: it needs a prefix-argument (`C-u`) mechanism jmacs does not
yet have. The spec reserves the `prefix` name for it.

## Context

`M-x` lists only the commands bound in the keymap — `command-names`
(`palette.lisp`) walks `the-keymap`. The keymap was a cheap stand-in
for a command registry; a command that is defined but not bound to a
key — `customize` is the first — is invisible to `M-x`.

The deeper issue: jmacs has no first-class notion of a *command*. A
command is just a `define`d procedure, indistinguishable from a helper
(`lookup-key`), a primitive, or a prelude function (`caar`). Listing
*every* procedure in `M-x` would be noise — and several need arguments.

This is the distinction Emacs draws with `(interactive)`: commands
(invoke by name or key) versus ordinary functions. And `(interactive)`
does a second, more powerful job — it declares *how a command's
arguments are gathered*: from the region, from a minibuffer prompt,
from the prefix argument. Today jmacs commands are all zero-argument
and bury their input-gathering inside the body (`replace-string` →
`start-replace!` → a bespoke minibuffer dance). They conflate *what the
command does* with *how its inputs are obtained*, and so cannot be
called cleanly with explicit arguments.

This plan gives jmacs a real command system: `defcommand`, a command
registry (which fixes `M-x`), and a declarative interactive argument
spec (the powerful half — jmacs's analogue of `(interactive)`).

## The `defcommand` form

```lisp
(defcommand uppercase-region (start end)
  "Upper-case the text in the region."
  (interactive region)
  (replace-region! start end
    (string-upcase (buffer-substring start end))))
```

- `name`, `(params)` and an optional docstring — as `define`.
- An optional **`(interactive source…)`** clause — the first body form
  after the docstring, as in Emacs — declares the argument spec.
- `defcommand` is a macro: it `define`s the procedure (docstring and
  all) *and* registers `(name . spec)` in the command registry.
- A command with no `(interactive)` clause is a zero-argument command —
  registered, `M-x`-able, invoked with no arguments (today's behaviour).

`uppercase-region` is now an ordinary function: callable directly as
`(uppercase-region 10 40)`, *and* interactively (by `M-x` or a key)
with `start`/`end` gathered from the region. That dual nature — and the
testability and composability it brings — is the point.

## The command registry

`*commands*` — a map from a command's name to its interactive spec
(nil for a zero-argument command). `register-command!` adds an entry;
`defcommand` calls it. `command-names` is rewritten to return
`(keys *commands*)`. `M-x` then lists *every* command, bound or not.
The keymap returns to a single job: binding keys.

## The interactive argument spec

The `(interactive …)` clause is a list of *source descriptors*; each
yields one or more argument values, concatenated into the call.

| Source | Yields | |
|--------|--------|--|
| `point` | the cursor offset | sync |
| `region` | the region's start and end (2 values) | sync |
| `region-or-buffer` | the region, or the whole buffer when none | sync |
| `(string "Prompt: ")` | a string from the minibuffer | async |
| `(number "Prompt: ")` | a number from the minibuffer | async |
| `(buffer "Prompt: ")` | a buffer name, with completion | async |
| `(file "Prompt: ")` | a file path | async |
| `(key "Prompt: ")` | one keystroke | async |
| `prefix` | the numeric prefix argument | *deferred* |

`prefix` is the one source held back: jmacs has no prefix-argument
(`C-u`) mechanism. The spec reserves the name; the source waits on a
prefix-argument feature of its own.

## The argument gatherer

When a command is invoked — by a key (`handle-key`) or by name
(`M-x`) — a single entry point, `run-command`, consults the registry:

- **no spec** → call the command with no arguments (back-compatible);
- **a spec** → *gather* the arguments, then `apply` the command to them.

Gathering walks the spec. Sync sources (`point`, `region`) are read at
once from the buffer primitives. Async sources (minibuffer prompts,
`key`) suspend: the gatherer opens the prompt and resumes in its
callback — a continuation-style fold over the spec. This is exactly the
shape `read-next-key` and the chained prompts in `startReplace` already
use; it is generalised here.

So the gatherer (Lisp) can prompt generically, two new host primitives:
`minibuffer-read` (a prompt → a string, by callback) and
`minibuffer-read-choice` (a prompt + options → a completed choice).
They generalise the bespoke `start-…!` prompt primitives; the existing
ad-hoc prompt functions can later be rebuilt on them.

`run-command` returns as soon as the first prompt is open; the command
itself runs in the gatherer's final callback — the same deferral the
`start-…!` commands already have today.

## Dispatch

`handle-key` (`keymap.lisp`): the command-name branch changes from
`((eval binding))` to `(run-command binding)`. `execute-command` and
the palette route the chosen name through `run-command` too. One path
serves both keys and `M-x`.

## Migration

1. Every standard-library command moves `(define (name) …)` →
   `(defcommand name () …)` — mechanical; it registers them, so `M-x`
   immediately lists all of them (and `customize` and friends appear
   with no keybinding needed).
2. The simple prompt commands are rewritten to use `(interactive)`
   specs: `goto-line` becomes `(defcommand goto-line (n) (interactive
   (number "Goto line: ")) …)`, `replace-string` takes two `(string …)`
   sources. Their bespoke host functions (`startGotoLine`,
   `startReplace`) collapse into the generic gatherer.
3. Incremental search stays a zero-argument command — it is a live
   incremental loop, not gather-then-run; `(interactive)` does not
   apply, and that is fine.

## Phasing

1. **`defcommand` + the registry.** A new `commands.lisp` (loaded
   *first* in `STDLIB_FILES`, before any command file): the macro,
   `*commands*`, `register-command!`, `run-command` with the no-spec
   path. `command-names` reads the registry. Migrate the stdlib
   commands' `define` → `defcommand`. `M-x` now lists every command.
2. **The interactive spec — sync sources.** `point`, `region`,
   `region-or-buffer`; the gatherer; dispatch through `run-command`.
   Region commands work.
3. **The async sources.** `minibuffer-read` host primitives, the
   prompt/`key` sources; migrate `goto-line` / `replace-string`.
4. **Deferred.** The `prefix` source, once a prefix-argument mechanism
   exists.

## Testing

- Stdlib tests: `defcommand` registers a command; `command-names` is
  the registry; `run-command` on a no-spec and on a sync-spec command;
  the gatherer assembles the right argument list for `point` / `region`.
- Smoke test: `M-x` offers a command that is bound to no key; a region
  command run from a key edits the region.
- The async gatherer is covered by the smoke test (a prompt-spec
  command) — the minibuffer has no unit harness.

## Risks and open questions

- The async gatherer is the subtle part — a cancelled or stale prompt
  must abort the half-gathered command cleanly.
- `defcommand`'s body parsing — an optional docstring, an optional
  leading `(interactive)` form — is a small macro; the no-doc /
  no-interactive / both cases must all be right.
- A region source with no active region — `region` errors, plain;
  `region-or-buffer` falls back to the whole buffer. Both are provided.
- The migration is broad — ~80 commands across every stdlib file — but
  mechanical; it is a phase of its own.
- `prefix` (`C-u`) is a genuine prerequisite for part of the vision and
  is a small feature in its own right.

## Critical files

- `packages/stdlib/lisp/commands.lisp` — **new**: the `defcommand`
  macro, `*commands*`, `register-command!`, `run-command`, the gatherer.
- `packages/stdlib/src/index.js` — register `commands.lisp` first.
- Every `packages/stdlib/lisp/*.lisp` command file — the `define` →
  `defcommand` migration.
- `packages/stdlib/lisp/keymap.lisp` — `handle-key` dispatches through
  `run-command`.
- `packages/stdlib/lisp/palette.lisp` — `command-names` reads the
  registry.
- `apps/desktop/src/app.js` — the `minibuffer-read` host primitives.
