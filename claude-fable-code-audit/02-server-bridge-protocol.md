# Server bridge, protocol & persistence (mwb) — audit

**Date:** 2026-07-01 · **Auditor:** agent 2 of 13 · **Branch:** `main` @ `efe0fa6d`
**Area:** `apps/desktop/mwb/` — the Model-B server (`server.js`), wire protocol, session/autosave persistence, and the port plumbing between main, the spine `utilityProcess`, and the renderer clients.

| File | Lines | Coverage in this audit |
|---|---|---|
| `apps/desktop/mwb/server.js` | 2360 | read fully |
| `apps/desktop/mwb/protocol.js` | 901 | read fully |
| `apps/desktop/mwb/client.js` | 354 | read fully (Phase-0 spike code) |
| `apps/desktop/mwb/preload.mjs` | 72 | read fully (Phase-0 spike code) |
| `apps/desktop/mwb/launch.js` | 219 | read fully (Phase-0 spike entry) |
| `apps/desktop/mwb/session-store.js` | 176 | read fully |
| `apps/desktop/mwb/atomic-write-sync.js` | 120 | read fully |
| `apps/desktop/mwb/autosave.js` | 264 | read fully |
| `apps/desktop/src/server-bridge.js` | 143 | read fully (cross-ref: the real fork/port wiring) |
| `apps/desktop/src/main.js` | 517 | read fully (cross-ref: env wiring, migration, quit) |
| `apps/desktop/src/server-view-client.js` | 976 | read fully (cross-ref: the real client half) |
| `apps/desktop/src/preload.mjs` | 804 | grepped (port re-dispatch section read) |
| `apps/desktop/mwb/spine.js` | 6103 | targeted sections read (~600 lines: minibuffer/picker delivery, viewStateOf, client lifecycle, loadWindowLayout, visitFile, customize, notebook/REPL/synctex, applyPaneIntent) |
| `apps/desktop/mwb/client-buffer.js` | 409 | targeted sections read (delta/resync/snapshot apply) |
| `apps/desktop/src/app.js` | ~13k | grepped + targeted sections (port receipt, bootServerViewClient, performShutdown) |
| test files: `protocol.test.js`, `session-store.test.js`, `atomic-write-sync.test.js`, `autosave.test.js`, `src/server-view-client.test.js`, `src/server-bridge.test.js` | — | read/skimmed for coverage assessment |

Two live Electron probes were run (offscreen, in the scratchpad, not the app) to settle
`MessagePortMain` semantics decisively: (1) one-shot `once('did-finish-load')` port delivery
across a page reload, (2) `postMessage` behaviour on a closed port and with a non-cloneable
value. Results are cited inline.

---

## Executive summary

- **DATA-LOSS HAZARD (P1, confirmed):** crash-recovery snapshots — the only copy of unsaved
  edits after a crash — are written to `$TMPDIR/godot-mw-b-recovery`. `MWB_RECOVERY_DIR` is
  never set in production (`main.js` sets `MWB_SESSION_STORE`, `MWB_CONFIG_HOME`,
  `MWB_SESSION_SEED` — not the recovery dir). This is the *identical* bug family as the
  workspaces.json store that was just moved out of tmpdir on 2026-07-01: macOS sweeps
  `/var/folders/.../T`, so a crash followed by ≥3 days away silently destroys the recovery set.
- **P0 (probe-confirmed mechanism):** a window **reload (Ctrl+Cmd+R, the View-menu "Reload"
  the docs recommend for picking up renderer edits) permanently disconnects that window from
  the server.** The server port is delivered exactly once per window
  (`server-bridge.js attachWindow` → `webContents.once('did-finish-load')`); on reload the old
  page's port closes (server detaches the client and drops its pane state) and the new page
  never receives a port — dead keys, no editor, no error surfaced. Recovery requires File ▸
  New Window. Verified with a minimal Electron probe replicating the exact wiring.
- **P1:** the whole spine process has **no `uncaughtException` net**, and several message-handler
  paths run **outside any try/catch** (the post-intent send block in `applyIntent`, the
  `MSG.PANE` and `OPEN_ELEMENT_SOURCE` handlers, the HELLO project branch). A throw there —
  the same stale-state family as the just-fixed restore freeze, e.g. `viewStateOf`'s still-unclamped
  `positionAt` (`spine.js:5390`) — now kills the **entire server and every window**, not one
  window. The recent `sendClientState` per-send-guard fix covers only the HELLO/restore paint.
- **P1:** a single malformed `{type:'intent'}` message with no `intent` field crashes the whole
  server (`applyIntent` dereferences `intent.id` *before* its try). Trust-boundary validation
  on the up-channel is otherwise ad-hoc coercion.
- **P2 cluster in the fan-out discipline:** `onKillReHome`, `broadcastView`, `fanDelta`,
  `broadcastOverlaysForActiveBuffer` and `resyncClientToCurrentBuffer` still use the
  zero-guard-per-client loop pattern the `sendClientState` fix was written to kill — one bad
  client's state aborts the loop and starves the remaining clients.
- **P2:** the production client has **no delta gap detection** (comments claim it exists), and
  the global `seq` counter is bumped across *all* buffers while deltas fan out *per buffer* —
  so seq is unusable for gap detection as designed. A dropped delta = silent, permanent mirror
  divergence.
- **P2:** quit-time `SESSION_SAVE` (the "Remember this workspace" label) is posted with no ack
  before main SIGTERMs the server — a race that can silently drop the named save.
