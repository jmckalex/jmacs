# The reactive Lisp notebook

A **notebook** is a sheet of named cells, each holding a Lisp expression.
A cell reads another cell's value **by bare name**, and editing one cell
recomputes everything downstream — spreadsheet / Observable style.

## Opening one

- `C-c n` (or `M-x notebook`) — a fresh in-memory `*notebook*`.
- Open a `.rxlisp` file — it mounts as a notebook, not a text editor.

## Cells

The canonical source is a sequence of `(cell NAME EXPR)` forms. A cell
refers to another just by writing its name:

```lisp
(cell radius 5)
(cell area (* 3.14159 radius radius))
(cell summary (str "r=" radius ", area=" area))
```

Bare names are rewritten to `(ref 'name)` before evaluation, so the
explicit `(ref 'name)` form still works too. The rewrite respects local
bindings — a `lambda` / `let` variable that happens to share a cell's
name shadows it as usual.

Each cell in the view is a **name field**, a **multi-line expression
editor**, a **result panel** (`→ value`), and a **state badge**:

| Badge | State |
|---|---|
| ● | `ok` — evaluated cleanly |
| ◌ | `stale` — edited, not yet recomputed |
| ✕ | `error` — the expression threw |
| ⟳ | `cycle` — part of a dependency loop |

Dependencies are discovered **at run time**: whatever a cell actually
reads becomes its dependency (so a name read only inside a branch counts
only when that branch runs). The engine topologically
sorts the graph (Kahn's algorithm), recomputes in order, and flags any
dependency cycle instead of looping forever. A cell's body is evaluated
in the global interpreter but its name is **not** defined globally —
values live in the notebook, reachable only through `ref`.

## Graphics

A cell whose value is an **SVG string** is drawn inline instead of being
shown as text — so a cell can produce a picture, not just a number:

```lisp
(cell dot (str "<svg width='90' height='90'>"
               "<circle cx='45' cy='45' r='" (* radius 5) "' fill='#5aa9e6'/></svg>"))
```

The SVG is just a value, so it's reactive like everything else — editing
`radius` redraws the circle. Any `<svg …>…</svg>` string works (built by
hand or from a helper). The markup is your own notebook output, rendered
with the same trust model as a REPL eval.

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
