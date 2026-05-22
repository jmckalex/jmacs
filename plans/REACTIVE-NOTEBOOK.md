# Plan — a reactive Lisp notebook

**Status: planned, not started.** A detailed design for review.

## Context

The architect wants a notebook view in the spirit of an Observable
notebook: cells of code, *reactive* — a cell re-runs when something it
depends on changes — with cells rendering their output as HTML. And the
defining constraint: it should be **written entirely in Lisp**, to
demonstrate that the Lisp engine is powerful. So the reactive engine,
the dependency graph, the cell model and the value→HTML formatting
should be Lisp code in the standard library, not host JavaScript.

Two existing things frame the work. The **REPL** (`packages/renderer/
src/repl.js`) is the closest existing surface that runs Lisp, but it is
linear and ephemeral — no cell identity, no re-evaluation. **Sticky
notes** are the precedent for *rendered HTML driven by Lisp*, but
inverted: there the host owns everything and Lisp is a thin command
wrapper. The notebook wants the opposite — the *engine* in Lisp.

## The hard constraint

From `docs/spec/lisp.md`: the Lisp **can** do closures, maps, vectors,
`defmacro`, `try`/`catch`, `set!`, `eval`, modules with hot reload —
everything the reactive engine needs. It **cannot**: touch the DOM (no
primitive builds or mutates an element); optimise tail calls (graph
walks must be iterative); run anything asynchronous (`docs/spec/lisp.md`
§8 — no concurrency).

**Conclusion.** The reactive engine, the dependency graph, topological
re-evaluation, and value→HTML *formatting* (producing an HTML *string*)
can all be pure Lisp. Turning that string into on-screen elements, and
capturing cell edits, cannot — *some* host primitive is unavoidable.
The plan's job is to make that host surface as thin as honestly
possible. v1 is **synchronous**: no timer/fetch cells until the Lisp
gains a concurrency model.

## The reactive model

**A cell is a Lisp map** — `{:id :name :source :form :value :output
:html :deps :state :error}` where `:state` is `:ok | :error | :stale |
:running`. The notebook is `{:cells … :env … :order …}`.

