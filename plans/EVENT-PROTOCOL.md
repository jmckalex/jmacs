# Sub-Plan: Change Event Protocol

## Purpose

The event protocol determines performance and correctness under load. Hard to change later because every layer depends on it. Worth pinning down carefully.

Document the protocol in `docs/api/events.md`.

## Event Flow

```
L1 (rope) → emits LowLevelEdit
L2 (buffer) → consumes LowLevelEdit, maintains text properties and markers, emits BufferChange
L4 (renderer) → consumes BufferChange, updates DOM
L3 (Lisp/JS) → before-change and after-change hooks fire around L2 mutations
```

## Event Types

### `LowLevelEdit` (L1 → L2)
```
{
  start: integer,
  oldLength: integer,
  newLength: integer,
  insertedText: string  // empty for pure deletions
}
```

L1 doesn't care about character semantics, only ranges. One operation produces one event.

### `BufferChange` (L2 → L4, L2 → hooks)
```
{
  buffer: BufferId,
  edit: {
    start: integer,
    oldEnd: integer,
    newEnd: integer,
    oldText: string,
    newText: string
  },
  affectedMarkers: [MarkerId],
  affectedOverlays: [OverlayId],
  affectedProperties: [PropertyKey],
  source: 'user' | 'program' | 'undo' | 'redo',
  undoGroup: UndoGroupId | null
}
```

Rich enough that consumers don't need to query L2 for context. The `affected*` fields let the renderer update incrementally.

### `PropertyChange` (L2 → L4)
```
{
  buffer: BufferId,
  start: integer,
  end: integer,
  key: PropertyKey,
  oldValue: any,
  newValue: any
}
```

Separate from BufferChange because property changes happen without content changes (e.g., syntax highlighting after an idle period).

### `OverlayChange` (L2 → L4)
```
{
  buffer: BufferId,
  overlayId: OverlayId,
  type: 'created' | 'moved' | 'modified' | 'deleted',
  oldRange: [integer, integer] | null,
  newRange: [integer, integer] | null,
  changedKeys: [PropertyKey]
}
```

### `StateChange` (L2 → L4)
For non-content state: point, mark, mode changes.
```
{
  buffer: BufferId,
  type: 'point' | 'mark' | 'major-mode' | 'minor-mode',
  oldValue: any,
  newValue: any
}
```

## Delivery Semantics

### Synchronous vs asynchronous
**Synchronous within a single command, asynchronous across commands.**

A single command runs to completion before events are delivered to L4. A command that makes 100 edits delivers 100 events as a batch when the command finishes, not interleaved.

This prevents the renderer from displaying intermediate inconsistent states and makes commands appear atomic to observers.

Hooks within the command (before-change, after-change) fire synchronously around each individual edit — they're inside the command's scope.

### Coalescing
L4 may coalesce events arriving in the same batch:
- Consecutive insertions in the same range → one render update
- Property changes that fully overlap content changes → folded into the content update
- Overlay creation and deletion within the same batch → may be elided if net effect is no change

L4 does this for performance; L2 doesn't pre-coalesce. L2 reports truth; L4 optimises display.

### Ordering
Within a batch, events arrive in **causal order** — the order operations were performed. The renderer can replay them sequentially to derive correct final state.

### Error handling
If a hook throws, error is caught, logged, offending hook not invoked again for the rest of the batch. The edit itself is not rolled back. Rolling back is too expensive and creates worse inconsistencies than the original error.

## Subscription API

```
subscribe(buffer, eventTypes, handler) → SubscriptionToken
unsubscribe(token)
```

`eventTypes` is a set of event type names; subscribers only receive types they ask for. Handler signature:
```
handler(events: [Event], batchInfo: BatchInfo)
```

Handlers always receive a batch, even if it's a batch of one. Forces handlers to think about batched updates from the start.

## Performance Budget

The protocol must support, on commodity hardware:

- A buffer with 1 million characters, syntax highlighting active
- Typing maintains steady 60fps (sub-16ms per keystroke)
- A bulk operation (find-replace-all across 10K-line file) completes within a few hundred ms with one render at the end

These are not stretch goals. They're table stakes.

## Implementation Guidance

For L2:
- Maintain dirty ranges between batches; emit batched events at command end
- Use interval trees for properties; updating on a range should be O(log n)
- Markers via balanced structure; updating affected markers after an insert is O(k log n) where k is markers in the affected range

For L4:
- Maintain viewport-aware rendering; only re-render visible content
- Use `requestAnimationFrame` to coalesce event batches arriving in quick succession
- Maintain a mirror data structure for minimal DOM patching
- Use CSS transforms for scrolling, not DOM reordering

## What Goes In The Document

`docs/api/events.md`:

1. **Event types** — schemas for each event
2. **Delivery semantics** — when events fire, batching rules, ordering
3. **Subscription API** — signatures and usage
4. **Performance contract** — what the protocol guarantees
5. **Examples** — walk through scenarios (typing a character, syntax highlighting, undoing a command) showing what events fire and when

5-10 pages. Decisions are concentrated.

## Self-Test

Walk through these:

1. **User types a character.** One L1 LowLevelEdit, one L2 BufferChange (source='user'), one L4 render. Sub-16ms.

2. **Syntax highlighter runs after idle.** No L1 event. Multiple L2 PropertyChange events. L4 batches into one render.

3. **Find-replace-all with 500 matches.** 500 L1 events, 500 L2 BufferChange events, all in one batch. L4 renders once. Few hundred ms total.

4. **A hook errors during after-change.** Error caught, logged, hook disabled for rest of batch. Subsequent edits proceed. User sees no broken state.

5. **User undoes a multi-edit command.** Single undo invocation produces a batch with source='undo', delivered atomically. L4 renders once.

If these work cleanly, the protocol is sound.
