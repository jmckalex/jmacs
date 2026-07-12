I've read all 11 files fully and grepped each for "jmacs". Here is the audit report.

---

## Documentation audit — partition results

### docs/MAP.md
clean. (Fully Model-B; explicitly caveats ARCHITECTURE.md as pre-server at line 34. No "jmacs".)

### docs/VISION.md
clean. (No "jmacs"; the editor is referred to as "the new editor"/"this editor" — never named, but that is an absence, not a stale name. Mentions of JMarkdown/TROCP/Folio/Codify are other products, correctly named. No dispatch prose to drift.)

### docs/ARCHITECTURE.md
`docs/ARCHITECTURE.md:5 — MODEL-B — MED — "buffer changes propagate to the renderer for display. The renderer never modifies state directly." — describes the single-process in-renderer dataflow; under Model B the renderer is a thin client and this exact "one world / renderer never modifies state" line is the one MAP.md flags as stale — add a Model-B pointer/caveat.`
`docs/ARCHITECTURE.md:59 — MODEL-B — MED — "The Electron renderer process. Subscribes to L2 events, projects buffer state into the DOM" — the renderer no longer subscribes to L2 in-process; the server (spine) owns L2 and pushes view state — reframe as server-consumes-L2, client-renders-pushed-state.`
`docs/ARCHITECTURE.md:69 — MODEL-B — MED — "Input dispatches commands; commands modify L2; L2 events flow back to drive rendering." — old in-renderer loop; in Model B input becomes a KEY intent to the server, which resolves and returns a directive — rewrite for the server/client split.`
`docs/ARCHITECTURE.md:102 — MODEL-B — MED — "It's not multi-window or collaborative. One window with multiple buffers." — flatly false now: Model B is explicitly multi-window (one thin client per window) — the single clearest contradiction in the partition; remove/replace.`

### docs/VIEWS.md
`docs/VIEWS.md:9 — MODEL-B — LOW — "Read docs/ARCHITECTURE.md first for the broader picture." — sends the reader to the known-stale pre-server doc as the authoritative "broader picture" without the Model-B caveat MAP.md attaches — add "(predates the server; see docs/MODEL-B-DISPATCH.md)".`
(Body is otherwise fully current and Model-B-consistent. No "jmacs".)

### docs/MODEL-B-DISPATCH.md
clean. (This is the current dispatch playbook; accurate and Model-B-native. No "jmacs".)

### docs/CUSTOM-VIEWS.md
`docs/CUSTOM-VIEWS.md:3 — MODEL-B — LOW — "…paints a buffer…and turns keystrokes back into commands." — loose/old framing; the renderer turns keystrokes into KEY intents that the server resolves into commands — minor, could clarify.`
`docs/CUSTOM-VIEWS.md:21 — MODEL-B — LOW — "L4 | The renderer: views, keymap, projection, DOM." — lists "keymap" as an L4/renderer responsibility, but keymap resolution is now server-side (keymap.lisp); the renderer only does keyEventToString — qualify as "key-event normalisation" not keymap ownership.`
(Dispatch details — SINGLETON_VIEWS, mountKindView, onKey→dispatchKey — match current code. No "jmacs".)

### docs/GUARDRAILS.md
clean. (Agent-safety doc; no dispatch/architecture prose and no "jmacs". Aside, out-of-scope: lines 108–110 use `git checkout main`, which contradicts CLAUDE.md's `git switch main` rule — not a naming/Model-B issue.)

### docs/SNIPPETS-INLINE-NOTES.md
`docs/SNIPPETS-INLINE-NOTES.md:55 — NAMING — MED — "(defgroup 'snippets 'jmacs …) — a customize subgroup under jmacs." — the customize root group is named "jmacs"; if the underlying code still uses 'jmacs this is user-facing in the customize UI. Every other name in this doc is already Godot-ified (godot-snippets, :godot-version, author "Godot") — rename the group to 'godot in code and update this line.`

### docs/spec/lisp.md
`docs/spec/lisp.md:282 — MODEL-B — LOW — "They share the buffer the editor view displays, so evaluating them in the REPL edits the visible document." — the effect still holds, but the mechanism is stale: the interpreter runs in the server process and does not share a buffer object with the renderer's view; the edit propagates via the server's push — soften the "share the buffer" wording.`
(No "jmacs"; language-core sections are current.)

### docs/spec/modes.md
`docs/spec/modes.md:7 — NAMING — MED — "how modes work in jmacs: the data model…" — product name in prose in a spec doc — change "jmacs" → "Godot".`
(Keymap-chain / handle-key design matches the current server-side keymap.lisp, so no Model-B drift.)

### docs/api/layer2.md
`docs/api/layer2.md:6 — MODEL-B — MED — "It is the surface that the renderer and (through host primitives) the Lisp runtime talk to." — the thin-client renderer does not talk to L2 directly in Model B; only the server does — drop the renderer from this sentence (renderer gets pushed view state, not L2 access).`
`docs/api/layer2.md:83 — MODEL-B — MED — "so the renderer and modeline refresh exactly as they do for an edit or cursor move." — assumes the renderer subscribes to L2 change events in-process; in Model B the server consumes the event and pushes to the client — reframe.`
`docs/api/layer2.md:126 — MODEL-B — MED — "The renderer (L4) drives all of its rendering from this event." — the renderer no longer subscribes to L2 events; the spine does and emits directives / pushes VIEW fields — rewrite for server-consumes / client-renders.`
(No "jmacs". Out-of-scope aside: lines 136 & 141 still list "Markers … not built," but markers are implemented per lisp.md §12 — a staleness bug outside the two audit dimensions.)

---

## FINAL SUMMARY

This partition is in good shape on the current-playbook docs (MAP, MODEL-B-DISPATCH, VIEWS, GUARDRAILS, VISION are clean or near-clean) but carries concentrated Model-B drift in the two pre-server reference docs — **ARCHITECTURE.md** (renderer-subscribes-to-L2, one-directional in-process dataflow, and the flatly-false "not multi-window" line 102) and **api/layer2.md** (renderer talks to / renders from L2 directly). Naming is nearly done: only two stale "jmacs" prose/symbol references remain (modes.md spec intro, and the snippets customize root group `'jmacs`), both in internal docs, both MED.

**Counts (dimension × severity):**
- NAMING: HIGH 0, MED 2, LOW 0 — (modes.md:7; SNIPPETS-INLINE-NOTES.md:55)
- MODEL-B: HIGH 0, MED 7, LOW 4 — MED: ARCHITECTURE.md:5,59,69,102 + layer2.md:6,83,126; LOW: VIEWS.md:9, CUSTOM-VIEWS.md:3,21, lisp.md:282
- Total: 13 findings across 6 files; 5 files clean.
- (No HIGH: nothing in this partition is end-user-facing — all are developer/spec docs, so MED is the ceiling per the rubric.)

**OK "jmacs" refs NOT flagged:**
- The filesystem repo path `…/Source/jmacs/main` (path only; never appears in file bodies).
- Internal package scope `@editor/*` (e.g. CUSTOM-VIEWS.md, layer2.md imports) — correct, not a product name.
- No historical "formerly jmacs" / "renamed from jmacs" references exist in these files (nothing to exempt on that basis). The only two in-body "jmacs" hits are both flagged above.