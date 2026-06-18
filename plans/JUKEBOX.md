# Jukebox → Music Player

Turn the jukebox view from a toy (point it at one folder, get a flat
filename list + play/pause) into a real music player: a recursively-scanned
**library**, a searchable/sortable **track browser**, a play **queue** with
shuffle/repeat, **playlists** (manual + smart), and persisted **stats**
(play counts, ratings, date-added). Same entry point — point it at a folder
(now possibly nested) — but a real app behind it.

Status: PLANNING (2026-06-18). Nothing built yet.

## What we keep (today's foundation)

The current design is well-factored and the load-bearing pieces survive:

- **`<jukebox-view>` custom element** (`packages/renderer/src/jukebox-view.js`)
  — the right vehicle (owns DOM + playback state directly; *not* an
  element-view). We grow it, we don't replace it.
- **Shared audio controller** (`apps/desktop/src/audio.js`) — play/pause/stop,
  `currentTime`/`duration`/`seek`, `currentPath`, `isPlaying`, `onEnded`,
  `attachElement`. A complete transport layer already. The visible
  `<audio controls>` is adopted into it, so the REPL's `audio-*` primitives
  stay truthful.
- **`media://` scheme** (`serve.js`) — `stream:true` + Range pass-through, so
  `<audio>` seeks large files without buffering the whole thing.
- **Embedded-art extraction** — `getEmbeddedArt(path)` (ID3 APIC / MP4 covr),
  async, per-track, already wired into the view.
- **Audio metadata read/write** (`audio-metadata.js` / `-write.js`) — ID3v2,
  MP4/iTunes, Ogg/Vorbis; returns title/artist/album/track/year/genre/
  duration. The write side can edit tags (used later for rating-to-tag, if we
  want it).
- **Lisp surface pattern** (`jukebox.lisp`) — thin: a command + a customizable
  `*jukebox-track-format*` template. We extend this surface, same spirit.

## Three gaps that drive the plan

1. **Scan is one-level, synchronous, eager.** `open-jukebox-buffer!` lists a
   single directory (`listDirectorySync`) and calls `format-track` →
   `audio-metadata` *synchronously per file* before the view mounts. A nested,
   thousand-track library = thousands of blocking IPC round-trips at open. We
   need a **recursive, async, cached** scan.
2. **No FLAC/WAV metadata.** `.flac` passes the suffix filter but has no
   parser, so FLAC libraries show as filenames. FLAC embeds Vorbis comments
   (we already parse those for Ogg) — extractable. Duration for Ogg/FLAC isn't
   computed yet either; the track table needs it.
3. **No persistence.** Close the view and playlists/ratings/play-counts (none
   exist yet) would vanish. We need a durable, per-library store.

## Architecture decisions (the load-bearing ones)

Following the house rule — **Lisp is the customization/macro surface, JS does
the heavy lifting, JS defaults are overridable from Lisp**:

- **Library scan = a new host primitive, async.** Add
  `scan-music-library!(root) → Promise` in the main process (Node
  `fs.readdir` recursion + metadata in a worker/batched), NOT Lisp recursion
  (which would be N synchronous IPC calls). It returns the full track list
  with metadata + duration + an art reference. Heavy lifting in JS.
- **A library model owned host-side, cached to disk.** The buffer stops
  carrying `tracks[]`/`labels[]`; it becomes "this jukebox is rooted at
  ROOT". The library (scan result + persisted stats/playlists) lives in a
  JS model the view queries. This is what lets search/sort/queue/virtualize
  scale.
- **Persistence = one JSON per library in the config dir**, keyed by a hash of
  the root path, via `writeConfigFile` + `atomicWrite`:
  `~/.config/godot/jukebox/<sha1(root)>.json`. Holds the metadata cache (so
  reopening is instant; re-scan is incremental by mtime), playlists, smart-
  playlist definitions, and per-track stats. **Non-destructive** — we don't
  write into the user's audio files (rating-to-tag is an opt-in Phase 4
  extra). Optionally also export/import `.m3u8` so playlists interoperate.
- **Smart playlists are Lisp data.** A rule is an expression over track fields
  + stats, evaluated by a small matcher. This is the Godot-flavoured bit that
  makes it ours, not a generic player (see the DSL below).
- **Keep the dedicated custom element**; grow its DOM and state. Search/filter
  is client-side and instant (the bib-search precedent), no IPC per keystroke.

## Data model

```
Track   { path, rel, title, artist, albumArtist, album, disc, track,
          year, genre, duration, addedAt, hasEmbeddedArt, artPath|null }
Library { root, scannedAt, tracks: Track[], indices (byArtist/byAlbum/byGenre) }
Stats   { [path]: { plays, lastPlayed, skips, rating(0–5), addedAt } }
Playlist      { id, name, kind:'manual', trackPaths: string[] }
SmartPlaylist { id, name, kind:'smart', rule, sort, limit }   // rule = Lisp data
Queue   (runtime) { items: path[], index, shuffle, shuffleOrder, repeat:'off'|'all'|'one' }
```

## Phased plan

Each phase is its own branch → tests green → live-test → merge (recovery tag).
Phases 0–2 deliver "a real player"; Phase 3 delivers "generates playlists";
Phase 4 is optional polish.

