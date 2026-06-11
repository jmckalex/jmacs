# Project Operating Instructions

This file is read by Claude Code at the start of every session. It establishes the working agreements that apply across all tasks and sub-agents.

## Context

This project builds a Lisp-extensible editor with an Electron presentation layer. The architecture is documented in `docs/ARCHITECTURE.md` and the working plans are in `plans/`. Before starting any non-trivial task, read the relevant plan document.

The architect (the human you are working with) is Jason. Jason works in vanilla JavaScript (ES2022+ modules), not TypeScript. There is no compilation step. JSDoc comments document public APIs.

The editor exposes two extension languages: a custom Lisp (the primary, what gives the editor its character) and JavaScript (also first-class, given that we're in a JS runtime).

At the start of a session, read `HANDOVER.md` (an untracked rolling doc at the repo root) for the current state, in-flight branch, and immediate next action — it is written at the end of each session for the next one.

## Running and testing the app

- **Launch the app:** `cd apps/desktop && ./node_modules/.bin/electron .`. Do **not** use `pnpm dev` — pnpm's pre-run dependency check currently fails on an unresolved `citation-js` ignored-build placeholder; the direct `electron .` invocation sidesteps it. (If you need the architect to run an interactive command, suggest they type `! <command>` in the prompt.)
- **Reloading edits:** `app://` assets are served `no-store` (`apps/desktop/src/serve.js`), so a window **reload (Ctrl+Cmd+R — plain Cmd+R is M-r now that Command is Meta)** reliably picks up edited *renderer* code — `apps/desktop/src/app.js`, anything under `packages/renderer/src`, `*.lisp`, `styles.css`. Edits to *main-process* code (`serve.js`, the main entry, `preload.mjs`) need a full **quit (C-x C-c, or the app-menu Quit) + relaunch**.
- **Tests:** `pnpm test` at the root runs all packages; `pnpm --filter @editor/<pkg> test` runs one. Caveat: unit tests **stub the host primitives**, so the real bodies of `apps/desktop/src/app.js` primitives never execute under test — sanity-check new primitive bodies in the running app, not just via green suites.

## Working Agreements

### Branching and commits

- **`main` is protected.** **Sub-agents must never touch `main`** — all sub-agent work happens on a branch; the ban on *checking out* `main` is the guard rail that stops an autonomous agent from going rogue. The **main interactive assistant**, working with the architect live, may commit *small, low-risk polish* (a doc tweak, a sample file, a one-line fix) directly to `main` — but **features and anything substantial go on a branch and are merged only when the architect explicitly asks**.
- **Switch to `main` with `git switch main`, never `git checkout main`** — the `checkout main` form is blocked by a permission hook (the same guard rail). `git switch` is allowed and is how you move onto `main` to merge.
- **Merge to `main` with `git merge --no-ff` plus a pre-merge recovery tag** — tag `main`'s tip before merging (e.g. `git tag pre-<feature>`), so any merge is easy to recover from. Push only when the architect asks (`git push origin main --follow-tags`).
- **Sub-agents work on branches named for their role**: `agent-1-storage`, `agent-2-buffer`, etc. Sub-tasks can use further branches like `agent-2-buffer/markers`.
- **Commit frequently.** Each logically complete unit of work gets its own commit. Small commits are recoverable; large ones are not.
- **Commit messages follow conventional commits**: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`. Subject under 72 characters, imperative mood ("add" not "added"). Body explains *why* if not self-evident.
- **Every commit must pass tests.** Fix tests before committing, or revert.
- **Never use `git push --force`, `git push -f`, or `git reset --hard origin/<branch>`.** If you think you need them, stop and write to `architect-notes.md`.

### Territory and scope

Each package belongs to one role. Stay inside it:

- `packages/storage/` — Layer 1 work
- `packages/buffer/` — Layer 2 work
- `packages/lisp/` — Layer 3 work
- `packages/renderer/` — Layer 4 work
- `packages/view/` — the View abstraction (per-tab on-screen surface)
- `packages/pane/` — the Pane tree (binary split tree; leaves hold a view)
- `packages/stdlib/` — Lisp standard library
- `packages/lsp/` — LSP integration (week 4+)
- `apps/desktop/` — Electron integration

If a task requires changes outside the current territory, **do not modify the other territory directly.** Write a note to `architect-notes.md` describing what you need. The architect will route it.

### Stopping and asking

When working autonomously (overnight or otherwise), the architect cannot answer questions in real time. When you encounter a situation that needs human judgement, the correct response is **not** to guess and proceed — it is to stop the current task cleanly and write to `architect-notes.md`.

Situations that warrant stopping:

- The spec or plan document is ambiguous on a point that affects your implementation
- You discover a design decision that wasn't anticipated and could go several ways
- A test fails in a way suggesting the spec might be wrong rather than the code
- You're about to do something that affects another package's territory
- You're about to install a non-trivial dependency that wasn't in the plan
- You're about to refactor something outside your assigned task scope
- You've tried the same fix three times without success

When stopping: leave the codebase in a clean state — committed, tests passing on what you've done — and write a detailed note. Then end the session. Wasted compute is cheaper than wasted code.

### Note-taking format

When stopping to ask, append to `architect-notes.md`:

```
## [YYYY-MM-DD HH:MM] <Role/Task>: <one-line summary>

**Context**: What you were trying to do.

**Question/blocker**: What you need from the architect.

**Options considered**: 2-3 alternatives, with brief pros/cons.

**State of the work**: What branch you're on, what's committed, what's left.

---
```

Don't delete previous notes. The architect reads through them.

### Testing discipline

- **Tests are not optional.** Every new public function gets a test. Every bug fix includes a regression test.
- **Run the full test suite before committing.** `pnpm test` at the root, or the package-specific command.
- **Don't disable failing tests to make the suite pass.** Fix the underlying issue, or fix the test and explain in the commit message. If unsure, stop and ask.
- **Don't write tests that don't assert anything meaningful.** A test should fail if behaviour breaks.

### Code style

- **Vanilla JavaScript, ES2022+ modules.** Use `import`/`export`. No CommonJS in new code.
- **JSDoc for public APIs.** Document parameter types, return types, behaviour. Internal helpers can be undocumented if obvious from a short read.
- **Prefer pure functions.** Side effects are sometimes necessary (the buffer is mutable) but localise them and make them visible.
- **Avoid clever code.** Boring readable code is what we want. The Lisp is where interesting abstractions live; host code is plumbing.
- **No `eslint-disable` without a comment explaining why.**

### Dependencies

- **Don't add dependencies without good reason.** Each is a thing that can break. Prefer 50 lines of code to a 10MB package for one function.
- **Pin versions.** No `^` or `~` ranges for new additions; exact versions.
- **Update with care.** Don't update existing dependencies as part of unrelated work. Updates are their own commits with their own justification.

### What to read first

For any non-trivial task:

1. `HANDOVER.md` (current state + in-flight branch) and `MEMORY.md`
2. `docs/VISION.md` and `docs/ARCHITECTURE.md`
3. The relevant plan document in `plans/`
4. The spec document for any layer you interact with
5. The existing code in your package and its tests
6. Current state of `architect-notes.md`

**If the task touches views or panes**, read `docs/VIEWS.md` *first*.
It is the condensed playbook of which display-state is owned by
which path, what stays invariant under view/tab operations, and the
specific bug families that keep recurring. Skipping it almost
guarantees a one-line fix that breaks three other arms.

### Communication style

When responding to the architect (in commits, notes, or interactive sessions):

- Be direct. Skip preambles.
- Reference specific files and line numbers where relevant.
- Flag uncertainty honestly. "I think this is right but I'm not 100% sure about X" is more useful than false confidence.
- If you made a decision the architect should review, say so explicitly.
- Don't apologise reflexively. A clean explanation is more useful than expressions of regret.

## Project Glossary

- **L0–L4** — the architecture's layers (host, storage, buffer, lisp, renderer)
- **Buffer** — a Layer 2 object representing text with semantic metadata
- **Marker** — a position in a buffer that updates correctly under edits
- **Overlay** — a range with metadata, distinct from text properties
- **Mode** — a tagged behavioural configuration for a buffer
- **The architect** — Jason
- **The canonical use case** — the editing session in `plans/CANONICAL-USE-CASE.md`
- **The Lisp** — the custom Lisp dialect for this editor, specified in `docs/spec/lisp.md`

## Final Notes

The most important habit: **commit often, on a branch, with tests passing.** Everything else is recoverable from good commit history. Skipping that discipline is the only way to lose real work.

If anything here conflicts with a specific task brief, the brief wins for that task, but flag the conflict in `architect-notes.md` so the standing instructions can be updated.
