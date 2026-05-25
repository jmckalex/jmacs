# Plan — Editable audio metadata

**Status: planned, not started.** A detailed design for review.

## Context

`apps/desktop/src/audio-metadata.js` ships ~800 lines of *read-only*
extractors: `extractMP3Metadata` parses ID3v2/v1, `extractMP4Metadata`
walks the atom tree to find `moov/udta/meta/ilst`, `extractOGGMetadata`
unpacks the Vorbis comment packet. The audio view (`packages/renderer/
src/audio-view.js`) renders the result as a definition list inside
`.audio-meta`, with the title and a synthesised subtitle above.

What's missing: writers. None of the three containers can be modified
from inside the editor today. The user has asked for the audio view to
become an editing surface — double-click a value to change it, a per-row
remove button, a plus pill to add a new key/value pair — with the
result written back to the file on disk.

This document is the design for that work. It covers the user model,
the editable-vs-derived split, the host-side writer architecture, the
Lisp primitive surface, the per-format specifics (the hard part), and
the sequencing of branches.

## The user model

A buffer of kind `audio` shows a single audio file. The current view
already lays out a list of rows. We extend each row:

- **Double-click on the value** turns it into an `<input>`. Enter
  commits the change; Escape reverts; blur commits. The host primitive
  fires on commit.
- **A red minus button** sits to the right of every editable row. A
  click removes the tag (host primitive fires with `value: nil`).
- **A plus pill** below the last row opens a small two-input pair —
  key and value — and a confirm button. Confirm fires the same
  primitive with the new key/value.

Failure mode: revert the UI to the value-before-the-edit (or restore
the deleted row, or discard the add) and write a one-line message to
the minibuffer. No modal dialog. The user can retry.

## Editable rows vs derived rows

Not every row in `.audio-meta` is a tag the user owns. Four are
derived from the file itself and must not be editable or removable:

| Row | Source | Editable? |
|---|---|---|
| Artist | Tag (`TPE1` / `©ART` / `ARTIST`) | yes |
| Album | Tag (`TALB` / `©alb` / `ALBUM`) | yes |
| Track | Tag (`TRCK` / `trkn` / `TRACKNUMBER`) | yes |
| Year | Tag (`TYER` / `©day` / `DATE`) | yes |
| Genre | Tag (`TCON` / `©gen` / `GENRE`) | yes |
| Title | Tag (`TIT2` / `©nam` / `TITLE`) | yes (the headline doubles as a row) |
| **Duration** | Stream | **no** — computed by the codec, not a tag |
| **File** | Filename | **no** — rename via OS |
| **Format** | MIME inferred from extension | **no** |
| **Path** | Absolute path | **no** |

The view marks each row in its rendering data with `editable: true |
false`. The minus button and the double-click cursor only appear for
editable rows. Derived rows render in a slightly muted style so the
visual distinction is obvious.

The plus pill only adds **editable** tags — there is no semantically
meaningful way to "add a duration" — but it does NOT restrict the key
to the table above. ID3v2 has hundreds of frame IDs; MP4 has
extensible iTunes-style atoms; Vorbis comments are user-extensible by
spec. The user can add a `COMPOSER` tag if they want, and we'll write
it.

## Writer architecture — one writer per container

A new file `apps/desktop/src/audio-metadata-write.js` (so the read
path stays self-contained). The public surface:

```js
/**
 * Apply `changes` to the audio file at `path`.
 *
 * @param {string} path - Absolute path to the file.
 * @param {object} changes - { set: { artist: 'foo', ... },
 *                             remove: ['album', ...] }
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeMetadataSync(path, changes) { … }
```

Dispatch by extension, parallel to `extractMetadata`:

- `.mp3`              → `writeID3v2(path, changes)`
- `.m4a` / `.mp4`     → `writeMP4Metadata(path, changes)`
- `.ogg` / `.oga`     → `writeOGGMetadata(path, changes)`
- otherwise           → `{ ok: false, error: 'unsupported format' }`