**Dependency discovery — by tracing, not declaration.** A cell reads
another cell's value through `(ref 'name)`. `ref` records, in a
dynamically-scoped "currently-evaluating cell" variable, that this cell
read that one. Dependencies are thus discovered exactly and at run
time — no static analysis, conditionals handled naturally. (A later
`cell` sugar macro can rewrite bare names to `ref` calls; v1 uses
explicit `ref`.)

**The engine** (pure Lisp): build the dependency graph from cells'
`:deps`; topologically order it with Kahn's algorithm (iterative —
TCO-safe); detect cycles and flag them as errors rather than
overflowing the stack; on a cell edit, re-evaluate it and — only if its
value actually changed (`equal?`) — the topologically-sorted transitive
closure of its dependents. A cell that throws is caught, marked
`:error`; its dependents go `:stale`. Topological order guarantees
glitch-freedom. **This engine is the "show the Lisp is powerful"
centrepiece.**

**Cell isolation.** Cells must not pollute the global environment. The
notebook keeps its own name→value map; `ref` reads it, a cell's `:name`
writes it; the engine `define`s nothing globally.

## The central question: rendering a UI from Lisp

"Entirely in Lisp" collides with "Lisp has no DOM." Four options:

- **(a) General host DOM primitives** Lisp drives (`dom/create`,
  `dom/append!`, …) — maximises Lisp's reach but is a large, leaky new
  host surface and a project in itself.
- **(b) Render into the existing overlay layer** — reuses a proven
  facility, but the overlay annotates *text*; a notebook is not an
  annotation of a document.
- **(c) A text-buffer notebook** — cells as delimited text regions,
  output inserted as text. *Zero new host code*, genuinely entirely in
  Lisp today — but output is text only, not the Observable look.
- **(d) A thin host view shell, Lisp drives the content** — a new
  notebook view (a sibling of the editor/REPL views) that owns only the
  cell DOM skeleton, the code-input editing, and the `innerHTML` write;
  plus a small (~10) notebook-specific primitive bridge
  (`notebook-cell-source`, `notebook-set-cell-html!`, …). All
  reactivity, the graph, the engine and the value→HTML formatting are
  Lisp.

**Recommendation: (d), with (c) as the phase-1 stepping stone.** Build
the engine first against a text buffer (c) — zero host code, proves the
engine end-to-end, ships independently. Then add the thin view shell
(d) and point the *same engine* at it. Design the engine with a small
*sink* interface (a Lisp map of `emit-value` / `emit-output` /
`emit-error` procedures) so the identical engine drives both — text
insertion in (c), `notebook-set-cell-html!` in (d). State plainly: the
host shell in (d) is irreducible (Lisp cannot create elements) but is
no larger in spirit than the buffer-primitive bridge already trusted.

## Components

- `packages/stdlib/lisp/notebook.lisp` — **new.** The reactive engine,
  cell model, topological re-evaluation, the value→HTML formatter, the
  `notebook-mode` + commands + keymap. A `(module notebook …)` so it is
  namespaced and hot-reloadable.
- `packages/renderer/src/notebook-view.js` — **new** (phase 2). The DOM
  shell: a vertical list of cells, each a code input + an output area;
  modelled on `repl.js` + `sticky-notes.js`.
- `packages/stdlib/src/notebook-primitives.js` — **new** (phase 2). The
  ~10-primitive host bridge, modelled on `buffer-primitives.js`.
- `apps/desktop/src/app.js` — wire the notebook view + primitives; the
  host calls `interpreter.call('notebook-cell-edited', id)` when a cell
  changes, mirroring how `dispatchKey` calls `handle-key`.
- `packages/stdlib/src/index.js` — register `notebook.lisp`.

## Phasing

0. **Spike** — in the existing REPL, hand-build two cells as Lisp maps
   and a read→eval→topo-re-eval loop. Proves the engine, zero host code.
1. **The engine + a text-buffer notebook (option c)** — full cell
   model, `ref`-based tracing, Kahn sort, cycle detection, error cells,
   value-equality re-run skip; `notebook-mode` + commands. Pure stdlib,
   the only host change being a `STDLIB_FILES` entry. Shippable: a
   working reactive notebook, text output.
2. **The notebook view (option d)** — `notebook-view.js`,
   `notebook-primitives.js`, `app.js` wiring; swap the engine's sink to
   the HTML sink; the Lisp value→HTML formatter. Cells now render HTML
   — the Observable look. The engine code is unchanged.
3. **Polish** — the `cell` sugar macro (bare names via static
   analysis), richer formatters (tables, simple charts as HTML),
   cell reordering, notebook persistence to a `.notebook` file.
4. **Deferred** — async cells (timers, fetch): blocked on the Lisp
   concurrency model; each cell as a real L2 buffer.

## Testing

- **Engine unit tests** (`stdlib.test.js` style, pure Lisp, fast):
  a downstream cell recomputes on an upstream change; an *unaffected*
  cell does not (counter-instrumented); a cycle is detected, not
  overflowed; an erroring cell is caught and its dependents go `:stale`;
  topological order is correct for a diamond dependency.
- **Formatter tests** — value → expected HTML, including escaping (the
  XSS surface).
- **Primitive bridge tests** (phase 2) — against a fake notebook view,
  like `buffer-primitives` against a session.
- **Smoke test** — open a notebook, type and run a cell, assert a
  dependent cell updated.

## Risks

- **"Entirely in Lisp" is not literally achievable** — Lisp cannot
  render pixels. The plan minimises the host surface; phase 1 (option c)
  *is* literally all-Lisp and ships first, making the point.
- **No TCO** — the topological sort and graph walks must be iterative.
- **No concurrency** — async/reactive cells (timers, fetch) are
  impossible until the Lisp gains coroutines; v1 is synchronous-only.
- **`eval` runs in the global environment** — cell isolation relies on
  the engine routing all references through its own map and never
  `define`-ing globally.
- **XSS via cell output** — the Lisp formatter escapes by default; only
  an explicit `(html …)`-tagged value bypasses.

## Open questions for the architect

1. **Cell environment isolation** — accept the `ref`-map approach, or
   invest in a small L3 change so `eval` can take an environment
   (cleaner, lets cells use bare names and `define` freely)?
2. **Ship phase 1 (text notebook) standalone**, or go straight to the
   notebook view?
3. **Dependency mechanism** — explicit `(ref 'x)` for v1 (recommended),
   or the `cell` sugar macro with static analysis from the start?
4. **Synchronous-only acceptable for v1?** A real Observable notebook is
   async-first; the Lisp has no concurrency.
5. **The host shell size** — confirm the ~10-primitive notebook-specific
   bridge over the more ambitious general DOM-primitive set.
6. **Notebook persistence** — serialise cells to a `.notebook` file as
   Lisp data; persist computed outputs, or recompute on open?

## Critical files

- `packages/stdlib/lisp/notebook.lisp` — **new**, the reactive engine.
- `packages/renderer/src/notebook-view.js` — **new** (phase 2), the
  DOM shell.
- `packages/stdlib/src/notebook-primitives.js` — **new** (phase 2), the
  host bridge.
- `apps/desktop/src/app.js`, `packages/stdlib/src/index.js` — wiring.
