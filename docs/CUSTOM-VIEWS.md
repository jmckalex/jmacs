# Custom views

A *view* is the Layer 4 component that paints a buffer into the DOM and
turns keystrokes back into commands. Most buffers are text — the editor
view (`view.js`) handles them. But not everything in the editor *is*
text: the customisation UI is a form, an image is an `<img>`, a doc
page is rendered HTML, a jukebox is `<audio>` plus cover art.

This document explains how the renderer chooses a view for a buffer,
how to add a new view, and — at the end — when you should reach for a
custom view rather than a text-mode keymap.

## Layering recap

| Layer | What it owns                                       |
| ----- | -------------------------------------------------- |
| L1    | Storage primitives (the rope).                     |
| L2    | The `buffer` object — text plus semantic metadata. |
| L3    | The Lisp interpreter and standard library.         |
| L4    | The renderer: views, keymap, projection, DOM.      |

Two pieces of L2 matter for views:

- **The text buffer.** `createBuffer()` returns a rich object with
  `text`, `point`, `setText()`, `onChange()`, `majorMode`, and so on.
  This is what the *editor* view edits.
- **The `kind` marker.** Non-text buffers are plain JS objects with a
  `kind: '<name>'` property and whatever payload the matching view
  needs. They do not pretend to be text buffers — they have no `point`,
  no `text`, no `onChange`. They sit in `buffers[]` alongside text
  buffers so `C-x b`, `kill-buffer`, the buffer-list and the modeline
  see them.

The renderer chooses a view by reading `buffer.kind`. A buffer with no
`kind` is a text buffer; everything else dispatches by name.

## Existing kinds

| Kind         | Created by                       | View module             | What it shows                                          |
| ------------ | -------------------------------- | ----------------------- | ------------------------------------------------------ |
| (none/text)  | `createBuffer()`                 | `view.js`               | The editor view. The default; this is what *is* a buffer in the textbook sense. |
| `customize`  | `openCustomize()` (app.js)       | `customize.js`          | The customisation form — typed widgets for the registry. |
| `image`      | `openFileInteractive()` on an image, or `open-image-file!` | `image-view.js` | An `<img>` with a fit/actual zoom toggle. |
| `doc`        | `openDocBuffer()` / `openDocstringBuffer()` (app.js) | `doc-view.js` | A pre-rendered HTML doc page with cross-link routing. |
| `jukebox`    | `(jukebox <dir>)` Lisp command   | `jukebox-view.js`       | Cover art, `<audio>` controls, a track list, shuffle/randomise. |

## The view contract

A view is a factory:

```js
function createXView(container, options) { ... }
```

It mounts an element into `container` and returns an object with:

```
{
  element,          // The root HTMLElement. The host shows/hides it.
  setBuffer(buf),   // Called when the buffer the view should show changes.
  focus(),          // Called after mounting so keystrokes land here.
}
```

Beyond that, the view may take a `onKey(keyString)` callback so chord
keys (`C-x b`, `M-x`, `C-h k`) still dispatch through the Lisp keymap
when typed in the view. Other callbacks are per-view (the doc view
takes `openDoc`, the customize view takes `applySetting`, etc.).

The host (`apps/desktop/src/app.js`) builds all views once at startup,
hides them all, and unhides exactly one in `switchToBuffer()` — see
`mountView(kind)`.

### Dispatch in app.js

`switchToBuffer(index)` is the entire dispatch:

```js
const buffer = buffers[index];
if (buffer.kind === 'customize') {
  mountView('customize');
  customizeView.setBuffer(buffer);
  customizeView.focus();
} else if (buffer.kind === 'image') {
  mountView('image');
  imageView.setBuffer(buffer);
  imageView.focus();
} else if (buffer.kind === 'doc') {
  mountView('doc');
  docView.setBuffer(buffer);
  docView.focus();
} else if (buffer.kind === 'jukebox') {
  mountView('jukebox');
  jukeboxView.setBuffer(buffer);
  jukeboxView.focus();
} else {
  // text path: re-point the editor view, watch the buffer,
  // ensure a major mode, focus.
}
```

`mountView(kind)` just toggles `display: none` on every view's root and
unhides the one whose name matches.

## Adding a new view — step by step

Say you want an `org-mode`-style outline view, `kind: 'outline'`.