- **P2:** no single-instance lock: two Godot instances share `~/.godot/workspaces.json`
  (last-writer-wins clobber of each other's saved workspaces) and the same recovery dir
  (instance B *consumes and clears* instance A's live recovery snapshots at boot).
- Persistence primitives themselves (`atomic-write-sync.js`, `session-store.js`,
  `autosave.js` pure logic) are solid and well-tested; the recent workspaces.json migration in
  `main.js` handles both-files-exist and double-run correctly.
- `server.js` (2360 lines: all routing, the minibuffer fork, restore orchestration, session
  persistence) has **zero automated tests** — it cannot even be imported under `node --test`
  (top-level `process.parentPort.on`). Both this session's freeze bug and the reload bug live
  exactly in that uncovered glue.

---

## Findings

### SRV-01: Window reload permanently disconnects the client — the server port is delivered exactly once per window

**Severity:** P0
**Dimension:** Correctness (user-reachable dead window in normal use)
**Location:** `apps/desktop/src/server-bridge.js:105–128` (`attachWindow`), `apps/desktop/src/main.js:250` (sole call site), `apps/desktop/src/menu.js:175–178` (`role: 'reload'`, Ctrl+Cmd+R), `apps/desktop/src/app.js:381–399` (port receipt)

**Evidence:**
- `attachWindow` creates one `MessageChannelMain`, posts `port1` to the server, and delivers
  `port2` with `webContents.once('did-finish-load', deliver)` — a **one-shot** listener.
  `attachWindow` is called exactly once per window (`main.js:250`, at window creation). Grep
  confirms `godot:server-port` is sent nowhere else, and there is no renderer-side "request a
  port" path (`app.js` only *listens*; `bootServerViewClient` no-ops while `godotServerPort`
  is null, `app.js:3991`).
- The app menu binds **Ctrl+Cmd+R → `role: 'reload'`** and both `CLAUDE.md` and
  `docs/MODEL-B-DISPATCH.md` (reload-rules table) instruct that a window reload is the way to
  pick up renderer/`*.lisp`/CSS edits.
- **Probe (run this session, minimal offscreen Electron app replicating the wiring):** first
  load → `did-finish-load #1` → port delivered; `webContents.reload()` → server-side port
  fires `close`; `did-finish-load #2` → **no second delivery** (`RESULT loads=2 delivers=1`).
- Server side, the old port's `close` runs `detachClient` (`server.js:509,523–540`):
  the client is reaped and `spine.removeClientView` drops the window's pane tree.

**Failure scenario:** the architect edits `app.js`, presses Ctrl+Cmd+R exactly as the playbook
says. The page reloads, boots, and waits forever for a port: no snapshot, no editor content,
every key dead. No error is shown (the only trace is the absent
"[godot] Model-B server port connected" console line). The window's server-side layout is
already gone (detach). Recovery: File ▸ New Window (main-process menu still works), then close
the husk. No document data is lost (buffers live in the server) — but this is a bricked window
via a documented, menu-exposed action.

**Fix direction:** deliver the port on **every** load: use `webContents.on('did-finish-load')`
and mint a *fresh* `MessageChannelMain` per load inside the handler (the old port is dead
anyway), or have the renderer request a port explicitly on boot (an `ipcMain.handle` that
mints + posts a channel — also fixes any load/registration race). Update the reload-rules docs
if reload is instead declared unsupported.

**Confidence:** CONFIRMED (code trace + live Electron probe of the identical wiring). Caveat
honestly noted: the playbooks describe reload as the daily workflow, which implies either
nobody has window-reloaded since Model B became the only mode (2026-06-28) or reloads are being
followed by relaunches; I found no re-delivery path and the probe is decisive about the
mechanism.

---

### SRV-02: Crash-recovery snapshots live in the macOS-swept tmpdir — `MWB_RECOVERY_DIR` is never set in production

**Severity:** P1
**Dimension:** Data safety
**Location:** `apps/desktop/mwb/server.js:1516–1517` (`RECOVERY_DIR = MWB_RECOVERY_DIR || join(tmpdir(), 'godot-mw-b-recovery')`), `apps/desktop/src/main.js:414–449` (env wiring — sets `MWB_SESSION_SEED`, `MWB_CONFIG_HOME`, `MWB_SESSION_STORE`; **not** `MWB_RECOVERY_DIR`)

**Evidence:** repo-wide grep: `MWB_RECOVERY_DIR` appears only in `server.js` (definition) —
no production setter. So the autosave controller (`createAutosave({ dir: RECOVERY_DIR, … })`,
`server.js:1519–1524`) always writes recovery snapshots of every dirty buffer into
`$TMPDIR/godot-mw-b-recovery` on macOS. This is precisely the hazard class fixed *this week*
for the named-workspace store (HANDOVER.md item 2, commit `b7fc4f42`: "macOS sweeps
`/var/folders/.../T`, so named workspaces could silently vanish") — the recovery dir was not
moved with it.

**Failure scenario:** the app (or the spine) crashes with unsaved edits. The snapshots — at
that point the *only* copy of the edits — sit in tmpdir. The user doesn't relaunch Godot for a
few days (holiday, other machine); macOS's periodic tmp cleaning removes files not recently
accessed; on relaunch `recoverOnStartup` (`server.js:1956`) finds nothing. Work silently gone.
While the app runs, the 4-second re-snapshot keeps mtimes fresh, so the exposure is exactly the
crash-then-gap window — the same window recovery exists to cover.

**Fix direction:** pin the recovery dir under the config home
(`MWB_RECOVERY_DIR = join(configHome, 'recovery')` in `main.js`, next to the `MWB_SESSION_STORE`
wiring), with a first-run copy-across of any existing tmpdir snapshots (mirror the
workspaces.json migration ~`main.js:434–442`).

**Confidence:** CONFIRMED (traced end to end; the memory/HANDOVER record establishes the sweep
is accepted as real in this codebase).

---

### SRV-03: Unguarded message-handler paths + no process-level exception net — a state-computation throw now kills the whole server (every window)

**Severity:** P1
**Dimension:** Correctness / crash blast radius
**Location:**
- `apps/desktop/mwb/server.js:1091–1159` — the entire post-intent block of `applyIntent`
  (`resyncClientToCurrentBuffer` at 1113, the RESYNC loop at 1129–1137, the CURSOR echo at
  1141, `sendCursorsTo` at 1153, `broadcastView()` at 1158) sits **after** the `try/catch`
  (which closes at 1085–1089).
- `server.js:1369–1390` — the `MSG.PANE` handler (`applyPaneIntent`, `resyncClientToCurrentBuffer`,
  `sendViewTo`, `sendCursorsTo`, `persistLastSession`) has no guard.
- `server.js:1490–1499` — `OPEN_ELEMENT_SOURCE` (`openElementSource` + resync), no guard.
- `server.js:1338–1348` — the HELLO `pendingProjectWindow` branch (`spine.visitFile` loop +
  `spine.loadProjectWindow`), no guard.
- No `process.on('uncaughtException')` anywhere in `server.js`/`spine.js` (grep confirmed;
  `main.js:76` has one, but that is the main process).
- Throw source still live: `spine.js:5390` — `viewStateOf` calls `buf.positionAt(v.point)`
  with **no clamp** (the session-restore fix clamped `pointPosition` at `spine.js:5711` and
  restored layouts in `loadWindowLayout`/`clampRestoredPoints` at `spine.js:5013`, but this
  third `positionAt` call site was not hardened).

**Evidence:** the delivery chain is: port `'message'` → `onClientMessage` (no try) →
handler. Any exception escaping a handler propagates out of the EventEmitter callback into the
utilityProcess's default behaviour: process exit. `server-bridge.js:88–91` then only logs
"`[godot-server] server exited (code …)`" — no respawn ("Respawn orchestration is a later
phase"), no user notification. Contrast with the fixed path: `sendClientState`
(`server.js:744–761`) runs its six sends each under its own guard precisely because a
data-shaped throw in an early send used to freeze the window; the *same throw* arriving through
`broadcastView` at the end of *any* intent, or through the `MSG.PANE` resync, is uncaught all
the way down and now takes out every window at once.

Note the mitigating probe result: `MessagePortMain.postMessage` to a **closed** port does
**not** throw (probe-confirmed silent drop), and even a function-valued payload did not throw —
so dead ports are not a throw source; the risk is entirely stale/invalid **spine state** during
view-state computation (`positionAt`, `focusedViewOf`, registry lookups), i.e. exactly the bug
family that has now bitten twice.

**Failure scenario:** any future data bug of the restore-freeze family (a view point past a
shrunk buffer reached through a path other than `loadWindowLayout` — e.g. `recoverBuffer`
seeding, a data-source↔text switch edge) throws inside `viewStateOf` during the
`broadcastView()` at `server.js:1158`. The exception escapes `applyIntent`, the spine dies,
every window goes dark simultaneously, and up to 4s of edits (autosave cadence) are at risk —
in tmpdir (SRV-02).

**Fix direction:** three layers, cheapest first: (1) a `process.on('uncaughtException')` in
`server.js` that logs and *keeps serving* (or at minimum flushes metadata + one autosave pass
before exiting); (2) wrap `onClientMessage`'s dispatch in a per-message guard; (3) clamp
`v.point` in `viewStateOf` (`Math.min(v.point, buf.length)`) as `pointPosition` already does.

**Confidence:** CONFIRMED for the chain and the unguarded regions (traced line by line);
PLAUSIBLE for the specific future throw source (the two historical instances of this family
are documented in HANDOVER.md).

---

### SRV-04: A malformed INTENT message crashes the entire server — `intent.id` dereferenced before the guard

**Severity:** P1
**Dimension:** Security & IPC (trust-boundary validation) / robustness
**Location:** `apps/desktop/mwb/server.js:816` (`currentEchoId = intent.id;` — before the `try` at 832), reached from `server.js:1366–1367` (`case MSG.INTENT: applyIntent(client, msg.intent)`)

**Evidence:** `onClientMessage` validates only `msg && typeof msg === 'object'`. A message
`{ type: 'intent' }` (no `intent` field) passes, and `applyIntent(client, undefined)` throws
`TypeError: Cannot read properties of undefined (reading 'id')` at line 816 — *outside* the
handler's try/catch (which begins at line 832). Per SRV-03's chain, that is an uncaught
exception in the utilityProcess → whole-server death, all windows.

**Failure scenario:** (a) a compromised renderer — or any page that somehow obtains the
transferred `MessagePort` — kills the editor server (and with it every window's live state) with
one two-field message; (b) more mundanely, a future renderer refactor that posts a slightly
wrong intent shape bricks the whole app rather than one window logging an error. The rest of
the up-channel is duck-typed coercion (`String(intent.key ?? '')`, `Array.isArray` checks) —
mostly tolerant, but nothing systematic; e.g. `PANE_VIEWPORT`/`VIEWPORT`/`WINDOW_BOUNDS` rely
on the spine's internal tolerance.

**Fix direction:** normalise at the boundary: in `onClientMessage`,
`const intent = msg.intent && typeof msg.intent === 'object' ? msg.intent : null;` and drop
null; or move line 813–831 inside the try. A tiny `validateIntent(msg)` in `protocol.js`
(which already owns `normalisePickerRequest` as the pattern) would give both ends one shape.

**Confidence:** CONFIRMED (trivial trace; not probe-executed against the live server since
that would require launching the app).

---

### SRV-05: The per-client-guard fix is incomplete — `onKillReHome`, `broadcastView`, `fanDelta`, `broadcastOverlaysForActiveBuffer`, `resyncClientToCurrentBuffer` still let one client's failure starve the rest

**Severity:** P2
**Dimension:** Correctness (state divergence across windows)
**Location:** `apps/desktop/mwb/server.js:805–809` (`onKillReHome`), 585–587 (`broadcastView`), 551–567 (`fanDelta`), 605–614 (`broadcastOverlaysForActiveBuffer`), 766–789 (`resyncClientToCurrentBuffer` — internally unguarded, called from eight sites beyond `sendClientState`)

**Evidence:** the 2026-07-01 freeze fix introduced per-step guards **only** in
`sendClientState` (`server.js:744–761`, used by HELLO and `handleWorkspaceChoice`). Every other
multi-client loop posts/computes per client with no per-iteration guard:

```js
function onKillReHome() {
  for (const c of clients) resyncClientToCurrentBuffer(c);   // one throw → rest skipped
  ...
}
function broadcastView() {
  for (const c of clients) sendViewTo(c);                    // one throw → rest skipped
}
```

Most call sites sit inside `applyIntent`'s try (so the *server* survives via the catch at
1085), but the loop still aborts: the remaining clients never receive their delta / view /
resync for that intent. `fanDelta` is the worst case — a skipped DELTA is permanent divergence
because the client has no gap detection (SRV-06).

**Failure scenario:** window A's leaf state is momentarily inconsistent (the same stale-state
family); a kill-buffer in window C triggers `onKillReHome`; A's resync throws; windows B and D
(later in `clients[]`) are never re-homed and keep rendering a killed buffer's mirror. The
`finally`-less loop also leaves `spine.setActiveClient` bound to the failing client.

**Fix direction:** the same idiom as `sendClientState`: wrap the per-client body of every
multi-client loop in its own try/catch that logs and continues; give
`resyncClientToCurrentBuffer` an internal per-send guard (it is the paint used *after* boot).

**Confidence:** CONFIRMED (pattern verified at each listed site).

---

### SRV-06: No delta gap detection in the production client — and the global `seq` makes per-buffer gap detection impossible anyway

**Severity:** P2
**Dimension:** Correctness (silent replication divergence) + architecture drift
**Location:** `apps/desktop/mwb/client-buffer.js:112` (comment: "The last server sequence number we've applied (gap detection)"), 145–168 (`applyDelta` — records `lastSeq`, never checks it), `apps/desktop/src/server-view-client.js:498–503` (`onDelta` — applies blindly); `apps/desktop/mwb/server.js:149–151, 551–567` (one global `seq` incremented per change, fan-out filtered per buffer)

**Evidence:** the Phase-0 spike client (`mwb/client.js:195–199`) *did* detect
`delta.seq !== lastSeq + 1` and re-request a snapshot. The production client dropped that: 
`applyDelta` only stores `lastSeq`. Meanwhile the server's `seq` is a single counter across
**all** buffers, but `fanDelta` sends each delta only to clients viewing the changed buffer —
so a client legitimately sees seq 5 → 9 whenever another buffer was edited in between. Gap
detection as documented cannot be implemented without per-buffer sequencing. `applySnapshot`'s
comment ("resync after a detected gap") and `client-buffer.js:112` promise machinery that does
not exist.

**Failure scenario:** any dropped or skipped DELTA (SRV-05's aborted `fanDelta` loop; a
future send error) silently desynchronises that window's mirror from the canonical buffer —
edits land at wrong offsets from then on, and nothing ever heals it (no resync trigger). With
today's code the *known* trigger is SRV-05; the design leaves no safety net for unknown ones.

**Fix direction:** either make `seq` per-buffer (bump a counter on the buffer entry; snapshot
carries it) and restore the spike's gap → HELLO/RESYNC request, or delete the dead `seq`
plumbing and comments so nobody trusts it. The former is the correct (harder) option and cheap:
the RESYNC machinery already exists.

**Confidence:** CONFIRMED (all three code points read; divergence consequence PLAUSIBLE, needs
a send failure to trigger).

---

### SRV-07: Quit-time `SESSION_SAVE` has no acknowledgement — the named-workspace save races the server SIGTERM

**Severity:** P2
**Dimension:** Correctness / persistence
**Location:** `apps/desktop/src/app.js:2224–2235` (`performShutdown` posts `MSG.SESSION_SAVE` then proceeds), `apps/desktop/src/main.js:298–301` (`app:quit` → `app.quit()`), `main.js:467–472` (`will-quit` → `serverBridge.dispose()` → `child.kill()`), `apps/desktop/mwb/server.js:2019` (SIGTERM handler → flush metadata → `process.exit(0)` — pending port messages dropped)

**Evidence:** the comment in `performShutdown` admits the design: the save is "Posted BEFORE
the flushes below, which **give the server time** to do its synchronous save before it's torn
down." There is no ack; the only thing between the post and `window.host.quit()` is
`await flushAllMetadata(); await recovery.clear();` — renderer↔main IPC latency used as a
timer. If the spine's event loop is busy (an autosave pass over large buffers, a big
`PANE_TREE` fan-out), SIGTERM's `process.exit(0)` runs before the queued `SESSION_SAVE`
message is dispatched, and the labelled workspace is silently never written. The `__last__`
auto-snapshot survives (written on structural changes throughout the session), so the loss is
the *label/named entry*, not the layout.

**Failure scenario:** user quits, types a workspace name at the "Remember this workspace"
prompt, relaunches — the chooser doesn't list it. Non-deterministic, unreproducible-looking.

**Fix direction:** make the save a request/reply (server posts `session-saved` back; the
renderer awaits it — with a short timeout — before `host.quit()`), or route the save through
main (which controls the kill ordering) rather than the port.

**Confidence:** PLAUSIBLE (race window is real but small; not observed).

---

### SRV-08: No single-instance lock — two Godot instances clobber `workspaces.json` and steal each other's recovery snapshots

**Severity:** P2
**Dimension:** Data safety
**Location:** `apps/desktop/src/main.js` (no `requestSingleInstanceLock` anywhere — grep confirmed), `apps/desktop/mwb/session-store.js:77–111` (in-memory model, whole-file rewrite on every `persist()`), `apps/desktop/mwb/server.js:1956–2009` (`recoverOnStartup` → loads snapshots → `autosave.clear()` removes the **whole shared dir**)

**Evidence:**
- Each server process loads the workspace store **once** at boot into an in-memory model and
  rewrites the entire file on every mutation. Two live instances (e.g. the packaged Godot and
  a dev `electron .` — a combination the project actually uses) both point at
  `~/.godot/workspaces.json`; instance B's next `persist()` silently erases any workspace
  instance A saved after B booted, and their `__last__` snapshots overwrite each other.
- Both instances share `$TMPDIR/godot-mw-b-recovery`. Instance B's `recoverOnStartup` sees
  instance A's live snapshots (disk older than snapshot — that's what dirty means), loads them
  as recovered buffers **in B**, then `autosave.clear()` deletes the directory — including A's
  ongoing snapshots. A recreates it within 4 s, but if A crashes inside that window its edits
  have no snapshot; and B now surfaces spurious "recovered" copies of files A still has open.

