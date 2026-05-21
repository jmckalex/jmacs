# Sub-Plan: Risk Register

## Purpose

Concrete risks specific to this project, what to watch for, what to do. Reread at the end of weeks 1 and 2.

## Architectural Risks

### Layer 2 API sprawl
**What it looks like**: The buffer API grows to 80, 120, 200 functions. Each addition seems reasonable. The whole becomes incoherent.

**Warning signs**: Adding new API functions weekly. The API document growing without review.

**Response**: Review every new function. Most should be stdlib helpers built from L2 primitives, not L2 itself. "Build that out of these" is the answer.

### Lisp spec inconsistency
**What it looks like**: Macro system says one thing, module system another, error handling makes a third assumption. Implementation diverges from spec on ambiguous points.

**Warning signs**: Encountering an ambiguity in the spec that affects implementation.

**Response**: Treat ambiguities as gifts. Update the spec when you discover them. Never leave spec and implementation divergent.

### Event protocol performance
**What it looks like**: Typing feels laggy. Renderer can't keep up. 60fps slips.

**Warning signs**: Week 2 day 12 dogfooding shows visible latency.

**Response**: Profile first, optimise second. Likely culprits: too many events per keystroke (coalesce earlier), renderer re-rendering more than necessary (incremental only), buffer doing per-keystroke work that should be deferred (syntax highlighting on idle).

### Wrong language for the wrong layer
**What it looks like**: JavaScript is fine for everything except the rope, which is borderline. Or the Lisp interpreter is slow enough that complex commands feel sluggish.

**Warning signs**: Storage performance unimpressive, or tree-walking interpretation is the bottleneck.

**Response**: Drop to WASM (Rust or AssemblyScript) for the rope only, keep JavaScript everywhere else. Or accept tree-walking for week 3 and plan a bytecode VM for week 5. Neither requires rearchitecting.

## Process Risks

### Spec drift during implementation
**What it looks like**: Implementation interprets an ambiguous spec one way. Document still says the original. Other parts of the system read the document, not the code. Divergence compounds.

**Warning signs**: Discovering, in code review, behaviour that doesn't match the document.

**Response**: When this happens, decide which version is correct. Update document or code. Don't leave them divergent.

### Insufficient dogfooding
**What it looks like**: Week 3 day 18, the editor "works" by some technical definition but I haven't used it for anything real. Scenarios hit friction I didn't anticipate.

**Warning signs**: Day 17 passes without opening the editor to edit a real file.

**Response**: Force dogfooding sooner. Even on day 14, with a rough editor, try to edit something. Find friction. Friction at week 2 is cheap; friction discovered post-week-3 is expensive.

## Motivational Risks

### Excitement burnout in week 2
**What it looks like**: Week 1 was exciting (designing). Week 2 less exciting (implementing). Energy flags.

**Warning signs**: Doing other things instead. Repository goes a day without commits.

**Response**: Recognise this is normal. The dogfooding milestone is the antidote — once using the editor, motivation comes from improving your own tool, not from abstract project work. Push to the milestone even if quality compromises are required.

### Competing project pull
**What it looks like**: TROCP demands attention. A philosophy deadline appears. Julia wants you for something. Editor goes a week without attention.

**Warning signs**: Days slip without movement.

**Response**: Real risk that's hard to mitigate structurally. Best response: honest about actual available time, scale the schedule, consider whether a partial pause and resume is better than stretched continuous effort. Either is fine; abandoning is what to avoid.

### Perfectionism trap
**What it looks like**: Lisp spec keeps growing. Week 1 ends without runtime implementation because spec isn't "done."

**Warning signs**: Day 5 arrives and the spec is on its fourth major revision.

**Response**: Ship the spec at "good enough for implementation to start." Iterate based on implementation experience. Premature optimisation of the spec is the same anti-pattern as premature optimisation of code.

### Overwhelm from seeing the whole territory
**What it looks like**: After reading all the plans, the project feels too big to start.

**Warning signs**: Avoiding the project even though it's the project you want to do.

**Response**: Close the plans. They exist; they're there when you need them; you don't need to hold them in your head. Write twenty lines of code. The project becomes tractable the moment it stops being abstract.

## Technical Risks

### CodeMirror Text class doesn't extract cleanly
**What it looks like**: Trying to use `@codemirror/state` Text and discovering it's too coupled to other CodeMirror internals.

**Warning signs**: Storage agent reports difficulty during week 1.

**Response**: Implement a piece tree from scratch. Few hundred lines of careful code, not a multi-week project. Default to from-scratch if extraction is awkward.

### Tree-sitter integration harder than expected
**What it looks like**: Loading WASM grammars in Electron has friction.

**Warning signs**: Renderer reports difficulty.

**Response**: Tree-sitter has documented Electron usage. Working path exists. First approach might not work; try another (server-side parsing via main process, for instance).

### Electron renderer performance issues
**What it looks like**: Even small buffers render slowly. Frame rate dips during typing.

**Warning signs**: Day 12 typing feels off.

**Response**: Standard optimisations: virtualisation, CSS containment, requestAnimationFrame batching, avoiding layout thrash. VS Code's source is public and worth referring to.

### Hot reload doesn't work cleanly
**What it looks like**: Re-evaluating a module updates definitions but live state has stale references. Bugs proliferate.

**Warning signs**: Day 18, hot reload "works" but editor behaves oddly afterward.

**Response**: The clean solution is binding indirection — function references resolved through a binding table that the module update modifies. Common Lisp's symbol/function-cell model; Clojure's vars. Real piece of design work, well-understood.

### Electron main/renderer IPC sync issue
**What it looks like**: Something in desktop integration assumes synchronous behaviour that's actually async.

**Warning signs**: File saves complete before buffer's modified state updates. Window close loses unsaved changes.

**Response**: Standard Electron stuff. Audit IPC patterns, ensure consistent async handling.

## Scope Risks

### Scenario creep
**What it looks like**: Wanting to add "just one more thing" to the canonical scenario.

**Warning signs**: Canonical use case document grows.

**Response**: Don't edit the canonical use case after week 1 except to *cut* scope. Additions go to a "post-week-3 ideas" document.

### Trying to be Emacs-compatible
**What it looks like**: Thinking "we should support that Emacs feature." Then several.

**Warning signs**: Lisp spec starts to look like Elisp. Stdlib mimics Emacs command names beyond what's natural.

**Response**: Reread the vision. Cleanroom is the point. Bias toward clean over familiar.

### Premature ecosystem thinking
**What it looks like**: Designing the package system in week 2 because imagining how others will write modes.

**Warning signs**: Architectural discussions reference hypothetical third-party developers.

**Response**: No one else exists yet. Design for own use first. Ecosystem is month 3, not week 2.

## Existential Risks

### The project is not actually right for me
**What it looks like**: Two weeks in, not enjoying it. Work feels like obligation.

**Response**: Stop. The reason to do this is that it's interesting. If it isn't, no amount of feasibility analysis matters. Better to abandon at week 2 than grimly continue.

### Someone else ships the same thing first
**What it looks like**: During week 2, discover [hypothetical Editor X] which is essentially what I'm building, MIT-licensed.

**Response**: Unlikely but possible. If it happens, take it as a gift — use Editor X, contribute, reclaim the time. The reason to build is the thing's value, not the project's existence; if the thing exists, the purpose is served.

## Watching the Watchers

The risk register itself has a meta-risk: it can become reassurance theatre, where naming risks feels like managing them. The point is to make you act when a warning sign appears. Reread it at the end of weeks 1 and 2. If you don't reread it, the document didn't help.
