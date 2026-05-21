# Master Plan

This is the top-level navigation document for building the editor. Sub-plans cover detailed areas; this document points to them and gives the overall shape.

## Sub-Plans

- **`LISP-SPEC.md`** — designing the Lisp language
- **`LAYER2-API.md`** — the buffer/semantic API design
- **`EVENT-PROTOCOL.md`** — change events between layers
- **`CANONICAL-USE-CASE.md`** — the editing session week 3 must support
- **`WEEK-BY-WEEK.md`** — day-level schedule for weeks 1–3
- **`RISKS.md`** — failure modes and responses

## The Goal (Three Weeks)

By end of week three: an editor used daily to edit its own source code.

This means, concretely, the editor supports opening and saving files, basic editing, search and replace, multiple buffers, syntax highlighting (at least for JavaScript and the Lisp dialect) via tree-sitter, a working Lisp REPL embedded in the editor, ability to evaluate Lisp code that modifies buffers, a usable command palette, and pleasant visual defaults.

What it does *not* need at three weeks: LSP, package management, modes beyond JS and Lisp, completion, debugging integration. These come later.

The dogfooding criterion is the only one that matters. If by end of week three I'm using the editor to edit its own Lisp source, the project has crossed the line. If I'm still in Sublime, something needs reassessment.

## Architectural Commitments (Fixed in Week One)

These decisions get made before serious implementation begins and don't change without serious cause:

1. **Host language**: Vanilla JavaScript (ES2022+ modules). JSDoc for public API documentation. No TypeScript, no compilation step.

2. **Lisp implementation**: Custom dialect, written from scratch. Tree-walking interpreter in vanilla JavaScript. A few thousand lines, well-trodden ground.

3. **Storage**: CodeMirror 6's `@codemirror/state` Text class if it extracts cleanly; otherwise a piece tree from scratch.

4. **Tree-sitter integration**: `web-tree-sitter` package, grammars compiled to WASM, loaded on demand.

5. **Renderer**: Plain DOM with virtualization for the editor surface. React (or similar) only for chrome (modeline, command palette).

6. **Build**: Vite for the renderer, electron-builder for packaging. pnpm workspaces. ESM modules.

7. **Dual scripting**: Lisp is the primary extension language and defines the editor's character; JavaScript is also first-class and has full access to the L2 API. Both share runtime state.

8. **Repository layout**:
   ```
   editor/
     apps/desktop/
     packages/
       storage/      # Layer 1
       buffer/       # Layer 2
       lisp/         # Layer 3
       renderer/     # Layer 4
       stdlib/       # Lisp standard library
     docs/
     plans/
   ```

## Sub-Agents (Optional, Used As Needed)

The plans originally described eight sub-agents. In practice, you'll use Claude Code interactively for most work, with sub-agents activated for specific bounded tasks that benefit from autonomous execution (the rope implementation, the LSP client). Don't dispatch sub-agents because the plan says to; dispatch them when a task is bounded enough to delegate cleanly.

When you do use sub-agents, the territory model from the plans applies: each agent owns one package, stays in it, writes to `architect-notes.md` rather than wandering. See `docs/GUARDRAILS.md` for the setup.

## The Three-Week Shape

Detailed day-by-day breakdown is in `WEEK-BY-WEEK.md`. Top-level shape:

**Week 1 — Foundations**
- Lisp spec drafted to "implementable" state
- L2 API design documented
- Event protocol specified
- Storage layer working with tests
- Build infrastructure functional
- End-of-week milestone: `pnpm dev` opens an Electron window, storage layer is solid

**Week 2 — Runtime and Surface**
- Lisp runtime implemented and exercising the spec
- Buffer layer complete and integrated with storage
- Renderer displays a buffer and reflects edits
- Basic input handling
- End-of-week milestone: typing in the Electron window produces visible characters in the buffer

**Week 3 — Make It Real**
- Standard library of commands written in Lisp
- Tree-sitter syntax highlighting active
- Command palette and file picker
- REPL integrated
- Visual polish
- End-of-week milestone: editing the editor's own source code in the editor

## What You Need to Do First

1. **Pick a name.** Or commit to a placeholder. Don't skip.

2. **Initialise the repository.** Create the monorepo structure above. Commit `docs/VISION.md`, `docs/ARCHITECTURE.md`, and these plans.

3. **Write the first 200 lines of storage code.** Not the Lisp spec, not the L2 API, not the agent prompts. A function that inserts text into a buffer. Then twenty more lines. Concrete code is grounding.

4. **As momentum builds, layer in the design work.** The Lisp spec, the L2 API, the event protocol. These don't need to be complete before code starts; they need to exist in usable form before the parts that depend on them.

## What Success Looks Like At Each Boundary

**End of week 1**: Repository alive. Storage works. Buffer designed and partially implemented. Lisp spec drafted enough to start implementation. Build pipeline produces a runnable Electron skeleton.

**End of week 2**: Lisp runtime evaluates code. Renderer shows a buffer. Input flows from keyboard to Lisp execution. The editor is rough but real.

**End of week 3**: I use it. The editor is my tool for editing its own source. Command palette, syntax highlighting, basic file management, search and replace, multiple buffers. Visual quality good enough that working in it is pleasant.

If a milestone slips significantly, the response is **not** to add a week — it's to cut scope. Drop features rather than extend timeline. Time pressure forces good decisions about what actually matters.

## Out of Scope for Three Weeks

- LSP support
- Tree-sitter for languages beyond JS and Lisp
- Package management
- Cross-platform builds (macOS only is fine)
- Settings UI
- Themes beyond one or two defaults
- Multiple windows
- Project-aware features
- Anything multiplayer or collaborative
- Mobile or web targets

Resist scope creep. The point of week three is *daily usage*, not feature competitiveness with VS Code.

## After Week Three

Don't plan months four onward now. Plan week four at the end of week three when you know what the editor actually feels like and where the friction lives. The most likely shape: LSP in week four, tree-sitter grammars for more languages in week five, package system started in week six. But write that plan when you get there.

## The Trajectory Reminder

This project will not unfold according to plan. JMarkdown started as an annoyance fix and grew into something different from anything I'd have planned. The new editor will do the same.

The plans describe a credible starting shape. The actual shape will emerge from sustained use. The plans serve the project by giving it a defensible foundation; they don't serve the project by being adhered to rigidly.

When in doubt, write code. The plans will still be here when you need them.
