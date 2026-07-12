# Desktop utility modules (audio, sticky-notes, sessions, faces, projects) — audit

**Auditor:** audit agent 7 of 13 (read-only)
**Date:** 2026-07-01
**Repo:** /Users/jalex/Source/jmacs/main @ main (efe0fa6d), suite green (3290)
**Method:** full read of each target file; byte-math traced by hand; callers traced through `app.js` / `files.js` / `preload.mjs` / `mwb/`; targeted `positionAt` throw confirmed with a one-off `node` harness against the real storage buffer.

## Scope

| File | Lines | Role | Verdict |
|---|---|---|---|
| audio-metadata-write.js | 1066 | Tag WRITE (MP3/MP4/Ogg), rebuild-everything | Byte math sound on well-formed input; durability + Ogg-fidelity gaps |
| audio-metadata.js | 804 | Tag PARSE (ID3v2/v1, MP4, Ogg/Opus) | Robust against hostile input (bounded, proto-safe) |
| audio-art.js | 354 | Embedded artwork extract | Bounded, safe |
| audio.js | 136 | Playback wrapper | Fine |
| sticky-notes.js | 747 | Overlay notes + anchor math + persistence | **P1 stale-anchor crash; no cross-session relocation** |
| session.js | 642 | Pane-tree session serialise/restore | **Pre-Model-B residue — inert in server mode** |
| bookmarks.js | 190 | Named marker positions | Clamps + relocates correctly |
| bookmark-relocate.js | 156 | Cross-session bookmark relocation | Solid |
| project-chooser.js | 408 | Launcher modal | No injection; fine |
| project-index.js | 158 | Pure catalogue helpers | Fine |
| move-view-state.js | 230 | Swap/permute state machine | Fine |
| move-view-mode.js | 198 | Overlay for the above | Fine |
| add-pane-mode.js | 180 | Add-pane overlay | Fine |
| element-spec.js | 145 | Element-view registry/URL policy | Fine |
| math-preview-host.js | 109 | Minor-mode membership seam | Fine |
| mode-menu-build.js | 117 | Mode-menu assembly | Fine |
| face-styles.js | 339 | Face map → CSS `<style>` | **P2 CSS injection (values unescaped)** |
| face-overrides.js | 328 | faces.json ⇄ Lisp shape | Fine (migration OK) |
| bdsk-file.js | 166 | BibDesk attachment resolve (JXA) | No shell injection; minor open-exec hardening |
| metadata.js | 65 | Sidecar path + emptiness rule | Fine |

## Executive summary (worst first)

The audio **write** path — the highest-stakes territory, since it rewrites a user's music files — is fundamentally sound. Every writer follows the plan's "parse → mutate → re-serialise → temp+rename" model, never patches in place, and the byte math (syncsafe encode/decode symmetry, UTF-8 text frames, MP4 `ilst` splice + `stco`/`co64` delta patching, Ogg page/segment/CRC assembly) checks out for **well-formed** files. I found **no P0 silent-corruption path on a normal file** in any of the three format writers. That is the headline.

The real findings are around the edges:

1. **DESK-01 (P1, CONFIRMED):** sticky-note anchors are **never clamped or relocated across sessions**. A note whose stored `anchor` exceeds the current buffer length (the file was shortened by another tool between sessions) makes `place()` call `buffer.positionAt(anchor)`, which **throws `RangeError`**, and the throw propagates out of the un-guarded `applyTextMountSideEffects` → `mountKindView` mount path. Bookmarks solve exactly this with `bookmark-relocate.js`; sticky notes have no equivalent.

2. **DESK-02 (P2, CONFIRMED):** the audio writer's private `writeAtomic` does **not `fsync`** before the rename, unlike the shared `atomic-write.js` it was factored from. The original is never in-place-truncated, but a power-loss window can leave the new music file unflushed.

3. **DESK-03 (P2, CONFIRMED):** the Ogg writer **silently drops embedded cover art** (and every other non-surfaced comment), where the MP3 and MP4 writers deliberately re-preserve it. Its own doc-comment claims the opposite.

4. **DESK-04 (P2, CONFIRMED):** `face-styles.js` interpolates `foreground` / `background` / `family` / `size` / `weight` / `slant` **values into the `<style>` block with no escaping or validation** — a CSS-injection surface fed straight from the persisted `faces.json`.

