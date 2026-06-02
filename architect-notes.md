# Architect notes

Running log for decisions/blockers that need Jason. Newest first.

---

## [2026-06-03 overnight] swap-views / permute-views: built, needs live test + a keybinding call

**Context**: Implemented the two commands designed in
`plans/PANES-SWAP-PERMUTE.md` (number every pane, type pane numbers to
swap / permute which view each pane shows). Built bottom-up on branch
`swap-permute-views`. Full suite green throughout (**1144 tests, 0
fail**; +34 over the 1109 baseline).

**What's done and unit-tested (safe):**

- **Layer 1 — pane package** (`tree.js`, `layout.js`): `swapLeaves`,
  `permuteLeaves` (copy-on-write, identity-preserving frame moves) and
  `spiralOrder` (your clockwise-spiral-from-top-left numbering,
  furthest-out-first, stable-id tiebreak). 13 tests — incl. the exact
  orderings for L/R, T/B, 2×2 (TL→TR→BR→BL), tall-left+stacked-right;
  swap=transposition; permute∘inverse=identity; bijection guard.
- **Layer 3 — stdlib primitives** (`pane-primitives.js`):
  `permute-panes!`, `panes-in-spiral-order` (+ `swap-panes!` unchanged,
  still delegating to `paneHost.swapPanes`). 7 tests with a mock host.
- **State machine** (`move-view-state.js`): pure reducer for digit
  entry — unambiguous-prefix auto-accept (single keypress ≤9; waits only
  on a genuinely ambiguous prefix like 1 vs 10–12), Space force-accept,
  Backspace undo, bijection, permute forced-last. 14 tests.

**What's written but NOT yet verified (needs the running app):**

- `app.js`: `swapPaneFrames` / `permutePaneFrames` / `spiralOrderedLeaves`;
  `paneHost.swapPanes` repointed to the frame-move (so
  `swap-with-other-pane`, `C-x X`, now rides it too — please sanity-check
  that still works); `permutePanes` + `panesInSpiralOrder` added;
  `enter-move-views-mode!` primitive; **old `swapPaneViews` deleted**.
- `move-view-mode.js`: the overlay (numbered badges + prompt strip),
  window-capture key handling, modal focus grab.
- `panes.lisp`: `swap-views` / `permute-views` commands.
- `menu.js`: **View menu → "Swap Views…" / "Permute Views…"** (the
  primary entry point).
- `styles.css`: overlay/badge/prompt styling + beep shake.

**Please live-test (per our test-before-merge rule — do not merge on
tests-green alone):**

1. View menu → *Swap Views…* with ≥2 panes: badges appear top-left of
   each pane, numbered clockwise-spiral from the top-left pane; type two
   numbers, Enter swaps them; Esc/`C-g`/backdrop-click cancels; Delete
   undoes.
2. *Permute Views…*: it walks pane 1→?, pane 2→?, …; each badge shows
   `k→d` as assigned; the last is auto-filled; Enter applies all at once.
3. **The whole point — a browser/pdf/shell pane must NOT reload/blank
   when moved** (frame-move). Put a live page in one pane, swap it,
   confirm it survives.
4. **Two things I couldn't verify and am least sure about:**
   - *Badge z-order over a focused `<webview>`.* The overlay is
     z-index 60 and grabs focus, but a `<webview>` guest can paint over
     sibling DOM. If badges are hidden behind a browser pane, we may need
     to dim/cover the webview while the overlay is up.
   - *Multi-digit over a focused browser.* Menu entry focuses the editor
     first (releasing the key grab) and the overlay re-grabs focus, so
     digits should reach the window — but this is the exact "webview
     swallows keys" hazard, worth a direct check.
   - Minor edge: if the host is resized *during* entry, badge numbers use
     the entry-time layout while the apply re-derives spiral order — a
     mismatch is possible. Rare (modal, brief); flagging only.

**Decision I need from you — keybindings (deliberately left unbound).**

I did not bind `swap-views` / `permute-views` to keys — that's
user-facing taste, and binding blindly risks annoyance. They're reachable
via the View menu and `M-x`. Free `C-x` slots: `C-x 4`–`C-x 9`.

- **Options**: (a) leave menu/`M-x` only; (b) bind under `C-x` digits
  (e.g. `C-x 4` swap, `C-x 5` permute) — but `4`/`5` are Emacs
  other-window/other-frame prefixes, so this diverges from muscle memory;
  (c) a small mnemonic prefix of your choosing.
- My lean: (a) for now — the menu is the right primary path anyway, since
  the commands are most useful when a browser pane is focused and would
  swallow a chord. Tell me which you want and I'll wire it in `keymap.lisp`.

**State of the work**: branch `swap-permute-views`, 5 commits off `main`
(`6e502a9` spec is already on `main`). Nothing half-done; tree clean;
suite green. Ready for your live test, the keybinding call, then merge.

---
