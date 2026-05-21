# Sub-Plan: Week-By-Week Schedule

## Purpose

Day-level breakdown of weeks 1-3. Default scaffolding; deviate when reality demands. Skipping days is fine; reordering within a week is fine; cutting scope is fine. Letting the schedule slip without conscious decision is what to avoid.

Assumes part-time intensity — a few focused hours per day, not full days.

## Week 1 — Foundations

### Day 1
- Pick project name (or commit to placeholder)
- Create repository, initialise monorepo structure
- Commit `docs/VISION.md`, `docs/ARCHITECTURE.md`, all plan documents
- Write the first storage code: a function that inserts text into a buffer (twenty lines)
- See how it feels

### Day 2
- Continue storage layer: insert, delete, range query, change event emission
- Start drafting `docs/spec/lisp.md`: introduction, lexical structure, evaluation model
- Write the one-page idiomatic Lisp example

### Day 3
- Storage layer: undo/redo, persistence
- Lisp spec: special forms, macro system thinking (this is the hardest part)
- Start `docs/api/layer2.md` design

### Day 4
- Storage layer: tests, basic performance check
- Lisp spec: modules, error handling, concurrency model (can stub)
- Layer 2 API: core operations, markers, text properties

### Day 5
- Buffer layer (L2): start implementation against the API doc
- Write `docs/api/events.md`
- Lisp spec: JavaScript interop section

### Day 6
- Buffer layer: continue, integrate with storage
- Build infrastructure: get `pnpm dev` opening an Electron window (even blank)
- Refine Lisp spec based on insights

### Day 7
- Review and consolidate week 1
- Self-test the Lisp spec by writing the example program
- Confirm L2 API ready for serious implementation
- End-of-week milestone check

**Week 1 success criteria:**
- `pnpm dev` opens an Electron window
- `docs/spec/lisp.md` drafted to implementable state
- `docs/api/layer2.md` drafted to implementable state
- `docs/api/events.md` exists
- Storage layer working with tests
- Buffer layer in progress

## Week 2 — Runtime and Surface

### Day 8
- Start Lisp runtime implementation: reader, basic evaluator
- Renderer: start work, against mock L2 events initially
- Refine canonical use case based on what's becoming concrete

### Day 9
- Lisp runtime: function definition, function calling, environments
- Buffer layer: should be near complete
- Renderer: basic buffer display

### Day 10
- Lisp runtime: macros (the hard part)
- Buffer/storage integration testing
- Write first stdlib functions in Lisp by hand (not running yet) to validate language feel

### Day 11
- Lisp runtime: modules, error handling
- Test runtime against simple programs
- Renderer: connect to real buffer events

### Day 12
- First integration: typing in Electron window produces visible characters
- Fix issues that surface — module resolution, event timing, encoding edge cases (expect these)
- This is the first day the editor *looks* like an editor

### Day 13
- Renderer: input handling, key events flow through
- Lisp runtime: REPL integration
- Begin testing: typing works, undo works, modeline updates

### Day 14
- Week 2 review
- Identify week-3 risks
- Cut scope if needed

**Week 2 success criteria:**
- Electron window opens to an editable buffer
- Typing works, renders correctly
- Basic editing (insert, delete, backspace) works
- Lisp runtime evaluates expressions
- Storage and buffer integrated
- Renderer subscribes to and reflects buffer events

## Week 3 — Make It Real

### Day 15
- Start stdlib: find-file, save-buffer, basic movement commands
- Renderer: command palette UI
- JavaScript-side L2 binding (so JS extensions can call buffer operations)

### Day 16
- Stdlib: search, kill/yank, command-level undo
- Renderer: file picker
- Tree-sitter integration: load Lisp grammar, syntax highlighting appears
- First real dogfooding attempt

### Day 17
- Fix dogfooding bugs
- Visual polish: fonts, colours, spacing, modeline design
- Stdlib: mode definitions (lisp-mode, javascript-mode)
- Editor usable for short editing sessions

### Day 18
- More dogfooding. Edit actual files
- Lisp runtime: REPL command, hot reload mechanism
- Test JavaScript extension loading
- Fix discovered friction

### Day 19
- End-to-end test of canonical scenario
- Identify remaining gaps; fix or accept
- Visual final pass

### Day 20
- Continued dogfooding
- Performance check: large buffer typing still smooth
- Final polish

### Day 21
- Project review: the editor is my daily tool
- Document what works, what doesn't, what surprised
- Sketch week-4 plan
- Note: three weeks ago this was a concept; now it exists

**Week 3 success criteria:**
- Canonical use case runs successfully
- I've used the editor to edit its own source code at least once
- Performance feels acceptable
- The editor is the one I reach for sometimes

## Adjustments and Recovery

If week 1 slips more than a day, compress the Lisp spec — cut macro sophistication, defer module complexity, accept rougher specs to keep moving.

If week 2 slips more than a day, cut scope from week 3. Drop the REPL. Drop hot reload. Drop the file picker (use a prompt). Get to a smaller usable editor faster.

If week 3 slips, declare partial success and move on. A 70%-complete week-3 editor used anyway is better than perpetually pushing the deadline. Continue improvement post-week-3.

The fixed point is *daily usage by end of week 3*. Everything else is negotiable.

## When to Stop Following This Schedule

This schedule serves the project, not the other way around. Discard when:

- Project is significantly easier than expected; finish in two weeks
- A single piece will take much longer than estimated; rescope rather than reschedule
- A wall appears; step back and reconsider before continuing
- Scenario complete early; start week 4 work

The schedule is scaffolding. Use it as long as it helps, then drop it.
