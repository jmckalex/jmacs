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
Lisp primitive surface, and per-format serialiser notes.

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

## Shape — parser/serialiser pairs, symmetric and rebuilt

The defining design decision: **every write rebuilds the file from
scratch.** No in-place edits, no padding tricks, no "did the size
change?" branches. The host-side flow for every mutation:

1. Parse the file into an in-memory model.
2. Mutate the model.
3. Re-serialise the model into bytes.
4. Atomic write (temp file + rename).

This is symmetric with the existing readers. For each container we
have a `parseX` already; we add a `serialiseX` that's its mirror.
Round-trip — `parseX → serialiseX → parseX` — is the natural test.

The cost is whole-file I/O on every edit (~30–100 ms on an SSD for a
typical 3–15 MB music file). That's invisible to the user and
irrelevant to anything else. The benefits are substantial:

- One code path per format. No padding/no-padding/grew/shrank
  branching. The MP4 `stco`/`co64` offsets are *outputs* of the
  serialiser, not something to patch.
- Cover-art editing falls out for free. Replacing a 500 KB cover is
  the same code path as renaming an artist.
- Each format writer is a parser/serialiser pair, testable in
  isolation, round-trip-asserted, with one failure mode (write
  failed).
- The serialiser is the *spec* of what the file looks like. Reading
  the serialiser tells you what bytes the writer can produce; it's
  not buried under "did the optimisation fire".

## Writer architecture

A new file `apps/desktop/src/audio-metadata-write.js` (so the read
path stays self-contained). Public surface, symmetric with the
extractors:

```js
/**
 * Write `metadata` to the audio file at `path`, replacing whatever
 * tags existed. Derived fields (duration, file, format, path) are
 * ignored if present.
 *
 * @param {string} path - Absolute path to the file.
 * @param {object} metadata - The complete new metadata. Keys not
 *   present are removed; keys present (with non-null values) are set.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeMetadataSync(path, metadata) { … }
```

Dispatch by extension, parallel to `extractMetadata`:

- `.mp3`              → `serialiseMP3(audioStream, metadata)`
- `.m4a` / `.mp4`     → `serialiseMP4(atomTree, metadata)`
- `.ogg` / `.oga`     → `serialiseOGG(streamPages, metadata)`
- otherwise           → `{ ok: false, error: 'unsupported format' }`

Each serialiser takes the *parsed* file model plus the *new* metadata
and produces a complete byte buffer. The caller (`writeMetadataSync`)
writes that buffer to a temp file and renames it over the original.
Rename is atomic on POSIX; on Windows we use `fs.rename` with the
file closed.

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

Both are implemented as thin wrappers over `extractMetadataSync` +
`writeMetadataSync`: read the current metadata, mutate, write. The
read-modify-write happens inside the single primitive call, so the
Lisp side sees an atomic operation.

Keys are normalised user-facing names — `artist`, `album`, `track`,
`year`, `genre`, `title` — mapped to the container's frame ID inside
the serialiser. The Lisp side never sees `TPE1` or `©ART`.

Adding a non-standard tag uses the same primitive with an arbitrary
key string. A keyword like `:composer` works as well as `"composer"`.

A wrapper macro `with-audio-buffer-rewrite!` (Lisp side) handles the
common "set, then refresh the buffer's cached metadata" pattern so
the view repaints from authoritative source after each write.

## Failure handling

The host primitive catches the serialiser's errors and translates
them into a Lisp condition the view's command can `try` around:

- `enoent` — file missing (deleted out from under us)
- `eacces` — read-only file or permission denied
- `ebusy` — Windows: the `<audio>` element holds the file open
- `eformat` — unrecognised container (returned by the dispatcher)
- `eparse` — the existing tag couldn't be parsed (the file is
  malformed or uses a feature we don't handle)

The audio view's edit-commit handler reverts the UI on any error and
writes `"editing failed: <msg>"` to the minibuffer.

On the Windows `ebusy` case: pause the `<audio>` element, drop its
`src`, retry once. If the retry succeeds, restore the src and the
playback position. The audio view needs to expose a small
`pauseAndRelease() / resumeFrom(time)` API for this — added alongside
the UI work.

## MP3 / ID3v2 serialiser

The MP3 file is `[ID3v2 tag][audio frames][optional ID3v1 tag]`. The
parser already returns the audio-frames byte range; the serialiser
emits:

1. A fresh ID3v2.4 tag built from the new metadata (frames in any
   order, since the spec is order-independent).
2. 2 KB of `0x00` padding after the last frame (matches iTunes
   convention; allows third-party tools to grow without rewriting).
3. The audio frames verbatim from the parsed model.
4. The ID3v1 tag (if present) verbatim — or we drop it; v1 is
   superseded.

Frame mapping is small and explicit:

```js
const ID3_FRAME_FOR_KEY = {
  artist: 'TPE1', album:  'TALB', title:  'TIT2',
  track:  'TRCK', year:   'TDRC', genre:  'TCON',
};
```

(`TDRC` is the v2.4 recording-time frame; v2.3's `TYER` is auto-
promoted on rewrite.) Custom keys map to `TXXX:KEY=value`, the
standard user-defined frame. Cover art is `APIC`; we write whatever
bytes the metadata model carries for `cover`.

Text encoding: UTF-8 (encoding byte `0x03`) throughout. ID3v2.4
allows it; old tools that only read v2.3 see Latin-1 fallback through
graceful degradation, which is the best we can offer without a
multi-encoding model.

## MP4 serialiser

MP4 metadata lives at `moov/udta/meta/ilst/<atom>`. The serialiser
takes the parsed atom tree, replaces `ilst`'s children, and writes
the file out:

