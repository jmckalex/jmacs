# Layer 2 — the Buffer API

This document describes the Layer 2 buffer API as implemented in
`packages/buffer`. L2 is the conceptual heart of the editor: it wraps
L1 storage and adds the things an *editor* needs — a cursor, a
selection, editing commands, and change events. It is the surface that
the renderer and (through host primitives) the Lisp runtime talk to.

The architecture flags this surface as one that compounds: extensions
depend on it. This document is the explicit record of it.

Offsets are character positions, zero-indexed. Ranges are half-open
`[start, end)`. Lines and columns are zero-indexed.

## Creating a buffer

```js
import { createBuffer } from '@editor/buffer';

const buffer = createBuffer('initial text', { name: 'file.txt' });
```

- `createBuffer(initialText = '', options = {})` → a buffer.
- `options.name` — a human-readable name (default `'untitled'`).

## Reading

| Member | Description |
|--------|-------------|
| `text` / `toString()` | The full contents. |
| `length` | Character count. |
| `lineCount` | Number of lines (always ≥ 1). |
| `name` | The buffer's name (settable). |
| `slice(start?, end?)` | Text of a range. |
| `lineAt(offset)` | `{ number, from, to, text }` — the line containing `offset`. `to` excludes the newline. |
| `positionAt(offset)` | `{ line, column }` for an offset. |
| `offsetAt(line, column)` | The offset for a line/column; `column` is clamped to the line. |

## Point, mark and selection

The **point** is the cursor; the **mark** is the selection anchor.

| Member | Description |
|--------|-------------|
| `point` | The cursor offset. |
| `mark` | The anchor offset, or `null`. |
| `selection` | `{ start, end }` of the selected range, or `null`. |
| `setMark(offset \| null)` | Set or clear the anchor. |
| `clearMark()` | Clear the anchor. |

## Movement

Each movement method accepts `{ extend }`; when `extend` is true the
mark is kept (or set) so the move grows a selection.

- `moveTo(offset, { extend })` — to an absolute offset (clamped).
- `moveLeft` / `moveRight` / `moveUp` / `moveDown`.
- `moveLineStart` / `moveLineEnd`.
- `moveBufferStart` / `moveBufferEnd`.

## Editing

All editing is relative to the cursor.

- `insert(text)` — insert at the cursor, replacing any selection.
- `deleteBackward(count = 1)` / `deleteForward(count = 1)` — delete
  around the cursor, or the selection if one is active. Each returns
  whether anything was deleted.
- `setText(text)` — replace the whole buffer (used to load a file);
  the cursor moves to the start.

## Modes

A buffer carries a **major mode** and a list of **minor modes**. L2
stores them as opaque values — it never interprets them; the standard
library defines what a mode is.

| Member | Description |
|--------|-------------|
| `majorMode` | The major mode, or `null` (settable). |
| `minorModes` | The active minor modes — an opaque value, or `null` (settable). |

Setting either emits a change event (`change: null`), so the renderer
and modeline refresh exactly as they do for an edit or cursor move.

## History

- `undo()` / `redo()` — reverse or reapply the last edit; return a
  boolean. The cursor moves to the changed region.
- `canUndo` / `canRedo` — availability.

Undo is currently per-L1-edit (one keystroke is one undoable step).
Command-level undo grouping is a planned L2 addition.

## Change events — the protocol

```js
const unsubscribe = buffer.onChange((event) => { … });
```

`onChange(listener)` registers a listener and returns an unsubscribe
function. The listener fires after **every** mutation *and* every
cursor move, with a `BufferEvent`:

```
BufferEvent = {
  change: BufferChange | null,   // null for a pure cursor move
  point:  number,                // the cursor after the event
  mark:   number | null,         // the anchor after the event
}
```

A `BufferChange` is the underlying L1 edit — one uniform shape for
insert, delete and replace:

```
BufferChange = {
  start:    number,   // offset where the change begins
  removed:  string,   // text removed at `start`  ('' for an insert)
  inserted: string,   // text inserted at `start`  ('' for a delete)
}
```

So a consumer can update incrementally: `change` is `null` when only
the cursor moved (re-place the cursor), and otherwise describes exactly
what text changed. The renderer (L4) drives all of its rendering from
this event.

Events fire synchronously, in subscription order, including for `undo`
and `redo`.

## What L2 does not have yet

The architecture names more for L2; these are not built:

- **Text properties** and **overlays** — metadata on ranges.
- **Markers** — positions that survive edits.
- **Hooks** — before/after-change extension points.
- **Undo groups** — command-level transactions over L1's undo.

They are layered on without changing the surface above. (Modes now
have a home — see *Modes* above; their semantics live in the standard
library, specified in `docs/spec/modes.md`.)