5. **Architecture:** `session.js` is **pre-Model-B residue**. In the shipping (server) config every one of its effectful methods is bypassed (`NULL_SESSION` + a `serverMode` guard on restore), and its only remaining live consumers — `openProject` / `closeProject` — are themselves dead (project opening is server-authoritative via `PROJECT_OPEN`). Real session persistence lives in `mwb/session-store.js`.

## Findings

### DESK-01: Sticky-note anchors are never clamped/relocated across sessions → `positionAt` throws on mount

- **Severity:** P1
- **Dimension:** Correctness / data-safety (external-edit anchor math)
- **Location:** `apps/desktop/src/sticky-notes.js:216` (`place` → `buffer.positionAt(note.anchor)`); load with no clamp at `sticky-notes.js:193` (`notes()`) and `setBuffer` at `:564`; mount call site `apps/desktop/src/app.js:6470` inside `applyTextMountSideEffects` (`:6415`), reached un-wrapped from `mountKindView` (`:6500`) and `mountTablineActiveChild` (`:7108`). Throw source: `packages/storage/src/buffer.js:309` `positionAt` → `assertOffset` (`:83`).
- **Evidence:** Notes are loaded verbatim from the JSON sidecar (`app.js:1913` `buffer.metadata = metadata`). `place()` does `const { line } = buffer.positionAt(note.anchor);` with no bounds guard. `positionAt` calls `assertOffset`, which throws `RangeError` for `offset > text.length`. Confirmed against the real buffer:
  ```
  createBuffer("short").positionAt(999)
  → RangeError: offset 999 out of range [0, 5]
  ```
  `adjustAnchor` (`sticky-notes.js:47`) keeps anchors in-bounds during a live session, but there is **no clamp and no context relocation on load**. Contrast `bookmarks.js:108-112`, which runs `relocate(text, record)` (clamped in `bookmark-relocate.js:61` via `Math.min(anchor, n)`) before creating each marker.
- **Failure scenario:** User puts a sticky note near the end of `chapter.md`, quits Godot, edits `chapter.md` in another editor and deletes a large trailing section, reopens it in Godot. On mount, the first note whose `anchor` now exceeds the file length throws out of `place()`; the exception unwinds through `applyTextMountSideEffects`/`mountKindView` (neither wraps it), aborting the text-view mount side-effects (sticky overlay, bookmarks bind, inline-eval overlay, focus). A hand-edited or from-the-future sidecar (float/huge `anchor`) triggers the same throw (`assertOffset` also rejects non-integers). No on-disk corruption — the failure is on read, before any write.
- **Fix direction:** Clamp on load and add a relocation net symmetric with bookmarks: in `notes()`/`setBuffer`, clamp each `note.anchor` to `[0, buffer.length]` (and coerce to integer), or reuse `bookmark-relocate.js`'s `captureContext`/`relocate` (store front/rear context on notes too). At minimum wrap the per-note `place()` in a try/catch so one bad anchor can't abort the whole mount.
- **Confidence:** CONFIRMED (throw mechanism traced end-to-end and reproduced; exact user-visible blast radius of the unwind is PLAUSIBLE — at least the notes overlay fails, likely the rest of the mount side-effects too).

### DESK-02: Audio writer's `writeAtomic` omits `fsync` (durability gap vs. the shared atomic writer)

- **Severity:** P2
- **Dimension:** Correctness / data-safety (durability)
- **Location:** `apps/desktop/src/audio-metadata-write.js:1041` `writeAtomic` (used by `writeMP3Sync:236`, `writeMP4Sync:650`, `writeOGGSync:1030`).
- **Evidence:**
  ```js
  function writeAtomic(path, data) {
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, data);          // no fsync
    try { renameSync(tmpPath, path); }
    catch (error) { try { unlinkSync(tmpPath); } catch {} throw error; }
  }
  ```
  The shared `apps/desktop/src/atomic-write.js:47` explicitly `await handle.sync()` before the rename "so a power loss right after the rename can't surface an empty/partial file." The audio copy — writing the *larger, harder-to-recreate* files — skips that flush. The comment claims crash-safety, which holds for a **process** crash (rename is atomic once both entries are in the page cache) but not for **power loss** (data blocks may not be durable when the rename becomes durable).
