# The reactive Lisp notebook

A **notebook** is a sheet of named cells, each holding a Lisp expression.
A cell can read another cell's value with `(ref 'name)`, and editing one
cell recomputes everything downstream — spreadsheet / Observable style.

## Opening one

- `C-c n` (or `M-x notebook`) — a fresh in-memory `*notebook*`.
- Open a `.rxlisp` file — it mounts as a notebook, not a text editor.

## Cells

The canonical source is a sequence of `(cell NAME EXPR)` forms:

```lisp
(cell radius 5)
(cell area (* 3.14159 (* (ref 'radius) (ref 'radius))))
(cell summary (str "r=" (ref 'radius) ", area=" (ref 'area)))
```

Each cell in the view is a **name field**, a **multi-line expression
editor**, a **result panel** (`→ value`), and a **state badge**:

| Badge | State |
|---|---|
| ● | `ok` — evaluated cleanly |
| ◌ | `stale` — edited, not yet recomputed |
| ✕ | `error` — the expression threw |
| ⟳ | `cycle` — part of a dependency loop |

Dependencies are discovered **at run time**: whatever a cell actually
reads via `(ref 'name)` becomes its dependency (so a `(ref …)` inside a
branch only counts when that branch runs). The engine topologically
sorts the graph (Kahn's algorithm), recomputes in order, and flags any
dependency cycle instead of looping forever. A cell's body is evaluated
in the global interpreter but its name is **not** defined globally —
values live in the notebook, reachable only through `ref`.

## Editing

| Key | Action |
|---|---|
| `Enter` | evaluate / commit the cell now |
| `Shift-Enter` | newline within the expression |
| `M-↑` / `M-↓` | move the cell up / down |
| `+ cell` | append a new cell |
| `×` | delete the cell |

Typing debounces a recompute; editor chords (`C-x b`, `M-x`, prefix
continuations) still reach the host keymap while a cell editor is
focused.

## Persistence

`C-x C-s` saves the notebook to a `.rxlisp` file. The file holds only the
canonical `(cell …)` source — results live in the view, never on disk, so
the file stays clean and diffable. Reopening the file (or restoring a
session) re-evaluates from source.

## Where the code lives

- **Engine** — `packages/stdlib/lisp/notebook.lisp` (pure Lisp: parse →
  dependency graph → topo-sort → recompute → format). The host bridge is
  `notebook-eval!`, returning marshalled per-cell records.
- **View** — `packages/renderer/src/notebook-view.js` (the
  `<notebook-view>` custom element + pure helpers).
- **Wiring** — `apps/desktop/src/app.js` (`configureNotebookView`,
  `open-notebook-buffer!`, the `notebook` kind) and
  `apps/desktop/src/files.js` (the `.rxlisp` suffix).
- **Command** — `packages/stdlib/lisp/notebook-commands.lisp`.

`sample-documents/demo.rxlisp` is a worked example.