Each writer normalises the user-facing key (`artist`) to its
container-specific frame ID (`TPE1` for ID3, `©ART` for MP4, `ARTIST`
for Vorbis). The mapping table lives next to the dispatcher.

The writer is **synchronous** — same as the extractors, same as the
Lisp interpreter. Small writes are not a UI hazard; large rewrites
(rare) are bounded by file size and disk speed and stay on the call
stack rather than introducing a host-side Promise the Lisp side
cannot await.

## Lisp primitive surface

Two new host primitives, registered in `app.js`'s primitive table the
same way `audio-metadata` is registered today:

```lisp
;; Set or update a tag. Returns nil on success, signals an error
;; otherwise. value may be a string or a number; nil is rejected
;; (use remove-audio-metadata! for removal).
(set-audio-metadata! path key value)

;; Remove a tag. Returns nil whether or not the tag was present.
(remove-audio-metadata! path key)
```

Keys are normalised user-facing names — `artist`, `album`, `track`,
`year`, `genre`, `title` — mapped to the container's frame ID by the
writer. The Lisp side never sees `TPE1` or `©ART`; the host hides
that.

Adding a non-standard tag uses the same primitive with an arbitrary
key string. A keyword like `:composer` works as well as `"composer"`.

A wrapper macro `with-audio-buffer-rewrite!` (Lisp side) handles the
common "set, then refresh the buffer's cached metadata" pattern so
the view repaints from authoritative source after each write.

## Failure handling

The host primitive catches the writer's errors and translates them
into a Lisp condition the view's command can `try` around:

- `enoent` — file missing (deleted out from under us)
- `eacces` — read-only file or permission denied
- `ebusy` — Windows: the `<audio>` element holds the file open
- `eformat` — unrecognised container (returned by the dispatcher)
- `eparse` — the existing tag couldn't be parsed (the file is
  malformed or uses a feature we don't handle)

The audio view's edit-commit handler reverts the UI on any error
and writes `"editing failed: <msg>"` to the minibuffer.

On the Windows `ebusy` case: pause the `<audio>` element, drop its
`src`, retry once. If the retry succeeds, restore the src and the
playback position. This is a small per-format quirk worth handling
because it's the single most likely failure on Windows.

## ID3v2 writer (the easy one)

ID3v2 tags live at the start of an MP3 file. The structure:

```
'ID3' + version (2 bytes) + flags (1 byte) + size (4 syncsafe bytes)
+ frames + padding (0x00…)
```

The size field is the size of frames + padding, in bytes. Padding is
typically 0–2KB; iTunes writes ~2KB by default.

The plan: parse the existing tag, modify the frames in memory, write
back. Two output paths:

- **In-place rewrite** if the new tag (frames + minimum padding) is
  ≤ the old tag's reserved bytes. Patch the size field, write the
  new frames, pad to the old size. Audio data after the tag is
  untouched.
- **Full rewrite** otherwise. Read the rest of the file (the audio
  stream), write the new tag + a fresh 2KB padding, then write the
  audio stream after. Atomic via temp-file + rename.

90%+ of writes go through the in-place path because tag changes are
small (a few bytes per frame).

Frame mapping is small and explicit:

```js
const ID3_FRAME_FOR_KEY = {
  artist: 'TPE1',
  album:  'TALB',
  title:  'TIT2',
  track:  'TRCK',
  year:   'TYER',  // 2.3 — 2.4 calls it TDRC
  genre:  'TCON',
};
```

Custom keys (`composer`, etc.) map via a small lookup table or fall
through to `TXXX:KEY=value` (the standard user-defined frame).

## MP4 writer (the hard one)

MP4 metadata lives at `moov/udta/meta/ilst/<atom>`. The view's
currently-displayed `.m4a` is a Jesus Jones track tagged in this
format. Each `<atom>` is a 4-byte four-character code (`©nam`,
`©ART`, `©alb`, `trkn`, `covr`, …) wrapping a `data` atom.