- **Failure scenario:** Power loss in the narrow window after `renameSync` returns but before the data pages are flushed can leave `song.mp3` present-but-zero/partial on filesystems that don't order data before rename metadata. The *original* is never at risk (temp+rename), so worst case is old-intact-or-new-unflushed — but the new file can be damaged.
- **Fix direction:** Route all three writers through the shared `atomicWrite` (it fsyncs, uses a hidden `.NAME.tmp-…` temp, and cleans up on failure), or add `fs.fsyncSync(fd)` before the rename here. This also fixes the cosmetic temp-litter point (DESK-10).
- **Confidence:** CONFIRMED (no `fsync`/`sync` call anywhere in the audio module).

### DESK-03: Ogg tag write silently drops embedded cover art (inconsistent with MP3/MP4)

- **Severity:** P2
- **Dimension:** Correctness / data-fidelity (silent loss of embedded user data)
- **Location:** `apps/desktop/src/audio-metadata-write.js:922` `serialiseOGG` + `:797` `buildVorbisCommentPacket`; reader gap at `audio-metadata.js:785` `extractOGGMetadata` (never surfaces `METADATA_BLOCK_PICTURE`).
- **Evidence:** `serialiseOGG` reads the original comment packet **only to recover the vendor string** (`:948-955`) and then rebuilds the comment packet entirely from `fields` (`newComment = buildVorbisCommentPacket(fields, { vendor })`, `:956`). `fields` originates from the renderer's cached metadata (`app.js` `applyAudioMetadataEdit` → `stripDerivedFields`), which only ever holds title/artist/album/track/year/genre + user-added custom keys — **never** `METADATA_BLOCK_PICTURE`, because `extractOGGMetadata` doesn't extract it. So every non-surfaced Vorbis comment (cover art, ReplayGain, MUSICBRAINZ_*, COMPOSER already in the file, …) is dropped on any Ogg tag edit. The module's own doc-comment (`:677-681`) asserts cover art "survives a write naturally — the writer treats it as just another comment field," which is **false** on this code path. MP3 (`writeMP3Sync:229-234`) and MP4 (`serialiseMP4:587-591`) both re-extract and re-embed the existing APIC/`covr`; Ogg has no equivalent.
- **Failure scenario:** User edits the title on an `.ogg` that carries an embedded cover → the cover (and any other non-standard comments) is gone from the file after save, silently.
- **Fix direction:** In `serialiseOGG`, parse the original comment packet's entries and carry forward any field not overwritten by `fields` (at minimum `METADATA_BLOCK_PICTURE`), mirroring the MP3/MP4 cover re-preservation. Also correct the misleading doc-comment.
- **Confidence:** CONFIRMED (no cover round-trip test exists for Ogg; the only `serialiseOGG` tests are text round-trips + CRC — `apps/desktop/test/audio-metadata-write.test.js:890-1005`).

### DESK-04: `face-styles.js` interpolates face values into `<style>` unescaped → CSS injection from persisted config

- **Severity:** P2
- **Dimension:** Security (DOM/CSS injection from a persisted/synced config file)
- **Location:** `apps/desktop/src/face-styles.js:115` `faceDeclarations` (and `cssWeight:58`, `cssSlant:68`, `cssSize:80`, `valueToString:46`), emitted via `generateFaceCss:155` / `generateModeFaceCss:202` / `generateBaseFaceCss:181`, written to the DOM by `writeFaceStyleElement:286` (`element.textContent = css`). Live wiring: `mwb/spine.js:2811` `faceStylesCss(current-face-styles, …)` → `faces-apply` directive → `app.js:3735` `writeFaceStyleElement(document, String(args?.[0]))`.
- **Evidence:** The mode-name **selector** is escaped (`cssAttrValue:142`), but the **values** are not:
  ```js
  const fg = valueToString(attrs.get('foreground'));
  if (fg !== null) decls.push(`color: ${fg};`);          // raw
  const family = valueToString(attrs.get('family'));
  if (family !== null) decls.push(`font-family: ${family};`); // raw
  ```
  A `foreground` such as `red } body{display:none} .x{` closes the `.tok-…` rule and injects arbitrary rules; a `family`/`background` containing `url(https://evil/x)` fires a network request from the privileged `app://` origin. These values flow from `faces.json` (`face-overrides.js jsonToLispOverrides` → `*face-overrides*` → resolved styles), i.e. a persisted config that could be shared/synced as a "theme."
