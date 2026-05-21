# @editor/renderer — Layer 4

Presentation. The renderer projects L2 buffer state into the DOM and
turns keyboard input into editing commands. It never mutates the buffer
directly — input dispatches commands, the buffer emits events, and
those events drive rendering.

## Current state

A minimal but complete v0: it renders lines, a blinking cursor and a
selection highlight, batches rendering on animation frames, and handles
a built-in keymap. **Not yet present:** virtualisation (all lines are in
the DOM), run-based spans (one element per line, no syntax highlighting
yet), and tree-sitter. These arrive when they start to matter.

## Design

The renderer is split so that everything except the DOM mutation is
pure and unit-tested:

- `projection.js` — buffer state → a plain line model and selection
  rectangles. No DOM.
- `keymap.js` — a keyboard event → an editor intent. No DOM, no buffer.
- `commands.js` — applies an intent to a buffer. No DOM.
- `view.js` — the editor surface: builds elements, subscribes to the
  buffer, batches renders with `requestAnimationFrame`, and wires
  keystrokes through `commands.js`.
- `repl.js` — a REPL panel (scrollback log + input line with history).
  Plain DOM; it knows nothing about Lisp, reporting submitted source
  through an `onSubmit` callback and rendering whatever text it is
  handed. That keeps the renderer decoupled from the language runtime.

## API

```js
import { createEditorView, createReplView } from '@editor/renderer';

const view = createEditorView(buffer, document.getElementById('host'));
view.focus();
// view.element — the root node; view.destroy() — unsubscribe and remove.

const repl = createReplView(document.getElementById('repl-host'), {
  onSubmit: (source) => { /* evaluate, then repl.appendResult(...) */ },
});
```

Geometry uses CSS `ch` (columns) and `lh` (lines) units, so a monospace
font needs no pixel measurement. The host application owns the theme;
see `apps/desktop/styles.css`.

## Tests

```
npm test
```

Covers projection, keymap and commands. The DOM view is exercised by
the desktop app's smoke test (`apps/desktop`).
