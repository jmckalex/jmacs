# Sub-Plan: Layer 2 Buffer API

## Purpose

Layer 2 is the system's nervous system. Every piece of Lisp or JavaScript code that does anything interesting talks to L2. Every renderer update reflects L2 state. If L2 is right, the system composes well; if wrong, you fight it forever.

Write the L2 API as `docs/api/layer2.md` before serious implementation begins.

## What L2 Owns

- **Buffer**: a sequence of characters with associated state
- **Text properties**: arbitrary metadata attached to character ranges
- **Overlays**: ranges with attached metadata, distinct from text properties
- **Markers**: positions in a buffer that update correctly under edits
- **Modes**: tagged behaviour for a buffer
- **Hooks**: extension points
- **Point and mark**: cursor and selection anchor
- **Undo groups**: command-level transactions

## What L2 Does Not Own

Be strict about this — it's where API sprawl starts:

- **Rendering**: L4's job. L2 emits change events; L4 decides what to draw
- **Input**: L4's job. Key events arrive at L4, dispatched via keymaps
- **Command execution**: L3 / stdlib's job. L2 provides primitives; commands are extensions
- **File I/O**: L1's job for bytes; L2 holds contents but doesn't decide when to save
- **Syntax highlighting**: a consumer of L2 (sets text properties); L2 just provides the property machinery

## Core API Surface

Names are illustrative; rename as you like.

### Buffer lifecycle
```
create-buffer(name, options) → Buffer
destroy-buffer(buffer)
buffer-by-name(name) → Buffer | null
all-buffers() → [Buffer]
current-buffer() → Buffer
set-current-buffer(buffer)
```

### Buffer content
```
buffer-length(buffer) → integer
buffer-substring(buffer, start, end) → string
insert(buffer, position, text)
delete(buffer, start, end)
replace(buffer, start, end, text)
```

### Point and mark
```
point(buffer) → integer
set-point(buffer, position)
mark(buffer) → integer | null
set-mark(buffer, position)
region(buffer) → [integer, integer] | null
```

### Markers
```
make-marker(buffer, position, options) → Marker
marker-position(marker) → integer
set-marker-position(marker, position)
marker-buffer(marker) → Buffer
```

Marker options must include insertion behaviour: when text is inserted at the marker's position, does the marker stay or advance? Recommended default: after-insertion (marker stays with text before the insertion point). But provide both and require callers to specify.

### Text properties
```
get-text-property(buffer, position, key) → value | null
set-text-property(buffer, start, end, key, value)
remove-text-property(buffer, start, end, key)
text-property-ranges(buffer, key) → [(start, end, value)]
```

### Overlays
```
make-overlay(buffer, start, end, options) → Overlay
overlay-range(overlay) → [integer, integer]
move-overlay(overlay, start, end)
overlay-property(overlay, key) → value | null
set-overlay-property(overlay, key, value)
delete-overlay(overlay)
overlays-at(buffer, position) → [Overlay]
overlays-in(buffer, start, end) → [Overlay]
```

### Modes
```
buffer-major-mode(buffer) → symbol
set-major-mode(buffer, mode-symbol)
buffer-minor-modes(buffer) → [symbol]
enable-minor-mode(buffer, mode-symbol)
disable-minor-mode(buffer, mode-symbol)
```

Mode *definitions* are L3 / stdlib concerns. L2 just tracks which modes are active.

### Hooks
```
add-hook(hook-name, handler)
remove-hook(hook-name, handler)
run-hook(hook-name, args...)
```

Predefined hooks at minimum: `before-change`, `after-change`, `mode-activation`, `buffer-created`, `buffer-destroyed`.

### Undo
```
begin-undo-group(buffer)
end-undo-group(buffer)
undo(buffer)
redo(buffer)
```

Undo groups are explicit. Commands wrap themselves in `begin-undo-group`/`end-undo-group` so undo operates at command granularity.

## Hard Design Decisions

### Marker insertion semantics
See above. Decide and document.

### Text property merging
When you set property `:face` on range [10, 20] and then on range [15, 25], what's the value at position 17? **Last write wins, per key.** Position 17 sees only the second value. Implementation is an interval map per key.

### Overlay vs text property priority
When a character has both a text property and an overlay setting the same key, overlays "win" by default but each overlay declares a priority. Queries return either a list of all values or the highest-priority value with explicit precedence rules.

### Change event granularity
When you insert 1000 characters, L2 emits **one event**. Define an Edit type: `{ start, oldEnd, newEnd, oldText, newText }`. Each insert/delete/replace call produces exactly one Edit. Coalescing for performance is L4's concern.

### Multi-buffer atomicity
Undo groups are per-buffer. For cross-buffer operations, model as coordinated single-buffer groups with a higher-level transaction abstraction. Keeps L2 simple.

### Buffer encoding
Buffers hold Unicode (JavaScript strings, effectively UTF-16). Encoding is an I/O concern, handled at the L0/L1 boundary. Position indices are character positions, not byte positions.

### Position units
**Character positions, zero-indexed, half-open ranges `[start, end)`.** Document loudly.

## Dual-Language Bindings

The L2 API is exposed in both Lisp and JavaScript. The Lisp binding uses kebab-case (`buffer-length`); the JavaScript binding uses camelCase (`bufferLength`). Both wrap the same underlying operations.

Document this convention. When you add a new L2 operation, both bindings get updated.

## What Goes In The API Document

`docs/api/layer2.md`:

1. **Conceptual model** — what a buffer is, what a position is, what an overlay vs text property is
2. **Type signatures** — every public function with parameter types and return types (use JSDoc-compatible notation)
3. **Semantic rules** — what each operation does, what events it fires, what its undo behaviour is
4. **Invariants** — what L2 promises about consistency
5. **Examples** — short snippets exercising the API in both Lisp and JavaScript

Length: 15-30 pages once mature. Initial draft 5-10 pages covering the core surface.

## Mistakes to Watch For

- **Exposing implementation details.** Don't expose the rope structure, interval tree, anything internal. The API is *what* you can do, not *how*.

- **Convenience functions in core.** Resist adding `goto-line` or `forward-word` to L2. These are stdlib functions on L2 primitives. L2 has `set-point` and `buffer-substring`; that's enough.

- **Renderer concerns leaking in.** If the renderer needs something, ask whether L2 should provide it or whether the renderer should compute it. Often the second.

- **Premature optimisation hooks.** Don't add "fast path" APIs because you imagine an operation will be slow. Profile first.

- **Forgetting hooks.** Every state change should fire a hook. Hooks are how the system extends itself.

## Self-Test

Walk through these and confirm the API supports them cleanly:

1. **Open a file, edit it, save it.** L1 reads bytes, L2 wraps as a buffer, edits flow through L2, save round-trips through L1.

2. **Syntax highlight a buffer.** Lisp function called on `after-change`, parses changed region, sets text properties for syntax categories. Renderer sees property changes, re-renders affected ranges.

3. **Mark a region, kill it, yank it elsewhere.** Mark set, point moves, region extracted, text deleted, point moves, text inserted with text properties preserved.

4. **A long-running operation with progress.** Function modifies buffer in chunks, each an undo group, user can interrupt. Hooks fire correctly.

5. **Cross-language: JavaScript code defines a function, Lisp code calls it, the function modifies a buffer.** All hooks fire, all events propagate, both languages see consistent state.

If these all work cleanly, the API is ready.