**Failure scenario:** dev instance running with dirty buffers; the user double-clicks the
packaged app. The second instance boots, silently absorbs and clears the first's recovery set,
and each quit thereafter overwrites the other's workspace store.

**Fix direction:** `app.requestSingleInstanceLock()` in `main.js` (focus the existing window on
second launch) is the standard fix and matches the shared-server architecture; alternatively
scope the store/recovery paths per instance, but that contradicts their purpose.

**Confidence:** CONFIRMED mechanics (all three code points traced); the two-instance situation
itself is PLAUSIBLE (nothing prevents it today).

---

### SRV-09: `server-view-client` pending-intent map leaks an entry for every key that produces no echo — unbounded growth scanned on the typing hot path

**Severity:** P2
**Dimension:** Correctness / perf cliff
**Location:** `apps/desktop/src/server-view-client.js:243` (`const pending = new Map()`), 269–273 (`sendKey` — registers every key), 498–512 (`onDelta`/`onCursor` — delete only by `echoId`), 519–525 + 560–570 (`[...pending.values()].some(…)` on every CURSORS and VIEW message)

**Evidence:** every keystroke registers a pending entry. The server echoes an id back **only**
via a DELTA (text changed) or a CURSOR (point moved: `server.js:1138–1147`). A key that does
neither — `C-x` (prefix), `C-g`, an unbound key, any key while a status-only command runs —
leaves its entry in `pending` forever. Cleanup happens only on a buffer-switch SNAPSHOT
(`onSnapshot`: `if (isSwitch) pending.clear()`). Meanwhile `onCursors` and `onView` spread the
whole map (`[...pending.values()].some((p) => p.predicted)`) on **every** message — and the
server broadcasts a VIEW to every client after every intent, so the scan cost grows linearly
with session-long leaked entries, paid per keystroke per window. (Also note `p.predicted` is
always `false` now that local echo is gone — the entire scan is dead logic guarding nothing.)

