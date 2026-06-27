# Plan — server-authoritative key dispatch (one keymap, G5)

**Status: DESIGN, awaiting sign-off on §4 (vocabulary), §5 (directive schema),
§8 (phasing).** Branch: `spine-keymap-from-lisp`, off `main`.

This supersedes the earlier "make keymap.lisp authoritative" Option-A draft.
Jason's call (2026-06-27): this is the **start of G5** — flag-off (the
in-renderer interpreter) is being **retired**, so `keymap.lisp` can be
rewritten freely for the Model-B world. There must be **one** key-handling
system: the server resolves every key; anything a renderer must *do* comes
back as an explicit **client directive** that can target any subset of windows.

## 1. The principle

> The server is the only thing that resolves a key. A renderer-side effect is
> never decided client-side — it is an instruction the server sends to a
> chosen set of clients.

This is what makes commands like `close-other-windows`, `quit`, or
`toggle-theme-everywhere` expressible: the command runs **once** on the server
(the `utilityProcess` spine), which then addresses *whichever* clients it wants.
A keystroke in window A can shut windows B and C.

## 2. Why two systems exist today (the drift we're removing)

Under Model B the spine runs in an Electron `utilityProcess`; each renderer
window is a thin client over a `MessageChannelMain` port. Key dispatch is
currently split across **three** places that drift:

- **Spine global chords** — hand-written JS tables `KEYMAP`/`CC_MAP`/`CX_MAP`
  (`apps/desktop/mwb/spine.js:373/466/477`) + a JS chord state machine in
  `handleKey` (`spine.js:3529`). Server-safe commands only.
- **Spine mode chords** — a *separate* Lisp resolver `-spine-resolve` /
  `-spine-chord-map` (`spine.js:2099`) over `(minor-mode-keymaps) +
  (major-mode-keymap)` — **no global map**.
- **Renderer (flag-off)** — `packages/renderer/src/keymap.js` `resolveKey` +
  `keymap.lisp` consumed by the in-renderer interpreter. Retired by G5.

The symptom that started this: `M-left`/`M-right` (word motion) live in
`keymap.lisp` but were never mirrored into the spine's JS table, so Cmd+←/→ do
nothing under Model B. Confirmed: the renderer sends Cmd+← as
`{key:'ArrowLeft', meta:true}` → `keyEventToString` → `M-left` (correct) →
KEY intent to server → the spine's JS table has no `M-left` → no-op.

## 3. The target architecture

```
 renderer (client)                         spine (utilityProcess)
 ─────────────────                         ──────────────────────
 keyEventToString(event) ── KEY intent ──▶ handle-key (keymap.lisp)
   (IME/composition guard,                   ├─ resolve via keymap-chain
    no local resolution)                      │   (minor → major → the-keymap)
                                              ├─ prefix? hold chord state (Lisp)
                                              ├─ command? command-registered?
 ◀── CLIENT_DIRECTIVE(targets,name,args) ─┤   │   ├─ yes → run-command
   apply directive to this window             │   │   └─ no  → no-op + status
   (and the server may have sent the          ├─ buffer edit → already synced
    same directive to other windows)          └─ self-insert → insert! + echo
```

- **`keyEventToString` stays in the renderer** (`packages/renderer/src/keymap.js:163`)
  — it already yields the right names; it's pure event→string, no resolution.
- **The client forwards every key** as a `KEY` intent (it already does:
  `server-view-client.js:20`). The client does **no** keymap resolution — the
  current local `C-x C-c` quit special-case (`server-view-client.js:315`) is
  **removed** and becomes a server `quit` command that emits a `close-window`
  directive to `self` (§5).
- **`keymap.lisp` is the one keymap**, resolved by the server through its own
  `handle-key` / `lookup-key` / `keymap-chain` / `-prefix-maps-for`
  (all already implemented in `keymap.lisp`). The spine's JS tables and
  `-spine-resolve` are **deleted**.
- A command whose effect is renderer-side calls a host primitive that **emits a
  client directive** (§5) instead of mutating a server buffer.

This is "Option B" (delegate to Lisp `handle-key`) — now unambiguous because
flag-off is gone, so there is no second consumer of `keymap.lisp` to perturb.

## 4. Vocabulary convergence (NEEDS SIGN-OFF)

