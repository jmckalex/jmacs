# The Model-B primitive split

> Status: living document, written as the server-side stdlib port grows.
> Companion to `architect-notes.md` (the rolling Model-B log) and
> `plans/MULTI-WINDOW-MODEL-B.md` §5 (the model-vs-render change surface).

## Why this document exists

The command spine (`spine.js`) loads `commands.lisp` + `editing.lisp`
verbatim and runs them against a real L2 buffer through the real
`createBufferPrimitives`. Completing Model B means loading the **rest of
the stdlib server-side**. But most stdlib files are written against *host
primitives*, and those primitives fall into two very different worlds:

- **Model-side** primitives touch only buffer/interpreter state. The
  server *is* the authority for that state, so it can provide these
  directly — and it must, because the buffer lives in the server.
- **Render-side** primitives touch the screen: pixel measurement, DOM,
  the pane tree, view rendering, the system clipboard, MathJax, etc. The
  server (an Electron `utilityProcess` = a headless Node child) has no
  business doing these. Each one becomes either (a) a **down-channel
  view-update message** the client executes, or (b) a **stub/no-op** for
  now (the command resolves and its model effect, if any, runs; its
  visual effect is deferred).

Once a primitive is categorised, porting the stdlib file that uses it is
mechanical: provide the model-side ones, route or stub the render-side
ones, then load the file verbatim. **This table is the deliverable** —
it turns the remaining port from research into bookkeeping.

## The three categories

| Category | Meaning | Where it lives under Model B |
|---|---|---|
| **model** | Pure buffer/interpreter state. | Server provides it directly (already does, via `createBufferPrimitives`, or a small server-side helper). |
| **render-message** | A visual effect the client owns. | Server turns the call into a `VIEW`/scroll/`SNAPSHOT` message; client executes the pixels/DOM. |
| **stub** | Visual/system effect not yet wired. | Server no-ops it (or returns a harmless default). The command still loads + dispatches; the effect is deferred. Documented so it's a known gap, not a silent break. |

A useful litmus test: **could two windows showing the same buffer
legitimately disagree about the answer?** If yes (scroll position, pixel
height, which pane is focused, this window's minibuffer) it is per-client
→ render-side. If no (the buffer text, the kill ring, a major mode, a
customize value) it is shared → model-side.

## The split, by primitive family

### Buffer / editing — **model** (already provided)

The whole `createBufferPrimitives` surface is model-side and the spine
already supplies it: `point`, `mark`, `insert!`, `delete-backward!`,
`delete-forward!`, `delete-region!`, `buffer-text`, `buffer-substring`,
`buffer-length`, `buffer-line-count`, `goto!`, `cursor-*!`, `set-mark!`,
`clear-mark!`, `region-active?`, `region-text`, `line-start`, `line-end`,
`line-indent`, `word-forward-offset`/`word-backward-offset`,
`sentence-*-offset`, `fill-paragraph!`, `begin/end-change-group!`,
`make-marker`/`marker-position`/`set-marker!`/`release-marker!`,
`buffer-major-mode`/`set-major-mode!`, `buffer-minor-modes`/
`set-minor-modes!`, `view-name`/`set-view-name!`, `undo!`/`redo!`,
multi-cursor (`add-selection!`, `selections`, `collapse-to-primary!`,
`cursor-count`).

These are the bedrock: every model-heavy stdlib file is written against
them and "just works" server-side. (Markers/multi-cursor *render*
client-side, but the primitives themselves are model state.)

### Echo area / minibuffer — **render-message** (already wired)

| Primitive | Category | Server behaviour |
|---|---|---|
| `show-status!` / `clear-status!` | render-message | sets the echo string, broadcasts a `VIEW` |
| `open-minibuffer!` | render-message | sends a `VIEW` with `minibuffer.active`; the client shows the prompt and replies with minibuffer intents |
| `recenter!` | render-message | server picks the line (it knows point), sends a `scroll` request; client does the pixels (§5d, the *easy* direction) |

### Customisation — **model** (load) + **stub** (interactive openers)

| Primitive | Category | Note |
|---|---|---|
| `defcustom`, `custom-register!`, `custom-value`, `custom-apply!`, `custom-default`, `custom-state`, … | model | pure registry state in `custom.lisp`; loads + runs server-side unchanged |
| `write-custom-file!` | stub | persistence; only called by `save-customizations` (an interactive action), never at load |
| `open-customize!` / `open-customize-group!` / `open-customize-variable!` | stub | open a render-side customize view; the `customize` command resolves but the panel is deferred |

`*tab-width*` / `*indent-tabs-mode*` and the `-tab-width-effective` /
`-indent-tabs-effective` helpers (`indent.lisp`) are **model** — they read
the buffer's major mode + the custom registry. `line-ops.lisp` indent /
outdent depend on them and so are fully model-side.

### Modes — **model** (load) + **stub** (host sync)

| Primitive | Category | Note |
|---|---|---|
| `define-mode`, `register-mode`, `mode-for-name`, `switch-major-mode`, `enable-minor-mode`/`disable-minor-mode`, `minor-modes`, `add-hook`/`remove-hook`, `major-mode-name`, `resolve-keymap`, `major-mode-keymap` | model | `modes.lisp` is almost pure Lisp over buffer primitives — loads + runs server-side |
| `register-mode-menu!` / `mode-menu-sections` | model | pure registry; the *rendering* of the menu is render-side, but the registry is shared state |

The major-mode **keymap chain** must move into the spine's `handleKey`:
before the global table, consult the active buffer's major-mode keymap
and the active minor-mode keymaps (and `*key-reader*` for
`read-next-key`). This is what makes a mode's bindings (`C-c b` in
Markdown) dispatch server-side. Implemented in `spine.js`
(`resolveModeBinding`).

