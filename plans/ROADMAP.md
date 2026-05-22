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
| The command system — `defcommand`, a command registry, and Emacs-style interactive argument specs | [`COMMAND-SYSTEM.md`](COMMAND-SYSTEM.md) | planned — awaiting review |
| A reactive Lisp notebook (Observable-style), written in Lisp | [`REACTIVE-NOTEBOOK.md`](REACTIVE-NOTEBOOK.md) | planned — awaiting review |
| Pretty-printed markdown shown in place of source comments | [`MARKDOWN-COMMENTS.md`](MARKDOWN-COMMENTS.md) | planned — awaiting review |

The **command system** is the natural next step — it makes "command" a
first-class concept (so `M-x` lists every command, bound or not) and
introduces declarative interactive argument specs, the powerful half of
Emacs's `(interactive)`. The notebook and the markdown-comments feature
are independent of it and of each other, and can follow in any order.

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
and **Emacs-style customisation** — `defcustom`, the buffer-kind /
view-kind mechanism, the HTML customisation buffer, persistence and an
`init.lisp` ([`CUSTOMISATION.md`](CUSTOMISATION.md)).