The core difficulty: **`stbl/stco` and `stbl/co64` carry absolute
file offsets to chunks in `mdat`.** Resizing any box before `mdat`
(including `moov` itself) shifts those offsets and every entry
must be patched. Get this wrong and the file plays static.

Strategy, in order of preference:

1. **Same-size rewrite** — if the new ilst atom has the exact same
   byte length as the old one, patch it in place. No offset shifts.
2. **Eat or grow the `free` atom** — most MP4 files written by music
   software include a `free` box of padding adjacent to `moov`. If
   ilst grows by N bytes and `free` is at least N bytes, shrink `free`
   by N and write moov + ilst + smaller-free. If ilst shrinks, grow
   `free`. moov's total size is unchanged; mdat offsets are unchanged.
3. **Full rewrite with offset recompute** — last resort. Build the
   new moov atom, compute the byte delta between old and new moov,
   walk every `stco`/`co64` entry in every track and add the delta,
   then write the file: ftyp + new moov + mdat (verbatim from old).
   Atomic via temp-file + rename.

Step (2) handles iTunes-tagged files (~95% of consumer-grade `.m4a`
files in the wild). Step (3) handles the rest.

Frame mapping:

```js
const MP4_ATOM_FOR_KEY = {
  artist: '\xa9ART',  // ©ART
  album:  '\xa9alb',  // ©alb
  title:  '\xa9nam',  // ©nam
  track:  'trkn',
  year:   '\xa9day',  // ©day
  genre:  '\xa9gen',  // ©gen
};
```

`trkn` is encoded specially (a binary atom carrying track-number and
total-tracks as two 16-bit ints), as is `disk`. Strings use `data`
atom type 1 (UTF-8). Cover art is `covr` and out of scope for v1
of the writer — viewing it works; editing the art is a separate
feature.

## Ogg Vorbis writer (the fiddly one)

An Ogg stream is a sequence of pages. Vorbis encodes its
identification, comment, and setup packets at the start of the
stream. The comment packet is what we care about. To rewrite:

1. Find the comment packet — it spans one or more pages.
2. Rebuild it: the new packet is `\x03vorbis` + vendor string +
   user-comment list + framing bit.
3. Repaginate. If the new packet size > old, push the setup packet
   (and following pages) further along. Vorbis is robust to this
   because pages carry their own granule positions and sequence
   numbers — but the page boundaries must be re-checksummed.
4. Recompute the CRC32 (custom polynomial, see RFC 3533) for each
   modified page.
5. Update sequence numbers if pages were added or removed.

We need a small CRC32-Ogg implementation (~30 lines, table-driven).
The packet rewrite is straightforward; the pagination is the
fiddly bit, but the spec is precise.

Frame mapping is trivial — Vorbis comment field names are
user-facing strings, case-insensitive, and the standard names are
exactly what we use (`ARTIST`, `ALBUM`, `TITLE`, `TRACKNUMBER`,
`DATE`, `GENRE`).

## UI flow inside the audio view

The view becomes lightly stateful — each editable row tracks its
"committed" value alongside the in-flight one. The lifecycle:

1. Render the metadata list with `editable` rows carrying a
   `data-key` attribute, a double-click handler, and a minus button.
2. On double-click: replace the value `<dd>` content with an
   `<input>` pre-populated with the current value. Focus it, select
   all.
3. On commit (Enter or blur): call the host primitive synchronously.
   On success: write the new value back to the buffer's cached
   metadata, repaint the row. On failure: revert the input to the
   previous value, show the error in the minibuffer.
4. On Escape: revert without calling the host.

The minus button is a single click → call `remove-audio-metadata!`
→ on success, remove the row from the buffer's metadata and repaint;
on failure, restore the row and minibuffer the error.

