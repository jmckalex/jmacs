# Sub-Plan: The Canonical Use Case

## Purpose

Every architectural decision needs a concrete reference point. This is the scenario the editor must support well by end of week three. When a design question comes up, the answer is the one that serves this scenario better.

## The Scenario

I sit down at my Mac at the end of week three. I open my new editor. I spend the next 90 minutes editing files in `packages/stdlib/`.

Concretely:

1. **Launch the editor.** It opens to a buffer showing last-open files, or a scratch buffer if first launch.

2. **Open a file.** `C-x C-f` triggers a file picker. I type, fuzzy-match finds `packages/stdlib/editing.lisp`. Enter. File opens, syntax-highlighted as Lisp.

3. **Navigate the file.** Scroll, jump to a function definition, move with word/line motions. Cursor movement is instant.

4. **Edit a function.** Modify the definition of `forward-word`. Insert several lines, delete some, fix indentation. Each keystroke renders within one frame. Undo works.

5. **Search.** `C-s` triggers incremental search. Type a function name, editor highlights matches and jumps to first. Confirm, search ends, cursor at match.

6. **Save the file.** `C-x C-s`. File written to disk. Modeline updates to show no unsaved changes.

7. **Reload the editor's own Lisp.** Some command — `M-x reload-stdlib` — re-evaluates the standard library. The change to `forward-word` is now active. I test it; works.

8. **Open a second file.** Different buffer, same workflow. Both buffers exist; switch between them with `C-x b` or a buffer list.

9. **Use the REPL.** `M-x lisp-repl` opens a REPL buffer. Evaluate `(buffer-length (current-buffer))`. Get the answer. Define a temporary function, call it. The REPL shares state with the editor.

10. **Try a JavaScript extension.** A small JavaScript file in `packages/stdlib/` is loaded; the editor recognises a command it registers; `M-x` finds it; invoking it modifies the current buffer correctly.

11. **Quit.** Editor closes cleanly.

That session is what week three is building toward.

## What This Demands

Working backwards:

**From L1 (storage):**
- Opening and saving files (UTF-8)
- Edit operations fast enough that typing never lags
- Undo/redo correct across complex sequences

**From L2 (buffer):**
- Multiple buffers coexisting
- Text properties (for syntax highlighting)
- Point and mark
- Modes — at minimum, fundamental-mode and lisp-mode
- Hooks for after-change (syntax highlighting runs)
- Undo groups at command granularity

**From L3 (Lisp + JS):**
- Lisp runtime that evaluates commands fast enough for interactive use
- Module loading
- REPL with editor integration
- Error handling that doesn't crash
- Hot reload — re-evaluating a module updates definitions in the running system
- JavaScript module loading and command registration
- Cross-language interop (JS calls into Lisp-defined buffer ops)

**From L4 (renderer):**
- 60fps rendering during typing
- Syntax-highlighted display via tree-sitter
- Cursor and selection rendering
- Command palette UI
- Modeline with buffer name and modified state
- File picker UI for find-file
- Smooth scrolling

**From stdlib:**
- All commands invoked above, written in Lisp
- Keymap binding commands to conventional keys
- lisp-mode using tree-sitter Lisp grammar
- REPL command and supporting code
- File and buffer management

## Specific Decisions This Drives

**Hot reload model.** Scenario requires that re-loading a module updates definitions in the running editor. Module system needs mutable bindings or some form of indirection. Lisp runtime needs a way to redefine functions while preserving existing references.

**Keymap dispatch.** Scenario uses Emacs-style key bindings (`C-x C-f`). Renderer dispatches key events to a keymap defined in Lisp. Dispatcher supports key sequences, prefix arguments, universal argument.

**Command palette.** `M-x` triggers fuzzy-matching command palette. UI component (L4) plus command registry (stdlib).

**Minibuffer.** Several operations use a minibuffer area: search, command palette, find-file. Renderer component that stdlib drives.

**File picker.** Either a simple filtered list or a fuzzy finder. UI in L4, command logic in stdlib.

**Session state.** Closing and reopening preserving open files is a real feature but a stretch for week 3. Acceptable to defer.

## Non-Goals for the Scenario

Explicitly *not* included:

- LSP features (completion, diagnostics, hover)
- Git integration
- Project-aware features (file tree, project search)
- Multiple windows or splits (single window with multiple buffers is enough)
- Themes beyond one or two defaults
- Configuration UI
- Any non-Lisp, non-JS language modes

Resist scope creep. Each non-goal is a real loss but worthwhile.

## How to Use This Document

When a question is "should we support X?", check whether X is needed for the scenario. If yes, prioritise. If no, defer.

When a design decision could go several ways, ask which way better serves the scenario.

When unsure whether the editor is "done enough" for week 3, walk through the scenario. If you complete every step satisfactorily, the milestone is met.

## Revising the Scenario

If during week 1 or 2 the scenario seems unreachable, the response is to *cut steps*, not extend the timeline. Cutting step 9 (REPL) or step 7 (hot reload) reduces scope significantly while preserving the core "editor edits its own code" identity.

If during weeks 1-2 the scenario seems too easy, that's a green signal to either advance the timeline or expand toward week-4 features. Don't expand prematurely; finishing the basic scenario first is the right discipline.
