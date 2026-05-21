# @editor/storage — Layer 1

The text data structure. L1 has no semantic awareness: it knows what
characters are in a buffer, not what the buffer *means*.

Position units are **character positions, zero-indexed**. Ranges are
half-open `[start, end)`.

## Current state

A deliberately minimal start. `createBuffer` is backed by a plain
JavaScript string. This is correct but not scalable — every insert
copies the whole text. The string will be replaced by a piece tree
(efficient inserts, deletes, range queries, undo/redo) without changing
the public API.

## API

```js
import { createBuffer } from '@editor/storage';

const buf = createBuffer('hello world');
buf.insert(5, ',');
buf.toString(); // => 'hello, world'
```

- `createBuffer(initialText?)` — create a buffer, optionally seeded with text.
- `buffer.insert(position, text)` — insert `text` so it begins at `position`.
- `buffer.toString()` — the buffer's full contents as a string.

## Tests

```
npm test
```

Uses the Node built-in test runner (`node --test`); no dependencies.
