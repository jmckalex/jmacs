# Plan — server-authoritative key dispatch (one keymap, G5)

**Status: P1 DONE, P2a+P2b+P2c DONE (built+tested) — flip + live-verify + P3
remain (2026-06-27).** Branch: `spine-keymap-from-lisp`, off `main`. Vocabulary
(§4), directive schema (§5), phasing (§8), and the quit UX (§8a: per-buffer
save-some-buffers) all settled with Jason. Suite green throughout (full root
3173/3173). Recovery tags: `p1-keymap-complete`, `p2-directive-channel`.

**Done:**
- **P1 — one resolver** (`p1-keymap-complete`, commits 12c9c5a + d3708b5).
  keymap.lisp is the sole keymap; JS tables / `-spine-resolve` deleted;
  `handleKey` delegates to `handle-key`; guard + history-wrapper +
  self-insert `*last-command*` in place; view-vocab rename.
- **P2a — directive channel** (49b4992). `CLIENT_DIRECTIVE` +
  `emit-client-directive!` + `this/other/all-window-ids` + server routing +
  renderer `applyDirective` hook.
- **P2b — close-window / close-other-windows** (7743216). `C-x 5 0 / 5 1`,
  host close bridge (preload `host.closeWindow` → main `window:close`).
  ⚠️ The host bridge can't be unit-tested — needs live-verify.

- **P2c — quit server-side, save-some-buffers** (`0edd157`). `quit-editor` runs
  the cross-window per-buffer save walk (y/n/!/q) + the final net, then hands
  off via a `quit` directive to `app.js performShutdown`. Reachable via
  `M-x quit-editor`. ⚠️ The client `C-x C-c` special-case is KEPT as a fallback
  (old single-confirm quit) — the flip + live-verify is the next step.

**Remaining:**
- **The C-x C-c flip** — once `M-x quit-editor` is live-verified, remove the
  client `C-x C-c` special-case (`server-view-client.js:315`) so `C-x C-c` →
  server `quit-editor`. One small change; do it after verify so quit is never
  broken untested.
- **P3 — port the renderer-only commands** onto the directive channel
  (folding, help/describe, themes/faces, sticky-notes, eval-at-point,
  notebooks). Each becomes a server command emitting a directive.

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
  **removed** and becomes a server `quit` command. Because the server holds
  every client's state, it can check for unsaved content across the affected
  windows (and prompt / refuse) **before** emitting the `close-window`
  directive (§5) — something a client-local quit could never do.
- **`keymap.lisp` is the one keymap**, resolved by the server through its own
  `handle-key` / `lookup-key` / `keymap-chain` / `-prefix-maps-for`
  (all already implemented in `keymap.lisp`). The spine's JS tables and
  `-spine-resolve` are **deleted**.
- A command whose effect is renderer-side calls a host primitive that **emits a
  client directive** (§5) instead of mutating a server buffer.

This is "Option B" (delegate to Lisp `handle-key`) — now unambiguous because
flag-off is gone, so there is no second consumer of `keymap.lisp` to perturb.

## 4. Vocabulary convergence — view-centric (SIGNED OFF)

Decision (Jason, 2026-06-27): the **view** vocabulary is canonical, not
"buffer". A *view* is the general on-screen surface; only **text** views have a
backing L2 `Buffer` — other views (media, shell, directory, element, …) have a
**data-source** instead. The "buffer" command names in the spine are an
Emacs-era holdover from when every surface was assumed to be text. So the
spine's commands are **renamed to the view vocabulary** (and their references
in `server.js` + tests updated); `keymap.lisp` keeps the view names it already
had, with `buffer-menu` → `list-views`.

| Key      | canonical name     | spine renamed from          |
|----------|--------------------|-----------------------------|
| `M-x`    | `execute-command`  | `execute-extended-command`  |
| `C-x b`  | `switch-view`      | `switch-to-buffer`          |
| `C-x C-b`| `list-views`       | `list-buffers` (keymap.lisp: `buffer-menu`) |
| `C-x k`  | `kill-view`        | `kill-buffer`               |
| `C-x n`  | `scratch-view`     | (port server-side)          |

Implication: `switch-view` / `list-views` must enumerate **all** views (text
*and* data-source), not just text buffers. The internal L2 `Buffer` object
stays a "buffer" (it really is one, when a view has it) — only the
command/user-facing vocabulary goes view-centric.

