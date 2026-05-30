# Custom views

A *view* is the Layer 4 component that paints a buffer (or, more
generally, a `kind`-typed model) into the DOM and turns keystrokes back
into commands. Most buffers are text — the editor view (`text-view.js`)
handles them. But not everything in the editor *is* text: the
customisation UI is a form, an image is an `<img>`, a doc page is
rendered HTML, a jukebox is `<audio>` plus cover art.

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
- **The `kind` marker.** Non-text views are plain JS objects (created
  by `createView({ kind: '<name>', ... })`) with a `kind` property
  and whatever payload the matching view needs. They do not pretend to
  be text buffers — they have no `point`, no `text`, no `onChange`.
  They sit in `views[]` alongside text views so `C-x b`, `kill-view`,
  the buffer-list and the modeline see them.

The renderer chooses a view by reading `view.kind`. The custom element
whose tag matches the kind is the one that paints it.

## Existing kinds

| Kind                | Custom element            | What it shows                                                  |
| ------------------- | ------------------------- | -------------------------------------------------------------- |
| `text`              | `<text-view>`             | The editor view; the default. Wraps an L2 buffer.              |
| `tabline`           | `<tabline-view>`          | A *structural* view — its tabs are child views (one active).   |
| `customize`         | `<customize-view>`        | The customisation form — typed widgets for the registry.       |
| `image`             | `<image-view>`            | An `<img>` with a fit/actual zoom toggle.                      |
| `doc`               | `<doc-view>`              | A pre-rendered HTML doc page with cross-link routing.          |
| `audio`             | `<audio-view>`            | Cover art + `<audio>` + editable ID3 metadata.                 |
| `video`             | `<video-view>`            | An `<video controls>` with caption metadata.                   |
| `shell`             | `<shell-view>`            | xterm.js terminal connected to a host-side pty.                |
| `jukebox`           | `<jukebox-view>`          | Cover art, `<audio>` controls, a track list, shuffle/randomise. |
| `directory-tree`    | `<directory-tree-view>`   | A tree of folder rows; click → open file in adjacent tab.     |
| `directory-columns` | `<directory-columns-view>`| Finder-style horizontal browser with file previews.            |

## The view contract

A view is a **custom HTML element**. Each kind extends `ViewElement`
(the base from `packages/renderer/src/view-elements.js` — `HTMLElement`
in the browser, a stub in Node so the pure-helper tests can load the
module).

The minimum surface a host needs is four methods:

```js
import { defineViewElement, ViewElement } from './view-elements.js';

export class MyView extends ViewElement {
  constructor() {
    super();
    this._buffer = null;
    this._options = null;
  }

  /** Called before the first connectedCallback to wire host-supplied
   *  closures (onKey, openDoc, audio controller, etc.). Reconfiguring
   *  after mount throws. */
  configure(options) {
    if (this._buffer !== null) throw new Error('reconfigure after mount');
    this._options = options ?? null;
  }

  /** Identity getter — used by the host's mount dispatch and the
   *  modeline to know what kind of view this is without instanceof. */
  get kind() { return 'my-kind'; }

  /** Repoint at a different view payload. */
  setBuffer(view) { this._buffer = view; if (this._mounted) this._paint(); }

  /** Focus the right inner element. */
  focus() { /* this.querySelector('input').focus() etc. */ }

  /** Custom-element lifecycle — fired on first append. Build inner DOM
   *  lazily (so warehouse-style "constructed but not yet shown" works). */
  connectedCallback() { this._ensureMounted(); this._paint(); }

  /** Moves and destroys are indistinguishable here. Empty by convention. */
  disconnectedCallback() { /* intentionally empty */ }

  /** Explicit teardown — the host's kill-view path calls this. Release
   *  external resources (pty handles, audio sources, media elements). */
  destroy() { /* clean up here */ this._buffer = null; }
}

defineViewElement('my-view', MyView);
```

A few conventions every kind follows:

- **Constructor does no DOM work.** Custom-element constructors must be
  argument-less and side-effect-free; mounting is what
  `connectedCallback` is for.
- **`disconnectedCallback` is empty** unless the kind has a real reason
  to react. A `pane → warehouse` move fires it; so does a real
  teardown. There's no way to distinguish those inside the callback.
  Real teardown is `destroy()`, called explicitly by the kill-view
  path.
- **State lives on instance fields**, not module globals. Per-view
  point, scroll position, mode — all instance state. Identity that's
  useful in DevTools (a file path, a kind name) belongs on
  attributes — `this.setAttribute('data-file-path', path)`.
- **The element IS the root.** Earlier code returned `{ element, ... }`
  from a factory; the element wraps a `.foo-view` div. New conversions
  inline the inner DOM directly inside the custom element; older
  conversions use a thin wrapper around the existing factory (the
  TextView / AudioView pattern). Both work; both pass through
  setBuffer / focus / destroy.

## Dispatch in `app.js`

There is no `kindRegistry` and no per-kind `if/else` chain anymore.
Two helpers handle every kind:

```js
function mountKindView(view, context) {
  if (!view || typeof view.kind !== 'string') return;
  if (view.kind === 'text')    { ...applyTextMountSideEffects(view); return; }
  if (view.kind === 'tabline') { mountTablineKind(view, context); return; }
  const el = singletonElementForKind(view.kind);
  if (el) { el.setBuffer(view); el.focus(); }
}

function disposeKindView(view, context) {
  if (view.kind === 'shell')   { window.host.shellKill(view.sessionId); return; }
  if (view.kind === 'tabline') { disposeTablineKind(view, context); return; }
}
```

`singletonElementForKind` looks up the kind in `SINGLETON_VIEWS` — a
single `[{ kind, el, releasesBuffer }, ...]` array declared once next
to `mountKindView`. Adding a new kind means appending one entry there
plus the one-line import.

`hideInactiveRendererViews` iterates the same `SINGLETON_VIEWS` to
toggle `display: none` based on which kinds are currently in use across
the pane tree. Media-bearing kinds (audio / video / shell) also get
`setBuffer(null)` when their kind isn't in use anywhere, so a hidden
audio view doesn't keep streaming.

## Adding a new view — step by step

Say you want a tag-cloud view, `kind: 'tag-cloud'`.

1. **Write the class.** Drop a new file
   `packages/renderer/src/tag-cloud-view.js`. Extend `ViewElement`.
   Implement `configure` / `setBuffer` / `focus` / `connectedCallback`
   / `destroy`. Use `image-view.js` as a template for an inline
   conversion (single file, all logic in the class) or `audio-view.js`
   for the wrapper pattern (class wraps an existing factory). End the
   file with `defineViewElement('tag-cloud-view', TagCloudView)`.

2. **Export it.** Add to `packages/renderer/src/index.js`:

   ```js
   export { TagCloudView } from './tag-cloud-view.js';
   ```

3. **Create the singleton.** In `app.js`, after the other singletons:

   ```js
   const tagCloudView = /** @type {*} */ (document.createElement('tag-cloud-view'));
   tagCloudView.configure({
     ...(keymapReady ? { onKey: dispatchKey } : {}),
     // ...host-provided callbacks...
   });
   editorPaneElement().append(tagCloudView);
   tagCloudView.style.display = 'none';
   ```

4. **Register it.** Add one line to `SINGLETON_VIEWS`:

   ```js
   { kind: 'tag-cloud', el: tagCloudView, releasesBuffer: false },
   ```

   That single edit teaches `singletonElementForKind` (so
   `mountKindView` finds the element on tab-activate) and
   `hideInactiveRendererViews` (so visibility toggles correctly). No
   other dispatch sites need updating.

5. **Add the import.** At the top of `app.js`:

   ```js
   import { ..., TagCloudView, ... } from '@editor/renderer';
   ```

   The named import is what triggers the module's
   `defineViewElement('tag-cloud-view', ...)` side effect.

6. **Create views with the right shape.** Either from the host (a plain
   `createView({ kind: 'tag-cloud', tags, ... })` pushed into `views[]`)
   or from Lisp through a host primitive that does the push and routes
   to the new view.

7. **Add a Lisp command** that creates it. Wrap the primitive in a
   `defcommand` in the standard library so the user can run it through
   `M-x`. Bind a key if it deserves one.

8. **CSS.** Style the tag and (for now) the inner class:

   ```css
   tag-cloud-view,
   .tag-cloud-view {
     display: flex;
     height: 100%;
     /* ... */
   }
   ```

   The tag selector handles the wrapper; the class selector covers the
   pre-Phase-3 dual structure (factory creates an inner `.foo-view`
   div). Once a kind is fully inlined into its class — no inner div
   — only the tag selector is needed.

9. **Tests.** Pure helpers in the view module get Node tests under
   `packages/renderer/test/`. Anything that touches a real DOM is
   covered by the desktop smoke test
   (`apps/desktop/scripts/smoke.js`) — there is no jsdom-style test
   setup in the repo. Per-kind lifecycle behaviour (mount on
   connect, hide-not-kill on disconnect, real teardown via
   `destroy()`) is exercised end-to-end by the smoke arm.

## When to use a custom view vs a text-buffer mode

A text-buffer mode dresses up the *editor* view: keymap, syntax
highlighting, faces. The buffer is still text; commands still mutate
it.

A custom view replaces the editor view with arbitrary DOM. The view
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
host primitive that creates the view and hands it state, plus the
existing audio primitives. The view owns the playlist, the shuffle
flag, and the current track index.

The rule of thumb: **if you find yourself writing buffer text whose
sole purpose is to be re-rendered by your mode after every command,
you want a custom view.**

## Q9 by construction

Under the custom-element model, the DOM enforces the single-parent
invariant: a `<text-view>` element can be in at most one parent at a
time. Moving it from one pane to another is a single `appendChild`
call — the old parent automatically loses the child. This is what
the architecture refers to as **Q9 ("no same View in two panes") by
construction**: there is no bookkeeping pass to "remove the view from
the old place"; the platform doesn't let it be in two places to begin
with.

The earlier architecture (pre-Phase-2c) had to manage this with
helpers like `removeViewFromAllTablines` walking the tab arrays. Those
helpers stay around for now because tabline tabs still live as a JS
array on the tabline-view object, separately from the DOM; once tabs
migrate to being DOM children of the `<tabline-view>` element, the Q9
guarantee extends to them too and the helpers can be deleted.
