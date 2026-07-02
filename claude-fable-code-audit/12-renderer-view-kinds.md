# Renderer view kinds — audit

**Auditor:** audit agent 12 of 13
**Date:** 2026-07-01
**Repo:** /Users/jalex/Source/jmacs/main @ main (efe0fa6d)
**Area:** the view-kind zoo in `packages/renderer/src/` — every kind file agent 11
does *not* own. Model B: server owns the Lisp; views consume pushed state.
Read-only audit; the only file written is this report.

## Scope table

Everything in `packages/renderer/src/` that is not agent 11's territory
(view.js, highlight.js, keymap.js, tabline.js, minibuffer.js,
completions-panel.js, doc-panel.js, utility-dock.js, modeline/echo/status in
app.js, server-view-client). "Read fully" = every line; "Swept" = header +
DOM-sink grep + lifecycle (destroy/disconnected) + display-ownership +
document/window-listener balance.

| File | Lines | Depth |
|---|---:|---|
| pdf-view.js | 1509 | **Read fully** |
| jmarkdown-scan.js | 1110 | **Read fully** + benchmarked |
| minimap-view.js | 1065 | **Read fully** |
| directory-columns-view.js | 936 | **Read fully** |
| audio-view.js | 838 | **Read fully** |
| notebook-cells-view.js | 772 | **Read fully** |
| jukebox-view.js | 722 | **Read fully** |
| directory-tree-view.js | 613 | **Read fully** |
| gnuplot-view.js | 632 | **Read fully** (sinks/lifecycle) |
| browser-view.js | 434 | **Read fully** + main.js webview glue |
| notebook-cells-output.js | 372 | **Read fully** |
| shell-view.js | 499 | **Read fully** |
| element-view.js | 284 | **Read fully** |
| typeset-math.js | 187 | **Read fully** + MathJax config |
| markdown-preview.js | 516 | **Read fully** (iframe/sanitize path) |
| markdown.js | 120 | **Read fully** (marked config) |
| mermaid-scan.js | 493 | Benchmarked (backtracking) |
| notebook-cells-engine.js | 463 | Swept (AsyncFunction eval) |
| image-view.js | 375 | Swept (src/teardown) |
| video-view.js | 347 | Swept (src/teardown) |
| media-view.js | 238 | Swept (pure helpers) |
| doc-view.js | 557 | Swept (innerHTML + lifecycle) |
| hover-doc.js | 259 | Swept (innerHTML source) |
| reftex-cite-panel.js | 507 | Swept (innerHTML CSL) |
| reftex-select-panel.js | 442 | Swept |
| bookmark-view.js | 570 | Swept (innerHTML pin + doc listener) |
| customize.js | 578 | Swept (lifecycle, sinks) |
| recover-view.js | 311 | Swept |
| view-list-view.js | 282 | Swept |
| placeholder-view.js | 354 | Swept |
| text-view.js | 328 | Swept (wrapper; body is agent 11's view.js) |
| citation.js | 301 | Swept (pure helpers) |
| colour-picker.js / colour-swatches.js / colour-literals.js | 165/193/154 | Swept (doc-listener balance) |
| math-preview*.js, math-tooltip.js, math-segments.js, math-layout.js | — | Swept (math node sinks) |
| notebook-cells.js / -serialize.js | 219/117 | Swept (pure model) |
| treesitter.js, language-registry.js, folding.js, brackets.js, projection.js, indent-guides.js, latex-folds.js, runs.js, highlight-overrides.js, splitter.js, view-elements.js, inline-eval.js, repl.js, output-panel.js, gnuplot-history.js, gnuplot-svg.js, commands.js, fuzzy.js, index.js, tabline-view.js, bookmark-outline.js, placeholder-actions.js, languages/* | — | Swept (no DOM-content sinks; pure/borderline) |

Note: `tabline-view.js` is borderline agent-11 ("tabline"); swept, nothing found.

---

## Executive summary

The view-kind zoo is **in unusually good shape on the highest-value axis**:
**no confirmed XSS-from-file-content is reachable in production, and no
hostile-file crash/freeze exists on a normal path.** The two directory views —
the classic filename-XSS trap — render every filename through `textContent`,
and their icon URLs are dictionary-bounded to the vendored set. The media views
(audio/video/image/jukebox) route all strings through `textContent` and all
sources through host-built `media://`/`data:` URLs, with no renderer-side object
URLs to leak. The per-view-instance discipline is clean: no bare `text-view`
selectors, no cross-container `style.display` pokes. `xterm` and `pdf.js` are
current (6.0.0 / 5.7.284) and configured sanely; the shell pty and pdf worker
tear down on `destroy()`. Display ownership is respected everywhere.

The findings are all **P2/P3** — latent hazards and leaks, not live wounds:

1. **RVK-01 (P2):** `directory-columns-view` leaks a `ResizeObserver` + scroll
   listener + detached `<pre>` on *every text-file preview* — its inner view
   has no `destroy()` at all, so browsing files accumulates observers.
2. **RVK-02 (P2):** `jmarkdown-scan` is **quadratic** on `==`-dense /
   no-blank-line input (240 KB → 1.5 s, 1 MB → 42 s, measured) and re-scans the
   *whole document on every keystroke*; a crafted or minified `.jmd` freezes
   highlighting.
3. **RVK-03 (P2):** `markdown-preview.js` mounts an **unsandboxed same-origin
   `srcdoc` iframe fed unsanitized `marked` output** — a textbook renderer
   compromise **that is currently dead code** (no call site), but a landmine
   for whoever wires it up.
4. **RVK-04 (P2):** the `browser-view` webview has **no
   `setPermissionRequestHandler`**, so arbitrary embedded pages fall to
   Electron's default-allow for camera/mic/geolocation.
5. **RVK-05 (P2):** MathJax runs without the `safe` extension; default
   `autoload` pulls the `html` package on `\href`, so math in a hostile file can
   render a clickable `javascript:` link.

Everything else is P3 (jukebox kill doesn't stop shared audio; trusted-SVG
`innerHTML`; docstring/CSL markdown `innerHTML`; debug logging; a menu-open
teardown edge).

The **test story is thin**: most view *classes* have no automated coverage at
all (pdf, directory-columns, shell, gnuplot, element, video, customize,
notebook-cells view/engine/output, hover-doc, bookmark), which is expected under
the "smoke test owns live DOM" convention but leaves the biggest kind
(pdf-view, 1509 lines) with zero automated tests beyond `isPdfName`.

---

## Findings

### RVK-01: directory-columns text preview leaks a ResizeObserver + `<pre>` per preview

- **Severity:** P2
- **Dimension:** Correctness (lifecycle) / perf
- **Location:** `packages/renderer/src/directory-columns-view.js:403-419`
  (`renderHighlightedPreview`), and `directory-columns-view.js:930`
  (`DirectoryColumnsView.destroy` — the wrapper only nulls `_inner`; the inner
  factory returns **no `destroy`**).
- **Evidence:** `renderHighlightedPreview` installs, per preview `<pre>`:
  `pre.addEventListener('scroll', scheduleRender)` (line 412) and
  ```js
  const ro = new win.ResizeObserver(() => scheduleRender());
  ro.observe(pre);            // line 417-418 — never disconnected
  ```
  `paint()` (line 512) calls `strip.replaceChildren()` on every click, throwing
  away the old `<pre>`. The `ResizeObserver` holds a strong reference to its
  observed target and is retained by the platform's observation registry until
  `disconnect()` — which is never called. The inner factory returns only
  `{ element, setBuffer, focus, _selectIn }` (line 870-876): **no teardown
  hook**, and the element `destroy()` (line 930-933) just nulls `_inner`, so the
  context-menu/modal document listeners and these observers are never released.
- **Failure scenario:** The user opens a Finder-style columns view and clicks
  through 50 text files (each replaces the trailing preview column). 50 detached
  `<pre>` subtrees + 50 live `ResizeObserver`s accumulate for the life of the
  view. A long browsing session grows memory monotonically; the still-live
  observers also keep firing `scheduleRender` on any layout change.
- **Fix direction:** Give the inner factory a `destroy()` that disconnects the
  active preview's `ResizeObserver` and removes its scroll listener, and have
  the wrapper call it. Simplest concrete step: track the current preview's `ro`
  on a closure variable and `ro.disconnect()` at the top of `buildPreview`/next
  `paint`, and add an inner `destroy` that also closes any open context menu.
- **Confidence:** CONFIRMED (traced observe-with-no-disconnect + replaceChildren
  churn + missing inner destroy).

### RVK-02: jmarkdown-scan is quadratic on `==`-dense input; whole-doc rescan per keystroke

- **Severity:** P2
- **Dimension:** Correctness / perf (hostile / large input)
- **Location:** `packages/renderer/src/jmarkdown-scan.js` — `highlights()`
  (972-997) calling `blankLineAfter()` (1107-1110); also `isClaimed()`
  (171-174) linear scan; consumed via `languages/jmarkdown.js:45` memoised per
  `text`, invoked on the **whole document** by `treesitter.js`
  `captureProvider` (see its header, "the *whole* document").
- **Evidence (measured, Node, this repo):**
  | input | size | time |
  |---|---:|---:|
  | `('==a')×60k` (no blank lines) | 240 KB | **1.48 s** |
  | `('==a')×120k` | 480 KB | **4.31 s** |
  | `('==a')×350k` | 1.05 MB | **41.9 s** |
  | realistic prose w/ closed `==jumps==` + blank lines | 393 KB | 68 ms |
  For each `==` opener, `highlights` calls `blankLineAfter(S, open+2)` which does
  `S.slice(from)` (a full-tail copy) plus a regex, and `S.indexOf('==', ...)` —
  both O(n) — for O(n) openers ⇒ **O(n²)**. The `isClaimed` linear scan adds a
  second O(k²) when many inline constructs are claimed. Realistic prose is fine
  because blank lines make `blankLineAfter` return early; the cliff is
  `==`-dense text *with no blank lines* (minified content, base64 blobs, `====`
  separator art in one long stretch).
- **Failure scenario:** Opening — or *typing in* — a large `.jmd`/`.md` with a
  long `==`-dense run freezes highlighting for seconds per keystroke (the capture
  provider re-scans the whole buffer on every edit, since the memo key is the
  text). A hand-crafted file wedges the renderer for ~40 s on a single edit.
- **Fix direction:** Precompute blank-line offsets once per scan (a sorted array
  + binary search in `blankLineAfter`, no per-call slice); cap `highlights`
  work; make `isClaimed` an interval index rather than `Array.some`. Separately,
  consider windowing the dialect scan to the viewport ± overscan rather than the
  whole buffer.
- **Confidence:** CONFIRMED (benchmarked quadratic scaling; whole-doc-per-edit
  invocation traced through `languages/jmarkdown.js` + `treesitter.js`).

### RVK-03: markdown-preview.js — unsandboxed same-origin srcdoc iframe fed unsanitized marked output (dead code, but a landmine)

- **Severity:** P2 (would be **P0** if wired)
- **Dimension:** Security (XSS-from-file-content)
- **Location:** `packages/renderer/src/markdown-preview.js:452-461`
  (iframe creation, **no `sandbox` attribute**), `319` / `353`
  (`frame.srcdoc = docHtml` / `next.innerHTML = html`); render source
  `renderMarkdown` in `markdown.js:74` = `new Marked({ gfm:true, breaks:false })`
  with **no sanitizer** (marked passes raw HTML through).
- **Evidence:** The component builds `doc.createElement('iframe')` with only a
  class — no `sandbox`. A same-origin `srcdoc` iframe inherits the parent
  `app://` origin **and** the page CSP (`index.html:7`), whose
  `script-src` includes **`'unsafe-inline'`** — so inline `<script>` and
  `onerror=`/`onload=` handlers in the srcdoc **execute**, and same-origin means
  the frame can reach `window.parent.host` (the full context bridge: file writes,
  shell spawn, …). `renderMarkdown` does not strip HTML.
  **However**, `createMarkdownPreview` has **no call site** anywhere in
  `apps/desktop` (grep: only the `index.js` export + its own definition). The
  *live* preview host (`#markdown-preview-host`) is filled by a separate
  hand-built iframe in `app.js:7541` whose `src` is
  `http://localhost:${port}/` (the `jmarkdown watch` subprocess) — **cross-origin
  from `app://`**, so that path is correctly isolated.
- **Failure scenario:** Not exploitable today (unwired). If a future change
  mounts `createMarkdownPreview` with `render = renderMarkdownHtml` (as its
  JSDoc implies), opening + previewing a hostile `.md` containing
  `<img src=x onerror="parent.host.…">` yields renderer RCE.
- **Fix direction:** Either delete the module (superseded by the localhost
  watch-preview), or before any reuse: add `sandbox=""` (no
  `allow-same-origin`), and sanitize/escape HTML in `renderMarkdown` (or render
  in a null-origin frame). A comment in the file should record that it is *not*
  the live path.
- **Confidence:** CONFIRMED (no sandbox; marked unsanitized; no call site; live
  path is cross-origin localhost).

### RVK-04: browser-view webview has no permission-request handler (Electron default-allow)

- **Severity:** P2
- **Dimension:** Security (browser surface) — *main-process / agent-7 territory,
  but it governs this kind's posture*
- **Location:** `packages/renderer/src/browser-view.js:205-219` (mounts
  `<webview partition="persist:browser-views" allowpopups>`); the gap is in
  `apps/desktop/src/main.js` — grep for `setPermissionRequestHandler` /
  `setPermissionCheckHandler` across `apps/` + `packages/` returns **nothing**.
- **Evidence:** `main.js:269` installs a `web-contents-created` handler that
  correctly denies `setWindowOpenHandler` popups (only a user-clicked
  `foreground-tab` https link reloads in the same webview). But no permission
  handler is registered on the webview's session. Electron's default, absent a
  handler, approves most permission requests (camera/mic `media`, `geolocation`,
  `notifications`, …). The `browser-view` navigates to arbitrary
  `https://` pages (`normaliseUrl` prepends `https://`).
- **Failure scenario:** The user opens a hostile page in the in-app browser; the
  page calls `getUserMedia()` / `navigator.geolocation` and Electron silently
  grants — camera/mic/location exposure with no prompt.
- **Fix direction:** On the `persist:browser-views` session, install
  `setPermissionRequestHandler`/`setPermissionCheckHandler` that denies by
  default (or prompts) — camera/mic/geolocation especially.
- **Confidence:** CONFIRMED (no handler exists); impact PLAUSIBLE (depends on
  Electron default-grant, which is the documented behaviour).

### RVK-05: MathJax lacks the `safe` extension — `\href{javascript:…}` reachable from file content

- **Severity:** P2
- **Dimension:** Security (MathJax input from buffer content)
- **Location:** `apps/desktop/index.html:44-63` (`window.MathJax = {…}` — no
  `options.safeOptions`, no `tex.packages` pin, `svg`+`startup` only); consumed
  by `packages/renderer/src/typeset-math.js:49` (`tex2svg`) which returns a
  live node inserted into the DOM by the math-preview / math-tooltip layers.
- **Evidence:** The config sets `inlineMath`/`displayMath`/`processEscapes` but
  never loads the `safe` extension nor restricts `tex.packages`, so `tex-svg.js`
  uses its defaults — which include `autoload` + `require`. `autoload` maps
  `\href` to auto-load the `html` package; `\href{url}{text}` then renders an
  SVG `<a>` whose href is arbitrary. Under the page CSP's
  `script-src 'unsafe-inline'`, a `javascript:` href is not blocked. The math
  body is **buffer/file content** (latex-mode, markdown/jmarkdown math), so a
  hostile `.tex`/`.md` can carry `$\href{javascript:…}{click me}$`.
- **Failure scenario:** User opens a hostile document, enables math preview; the
  math typesets a clickable link; a click runs `javascript:`. (The
  `html` package's `\style`/`\class`/`\cssId` also allow attribute/style
  injection into the math node — overlay/positioning tricks — without a click.)
- **Fix direction:** Load the MathJax `safe` extension (or pin
  `tex.packages` to exclude `html`/`require`, or set
  `options.safeOptions.allow.URLs = 'safe'`). Keeps display math working while
  neutralising `javascript:`/`data:` hrefs.
- **Confidence:** PLAUSIBLE (config gap CONFIRMED; not traced end-to-end that the
  live preview path renders the `\href` anchor and that the click navigates —
  worth a live check, but the default-autoload behaviour is documented).

### RVK-06: notebook `inspect()` auto-renders any returned string containing `<svg` as innerHTML

- **Severity:** P2
- **Dimension:** Security (notebook cell output into DOM) — flag-off MVP,
  not-live-verified
- **Location:** `packages/renderer/src/notebook-cells-output.js:139-141`
  (`inspect`: `if (/<svg[\s>]/i.test(value)) return { type:'svg', svg:value }`);
  sink at `notebook-cells-view.js:347` (`out.innerHTML = desc.svg`) and `:350`
  (`out.innerHTML = desc.html`).
- **Evidence:** A cell that returns a *plain string* containing `<svg` is
  auto-classified as `svg` and its content is assigned via `innerHTML` with no
  opt-in. SVG inserted via `innerHTML` executes inline event handlers
  (`<svg onload=…>`, `<animate onbegin=…>`, `<image href onerror=…>`), so the
  auto-path is a live-markup sink. The explicit `Inspector.html`/`.svg` builders
  are documented escape hatches ("trust model = REPL"); the concern is the
  *automatic* path, which needs no author intent — merely returning
  attacker-derived text that happens to contain `<svg`.
- **Failure scenario:** A cell does `return await (await fetch(hostileUrl)).text()`
  and the response contains `<svg onload=…>` — renders as live markup. Bounded by
  REPL trust (the cell already runs arbitrary JS) and by cells **not**
  auto-running on notebook open (verified: `openNotebook`→`loadCells` never runs
  cells; the user must click Run), so this is not an open-file RCE.
- **Fix direction:** Don't auto-`innerHTML` inferred SVG — require the explicit
  `Inspector.svg(...)` opt-in, or sanitize the auto path. Low urgency while the
  notebook is flag-off/MVP.
- **Confidence:** CONFIRMED (sink + auto-classification); impact bounded by REPL
  trust + no-auto-run.

### RVK-07: jukebox kill-while-playing doesn't stop the shared audio controller

- **Severity:** P3
- **Dimension:** Correctness (lifecycle)
- **Location:** `packages/renderer/src/jukebox-view.js:686-689`
  (`JukeboxView.destroy` nulls `_inner` only); `apps/desktop/src/app.js:6612`
  (`disposeKindView` has **no `jukebox` case**); the view adopts the shared
  controller via `audio.attachElement(audioEl)` (jukebox-view.js:196-198).
- **Evidence:** `q`/Quit calls `audio.stop()` (jukebox-view.js:385-388), but
  `C-x k` (kill-view) routes through `disposeKindView`, which has cases for
  browser/doc/placeholder/element/minimap/shell/gnuplot/tabline — **not
  jukebox** — and `killViewAtIndex` only special-cases audio/video for
  `destroy()`. Jukebox's inner factory returns no `destroy` and the wrapper's
  `destroy` doesn't touch the audio controller. So killing a jukebox tab while a
  track plays leaves the shared controller playing with no visible transport.
  (`hideInactiveRendererViews`' media-release list is audio/video/shell — jukebox
  is not in it either.)
- **Failure scenario:** Play a track in the jukebox, `C-x k` the buffer → audio
  keeps playing; the user must find the REPL `audio-stop` (or reopen a jukebox)
  to silence it.
- **Fix direction:** Add a `jukebox` branch to `disposeKindView` (or a wrapper
  `destroy`) that calls `audio.stop()` when this view owns the currently-playing
  path.
- **Confidence:** PLAUSIBLE (traced the missing dispose branch; the shared-
  controller design is deliberate, so exact live behaviour depends on whether the
  controller keeps driving the detached element).

### RVK-08: gnuplot-view leaks a document listener + menu node if destroyed while its context menu is open

- **Severity:** P3
- **Dimension:** Correctness (lifecycle)
- **Location:** `packages/renderer/src/gnuplot-view.js:275`
  (`doc.addEventListener('mousedown', onDocMouseDown, true)` in `openMenu`),
  `242-249` (`closeMenu` removes it), `534-542` (`destroy` — does **not** call
  `closeMenu`).
- **Evidence:** The right-click menu is appended to `doc.body` and installs a
  capture-phase document listener; `closeMenu` balances both on the normal path.
  But `destroy()` tears down subscriptions and clears caches without closing an
  open menu, so a view killed with its menu open orphans the menu `<div>` in
  `body` and the document listener.
- **Failure scenario:** Right-click a plot, then `C-x k` before dismissing the
  menu — a dangling document mousedown listener + menu node survive the view.
- **Fix direction:** Call `closeMenu()` at the top of `destroy()`.
- **Confidence:** PLAUSIBLE (narrow edge; normal path is balanced).

### RVK-09: pdf-view emits verbose file-path debug logging in production

- **Severity:** P3
- **Dimension:** Architecture (smell / minor info exposure)
- **Location:** `packages/renderer/src/pdf-view.js:247-258` (`setBuffer`),
  `528-539` / `600-603` (`_loadFromBuffer`).
- **Evidence:** `console.debug('[pdf-view] setBuffer', {…})` and
  `console.debug('[pdf-view] _loadFromBuffer', { …, src, filePath, … })` run on
  every mount/load with no `__SMOKE__`/dev gate, logging absolute file paths and
  media URLs to the renderer console in shipped builds.
- **Fix direction:** Gate behind a debug flag or drop.
- **Confidence:** CONFIRMED.

### RVK-10: pdf-view `_resizeObserver` not explicitly disconnected on destroy

- **Severity:** P3
- **Dimension:** Correctness (lifecycle — self-contained)
- **Location:** `pdf-view.js:507-514` (creates `this._resizeObserver` on the
  viewport), `_teardownDoc` (1485-1506) disconnects only `this._observer` (the
  page IntersectionObserver); `destroy()` (287-290) → `_teardownDoc`.
- **Evidence:** The viewport `ResizeObserver` is never `disconnect()`ed. It
  observes a child of the element and is referenced only through the element, so
  element + observer + viewport form an isolated cycle that GC collects once the
  host drops the element — hence "self-contained", not a growing leak. Still,
  explicit teardown is the house style (shell-view and minimap both disconnect).
- **Fix direction:** `this._resizeObserver?.disconnect()` in `destroy()`.
- **Confidence:** CONFIRMED (missing disconnect; impact minor).

### RVK-11: trusted-SVG `innerHTML` (directory-tree icons, gnuplot/minimap plots) — defended but attribute-handler-bearing

- **Severity:** P3
- **Dimension:** Security (defended latent)
- **Location:** `directory-tree-view.js:247,256` (`span.innerHTML` of a fetched
  Material SVG); `gnuplot-view.js:318` (`plot.innerHTML = payload.svg`);
  `minimap-view.js:652` (`thumb.innerHTML = p.svg`).
- **Evidence:** All three sources are trusted-local: the directory-tree icon URL
  is dictionary-bounded (`material-icons.js` — filename → a vendored icon *name*
  → `BASE + <vendored file>`, never an attacker path), and the gnuplot/minimap
  SVGs are the host's own gnuplot output (scripts stripped main-side per the
  comments). `<script>` inserted via `innerHTML` is inert, but inline
  `onload=`/`onerror=` attributes would fire — so the safety rests entirely on
  the sources being trusted (they are). No filename or file-content path reaches
  these sinks.
- **Fix direction:** None required; if defence-in-depth is wanted, parse SVG with
  `DOMParser('image/svg+xml')` and strip `on*` attributes before insert.
- **Confidence:** CONFIRMED (sources traced to trusted origins).

### RVK-12: docstring / CSL markdown rendered to innerHTML via unsanitized `marked` (author/semi-trusted)

- **Severity:** P3
- **Dimension:** Security (defended latent)
- **Location:** `hover-doc.js:111` (`preview.innerHTML = summary.preview`, a
  rendered live docstring), `doc-view.js:465` (`tmp.innerHTML = buffer.html`),
  and `reftex-cite-panel.js:267` `setReferenceHtml` (`el.innerHTML =
  html.replace(/<script/gi,'&lt;script')`).
- **Evidence:** Docstring previews come from `renderMarkdown` (unsanitized
  `marked`) of a Lisp function's docstring — author/REPL trust (the user defines
  the function). `doc-view` renders pre-built manual pages
  (`scripts/build-docs.js`) — trusted. `reftex-cite-panel` renders citation.js
  CSL output, which HTML-escapes bib field text and emits only its own tags; the
  `<script`-only strip is a weak secondary guard (wouldn't catch `<img onerror>`)
  and bibliographies are frequently *downloaded* (semi-trusted), so the real
  barrier is citation.js's field escaping.
- **Fix direction:** For the bib path, prefer building the reference DOM without
  `innerHTML` or run a real sanitizer rather than a `<script`-only regex; for
  docstrings, escaping/sanitizing marked output would harden the author path.
- **Confidence:** PLAUSIBLE-latent (relies on upstream escaping + trust; no
  confirmed injection path).

---

## Per-kind lifecycle & sink matrix

| Kind (file) | Leaks on churn? | Unescaped DOM sink? | Display-ownership violation? | Server-state consumption | Test coverage |
|---|---|---|---|---|---|
| pdf (pdf-view.js) | resize-observer not explicitly disconnected (self-contained, RVK-10); doc + worker torn down OK | none — status/find all `textContent`/`createTextNode` | none | per-instance; `src`/`filePath` from view push; generation-token guards stale loads (good) | **none** (only `isPdfName` via barrel) |
| browser (browser-view.js) | webview `src`→about:blank on destroy (OK) | none | none | per-instance; url from view push, `did-navigate`→`onNavigate` upstream | helper only (`normaliseUrl`) |
| shell (shell-view.js) | term.dispose + RO.disconnect + unsub in destroy (good) | none (xterm owns escapes; `\x1b[` writes are controlled) | none | subs via onData/onExit; pty killed by disposeKindView | **none** |
| directory-tree | none | icon `innerHTML` = dictionary-bounded vendored SVG (RVK-11); names `textContent` | none | listing via host primitive | directory-tree-view.test.js (helpers) |
| directory-columns | **RVK-01: RO + scroll listener + `<pre>` per preview; no inner destroy** | none — names + preview via `textContent`/spans | none | listing + `getPreview` via host | **none** |
| notebook-cells (view) | destroy removes markers + editor.destroy (OK) | **RVK-06 auto-svg innerHTML**; html/svg descriptors (REPL trust) | none | eval via `__godotNotebookEval` (server) or local engine | model tested; **view/engine/output untested** |
| audio | pause+removeAttribute+load on destroy (good) | none — metadata `textContent`; art `img.src`=data:/media: | none | metadata/art from view push | audio-view.test.js (helpers) |
| jukebox | **RVK-07: shared audio not stopped on kill** | none — labels/notes `textContent` | none | tracks/labels/art from view push | jukebox-view.test.js (helpers) |
| minimap | destroy: subs + RO + raf + editTimer + flyout all released (exemplary); bindTarget tears down prior subs | plot-thumb `innerHTML` = trusted gnuplot SVG (RVK-11) | manages only its own inner elements | adapter (getLineRuns/onScroll/onChange); repaint **debounced 60 ms** (no per-keystroke cliff) | minimap-view.test.js (geometry) |
| gnuplot (view) | subs cleared in destroy; **RVK-08 menu-open edge** | `plot.innerHTML` = trusted gnuplot SVG (RVK-11) | none | onResult/onExit subs; process killed by disposeKindView | history/svg helpers only |
| element (element-view) | destroy drops key grab + channels + inner element (good) | none (attrs via setAttribute) | none | `import(moduleUrl)` from Lisp spec — **CSP blocks remote** (script-src lacks https:) | **none** |
| image / video | removeAttribute('src')(+load) on destroy; **no renderer object URLs** | none | none | `src` from view push | image-view/media-view tests (helpers) |
| doc (doc-view) | per-instance dispose via disposeDocElementForView | `buffer.html` innerHTML = built manual (trusted, RVK-12) | none | readPage / renderMarkdown | doc-view.test.js |
| customize | swept — form widgets, `textContent`; no doc-listener leak | none found | none | server customize data-source | (helpers) |
| recover / view-list / placeholder / bookmark | swept — `textContent`; bookmark pin innerHTML is a **static** icon string (safe); bookmark doc-listener balanced | none (bookmark pin static) | none | pushed fields | recover/view-list tested; bookmark(view) untested |
| markdown-preview.js | **RVK-03 dead-but-dangerous** (unsandboxed srcdoc; unwired) | `srcdoc`/`innerHTML` unsanitized marked | n/a (unwired) | n/a | markdown-preview.test.js (commit logic) |
| typeset-math / math-* | math nodes cloned into DOM (not innerHTML) | **RVK-05 MathJax `\href`** (config-level) | none | body from buffer | typeset-math + math-* tests |
| jmarkdown-scan | pure (no lifecycle) | n/a | n/a | whole-doc scan (RVK-02) | jmarkdown-scan.test.js |
| mermaid-scan | pure | n/a | n/a | benchmarked — **no backtracking** | mermaid-scan.test.js |

---

## Architecture observations

- **Per-view-instance discipline is clean across the zoo.** No file uses a bare
  `text-view` (or other kind) selector reaching into another container
  (`grep` for cross-container `querySelector('text-view')` → nothing). Every kind
  toggles only its own inner elements' `style.display` (minimap's
  canvas/thumb/message/plotStrip, audio/jukebox art, media error blocks) — all
  within-instance, none crossing the ownership lines in `docs/VIEWS.md`.
- **`disposeKindView` (app.js:6612) is the single dispatch for per-kind
  teardown** and is mostly symmetric — but it is a hand-maintained `if`-ladder,
  and the **jukebox omission (RVK-07)** is exactly the kind of gap that ladder
  invites. A registry keyed by kind (mirroring `SINGLETON_VIEWS`) would make
  "every kind that allocates must appear here" checkable.
- **CSP is a real backstop and is doing its job.** `script-src 'self' app:
  'unsafe-inline' 'wasm-unsafe-eval'` (no `https:`) means element-view's
  `import(moduleUrl)` (element-view.js:175) cannot pull remote code into the
  privileged renderer — a genuine mitigation for the "arbitrary module URL from
  Lisp" power. The same CSP's `'unsafe-inline'`, however, is what makes RVK-03
  and RVK-05 dangerous (inline handlers / `javascript:` execute). Tightening
  `script-src` (dropping `'unsafe-inline'`, moving inline MathJax config to a
  file) would neutralise a whole class.
- **The live markdown preview is correctly cross-origin** (localhost subprocess
  iframe, app.js:7858), which is the right isolation boundary; the dead in-app
  `markdown-preview.js` predates that and should be retired to avoid confusion
  (RVK-03).
- **Notebook execution is `AsyncFunction`/server-eval, gated behind explicit
  Run.** No auto-run on open, so opening a notebook file is not code execution —
  the eval power is the feature, not a vulnerability.
- **Stale-push handling is generally sound.** pdf-view's `_loadGeneration` token
  and jukebox's `embeddedArtFor` guard both correctly drop late async results
  for a superseded target — a good pattern the other async kinds follow.

## Test coverage

- **View *classes* are broadly untested** (expected: no jsdom; live DOM is the
  smoke test's job per `docs/CUSTOM-VIEWS.md` §9). Pure helpers *are* covered:
  `isPdfName`, `normaliseUrl`, audio/jukebox/image/media helpers,
  jmarkdown-scan, mermaid-scan, typeset-math, minimap geometry, notebook model.
- **Kinds with NO automated coverage of any kind** (not even helpers, or the
  helper tests don't touch the risky code): **pdf-view** (1509 lines — the
  find/highlight DOM surgery, hostile-PDF path — has only `isPdfName`),
  **directory-columns-view** (RVK-01 lives here, untested),
  **notebook-cells-view / -engine / -output** (only the *model* `notebook-cells`
  is tested), **shell-view**, **gnuplot-view**, **element-view**, **video-view**,
  **customize.js**, **hover-doc.js**, **bookmark-view** (the view; the outline is
  a separate tested file).
- **Highest-value gap:** pdf-view's find/highlight (`_highlightInPage`,
  `_wrapMatch`, `_wrapInSpan`) and page-text extraction are pure enough to unit
  test against a stub `PDFDocumentProxy`, and are the most intricate DOM logic in
  the area — worth a dedicated test.
- **RVK-02 is directly regression-testable** (a size-scaling assertion on
  `scanJmarkdown` with `==`-dense input would have caught the quadratic).

## What's solid

- **Directory views resist filename XSS** — every filename renders via
  `textContent`/`createTextNode`; symlink targets go in `title`; icon URLs are
  dictionary-bounded to the vendored Material set (`material-icons.js`). This is
  the classic trap and it's handled correctly.
- **Media kinds (audio/video/image/jukebox)** route every string through
  `textContent` and every source through host-built `media://`/`data:` URLs;
  **no renderer-side `createObjectURL`** anywhere in the area, so there is no
  object-URL revocation to leak. Teardown pauses + drops `src` + `load()`.
- **shell-view** is exemplary on lifecycle: `term.dispose()`,
  `ResizeObserver.disconnect()`, and both IPC unsubscribes in `destroy()`; the
  pty is reaped by `disposeKindView`. xterm 6.0.0 is current; the Cmd+C
  clipboard interception is scoped and doesn't remap Ctrl+C (SIGINT preserved).
- **pdf.js 5.7.284** with worker/cmap/wasm from `app://` (local), generation
  tokens guarding stale renders, and the doc torn down (`pdfDoc.destroy()`) so
  the worker frees memory. No `innerHTML` anywhere in pdf-view.
- **browser-view + main.js** get the popup story right: `allowpopups` surfaces
  window-opens, and `setWindowOpenHandler` denies all, loading only a
  user-clicked `foreground-tab` https link in the same webview; `partition` is a
  persistent isolated store; no `nodeintegration`/`preload` on the webview.
- **minimap** is the model for observer/timer hygiene: `bindTarget` tears down
  prior subs, `destroy` releases subs + ResizeObserver + rAF + edit timer + the
  body-parented flyout; repaint is debounced (60 ms), so there is **no
  per-keystroke repaint cliff**.
- **mermaid-scan** shows no catastrophic backtracking on hostile input (500 KB
  single line, 180 KB of arrows, 20 K nested brackets — all < 35 ms).
- **Display ownership** is respected everywhere in the area — the bug family that
  dominates `docs/VIEWS.md` is absent here.

## Open questions

1. **Is `markdown-preview.js` intended to survive?** It's dead (no call site) and
   its unsandboxed srcdoc + unsanitized marked (RVK-03) is a landmine. Delete, or
   sandbox + sanitize + comment "not the live path"?
2. **MathJax `safe` (RVK-05):** does the live math-preview/tooltip path actually
   render `\href`-produced anchors, and does clicking one navigate `javascript:`
   in this Electron build? A 2-line live check would settle CONFIRMED vs
   PLAUSIBLE. Regardless, loading the `safe` extension is cheap insurance.
3. **browser-view permissions (RVK-04):** should the in-app browser deny
   camera/mic/geolocation outright, or prompt? (Agent-7 to route, but it defines
   the kind's security contract.)
4. **jukebox kill semantics (RVK-07):** should `C-x k` on a playing jukebox stop
   playback (add a `disposeKindView` branch), matching audio/video, or is
   "keeps playing, stop via REPL" intended?
5. **Notebook auto-svg (RVK-06):** keep the `inspect()` string→`<svg>`→innerHTML
   convenience, or require explicit `Inspector.svg(...)`? Cheap to tighten while
   the notebook is still flag-off.

---

## Stats

- **Files in area:** ~60 (renderer/src minus agent-11's set); 16 read fully,
  the remainder swept.
- **Findings:** 13 — **P0: 0, P1: 0, P2: 5, P3: 8.**
- **By dimension:** Security 6 (RVK-03/04/05/06/11/12), Correctness/lifecycle 5
  (RVK-01/07/08/10 + perf RVK-02), Architecture/smell 1 (RVK-09), plus the
  cross-cutting perf finding (RVK-02).
- **Confidence:** CONFIRMED 8 (RVK-01/02/03/06(sink)/09/10/11 + RVK-04 gap),
  PLAUSIBLE 5 (RVK-05/07/08/12 + RVK-04 impact).
- **Benchmarks run:** scanJmarkdown (quadratic confirmed, 240 KB→1.5 s /
  1 MB→42 s), scanMermaid (no backtracking).
- **XSS-from-file-content reachable in production:** none confirmed.
- **Hostile-file crash/freeze on a normal path:** none (RVK-02 requires
  pathological `==`-dense input).