1. **Write the view module.** Drop a new file
   `packages/renderer/src/outline-view.js`. Follow `image-view.js` for
   the shape: a factory that creates a root element, attaches a
   `keydown` listener that forwards through `onKey`, and exposes
   `{ element, setBuffer, focus }`. Keep it pure DOM — no filesystem,
   no Lisp.

2. **Export it.** Add the export from `packages/renderer/src/index.js`:

   ```js
   export { createOutlineView } from './outline-view.js';
   ```

3. **Mount it in `app.js`.** After the other views are created:

   ```js
   import { createOutlineView } from '@editor/renderer';

   const outlineView = createOutlineView(
     document.getElementById('editor-host'),
     { ...(keymapReady ? { onKey: dispatchKey } : {}) }
   );
   outlineView.element.style.display = 'none';
   ```

4. **Teach `switchToBuffer` and `mountView` the new kind.** Add a
   branch to the `if`/`else if` chain in `switchToBuffer`, and an entry
   to `mountView` that sets `display` on `outlineView.element`.

5. **Create buffers with the right shape.** Either from the host (a
   plain `{ kind: 'outline', name, … }` pushed into `buffers[]`) or
   from Lisp through a host primitive that does the push and the
   `switchToBuffer(buffers.length - 1)`.

6. **Add a Lisp command that creates it.** Wrap the primitive in a
   command in the standard library so the user can run it through
   `M-x`. Bind a key if it deserves one.

7. **(Optional) Cosmetic CSS.** Per-view styles go in
   `apps/desktop/styles.css`; the convention is `.outline-view {…}`
   matching the root `className`.

8. **Tests.** Pure helpers in the view module get Node tests under
   `packages/renderer/test/`. Anything that touches a real DOM is
   covered by the desktop smoke test (`apps/desktop/scripts/smoke.js`)
   — there is no jsdom-style test setup in the repo.

## When to use a custom view vs a text-buffer mode

A text-buffer mode dresses up the *editor* view: keymap, syntax
highlighting, faces. The buffer is still text; commands still mutate
it.

A custom view replaces the editor view with arbitrary DOM. The buffer
is not text; commands talk to view state directly.

Reach for **a mode** when:

- The user reads and edits text. (Programming, prose, Lisp.)
- The metaphor is "type characters, save bytes."
- A keymap and some syntax classes do the job.

Reach for **a custom view** when one or more of these is true:

- Native DOM elements do the work better (`<audio>`, `<video>`,
  `<img>`, `<input type="color">`, an `<iframe>`, a `<canvas>`).
- The "buffer body" is regenerated wholesale on every action — there
  are no characters the user types into it.
- Plain text would mis-fight the editor for keys. (SPC means "play",
  not "insert a space"; RET means "play this track", not "newline".)
- Visual elements (an image, a colour swatch, a progress bar made of
  real CSS) belong in the model, not in a Unicode approximation.

### The jukebox as a cautionary tale

The first jukebox was a text-buffer mode. The "panel" was a string
re-rendered after every command; box-drawing characters drew the
progress bar; the playlist was rendered as numbered lines.

Two classes of bug followed:

- **Keymap competition.** SPC in a text buffer wants to insert a
  space. The mode's binding for SPC ("play / pause") fought with that;
  the fix was a workaround in the renderer's keymap module (printable
  characters arrive as the literal character, not as `"space"`), and
  the mode bound `" "` instead of `"space"`. Every key that has a
  natural text meaning hits this problem.
- **The body is not text.** Moving the now-playing pointer meant
  re-rendering the whole panel and then walking point down N lines to
  the right track row, in Lisp, by counting newlines — because the
  buffer's `positionAt` was not exposed. None of this is meaningful
  edit history; it is paint code masquerading as buffer state.

The replacement (`packages/renderer/src/jukebox-view.js`) is a custom
view: an `<img>` for the cover, an `<audio controls>`, a real `<ol>`
track list whose items are buttons. Keystrokes are caught on the view
root and routed through `onKey` for chord keys; everything else (SPC,
RET, n, p, …) is handled by direct DOM event listeners on the view.
There is no buffer text to fight with.

The Lisp side of the jukebox shrinks to: a single command, a single
host primitive that creates the buffer and hands the view its state,
plus the existing audio primitives. The view owns the playlist, the
shuffle flag, and the current track index.

The rule of thumb: **if you find yourself writing buffer text whose
sole purpose is to be re-rendered by your mode after every command,
you want a custom view.**
