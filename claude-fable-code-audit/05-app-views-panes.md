# app.js — views, tablines, panes & session-restore client — audit

**Date:** 2026-07-01 · **Auditor:** audit agent 5 of 13 · **Branch:** `main` @ `efe0fa6d` · **Read-only audit**

| Scope item | Covered |
|---|---|
| `apps/desktop/src/app.js` (9141 lines, read in full) | ✅ |
| `views[]` / `currentViewIndex` / `currentTextBuffer` bookkeeping (all touch points) | ✅ |
| `openFileByPath` + `visitFile` client arm (forceDuplicate, Q9 auto-duplicate) | ✅ |
| `switchToViewIndex` (both branches), `switchToView`, `activateTabInTabline` | ✅ |
| `mountTablineActiveChild` (orphan sweep, display loop, per-kind branches) | ✅ |
| `killViewAtIndex` end to end + close/kill path enumeration (server-buffer kill vs leak) | ✅ |
| `ensureTabElement` / `ensureEditorViewForLeaf` / `disposeKindView` per kind | ✅ |
| `hideInactiveSingletons` vs `hideInactiveRendererViews` — every call site vs ownership table | ✅ |
| SINGLETON_VIEWS residue | ✅ |
| Session-restore client arm (legacy `installRootPane` + Model-B reconcile, seed splice, ephemeral kinds, durable ids) | ✅ |
| Focus machinery (`setCurrentPaneId` single-entry, `focusPaneFromEvent` capture) | ✅ |
| Tabline state lifecycle (`tablineStateByView`), pane DOM mirror (`paneElements`), modeline discipline | ✅ |
| Dock/utility interplay, configure* factories | ✅ |
| Cross-referenced: `packages/renderer/src/tabline.js`, `packages/pane/src/pane.js`, `packages/view/src/view.js`, `apps/desktop/src/server-view-client.js`, `apps/desktop/mwb/client-buffer.js`, `apps/desktop/mwb/pane-model.js` (targeted), `apps/desktop/mwb/spine.js` (close-tab/visitFile arms only), `apps/desktop/src/session.js`, `apps/desktop/src/main.js` (quit arm only), `apps/desktop/mwb/pane-view-client.js` (harness-only, confirmed non-production) | ✅ |

**Context that frames everything below:** `preload.mjs:20` hardcodes `serverMode: true`. Model B is the only mode. That makes roughly half of app.js's view machinery — the paths `docs/VIEWS.md` documents as "Key flows" (`openFileByPath`, `openFileInteractive`, `killViewAtIndex`, `switchToView`, the placeholder/split stack, `installRootPane`/`wrapRootInTabline`, the recovery view) — **unreachable dead code**, while the live display pipeline is the server reconcile (`applyServerPaneTree` → `reconcileServerPaneTree` → `buildServerPaneNode` → `buildServerLeafTabline`), which `docs/VIEWS.md` does not describe at all. The audit grades live-path bugs at full severity and dead-path hazards as latent (P3).

---

## Executive summary (worst first)

1. **APPV-01 (P1, CONFIRMED trace):** Closing a media or browser **tab** in server mode never destroys its per-tab element. `disposeBrowserElementForView` only consults `browserElementByView`, but tab elements live in the tabline's `editorByChild`; plain media (pdf/image/audio/video) tabs have **no** dispose path at all. A closed audio tab keeps playing with no UI; a closed browser tab keeps its `<webview>` guest process alive (hidden — including any page audio); pdf/video tabs leak their decoded resources. Only shell/gnuplot tabs are reaped correctly (`reapProcView` is the one function that walks `editorByChild`).
2. **APPV-02 (P1, CONFIRMED):** The known tab-close server-buffer leak. On main, a server-buffer tab shown through a tab strip whose tabline lacks `_serverLeafTabline` falls to the renderer-only `removeTabInTabline` branch — the spine buffer survives (piles up in the buffer list) and the tab resurrects on the next PANE_TREE push. The fix exists **unmerged** on branch `tabclose-kill-server-buffer` (`b74fa210`). Full kill-vs-leak path enumeration below.
3. **APPV-03 (P1, PLAUSIBLE — data-safety):** Native Quit (Cmd+Q / app-menu, via `before-quit` → `app:confirm-quit` → `quitInteractive`) checks **renderer-side** `dirtyBuffers`, which is empty/meaningless under Model B — so the spine's `quit-editor` save-some-buffers walk is bypassed and unsaved server-side edits get **no save prompt** on native quit (mitigated only by the spine's autosave).
4. **APPV-04 (P2, CONFIRMED trace):** A pane **click** (`setCurrentPaneId`) re-arms the renderer dirty/autosave watch on a server `ClientBuffer` mirror — the mirror has no saved-baseline, so it becomes *permanently* dirty, producing spurious "Discard unsaved changes?" quit confirms and renderer-side recovery snapshots of server-owned buffers. This is the same wrong-store problem as APPV-03, in the opposite direction.
5. **APPV-05 (P2, CONFIRMED trace):** Help/Apropos dock **cross-links** route through the legacy `showDocInPane` → `switchToViewIndex`, which pushes a renderer-local doc view into a **server-owned** tabline's tabs: a ghost tab that never activates and vanishes on the next reconcile, plus an unbounded `views[]` leak.
6. A cluster of P2s in the reconcile: leaked math-preview controllers, stale `editorView`/hover-doc in bare-leaf windows, focus-stealing re-mounts, single-element theft when the same media source occupies two leaves, pdf directives that only reach the singleton.
7. The dead legacy stack carries latent Q9 violations (`openFileInteractive`, `switchToView`) that will bite anyone who revives it; `docs/VIEWS.md` has drifted materially from the code (details in the invariant table).

No XSS found: every user-controlled string that reaches the DOM in this territory (tab labels, modeline, titles, picker rows, view-list cells) goes through `textContent`; `displayDocPanel` escapes its heading.

---

## Findings

### APPV-01: Closing a media/browser tab leaks its live element — audio keeps playing, webview guest survives

