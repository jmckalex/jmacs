# Browser ↔ Lisp bridge

Build on `plans/BROWSER-VIEW.md`: give pages loaded in a
`<browser-view>` the ability to call into Godot's Lisp interpreter,
define commands in it, and respond to events from it. Two-way
bridge between the page's JavaScript and the editor's runtime.

Prerequisite: `<browser-view>` already shipping (the basic plan).

Effort: **2-3 focused days** for the bridge core, plus **half a day
to a day** for the `<script>` tag extension. Cumulative from the
basic browser view: roughly **a week-plus-a-bit** end to end.

## What it enables

A page with the bridge active can do four things:

```js
// Evaluate any Lisp form. Returns the result as a JS value.
const sum = await window.godot.eval('(+ 1 2)');               // 3

// Call a named function with args. Cleaner than building a string.
await window.godot.call('open-file-path!', '/path/to/file');

// Define top-level forms. Scoped to this browser view's lifetime
// by default — bindings unbind when the view is killed.
await window.godot.define(`
  (defcommand show-time () "Show wall-clock time."
    (message (format-time (current-time))))
`);

// Subscribe to events Godot emits — view switch, buffer change, etc.
window.godot.on('view-changed', (view) => { … });
```

Real use cases:

- **Live tutorials and interactive docs.** A `file://` page rendered
  by the browser view that has "Try it" buttons next to code
  samples — clicking runs the example *in the user's actual editor*.
  The page is the textbook; Godot is the runtime.
- **Notebook-style workflows.** A page renders a Jupyter-shaped
  notebook, each cell evaluates through `window.godot.eval`, results
  render inline. The notebook persists as `.html`; the runtime is
  the editor itself.
- **Plugins delivered as web pages.** A package author publishes an
  HTML page that, when explicitly trusted, defines new commands.
  One-click plugin install via a page visit.
- **Live dashboards.** A page that polls Godot for stats (memory,
  buffer count, modeline state) and renders them — handy when
  debugging the editor itself.

## Security

This is the conversation the basic browser view dodges, and it's
the actual design work. Lisp can read files, spawn shells, modify
editor state. A drive-by `(write-file "/etc/passwd" "")` from a
random ad network is catastrophic.

Three orthogonal mitigations:

### 1. Opt-in per view

`(open-url URL)` is the safe default — no bridge.
`(open-url URL :lisp #t)` is the explicit opt-in. The view's
toolbar shows a clear `λ` indicator when the bridge is live;
clicking it toggles. Users have to be intentional, every time.

### 2. Origin allowlist

Even with `:lisp #t`, the bridge is only injected into pages whose
origin matches the user's allowlist. Defaults:

```
file://                            ← local HTML files
http://localhost:*                 ← local dev servers
godot://                           ← Godot's own custom protocol
```

Adding a remote origin (`https://docs.godot-editor.org`) is a Lisp
command (`M-x add-trusted-lisp-origin`) and requires
re-confirmation each time it's used in a new session. The defcustom
`*lisp-bridge-origins*` is the source of truth.

### 3. Scoped definitions

`window.godot.define` writes into a per-view environment that
inherits from the global namespace but doesn't pollute it. When
the view is killed, the definitions go away. The user who closes a
tab gets their editor back to its pre-page state with no residue.
A `window.godot.define-globally` could exist for the rare case
where a definition should persist — but it'd require an explicit
"Yes, persist this command" prompt every time.

Combined: even a trusted page can only do harm while it's open, and
only when the user has opted into both `:lisp #t` and the page's
origin. That's roughly the model browser extensions use, and it's
about as much protection as you can give the user without making
the feature too annoying to bother with.

## Architecture: the IPC plumbing

Electron's `<webview>` lives in a separate renderer process from
Godot's main renderer. The bridge is a two-step path.

### Webview preload script