`keymap.lisp` (inherited, pre-Model-B) binds several keys to **renderer**
command *names* the spine registers under **different** names. Today these keys
work via the JS tables; switching to `keymap.lisp` unchanged would break them.
We converge on **one** name per command. Proposed: the server/Emacs name wins,
and `keymap.lisp` is edited to use it (we own `keymap.lisp` now).

| Key      | keymap.lisp (old) | spine (server)            | proposed canonical |
|----------|-------------------|---------------------------|--------------------|
| `M-x`    | `execute-command` | `execute-extended-command`| `execute-extended-command` |
| `C-x b`  | `switch-view`     | `switch-to-buffer`        | `switch-to-buffer` |
| `C-x C-b`| `buffer-menu`     | `list-buffers`            | `list-buffers`     |
| `C-x k`  | `kill-view`       | `kill-buffer`             | `kill-buffer`      |
| `C-x n`  | `scratch-buffer`  | (none yet)                | port `scratch-buffer` server-side |

**Open question for Jason:** `switch-view`/`kill-view` reflect the editor's
*view* model (per-tab surface), not just *buffer*; confirm these are functional
synonyms server-side (they should be under Model B — a window shows one buffer)
or whether the buffer/view distinction must be preserved in the names.

Genuinely **server-only** bindings absent from the old `keymap.lisp` — **add**
to `keymap.lisp` (it's the source of truth now):
- `C-x 5 2` → `new-window` (spine-only; the old single-window keymap had no
  frame prefix).
- `C-x 5 0` / `C-x 5 1` → `close-window` / `close-other-windows` (NEW commands,
  the proving ground for §5 — see P2).

## 5. The client-directive channel (NEEDS SIGN-OFF)

Generalize the existing `RUN_CLIENT_COMMAND` (protocol.js:152, built for
element-views) into a first-class directive with **window targeting**.

**New message** (protocol.js): `CLIENT_DIRECTIVE`
```
{ type: 'client-directive',
  targets: 'self' | 'others' | 'all' | number[],   // client indices
  directive: { name: string, args: <json> } }      // serializable only
```

**Lisp host primitive** a command body calls:
```lisp
(emit-client-directive! targets name . args)   ; targets: 'self 'others 'all or a list of ids
```
e.g.
```lisp
(defcommand close-other-windows ()
  "Close every window except this one (C-x 5 1)."
  (emit-client-directive! 'others 'close-window))
```
The spine resolves `targets` against its live client set (it already tracks
`paneModels` keyed by client index + the active client), serializes the
directive, and posts it to each selected port. The renderer has a directive
handler that maps `name` → a renderer action (close the window, toggle a fold,
re-theme, …). **Constraint:** directive args are structured-clone-safe — no
raw Lisp symbols over the port (the known gotcha); send strings/plain data.

This subsumes `RUN_CLIENT_COMMAND` (`self` target) and adds the multi-window
reach. Migration: re-express the element-view `RUN_CLIENT_COMMAND` callers as
`CLIENT_DIRECTIVE … targets:'self'`, then retire the old message.

## 6. The guard (mandatory)

`run-command` (`commands.lisp:136`) does `(if (nil? spec) ((eval name)) …)` —
for an **unregistered** name `(eval name)` **throws** (unbound symbol), it does
*not* no-op. `keymap.lisp` binds ~30 commands not yet ported server-side
(folding, help/describe, sticky-notes, notebooks, eval-at-point …). So
`handle-key`'s command branch must check `command-registered?` (`commands.lisp:25`,
already exists) before `run-command`; otherwise a no-op + an optional
"X is not available" status. We own `keymap.lisp`, so the guard goes directly
into its `handle-key`.

## 7. Spine-specific behaviors to re-home into the Lisp/server flow

The JS `handleKey` wrapper currently adds three things `keymap.lisp`'s
`handle-key` does not. Under full delegation they move:

1. **Self-insert `*last-command*`** — the JS path sets
   `(set! *last-command* 'self-insert)` before inserting (yank-pop
   invalidation). `keymap.lisp`'s self-insert branch is a bare `(insert! key)`.
   **Fix:** add the `*last-command*` set to `keymap.lisp`'s self-insert branch.