- **Failure scenario:** User imports someone's `faces.json` theme (or a synced dotfile) whose `default.family` is `"x; } * { background: url(//tracker/beacon) }"`. On load the spine bakes it into the CSS string, the renderer injects it, and the beacon fires / UI can be spoofed. Blast radius is CSS-only (Chromium won't execute JS from CSS), but url() exfiltration and UI spoofing on a privileged page are real.
- **Fix direction:** Validate each value before interpolation — colours via `CSS.supports('color', v)` (the sticky-notes `applyColor:269` already does exactly this), and reject any value containing `;`, `{`, `}`, `<`, or `url(` for family/size/weight/slant. Prefer setting properties on a scratch `CSSStyleDeclaration` and reading them back, which drops invalid values, over string concatenation.
- **Confidence:** CONFIRMED (values traced unescaped from faces.json to `<style>`; no injection test in `apps/desktop/test/face-styles.test.js`).

### DESK-05: `session.js` and in-renderer `openProject`/`closeProject` are dead in the shipping (Model B) config

- **Severity:** P3 (dead code / architecture — no runtime bug)
- **Dimension:** Architecture (pre-Model-B residue, duplication with `mwb/session-store.js`)
- **Location:** `apps/desktop/src/session.js` (whole module); consumers `app.js:8698` `sessionController`, `:8919` `openProject`, `:8987` `closeProject`, `:8940` `projectSession`.
- **Evidence:** `preload.mjs:20` hard-codes `serverMode: true` and MEMORY confirms the flag-off path is retired. In server mode: (a) `activeSession()` returns `NULL_SESSION` (`app.js:8730-8745`), so every `save`/`flush` no-ops; (b) `sessionController.restore()` is guarded by `if (!(window.host && window.host.serverMode))` (`app.js:9055-9058`), so restore never runs. The remaining consumers of `createSession` are `openProject`/`closeProject`, but `openProject` has **no live caller** — the chooser's `openProject` callback and `open-project-dialog` both route through `requestOpenProject` (`app.js:8848`), which posts `MSG.PROJECT_OPEN` to the server (server-authoritative project windows). The genuinely-live session persistence is `mwb/session-store.js` (`createSessionStore`, v3 workspaces store) wired at `mwb/server.js:86`, plus the server seeding from `session.json` via `MWB_SESSION_SEED` (`main.js:423`, `server.js:1914`).
- **Failure scenario:** None at runtime — it's inert. The cost is maintenance drift: 46 green tests in `session.test.js` keep `session.js` looking authoritative, and a reader touching "session restore" can waste time in the wrong file. `serialise`/`serialiseTree`/`deserialise`/`migrateV1` are dead in production.
- **Fix direction:** Remove `session.js` + its `app.js` wiring (`sessionController`, `openProject`, `closeProject`, `projectSession`, `sessionOptions`, `restoreInto`) and its tests, or, if kept for a possible non-server mode, add a header stating it is inert under Model B and pointing at `mwb/session-store.js`. Verify nothing else imports it first (only `app.js` does today).
- **Confidence:** CONFIRMED (server-mode guards + `NULL_SESSION` + the `PROJECT_OPEN` routing all traced; `openProject`/`closeProject` have no live call site).

### DESK-06: MP3 `findMP3AudioStart` ignores v2.4 footer / unsync, keying only on the "ID3" magic

- **Severity:** P3
- **Dimension:** Correctness (rare-format fidelity)
- **Location:** `apps/desktop/src/audio-metadata-write.js:190` `findMP3AudioStart`, `:200` `stripID3v1`.
- **Evidence:** `findMP3AudioStart` returns `10 + tagSize` whenever bytes 0-2 are "ID3". The v2.4 tag **footer** (header flag `0x10`, a trailing 10-byte "3DI…" block) is *not* counted in `tagSize`, so on a footer-bearing file the returned offset lands 10 bytes early and the footer bytes get prepended to the "audio" and preserved in output (malformed; most decoders resync past it). Likewise a trailing ID3v1 *extended* ("TAG+", 227 bytes preceding the 128-byte TAG) and APEv2 tags are not stripped and ride along in the copied audio. All are rare in music-library files, and the rebuild otherwise preserves the audio stream verbatim.
- **Failure scenario:** Editing a tag on an MP3 written with a v2.4 footer yields a technically-malformed (but usually still-playable) file.
- **Fix direction:** If bit `0x10` is set in the header flags, add 10 to the skipped length; optionally detect/strip "TAG+" and APEv2. Low priority.
- **Confidence:** PLAUSIBLE (footer files are rare; not reproduced against a real fixture).