A small JS file Godot ships, loaded into every browser view's
renderer via the webview's `preload` attribute. It uses
`contextBridge.exposeInMainWorld('godot', ...)` to put the API on
the page's `window`. Each method routes through
`ipcRenderer.sendToHost(...)` — which sends a message to *the host
renderer* (where Godot's interpreter lives), not the main process.

### Host renderer handler

Godot's main renderer listens for `webview.on('ipc-message', ...)`.
The message includes a request ID, an op (`eval` / `call` /
`define`), and a payload. The handler:

1. Checks origin against the allowlist.
2. Looks up the per-view Lisp environment.
3. Runs `interpreter.call` or `interpreter.eval` in that environment.
4. Serialises the result (Lisp number → JS number, Lisp string → JS
   string, Lisp list → JS array, Lisp procedure → opaque handle).
5. Sends back via `webview.send('godot:result', { requestId, value })`.

The preload script's API resolves the request's promise when the
result lands.

For events flowing the other way (Godot → page), the host renderer
hooks Godot's event system and calls
`webview.send('godot:event:<name>', payload)`. The preload script
dispatches to subscribed callbacks.

## Synchronous Lisp, async JS

Godot's interpreter is sync (one of the architecture decisions in
`CLAUDE.md` and the prior handover). The bridge is async because
cross-process IPC is async. The mismatch is fine in practice —
`window.godot.eval(...)` returns a Promise even though the Lisp
side ran synchronously and was done before the IPC reply came
back. The JS world gets normal `await`-able semantics; the Lisp
world gets the synchronous evaluation it expects. No interpreter
changes needed.

The deadlock case to think about: a Lisp evaluation that triggers a
UI operation that needs the webview to respond. Don't do that —
keep `eval` calls Godot-side-only, no cross-page UI calls. If we
ever need that, a separate async event channel handles it.

## `<script type="text/godot-lisp">` extension

Once the bridge is in place, recognising `<script>` tags is a thin
scanner on top — and conceptually it unifies "definitions delivered
programmatically" with "definitions declared in the page" into one
path: *Lisp in this page runs in Godot's interpreter, period*.

### What it looks like in a page

```html
<!DOCTYPE html>
<html>
<head>
  <title>show-time tutorial</title>
  <script type="text/godot-lisp">
    (defcommand show-time ()
      "Display the current time."
      (message (format-time (current-time))))
  </script>
</head>
<body>
  <p>Loaded <code>show-time</code>. Try <kbd>M-x show-time</kbd>.</p>
  <!-- Or pull from a separate file -->
  <script type="text/godot-lisp" src="extra-commands.lisp"></script>
</body>
</html>
```

The browser already does the right thing with custom `<script>`
types — anything it doesn't recognise as JS / module / importmap
gets silently ignored by Chromium. So we can pick a type string and
own it without collision.

### Type string

`text/godot-lisp` for ordinary blocks; `application/godot-lisp`
accepted as a synonym. The `x-` prefix convention is the older
spelling; modern HTML5 is fine with bare custom types. Avoid
`text/lisp` — too generic, future-collision-prone.

### Scanner

In the same preload script that exposes `window.godot`, add a
scanner that runs after `DOMContentLoaded` plus a `MutationObserver`
so dynamically-injected script tags (SPA navigation, lazy-load)
also pick up:

```js
const LISP_TYPES = new Set(['text/godot-lisp', 'application/godot-lisp']);

function executeLispScript(script) {
  if (script.dataset.godotLispExecuted) return;
  script.dataset.godotLispExecuted = '1';
  const run = async () => {
    let source = script.textContent;
    if (script.src) {
      const res = await fetch(script.src);
      source = await res.text();
    }
    try {
      await window.godot.eval(source);
    } catch (err) {
      console.error('Godot Lisp error in <script>:', err);
    }
  };
  run();
}

function scanScripts() {
  for (const script of document.querySelectorAll('script')) {
    if (LISP_TYPES.has(script.type)) executeLispScript(script);
  }
}

document.addEventListener('DOMContentLoaded', scanScripts);

new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.tagName === 'SCRIPT' && LISP_TYPES.has(node.type)) {
        executeLispScript(node);
      }
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
```

Maybe 40 lines including the `src=` fetch path. The execution
order matches document order naturally — `querySelectorAll` returns
elements in tree order, and the MutationObserver fires in insertion
order.

