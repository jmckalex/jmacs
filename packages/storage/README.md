# @editor/storage — Layer 1

The text data structure. L1 has no semantic awareness: it knows what
characters are in a buffer, not what the buffer *means*. Semantics live
in Layer 2 (`@editor/buffer`).

Positions are **character offsets, zero-indexed**. Ranges are half-open
`[start, end)`. Lines and columns are zero-indexed.

## Current state

`createBuffer` is backed by a plain JavaScript string, so every edit
copies the whole text. This is correct but does not scale; the string
will be replaced by a piece tree behind this exact public API.

## API

```js
import { createBuffer, loadBuffer, saveBuffer } from '@editor/storage';

const buf = createBuffer('hello world');
buf.insert(5, ',');           // 'hello, world'
buf.delete(0, 7);             // 'world'        -> returns 'hello, '
buf.replace(0, 5, 'there');   // 'there'        -> returns 'world'
buf.undo();                   // back to 'world'

await saveBuffer(buf, '/tmp/note.txt');
const reloaded = await loadBuffer('/tmp/note.txt');
```

### Editing

- `insert(position, text)` — insert `text` beginning at `position`.
- `delete(start, end)` — remove `[start, end)`; returns the removed text.
- `replace(start, end, newText)` — swap a range; returns the old text.
- `undo()` / `redo()` — reverse or reapply the last edit; return a
  boolean. `canUndo` / `canRedo` report availability.

### Reading

- `toString()` — full contents. `slice(start?, end?)` — a sub-range.
- `length` — character count. `lineCount` — number of lines.
- `lineAt(position)` — the `{ number, from, to, text }` line at an offset.
- `positionAt(offset)` — offset to `{ line, column }`.
- `offsetAt(line, column)` — `{ line, column }` back to an offset.

### Observing

- `onChange(listener)` — fires after every mutation (including undo and
  redo) with a `{ start, removed, inserted }` change; returns an
  unsubscribe function.

### Persistence

- `loadBuffer(path)` — read a file into a new buffer.
- `saveBuffer(buffer, path)` — write a buffer's contents to a file.

## Tests

```
npm test
```

Uses the Node built-in test runner (`node --test`); no dependencies.
