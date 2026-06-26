# Multi-window — Model B: central server, windows as clients

> The companion to **`MULTI-WINDOW.md`** (Model A: independent windows). Same
> product goal, the opposite architecture. This is the **Emacs-daemon /
> `emacsclient`** model: **one Lisp interpreter + one editor model = a central
> server**; each window is a thin(ish) **display client** with its own
> JavaScript/Chromium isolation. Written so the two can be built in parallel
> worktrees and judged on evidence (§10).
>
> Jason's framing (2026-06-22): keep a single globally shared Lisp interpreter;
> windows are clients served by a common central source. We still get isolation
> from the separate JS engines per window, but far richer cross-window
> communication. This plan makes that concrete and honest about its costs.

---

## 1. The goal

Multiple top-level windows (same as Model A) — **but with Emacs-style
integration**: one shared world. The same buffer can be displayed in several
windows; a command in one window operates on state every window sees; a
customization (`defcustom`, `define`, a theme) is instantly global; kill-ring,
registers, markers, the buffer list are shared by nature. The thing Model A
*can't* cheaply do — one buffer live in two windows — is the thing Model B gets
for free, because the buffer lives in the one place everybody is looking at.

---

## 2. The core inversion

Model A keeps the whole editor (interpreter + buffers + views + commands) **per
renderer** and isolates windows by running more renderers. Model B **moves the
model out of the renderer into a central server** and turns renderers into
clients of it.

```
            Model A                              Model B
  ┌──────────┐   ┌──────────┐         ┌──────────┐   ┌──────────┐
  │ window 1 │   │ window 2 │         │ client 1 │   │ client 2 │   (renderers:
  │ interp + │   │ interp + │         │ render + │   │ render + │    DOM, view.js,
  │ buffers  │   │ buffers  │         │ input    │   │ input    │    input, own V8)
  └────┬─────┘   └────┬─────┘         └────┬─────┘   └────┬─────┘
       │ files/IPC    │                    │  protocol    │
       └──────┬───────┘                    └──────┬───────┘
        main (stateless)                   ┌──────┴───────┐
                                           │   SERVER     │  one Lisp interpreter
                                           │ interp +     │  + the buffer model +
                                           │ buffers +    │  the global env +
                                           │ commands +   │  commands/keymap +
                                           │ project/sess │  project/session model
                                           └──────────────┘
```

The Emacs analogy is exact: `emacs --daemon` is the server (one Lisp, all the
buffers); `emacsclient` frames are the clients (displays + input). Close a
frame, the buffers live on; open a new frame, it sees them.

**What we keep:** per-window **render** isolation — each client is its own
renderer process (own V8, own DOM). A rendering crash or hang in one client is
contained; the server and the other clients survive; main respawns the client
and it re-attaches (like `emacsclient` reconnecting).

**What we trade:** **state** isolation. There is now one shared model. This is
the Emacs fragility Jason flagged — but it is contained to a single, well-
defined layer (the server), with the render layer still isolated, and mitigated
deliberately (§7). It is NOT Emacs's "implicit global everything": the
client/server boundary is explicit and typed; behind it, the model is shared.

---

## 3. THE foundational decision: where the server runs

The model (interpreter + buffers + env) is pure JavaScript with no DOM
dependency in its *core* — only its host **primitives** touch the renderer
today. So the server is a JS context that is NOT a visible renderer. Three
homes:

