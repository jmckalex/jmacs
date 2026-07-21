# Modes — design proposal

**Status: decided — the open questions (§13) are answered, and
phases 1–3 are implemented. Phase 4 remains.**

A *mode* is a tagged behavioural configuration for a buffer (per the
glossary). This document proposes how modes work in Godot: the data
model, where per-buffer state lives, how mode keymaps compose with the
global keymap, and how modes are chosen. It ends with a phasing plan
and the open questions worth a decision before implementation.

The design goal, as everywhere: the smallest thing that is genuinely a
mode system, with modes themselves being ordinary Lisp data.

## 1. The model

Two tiers, as in Emacs — the model an Emacs user expects, and a proven
one:

- A buffer has exactly **one major mode** — its primary character
  (`lisp-mode`, `markdown-mode`). A buffer always has a major mode; the
  fallback is `fundamental-mode`.
- A buffer has **zero or more minor modes** — orthogonal, toggleable
  behaviours (`auto-fill-mode`, say), stacked in a defined order.

Major and minor modes are the *same kind of value*; they differ only in
how they are used (one-of vs many-of).

## 2. A mode is data

A mode is a plain Lisp map. No new special form is required — a mode is
created with `define` and a map literal:

```lisp
(define lisp-mode
  {:name           "Lisp"
   :keymap         lisp-mode-map      ; a keymap, or nil
   :comment-prefix ";; "              ; or nil
   :highlight      :lisp              ; highlighter hint, or nil
   :on-enable      (lambda () nil)    ; run when the mode is entered
   :on-disable     (lambda () nil)})  ; run when the mode is left
```

Every key is optional. A minor mode typically sets only `:name`,
`:keymap`, and the hooks. `fundamental-mode` sets only `:name`.

Keeping a mode as data (not a class, not a special form) means it can
be inspected, copied, and modified in the REPL like anything else —
which is the whole point of the editor.

A later convenience macro `define-mode` could add keyword-argument
sugar, but it is not needed for v1.

## 3. Example modes (shipped in the standard library)

```lisp
(define fundamental-mode {:name "Fundamental"})

(define lisp-mode
  {:name "Lisp" :comment-prefix ";; " :highlight :lisp
   :keymap lisp-mode-map})

(define markdown-mode
  {:name "Markdown" :comment-prefix nil :highlight :markdown
   :keymap markdown-mode-map})

(define javascript-mode
  {:name "JavaScript" :comment-prefix "// " :highlight :javascript})
```

## 4. Per-buffer state — where it lives

A buffer needs to know its major mode and its minor modes. Two places
this could live:

- **(A) On the L2 buffer** — a `mode` slot and a `minorModes` list,
  which L2 stores opaquely and never interprets. Architecturally
  "correct" (the architecture lists modes under L2) and lets the
  renderer read the mode directly.
- **(B) In the stdlib bridge** — a `Map` keyed by the buffer object,
  held inside `createBufferPrimitives`. No change to the L2 package.

**Recommendation: (B) for v1.** It is the smaller, lower-risk change —
L2 stays untouched — and the mode system needs nothing from L2 except a
buffer to key on. The cost is that the renderer cannot see the mode, so
**syntax-highlight selection stays extension-based** (`languageForName`)
in v1 rather than being driven by `:highlight`. That is acceptable: a
`.md` buffer gets `markdown-mode` *and* markdown highlighting today,
just chosen by two independent rules that happen to agree.

Promoting mode state into L2 and unifying highlight selection is a
clean later step (§12) and does not change anything above this slot.

