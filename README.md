# Editor Project

A Lisp-extensible editor with a JavaScript runtime layer, built as an Electron application. Successor in spirit to Emacs, with modern foundations.

## What This Is

An editor I'm building because the existing tools don't quite fit how I work. It runs as an Electron app. It's extensible in Lisp (my own dialect, designed for this purpose) and in JavaScript (because we're already in a JS runtime). It's designed to be the environment I work in for the next decade — for code, for writing, for the computational philosophy book.

The defining commitments are *legibility* (the editor should be comprehensible to the people who use it) and *aesthetic quality from day one* (beautiful by default, not configurable into beauty).

For the full vision, read `docs/VISION.md`. For the architecture, read `docs/ARCHITECTURE.md`. For how the project is structured for building, read `plans/MASTER.md`.

## Quick Start (Development)

```bash
pnpm install
pnpm dev          # launches the Electron app
pnpm test         # runs all package tests
```

## Repository Layout

```
editor/
  apps/
    desktop/              # Electron main process, ties everything together
  packages/
    storage/              # Layer 1: rope-based text storage
    buffer/               # Layer 2: semantic buffer model
    lisp/                 # Layer 3: Lisp runtime
    renderer/             # Layer 4: Electron renderer process
    stdlib/               # Lisp code shipped with the editor
  docs/
    VISION.md             # Why this exists
    ARCHITECTURE.md       # How it's built
    spec/lisp.md          # The Lisp specification
    api/                  # Layer 2 and event protocol specs (to be written)
  plans/
    MASTER.md             # Top-level navigation
    *.md                  # Detailed sub-plans
  scripts/
    overnight-prep.sh     # Run before unsupervised Claude Code sessions
    overnight-review.sh   # Run after, to summarise work
  .claude/
    settings.json         # Claude Code permission profile (committed)
    settings.local.json   # Personal overrides (gitignored)
  .githooks/
    pre-commit            # Test-gated commits, branch protection
  CLAUDE.md               # Operating instructions for AI agents
```

## Working With Claude Code

This project is built collaboratively with Claude Code, including overnight unsupervised sessions for substantial pieces of work. The setup for this is documented in `docs/GUARDRAILS.md`. Read it before launching long-running agent sessions.

The short version: agents work on branches, never on `main`. Tests gate commits via the pre-commit hook. The `overnight-prep.sh` script tags a recovery point before any unsupervised session. Recovery is always available via `git reset --hard <recovery-tag>`.

## Status

Running. `pnpm dev` opens the editor in an Electron window, and it is
usable: text editing with undo, multiple buffers, file open/save,
incremental search, a fuzzy command palette, syntax highlighting
(tree-sitter for JavaScript, a tokenizer for the Lisp dialect), a kill
ring, word motions, a line-number gutter, matching-bracket highlight,
and an embedded Lisp REPL.

The five layers are in place — storage (L1), buffer (L2), the Lisp
runtime (L3), the renderer (L4) — and the editor's keymap, commands and
standard library are written in the editor's own Lisp, hot-reloadable
from inside the editor (`C-x C-r`). 243 tests pass; an Electron smoke
test exercises the whole stack.

What the plans set as the three-week goal — the editor usable for
editing its own source — is reached. See `architect-notes.md` for the
build log and `docs/spec/lisp.md` for the language.