2. **Undo/redo resync flag** — the server must know a history op ran (it
   resyncs full text+cursors). `run-command` sets `*this-command*`; the thin
   JS wrapper reads it after `handle-key` returns and sets `lastWasHistoryOp`.
3. **IME / composition + optimistic echo** — client-side concerns; the client
   keeps its composition guard before sending KEY. The thin server wrapper
   keeps only the post-dispatch history check.

So the spine's `handleKey(key)` JS shrinks to: `interpreter.call('handle-key',
key)` then the history-op post-check. All resolution, chord state, self-insert,
run-command, and the guard live in `keymap.lisp`.

## 8. Phasing (all on the branch; merge only when the whole thing is perfect)

Jason: land nothing in `main` until the entire feature works on the branch.
Internal commits stage it so each step is live-verifiable:

- **P1 — one resolver.** Delete the JS `KEYMAP`/`CC_MAP`/`CX_MAP` +
  `-spine-resolve`/`-spine-chord-map`. Load `keymap.lisp` into the spine;
  delete the `the-keymap = {}` shim. Route `handleKey` → `handle-key`. Add the
  guard (§6) and the self-insert/history re-homing (§7). Reconcile vocabulary
  (§4). **Visible win:** `M-left`/`A-left` word motion, shift-arrow word
  select, `C-x +`/`x`/`X`/`C-arrows`, the `C-h`/`M-n` prefixes engaging,
  `C-c d`-in-Markdown fallthrough — all start working; all existing chords
  still work. spine.test.js green throughout.
- **P2 — the directive channel.** Add `CLIENT_DIRECTIVE` + `emit-client-directive!`
  (§5). Migrate window lifecycle: `quit`/`close-window`/`close-other-windows`
  as server commands emitting directives; remove the client's `C-x C-c`
  special-case. **Proves** the multi-window round-trip end to end.
- **P3 — port the renderer-only commands** incrementally onto the directive
  channel: folding, help/describe (`C-h` family), themes/faces, sticky-notes,
  eval-at-point, notebooks. Each becomes a real server command emitting a
  directive; the §6 guard's no-op list shrinks as they land.

## 9. Tests + live-verify

- `apps/desktop/mwb/spine.test.js` drives `handleKey` (prefix chords,
  self-insert) — keep green at every commit; it's the safety net.
- Add: `M-left`/`M-right` → backward/forward-word; `C-x C-s` still resolves;
  an unregistered binding no-ops (doesn't throw); auto-pair `(` still runs
  `auto-pair-open-paren`; `C-c d` in a Markdown buffer falls through to the
  global `add-cursor-next`.
- Directive tests (`protocol.test.js` / a spine test): `emit-client-directive!
  'others …` reaches every client but the originator; `'self` only the caller.
- **Live-verify (quit + relaunch — spine is the utilityProcess):** word motion;
  every `C-x` chord; `C-x 5 2` new window; `C-x 5 1` closes the others;
  `C-x C-c` quit; typing + auto-pair; edit a binding in `keymap.lisp`, relaunch,
  see it take effect (the disk-editable payoff). Build side can't launch the
  GUI — Jason live-verifies each phase.

## 10. Risks / watch-points

- **Core dispatch** — a mistake breaks every key. Incremental commits, keep
  spine.test.js green, hand each phase to Jason for live-verify before the next.
- **Load order** in `SPINE_STDLIB`: `keymap.lisp` must load **before**
  `auto-pair.lisp` (so its char bindings layer onto the real `the-keymap`) and
  after the command-defining files it references by symbol (symbols resolve
  late, so mostly flexible; `the-keymap` must exist before `handle-key` runs).
  Remove the now-duplicate spine definitions (`the-keymap` shim,
  `-spine-resolve`, the spine's `read-next-key`, the minimal `keyboard-quit`) —
  `keymap.lisp`'s become the sole versions.
- **Serialization**: directives cross the process boundary — structured-clone
  safe only (no raw Lisp symbols/values; send strings/plain data).
- `spine.js`/`server.js` aren't in the `node --check` suite; `spine.test.js`
  exercises them. `spine.js` reads as binary to plain grep — use `grep -a`.
- **`describe-key`/`C-h k` "read the next key"** is a separate unwired item
  (the reader, not the prefix). `C-h` becomes a live prefix in P1; the
  read-next-key reader lands with the help port in P3 — note, don't scope-creep.