### (i) A dedicated `utilityProcess` — **recommended**
Electron's `utilityProcess` spawns a Node child. Run the Lisp server there.
- **Pro:** the UI-main thread stays free (window management, IPC, the menu, the
  OS event loop never block on Lisp); the server is its own process, so a server
  crash → respawn without taking down windows; it's Node, so the server does its
  **own file/process I/O directly** (no IPC for `save-buffer`, `latex-compile`,
  directory listing — a real simplification vs today's renderer→main hops).
- **Con:** `utilityProcess` can't directly IPC a renderer; main bridges, or we
  hand each client a `MessagePort` to the server (Electron supports
  `MessageChannelMain` → transfer a port to a renderer) for a near-direct
  client↔server channel.

### (ii) The main process
Simplest (no extra process; main already does IPC). **But** a long synchronous
Lisp command blocks the main thread → **every window freezes and window
management stalls**. This is Emacs's "Emacs is hung," at the worst possible
layer. Rejected unless §8's interruption story is airtight.

### (iii) A hidden renderer (`BrowserWindow {show:false}`)
The interpreter keeps a DOM (unused) and `requestAnimationFrame`. Clients talk
to it via main or a `MessagePort`. Workable, but carries Chromium overhead for a
process that renders nothing, and keeps the "interpreter assumes a renderer"
coupling we'd rather cut.

> **Recommendation: (i) utilityProcess**, with `MessagePort` channels to each
> client. Decide early; everything else hangs off it.

---

## 4. The client↔server protocol (the design crux)

Two streams: **input up**, **state down**.

- **Up (client → server):** key events (already normalised to `keyEventToString`
  names — do that client-side, send the string), mouse/click intents, focus,
  viewport resize, scroll *intent*, and "open this file here" requests. The
  client sends *intent*, not edits.
- **Down (server → client):** what to render — buffer content/deltas for the
  buffers this client shows, cursor/selection, overlays/markers, the pane tree,
  modeline, toolbar/lens/spine data, minibuffer state, status messages.

### The big axis — thin client vs replicated client
- **Thin client:** the server computes render-ops (or even pixels) and pushes
  them; the client paints dumbly. Maximal server authority, but it means
  **rewriting view.js** (tree-sitter highlighting, folding, measurement, math
  preview, the toolbar) as a server-driven render protocol. Enormous.
- **Replicated client — recommended:** the server is **authoritative** for
  buffers + state; each client keeps a **synced mirror of the buffers it is
  displaying** and renders them **locally with the existing view.js stack,
  unchanged**. Commands run on the server (canonical); the server emits **buffer
  deltas** to every client showing that buffer; each client applies the delta to
  its mirror and re-renders locally.

  This is the key to tractability: **don't rewrite rendering — replicate state
  and render locally.** Highlighting, folding, the whole renderer keep working
  as-is, reading a local buffer mirror instead of the local canonical buffer.

So the protocol carries **buffer deltas + view-state**, not pixels.

### Per-window vs per-buffer state (the Emacs window/buffer split)
The server distinguishes **buffer state** (text, markers, overlays, major mode —
shared across all windows showing it) from **window state** (point, mark,
`window-start`/scroll, the pane tree — per client). Two windows on one buffer
share the text but have independent cursors and scroll. The server tracks a
per-client view table; deltas to shared text fan out to all viewers, while a
cursor move in window A touches only window A's window-state.

### Latency budget
Every keystroke round-trips client → server → delta → client-render. Target
**< 16 ms** end-to-end so typing feels native. Tactics:
1. **Local echo / optimistic insert:** the client applies a plain
   self-insert to its mirror **immediately** and sends the intent; the server
   confirms (and reconciles if a hook changed things). Self-insert is the 99%
   path and must never wait on a round-trip.
2. Tight binary-ish delta encoding; `MessagePort` direct channels (no main hop).
3. The server's per-keystroke work (keymap dispatch + the command) must stay
   cheap; heavy commands are the exception, not self-insert.

Validating that local-echo + round-trip *feels* instant is **the** make-or-break
experiment (§9 Phase 0).

---

## 5. The change surface (what moves, what stays)

### Moves to the SERVER (utilityProcess)
- The Lisp `interpreter` + global env (today `app.js:3806`).
- The **buffer model** — `packages/storage` (L1), `packages/buffer` (L2:
  markers, overlays, modes), and the kill-ring/registers.
- **Commands + keymap dispatch** — the whole `defcommand` surface, keymap
  resolution, the minibuffer state machine, the project/session model.
- The **logical** view/pane tree (which buffer shows in which pane, splits) —
  the *structure*. Rendering of it stays client-side.
- The host operations that are really I/O — file read/write, directory listing,
  process spawn (`run-process!`), recovery/autosave. In a Node utilityProcess
  these become **direct** (a simplification), except dialogs/window ops which
  must round-trip to main (only main shows native dialogs / makes windows).

### Stays in the CLIENT (renderer)
- `packages/renderer` `view.js` and everything it drives — DOM, tree-sitter
  highlight, folding, measurement (line heights, wrap, scroll geometry),
  overlays/widgets, math preview, the minimap, the toolbar/lens/spine/dir-tree
  DOM. All of it renders from the **local buffer mirror**.
- Input capture + normalisation (→ key-string, mouse intents).
- A **local mirror** of each displayed buffer + the client's window-state.

### The genuinely hard refactor
Today the interpreter, buffers, commands, and `view.js` are one renderer module
graph calling each other **synchronously** (a command calls `insert!`, the
buffer mutates, `view.js` reads it and repaints, all in one tick). Model B cuts
that graph in two with an **async protocol** at the seam. The bulk of the work
is: (a) defining that seam, (b) making `view.js` render from a mirror + deltas
instead of the live buffer, (c) making buffer-mutating primitives server-side
operations that emit deltas, (d) measurement that the server needs (e.g. for
`window-start` after a wrap) being requested from the client. (d) is subtle —
the server owns wrapping/scroll *decisions* but the client owns *measurement*;
they must converse.

---

## 6. Communication possibilities (the payoff — the whole point)
- **One buffer in N windows** — intrinsic: the buffer lives in the server; every
  client showing it gets deltas. Edit in window A → window B updates. (Model A's
  expensive, rejected feature; here it's the default.)
- **Cross-window commands** — trivial: every command runs in the one server env.
  `(other-window-eval …)`, "send this region to that window", "run in all
  windows" are internal calls + targeted renders, not an IPC bus.
- **Live global customization** — one interpreter = one global env. A
  `defcustom`/`define`/theme/keybinding change is **instantly** visible in every
  window (Model A needs an explicit `config:changed` broadcast; here there's
  nothing to broadcast — there's one env).
- **Shared kill-ring, registers, marker rings, buffer list, undo** — all shared
  by construction (undo is per-buffer and server-side → undo in window A affects
  the buffer everyone sees; Emacs semantics, and a feature).
- **A real Lisp REPL that sees everything** — eval in any window's command field
  operates on the whole live world, not that window's slice.

This is the column where Model B wins decisively.

---

## 7. Isolation kept / given up — and the mitigations
**Kept:** per-window render isolation. A client crash/hang/runaway-render is
contained; main respawns it; it re-attaches to the server and re-renders from
current state. Visual bugs don't cross windows.

**Given up:** state isolation — one shared model. A bad extension, an infinite
loop, a corrupt data structure, or a runaway computation affects **all** windows.
Mitigations, in order of importance:
1. **Server in a `utilityProcess`** → a server crash kills only the server;
   main respawns it; clients reconnect. Daemon resilience.
2. **Cooperative interruption** — the eval trampoline already exists (TCO); add a
   **step budget + an interrupt flag** so `C-g`/`keyboard-quit` can actually
   abort a runaway command. Without this, one bad `(while #t …)` hangs everyone
   (the classic Emacs hang). This is **mandatory**, not optional.
3. **Server-side autosave/recovery** — the buffers' unsaved state lives in the
   server's memory; a server crash must not lose work. Move the existing
   recovery/autosave (renderer-side today) into the server; on respawn, recover.
4. **Extension sandboxing (later)** — because the blast radius is now global,
   there's a stronger case for running untrusted extensions with a budget /
   capability limits. Out of scope for v1 but worth noting the model invites it.

The honest summary: Model B reintroduces a *shared* failure domain (the model),
but a **single, named, process-isolated, interruptible** one — not Emacs's
implicit-global-everything. The boundary is explicit; the thing behind it is
shared on purpose.

---

## 8. Risks & landmines
- **Latency** (§4) — the existential risk. If local-echo + round-trip doesn't
  feel native, Model B is a non-starter. Measure first (Phase 0).
- **Blocking** — a long synchronous command freezes all clients until §7.2's
  interruption lands. Server-in-utilityProcess saves *window management* but not
  the *editing* of clients waiting on the server.
- **The model/render split** — the largest single refactor in the codebase;
  `view.js`-reads-buffer-synchronously is everywhere. Risk of a long
  half-working middle.
- **Delta correctness** — markers, overlays, multi-cursor, folding, and undo all
  crossing the server→client replication correctly. Undo policy (server-side,
  shared) must be decided up front.
- **Measurement conversation** (§5d) — server owns scroll decisions, client owns
  pixels; getting `window-start`/centering right across the wire is fiddly.
- **Boot/lifecycle** — the server boots + loads stdlib *before* clients attach; a
  client launching against a not-ready server; respawn/reconnect semantics.
- **Native dialogs / window ops** — must hop server→main (only main can do
  them); a two-hop path for "open file" if it uses a native picker.
- **The host bridge inversion** — file/process I/O moves server-side (good), but
  anything that today assumed renderer context (e.g. `window.host`, clipboard,
  `media://`) needs a home: clipboard + native pickers stay client/main; file +
  process I/O go server.
- **Smoke/screenshot harness** — already can't boot the app (no preload); under
  Model B they'd need to stand up the server too.
- **The just-built toolbar + projects** — both assume the renderer owns the
  interpreter + buffers. They'd move server-side (data) with client-side
  rendering. The toolbar's `define-toolbar-*` collectors run in the server;
  `renderActions`/`renderLens` stay client-side. Plan for the port.

---

## 9. Phased roadmap
**Phase 0 — Stand up the server + ONE client; prove latency.** Extract
interpreter + buffer model + commands into a `utilityProcess`; one window becomes
a client over the protocol (local-echo self-insert + deltas). **No multi-window
yet.** The entire point is to (a) prove the split is buildable and (b) **measure
typing latency** against today's in-renderer baseline. **Exit:** a single window
edits through the server and typing feels indistinguishable from today. *If this
fails, stop and prefer Model A.*

**Phase 1 — Interruption + crash recovery.** The step-budget/`C-g` interrupt;
server-side autosave/recovery; server respawn + client re-attach. (Pulled early
because without it the shared model is unsafe to live in.)

**Phase 2 — N clients, distinct buffers.** Multiple windows attach to the one
server; window registry + focus in main; `window:new/close/focus`; each client
shows its own buffers. (Now it's genuinely multi-window.)

**Phase 3 — One buffer in many windows (the payoff).** Per-client window-state
(point/mark/scroll) over shared buffer state; deltas fan out; cursors are
per-window. The feature Model A can't do.

**Phase 4 — Shared-world niceties.** Cross-window commands (`window-eval`,
move-view — trivial here), shared kill-ring/registers exposed, the global REPL.

**Phase 5 — Polish.** Window menu/titles, platform menu correctness, the
daemon lifecycle UX (start/attach/detach), docs.

---

## 10. The bake-off — how to judge B vs A
Build **Phase 0 of each** in parallel worktrees and decide on evidence, not
taste. The axes:

| Axis | Model A (independent) | Model B (server/clients) |
|---|---|---|
| **Responsiveness** | native (all local) | **must prove** (round-trip + local echo) |
| **Cross-window integration** | weak; needs an explicit bus; no same-buffer | **rich; shared world; same-buffer free** |
| **Robustness / blast radius** | strong (full per-window isolation) | render isolated, **model shared** (needs §7 interrupt + respawn) |
| **Implementation cost/risk** | moderate (persistence + routing) | **high** (the model/render split) |
| **Identity fit** | Nova / VS Code | Emacs daemon |
| **What it unlocks later** | clean, simple, boring | a genuinely shared programmable world |

**The decisive experiment is Phase 0 latency.** If Model B can type as fast as
today *and* the split doesn't metastasise, its integration ceiling is far higher
and it may be worth the cost. If latency or the split bite, Model A is the safe,
shippable answer. Measure, then choose.

### Worktree setup for the bake-off
Two worktrees off a common base (recommend the current `main` tip, or this
`multi-window-plan` branch so both plans travel along):
```
git worktree add ../godot-mw-a -b multi-window-a <base>   # builds Model A
git worktree add ../godot-mw-b -b multi-window-b <base>   # builds Model B
```
Each worktree is a full checkout on its own branch; build the respective Phase 0,
compare, keep the winner, `git worktree remove` the other. (Note: branch each
worktree explicitly off the intended base — the agent-worktree default can be
stale; verify with `git merge-base`.)