- **Severity:** P1
- **Dimension:** Correctness & data safety (resource lifecycle, user-audible misbehaviour)
- **Location:** `apps/desktop/src/app.js` — `reconcileServerPaneTree` prune loops (`app.js:3286–3323`), `disposeBrowserElementForView` (`app.js:5203–5209`), `ensureTabElement` (`app.js:6993–7011`), `reapProcView` (`app.js:3192–3212`, the correct pattern that everything else lacks)
- **Evidence:**
  - A media/browser **tab** gets its element from `ensureTabElement`'s generic branch (`app.js:6993–6998`): a fresh `<pdf-view>`/`<audio-view>`/`<browser-view>` registered **only** in `state.editorByChild`.
  - When the source closes (tab `×` → spine `close-tab`, which **kills by default** on main via `*close-tab-kills-view*`, `spine.js:5540–5595`; or `C-x k` / View-List trash), the next PANE_TREE excludes it:
    - image/pdf/audio/video: the `serverMediaViews` prune (`app.js:3286–3304`) does `serverMediaViews.delete(id)` and **nothing else** — no element destroy, no `editorByChild` removal.
    - browser: the reap loop (`app.js:3318–3323`) calls `disposeBrowserElementForView(v)`, which looks up `browserElementByView.get(view)` → **miss** for a tab-born element (only `ensureBrowserElementForView`, the bare-leaf path, populates that map) → silently returns.
    - shell/gnuplot: `reapProcView` (`app.js:3192–3212`) explicitly walks every `tablineStateByView` entry's `editorByChild`, destroys the element, and kills the child. **This asymmetry is the bug**: procs got the treatment; media and browsers did not.
  - The leaked element stays parented in `.tabline-content` with `display:none` (the display loop hides it because its view key is no longer the active child, `app.js:7077–7079`), and stays in `editorByChild` forever, so the orphan sweep (`app.js:7068–7075`) protects it (it *is* known).
  - `<audio-view>` pauses only in `destroy()` (`audio-view.js:644–649`); `display:none` does not pause an `<audio>` element. A hidden `<webview>` keeps its guest process (and any page audio) running; `browser-view.js` tears the guest down only in `destroy()` (`browser-view.js:151`).
- **Failure scenario (concrete):** Open an mp3 (it plays as a tab in the tabline). Click the tab's `×`. The tab disappears, the spine buffer is killed — and **the music keeps playing** with no visible view and no way to stop it short of quitting. Equivalent: close a browser tab while YouTube plays → hidden guest keeps playing audio. Repeatedly opening/closing PDFs leaks a full PDF.js document per close.
- **Fix direction:** Give the media prune and the browser reap the `reapProcView` shape: when a source id leaves `shownMedia`/`serverLiveBrowsers`, walk `tablineStateByView` for `editorByChild.get(view)`, `destroy()` + `remove()` + delete the map entry (and keep the existing bare-leaf disposals). Alternatively factor a single `disposeServerSourceElement(view)` used by all three loops.
- **Confidence:** CONFIRMED (every dispose path in the file enumerated; the audible behaviour itself should be live-verified once, but no code path destroys these elements).

### APPV-02: Tab close on a non-flagged strip leaves the spine buffer alive (known bug; fix unmerged)

