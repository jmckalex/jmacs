# Browser view

A `<browser-view>` custom element — a thin chrome (URL bar, back /
forward / reload buttons) wrapping Electron's native `<webview>`
tag. Lets the user open a URL inside a Godot pane, navigate
normally, drop the page into a tabline alongside text views.

Effort: **1-2 focused days** for v1.

## Why this fits Godot's character

Custom views are how Godot escapes the "everything is text" trap
(see `docs/CUSTOM-VIEWS.md`). A browser is the canonical case:
typing into a URL bar shouldn't compete with the editor's keymap;
SPC shouldn't insert a space into a web page. The `<webview>`
element does the rendering work; Godot just adds the chrome and
wires the keystroke dispatch.

It's also useful as a research surface for an editor that already
treats citations (citation.js) and documentation pages (`<doc-view>`)
as first-class kinds. Opening the relevant Wikipedia / Stack
Overflow / docs page next to the code you're editing is a clean
workflow.

## Architecture

### The class

`class BrowserView extends ViewElement`, registered as
`<browser-view>` via `defineViewElement('browser-view', BrowserView)`.
Follows the existing pattern (TextView, ImageView, AudioView):
`configure` → `connectedCallback` → `setBuffer` / `focus` /
`destroy`. Kind getter returns `'browser'`.

### Inner DOM

```html
<browser-view>
  <div class="browser-toolbar">
    <button class="browser-back" title="Back">←</button>
    <button class="browser-forward" title="Forward">→</button>
    <button class="browser-reload" title="Reload">⟳</button>
    <input class="browser-url" type="text" spellcheck="false">
    <button class="browser-stop" title="Stop" hidden>×</button>
  </div>
  <webview class="browser-content"
           partition="persist:browser-views"></webview>
</browser-view>
```

CSS: toolbar is `flex: 0 0 36px`, webview is `flex: 1`. URL input
is `flex: 1` inside the toolbar; buttons keep their natural width.

The `partition="persist:browser-views"` attribute shares cookies /
localStorage across all browser views in Godot, isolated from
anything else the editor embeds. Logged-in sites stay logged in
across Godot restarts.

### State

Lives on the element:

- `_options` — `{ onKey, defaultUrl, partition }`
- `_pendingUrl` — set by `setBuffer` before the DOM is mounted

The `<webview>` owns history, current URL, title, loading state.
The wrapper reads those out via webview methods and events.

### Electron prerequisite

`apps/desktop/src/main.js` (or wherever `BrowserWindow` is
constructed) needs:

```js
webPreferences: {
  ...existingFlags,
  webviewTag: true,
}
```

`<webview>` has been disabled by default in Electron since 5.0 for
security. Enabling it is a one-line change. The other flags
(`contextIsolation: true`, etc.) should stay as they are.

## Wiring

In `connectedCallback`, after `_ensureMounted` builds the toolbar
and webview, wire eight events:

| Source                              | Effect                                              |
|-------------------------------------|-----------------------------------------------------|
| `back` click                        | `webview.canGoBack() && webview.goBack()`           |
| `forward` click                     | `webview.canGoForward() && webview.goForward()`     |
| `reload` click                      | `webview.reload()`                                  |
| `stop` click                        | `webview.stop()`                                    |
| URL input Enter                     | `webview.loadURL(normalize(input.value))`           |
| `webview` `did-navigate`            | Update URL input; enable / disable back+forward     |
| `webview` `page-title-updated`      | Update `view.name`, call `notifyViewsChanged()`     |
| `webview` `did-start-loading` /     |                                                     |
| `did-stop-loading`                  | Swap reload ↔ stop button visibility                |

A `normalize()` helper handles the "user types `example.com`" case:
if there's no scheme, prepend `https://`.

A `keydown` listener at the `<browser-view>` level forwards chord
keys (`C-x b`, `M-x`, etc.) through `onKey` so Godot's keymap still
fires while the browser has focus. Non-chord keystrokes fall
through to the webview naturally so the user can type into web
forms.

## Kind registration

In `app.js`, one new entry in `SINGLETON_VIEWS`:

```js
{ kind: 'browser', el: browserView, releasesBuffer: false },
```

Plus the singleton creation block (the same pattern as image /
audio / video / customize / …):

```js
const browserView = /** @type {*} */ (
  document.createElement('browser-view')
);
browserView.configure({
  ...(keymapReady ? { onKey: dispatchKey } : {}),
  defaultUrl: 'about:blank',
  partition: 'persist:browser-views',
});
editorPaneElement().append(browserView);
browserView.style.display = 'none';
```