The plus pill is two inputs (key, value) + confirm. On confirm, call
`set-audio-metadata!`. On success, add the row to the metadata and
repaint. On failure, leave the pill open with the typed text intact
and minibuffer the error.

## Sequencing

Each phase is its own branch off `main`, merged via `--no-ff`.

1. **agent-audio-edit-ui** — the UI surface (double-click, minus,
   plus) wired to a fake host primitive that just logs to console.
   The plus pill and minus button render; the inline edit lifecycle
   is complete; failures are simulated by alternating the fake
   primitive between success and failure. Lets us iterate on the
   look and feel before any writer work lands.
2. **agent-audio-edit-id3v2** — the ID3v2 writer + `set-audio-
   metadata!` / `remove-audio-metadata!` for `.mp3` files only.
   Other formats return `'unsupported format'`. Round-trip tests
   live in `apps/desktop/test/audio-metadata-write.test.js`.
3. **agent-audio-edit-mp4** — the MP4 writer for `.m4a` and `.mp4`.
   Steps (1) and (2) of the strategy land first; step (3) (full
   offset recompute) follows in the same branch only if the test
   corpus needs it.
4. **agent-audio-edit-ogg** — the Ogg Vorbis writer. Lowest
   priority because the existing `.flac` / `.wav` extraction gap
   (noted in the prior handover) suggests Ogg-family files are
   rare in the architect's workflow.

Each branch lands a smoke arm at the bottom of `scripts/smoke.js`
that drives a round-trip through its writer.

## Testing strategy

For each writer, round-trip in three layers:

- **Pure-host unit tests** in `apps/desktop/test/audio-metadata-
  write.test.js`. Build a tagged file in memory, write through the
  writer, re-extract with the existing reader, assert equality.
- **Negative-path tests.** Read-only file → `eacces`. Missing file
  → `enoent`. Malformed input → `eparse`. Unrecognised key → either
  silent fallthrough (Vorbis) or `TXXX` (ID3) — either way, no
  throw.
- **Smoke arm** in `apps/desktop/scripts/smoke.js`. Seed a real
  ID3v2-tagged MP3, mount it through the audio view, drive the UI
  to change a tag, read the file back, assert the new value is on
  disk. Same for MP4 and Ogg in their respective branches.

## Risks and open questions

- **Cover art editing** is out of scope. Viewing works; replacing
  the embedded art would re-open every offset question and is its
  own feature. Defer to a later branch.
- **Lossy round-trips.** ID3v2 has multiple text-encoding choices
  (Latin-1, UTF-16, UTF-8). The writer always writes UTF-8 (ID3v2.4)
  or ISO-8859-1 (ID3v2.3) depending on the file's existing version,
  to keep round-trips clean. Mojibake risk for files written by
  ancient tools — flag in tests, not blocking.
- **MP4 step (3) is real work.** If the iTunes-style padding
  assumption holds for the architect's library (a quick survey can
  confirm), step (3) might never be needed and the MP4 branch is
  cheaper. Worth a 10-minute audit before committing to the full
  rewrite path.
- **Playback during write.** The audio view's `<audio>` element
  holds the file open. On macOS/Linux that's fine; on Windows the
  rename can fail. The plan is "pause, drop src, retry, restore"
  but the audio view doesn't currently expose hooks for that.
  Worth adding a method to the view's API in agent-audio-edit-ui.
- **The audio-view caches its buffer's `metadata` field**, set
  by the host when the buffer is created. Writes that succeed
  need to update this cache or the view will paint stale values
  the next time it mounts. The `with-audio-buffer-rewrite!` macro
  handles this; the buffer-side mechanism (a setter on the buffer's
  metadata) needs to land alongside the UI.
- **Locale-sensitive sorting** of the metadata rows isn't a
  problem today (the view renders in extraction order), but if we
  start letting users add arbitrary keys the row order should
  probably stabilise. Out of scope; flag if it bites.