**Failure scenario:** a long single-buffer session (the actual usage pattern) accumulates tens
of thousands of entries; typing latency degrades gradually; memory grows without bound. No
crash, just the classic slow-leak profile.

**Fix direction:** cap the map (delete oldest beyond N), or expire entries on the next VIEW
whose `seq` ≥ send-time seq, or simply stop registering non-printable keys / drop the
`predicted` machinery entirely (it is vestigial — comments at 239–242 admit the predict path is
gone).

**Confidence:** CONFIRMED growth mechanism (all insert/delete sites enumerated); perf impact
PLAUSIBLE (not measured).

---

### SRV-10: Spine crash/exit leaves every window silently hung — no respawn, no user notification, no client-side port-close handling

**Severity:** P2
**Dimension:** Correctness & data safety (crash UX)
**Location:** `apps/desktop/src/server-bridge.js:86–91` (exit → log only; "Respawn orchestration is a later phase"), `apps/desktop/src/server-view-client.js` (no `port.on('close')` / `close` handling anywhere — grep confirmed), `apps/desktop/mwb/launch.js:72–74` (spike: same log-only)

**Evidence:** if the spine exits (SRV-03/SRV-04 crashes, OOM, a kill), main logs one stderr
line. Renderers keep their dead ports; `dispatchKey` keeps posting into the void
(probe-confirmed: posting to a closed port silently drops); nothing in the client listens for
port close; no dialog, echo-area message, or reconnect is attempted. The user experiences a
fully-painted editor where nothing responds — indistinguishable from the freeze family — and
must guess to quit. Unsaved edits are only as fresh as the last 4 s autosave pass (in tmpdir,
SRV-02).