Genuinely **server-only** bindings absent from the old `keymap.lisp` — **add**
to `keymap.lisp` (it's the source of truth now):
- `C-x 5 2` → `new-window` (spine-only; the old single-window keymap had no
  frame prefix).
- `C-x 5 0` / `C-x 5 1` → `close-window` / `close-other-windows` (NEW commands,
  the proving ground for §5 — see P2).

## 5. The client-directive channel (SIGNED OFF)

Generalize the existing `RUN_CLIENT_COMMAND` (protocol.js:152, built for
element-views) into a first-class directive with **window targeting**.

Decision (Jason, 2026-06-27): targeting is an **explicit array of window ids** —
nothing richer. The server already knows which window is the sender and which
are the rest, so "self" / "others" / "all" are just Lisp helpers that *return*
an id array; the message itself only ever carries a concrete list.

**New message** (protocol.js): `CLIENT_DIRECTIVE`
```
{ type: 'client-directive',
  targets: number[],                              // explicit window ids, always an array
  directive: { name: string, args: <json> } }     // structured-clone-safe only
```

**Lisp host primitive** a command body calls:
```lisp
(emit-client-directive! ids name . args)   ; ids: a list of window ids
```
with id-set helpers the server provides:
```lisp
(this-window-id)     ; the window whose keystroke is running
(other-window-ids)   ; every window except this one
(all-window-ids)     ; every window
```
e.g.
```lisp
(defcommand close-other-windows ()
  "Close every window except this one (C-x 5 1)."
  (emit-client-directive! (other-window-ids) 'close-window))
```
The spine serializes the directive and posts it to each listed window's port.
The renderer has one directive handler that maps `name` → a renderer action
(close the window, toggle a fold, re-theme, …). **Constraint:** directive args
are structured-clone-safe — no raw Lisp symbols over the port (the known
gotcha); send strings/plain data.

This subsumes `RUN_CLIENT_COMMAND` (a one-element id list). Migration:
re-express the element-view `RUN_CLIENT_COMMAND` callers as `CLIENT_DIRECTIVE`
with `(list (this-window-id))`, then retire the old message.

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
- **P2 — the directive channel.** Add `CLIENT_DIRECTIVE` +
  `emit-client-directive!` + the id-set helpers (§5). Migrate window lifecycle:
  `quit`/`close-window`/`close-other-windows` as server commands emitting
  directives, with the server's unsaved-content check before any close; remove
  the client's `C-x C-c` special-case. **Proves** the multi-window round-trip
  end to end.
- **P3 — port the renderer-only commands** incrementally onto the directive
  channel: folding, help/describe (`C-h` family), themes/faces, sticky-notes,
  eval-at-point, notebooks. Each becomes a real server command emitting a
  directive; the §6 guard's no-op list shrinks as they land.

## 8a. P2c — quit server-side (NEEDS A DECISION before building)

Why it was deferred: quit is a **data-safety path** (it kills the server) and
the cross-window save-prompt UX is a genuine fork — not just untestable
plumbing. The current quit (`app.js:2834 quitInteractive`) is renderer-side:
it checks the renderer's **own** `dirtyBuffers` set, then runs the workspace
"Remember this workspace?" prompt, flushes metadata, clears recovery, and calls
`host.quit()`. The flaw you identified: a quit from window A only sees A's
dirty set — buffers unsaved in window B are invisible to A's check. The server
sees all of them.

**Recommended design (for your call):**
1. The client's `C-x C-c` special-case (`server-view-client.js:315`) is
   removed, so `C-x C-c` → server `quit-editor` (keymap.lisp already binds it).
2. `quit-editor` asks the spine for the **cross-window** dirty set (a new spine
   query over the buffer registry — `dirty-buffer-names` / a count), then emits
   a `quit` directive to the originating window **carrying that count/list**.
3. The window's `applyDirective('quit', { dirtyCount, names })` runs the
   existing `quitInteractive`, but the confirm now reflects **all** windows'
   unsaved buffers (passed in), not just its own. The workspace prompt + flush +
   `host.quit()` stay where they are (they're host concerns).

This keeps the proven shutdown sequence, fixes the cross-window blind spot, and
the only new pieces are the spine dirty-query + the directive carry (both
testable). **Open question:** do you want the save-prompt to stay a single
confirm ("Discard unsaved in N buffers?") as today, or become a per-buffer
save/discard flow? And should quit be refused outright when dirty, or always
offer discard? That UX choice is yours.

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