### Semantics

Match HTML's script-tag conventions where they're useful, diverge
where they aren't:

| HTML script feature                          | What we do |
|----------------------------------------------|------------|
| Inline `<script>` body as source             | ✅ Yes — `script.textContent` |
| `src=` attribute fetches and executes        | ✅ Yes — fetch the URL, body is the source |
| Document-order execution                     | ✅ Yes — natural from `querySelectorAll` |
| `defer` (delay until parsing complete)       | ✅ We already do this via `DOMContentLoaded` |
| `async` (no ordering guarantee)              | ❌ Skip for v1 — Lisp blocks are usually small and order-sensitive |
| `type="module"` (ES module semantics)        | ❌ N/A — Lisp has its own module system |
| Errors halt subsequent execution             | ❌ Differ — `try/catch` per block, errors logged but next block runs |

### Security note: auto-execution

The bridge already gates on (a) `:lisp #t` on the view and (b) the
page's origin on the allowlist. Inline `<script type="text/godot-lisp">`
auto-executes the moment those two are true, with no further
opt-in. That's a subtle escalation worth being explicit about:

- A page with the bridge available **but** doesn't call
  `window.godot.eval` is benign — the user opted into capability but
  the page chose not to use it.
- A page with `<script type="text/godot-lisp">` blocks **uses** the
  capability the moment it loads — there's no in-page decision step.

The toolbar `λ` indicator should change appearance when the current
page contains executed Godot-Lisp blocks, so users see "this page
is running Lisp in my editor right now" at a glance.

For `src=` URLs, apply the same origin allowlist as for the page
itself. A trusted page can `<script src="https://example.com/lib.lisp">`
only if `example.com` is also on the allowlist — otherwise the load
is denied with a console error. This stops a trusted local page
from pulling untrusted remote code in via a script tag.

### Output and side effects

Same path as `window.godot.eval`:

- `(message ...)`, `(print ...)`, `(display ...)` flow to Godot's
  minibuffer / log, exactly like REPL output.
- `(defcommand ...)` registers in the *per-view environment* —
  when the browser view is killed, the command unbinds. Same scoping
  as the bridge's `define`.
- Pages that want to capture output subscribe via
  `window.godot.on('output', cb)`.

The per-view environment is what makes the script-tag pattern safe
enough to be casually useful: closing the tab is a reset button. A
page that defines twenty experimental commands leaves no trace once
the user closes it.

## Effort

On top of the basic `<browser-view>`:

### Bridge core

| Step                                                          | Time     |
|---------------------------------------------------------------|----------|
| Preload script + IPC plumbing both directions                 | 4-6 hrs  |
| Host renderer eval / call / define dispatch + serialisation   | 4-6 hrs  |
| Per-view Lisp environment (inherits global, killed with view) | 3-5 hrs* |
| Origin allowlist + `add-trusted-lisp-origin` flow             | 2-3 hrs  |
| Toolbar `λ` indicator + on/off toggle UI                      | 2 hrs    |
| Smoke arm: open a local page that eval's a primitive          | 2 hrs    |
| Polish: error handling for failed eval, define typos, origin denial | 3-4 hrs |

*\*The per-view environment is the wildcard. If Godot's interpreter
supports a "child environment that delegates lookups to the parent
and isolates definitions" out of the box, it's a couple of hours.
If we'd need to add that primitive, it's more like a day on the
interpreter side.*

### Script-tag extension (on top of bridge)

| Step                                                          | Time     |
|---------------------------------------------------------------|----------|
| Script-tag scanner + MutationObserver                         | 2-3 hrs  |
| `src=` attribute support + origin check                       | 1-2 hrs  |
| Document-order execution + error isolation                    | 1 hr     |
| Toolbar indicator state changes when scripts run              | 1 hr     |
| Smoke arm: page with inline + `src=` scripts                  | 2 hrs    |
| Polish: per-script error reporting (line numbers if possible) | 2 hrs    |