- **Severity:** P1
- **Dimension:** Correctness (state leak; ghost tabs)
- **Location:** `apps/desktop/src/app.js:6787–6791` (the tabline `onClose` else branch); fix on unmerged branch `tabclose-kill-server-buffer` (`b74fa210`)
- **Evidence:** `onClose` routes to the server only when `view._serverLeafTabline` is set (`app.js:6776–6786`). A server façade/proxy tab reached through a strip **without** that flag (the architect's live repro: project-window central tabline) falls through to `views.indexOf(target)` → `-1` (server tabs are never in `views[]`) → `removeTabInTabline(view, i)` — a renderer-only splice. The spine never hears about the close: the buffer stays in the registry (piles up in `C-x C-b`) and the next PANE_TREE reconcile **resurrects the tab** (the wire tabs still include it). The unmerged commit adds exactly the missing arm: resolve `target === serverFacadeView ? currentBufferId() : target._serverBufferId` and route to `serverViewClient.closeBuffer(serverId)`.
- **Kill-vs-leak enumeration for current main** (the requested inventory):

  | Close path | What happens to the server buffer | Client element |
  |---|---|---|
  | Tab `×` / middle-click, `_serverLeafTabline` strip | **KILLED** — `close-tab` intent → spine kills by default (`*close-tab-kills-view*` ≠ #f, `spine.js:5546–5549`, commit `38527663` on main); last-tab case collapses to a bare `*scratch*` (`spine.js:5566–5585`) | text: rebound (OK); **media/browser: leaked (APPV-01)**; proc: reaped |
  | Tab `×`, strip **without** the flag (project-window regression) | **LEAKED** — renderer-only `removeTabInTabline`; tab resurrects on next push | element destroyed locally (only the buffer leaks) |
  | `C-x k` (typed) | **KILLED** — server `kill-buffer` | same per-kind story as row 1 |
  | View-List trash icon | **KILLED** — `serverViewClient.closeBuffer(id)` = `switchBuffer(id); sendKey('C-x'); sendKey('k')` (`server-view-client.js:779–784`) | same |
  | `killViewAtIndex` (legacy full kill incl. `disposeKindView`) | n/a — unreachable in server mode (no live caller resolves a server tab to a `views[]` index) | n/a |

- **Failure scenario:** In a project window, close file tabs in the central tabline: tabs drop but buffers accumulate; `*scratch*` leaves get minted; buffer list grows unboundedly.
- **Fix direction:** Merge `tabclose-kill-server-buffer` (it is exactly the else-branch guard). Consider also *diagnosing why* a server tabline renders without `_serverLeafTabline` in project windows — `buildServerLeafTabline` always sets it, so there is a second mount path in play (worth one debugging session; the unmerged fix is correct regardless because it makes `onClose` id-driven rather than flag-driven).
- **Confidence:** CONFIRMED (bug live-diagnosed by the architect per the fix commit message; main verified to lack `b74fa210` via `git merge-base --is-ancestor`).

### APPV-03: Native Quit consults renderer `dirtyBuffers` — the spine's save-some-buffers walk is bypassed

- **Severity:** P1 (data-safety; loss depends on spine autosave, hence PLAUSIBLE)
- **Dimension:** Correctness & data safety
- **Location:** `apps/desktop/src/app.js:2198–2207` (`quitInteractive`), `app.js:7983–7987` (`onConfirmQuit` wiring), `apps/desktop/src/main.js:502–510` (`before-quit` → `app:confirm-quit`); contrast `spine.js:3268–3336` (`quit-editor`, the real cross-window unsaved walk) and `app.js:3667–3671` (the `quit` directive path that correctly skips the re-check)
- **Evidence:** `quitInteractive` gates on `dirtyBuffers.size`. Under Model B the renderer's dirty tracking is deliberately disconnected from the real buffers (`onServerBuffer` does a **bare** `currentTextBuffer = mirror` at `app.js:3978` specifically to keep the watch off the mirror). So on the native-quit path `dirtyBuffers.size === 0` regardless of real unsaved state → no confirm → `performShutdown()` → `host.quit()`. The keyboard path (`C-x C-c`) is fine: it routes to the spine's `quit-editor`, which runs the per-buffer y/n/!/q walk and then sends the `quit` directive. The native path skips all of that.
- **Failure scenario:** Edit a file, don't save, hit **Cmd+Q** (or app-menu Quit). No save prompt; the app exits. Recovery of the edit depends entirely on the spine's autosave snapshots.
- **Fix direction:** In server mode `quitInteractive` should not consult renderer state at all — route the native quit through the server (`serverViewClient.runCommand('quit-editor')` or a dedicated intent) so the same walk runs, with `performShutdown` reached only via the `quit` directive. (Overlap note: agent 4 owns the directive/boot seam; the *root cause* here is view-territory bookkeeping — the wrong dirty store.)
- **Confidence:** PLAUSIBLE for actual data loss (spine autosave exists — `mwb/autosave.js`); CONFIRMED that the walk is bypassed.

### APPV-04: `setCurrentPaneId` re-arms the dirty/autosave watch on server mirrors (permanent phantom dirty)

- **Severity:** P2
- **Dimension:** Correctness (state pollution → spurious dialogs, wasted disk churn)
- **Location:** `apps/desktop/src/app.js:824–831` (`setCurrentPaneId` text branch → `setCurrentTextBuffer`), `app.js:489–524` (`setCurrentTextBuffer`/`watchCurrentBuffer` dirty marking), `mwb/client-buffer.js:126–130` (mirror emits the same `{change, point, mark}` event shape as a real L2 buffer)
- **Evidence:** Click a text pane in a split (normal Model-B use): `focusPaneFromEvent` → `setCurrentPaneId` → peeled view is a server-backed text view whose `buffer` is the shared mirror or a static `ClientBuffer` → `setCurrentTextBuffer(view.buffer)` → `watchCurrentBuffer()` subscribes. Every server-echoed DELTA then fires the change listener; `bufferMatchesSaved(mirror)` is always false (no `markBufferSaved` ever runs for mirrors, `app.js:277–284`) → `dirtyBuffers.add(mirror)` + `recovery.save()`. The mirror can never be un-dirtied (saving happens server-side; the baseline never updates).
- **Failure scenario:** Split the window, click between panes, type, save everything, Cmd+Q → **"Discard unsaved changes in 1 buffer(s)?"** for work that is fully saved. Meanwhile the renderer recovery controller snapshots server-buffer text on every edit (pure churn: the server-mode boot never scans/offers renderer snapshots, `app.js:9124–9130`).
- **Fix direction:** In `setCurrentPaneId`, skip `setCurrentTextBuffer`/`bindCursor` for `isServerBackedView(view)` (mirror the `applyTextMountSideEffects` early-return at `app.js:6421`); keep the bare `currentTextBuffer = mirror` assignment for the readers that need it (`tree-sitter-query`, preview sync).
- **Confidence:** CONFIRMED (traced end to end: click → subscribe → DELTA emit → dirty add; both consumers of `dirtyBuffers` affected).

### APPV-05: Help/Apropos cross-links push a renderer-local doc view into a server tabline (ghost tab + `views[]` leak)

- **Severity:** P2
- **Dimension:** Correctness / architecture (legacy path mutating server-owned structure)
- **Location:** `apps/desktop/src/app.js:2360–2365` (`createDocPanel({ openDoc: openDocInPane })`), `app.js:5752–5769` (`showDocInPane`), `app.js:1591–1605` (`switchToViewIndex` tabline branch pushes into `tlv.tabs`), `app.js:7202–7210` (`activateTabInTabline` server arm can't resolve it)
- **Evidence:** `C-h k`/`C-h f`/`C-h a` render into the utility dock via `displayDocPanel`; a `[data-jmacs-doc]` cross-link in that panel calls `openDocInPane(name)` → `showDocInPane` → `views.push(docView)` + `switchToViewIndex(views.length - 1)`. The focused leaf's view is a `_serverLeafTabline` tabline, so the tabline branch **pushes the local doc view into the server tabline's `tabs`** and calls `activateTabInTabline`, whose server arm finds no `_serverBufferId` → sends only a `focus-pane` intent and returns (never activates, never mounts). `notifyViewsChanged` → `refreshPaneTabStrips` renders the ghost tab; the next PANE_TREE reconcile rebuilds `tlv.tabs` from the wire and the ghost evaporates. The doc view stays in `views[]` forever (nothing in server mode can kill it); a second link click hits the `cur.kind === 'doc'` branch and silently updates the invisible view.
- **Failure scenario:** `C-h f describe-key`, click any cross-reference link in the Help tab → a tab flashes into the strip, cannot be selected, disappears on the next layout push; the doc never opens; repeat = one leaked view per click.
- **Fix direction:** In server mode route panel cross-links through the existing server path — `serverViewClient.docOpen(name)` (`server-view-client.js:892–898`), exactly as `hoverDoc.openDoc` already does (`app.js:7391–7393`). `showDocInPane`/`openDocInPane` should refuse (or delegate) when `serverViewClient` exists.
- **Confidence:** CONFIRMED (static trace; behaviour worth one live confirmation).

### APPV-06: Same media/browser/proc source in two leaves → one element gets stolen, a pane renders blank

- **Severity:** P2
- **Dimension:** Correctness (Q9 at the element level, server path)
- **Location:** `apps/desktop/src/app.js:2861` (`buildServerMediaView` keyed by `bufferId` → one view object shared by every leaf showing that source), `app.js:5643` (`ensureProcViewElement` re-parents), `app.js:5175` (`ensureBrowserElementForView` re-parents), `app.js:6593–6598` (`mountKindView` singleton re-parent)
- **Evidence:** The spine's `split` copies the focused leaf's buffer into the new leaf (`pane-model.js:273–289`). If the focused leaf is a media/browser/proc data-source, both wire leaves carry the same `bufferId`/`viewKind` → `buildServerPaneNode` gives both leaves the **same cached view object** → the mount loop mounts leaf 1's element, then leaf 2's mount **re-parents the same element** (per-instance maps are keyed by view; the singleton branch re-parents the one singleton). The first pane is left empty. For a browser this also re-creates the `<webview>` guest (documented at `app.js:5158–5165`), resetting the page.
- **Failure scenario:** Focus a PDF (or browser/shell) pane, `C-x 2` → two panes, one blank; the blank one re-steals the element on the next reconcile ordering change, so which pane is blank can flip.
- **Fix direction:** Either the spine refuses to split a data-source leaf (cheapest), or the client keys media elements by `(leafId, sourceId)` the way `serverLeafActiveTabViews` already keys text tabs by leaf.
- **Confidence:** PLAUSIBLE (code trace is complete; not live-verified whether the spine permits splitting a media-focused leaf).

### APPV-07: Math-preview controllers (and typeset caches) leak across reconciles and tab closes

- **Severity:** P2
- **Dimension:** Correctness (unbounded memory growth on a live path)
- **Location:** `apps/desktop/src/app.js:3347–3354` (reconcile's editor-instance sweep — destroys instances but never calls `disposeMathPreviewForLeaf`), `app.js:4317` (`mathPreviewByPaneId`), `app.js:4715–4722` (`disposeEditorViewForLeaf` — the legacy path that *does* clean up, not used by the reconcile), `app.js:6983` (tab elements register controllers keyed by the child view object; no dispose on tab close)
- **Evidence:** `mathPreviewByPaneId` is keyed by leaf id (leaf-direct) or by the per-tab view object (`getMathReplacedRanges({ id: child, ... })`). The reconcile tears down vanished leaves' `<text-view>`s inline (`inst.destroy(); editorViewByPaneId.delete(id)`) without touching `mathPreviewByPaneId`; server-side tab closes never call `removeTabInTabline`/`disposeMathPreviewForLeaf` either. Each controller pins a MathJax typeset cache.
- **Failure scenario:** Work in a `.tex`/`.jmd` buffer with math-preview on, split and unsplit panes (C-x 2 / C-x 0) or open/close tabs over a session — one controller + cache per dead leaf id / closed tab accrues for the window's lifetime.
- **Fix direction:** In the reconcile's `liveIds` sweep, call `disposeMathPreviewForLeaf({ id })` alongside the instance destroy; in the tab-close disposal added for APPV-01, dispose the per-tab controller too (keyed by the view object).
- **Confidence:** CONFIRMED (no dispose path exists for those keys; growth is unbounded but slow).

### APPV-08: `editorView` / hover-doc go stale in bare-leaf server windows — fold/recenter/flash directives hit a destroyed element

- **Severity:** P2
- **Dimension:** Correctness / architecture (stale cached reference — the `currentTextBuffer`-family bug shape)
- **Location:** `apps/desktop/src/app.js:4728–4731` (boot `editorView`), `app.js:3347–3354` (reconcile destroys the boot instance when local `pane-leaf-…` ids vanish), `app.js:3427–3431` (bare text-leaf branch never reassigns `editorView`), directive consumers `app.js:3695–3710` (`recenter-current-line`, `flash-current-line`), `app.js:3904–3910` (`fold-toggle`/`fold-all`/`unfold-all`), `app.js:7879–7888` (`toggleMarkdownPreview` focus)
- **Evidence:** `editorView` is reassigned only by `setCurrentPaneId` (`app.js:838–841`) and `applyTextMountSideEffects` (`app.js:6423–6444`). The reconcile path for a **bare** text leaf (fresh `C-x 5 2` window: `windowKind 'single'`, one scratch pane, no tabline yet) calls `ensureEditorViewForLeaf` + `repointServerTextEl` only — so after the first PANE_TREE replaces the boot leaf (local id) with a server-id leaf, the boot instance is destroyed and `editorView` dangles. Tabline windows are fine (the text-tab mount reassigns it). Same story for `hoverDoc.setEditorEl` (only rebound in the tabline text branch, `app.js:6443`): hover-doc is dead in bare-leaf windows.
- **Failure scenario:** `C-x 5 2`, open a `.tex` file (still a bare leaf), `C-c C-p`-style fold/`markdown-preview-sync`/SyncTeX inverse search → the directive calls `editorView.recenter()`/`toggleFoldAtPoint()` on a destroyed `<text-view>` (TextView.destroy nulls the inner editor): silent no-op or throw into the fault reporter. Hover documentation never appears in that window.
- **Fix direction:** Make the directive handlers resolve the focused element dynamically (`focusedServerLeafElement()` already exists at `app.js:3014–3027` and is exactly this) instead of the `editorView` module global; or reassign `editorView`/`hoverDoc` in the reconcile's bare-text branch.
- **Confidence:** CONFIRMED for the stale pointer; PLAUSIBLE for user impact severity (depends how often fold/synctex/preview run in not-yet-tabbed windows).

### APPV-09: Reconcile focus discipline — unconditional `focus()` during mounts can steal the minibuffer's focus

- **Severity:** P2
- **Dimension:** Correctness (focus/keyboard routing)
- **Location:** `apps/desktop/src/app.js:6444` (`applyTextMountSideEffects` server-backed branch: `instance.focus()` unconditionally), `app.js:3421–3426` (bare-media mount computes `focus` but deliberately leaves media "always-focus"), contrast the guarded restore at `app.js:3458–3463` (only refocuses when `document.activeElement` is `<body>` — the author knew stealing was a hazard)
- **Evidence:** Every PANE_TREE reconcile of a tabline leaf runs `mountTablineActiveChild` → text branch → `applyTextMountSideEffects(child, tv)` → `instance.focus()`. PANE_TREE pushes are not only user-initiated: a bookmark/customize `setState` fan-out re-pushes (`spine.js:752`), and multi-window edits re-push to every window showing the buffer. If a minibuffer prompt (or the REPL input) holds focus when such a push lands, the text view yanks it; typed prompt text starts going to the editor. Similarly a **non-focused** bare media pane re-mounting calls `el.focus()` (`focus` stays true for media kinds), pulling keyboard focus into e.g. a side PDF on an unrelated structural push.
- **Failure scenario:** Window A has a find-file prompt open; window B (same buffer visible in A) triggers a bookmark set (`C-x r m`) → A reconciles → A's active text tab steals focus from A's minibuffer mid-typing.
- **Fix direction:** Thread the same `focus: leaf.id === currentPaneId && !minibuffer.isOpen()` context the media branches already partially honour into `applyTextMountSideEffects` (or gate the `instance.focus()` on `document.activeElement` being body/the pane, mirroring `app.js:3458`). Drop the media "always-focus" exemption for non-focused leaves.
- **Confidence:** PLAUSIBLE (multi-window/fan-out timing; single-window repro likely possible via bookmark ops with the dock REPL focused).

### APPV-10: `pdf-reload` / `pdf-synctex-show` directives only reach the pdf **singleton** — tabbed PDFs never refresh

- **Severity:** P2 (P3 if tabbed PDFs are rare in latex flows)
- **Dimension:** Correctness / architecture (singleton residue vs per-instance reality)
- **Location:** `apps/desktop/src/app.js:3809–3821` (`pdf-reload` reads `pdfView.buffer`), `app.js:3822–3840` (`pdf-synctex-show` same), vs `ensureTabElement` (`app.js:6993–6998`, per-tab `<pdf-view>` instances)
- **Evidence:** A PDF opened as a bare pane mounts the `pdfView` singleton (`mountKindView` default branch), so latex-view's split-output flow works. A PDF living as a **tabline tab** has its own `<pdf-view>` element in `editorByChild`; the directives still consult only the singleton (`pdfView.buffer` — stale or null), so a recompile's reload and forward-SyncTeX highlight silently miss it.
- **Failure scenario:** Drag your latex output PDF into the main tabline (or open a PDF that lands as a tab), recompile — the tab keeps showing stale pages; `C-c C-v` does nothing.
- **Fix direction:** Resolve the target through `elementForViewInstance` over the media view for the wanted path (it already searches `editorByChild` first, `app.js:7147–7167`), or iterate all mounted pdf elements matching the path.
- **Confidence:** CONFIRMED for the code shape; PLAUSIBLE for how often the tabbed configuration occurs.

### APPV-11: `performShutdown` posts `SESSION_SAVE` and then quits — ordering is "give it time", not a guarantee

- **Severity:** P3 (data-safety adjacent)
- **Dimension:** Correctness & data safety
- **Location:** `apps/desktop/src/app.js:2224–2244` (`performShutdown`)
- **Evidence:** The named-workspace save is `godotServerPort.postMessage({ type: MSG.SESSION_SAVE, label })` followed by `await flushAllMetadata(); await recovery.clear(); window.host.quit()`. The comment itself says the awaits "give the server time to do its synchronous save before it's torn down". Port delivery to the utilityProcess plus the spine's write racing app teardown is unbounded in principle; a slow disk or an early `will-quit` teardown loses the named workspace (the `__last__` auto-snapshot softens this).
- **Fix direction:** Make SESSION_SAVE request/ack (the client already has the reqId/promise pattern — `replEval` et al.) and await the ack (with a short timeout) before `host.quit()`.
- **Confidence:** PLAUSIBLE (no observed failure; race by construction).

### APPV-12: Renderer/server pane-id namespaces can collide (no `bumpIdCounterPast` on wire ids)

- **Severity:** P3 (latent — every current colliding path is dead code)
- **Dimension:** Architecture & consistency
- **Location:** `apps/desktop/src/app.js:3214–3247` (`buildServerPaneNode` adopts wire ids verbatim), `packages/pane/src/pane.js:30–53` (both realms mint `pane-leaf-N` from independent counters; `bumpIdCounterPast` exists for exactly this), legacy `buildRestoredPaneTree` does call it (`app.js:8363, 8374`)
- **Evidence:** The spine's pane-model runs `@editor/pane` in its own process realm; its ids (`pane-leaf-7`…) arrive over the wire and are installed verbatim. The renderer's own counter sits at ~2 (only the boot leaf minted). Any renderer-side `createLeafPane()` without an explicit id (today: `openNoFocusViewInSplit`, `splitPaneAtLeaf*`, `attachMinimapBesideLeaf`, project layouts — all dead or gated off in server mode) would mint `pane-leaf-2`, potentially equal to a live server leaf id → `paneElements` (a Map keyed by id) aliases two leaves to one div; `computeRects` (also id-keyed) drops one rect.
- **Fix direction:** One line in `buildServerPaneNode`'s leaf/split arms: `bumpIdCounterPast(wire.id)`. Cheap insurance for the next feature that mints a client-side companion pane.
- **Confidence:** CONFIRMED as a latent landmine; no live trigger today.

### APPV-13: Dead legacy view machinery, with latent Q9 violations inside it

- **Severity:** P3
- **Dimension:** Architecture & consistency (dead code) + latent correctness
- **Location / evidence:**
  - **Unreachable under `serverMode:true` (verified by caller graph):** `openFileInteractive` (only caller: placeholder `o` action), the whole placeholder/split stack (`splitPaneAtLeaf`, `splitPaneAtLeafWith`, `splitAndOpenFile`, `openNoFocusViewInSplit` — **zero callers**; the `paneHost`/`viewHost` objects they served no longer exist, only stale comments at `app.js:243, 853, 1182, 5857`), `killViewAtIndex` (all live close paths route server-side), `switchToView`, `openCustomize`, `openFileInTabAdjacent` (zero callers), `openFileByPath` (restore + tree-open both rerouted; `sessionOptions.openByPath` only runs in the skipped legacy restore), `wrapRootInTabline`, `installRootPane`+`buildRestoredPaneTree`+`materialiseRestoredView`, `recoverSnapshot`/`openRecoverView` (server mode skips the scan), `openProject`/`closeProject` (superseded by `requestOpenProject`), `toggleMinimapForFocusedLeaf` (self-gated), `serverChrome.requestQuit` (nothing in `server-view-client.js` invokes it — only a test fake).
  - **Latent Q9 bugs preserved in that dead code**, which will bite anyone reviving it:
    - `openFileInteractive` (`app.js:1883–1905`): its `showingElsewhere` check tests only `leaf.view === existingView` — it **misses tabline tabs**, the exact gap `openFileByPath` fixed (`app.js:2081–2095`, "The latter case was previously missed"). Reviving the dialog path re-ships close-one-closes-both.
    - `switchToView` (`app.js:1647–1667`): refuses only when the target is the *active* view elsewhere; a **background tab** in another tabline is not refused, so the tabline branch of `switchToViewIndex` would push the same View object into a second `tabs[]` — the Bug-2 identity violation.
    - `openFileByPath` leaf-direct repeat-open (`app.js:2096–2126`): the duplicate-reuse check (`existingDup`) only runs when the focused pane is a tabline; a leaf-direct focused pane re-opening a file that is shown elsewhere mints a fresh dup per call, orphaning the previous dup in `views[]`.
    - `killViewAtIndex` wasCurrent branch B (`app.js:1798–1803`): if entered without an auto-collapse (a `currentViewIndex`≠focused-pane desync at entry), `currentViewIndex` is left un-fixed after the splice (the 9/7 shape). Unreachable from current callers (capture-phase focus makes the closed tab's pane focused first), but the branch trusts a precondition it doesn't check.
    - `removeViewFromAllTablines` (`app.js:1673–1690`): pushes an `emptied` record even for a tabline that was **already** empty before the kill, and an emptied *nested* tabline collapses the whole outer leaf via `deletePaneInTree` rather than removing the nested tabline from its parent's tabs (Q10 edge).
- **Fix direction:** A deliberate teardown pass (the B5–B7 audit style): delete or `@deprecated`-fence the dead stack, keeping only what the reconcile reuses (tabline machinery, `mountKindView`, hide-family, pane DOM). Until then, treat the Q9 gaps above as the checklist for any revival.
- **Confidence:** CONFIRMED (caller graphs grepped; `serverMode: true` hardcoded in `preload.mjs:20`).

### APPV-14: SINGLETON_VIEWS residue — what is still needed vs vestigial

- **Severity:** P3
- **Dimension:** Architecture & consistency
- **Location:** `apps/desktop/src/app.js:6387–6402` (the list), `app.js:6896–6923` (`perKindConfigureFactory` — **duplicate `case 'customize'`** at 6898 and 6920, second unreachable)
- **Evidence / inventory (server-mode reality):**
  - **Still load-bearing** (bare data-source panes mount via `mountKindView`'s default singleton branch): `pdf`, `image`, `audio`, `video`, `jukebox`, `customize`, `directory-tree`, `directory-columns`, `view-list`. Note this means at most **one bare pane per kind per window** (a second same-kind bare pane steals the singleton — APPV-06's sibling).
  - **Vestigial in server mode:** `shell` and `gnuplot` singletons (server proc views are `_serverMedia` → per-instance `ensureProcViewElement`; the singletons plus their `releasesBuffer` flags only toggle a detached element), `recover` (scan skipped), `bookmark` (server outlines are per-instance via `bookmarkElementByView`).
  - `hideInactiveSingletons` remains the correct single owner for singleton visibility and is correctly the only display-state function the tabline mount calls (see the invariant table). The docs' claim that `browser` is in SINGLETON_VIEWS is wrong (it is per-instance; the list's own comment says so).
- **Fix direction:** Trim the vestigial entries when the dead-code pass (APPV-13) runs; delete the duplicate `customize` case now (one-liner).
- **Confidence:** CONFIRMED.

### APPV-15: Assorted small leaks and stale comments (live paths)

- **Severity:** P3
- **Dimension:** Correctness (slow leaks) / consistency
- **Evidence:**
  - `serverTabProxies` (`app.js:2630`) is never pruned — one proxy object per ever-seen buffer id for the window's lifetime (tiny records; unbounded count).
  - Nested-tabline disposal is non-recursive: `disposeTablineKind` (`app.js:7313–7329`) destroys the child *elements* but leaves a nested tabline's own `tablineStateByView` entry behind (legacy-only shape).
  - `onClose`'s comment (`app.js:6772–6775`) still says close-tab "un-curates … NOT a global kill" — stale since `38527663` made kill the default; the JSDoc on `focusPaneFromEvent` (`app.js:716–720`) says "Runs on the bubble (no capture)" while registration is capture-phase (`app.js:751–752`; the registration-site comment and docs/VIEWS.md are correct — the function JSDoc is the stale one).
  - `onSnapshot` (`server-view-client.js:462–493`) rebuilds the mirror object even for a same-buffer snapshot, forcing a follow-cursor reveal through `repointServerTextEl` (the `sameBuffer` scroll-preserve can't match a brand-new object). Only visible if the spine ever re-snapshots without switching.
- **Fix direction:** prune proxies against BUFFER_LIST; recurse dispose; refresh the two comments; reuse the mirror on same-id snapshots.
- **Confidence:** CONFIRMED.

---

## Architecture observations

**The reconcile is the real view system now, and it is undocumented.** `docs/VIEWS.md` — the designated invariant catalogue — documents the legacy world. The live pipeline (`serverPaneTreeWire` → `buildServerPaneNode` → per-leaf-keyed stable tab views → `mountTablineActiveChild` reuse) is a genuinely good design (stable identities per leaf id / source id, scroll-preserving repoints, hide-not-kill for procs/browsers), but its invariants exist only as inline comments. The bug families found here (APPV-01/02/06) are all *ownership/lifecycle* gaps in the seams between the new maps (`serverMediaViews`, `serverLeafTablines`, `serverTabProxies`, `serverLeafActiveTabViews`) and the old ones (`editorByChild`, `browserElementByView`, `SINGLETON_VIEWS`) — exactly the kind of thing the VIEWS.md ownership table exists to prevent. It needs a "Model-B reconcile" chapter with its own ownership table: *which map owns which element's lifetime, and which loop is allowed to dispose it.*

**Dispose asymmetry is the systemic defect.** There are now **five** element registries (`editorByChild` per tabline, `browserElementByView`, `procViewElementByView`, `serverMediaViews`(+`elementHostByView`, `docElementByView`, `bookmarkElementByView`, `minimapElementByView`), `SINGLETON_VIEWS`) and **three** independent close signals (PANE_TREE shape, `serverLiveProcs`, `serverLiveBrowsers`). Only procs have a disposer that spans registries. A single `disposeElementsForSource(sourceId)` that consults every registry would eliminate the whole APPV-01 family structurally.

**Focus state has two owners by design, but three in practice.** The server owns logical focus (wire `focused` → `currentPaneId` in the reconcile); `setCurrentPaneId` owns click-driven focus; but `applyTextMountSideEffects` and the media mount branches *also* mutate DOM focus as a side effect of rendering (APPV-09). Rendering should not move the keyboard.

### Invariant-by-invariant verdict (docs/VIEWS.md catalogue vs current main)

| # | VIEWS.md invariant / claim | Verdict |
|---|---|---|
| 1 | Q9 identity — no same View object in two visible positions; `views.indexOf`/`tabs.indexOf` reference-equality | **HOLDS** in `openFileByPath` (incl. the tabline-tab detection + focused-tabline dup reuse); **VIOLATED-AT** (latent, dead code) `openFileInteractive:1883` and `switchToView:1647` (background-tab gap); **VIOLATED-AT** (live, element level) same-source-in-two-leaves in the server path (APPV-06). Server proxies intentionally share one object across strips — benign today because proxies are label-only and all mutation is id-routed, but it is an undocumented exception to Q9 |
| 2 | Every `views.splice` fixes `currentViewIndex` in the same step | **HOLDS** — all three splice sites (`splicePlaceholderFromViews:1033–1040`, `killViewAtIndex:1728`+branches, seed-splice `9083–9095` incl. the defensive clamp). Branch-B edge noted in APPV-13 |
| 3 | Display-state single owner: per-tab = mount display loop; leaf-direct = switch path; singletons = `hideInactiveSingletons` | **HOLDS** — `hideInactiveRendererViews` is called only from the four focused-leaf-changed paths (1016, 1120, 1284, 1632); `mountTablineActiveChild` uses only `hideInactiveSingletons` (7090, 7100, 7128); all leaf-direct queries are `:scope > text-view` (1509, 1528); no out-of-owner `style.display` pokes found on live paths (`openNoFocusViewInSplit:1161` pokes but is dead) |
| 4 | Tabline ring-fence in `killViewAtIndex` wasCurrent | **HOLDS** (code matches the doc exactly, incl. the root-scratch substitution) — but the whole function is unreachable in Model B |
| 5 | Strip refresh detaches tabs mid-event → click logic must be capture-phase | **HOLDS** — `tabline.js:65` `replaceChildren()`; `focusPaneFromEvent` registered capture (`app.js:751–752`). The function's own JSDoc contradicts it (stale, APPV-15) |
| 6 | `currentTextBuffer` and `views[currentViewIndex]` agree | **DOC-STALE / VIOLATED-BY-DESIGN in Model B** — server mode deliberately decouples them (`onServerBuffer:3978` bare assignment); `setCurrentPaneId` re-couples the watch wrongly (APPV-04). The doc's "modeline reads from both" is gone: **`updateModeline` no longer exists anywhere in app.js**; the modeline is 100% server-pushed (`serverChrome.setModeline:3572`). The `9/7` signature can no longer render |
| 7 | Ephemeral kinds: browser, pdf, jukebox, shell, customize, doc → `viewToBlob` null; seed-splice fixes index | **HOLDS with drift** — `session.js` matches except **pdf is conditionally persisted** (`persist` flag, `session.js:189–197`) and bookmark/directory-* persist; the doc's flat "pdf ephemeral" is stale. Seed-splice fix present (`9083–9095`). Entire legacy restore is skipped in server mode (`9056–9058`) — the doc doesn't say so |
| 8 | Pane/leaf ids durable across restore; `visitFile` drops a stale target id → editing leaf | **HOLDS** — client arm adopts wire ids verbatim (`buildServerPaneNode:3220,3246`); spine `visitFile` validates the target id against live leaves and falls back to `editingLeafId` (`spine.js:3656–3674`); legacy `buildRestoredPaneTree` bumps the counter (8363, 8374). Gap: the reconcile does **not** bump the renderer's id counter (APPV-12) |
| 9 | `setCurrentPaneId` is the single entry point for focus changes | **DOC-STALE** — deliberate bypasses now: `reconcileServerPaneTree:3355` (server-authoritative, also skips the `isNoFocusPane` guard, trusting the wire), `mountServerSingleFallback:3472`, `installRootPane:8424` (legacy), `deletePaneInTree:1265–1287` (a duplicated inline copy of the rebind logic — drift risk) |
| 10 | `activateTabInTabline` syncs `currentViewIndex` when in the focused leaf | **HOLDS** (legacy arm, 7217–7225) + an undocumented server arm (7202–7210) that routes to the server instead |
| 11 | mount eager-creates all **non-text** tabs | **DOC-STALE detail** — procs (shell/gnuplot) are now also excluded from eager creation (`7037–7044`, xterm sizing) |
| 12 | `SINGLETON_VIEWS` contains "browser, pdf, image, audio, video, etc." | **DOC-STALE** — browser is per-instance and explicitly not in the list (`app.js:6394`); the list also contains view-list/recover/bookmark/directory-*/shell/gnuplot which the doc doesn't mention |
| 13 | Known-bug table (9 rows) | All nine root causes remain fixed in the current code (spot-checked each) |
| 14 | "Key flows": openFile → switch → kill | **DOC-STALE at the architectural level** — none of these flows is reachable in Model B; the live flows (visitPath/switchBuffer/close-tab intents + PANE_TREE reconcile) are undocumented |

---

## Test coverage

- **app.js: zero.** All of this territory's orchestration — `mountTablineActiveChild`, `killViewAtIndex`, `activateTabInTabline`, the reconcile, the element registries, the dispose loops — runs only in the live app. The suite being green (3290) says nothing about any finding above.
- **What IS covered nearby:** `packages/pane` (tree/layout, `pane.test.js`, `pane-edge.test.js`), `packages/view` (createView + utils), `apps/desktop/src/session.test.js` (blob serialise/restore incl. ephemeral rules), `server-view-client.test.js` (snapshot/switch/chrome fakes — this is why the client core is trustworthy), `mwb/pane-model.test.js` + `spine-panes.test.js` (server tree ops), `pane-client-layout.test.js`, `packages/renderer/test/tabline-view-lifecycle.test.js` (element lifecycle only — the strip logic in `tabline.js` (index closures, drag-reorder, middle-click) has no direct test), `pane-focus.test.js`, `server-router-gate.test.js`, `move-view-state.test.js`, `tree-open.js` via `pickEditingLeaf` tests.
- **Extractable-and-testable candidates (highest value first):**
  1. **The source-close dispose sweep** (APPV-01 fix): a pure function `(registries, closedIds) → elements-to-destroy` is trivially unit-testable and directly pins the P1.
  2. **The reconcile's map-pruning logic** (`stillStatic` / `shownMedia` / `tablineLeafIds` / minimap sets): pure set computation over a wire tree — extract from `reconcileServerPaneTree` and table-test against tree shapes (media in tabs, tabline flips, minimap toggles).
  3. **`buildServerLeafTabline`'s tab mapping** (active/proxy/media selection + `active` index): pure given injected caches.
  4. **`killViewAtIndex` index bookkeeping** (legacy but subtle): a harness with a fake pane tree would have caught branch-B; worth it only if the legacy path survives the teardown.
  5. **`hideInactiveRendererViews`/`hideInactiveSingletons`** against a JSDOM pane fixture — the ownership table as an executable test.
- The smoke arm (`scripts/smoke.js`) exercises some of this live, but per MEMORY the known backtick trap and stubbed primitives limit it; none of the close-path leaks would trip it.

## What's solid

- **The leaf-flip identity discipline**: `serverLeafActiveTabViews` (one stable live↔static view object per tabline leaf) and `repointServerTextEl`'s same-buffer scroll preservation are careful, correct work — tab switches and focus flips reuse elements exactly as intended.
- **All three `views.splice` sites** fix `currentViewIndex` in-step, including the seed-splice with its defensive clamp — the historical 9/7 family is genuinely closed out in the code that remains.
- **The display-ownership rules hold everywhere on live paths**: no `hideInactiveRendererViews` from the tabline mount, `:scope > text-view` selectors throughout, the orphan sweep + display loop in `mountTablineActiveChild` are exactly per spec.
- **Capture-phase focus** (`focusPaneFromEvent`) plus the strip-refresh detachment hazard are handled per the playbook, and the `:no-focus` guard is centralised in `setCurrentPaneId`.
- **Proc-view lifecycle** (hide-not-kill, lazy xterm creation while sized, `reapProcView` spanning both registries, the double-setBuffer re-entrancy guard) is the model the other kinds should copy.
- **Durable pane ids** across server restore (wire ids adopted; spine validates stale visit targets) — the just-merged behaviour is present and coherent on the client arm.
- **XSS posture**: labels/titles/rows all `textContent`; `escapeHtml` correct; the one `innerHTML` sink (`doc-view.js:465`) receives built docs or marked-rendered self-authored docstrings.

## Open questions

1. **Why does a project window's central tabline miss `_serverLeafTabline`?** `buildServerLeafTabline` always sets it, yet the architect's repro (per `b74fa210`) hit the else branch. There may be a second tabline mount path in project windows worth finding before/while merging the fix.
2. **Does the spine permit splitting a media/proc/browser-focused leaf** (APPV-06's trigger)? If it refuses, that finding drops to latent.
3. **Is `requestQuit` in `serverChrome` intentionally dead** (kept for a future client-resolved quit), or teardown residue?
4. **Should the renderer recovery controller exist at all in server mode?** It only ever fires via the APPV-04 path; the spine autosaves. If it's dead weight, `recovery.*` calls in server mode could be gated off wholesale.
5. **`*close-tab-kills-view*` default:** the app.js `onClose` comment still describes un-curate semantics; confirm which behaviour is the product intent (the spine default and the comment disagree).

## Stats

- Files read in full: `apps/desktop/src/app.js` (9141), `docs/VIEWS.md` (391), `docs/MODEL-B-DISPATCH.md` (235), `packages/renderer/src/tabline.js` (177), `apps/desktop/src/server-view-client.js` (976), `packages/pane/src/pane.js` (166), `packages/view/src/view.js` (first 80 + spot).
- Files read in targeted part: `mwb/client-buffer.js`, `mwb/pane-model.js`, `mwb/spine.js` (close-tab / visitFile / quit arms), `apps/desktop/src/session.js`, `apps/desktop/src/main.js`, `mwb/pane-view-client.js`, `packages/renderer/src/{audio,browser}-view.js`, `doc-panel.js`, `hover-doc.js`, `view-list-view.js`, preload.mjs; git history for the tabclose branch.
- Findings: **15** — P1: 3 (APPV-01, 02, 03) · P2: 7 (APPV-04…10) · P3: 5 (APPV-11…15).
- Confidence split: CONFIRMED 10 · PLAUSIBLE 5.
- Invariant catalogue: 14 verdicts — HOLDS 6 · HOLDS-with-drift 2 · DOC-STALE 4 · VIOLATED-AT (live) 1 · VIOLATED-AT (latent/dead) 1.