### Kill ring / yank — **model** + **stub** (system clipboard)

| Primitive | Category | Note |
|---|---|---|
| the `*kill-ring*` list, `kill-ring-add!`, `yank`, `yank-pop`, `kill-line`, `kill-word`, `copy-region`, `kill-region`, … | model | `kill.lisp`/`yank-pop.lisp` are ordinary Lisp over buffer primitives + the ring (shared interpreter state) |
| `clipboard-set-text!` / `clipboard-text` | stub (server-local) | the *interprogram* cut/paste edge. The server keeps an in-memory clipboard so the ring works fully + round-trips; true OS-clipboard sync is a render/main-process concern, deferred. (A future wiring: a `clipboard` render-message both ways.) |

**Subtlety — `*last-command*`.** `yank-pop` is valid only immediately
after `yank`/`yank-pop`, which it tests via `*last-command*` (set by
`run-command` in `commands.lisp`). For that to be true server-side, *all*
command dispatch must go through `run-command`. The spine's `handleKey`
already routes bound keys through `run-command`; the one gap was bare
self-insert (it called `buffer.insert` directly, never touching
`*last-command*`). Fixed: self-insert now clears `*last-command*` so a
yank-pop after typing is correctly rejected. (This is exactly the kind of
shared-history-state subtlety Model B forces you to get right, and it's
cheap once spotted.)

### Search / isearch — **stub** (the loop is host-owned)

| Primitive | Category | Note |
|---|---|---|
| `start-search!` / `start-search-backward!` | stub | `search.lisp`'s two commands just *begin* an incremental search; the actual isearch loop (per-keystroke match + highlight + minibuffer) lives in the host (renderer). Server-side this is a **render-message**-shaped feature — the right port is a server-driven search state machine + a client highlight overlay — but that's a whole slice of its own. For now the commands resolve and the loop is stubbed (documented gap). |
| `regex-search.lisp` | deferred | same shape, plus a regex overlay; not ported. |

This is the honest "render-side dependencies too entangled to port
cleanly now" case the brief allows: search's value is the *interactive
loop*, which is render-side, so loading `search.lisp` only gives you two
commands that point at an unbuilt loop. Documented, deferred.

### View / pane addressing — **render-message** / deferred

`view-primitives.js` (`current-view`, `view-list`, `switch-to-view!`,
`new-view!`, `kill-view!`, `toggle-minimap!`, …) and
`pane-primitives.js` (splits, the pane tree, `swap-panes!`) are about the
**window's pane tree and which view is focused** — inherently per-client
render state. Under Model B these become a negotiated conversation
between the server (which can own a logical view list) and each client
(which owns its pane geometry). Out of scope for this slice; the files
that need them (`views.lisp`, `panes.lisp`, `tabline.lisp`, `minimap.lisp`,
`directory-tree.lisp`, …) are **not** ported. Stubbed where a loaded file
references one incidentally.

### Live preview / MathJax / element views — **render-message**, deferred

`markdown-preview!`, `math-preview!`, the math-preview replaced-range
rendering, `open-element-view!`, the Atari/bib-search element views — all
pure render-side (iframes, MathJax, custom elements). The *commands* that
trigger them (`markdown-preview`, `toggle-math-preview`) load and resolve
when their primitive is stubbed; the visual effect is a render-message to
build later. For the Markdown port, `markdown-preview!` / `math-preview!`
are **stubs**; everything else in `markdown.lisp` (the formatting,
heading, list, surround commands + the math-symbol minor mode) is
**model**.

## What this means for the remaining port

With the table above, each not-yet-ported stdlib file resolves to a
recipe:

1. List the host primitives it calls (`grep` for non-`define`d symbols).
2. Look each up here (or extend the table with a new family).
3. Provide the **model** ones (usually already there), route the
   **render-message** ones to a `VIEW`/scroll/`SNAPSHOT`, **stub** the
   rest.
4. Load the file verbatim; add a headless test that drives one of its
   commands through the spine and asserts the buffer/mirror result.

The remaining genuinely-hard work is concentrated in the
**render-message** families that need a real protocol both ways — the
isearch loop, the pane/view negotiation, MathJax/preview, the
measurement conversation's *hard* direction (§5d). Those are slices, not
table rows. Everything model-side is now mechanical.

## Ported so far (this slice)

See `architect-notes.md` for the running record. As of this slice, loaded
server-side verbatim on top of `commands.lisp` + `editing.lisp`:
`custom.lisp`, `indent.lisp`, `modes.lisp`, `math-preview.lisp`,
`kill.lisp`, `yank-pop.lisp`, `line-ops.lisp`, `search.lisp` (commands
only; loop stubbed), `markdown.lisp` (a real major mode through the
server). Each driven headlessly through the spine.
