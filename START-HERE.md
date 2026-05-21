# Start Here

If you've been away from the project, this is the document to read first.

## What This Project Is

An Electron-based editor, extensible in Lisp (custom dialect) and JavaScript. Built for me, by me, with Claude Code as collaborator. The goal is a tool I use daily within three weeks, that I'm still using in a decade.

For the full picture, read `docs/VISION.md` (why) and `docs/ARCHITECTURE.md` (how).

## Where You Are

If this is day one: do steps 1-3 below.

If you've started but stalled: open `architect-notes.md` and `git log --oneline` to see where you left off. Then look at `plans/WEEK-BY-WEEK.md` to find the next day's tasks.

If you're confused about something specific: the relevant plan in `plans/` probably covers it. If not, check the docs.

## Today's First Three Moves

1. **Pick a name.** Or use `editor` as a placeholder. Don't agonise.

2. **Initialise the repository.**
   ```bash
   cd ~/path/to/wherever
   mkdir editor && cd editor
   git init
   # Copy everything from this starter pack into the directory
   git config core.hooksPath .githooks
   cp .claude/settings.local.json.example .claude/settings.local.json
   git add . && git commit -m "chore: initial project structure"
   ```

3. **Write twenty lines of code.** Create `packages/storage/src/index.js` with a function that inserts text into a buffer. Then twenty more lines. Concrete code is grounding.

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
- **The Lisp design** → `plans/LISP-SPEC.md` (will become `docs/spec/lisp.md` once written)
- **The buffer API design** → `plans/LAYER2-API.md` (will become `docs/api/layer2.md`)
- **Event protocol** → `plans/EVENT-PROTOCOL.md` (will become `docs/api/events.md`)
- **Risks and failure modes** → `plans/RISKS.md`
- **The success criterion** → `plans/CANONICAL-USE-CASE.md`
- **Operating instructions for AI agents** → `CLAUDE.md`

## A Final Note

The reason to do this is that it's interesting and useful to you. If at any point it stops being either, stop. The project will wait. It's been a good idea long enough to last a few more months on the shelf if needed.

But you'll probably keep going. You usually do.