### Phase 0 — Foundations (mostly invisible; unblocks everything)
- `scan-music-library!` host primitive: recursive, async, returns Track[] with
  metadata + duration + art refs. Skips dotfiles; follows the suffix set.
- Library cache + incremental re-scan (mtime); the per-library JSON store
  (read on open, atomic write on change). Hash-of-root keying.
- Extend metadata: **FLAC** (Vorbis comments in the FLAC metadata block;
  reuse the Ogg/Vorbis field reader) + **duration** for Ogg/FLAC
  (sample-count ÷ sample-rate). WAV: at least duration from the fmt/data
  chunks.
- Pure, unit-testable: scan dedup/merge, cache-vs-disk reconcile, the new
  parsers (fixture bytes), indexing.

### Phase 1 — The player shell (the big UX leap)
- Rebuild the `<jukebox-view>` layout: **left sidebar** (Library: All / Artists
  / Albums / Genres; Playlists) · **main**: sortable, **virtualized** track
  table (#, Title, Artist, Album, Duration) · **bottom now-playing bar**
  (art thumb, title/artist, prev/play-pause/next, **seek slider + elapsed/total
  times**, shuffle, repeat, volume).
- **Instant search box** filtering the library client-side (title/artist/album).
- **Queue** model + state machine: activate a track → play it and set the queue
  context (the current album / filtered set / playlist); next/prev/auto-advance
  over the queue; shuffle (stable order) + repeat off/all/one.
- Pure, unit-testable: search/filter, sort comparators, the queue state machine
  (next/prev/shuffle/repeat/auto-advance), duration formatting.

### Phase 2 — Playlists
- Manual playlists: create / rename / delete; add track(s) or a whole album;
  reorder; "play playlist" (loads the queue); "add to queue" / "play next".
- Persist to the library JSON; **import/export `.m3u8`** (relative paths) for
  interop.
- Pure, unit-testable: playlist CRUD, m3u parse/serialize, add/reorder ops.

### Phase 3 — Library intelligence + smart playlists (the "generate" promise)
- Stats: play count, last-played, skip count, date-added — updated on
  play/`ended`/skip, persisted. Ratings (0–5) per track.
- **Smart playlists as Lisp rules** (matcher + sort + limit). Built-ins:
  Recently Added, Most Played, Recently Played, Top Rated, Random Mix —
  plus user-defined in `init.lisp`. A "generate playlist from this
  artist/album/genre" command.
- Pure, unit-testable: the rule matcher (every predicate), sort+limit, stats
  updates, the built-ins against a fixture library.

### Phase 4 — Optional polish (pick à la carte later)
Album-grid browse · gapless / crossfade · ReplayGain or Web-Audio volume
normalisation · in-app **tag editor** (the write API exists) · rating-to-tag
sync · folder-watch auto-rescan · drag-a-folder-to-open · recent-libraries
landing · scrobble/export.

## Lisp surface (extends `jukebox.lisp`)

- **Commands**: `jukebox` (now opens the library at a root), `jukebox-search`,
  `jukebox-rescan`, `jukebox-queue`, `jukebox-play-album`, `jukebox-rate`,
  `jukebox-playlist-new` / `-add` / `-play` / `-delete`, `jukebox-export-m3u`.
- **defcustoms** (in the existing `'jukebox` group): track-format (have it),
  visible **columns**, default **sort**, default shuffle/repeat, scan suffixes,
  art filenames, library-cache location.
- **Smart-playlist DSL** — the signature Godot touch:

```lisp
(define-smart-playlist "Recently added jazz"
  :match (and (genre? "Jazz") (added-within-days 30))
  :sort  '(added . desc)
  :limit 50)

;; predicates over a track + its stats:
;;   (artist? "…") (album? "…") (genre? "…") (year-between 1990 1999)
;;   (added-within-days N) (played-at-least N) (rating>= N) (loved?)
;;   plus and / or / not
```

The matcher lives in JS (fast over a big library); the *rules* are Lisp data
the user writes — JS engine, Lisp customization surface, exactly the project's
model. It also doubles as the "generate a playlist" engine.

## Open decisions for Jason

1. **Library state location** — recommend the config-dir JSON (non-destructive,
   fast, one file per library). Alternative: write ratings/play-counts into the
   audio files' tags (portable across players, but mutates the user's files).
   Recommend: JSON now, optional tag-sync in Phase 4.
2. **FLAC/WAV scope** — extend metadata to FLAC (worth it for a "serious"
   player; moderate work) and at least WAV duration? Recommend yes for FLAC.
3. **Browse model** — table-first (iTunes-ish columns) vs album-grid-first
   (Apple-Music-ish). Recommend table-first in Phase 1, grid as a Phase 4 view.
4. **Scope/sequencing** — Phases 0–2 = a real player; Phase 3 = the playlist-
   generation Jason asked for. Confirm that ordering, or pull Phase 3 stats
   forward if "generate playlists" is the priority.

## Testing

The repo has **no jsdom** — DOM/playback/seek/virtualization are live-tested
(the PDF-pinch / jukebox precedent). But the *engine* is overwhelmingly pure
and unit-testable without a DOM: the scan merge/cache reconcile, the new
metadata parsers (fixture bytes), search/sort, the queue state machine, m3u
parse/serialize, playlist ops, the smart-playlist matcher, stats updates,
duration formatting. Aim to land each phase with its pure core fully covered
and only the surface live-tested — same discipline as the rest of the codebase.
