# Start Here

If you've been away from the project, this is the document to read first.

## What This Project Is

An Electron-based editor, extensible in Lisp (custom dialect) and JavaScript. Built for me, by me, with Claude Code as collaborator. The goal is a tool I use daily within three weeks, that I'm still using in a decade.

For the full picture, read `docs/VISION.md` (why) and `docs/ARCHITECTURE.md` (how).

## Where You Are

The editor exists, runs, and is usable for real work. The five-layer architecture is in place; the Lisp runtime, the standard library, panes/tabs, and a handful of view kinds (text, browser, PDF, image, shell) are all working.

To pick up where you left off: open `architect-notes.md` and `git log --oneline` to see what's recent. If there is an in-flight piece of work, the last commits and the notes file are where it lives.

If you're confused about something specific: the relevant plan in `plans/` probably covers it. If not, check the docs (the `docs/` tree is now the authoritative reference; `plans/` is the design log it was built from).

## Resuming Work

1. **Run it.** `pnpm dev` opens the editor in an Electron window. Confirm it still launches cleanly before changing anything.

2. **Check the test suite.** `pnpm test` runs every package. Green is the baseline — work from there.

3. **Read `docs/VIEWS.md`** if your task touches views, panes, or tabs. It is the playbook of which path owns which display-state and which bug families keep recurring there. Skipping it is a reliable way to ship a one-line fix that breaks three other arms.

## The Reminder

This project will not unfold according to the plans. JMarkdown started as an annoyance fix and became something different from anything you'd have planned. The new editor will do the same.

The plans describe a credible starting shape. The actual shape will emerge from sustained use.

When the plans feel heavy, close them and write code.

## Where Things Live

- **What the editor is and why** → `docs/VISION.md`
- **How it's architected** → `docs/ARCHITECTURE.md`
- **How to safely run Claude Code** → `docs/GUARDRAILS.md`
- **The three-week plan** → `plans/MASTER.md` (which points to other plans)
- **Day-by-day schedule** → `plans/WEEK-BY-WEEK.md`
- **The Lisp specification** → `docs/spec/lisp.md` (the working spec; `plans/LISP-SPEC.md` is the design log)
- **The buffer API** → `docs/api/layer2.md` (the working API; `plans/LAYER2-API.md` is the design log)
- **Event protocol** → `plans/EVENT-PROTOCOL.md` (not yet promoted to docs/api/events.md)
- **View / pane invariants** → `docs/VIEWS.md` (read first if your work touches views or panes)
- **Risks and failure modes** → `plans/RISKS.md`
- **The success criterion** → `plans/CANONICAL-USE-CASE.md`
- **Operating instructions for AI agents** → `CLAUDE.md`

## A Final Note

The reason to do this is that it's interesting and useful to you. If at any point it stops being either, stop. The project will wait. It's been a good idea long enough to last a few more months on the shelf if needed.

But you'll probably keep going. You usually do.
