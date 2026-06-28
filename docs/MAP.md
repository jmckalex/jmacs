# MAP — where to look

A one-page index of the system: for any task, which **one** document to read, and where each responsibility lives. This file exists so that the project can be understood from its artifacts, not from one person's memory. If you are an agent (or a future maintainer) picking up cold, start here.

The rule this index serves: **knowledge that keeps biting belongs in a doc, not in anyone's head.** When you re-derive a stable fact by reading code, that fact wants to be written down here or in the doc this points to.

---

## Reading order for a non-trivial task

1. `HANDOVER.md` (repo root, untracked) — current state, in-flight branch, the immediate next action. Written at the end of each session.
2. `MEMORY.md` (auto-memory index) — pointers to durable facts.
3. This file (`docs/MAP.md`) — find the subsystem you're touching.
4. The **one authoritative doc** for that subsystem (the table below).
5. The relevant `plans/<FEATURE>.md` (read its STATUS block first).
6. The code in your package + its tests.

For views/panes work, `docs/VIEWS.md` is mandatory **first**. For key dispatch / cross-window effects, `docs/MODEL-B-DISPATCH.md` is mandatory first.

---

## The layered model (the slow-changing skeleton)

| Layer | Package | Responsibility |
|---|---|---|
| L0 | `apps/desktop` (Electron main) | Host: file I/O, subprocesses, IPC. |
| L1 | `packages/storage` | The text data structure (rope/piece tree). No semantics. |
| L2 | `packages/buffer` | The Buffer: text + markers + overlays + modes. |
| L3 | `packages/lisp` | The Lisp interpreter (reader, evaluator, primitives). |
| L4 | `packages/renderer` | Views: paint a buffer/model to the DOM, turn keys into commands. |
| — | `packages/view`, `packages/pane` | The View handle and the Pane tree (binary split tree). |
| — | `packages/stdlib` | The Lisp standard library (`*.lisp`) — commands, modes, keymap. |

`docs/ARCHITECTURE.md` describes L0–L4 in prose. **Caveat:** it predates the server and still says "the renderer never modifies state directly / one world." The server architecture below is the current reality; treat ARCHITECTURE.md as background, not the dispatch model.

---

## The architecture: server + thin clients (Model B)

The editor runs as a **server** (the *spine*, an Electron `utilityProcess`, `apps/desktop/mwb/spine.js`) plus one thin **client** per window, each over a `MessageChannelMain` port. The Lisp interpreter runs in the server; the **server resolves every key**; renderer-side effects come back as a **`CLIENT_DIRECTIVE`** that can target any subset of windows. The stdlib slice the server loads is `SPINE_STDLIB` (in `spine.js`). Launched with `GODOT_SERVER=1`.

This is **the** architecture — the older in-renderer interpreter path is gone, not an alternative to keep in mind. Understanding the server/client split is essential before touching dispatch or views.

Authoritative doc for dispatch, the directive channel, embedded-Lisp authoring, and the recurring traps: **`docs/MODEL-B-DISPATCH.md`**.

---

## Subsystem → the one doc to read

| If you're touching… | Read first |
|---|---|
| Views, panes, tablines, display-state ownership | `docs/VIEWS.md` |
| Adding a new on-screen surface (view kind / element-view) | `docs/CUSTOM-VIEWS.md` |
| Key dispatch, keymaps, cross-window effects (Model B) | `docs/MODEL-B-DISPATCH.md` |
| The Lisp dialect (syntax, semantics, truthiness) | `docs/spec/lisp.md` |
| Major/minor modes | `docs/spec/modes.md` |
| Running the app + verifying a change | skill `run-and-verify` (`.claude/skills/`) |
| Agent safety / permissions / branch discipline | `docs/GUARDRAILS.md` + `CLAUDE.md` |
| The vision / why the editor is shaped this way | `docs/VISION.md` |
| A specific in-flight feature | `plans/<FEATURE>.md` (STATUS block first) |

---

## How these docs nest (the drill-down)

The docs form a hierarchy, so **"I need to know X about Y"** resolves top-down to the code you'll edit:

1. **`docs/MAP.md`** (this file) — the **router**. Subsystem → its playbook.
2. **Subsystem playbook** (e.g. `docs/MODEL-B-DISPATCH.md`, `docs/VIEWS.md`) — the **model**: seams, ownership, invariants, traps. Each ends with a **"Where to look"** block: a *code map* (seam → file → symbols), plus links *deeper* (specs) and *sideways* (related playbooks).
3. **Spec** (`docs/spec/*.md`) — the **authoritative detail** for a language or format (the Lisp dialect, modes).
4. **Code** — the file + symbol the playbook's code map names. Open it and get stuck in.

Convention for every playbook: name **files + symbols** (grep-able, durable), never line numbers, and end with the "Where to look" block so the path to code is always one scroll away. The `run-and-verify` skill is the procedural leaf — how to confirm the change once you've made it.

---

## Where each kind of knowledge lives (the meta-map)

- **`CLAUDE.md`** — standing *process* agreements (branching, testing, territory, style). Loaded every session. **Points, doesn't contain** architecture — keep it lean.
- **`docs/*.md`** — authoritative *reference*: seams, ownership, invariants, recurring bug families. Slow-changing. **Name files + symbols** (grep-able, durable); avoid line numbers (they rot). Every subsystem playbook ends with a **"Where to look"** code map.
- **`docs/spec/*.md`** — language/mode specifications.
- **`plans/*.md`** — per-feature working plans with a STATUS block.
- **`HANDOVER.md`** — the rolling *state log*: what's in flight right now. Not a place for durable architecture (that goes in `docs/`).
- **`MEMORY.md` + `memory/*.md`** — durable *project facts* and *feedback*, as pointers + topic files. Not a substitute for `docs/`; when a memory entry grows into an architectural treatise, migrate it into a `docs/` playbook and leave a one-line pointer.
- **`.claude/skills/*/SKILL.md`** — *procedural* recipes for recurring task shapes (e.g. `run-and-verify`). Thin; they point back to the docs above.
- **Tests + `.githooks` + node `--check`** — knowledge the machine *enforces*. The highest-leverage form: a failing test teaches better than a remembered warning. Prefer turning a recurring gotcha into a check.

---

## The recurring traps (full list in `docs/MODEL-B-DISPATCH.md`)

- `nil` is **truthy** — test with `nil?`, never `null?`.
- Embedded Lisp inside `spine.js` JS template literals: no backticks; write `\\n` for a newline and `\\"` for a quote (the template eats one level).
- `app.js` / `spine.js` / `server.js` are **not in the test suite** — use `node --check` + a throwaway interpreter harness, then live-verify.
- `app.js` init runs before later `let`/`const` — a read of a later-declared variable aborts the whole renderer boot (TDZ trap).
- Reload rules: renderer edits → window reload; main/server/`*.lisp` edits → quit + relaunch. (See `run-and-verify`.)