**Realistic totals: ~2-3 days for the bridge, ~half a day to a day
for the script-tag layer.** Cumulative from the basic browser view:
roughly **a week-plus-a-bit** end to end.

## Open questions worth settling early

- **What types cross the bridge?** Numbers / strings / booleans /
  arrays / plain objects round-trip cleanly. Lisp lists serialise as
  JS arrays. Lisp keywords as strings with a sentinel prefix?
  Procedures as opaque handles (so the page can invoke them via
  `window.godot.invoke(handle, args)`). Closures from page → Godot
  probably as similar opaque handles. There's a real design call
  about how rich the bridge gets.
- **Event taxonomy.** What events does Godot emit that pages would
  care about? Buffer change, view switch, modeline update, theme
  change. Probably worth defining the surface explicitly
  (`*lisp-bridge-events*` defcustom) rather than exposing every
  internal event.
- **Default-on for local files?** Some users would find `file://`
  automatically bridge-enabled convenient (local HTML notebooks
  just work); others would find it surprising. The conservative
  default is "always explicit, even for `file://`" but a
  `*lisp-bridge-default-for-local*` defcustom could flip it.
- **Define vs `defcommand` specifically.** `define` is general;
  `defcommand` registers a user-facing command. The page might want
  to do either. The bridge passes source verbatim, so the page's
  choice is respected — but the toolbar indicator should arguably
  differentiate "this page can run code" from "this page can install
  commands that will be in M-x forever."

## Patterns this enables

- **A single-file Godot tutorial.** Ship `tutorial.html` as a doc.
  The user opens it in Godot's browser view, the page has
  `<script type="text/godot-lisp">` blocks that define example
  commands, the prose explains them with "try `M-x example-command`"
  prompts.
- **A package as a webpage.** Instead of a `.tar.gz` of `.lisp`
  files, a package is a URL. Visit it, the script tags register
  commands. Combined with the per-view scoping, "uninstall" is
  "close the tab." Persistent installation is a separate explicit
  step.
- **A live cheatsheet.** A page that, on load, queries Godot's
  keymap via `window.godot.eval` and renders a cheatsheet matching
  the user's actual bindings — not the docs' default ones.
- **Self-modifying documentation.** A doc page whose interactive
  elements run Lisp to produce their own demo content. The page is
  its own example.

## v2 thoughts

- **Streaming output.** Long-running computations or REPL-style
  outputs need a streaming channel. `window.godot.session()` returns
  a session object with `eval(form)` and `on('output', cb)`. The
  Lisp side's `display` / `write` calls stream back as `output`
  events. Necessary for any real REPL UI.
- **Page-rendered widgets in editor panes.** Inverse of the bridge:
  a Lisp form embeds a small HTML widget (a chart, a date picker, a
  form) into a text buffer. Bridge in reverse — the Lisp form's
  output renders into the page DOM. This is the spec for several
  Emacs packages and is genuinely powerful; also genuinely big.
- **Source location in errors.** When a Lisp form in `<script>`
  errors, point the user at the file:line — for inline scripts, the
  in-page line; for `src=` scripts, the URL:line. Requires the
  interpreter to thread source locations through; not always
  trivial.
- **Edit-in-place.** A command `M-x edit-page-lisp` that opens the
  current page's `<script>` blocks as a virtual text buffer in
  Godot's editor. On save, re-inject and re-execute. Like having
  the page's source in a normal editor pane.
- **CSP integration.** Respect `Content-Security-Policy:
  godot-lisp 'none'` if the page sets it. Mostly for completeness.
- **Define-only variant.** `<script type="text/godot-lisp-define">`
  refuses to run anything but top-level definitions — no side
  effects on load. Useful for "this page only adds commands; it
  doesn't do anything to my editor right now." Self-documenting to
  a reader of the HTML.
- **Permission persistence.** Right now each trusted-origin addition
  is per-session. A `*lisp-bridge-origins-persisted*` defcustom
  could let users mark some origins as permanently trusted. Worth
  it once people use the bridge for real workflows.
- **Cross-view bridges.** Bridge between two browser views: page A
  defines a command that page B can call. Probably YAGNI for a while.
