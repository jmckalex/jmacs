# Renderer core (paint pipeline, chrome, client apply path) — audit

**Agent:** 11 of 13 · **Date:** 2026-07-01 · **Branch:** main @ efe0fa6d · Suite green (3290)
**Mode:** read-only (this file is the only write)

## Scope

Model B: the spine owns the interpreter and resolves every key; the renderer is a
thin client. Keys go up as strings (`keyEventToString`); state comes down as
SNAPSHOT/DELTA/CURSOR/VIEW/OVERLAYS/PANE_TREE/CLIENT_DIRECTIVE and is applied by
`server-view-client.js` → `app.js` chrome hooks. The renderer's local interpreter
and its v0 keymap are INERT.

| File | Claimed as | Coverage |
|---|---|---|
| `packages/renderer/src/view.js` (2131) | Core paint: caret/selection/folds/widgets/decorations, replaced-range layer, IME sink | full read |
| `packages/renderer/src/highlight.js` (932) | token→face mapping | struct + full DOM-sink sweep (no sinks) |
| `packages/renderer/src/keymap.js` | `keyEventToString` + IME | full read |
| `packages/renderer/src/tabline.js` | tab strip widget | full read |
| `packages/renderer/src/tabline-view.js` | `<tabline-view>` custom element | full read |
| `packages/renderer/src/text-view.js` | `<text-view>` wrapper | full read |
| `packages/renderer/src/minibuffer.js` | minibuffer + echo/status area | full read |
| `packages/renderer/src/completions-panel.js` | completions UI (file paths) | full read |
| `packages/renderer/src/utility-dock.js` | dock chrome + modal key capture | full read |
| `packages/renderer/src/doc-panel.js` | doc panel (utility dock) | full read |
| `packages/renderer/src/doc-view.js` | doc rendering (setBuffer innerHTML) | targeted |
| `packages/renderer/src/hover-doc.js` | hover tooltip | full read |
| `packages/renderer/src/math-tooltip.js` | replaced-range / math tooltip | full read |
| `apps/desktop/src/server-view-client.js` (976) | client apply path, every MSG case | full read |
| `apps/desktop/mwb/client-buffer.js` | the mirror (view.js's read surface) | full read |
| `apps/desktop/src/app.js` (selected) | chrome hooks: `setModeline`, `setEcho`, `applyDirective`, `displayDocPanel`, global key router, `focusPaneFromEvent`, markdown-preview iframe | targeted reads |
| `packages/renderer/src/markdown.js` | `renderMarkdown` (marked, no sanitiser) — referenced | targeted |
| `packages/renderer/src/markdown-preview.js`, `reftex-cite-panel.js` | cross-cutting sinks surfaced in sweep | targeted, scope-caveated |

Deliberately excluded (agent 12): pdf/minimap/audio/jukebox/directory/browser/notebook/shell/image/video/svg/games and `jmarkdown-scan.js`.

---

## Executive summary

The paint pipeline is **solid and defensively engineered**. `view.js`'s render is
rAF-batched, wrapped in a per-pass try/catch with a *degraded* (plain-text,
no-highlight, no-widget) retry, and line-virtualised (only the visible window +
overscan is in the DOM). The security posture of the **core** paint path is
good: every token/line/selection/decoration goes to the DOM via `textContent`
and `className`, never `innerHTML`. The tabline DOM-detachment hazard is handled
correctly — `focusPaneFromEvent` is registered **capture-phase** on both
mousedown and click (`app.js:751-752`). The IME P0 fix (B1) holds in the main
editor (`view.js:1511` gates on `composing || isComposing || keyCode===229`).

No **CONFIRMED P0** was found in the core files. The worst issues are:

- **RVCORE-01 (P2):** `server-view-client.js` `handleMessage` has **no
  per-message try/catch**; a throwing message handler or injected chrome hook
  aborts that message mid-flight and can desync client state. The prompt's
  "one bad message must not kill the stream" bar is only met by the MessagePort
  runtime not tearing down `onmessage` on a throw — not by design in this module.
- **RVCORE-02 (P2):** every `CURSOR`/`VIEW`/`OVERLAYS`/`CURSORS`/`RESYNC` message
  drives a **synchronous** `view.setView()` → `render()`, bypassing the rAF
  coalescing the edit path uses. A burst of cursor/overlay pushes forces one full
  visible-window DOM rebuild per message.
- **RVCORE-11 (P2):** the **minibuffer** and **utility-dock capture** keydown
  handlers do **not** gate on `isComposing`/keyCode 229 — an IME commit Enter/Escape
  in a minibuffer prompt is read as submit/cancel (CJK users).
- **RVCORE-03 (P2/P3):** the known **caret-drift near math tooltips** is precisely
  the `frozenLeft` capture in `math-tooltip.js` freezing the horizontal at first
  placement, *before* MathJax settles the measured widths of other inline widgets
  on the caret's line.

Two **cross-cutting security** items surfaced in the DOM-sink sweep and are
flagged with scope caveats (RVCORE-04 markdown-preview iframe has no `sandbox`;
RVCORE-05 reftex `.bib` innerHTML relies on citation.js escaping). Neither is a
confirmed core-file P0.

---

## Findings

### RVCORE-01: `handleMessage` has no per-message error isolation

- **Severity:** P2
- **Dimension:** Architecture / robustness (Security-adjacent)
- **Location:** `apps/desktop/src/server-view-client.js:587` `handleMessage`; wired at `:646` `port.onmessage = (e) => handleMessage(e.data)`
- **Evidence:** `handleMessage` is a bare `switch (msg.type)` with no surrounding
  `try/catch`. Only the `RUN_CLIENT_COMMAND` case guards its own call (`:608`).
  Several handlers do real, throwable work: `onSnapshot` builds a live editor via
  `mountView` (`:474`); `onView` → `renderChrome` → `openMinibufferDom` /
  `setModelineDom` call **injected chrome hooks** that, in `app.js`, run the big
  `applyDirective` switch, `displayDocPanel`, `toggleMarkdownPreview`, etc. — most
  guard their own `JSON.parse` but not the whole handler.
- **Failure scenario:** A single malformed payload or a throw inside one chrome
  hook (e.g. a directive handler that hits an unexpected DOM state) propagates out
  of `handleMessage` and out of `onmessage`. The MessagePort runtime does not
  close the port on an `onmessage` throw, so *the stream survives* — but the
  offending message's remaining work is skipped, leaving state half-applied
  (e.g. modeline updated, minibuffer transition not run), and the desync is
  silent (no `reportRenderError`-style funnel here).
- **Fix direction:** Wrap the `switch` body in `try/catch`, logging via the
  injected `log`. Cheap and matches the defensive posture everywhere else in this
  module (`destroy`, `reportViewport`, `connect` all use `try/catch`).
- **Confidence:** CONFIRMED (absence of guard). Throw-reachability PLAUSIBLE
  (most hooks are individually defensive today).

### RVCORE-02: cursor/view/overlay messages force a synchronous full render (no rAF coalescing)

- **Severity:** P2
- **Dimension:** Correctness / performance
- **Location:** `server-view-client.js` `onCursor:511`, `onCursors:524`, `onOverlays:531`, `onResync:542`, `onView:565/569` all call `view.setView({ buffer: mirror })`; `view.js` `setView:2100` ends in `render()` (synchronous), not `schedule()`.
- **Evidence:** The edit path is rAF-batched (`schedule()` at `view.js:1473`,
  `scheduleFollowingCursor` on `onChange`). But the *server-push* reconcile path
  calls `render()` directly, once per message. `render()` runs `renderLines`
  (rebuilds the visible-window DOM with `linesEl.replaceChildren(...)` and
  `gutter.replaceChildren(...)`), `renderSelection`, `renderBrackets`,
  `renderCursor`, sticky headers, decorations.
- **Failure scenario:** During rapid server pushes — multi-cursor motion streaming
  `CURSORS`, overlays streaming during isearch/occur, or a command that emits many
  `VIEW`s — the client does a full synchronous visible-window rebuild per message
  instead of collapsing to one frame. Highlight is cached when text is unchanged
  (so no re-tokenise), and virtualisation bounds each render to the viewport, so
  this is *bounded* (O(messages × viewportLines)), not unbounded — but it defeats
  the batching the edit path relies on and can stutter under a flood.
- **Fix direction:** Have the reconcile path call a `schedule()`-style entry
  (expose one from the editor, or set a "cursor dirty" flag and `schedule`).
  `setView` re-render on an *unchanged* buffer only needs a scheduled repaint.
- **Confidence:** CONFIRMED (traced: `setView` → `render()`).

### RVCORE-11: minibuffer / dock keydown handlers do not gate IME composition

- **Severity:** P2
- **Dimension:** Correctness (IME)
- **Location:** `packages/renderer/src/minibuffer.js:115` (`input.addEventListener('keydown', …)`); `packages/renderer/src/utility-dock.js:191` (`captureHandler`).
- **Evidence:** The main editor keydown correctly bails during composition
  (`view.js:1511`: `if (composing || event.isComposing || event.keyCode === 229) return;`).
  The minibuffer's own `<input>` keydown handler has **no such guard**: it treats
  `event.key === 'Enter'` as submit (`:133`) and `'Escape'` as cancel (`:139`),
  and calls `handlers.onKey(keyEventToString(event), …)`. The utility-dock modal
  capture handler (`:191`) likewise checks only `BARE_MODIFIERS`, not `isComposing`.
- **Failure scenario:** A CJK/IME user composing in a minibuffer prompt (find-file,
  switch-buffer, M-x, isearch) presses **Enter to confirm an IME candidate** —
  `isComposing` is true — and the handler submits the prompt with the
  half-composed value; **Escape to dismiss the candidate list** cancels the prompt.
  This is the exact failure class the editor's own path was hardened against (B1),
  not carried over to the chrome inputs.
- **Fix direction:** Add `if (event.isComposing || event.keyCode === 229) return;`
  at the top of both handlers.
- **Confidence:** CONFIRMED (guard absent). User-visible impact PLAUSIBLE (depends
  on IME/platform Enter-commit behaviour, which Chromium exhibits).

### RVCORE-03: caret-drift near math tooltips — `frozenLeft` captured before MathJax width-settle

- **Severity:** P2 (P3 if you consider it purely cosmetic)
- **Dimension:** Correctness (caret/selection math under widgets)
- **Location:** `packages/renderer/src/math-tooltip.js:119` `frozenLeft`, `:156-174` `position()`; interacts with `view.js` `columnToXPx:612`, `renderCursor:1284-1305`, and the block re-measure loop `view.js:1123-1134`.
- **Evidence:** On a line with inline math widgets, the caret x is
  `columnToXPx(line, column)` which subtracts, for each widget left of the caret,
  `sourceW − realW` where `realW = element.getBoundingClientRect().width`
  (`view.js:617-624`). That measured width is only stable *after* MathJax finishes
  typesetting the widget. The math tooltip anchors to the caret rect and **freezes**
  its horizontal on the first placement for a construct (`math-tooltip.js:166-169`:
  `if (frozenLeft === null) frozenLeft = …caretCenterX…`). If that first placement
  fires before the neighbouring widgets have settled their widths, the frozen x is
  captured against a pre-settle caret position and **stays offset for the whole
  editing session of that construct**. Separately, the block-row re-measure loop
  (`view.js:1124-1134`) calls `schedule()` again after measuring, so the caret can
  shift a few px between the reserve frame and the settle frame.
- **Failure scenario:** Enter a `$…$` that sits to the right of one or more already
  inline-typeset formulae on the same line; the tooltip opens a few glyphs off and
  never re-centres while you type in that construct. The `view.js:1289-1305` comment
  documents the sibling issue (assistive-MathML text tripping `hasWide` +
  `measureCaretXPxIn`) — that path is *guarded off* for widget lines, so the
  residual is the width-settle timing above, not the MathML miscount.
- **Fix direction:** Recompute `frozenLeft` once when MathJax reports the widget
  layer settled (the existing `refresh()`/re-measure already fires an extra frame —
  re-freeze on that frame), or anchor the tooltip to the caret element's live rect
  rather than freezing on first sight.
- **Confidence:** CONFIRMED (mechanism traced end to end). Magnitude PLAUSIBLE
  (depends on typeset timing; small px offset).

### RVCORE-04: markdown-preview iframe has no `sandbox` (cross-cutting; scope caveat)

- **Severity:** P2
- **Dimension:** Security (defence-in-depth)
- **Location:** `apps/desktop/src/app.js:7541` `document.createElement('iframe')`; `:7858` `markdownPreviewFrame.src = http://localhost:${result.port}/`.
- **Evidence:** The live JMarkdown preview points an iframe at the local
  `jmarkdown watch` HTTP server with **no `sandbox` attribute**. The page it loads
  is the user's markdown file rendered to HTML by the watch server, i.e. **file
  content** becomes active DOM. A hostile `.md`/`.jmd` in a cloned repo can carry
  `<script>` / `<img onerror>`.
- **Failure scenario:** Script in the previewed file executes — but in the
  **`http://localhost:PORT` origin**, which is cross-origin to `app://`. Same-origin
  policy denies it the Electron preload bridge (`window.host`) and the app's DOM, so
  the blast radius is the localhost origin only. Preview is opt-in (C-c v) on the
  user's own file. That is why this is **not P0**.
- **Fix direction:** Add `sandbox="allow-scripts"` (MathJax needs scripts) and
  deliberately **omit** `allow-same-origin`, so even the localhost origin can't be
  scripted into anything privileged. Confirm MathJax still runs under that sandbox.
- **Confidence:** CONFIRMED (no sandbox). Origin isolation mitigates to non-P0.

### RVCORE-05: reftex `.bib` reference innerHTML relies on citation.js escaping (cross-cutting; scope caveat)

- **Severity:** P2
- **Dimension:** Security
- **Location:** `packages/renderer/src/reftex-cite-panel.js:266` `setReferenceHtml` → `el.innerHTML = html.replace(/<script/gi, '&lt;script')`.
- **Evidence:** A `.bib` file in a cloned repo is attacker-controlled. The panel
  formats entries via citation.js and assigns the result with `innerHTML`, stripping
  only `<script`. The code comment asserts citation.js HTML-escapes every field; if
  that holds, the only emitted tags are citation.js's own. The `<script`-only strip
  would **not** stop `<img src=x onerror=…>` were a field ever unescaped, and this
  runs in the **app:// origin** (full `window.host` reach).
- **Failure scenario:** A malicious `.bib` title/author field that citation.js
  fails to escape → arbitrary HTML in the app:// document → XSS with host-bridge
  access. Reachability depends entirely on citation.js's escaping, which I did not
  audit here (its file is outside my core set).
- **Fix direction:** Don't rely on a dependency's escaping for an app://-origin
  innerHTML sink — build the reference DOM with `textContent` per field, or run it
  through a real sanitiser. At minimum widen the defensive filter to strip event
  handlers / `javascript:` too.
- **Confidence:** PLAUSIBLE (upstream escaping unverified; sink + attacker-controlled
  source CONFIRMED). May belong to another agent's territory.

### RVCORE-06: hover-doc tooltip `innerHTML` of server-rendered docstring

- **Severity:** P3
- **Dimension:** Security
- **Location:** `packages/renderer/src/hover-doc.js:111` `preview.innerHTML = summary.preview`.
- **Evidence:** `summary.preview` is a short markdown docstring rendered via
  `renderMarkdown` (`app.js:7383`, marked, **no sanitiser**) and shipped from the
  spine on `DOC_HOVER_RESULT`. Rendered with `innerHTML`.
- **Failure scenario:** Not reachable from mere file content — opening a hostile file
  does not define server-side documented symbols, so the resolved docstring is
  always a trusted (stdlib / user's own `custom.lisp`) one. But any docstring
  containing raw HTML renders unsanitised in the app:// origin.
- **Fix direction:** Either treat docstrings as trusted (document it) or sanitise
  the marked output before this sink. Systemic: see RVCORE-07.
- **Confidence:** PLAUSIBLE-low (trusted content today).

### RVCORE-07: doc-view / displayDocPanel render marked output without a sanitiser

- **Severity:** P3
- **Dimension:** Security
- **Location:** `packages/renderer/src/doc-view.js:465` `tmp.innerHTML = buffer.html`; `app.js:2347-2350` `displayDocPanel` builds the HTML (heading via `escapeHtml`, body via `renderMarkdownHtml`); `packages/renderer/src/markdown.js:74` marked configured with **no** `sanitize`/DOMPurify.
- **Evidence:** `markdown.js` explicitly does not sanitise (marked's `sanitize`
  option is deprecated and not replaced with a sanitiser). `renderMarkdown` protects
  LaTeX math and escapes *math bodies* (`escapeMathHtml`), but ordinary markdown
  passes through, so raw HTML in the source (`<script>`, `<img onerror>`) survives to
  the `innerHTML` sink in `doc-view.setBuffer`. `displayDocPanel` escapes the
  **heading** (`escapeHtml`, `app.js:2348-2349`) but the **body** is raw marked HTML.
- **Failure scenario:** The show-help / apropos bodies are command docstrings and
  the doc-view pages are the app's own built docs — trusted today. The exposure is
  the systemic "marked = no sanitizer": any path that ever routes attacker-controlled
  markdown to these sinks is an XSS. (Sticky notes render via the same
  `renderNoteHtml`; those bodies are user-authored, not repo file content.)
- **Fix direction:** Add a sanitiser pass (DOMPurify-equivalent, or a strict
  allow-list) to `renderMarkdown` output before any `innerHTML` sink, or forbid raw
  HTML in marked (`marked` can be configured to escape it).
- **Confidence:** PLAUSIBLE-low (all current sources trusted); CONFIRMED that no
  sanitiser exists on the path.

### RVCORE-08: `pending` map entries leak on a never-echoed key

- **Severity:** P3
- **Dimension:** Architecture / lifecycle
- **Location:** `server-view-client.js:243` `pending`, `:269-273` `sendKey` (adds), reconciled in `onDelta:500` / `onCursor:508` / `onView:561` (deletes).
- **Evidence:** Each `sendKey` registers `pending.set(id, {predicted:false})`. The
  entry is removed when the echoed DELTA/CURSOR/VIEW carries the matching `echoId`.
  A key the server drops (error, or a key that produces neither a delta nor a
  cursor echo) never clears its entry.
- **Failure scenario:** Over a very long session a trickle of unechoed keys grows
  `pending` unboundedly; `[...pending.values()].some(p => p.predicted)` (the
  in-flight guard, `:521`,`:561`) stays cheap since none are predicted, so the only
  cost is memory. `destroy()` drops the map. Bounded in practice.
- **Fix direction:** Age out `pending` entries (a max size or a TTL), or have the
  server ack every intent id.
- **Confidence:** CONFIRMED (no eviction path besides echo/destroy). Low impact.

### RVCORE-09: stale `getReplacedRanges()` for one frame after a shrinking RESYNC

- **Severity:** P3
- **Dimension:** Correctness (VIEW payload references stale state)
- **Location:** `view.js:725` `getReplacedRanges()` read each render; `computeMathLayout` fed `lineStarts`/`lineLengths` from *current* text but `ranges` from the host's last computation.
- **Evidence:** Fold state is robust to this — `refreshFoldIndex` re-derives the
  fold cache from the current mirror text every render (`view.js:292-311`), folded
  entries past EOF are pruned (`:698-700`), pills clamp `endLine` to `lineCount-1`
  (`:1070`), and `offsetPastFold` bounds-checks (`:1824-1831`). But the math
  *replaced-ranges* come from the math-preview host's own async recompute; between a
  RESYNC that shrinks the buffer and the host's recompute, a range's `start`/`end`
  can exceed EOF for one frame.
- **Failure scenario:** One-frame mis-layout of a math widget (or a throw inside
  `computeMathLayout`/`spliceInlineWidgets`). The render is wrapped in try/catch with
  a degraded plain-text retry (`view.js:1409-1421`), so a throw degrades that frame
  rather than freezing; a non-throwing out-of-range offset just paints slightly
  wrong for one frame and self-corrects.
- **Fix direction:** Clamp range offsets to `activeBuffer.length` inside
  `computeMathLayout`, or have the host invalidate replaced-ranges synchronously on
  a RESYNC.
- **Confidence:** PLAUSIBLE (narrow one-frame window; degrade path covers the throw).

### RVCORE-10: dead pre-Model-B keymap / local-edit code

- **Severity:** P3
- **Dimension:** Architecture (dead path)
- **Location:** `packages/renderer/src/keymap.js:27-79` (`MOVEMENT`, `MOVEMENT_WITH_MOD`, `resolveKey`); `packages/renderer/src/commands.js` (`handleKeyEvent`, `buffer.insert`/`deleteBackward` local edits); `view.js:1512-1514` fallback `handleKeyEvent(activeBuffer, event)`.
- **Evidence:** `keymap.js`'s `resolveKey` and the `MOVEMENT*` tables are the "v0
  keymap baked into the renderer" (its own docstring says the real bindings live in
  Lisp). Under Model B the server owns dispatch; `dispatchKey` always sends a KEY
  intent and returns true (`server-view-client.js:334-341`), and `app.js` always
  passes `onKey`, so `view.js`'s `handleKeyEvent` fallback (`:1514`) is unreachable in
  the app. Only `keyEventToString` / `altComposedInsert` from this module are live.
- **Failure scenario:** None functional — it's inert. It's a maintenance/readability
  smell and a trap (a future reader might think the renderer resolves keys).
- **Fix direction:** Delete `resolveKey` + `MOVEMENT*` and the `commands.js`
  local-edit fallback, or move them behind a clearly-marked "renderer-standalone /
  test-only" boundary. `keyEventToString` stays.
- **Confidence:** CONFIRMED.

---

## DOM sink inventory (security deliverable)

Every string→DOM sink in the claimed files. "Escaped how" is the actual mechanism;
"Verdict" weighs the source's trust against the sink.

| # | Sink | File:line | Source of string | Escaped how | Verdict |
|---|---|---|---|---|---|
| 1 | line/token text | `view.js:507,521,524` `renderRuns` | buffer text + tree-sitter face | `lineEl.textContent` / `span.textContent` + `className='tok-'+face` | **SAFE** — text never parsed as HTML; `className` setter can't inject markup/attrs |
| 2 | fold ellipsis / close preview / vellipsis | `view.js:960-1005` | buffer text | `textContent`, `renderRuns` (textContent) | **SAFE** |
| 3 | line numbers, chevron icon | `view.js:1021,1036` | line index, static FA class | `textContent`, `icon.className` | **SAFE** |
| 4 | selection / decoration / bracket boxes | `view.js:1147,1193,1245` | geometry only | style props, `className` | **SAFE** |
| 5 | sticky-header rows | `view.js:1724,1736` | buffer text | `textContent` / `renderRuns` | **SAFE** |
| 6 | modeline name / position | `app.js:3573-3574` | server modeline string (bakes file name) | `nameEl.textContent` / `positionEl.textContent` | **SAFE** |
| 7 | document.title | `app.js:3575` | server modeline | template into `document.title` (not HTML) | **SAFE** |
| 8 | echo / status | `minibuffer.js:173,177,242` | server status (file names) | `textContent` | **SAFE** |
| 9 | rich echo segments | `minibuffer.js:188-206` | server statusSegments | per-segment `textContent` + `style.color`/`fontWeight` (DOM props, CSP-safe) | **SAFE** |
| 10 | completions rows (file paths!) | `completions-panel.js:79,78` | file/dir names (attacker-controlled) | `label.textContent`, `item.dataset.name` | **SAFE** — paths never hit an HTML parser |
| 11 | tab labels | `tabline.js:76,83` | file basename / view name | `label.textContent`, `close.textContent='×'`, `tab.title=` (attr) | **SAFE** |
| 12 | utility-dock tab labels | `utility-dock.js:223,229` | panel title | `textContent` | **SAFE** |
| 13 | hover-doc name / notes | `hover-doc.js:94,101,106,118` | symbol name (textContent) | `code.textContent` etc. | **SAFE** for name |
| 14 | **hover-doc preview** | `hover-doc.js:111` | server-rendered docstring (marked) | **`innerHTML`, no sanitiser** | **RVCORE-06** — trusted source today |
| 15 | **doc-view page** | `doc-view.js:451,465` | built page HTML / marked docstring | **`innerHTML`**; heading escaped upstream, body raw marked | **RVCORE-07** — trusted source today |
| 16 | displayDocPanel HTML frame | `app.js:2347-2350` | heading + marked body | heading `escapeHtml`; **body raw marked** | **RVCORE-07** |
| 17 | doc-panel icon / FA buttons | `app.js:7532,7537`; `bookmark-view.js:145` | static FA markup (literals) | `innerHTML` of constant strings | **SAFE** (no dynamic data) |
| 18 | **markdown-preview iframe** | `app.js:7541,7858` | user markdown file via `jmarkdown watch` | iframe `src=localhost`, **no sandbox** | **RVCORE-04** — cross-origin isolated |
| 19 | markdown-preview morphdom | `markdown-preview.js:319,353,398` | engine HTML (`srcdoc`/`innerHTML`) | none (own doc) | cross-cutting; same trust as #18 (the live path uses the localhost iframe) |
| 20 | **reftex reference** | `reftex-cite-panel.js:267` | `.bib` fields via citation.js | **`innerHTML`, only `<script` stripped** | **RVCORE-05** — app:// origin |

`highlight.js` builds **no** DOM and holds **no** string sink — it returns
`Run[][]` data consumed by `renderRuns` (#1). Confirmed by a full grep for
`innerHTML|insertAdjacentHTML|outerHTML|createElement|className|textContent` (empty).

---

## Architecture observations

- **Display-ownership (VIEWS.md) is respected in the paint core.** `view.js` owns
  only its own leaf's DOM; the per-tab/leaf-direct/singleton visibility split lives
  in `app.js` (`mountTablineActiveChild`, `switchToViewIndex`, `hideInactiveSingletons`),
  outside my paint files. The tabline detachment hazard is correctly defused:
  `focusPaneFromEvent` is **capture-phase** on mousedown+click (`app.js:751-752`),
  and `tabline.js` `refresh()`'s `replaceChildren()` (`:65`) runs *inside* the tab's
  own mousedown after `onSelect(index)` has already captured `index` by closure.
- **Lifecycle / leaks are clean.** `view.js` `destroy()` (`:2123`) unsubscribes the
  buffer, `endDrag()`s the document mousemove/mouseup, disconnects the
  `ResizeObserver`, cancels the pending rAF, and removes the root. `hover-doc.js`
  removes all five listeners on `setEditorEl` re-point and on `destroy`. `utility-dock`
  `removeCapture()` runs on hide/toggle-hidden/close. `server-view-client.destroy()`
  tears down the view, both subscriptions, and nulls `port.onmessage`. The
  window-level listeners (`app.js:4155` keydown, `:751-752` capture focus) are
  singletons that die with the page — no per-mount accumulation. The one long-session
  growth vector is RVCORE-08 (`pending`), and it is bounded in practice.
- **The mirror read-surface is verbatim L1** (`client-buffer.js` delegates
  `lineAt`/`positionAt`/`offsetAt`/`slice` to `@editor/storage`), which is why
  `view.js`'s caret/selection math (`positionAt`/`offsetAt`, `visualColumn`,
  `charIndexAtVisualColumn`) works identically over a mirror — a genuinely small,
  clean seam.
- **Stale-VIEW cursor guard is present:** `onView` (`:561-570`) and `onCursors`
  (`:521-522`) skip adopting the server cursor while a predicted self-insert is in
  flight, so a lagging VIEW can't rewind the caret mid-type. Note the local-echo
  *predict* path is effectively dormant now (every key routes through the server's
  keymap; `dispatchKey` sends un-predicted keys), so the guard mostly protects the
  mouse-`moveTo` local echo.
- **`keyEventToString` internal consistency (Q4):** prefix order is
  `C-` `M-` `A-` `S-` (`keymap.js:180-184`) ✓; base name is lowercased via
  `codeToBase`/`NAMED_KEYS` ✓; punctuation code-names (`BracketLeft→[`, digits,
  `Space→space`) ✓; `Ctrl+M` resolves to `C-m` via `event.code==='KeyM'` while
  `Ctrl+Enter` → `C-enter` via `code==='Enter'` — the two are correctly disambiguated
  by `event.code` (not conflated as in a terminal). Synthetic events without `code`
  fall back to `NAMED_KEYS[key] ?? key.toLowerCase()` — a reasonable degradation.
  The module itself does **no** IME gating (it is pure); gating is the caller's job,
  which is honoured in `view.js` but **not** in `minibuffer.js`/`utility-dock.js`
  (RVCORE-11).
- **Dead pre-Model-B code** is confined and inert (RVCORE-10). The `paste` window
  handler (`app.js:4202`) is a documented no-op stub. Both are correctly guarded, not
  live alternatives.

## Paint pipeline (Q1) — how a VIEW push becomes DOM

- **DELTA/RESYNC/SNAPSHOT** mutate the `ClientBuffer` mirror's `@editor/storage`,
  which fires `onChange` → `scheduleFollowingCursor` → **rAF-batched** `render()`.
  This is the well-coalesced path.
- **CURSOR/CURSORS/OVERLAYS/VIEW** reconcile the mirror then call `view.setView()`,
  which renders **synchronously** (RVCORE-02) — the pipeline's one un-batched arm.
- **Full vs incremental:** each `render()` rebuilds the *visible window* only —
  `renderLines` emits DOM for display rows in `[firstRow−overscan, lastRow+overscan]`
  and `linesEl.replaceChildren(...)`. This is **line virtualisation**, so a big buffer
  costs O(viewportLines) per frame, not O(bufferLines). The **whole-buffer highlight**
  is the expensive part and is **cached** on `(text, language, mode, overrideGen)`
  (`view.js:812-851`); a scroll-only or cursor-only render reuses it, so there is **no
  whole-buffer re-tokenise per keystroke** for cached text — only an edit (text
  change) re-parses. Tree-sitter parse cost is therefore per-edit, not per-frame.
- **Perf cliffs:** (a) RVCORE-02's synchronous per-message render; (b) a language
  with a *whole-buffer* built-in tokeniser (LaTeX/Makefile via `highlightBuffer`)
  re-runs the whole-buffer tokenise on every edit (still cached across scrolls); (c)
  the block-math re-measure loop re-`schedule()`s an extra frame per block widget
  until `blockRowsByKey` converges (`view.js:1123-1134`) — one extra frame, then
  stable.
- **Stale VIEW state (fold ranges beyond EOF after an external change):** robust —
  the fold cache is re-derived from current mirror text every render and pruned/clamped
  (see RVCORE-09 evidence). The only residual staleness is the math replaced-ranges'
  one-frame window (RVCORE-09), which the degrade path covers for throws.

---

## Test coverage

- **Present:** `apps/desktop/src/server-view-client.test.js` (client apply path with
  fakes — the module is built for injection, so message routing is unit-tested),
  `apps/desktop/mwb/client-buffer.test.js` (mirror read surface + delta/echo),
  `packages/renderer/src/minimap-view.test.js` (agent-12 territory),
  `apps/desktop/test/server-view-mount.test.js`, `view-warehouse.test.js`,
  `math-preview-host.test.js`, `move-view-state.test.js`.
- **Unit-tested pure cores (by design):** `utility-dock.js` reducer
  (`emptyUtilityState`/`addTab`/`removeTab`/`activateTab`/`nextTabId`),
  `completions-panel.js` `completionsHeaderLabel`, `math-tooltip.js` `chooseRender`
  and `placeAbove` (all exported specifically to be testable without a DOM).
- **Gaps:**
  - **`keymap.js`** — no `keymap.test.js` in `packages/renderer/src`. `keyEventToString`
    is the whole client-side key contract (prefix order, `Ctrl+M`/`Ctrl+Enter`
    disambiguation, code-name table) and is untested. It is pure and trivially
    testable — this is a cheap, high-value gap.
  - **IME gating in chrome inputs** (RVCORE-11) — no test asserts the minibuffer
    ignores an `isComposing` Enter/Escape.
  - **`view.js`** paint/caret/fold math is DOM-heavy and only smoke-tested live
    (the plan and `CLAUDE.md` both note the unit suite stubs host primitives).
    `columnToXPx`/`xPxToColumn` (the widget-aware caret math) are pure enough to
    extract and test; today they aren't.
  - **`handleMessage`** has no test for a throwing handler / unknown type (the
    `default: break` for unknown types is correct but untested).

---

## What's solid

- The **render error boundary** — full try/catch with a degraded plain-text retry,
  then per-pass isolation for sticky/decoration/selection/bracket/cursor so one
  failing pass can't stop the caret from tracking (`view.js:1398-1470`). This is the
  right shape and reports once (`renderErrorReported`).
- **Line virtualisation + highlight caching** — bounded DOM and no per-keystroke
  whole-buffer re-tokenise; the fold index and highlight cache are shared with the
  sticky-header and minimap paths.
- **DOM-sink hygiene in the core paint path** — every dynamic string reaches the DOM
  via `textContent`/`className`/dataset; the completions panel (file paths!),
  tabline (file basenames), modeline and echo (file names) are all `textContent`.
- **Tabline detachment hazard** handled by capture-phase focus registration.
- **IME P0 (B1) holds in the editor** — `composing`/`isComposing`/`keyCode 229`
  gate + `compositionstart`/`compositionend` wired to the hidden textarea sink, with
  a stray-input drop guard (`view.js:372-391,1511`).
- **Lifecycle discipline** — `destroy()`s unsubscribe, disconnect observers, cancel
  rAF, and remove listeners consistently across `view.js`, `hover-doc.js`,
  `utility-dock.js`, `server-view-client.js`.
- **Client-apply defensiveness** — per-handler type guards, `activePickerId`/
  `minibufferActive` lock-step with the server, stale-picker teardown, stale-VIEW
  cursor-rewind guard, unknown-message `default: break`.

---

## Open questions

1. **RVCORE-05 reachability:** does citation.js actually HTML-escape every `.bib`
   field, including in author/title with embedded braces/commands? If not, RVCORE-05
   is a genuine app://-origin P0 from a repo `.bib`. Needs a citation.js-focused pass
   (outside my core files).
2. **RVCORE-04:** is `sandbox="allow-scripts"` (without `allow-same-origin`)
   compatible with the `jmarkdown watch` page's MathJax? If yes, it's a free harden.
3. **markdown-preview.js** (the `srcdoc`/morphdom component) — is it still wired
   anywhere, or fully superseded by the localhost iframe in `app.js`? If dead, its
   `srcdoc`/`innerHTML` sinks (`:319,353,398`) are a latent surface worth deleting.
4. Should the whole marked pipeline (`markdown.js`) gain a sanitiser now, given four
   `innerHTML` sinks (hover-doc, doc-view, displayDocPanel, sticky notes) all consume
   its unsanitised output and today's trust boundary is "docstrings/notes are
   trusted"? One sanitiser call closes RVCORE-06/07 permanently.

---

## Stats

- Files claimed as core: **17** (+ 3 cross-referenced: `markdown.js`,
  `markdown-preview.js`, `reftex-cite-panel.js`).
- Findings: **11** — P0 **0**, P1 **0**, P2 **5** (RVCORE-01,02,03,04,05,11 → six
  at P2; RVCORE-03 straddles P2/P3), P3 **5** (RVCORE-06,07,08,09,10).
  (Count by primary severity: P2 = 6, P3 = 5.)
- DOM string sinks inventoried: **20** — SAFE **14**, flagged **6** (2 core-trusted
  markdown `innerHTML`, 1 hover-doc, 2 cross-cutting iframe/bib, plus the static-FA
  `innerHTML`s which are SAFE).
- CONFIRMED: RVCORE-01 (guard-absence), 02, 03 (mechanism), 04, 10, 11 (guard-absence).
  PLAUSIBLE: RVCORE-05, 06, 07, 08 (impact), 09.
- `node --check` clean: `server-view-client.js`, `view.js`, `keymap.js`.
