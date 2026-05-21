# @editor/renderer — Layer 4

Presentation. The renderer projects L2 buffer state into the DOM and
turns keyboard input into editing commands. It never mutates the buffer
directly — input dispatches commands, the buffer emits events, and
those events drive rendering.

## Current state

The renderer renders syntax-highlighted lines, a blinking cursor and a
selection highlight, batches rendering on animation frames, and routes
keystrokes to a host dispatcher (the editor's Lisp keymap).
Highlighting is run-based — one span per highlighted run.
**Not yet present:** virtualisation; all lines are in the DOM.

## Design

The renderer is split so that everything except DOM mutation is pure
and unit-tested:

- `projection.js` — buffer state → a line model and selection
  rectangles.
- `keymap.js` — a keyboard event → an editor intent, or a normalised
  key string for the host keymap.
- `commands.js` — the renderer's built-in fallback keymap.
- `highlight.js` — tokenizers for the Lisp dialect and JavaScript.
- `treesitter.js` — tree-sitter highlighting for JavaScript, via
  `web-tree-sitter` and the prebuilt grammar in `vendor/`. The Lisp
  dialect keeps the tokenizer (it is custom and has no grammar).
- `runs.js` — splitting faced ranges into per-line runs.
- `fuzzy.js` — fuzzy filtering, for the command palette.
- `view.js` — the editor surface: builds elements, subscribes to the
  buffer, batches renders with `requestAnimationFrame`.
- `repl.js` — the REPL panel; `minibuffer.js` — the minibuffer (search,
  the command palette). Both are plain DOM, decoupled from the runtime.

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
