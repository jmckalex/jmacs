# Press-and-hold accents — corrected diagnosis and the fix

**Status:** FIXED on branch `press-and-hold-accents` (worktree
`/Users/jalex/Source/jmacs/accents`), awaiting live verification. The earlier
"blocked on an Electron limitation / build a custom chooser" conclusion was
**wrong** — see the corrected diagnosis below.

## The goal

On macOS, holding a letter (e.g. `e`) pops up the native accent chooser at the
caret (`è é ê ë …`); pressing a number (or clicking) inserts the accented
character in place of the base letter, instead of repeating the key.

## What the editor does

The editor is a custom `div`-based view, not a native text field. Keyboard
input is captured on a hidden 1px `<textarea class="editor-input">` sink
(`packages/renderer/src/view.js`). Keystrokes dispatch through the server
keymap (`onKey` → a KEY intent) and self-insert; the sink hosts IME
composition (CJK, dead keys) — and, it turns out, the accent popup's commit.

## The corrected diagnosis (2026-07-03)

Verified with a minimal test app on the **same Electron 42.2.0**, the same
`titleBarStyle: 'hiddenInset'` window, and an **exact clone of the hidden 1px
sink** (same CSS, same focus dance):

1. **Native press-and-hold works fine in Electron**, including through a
   hidden 1px textarea sink. (VS Code/Monaco — same architecture — support it
   natively; the well-known `defaults write com.microsoft.VSCode
   ApplePressAndHoldEnabled -bool false` workaround exists so vim users can
   *disable* the working picker to get key repeat.)
2. **The popup never drives a web composition.** The selection (digit or
   click) arrives solely as a plain `beforeinput`/`input` with
   `inputType: "insertText"` whose `data` is the ACCENT, whose default action
   **replaces** the base char in the textarea (`value` goes `"e"` → `"é"`,
   length unchanged). Waiting on `compositionstart`/`compositionend` — what
   the first three commits on this branch did — waits on a signal this path
   never emits.
3. **Auto-repeat keydowns keep firing while the popup is open.** Not a
   failure signal (the earlier diagnostic treated it as proof the popup
   wasn't engaged); the repeats simply deliver no text while it's up.
4. **The selection digit arrives as an ordinary keydown** (`keyCode` 50,
   *not* the IME sentinel 229); the commit happens in its **default action**.

## The actual bug

`view.js`'s keydown handler ran *before* the digit's default action and

- **cleared the sink** (`input.value = ''`) — destroying the very char macOS
  was about to replace, killing the commit; and
- **dispatched the digit through the keymap**, self-inserting it.

Hence holding `o` and pressing `4` yielded `o4`. Reproduced exactly by
replicating the handler in the bare test app (box 3: simulated buffer `e2`).

## The fix (implemented)

A small state machine in `view.js` — no `ApplePressAndHoldEnabled` writes, no
custom chooser; the native popup works natively:

- `printableBaseCandidate` — a just-typed bare printable was self-inserted
  into the buffer AND kept in the sink (the popup's replacement target).
- `accentPopupPending` — armed when that base is HELD (repeat keydowns
  observed): the popup may now be open. Repeats still don't dispatch (no
  `eeee` spam).
- While armed, the **next bare printable's dispatch is deferred**
  (`deferredAccentKey`) — its keydown neither touches the sink nor runs the
  keymap. The sink's `input` event then discloses which case it was:
  - **replacement** (`value === data`, e.g. `"e"` → `"é"`): popup commit →
    `deleteBackward(1)` + `insert(accent)` through the mirror (the same
    intent path `compositionend` uses);
  - **append** (`"e"` → `"ex"`): ordinary typing → the deferred key goes
    through the keymap exactly as it would have at keydown time.
- A **mouse click** on the popup is the same replacement-shaped `input` event
  with no keydown at all — the same listener handles it.
- The composition base-replace path is kept as a defensive parallel (should
  some macOS/Electron combination commit via composition); dead keys / CJK
  are unaffected (they never self-insert a base, so the flags stay false).

## Live-test checklist

- hold `e` → popup at the caret → press `2` → `é` replaces the `e`
- hold `e` → press `x` → popup dismisses, buffer gets `ex`
- hold `e` → **click** an accent in the popup → it replaces the `e`
- hold `e` → `Escape` → base `e` stays. (Escape is preventDefaulted by the
  keymap — verify the popup actually dismisses; known possible wart. Digits
  and clicks are the supported selection paths; arrows/Enter popup
  navigation may be swallowed by the keymap similarly.)
- dead keys (`Option+e`, `e`) and CJK composition unaffected
- arrows / Backspace still auto-repeat; bare printables don't (popup instead)

## Regression coverage

`apps/desktop/scripts/smoke.js` gained an `accents` arm driving the real
handlers with the three synthetic input shapes (digit selection, typing after
a hold, click selection). **Caveat:** the smoke harness itself is currently
broken — pre-existing on `main` and at `origin/main` (94e5bfdd): the splash
never dismisses and nothing spine-driven works under the harness, so every
interaction arm returns empties. The accents arm will assert once the harness
is repaired (separate task; not caused by the last 15 commits — verified by
bisect worktree).