`mountKindView` and `hideInactiveRendererViews` already iterate
`SINGLETON_VIEWS`; no other dispatch sites need touching.

## Lisp surface

A small host primitive and a user command:

```lisp
;; Host primitive (apps/desktop/src/app.js)
(defprim open-url! (url)
  "Open URL in a browser view. Creates the view, switches to it,
   returns the handle.")

;; User-facing command
(defcommand open-url "URL" ()
  "Open a URL in a browser pane."
  (let ((url (read-string "URL: ")))
    (open-url! url)))

;; Key binding
(global-set-key "C-c u" 'open-url)
```

The primitive does:

```js
const view = createView({
  kind: 'browser',
  name: url,  // overwritten by page-title-updated
  extras: { url },
});
views.push(view);
switchToViewIndex(views.length - 1);
return view;
```

`setBuffer(view)` on the singleton reads `view.url` and navigates
the webview. On `page-title-updated`, the view's `name` updates and
`notifyViewsChanged()` propagates to the modeline + tabline.

## Session restore

`session.js` already serialises view extras. The `url` field
round-trips for free; on restore, `setBuffer` navigates the webview
to the saved URL.

Page-internal back/forward history is lost — Electron doesn't
expose the webview's history stack as a serialisable snapshot.
That matches the semantics of quitting and re-opening a browser
tab in any normal browser, so this is fine.

## Effort

| Step                                                    | Time     |
|---------------------------------------------------------|----------|
| BrowserView class + inner DOM + CSS                     | 2-3 hrs  |
| Webview wiring (eight events, button handlers, URL norm) | 2-3 hrs  |
| `SINGLETON_VIEWS` entry, bootstrap, `open-url!` primitive | 1-2 hrs  |
| Lisp command + key binding                              | 30 min   |
| Smoke arm: open URL, title flows to modeline, back/forward enable | 2 hrs |
| Polish: error states, focus, hover-show-full-URL        | 2-3 hrs  |

**Realistic total: 1-2 focused days.**

## Edge cases worth a once-over

- **New-window handling.** `<webview>` fires `new-window` when a
  page calls `window.open` or follows a `target="_blank"` link.
  Electron blocks it by default. Options: spawn another browser
  view (call `open-url!` on the requested URL — feels native),
  open in the OS's external browser, or ignore. v1 default:
  spawn a new browser view in the focused pane.
- **DevTools.** A `C-c d` binding → `webview.openDevTools()` for
  the embedded page. Useful for any debugging the user might want
  on a site.
- **Permissions.** Camera, mic, notifications, geolocation. By
  default Electron prompts; for v1 "ask the user" is probably
  right. If you want to silently deny everything, set
  `permission-request-handler` on the webview's session.
- **Downloads.** Default Electron saves via OS dialog to the user's
  Downloads folder. Probably fine for v1; if you want Godot to
  open the downloaded file in the right kind, wire
  `webContents.session.on('will-download')`.
- **Page-level keyboard interception.** Pages like Google Docs and
  Notion capture keystrokes before the webview lets them bubble.
  Chord keys (`C-x b`) aren't usually intercepted, so Godot's
  keymap should still fire, but it's worth a manual test.
- **HTTPS errors.** Default Electron behaviour shows the cert
  error inside the webview. Probably fine.

## v2 thoughts (don't do these now)

The first thing you'll notice once you use it: **the singleton
model loses page state on view switch.** Click a link, switch to
a text pane, switch back — the browser reloads the original URL.
For "look something up briefly" that's fine; for "leave a long-form
page open while you work" it's annoying.

The fix is per-view-instance: each browser view has its own
`<webview>` element, parked in the warehouse when not active,
swapped into the focused pane when active. This is the
architectural shift `plans/VIEWS-AS-CUSTOM-ELEMENTS.md` describes
for non-text kinds. Browser is the obvious first kind to do it
for, because session loss is most visible there. But it's a
separate piece of work — v1 ships with the existing singleton
pattern.

Other potential v2 features:

- **Bookmark / history persistence.** A small JSON file in
  `userData/browser-history.json`. Lisp commands to query and
  open.
- **Find-in-page** (`C-s` over the webview's content). Webview
  has `findInPage()` and `stopFindInPage()` methods.
- **Reader mode.** Strip a page to its main content via
  Mozilla's Readability.js. Useful for reading articles inside
  Godot without ads.
- **Open-link-in-Godot.** A right-click menu on the webview to
  open the link's target as a Godot doc-view or text-view (if
  it's a docs page or a code file).
