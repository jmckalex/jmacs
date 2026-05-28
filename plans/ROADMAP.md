# Roadmap — features beyond the initial build

`MASTER.md` and `WEEK-BY-WEEK.md` describe the initial three-week build:
the editor reached the point of editing its own source. That bar is
cleared — the editor is in daily use for simple tasks.

This document is the running to-do list for what comes next. The theme
of this phase is *plumbing for standard things* — the capabilities a
mature editor is expected to have — rather than new ground.

Each planned feature has its own detailed plan document; the plans
carry the design, the phasing, and the open questions for the
architect. They are designs awaiting review and a go-ahead, not work
in progress.

## Planned

| Feature | Plan | Status |
|---------|------|--------|
| **A package management system** — manifest, autoload, install, list view, eventually a registry | [`PACKAGES.md`](PACKAGES.md) | planned — 12 open questions; next build session |
| The evaluator re-architecture — proper tail calls and a concurrency model (`await`, coroutines) | [`EVALUATOR.md`](EVALUATOR.md) | planned — gated by a performance spike |
| A reactive Lisp notebook (Observable-style), written in Lisp | [`REACTIVE-NOTEBOOK.md`](REACTIVE-NOTEBOOK.md) | planned — awaiting review; on `agent-reactive-notebook` |
| Pretty-printed markdown shown in place of source comments | [`MARKDOWN-COMMENTS.md`](MARKDOWN-COMMENTS.md) | planned — awaiting review |

The **evaluator re-architecture** is the foundational one — a single
rewrite that gets the evaluator off the JavaScript call stack, fixing
both the no-tail-calls and no-concurrency limits. It unblocks work that
is currently parked: the reactive notebook's async cells, an LSP
client, file watchers. The notebook and the markdown-comments feature
are independent of each other and can be built in either order.

One deferred sub-feature is also on the horizon: a **prefix-argument**
(`C-u`) mechanism. The command system reserves a `prefix` interactive
source for it (see [`COMMAND-SYSTEM.md`](COMMAND-SYSTEM.md)); it is a
small feature in its own right.

## Smaller follow-ups

- The menu and REPL-toggle commands added since the reference docs were
  written (`toggle-repl`, `mode-menu-entries` and the menu helpers) are
  not yet in `docs/reference/`. A modest doc update.
- Whole-file tokenizers for LaTeX and Makefile, so multi-line
  constructs highlight past their first line.
- Mode-specific keymaps for the HTML/LaTeX/Python/Makefile modes.

## Recently shipped

For context — the work since the initial build: the mode system, the
startup splash, double-click word selection, the scroll-bounce fix,
`C-x b` buffer creation, the `C-x p` REPL toggle, mode-specific native
menus, the sticky-notes feature (rendering via an external command,
MathJax, colour headers, collapse/expand, persistence, embedded media),
**Emacs-style customisation** — `defcustom`, the buffer-kind /
view-kind mechanism, the HTML customisation buffer, persistence and an
`init.lisp` ([`CUSTOMISATION.md`](CUSTOMISATION.md)) — and **the command
system** — `defcommand`, the command registry (so `M-x` lists every
command), and declarative interactive argument specs
([`COMMAND-SYSTEM.md`](COMMAND-SYSTEM.md)); the `prefix` source is
deferred.