1. Build a new `ilst` atom from the metadata. Atom-per-tag:
   - String tags (`©nam`, `©ART`, `©alb`, `©day`, `©gen`) wrap their
     UTF-8 string in a `data` atom of type 1.
   - `trkn` and `disk` wrap a binary `data` atom of type 0 with
     `[reserved 16-bit][index 16-bit][total 16-bit][reserved 16-bit]`.
   - `covr` wraps the image bytes in a `data` atom of type 13 (JPEG)
     or 14 (PNG) per the sniffed MIME.
   - Custom keys go in the iTunes-style `----` mean/name/data triplet.
2. Splice the new `ilst` into the atom tree (replacing the old one).
3. Walk the tree, emitting bytes. Each `mdat` chunk reference inside
   `stbl/stco` (32-bit) or `stbl/co64` (64-bit) is written as the
   chunk's *new* absolute byte offset — which the serialiser knows
   because it's laying everything out.
4. If any new offset crosses the 4 GB boundary, the affected `stco`
   atom is promoted to `co64` (different atom type, 64-bit entries).
   Otherwise the existing type is kept.

The pre-existing `mdat` bytes are copied verbatim — the serialiser
never touches the audio data. It only rebuilds `moov` and the
top-level box layout.

Frame mapping:

```js
const MP4_ATOM_FOR_KEY = {
  artist: '\xa9ART', album:  '\xa9alb', title:  '\xa9nam',
  track:  'trkn',    year:   '\xa9day', genre:  '\xa9gen',
  cover:  'covr',
};
```

The parser keeps the rest of the atom tree (`ftyp`, `mvhd`, `trak`,
`mdia`, `mdat`, …) as opaque byte ranges so the serialiser can emit
them unchanged. Only atoms inside `udta/meta` are mutated. This
preserves codec config, track timing, and anything else we don't
care about.

## Ogg Vorbis serialiser

The serialiser takes the parsed page sequence and the new metadata,
emits a complete Ogg stream:

1. Build a new Vorbis comment packet: `\x03vorbis` + vendor string +
   user-comment count + `KEY=VALUE` entries + framing bit.
2. Re-paginate the stream from scratch. The first page carries the
   identification packet (verbatim); subsequent pages carry the new
   comment packet + the setup packet (verbatim).
3. Recompute the per-page CRC32 (custom polynomial, RFC 3533).
4. Renumber page sequence numbers from zero.

Frame mapping is trivial — Vorbis comment field names are
user-facing strings, case-insensitive, and the standard names are
exactly the user-facing ones (`ARTIST`, `ALBUM`, `TITLE`,
`TRACKNUMBER`, `DATE`, `GENRE`).

A small CRC32-Ogg implementation (~30 lines, table-driven) is the
only piece of new infrastructure needed.

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
   look and feel before any writer work lands. Also lands the
   `pauseAndRelease() / resumeFrom(time)` API on the audio view.
2. **agent-audio-edit-id3v2** — the ID3v2 serialiser + the
   `extractMetadataSync` + `writeMetadataSync` wiring for `.mp3`.
   Round-trip tests in `apps/desktop/test/audio-metadata-write.test.js`
   (parse → mutate → serialise → parse → assert). The Lisp primitive
   gets registered here and the stubbed UI starts firing real writes.
   Other formats still error `'unsupported format'`.
3. **agent-audio-edit-mp4** — the MP4 serialiser for `.m4a` and
   `.mp4`. Round-trip tests against a real iTunes-tagged fixture
   (we can vendor one in `tests/fixtures/`).
4. **agent-audio-edit-ogg** — the Ogg Vorbis serialiser. Lowest
   priority because Ogg-family files are rare in the architect's
   workflow.

Each branch lands a smoke arm at the bottom of `scripts/smoke.js`
that drives a round-trip through its serialiser.

## Testing strategy

The always-rewrite design makes round-tripping the natural test for
every format. Three layers:

- **Parser/serialiser round-trip.** Build a tagged file in memory,
  parse it, immediately re-serialise without mutation, assert the
  output equals the input byte-for-byte. This is the strictest
  honesty test: it forces the parser to capture enough information
  for the serialiser to reproduce.
- **Read-modify-write round-trip.** Parse → mutate one field →
  serialise → parse → assert the field changed and others didn't.
- **Negative-path tests.** Read-only file → `eacces`. Missing file
  → `enoent`. Malformed input → `eparse`.

Per-format smoke arms in `apps/desktop/scripts/smoke.js` exercise
the full path: seed a tagged file on disk → mount via the audio view
→ drive the UI to edit a tag → read the file back through `extract` →
assert the new value is on disk.

## Risks and open questions

- **Parser fidelity.** Round-trip-without-mutation must produce
  identical bytes. The MP4 parser currently doesn't track the order
  of unknown atoms or their exact byte ranges; the serialiser would
  need a fallback "passthrough" representation for anything it
  doesn't understand. This is the only material implementation cost
  of the rewrite-everything design. Tractable; flagged so we don't
  pretend it's free.
- **Playback during write.** The audio view's `<audio>` element
  holds the file open. macOS/Linux can rename a file out from under
  an open handle; Windows can't. The `pauseAndRelease / resumeFrom`
  API on the view in step 1 handles this. The host primitive calls
  it before the temp-file rename.
- **The audio-view caches its buffer's `metadata` field**, set by
  the host when the buffer is created. Writes that succeed need to
  update this cache or the view will paint stale values on the
  next remount. The `with-audio-buffer-rewrite!` macro handles
  this; the buffer-side mechanism (a setter on the buffer's
  metadata) needs to land alongside the UI in step 1.
- **Locale-sensitive sorting** of the metadata rows isn't a problem
  today (the view renders in extraction order), but if we start
  letting users add arbitrary keys the row order should probably
  stabilise. Defer; flag if it bites.