### DESK-07: MP4 container-size patch assumes 32-bit box sizes

- **Severity:** P3
- **Dimension:** Correctness (latent, unrealistic input)
- **Location:** `apps/desktop/src/audio-metadata-write.js:601-605` (the `moov`/`udta`/`meta` size-patch loop).
- **Evidence:** The loop does `readUInt32BE(newMoov, offsetInMoov)` / `writeUInt32BE(…, oldSize + delta)` on each container's size field. `listBoxes` (`:290`) correctly handles 64-bit sizes (`size===1`, `headerSize 16`), but the patch loop does not: for a container using the 64-bit form, the 4 bytes at `offset` are the literal `0x00000001`, so `oldSize+delta` corrupts the marker and leaves the real 8-byte size at `offset+8` unpatched.
- **Failure scenario:** A `moov`/`udta`/`meta` with a 64-bit extended size would be re-sized incorrectly. In practice only `mdat` ever needs 64-bit sizing, so this never fires on real music.
- **Fix direction:** Detect `size===1` at each patched box and update the 8-byte size (or assert 32-bit and fail loudly). Note only.
- **Confidence:** CONFIRMED (code path is 32-bit-only) / impact PLAUSIBLE-but-negligible.

### DESK-08: `findChunkOffsetAtoms` doesn't bound `entryCount` against the atom size

- **Severity:** P3
- **Dimension:** Security / robustness (malformed input)
- **Location:** `apps/desktop/src/audio-metadata-write.js:510` `findChunkOffsetAtoms` (`entryCount = readUInt32BE(buf, bodyStart + 4)`, `:527`) → consumed by `patchChunkOffsets` (`:543`).
- **Evidence:** `entryCount` is read straight from the file and not checked against `(atom.end - entriesStart) / entrySize`. `patchChunkOffsets` then loops `entryCount` times. Out-of-range `readUInt32BE` returns 0 (undefined bytes) and out-of-range `Buffer` index writes are silent no-ops in Node, so there is **no crash and no OOB write past the buffer**, but a corrupt `stco`/`co64` `entryCount` could scribble patched values across adjacent `moov` bytes within `newMoov`.
- **Failure scenario:** Rewriting an already-malformed MP4 (bad chunk-offset table) could further mangle its `moov`. The file was already broken; this isn't reachable from a well-formed file.
- **Fix direction:** Clamp `entryCount` to what fits in the atom before iterating.
- **Confidence:** CONFIRMED (no bound); impact limited to malformed inputs.

### DESK-09: `.opus` reads tags but cannot write them

- **Severity:** P3
- **Dimension:** Correctness (feature asymmetry)
- **Location:** read `audio-metadata.js:29` (`.opus → ogg`); write `audio-metadata-write.js:261` (only `.ogg`/`.oga` → `writeOGGSync`).
- **Evidence:** Opening an `.opus` file surfaces tags (extractor handles OpusTags, `parseVorbisComments:742`), but a tag edit returns `unsupported format: .opus`. This is the *safe* asymmetry — good that `.opus` is excluded from `writeOGGSync`, because `serialiseOGG` builds a Vorbis (not Opus) header structure and would throw "not a Vorbis identification packet" (`:942`) rather than corrupt. Still a rough edge: the edit UI is offered for a file that can't be saved.
- **Fix direction:** Either grey out editing for `.opus`, or add an Opus serialiser (OpusHead/OpusTags, 2 header packets).
- **Confidence:** CONFIRMED.

### DESK-10: Audio temp files are non-hidden and litter the music folder on a crash