**Failure scenario:** any server crash in normal use → all windows dead simultaneously with no
explanation; user force-quits; recovery then depends on SRV-02's tmpdir surviving.

**Fix direction:** minimum viable: `child.on('exit')` in `server-bridge.js` notifies every
window (`webContents.send`) and the renderer shows a "server died — relaunch" banner; the port
`close` event on the renderer side can drive the same locally. Respawn + re-HELLO is the full
fix and the architecture already supports re-registration (monotonic client indices), but the
session/undo state would reset to the last persisted snapshots — say so in the banner.

**Confidence:** CONFIRMED behaviour (all points traced; drop semantics probe-verified).

---

### SRV-11: The up-channel embeds unescaped wire strings into Lisp/JS evaluation — the renderer is a fully trusted code source for the spine

**Severity:** P2
**Dimension:** Security & IPC (trust boundary documentation / defense in depth)
**Location:** `apps/desktop/mwb/spine.js:2883–2906` (`applyCustomizeChange` — `` interpreter.evaluate(`(custom-apply! (quote ${name}) (quote ${valueSrc}))`) `` with `name`/`valueSrc` raw off the wire), `spine.js:5812–5822` (`replEval` — arbitrary Lisp by design), `spine.js:5783–5806` + `notebook-engine.js` (`runNotebookCell` — arbitrary JS as `AsyncFunction` in the spine's Node context, by design), `server.js:1010` (`CUSTOMIZE_CHANGED` routes the raw object in)

**Evidence:** a `CUSTOMIZE_CHANGED` intent with
`valueSrc: '(begin (run-process! …) 1)'` — or simply unbalanced parens smuggling any form —
evaluates arbitrary Lisp in the spine, which has unrestricted `node:fs`, `child_process`
(`run-process!`), and the user's whole home directory. `REPL_EVAL` and `NOTEBOOK_EVAL` are
arbitrary evaluation *on purpose*. Conclusion: **any** compromise of the editor renderer is
full code execution in a Node process — the port is a code channel, not a data channel. That
is a defensible design for a single-user extensible editor (the renderer already has broad fs
reach via `files.js` IPC), but it is nowhere written down, and `applyCustomizeChange`
specifically *could* be a data channel (its legitimate inputs are a defcustom name + a value
literal) yet is implemented as string-splice evaluation.

**Failure scenario:** a renderer-side XSS/HTML-injection bug (the editor renders hostile file
content: markdown preview, doc panels, picker labels) escalates instantly to arbitrary native
code execution via one port message, and to *persistence* via `custom-apply-and-save!` writing
attacker Lisp into `~/.godot/custom.lisp` (runs on every future boot).

**Fix direction:** (1) state the trust model in `docs/MODEL-B-DISPATCH.md` (renderer ⇒ spine is
trusted; webview guests must never reach the port); (2) harden `applyCustomizeChange` cheaply:
validate `name` against the defcustom registry and `valueSrc` by reading it with the Lisp
reader (one datum, no evaluation) before splicing; (3) keep REPL/notebook as-is (they are the
product).

**Confidence:** CONFIRMED mechanics; exploitation path PLAUSIBLE (requires a renderer
compromise first).

---

### SRV-12: `handleMinibufferSubmit` hijacks any Lisp prompt whose label collides with a special-cased string

**Severity:** P2
**Dimension:** Architecture & consistency (a trap on the primary extension surface)
**Location:** `apps/desktop/mwb/server.js:1162–1242` (`handleMinibufferSubmit` — string-matches `spine.activePrompt` against `'M-x '`, `'Find file: '`, `'Directory tree: '`, `'Directory columns: '`, `'Jukebox directory: '`, `'Write file: '`, `'Switch to buffer: '`), `spine.js:5638–5644` (`abortMinibuffer` discards the suspended continuation)

**Evidence:** the fork is by exact prompt text. A *user* command in `init.lisp` —
`(defcommand my-open (f) (interactive (string "Find file: ")) …)` — suspends on a prompt whose
label collides; on submit the server takes the special-cased branch: `spine.abortMinibuffer()`
**silently discards the user's continuation** and runs the host's `visitFile` instead. The
command's body never sees the value and there is no error. The playbook
(`docs/MODEL-B-DISPATCH.md` §minibuffer) documents the fall-through behaviour but not the
collision hazard. Note also the near-miss inconsistency: `'Open project: '` is in the
TAB-completion allowlist (`server.js:1459–1463`) but *not* special-cased on submit — correct
today (find-project uses the named-param form), but the two lists drifting is exactly how the
next bug arrives.

**Failure scenario:** the architect (or future Lisp doc examples) reuses a natural prompt
string; the command mysteriously "does the built-in thing" instead of its body; no error to
debug from.

**Fix direction:** discriminate on something other than user-visible text — e.g. the host
prompts register an explicit marker when *they* open the prompt (`spine.hostPrompt = 'find-file'`
set by the placeholder-form commands), and `handleMinibufferSubmit` switches on that, falling
through to `deliverMinibuffer` otherwise. Cheap and removes the whole class.

**Confidence:** CONFIRMED by construction (not observed live).

---

### SRV-13: Server recovery snapshots are never cleared on a clean quit — deliberately discarded edits resurrect on every boot

**Severity:** P2
**Dimension:** Correctness / persistence contract
**Location:** `apps/desktop/mwb/server.js:2005` (`autosave.clear()` — called **only** inside `recoverOnStartup`), `server.js:2016–2021` (shutdown handlers flush metadata only), `apps/desktop/src/app.js:2237–2243` (the *renderer's* `recovery.clear()` on confirmed quit — a different store; the server dir is untouched)

**Evidence:** the renderer half of quit explicitly implements "a clean, confirmed quit is not a
crash: drop every recovery snapshot so the next launch doesn't offer to recover work the user
chose to discard." The server half has no equivalent: dirty buffers the user *declined to save*
in the quit walk were autosaved ≤4 s earlier; those snapshots survive quit; next boot
`recoverOnStartup` sees snapshot-newer-than-disk and loads each as a dirty recovered buffer
(`spine.recoverBuffer`), which autosave then re-snapshots — so the discarded text returns on
*every* subsequent launch until manually saved or killed. The name-dedup pass
(`server.js:1966–1977`) keeps it to one copy per file but cannot break the cycle.

**Failure scenario:** user edits `notes.md`, decides the edits were a mistake, quits and
discards. For every future session, a dirty `notes.md` (with the unwanted edits) is silently
sitting in the buffer list.

**Fix direction:** the spine's quit path (the `quit-editor` walk, before emitting the `quit`
directive) — or the SIGTERM handler when quit was confirmed — should call `autosave.clear()`
(and only then; a crash must keep them). Erring safe is right, but a *confirmed discard* is the
one case the user has answered explicitly.

**Confidence:** CONFIRMED logic trace (not run live).

---

### SRV-14: `PICKER_DELETE` lets a client delete the `__last__` snapshot — the guard exists only on `SESSION_DELETE`

**Severity:** P3
**Dimension:** Security & IPC / consistency
**Location:** `apps/desktop/mwb/server.js:919–927` (`PICKER_DELETE` → `sessionStore.remove(intent.value)` for any string) vs `server.js:1432–1435` (`SESSION_DELETE` → explicit `msg.id !== '__last__'` guard)

**Evidence:** the workspace chooser marks only named rows `deletable`, but enforcement is
client-side; the server-side `PICKER_DELETE` handler removes whatever id arrives, including
`'__last__'`. The sibling `SESSION_DELETE` channel guards exactly this. One protocol intent
enforces the invariant, the other doesn't.

**Fix direction:** copy the `!== '__last__'` guard into the `PICKER_DELETE` branch.

**Confidence:** CONFIRMED.

---

### SRV-15: Client detach does not abort spine-side continuations — an orphaned `read-next-key`/minibuffer/picker read leaks into the next window's input

**Severity:** P3
**Dimension:** Correctness (cross-window state bleed)
**Location:** `apps/desktop/mwb/server.js:523–540` (`detachClient` — clears `minibufferClient`/`pickerClient`/`activeClient` but never calls `spine.abortMinibuffer()` / `spine.cancelPicker()`), `spine.js:1020,1028` (`activePrompt`/`activePicker` persist)

**Evidence:** close a window while its prompt/picker/`read-next-key` is pending: the server
forgets the *ownership* but the spine keeps `activePrompt`, `activePicker`, the suspended
continuation, and (for `describe-key`-style reads) the armed `*key-reader*`. The next prompt
overwrites most of these (self-healing), but an armed key-reader eats the next keystroke from
*any* window and runs the dead window's callback against the new active client; and while
`activePrompt` lingers, a (buggy/hostile) `MINIBUFFER_SUBMIT` from another window drives the
special-cased branches (`server.js:1162+`) as that other window.

**Fix direction:** in `detachClient`, when the detaching client owned the prompt/picker, also
`spine.abortMinibuffer()` / `spine.cancelPicker(null)` and clear the key-reader
(`(set! *key-reader* nil)` via a small spine hook).

**Confidence:** CONFIRMED for the state not being cleared; the key-reader bleed is PLAUSIBLE
(depends on keymap.lisp's reader precedence, not re-verified in Lisp).

---

### SRV-16: `deliverMinibuffer`/`deliverPicker` encode values with `JSON.stringify` but the Lisp reader lacks `\uXXXX`/`\b`/`\f` escapes — control characters corrupt silently

**Severity:** P3
**Dimension:** Correctness (protocol encoding mismatch)
**Location:** `apps/desktop/mwb/spine.js:5626–5631` (`(minibuffer-delivered ${JSON.stringify(String(value))})`), 5660–5666 (`picker-delivered` same), `packages/lisp/src/reader.js:201–220` (escape map: only `n t r 0 \\ "` — unknown escapes collapse to the escaped char)

**Evidence:** `JSON.stringify` emits `\u0007`, `\b`, `\f`, ` `… for control characters.
The Lisp reader maps unknown escapes to the bare character: `"\u0007"` reads as the four
characters `u007`-ish (`u` then literal `0007`), `"\b"` reads as `b`. So a pasted value
containing a control char (terminal copy, weird PDF copy) is silently transformed before the
suspended command sees it. No crash (the reader doesn't throw on unknown escapes), just wrong
data.

**Fix direction:** a tiny `lispQuoteString()` in the spine that escapes only `\` `"` `\n` `\t`
`\r` `\0` and passes everything else raw (the port already carried the raw string safely), or
teach the reader `\uXXXX`.

**Confidence:** CONFIRMED mismatch (both sides read); real-world impact PLAUSIBLE/rare.

---

### SRV-17: Spike residue presented as production — `client.js`, `mwb/preload.mjs`, `launch.js` headers, and `protocol.js`'s "NOT production" banner

**Severity:** P3
**Dimension:** Architecture & consistency (dead code / misleading docs)
**Location:** `apps/desktop/mwb/protocol.js:1–22` (header: "Model-B Phase-0 spike … THIS IS FEASIBILITY-SPIKE CODE, not production" — it is now the production wire protocol imported by `server.js`, `server-view-client.js`, `app.js`), `mwb/client.js` + `mwb/preload.mjs` + `harness.html`/`view-harness.html`/`pane-harness.html` + `mwb/launch.js` (the Phase-0 latency harness — reachable only via an explicit `electron mwb/launch.js`), `client-buffer.js:112` ("gap detection" that doesn't exist — see SRV-06), `server.js:2–5` header still describing itself as serving "plan §3 (i)" spike topology

**Evidence:** the graduation plan (`plans/MWB-GRADUATION.md:353`) even says protocol.js should
move to `src/shared/` "reuse near-verbatim" — it graduated in place with the spike banner
intact. The spike client/preload/harnesses are dead in production (nothing in `main.js`
references them; the real preload is `src/preload.mjs`) but sit beside live modules with
identical names (`mwb/preload.mjs` vs `src/preload.mjs`), which is exactly how a future session
edits the wrong file. `predictSelfInsert`/`predictDeleteBackward` in protocol.js are exported
but production-unused (local echo removed) — kept alive only by tests and the spike.

**Fix direction:** re-head `protocol.js`/`server.js` truthfully; move the spike files under
`mwb/spike/` (or delete — the memory rule is "no backward compat"); fix the gap-detection
comments.

**Confidence:** CONFIRMED.

---

### SRV-18: `__last__` snapshot staleness — cursors/scroll persist only on structural changes, and a mid-restore reload/quit can lose the multi-window layout

**Severity:** P3
**Dimension:** Correctness / persistence
**Location:** `apps/desktop/mwb/server.js:1675–1687` (`persistLastSession` — called from `resyncClientToCurrentBuffer` and pane changes only), 1679 (`if (restoreInProgress) return` — suspended for the whole multi-window cascade)

**Evidence:** point moves and scrolls never trigger a persist, so `__last__` carries the
cursor positions as of the last buffer/pane change — restoring can land cursors minutes-to-hours
stale (the SESSION_SAVE path at quit is live, so *named* saves are current). And during a
multi-window restore, persistence is suspended until the last window lands
(`applyNextRestoreWindow`); a crash/quit mid-cascade leaves whatever `__last__` held before —
acceptable — but a *user-opened* window arriving during the cascade is mistaken for the next
restore window (`awaitingRestoreWindow` matches any non-bootstrap HELLO, `server.js:1334`) and
receives the saved layout instead of a fresh scratch; the real restore window then gets the
following blob or none. Same pattern for `pendingProjectWindow` (`server.js:1338`).

**Fix direction:** tag spawned windows (thread a token through `WINDOW_NEW` → `window:new` →
`attachWindow` → the HELLO) so restore/project HELLOs are matched by token, not arrival order;
optionally persist `__last__` on a debounced cursor-move too.

**Confidence:** CONFIRMED code paths; the interleaving user action is PLAUSIBLE/rare.

---

### SRV-19: Durability nuances in `atomicWriteSync` — no directory fsync, no `F_FULLFSYNC` on macOS

**Severity:** P3
**Dimension:** Data safety (power-loss edge)
**Location:** `apps/desktop/mwb/atomic-write-sync.js:47–77`

**Evidence:** the writer does temp + `fsyncSync(fd)` + `renameSync` — correct same-volume
atomic-replace against *process* crashes. Against *power loss*: (a) the rename's directory
entry is not fsynced, so the new name may not be durable even though the data is; (b) on macOS
`fsync(2)` only pushes to the drive cache — real durability needs `fcntl(F_FULLFSYNC)`, which
Node exposes indirectly. For an editor whose baseline is "the complete old or complete new
contents", (a)/(b) mean a power cut can, rarely, surface the *old* file (never a torn one) — an
acceptable posture, worth a comment rather than code.

**Fix direction:** document the contract in the header; optionally open+fsync the dir on POSIX
for the metadata/session stores (not per-keystroke paths).

**Confidence:** CONFIRMED semantics (standard POSIX/macOS behaviour; not fault-injected).

---

### SRV-20: The tmpdir fallbacks are still wired in `server.js` — any launch path that misses the env vars silently writes user data to tmpdir again

**Severity:** P3
**Dimension:** Data safety hygiene
**Location:** `apps/desktop/mwb/server.js:66–67` (`SESSION_STORE = MWB_SESSION_STORE || join(tmpdir(), 'godot-mw-b-session.json')`), `server.js:78` (sweep falls back to the tmpdir store's dir), `mwb/launch.js` (the spike entry sets neither, so a spike run writes sessions/recovery to tmpdir — fine for a spike, but it also *reads* nothing of the user's real store, masking store bugs)

**Evidence:** post-migration, correctness depends on `main.js` always setting
`MWB_SESSION_STORE` before the fork. The in-server fallback remains the swept tmpdir rather
than a config-home default. If a future entry point (a test harness graduating to production,
a CLI runner) forks `server.js` without the env, workspaces quietly regress to tmpdir with no
warning.

**Fix direction:** make the in-server default the config home when `MWB_CONFIG_HOME` is set
(`join(MWB_CONFIG_HOME, 'workspaces.json')`), keeping tmpdir only for the bare-spike case; or
log loudly when falling back.

**Confidence:** CONFIRMED wiring.

---

## Architecture observations

- **Topology is clean and matches the playbook.** main creates one `MessageChannelMain` per
  window; port1 → spine over `parentPort`, port2 → renderer via preload re-dispatch; the hot
  path never hops through main. `server.js` is genuinely a thin bridge: routing + prompt fork +
  restore orchestration + persistence; all editor semantics live in the spine. Verified against
  `docs/MODEL-B-DISPATCH.md` — no drift in the *described* seams (the drift is in the spike
  headers and the reload-rules table, per SRV-01/SRV-17).
- **Down-channel ordering is sound by construction.** All sends to one client share one FIFO
  port, and the server is single-threaded per message — so SNAPSHOT → VIEW → OVERLAYS →
  CURSORS → BUFFER_LIST → PANE_TREE (and directives after the paint, chrome directives after
  the view on HELLO) arrive in send order. I could not construct a directive-referencing-unseen-view
  ordering violation: layout changes push PANE_TREE via the effect *during* the command, before
  the directive emit that follows in the same command. The one ordering wart is `seq` (SRV-06):
  it exists to order VIEW against DELTA but is globally scoped while deltas are per-buffer.
- **`MSG.VIEW` is three protocols in one:** full view-state (`sendViewTo`), scroll-only
  (`sendScrollToActive`, `{view:{scroll}}`), and status-override (`sendStatusTo`). The client
  special-cases scroll-only with an early return; a status-override VIEW omits `minibuffer`,
  which would *close* an open prompt via `renderChrome` — today's two call sites both run after
  `abortMinibuffer` so it's coincidentally safe. Fragile shape; a discriminated message (or
  always spreading the full view-state) would be cheaper than the next bug.
- **Trust model is implicit** (SRV-11): the port is a code channel. Fine for one user, but it
  should be written down, and the customize path shouldn't be string-spliced eval when a
  validating data channel is a 10-line change.
- **Dead-port sends are silent drops** (probe-verified), which the code mostly assumes but the
  comments contradict ("a send to a dead port would otherwise throw / no-op",
  `server.js:520–521`). The real throw source is state computation, which is where the guards
  belong (SRV-03/05).
- **Client lifecycle:** monotonic indices, one-shot `bootstrapClaimed`, idempotent
  `detachClient`, empty-scratch reaping on detach — all correct and nicely reasoned. The gap is
  continuation cleanup (SRV-15) and the *renderer* half of lifecycle (reload/reconnect,
  SRV-01; crash notification, SRV-10).
- **Persistence layering is right:** injected-IO store (unit-testable), atomic writes
  everywhere user data lands (store, project sidecars, metadata, recovery records), stale-temp
  sweeping with an age threshold. The two placement mistakes (recovery dir in tmpdir; fallback
  store in tmpdir) are wiring, not design.
- **`bestCommandMatch` semantics** (exact, else shortest containing name) are documented in the
  playbook and mirrored for Lisp; ties break by registration order (stable per boot). Surprises
  are possible (`M-x save` → `save-buffer`-or-shorter) but bounded; the unmatched-name fallback
  to the renderer is properly gated client-side (`runClientCommand` refuses non-element-view
  names — verified in `app.js:4036–4046`). `clientCommandNames` is a grow-only global union
  across windows (never pruned on detach) — harmless today because of that same gate.

## Test coverage

- **`server.js`: zero automated coverage.** It is structurally untestable as-is — importing it
  executes module-level I/O and `process.parentPort.on(...)`, which throws outside a
  utilityProcess. The five embedded self-tests (`MWB_SAVE/UNDO/PANES/PICKER_SELFTEST`) are
  real end-to-end checks but env-gated, manual, and electron-only — invisible to `pnpm test`.
  Everything this audit's P0/P1s touch (port lifecycle, the minibuffer fork, the post-intent
  fan-out, restore orchestration, `persistLastSession`) is in that untested glue. Extracting
  the pure parts (`handleMinibufferSubmit`'s fork given a fake spine; `pathsInWindowBlob`;
  `workspaceChooserRows`; `collectSessionWindows`) into an importable module would make ~60% of
  the file testable without Electron.
- **`protocol.js`: 52 tests**, good coverage of every exported helper (delta apply/predict,
  modeline, overlay/cursor normalisation, pane-tree serialise/walk, picker normalise/filter,
  screenful math). Nothing tests message *validation* because there is none (SRV-04).
- **`session-store.js`: 7 tests** — empty store, save/list/get + persistence through re-read,
  `writeLast`, remove (incl. `__last__`), flat-format migration, garbage tolerance. Adequate
  for the pure store; the multi-writer hazard (SRV-08) is out of unit scope by design.
- **`atomic-write-sync.js`: 6 tests** — bytes on disk, overwrite + no-temp-left, failure leaves
  the original + cleans the temp, sweep age-threshold behaviour. Good.
- **`autosave.js`: 10 tests** — key/record shapes, `selectRecoverable` (incl. the
  scratch-duplication regression), `snapshotOnce`, scan round-trip incl. saved-over and
  newer-than-disk cases, missing dir, `clear`. Good; the interval/unref behaviour and
  per-buffer failure isolation inside a pass are untested (minor).
- **`server-view-client.js` (src): ~40 tests** — HELLO, snapshot/mount, key→intent routing,
  delta/cursor/view/overlays/resync application, minibuffer + picker round-trips and
  supersession, buffer-list caching, viewport reporting, destroy cleanup. Solid for the
  message surface. Untested: the `pending` map lifecycle (SRV-09), seq behaviour (none exists,
  SRV-06), port-close behaviour (none exists, SRV-10).
- **`server-bridge.js` (src): factory tests** cover fork config, per-window distinct channels,
  delivery-after-load, dispose idempotence — but not the reload case (SRV-01), which is
  precisely the once-vs-on distinction a fake `webContents` test could pin in five lines.
- `spine.test.js` (2875 lines) exercises the spine directly (other agents' territory) — it does
  not import `server.js`.

## What's solid

- **The atomic-write discipline** is applied consistently at every user-data write site the
  area owns: workspace store, project sidecars, `.godot-metadata`, recovery records, saved
  buffers — all through temp+fsync+rename, with error paths that report rather than throw
  through the spine (`writeFileForSave` never throws; metadata writes swallow + log).
- **`sweepStaleTemps`** with an age threshold is a thoughtful touch that closes the
  orphan-temp accumulation loop without racing live writers.
- **The picker channel's stale-reply guard** (fresh id per open; `deliverPicker` drops
  mismatched ids, `spine.js:5654–5668`) is exactly right and mirrored client-side (superseded
  pickers torn down); the boot workspace-chooser intercept by `pickerId` is clean.
- **Per-buffer delta fan-out + the resync discipline** (multi-cursor and grouped-undo edits
  demoted to whole-buffer RESYNC; `consumeHistoryOp` read-and-cleared every intent so a no-op
  undo can't leak) shows careful replication reasoning, as does skipping snapshots for
  data-source leaves to avoid the sibling-pane scroll rebuild.
- **Client lifecycle bookkeeping**: monotonic never-reused indices, the one-shot bootstrap
  claim (correctly *not* `clients.length === 0`), idempotent detach, scratch reaping guarded to
  empty+path-less+not-last.
- **`sendClientState`'s per-step guards** (the fix under review) are correctly built —
  each of the six paints isolated, PANE_TREE guaranteed a chance to land — and
  `applyNextRestoreWindow` got the same treatment for layout loads.
- **The workspaces.json migration** in `main.js` is right: existsSync-guarded (no overwrite
  when both exist, no re-run), non-destructive (tmpdir copy left as backup), try-wrapped.
- **`normalisePickerRequest`/`normaliseOverlay`/`normaliseCursors`** harden the down-channel
  render path against malformed rows — the one direction that *is* systematically validated.
- **`restoreSession`'s one-window-at-a-time cascade** eliminates HELLO ambiguity among its own
  spawns, and `restoreInProgress` correctly suspends the `__last__` writer so a mid-restore
  persist can't clobber the snapshot being restored from.

## Open questions

1. **Has anyone actually window-reloaded since Model B became the only mode (2026-06-28)?**
   SRV-01's mechanism is probe-certain, but the playbooks describe reload as routine. If Jason
   reloads and it *works*, there is a delivery path I could not find — worth one live
   Ctrl+Cmd+R with the console open (look for the absent "Model-B server port connected" line).
2. **Can a `<webview>` guest reach `app://` or the server port at all?** The editor page's port
   is transferred into the main world (`window.postMessage(…,'*')`); the guest is a separate
   process so it shouldn't see it, but the guest shares the default session unless partitioned —
   whether `protocol.handle('app')` content is loadable inside the webview (and what the
   browser-view partition is) belongs to the webview/main-security agent; flagging the
   cross-ref.
3. **Does `keymap.lisp` gate `handle-key` while `*minibuffer-reader*`/`*key-reader*` is set?**
   Determines whether SRV-15's orphaned reader actually eats the next window's key or merely
   lingers. Needs a Lisp-side read (keymap agent's area).
4. **Is the `WINDOW_BOUNDS`→store→`reconcileBounds` loop fully sanitising?** A hostile bounds
   object round-trips through `workspaces.json` into `win.setBounds` on restore;
   `window-geometry.js` looked like it normalises, but I did not audit it (main-process agent).
5. **`spine.setPaneHostRect` / `setViewport` tolerance** for adversarial shapes (`msg.rect`,
   `msg.lines` pass through with `|| {}` only) — spine agent's area; the server-side coercion
   is thin.

## Stats

- Files read fully: 11 (server.js, protocol.js, client.js, mwb/preload.mjs, launch.js,
  session-store.js, atomic-write-sync.js, autosave.js, server-bridge.js, main.js,
  server-view-client.js) + 6 test files read/skimmed for coverage.
- Cross-referenced (targeted): spine.js (~600 lines across 12 regions), client-buffer.js,
  app.js (4 regions), src/preload.mjs (port section), menu.js, reader.js.
- Live probes: 2 (Electron offscreen; port re-delivery across reload; closed-port +
  non-cloneable postMessage semantics). No app launch; no test suite run; no repo file
  modified other than this report.
- Findings: **1 P0, 3 P1, 9 P2, 7 P3** (20 total).
  - P0: SRV-01. P1: SRV-02 (data loss), SRV-03, SRV-04.
  - P2: SRV-05..SRV-13. P3: SRV-14..SRV-20.
- Confidence split: 15 CONFIRMED, 5 PLAUSIBLE (SRV-07, SRV-08 scenario, SRV-09 impact,
  SRV-15 bleed, SRV-16 impact).