New buffer primitives (the stdlib's bridge to that state):

```
buffer-major-mode            -> the current buffer's major mode
set-major-mode! mode         -> set it (runs on-disable then on-enable)
buffer-minor-modes           -> the list of active minor modes
add-minor-mode! mode
remove-minor-mode! mode
```

## 5. Activation

A registry maps a filename pattern to a mode:

```lisp
(register-mode ".lisp" lisp-mode)
(register-mode ".jmd"  markdown-mode)
(register-mode ".md"   markdown-mode)
(register-mode ".js"   javascript-mode)
```

`choose-major-mode!` sets the current buffer's major mode to the first
registered mode whose pattern matches the buffer's name, or
`fundamental-mode` if none match. The host calls it when a buffer is
created, opened, or renamed. (Patterns are filename *suffixes* in v1,
matched with a `string-suffix?` primitive — a companion to the existing
`string-prefix?`. Globs or regex can come later.)

## 6. Keymap composition

This is the part that changes `keymap.lisp`. Today a key is looked up
in one keymap. With modes, a key is resolved through a **chain**:

```
minor-mode keymaps (most-recently-enabled first)
  → major-mode keymap
    → the global keymap
```

The first keymap in the chain that binds the key wins. So `lisp-mode`
can bind `Tab` to a Lisp-aware indent without disturbing the global
`Tab`, and a buffer in `fundamental-mode` is unaffected.

`active-keymap` changes meaning slightly. Today it is "the keymap to
look the next key up in" — the global map at rest, a prefix sub-map
mid-sequence. It becomes:

- `nil` at rest — *look up through the mode chain*;
- a specific prefix sub-map while a key sequence is in progress.

Sketch of the revised `handle-key`:

```lisp
(define (lookup key)
  (if (nil? active-keymap)
      (lookup-in-chain key (keymap-chain))   ; §6 chain
      (get active-keymap key nil)))           ; mid-sequence

(define (handle-key key)
  (if (not (nil? *key-reader*))
      (run-key-reader key)
      (let ((binding (lookup key)))
        (cond
          ((map? binding)    (set! active-keymap binding) #t)
          ((symbol? binding) (reset-keymap!) ((eval binding)) #t)
          ((not (nil? active-keymap)) (reset-keymap!) #t)  ; bad sequence
          ((self-insert-key? key) (insert! key) #t)
          (else #f)))))
```

A prefix key found in a mode map descends into *that* map's sub-map, so
modes can have their own prefix sequences.

## 7. Minor modes

`enable-minor-mode` / `disable-minor-mode` add or remove a mode from the
current buffer's minor list and run its `:on-enable` / `:on-disable`.
The list order is the keymap-precedence order in §6.

v1 ships the *mechanism* and at most one example minor mode; a useful
catalogue of minor modes can grow later, pulled by real need.

## 8. Hooks

A mode's `:on-enable` runs when the mode becomes active in a buffer,
`:on-disable` when it stops — the built-in, single procedure slot set at
`define-mode` time, for "set things up for this buffer".

On top of that, **additive hooks** (Emacs's `lisp-mode-hook` story) are
now implemented in `modes.lisp`:

```lisp
(add-hook markdown-mode (lambda () (enable-minor-mode math-mode)))
(add-hook markdown-mode another-fn)            ; both run, in order
(add-hook markdown-mode on-leave :on-disable)  ; the disable phase
(remove-hook markdown-mode another-fn)
```

`add-hook` registers any number of functions per mode (keyed by display
name, so they survive a redefinition and can be registered before the
mode loads); it is idempotent by procedure identity and accepts a mode
object *or* its name. `run-mode-hook` runs the built-in `:on-enable` /
`:on-disable` slot **first**, then every registered hook in registration
order — so the built-in slot and community hooks coexist. This fires on
major-mode switch and minor-mode enable/disable alike.

## 9. The modeline

The modeline gains the major mode's `:name`:

```
scratch.lisp   Lisp        Ln 12, Col 3
```

A small change to the host's `updateModeline`.

## 10. Migration of what exists

Two pieces of today's extension-sniffing fold into modes:

- **`comment-prefix`** (a buffer primitive that inspects the file name)
  becomes: read the current major mode's `:comment-prefix`. `comment-line`
  is unchanged — it just gets the prefix from the mode.
- **`languageForName`** (the renderer's extension → highlighter map)
  **stays** in v1, per §4. When mode state moves into L2 it can be
  replaced by the mode's `:highlight`.

No behaviour is lost in the migration; the rules just gain a home.

## 11. What modes are *not* (v1 scope)

- No mode-local variables (Emacs's buffer-local variables). Modes
  configure via their keymap and fields only.
- No mode-specific indentation engine — `:indent` can be added to the
  mode map later when structural indentation is built.
- No automatic mode detection from file *content* (shebang lines, etc.)
  — only from the name.

## 12. Phasing

1. **Core.** The mode data structure; the registry and
   `choose-major-mode!`; per-buffer state (§4B); `string-suffix?`;
   `fundamental`/`lisp`/`markdown`/`javascript` modes; the modeline
   shows the mode name; `comment-prefix` reads the mode. Modes are real
   but still "passive" — they carry data, no keymap composition yet.
2. **Keymap composition.** The `handle-key` / `active-keymap` change of
   §6; mode keymaps shadow the global map.
3. **Minor modes and hooks** (§7–§8).
4. **Later.** Promote mode state into L2; drive highlighting from
   `:highlight`; mode-local variables; content-based detection.

Each phase is independently shippable, branch-tested, and leaves the
editor working.

## 13. Open questions for the architect

1. **Mode state — L2 slot or stdlib map?** §4 recommends the stdlib map
   for v1. Agree, or put it in L2 now?

Put it in L2 now.

2. **Highlighting** — accept extension-based highlighting in v1 (§4,
   §10), or hold modes until they can drive it?

extension-based highlighting works for now, but it ultimately needs to
be located in the mode. Once modes are in L2, we can drop extension-based highlighting.

3. **Pattern matching** — filename suffixes enough for v1, or are globs
   wanted from the start?

Filename suffixes are enough for now.

4. **`define-mode` sugar** — plain map literals for v1 (this proposal),
   or a macro now?

Build a macro now.

5. **Minor-mode precedence** — most-recently-enabled first (this
   proposal), or an explicit priority field?

Let's have an explicit priority field.

6. **Scope of v1** — is Phase 1 + Phase 2 the right first delivery, or
   should Phase 1 ship alone first?

Build Phases 1 and 2 together.

