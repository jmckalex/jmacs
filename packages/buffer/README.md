# @editor/buffer — Layer 2

The conceptual heart of the editor. L2 wraps an L1 storage buffer
(`@editor/storage`) and adds what an *editor* needs: a cursor, a
selection, editing commands, and change events.

Offsets are character positions, zero-indexed; ranges are half-open.

## Current state

A deliberately minimal L2. It has point, mark, editing commands,
movement, undo/redo and change events — enough to drive an editable
window. **Not yet present:** text properties, overlays, markers, modes,
hooks. The architecture names all of these; they are layered on once
the editor runs end to end.

## API

```js
import { createBuffer } from '@editor/buffer';

const buf = createBuffer('hello', { name: 'greeting' });
buf.moveTo(5);
buf.insert(' world');     // 'hello world', cursor at 11
buf.deleteBackward();     // 'hello worl'
buf.undo();               // 'hello world'

buf.onChange((event) => {
  // event: { change, point, mark }
});
```

### Cursor

- `point` — the cursor offset. `mark` — the selection anchor, or `null`.
- `selection` — `{ start, end }` of the selected range, or `null`.
- `moveTo(offset, { extend })`, `moveLeft/Right/Up/Down`,
  `moveLineStart/End`, `moveBufferStart/End` — all accept `{ extend }`
  to grow a selection.
- `setMark(offset | null)`, `clearMark()`.

### Editing (relative to the cursor)

- `insert(text)` — insert at the cursor, replacing any selection.
- `deleteBackward(count?)` / `deleteForward(count?)` — delete around the
  cursor, or delete the selection if one is active.
- `setText(text)` — replace the entire contents (used to load a file).
- `undo()` / `redo()` — with `canUndo` / `canRedo`.

### Reading

- `text` / `toString()`, `length`, `lineCount`, `slice(start?, end?)`.
- `lineAt`, `positionAt`, `offsetAt` — delegated to L1, for the renderer.

### Observing

- `onChange(listener)` — fires after every mutation *and* cursor move
  with a `{ change, point, mark }` event; `change` is `null` for a pure
  cursor move. Returns an unsubscribe function.

## Tests

```
npm test
```

Uses the Node built-in test runner (`node --test`).