- **Severity:** P3
- **Dimension:** Correctness (cosmetic / cleanliness)
- **Location:** `audio-metadata-write.js:1042` (`${path}.tmp.${pid}.${Date.now()}`).
- **Evidence:** The temp name has no leading dot, so a process crash between `writeFileSync` and `renameSync` leaves a visible `song.mp3.tmp.1234.567` in the user's library (the jukebox's `directory:list` filters dotfiles, so a hidden temp would be invisible). The shared `atomic-write.js:38` uses a hidden `.NAME.tmp-…` name.
- **Fix direction:** Subsumed by DESK-02 (switch to the shared `atomicWrite`, which is hidden + fsynced).
- **Confidence:** CONFIRMED.

### DESK-11: A user-added custom key named `cover` silently drops the embedded art

- **Severity:** P3
- **Dimension:** Correctness (edge-case fidelity)
- **Location:** `audio-metadata-write.js:229` (`writeMP3Sync` cover-preservation guard) + `buildID3v24Frames:159` / `buildIlstAtom:473` (cover shape check + `consumed` set).
- **Evidence:** The plus-pill lets the user add an arbitrary key (`packages/renderer/src/audio-view.js:179`). If a user adds key `cover` with a string value, `writeMP3Sync`'s guard `if (!('cover' in fields) || fields.cover === undefined)` is false, so the existing APIC is **not** re-extracted; and `buildID3v24Frames` requires `typeof fields.cover === 'object'` for the APIC branch while `cover` is in `consumed`, so the string is not written as a TXXX either. Net: the file's embedded cover is lost and the user's `cover=…` vanishes.
- **Fix direction:** Reserve/normalise the `cover` key (it's not a text tag), or only treat `cover` as the art slot when it's an object; write other-typed `cover` as a TXXX.
- **Confidence:** CONFIRMED (reasoned through the guards).

### DESK-12: `bdsk-file.js` `isOpenableFile` accepts executables → a crafted bookmark could be `open`-executed

- **Severity:** P3
- **Dimension:** Security (hostile `.bib` / `.bdsk`, mild code-exec hardening)
- **Location:** `apps/desktop/src/bdsk-file.js:101` `isOpenableFile` → `files.js:1047` `shell.openPath(path)`.
- **Evidence:** The JXA call itself is injection-safe: `execFile('osascript', ['-l','JavaScript','-e', JXA_RESOLVE, '--', b64], …)` uses an args array (no shell) and `b64` is a positional data arg. The guard `statSync(path).isFile()` blocks directories/`.app` bundles but **not** a plain executable file. A hostile `.bib` whose `Bdsk-File-N` bookmark resolves to an *existing* local executable (e.g. a script the attacker planted or a known system binary) would pass `isFile()`, and `shell.openPath` invokes the OS default handler — on macOS, `open` on an executable can run it.
- **Failure scenario:** User opens an untrusted `.bib` in bib-search and clicks an entry whose attachment bookmark points at an existing executable → it runs. Requires the target to already exist on disk and a user click, so exposure is modest.
- **Fix direction:** Additionally reject files with the exec bit set / non-document UTIs, or restrict to a document-type allowlist before `shell.openPath`.
- **Confidence:** PLAUSIBLE (depends on an attacker-referenced existing executable + user click).

### DESK-13: Syncsafe/frame/tag sizes overflow silently above ~256 MB

- **Severity:** P3
- **Dimension:** Correctness (latent, unrealistic input)
- **Location:** `audio-metadata-write.js:53` `encodeSyncsafeInt32`, `:112` `buildApicFrame`, `:174` `serialiseID3v24Tag`.
- **Evidence:** A 4-byte syncsafe int holds 28 bits (max 268,435,455 ≈ 256 MB). `encodeSyncsafeInt32` silently truncates above that (no validation), and JS `>>` coerces to int32 first, so an APIC payload or total tag size beyond ~256 MB would encode a wrong size and produce a corrupt tag. Only reachable with a pathologically large embedded cover; normal covers are < a few MB.
- **Fix direction:** Range-check before encoding and fail the write with a clear error rather than emit a bad size.
- **Confidence:** CONFIRMED (math) / negligible in practice.

## Architecture observations

- **`session.js` disposition — residue (see DESK-05).** It is imported and instantiated in `app.js` but every effectful method is short-circuited under `serverMode: true`: saves route to `NULL_SESSION`, restore is guarded off, and its last non-test consumers (`openProject`/`closeProject`) are themselves dead because project opening is server-authoritative (`requestOpenProject` → `MSG.PROJECT_OPEN`). The authoritative session code is `mwb/session-store.js` (v3 named-workspace store, migrates the old flat `{files,active}` into `lastSession`, atomic pretty-printed write) + the server's `MWB_SESSION_SEED` bootstrap. Removing `session.js` (and its `app.js` wiring/tests) would delete ~640 lines of misleading-but-green code with no runtime effect; the only guard is confirming no importer beyond `app.js`.
- **Two atomic-write implementations.** `atomic-write.js` (fsync, hidden temp, async) and the private `writeAtomic` in `audio-metadata-write.js` (no fsync, visible temp, sync) have diverged. The audio one guards the most valuable files but is the weaker of the two (DESK-02/DESK-10). Consolidating on the shared writer (a sync fsynced variant already exists as `atomicWriteSync` per `mwb/session-store.js`'s note) removes the divergence.
- **Cover-art preservation is per-format ad hoc.** MP3 and MP4 each re-extract-and-re-embed art (`extractID3v2APIC`/`extractMP4Covr`), Ogg does neither (DESK-03). A single "carry forward embedded art" seam in the writer would make the three symmetric and match the plan's intent that "cover-art editing falls out for free."
- **Anchor/relocation is solved once (bookmarks) and unsolved once (sticky notes).** `bookmark-relocate.js` is a clean, tested, three-tier (exact-straddle → one-sided → fuzzy-Levenshtein) relocation net. Sticky notes carry no context and no clamp (DESK-01). The relocation logic is generic enough to share.
- **Good separation elsewhere.** `move-view-state.js` (pure state machine) vs `move-view-mode.js` (DOM), `mode-menu-build.js`, `element-spec.js`, `project-index.js`, `math-preview-host.js` are all cleanly split pure-core / imperative-shell and unit-tested directly. `element-spec.js`'s `resolveElementModuleUrl` correctly refuses to treat a non-`app://`/`http`/`media` spec as anything but a repo-relative `app://editor/` path (the `app://` handler enforces the root jail), so a persisted `:module` can't load off-origin.

## Test coverage

- **Strong:** `audio-metadata-write.test.js` (~50 tests) covers syncsafe symmetry, UTF-8 round-trips, MP3 audio-stream byte-preservation, ID3v1 drop, MP4 `stco` patch (moov-before-mdat and moov-after-mdat), mdat byte-for-byte, and MP3/MP4 **cover preservation**. `audio-metadata.test.js` (25) + `audio-art.test.js` (21) exercise the parsers. `bookmark-relocate.test.js` (8, all three tiers), `bookmarks.test.js` (8, incl. "reopen after external edit"), `session.test.js` (46), `project-index.test.js` (18), `move-view-state.test.js` (17), `element-spec.test.js` (15), `face-styles.test.js`/`face-overrides.test.js` (21/17), `mode-menu-build.test.js` (6), `math-preview-host.test.js` (13), `project-chooser.test.js` (9), `bdsk-file.test.js` (8) all present.
- **Gaps that map to findings:**
  - **No Ogg cover-art round-trip test** — masks DESK-03 (only text/CRC round-trips exist).
  - **No sticky-note test for a stale/out-of-range anchor on load** — `sticky-notes.test.js` tests only the pure `adjustAnchor` math, never `place()`/`positionAt` with an anchor > buffer length (DESK-01). Bookmarks *do* test the reopen-after-shrink case; sticky notes don't.
  - **No face-value injection/escaping test** — `face-styles.test.js` only uses benign values, so DESK-04 is uncovered.
  - **No crash/fsync/atomicity test** for the audio writer (DESK-02) — hard to unit-test, but a "temp file cleaned up on rename failure" test is feasible.
  - **`session.js` carries 46 tests for a module inert in production** (DESK-05) — coverage without corresponding runtime.

## What's solid

- **The audio write design.** Rebuild-everything (parse → mutate → re-serialise → temp+rename) is the right call and is implemented faithfully. I found **no P0 corruption path on a well-formed MP3/MP4/Ogg** doing a normal edit. Syncsafe encode/decode are exact inverses under 2^28; MP3 output is a clean v2.4 tag + verbatim audio; MP4 splices a fresh `ilst`, patches `moov`/`udta`/`meta` sizes and all `stco`/`co64` tables by the correct delta (with the right zero-delta short-circuit when `moov` sits after `mdat`), and copies `mdat` untouched; the 64-bit chunk-offset arithmetic (`total & 0xffffffff` re-read through `>>>` in `writeUInt32BE`) is correct despite the int32 coercion.
- **Hostile-tag parsing is genuinely defensive.** Every parser loop advances by a strictly-positive step and bounds every read against `min(buf.length, declaredEnd)`, so a 2 GB-claimed frame/`tagSize`/`commentCount` cannot over-allocate (allocations are capped at file size), over-read (`subarray` clamps), or loop forever. Vorbis-comment keys are upper-cased before use, which incidentally neutralises `__proto__`/`constructor` prototype-pollution, and metadata is only ever assigned to fixed fields via `switch`. The uniform try/catch → `null` in `extractFromBytes` is a good backstop.
- **Atomicity of the *original* file.** All user-file writes (audio + `.godot-metadata` sidecar via `metadata:write` → shared `atomicWrite`) are temp+rename; no writer truncates a user file in place. The sidecar writer is versioned (`METADATA_VERSION`), migrates the legacy `.jmacs-metadata`, and deletes empty husks correctly (`isEmptyMetadata` is generic so one feature emptying can't drop another's data).
- **`bookmark-relocate.js`** is a model of the kind of relocation net sticky notes should adopt.
- **`bdsk-file.js`** avoids shell injection (arg-array `execFile`, `b64` as data), caches results, and is macOS-gated with a graceful null on failure.
- **`project-chooser.js` / `project-index.js`** do no filesystem walking (pure list shaping + a modal), use `textContent`/`dataset`/computed `hsl()` (no HTML/CSS injection), and guard async thumbnail loads with a render token. No symlink-recursion cliff lives here (directory listing is the non-recursive `directory:list` in `files.js`).

## Open questions

1. **Sticky-note relocation (DESK-01):** should notes gain full context relocation (reuse `bookmark-relocate.js`) or is a clamp-on-load + per-note try/catch acceptable? A clamp alone would silently pile stale notes at EOF; relocation would move them sensibly. Architect's call on fidelity vs. effort.
2. **Ogg cover carry-forward (DESK-03):** preserve only `METADATA_BLOCK_PICTURE`, or carry forward *all* non-surfaced comments (aligning Ogg with a "preserve unknown" policy that MP3/MP4 explicitly *don't* follow)? The plan says fidelity loss is deliberate — but not for cover art.
3. **`session.js` removal (DESK-05):** delete outright, or retain behind a documented "inert under Model B" header in case a non-server mode is ever revived? Confirm no importer beyond `app.js`.
4. **Face-value validation (DESK-04):** is `CSS.supports`-style validation (as sticky notes already do for colours) sufficient, or should faces.json be treated as fully trusted (single-user assumption) and the finding downgraded? Depends on whether themes/configs are ever shared or synced from untrusted sources.

## Stats

- Files audited: 20 (target set) + traced callers in `app.js`, `files.js`, `preload.mjs`, `mwb/spine.js`, `mwb/server.js`, `mwb/session-store.js`, `packages/storage/src/buffer.js`, `packages/renderer/src/audio-view.js`.
- Findings: 13 — **P0: 0 · P1: 1 · P2: 3 · P3: 9**
- By dimension: Correctness/data-safety 6 (DESK-01,02,06,07,11,13) · Data-fidelity 1 (DESK-03) · Security 3 (DESK-04,08,12) · Architecture/dead-code 1 (DESK-05) · Feature-asymmetry/cosmetic 2 (DESK-09,10)
- Confidence: CONFIRMED 10 · PLAUSIBLE 3 (DESK-06,12, and the blast-radius of DESK-01)
- Highest-stakes file (`audio-metadata-write.js`): no P0; byte math sound on well-formed input; issues are durability (fsync), Ogg cover fidelity, and rare-format edges.
- One-off harness used: confirmed `createBuffer("short").positionAt(999)` throws `RangeError` (DESK-01). No app launch; no `pnpm test` run.
