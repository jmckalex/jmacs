I've read all 14 chapters fully and grepped each for "jmacs". Here is the audit.

---

## docs/chapters/getting-started.md
- getting-started.md:3 — NAMING — HIGH — "This chapter introduces jmacs:" — product prose uses old name — "introduces Godot"
- getting-started.md:10 — NAMING — HIGH — "### What jmacs is" — section heading uses old name — "What Godot is"
- getting-started.md:12 — NAMING — HIGH — "jmacs is a Lisp-extensible editor" — product name — "Godot is a Lisp-extensible editor"
- getting-started.md:29 — NAMING — HIGH — "the property that gives jmacs its character" — product name — "gives Godot its character"
- getting-started.md:35 — NAMING — HIGH — "jmacs is built for the person" — product name — "Godot is built for"
- getting-started.md:52 — NAMING — HIGH — "the full architecture to use jmacs" — product name — "to use Godot"
- getting-started.md:56 — NAMING — HIGH — "jmacs is built in five layers" — product name — "Godot is built in"
- getting-started.md:108 — NAMING — HIGH — "jmacs is a pnpm workspace" — product name — "Godot is a pnpm workspace"
- getting-started.md:147 — NAMING — HIGH — "the REPL is what makes jmacs jmacs" — product name (twice) — "makes Godot Godot"
- getting-started.md:77 — MODEL-B — MED — "the text data structure, the Lisp interpreter itself" — locates the Lisp interpreter inside the per-window host; under Model B the interpreter is the single central server (spine), not per-window host machinery — reframe interpreter as the central server the thin window clients talk to
- getting-started.md:102 — MODEL-B — LOW — "the simple picture is enough: one window, one pane" — single-window framing (softened as a first-session simplification); Model B is multi-window — acknowledge multiple windows exist even if the first session uses one

## docs/chapters/basic-editing.md
- basic-editing.md:3 — NAMING — HIGH — "Everything jmacs does to text" — product name — "Everything Godot does"
- basic-editing.md:46 — NAMING — HIGH — "in jmacs the region is sticky once set" — product name — "in Godot the region"
- basic-editing.md:119 — NAMING — HIGH — "jmacs also carries a small set of whole-line operations" — product name — "Godot also carries"
- basic-editing.md:150 — NAMING — HIGH — "jmacs does not lean on the system clipboard" — product name — "Godot does not lean"
- basic-editing.md:179 — NAMING — HIGH — "the kill ring is jmacs's own model" — product name — "Godot's own model"
- (Model-B: clean.)

## docs/chapters/files-and-buffers.md
- files-and-buffers.md:3 — NAMING — HIGH — "A working session in jmacs" — product name — "in Godot"
- files-and-buffers.md:68 — NAMING — HIGH — "jmacs does not cram them" — product name — "Godot does not cram"
- files-and-buffers.md:99 — NAMING — HIGH — "jmacs will not silently overwrite" — product name — "Godot will not"
- files-and-buffers.md:111 — NAMING — HIGH — "jmacs shows this with a filled circle" — product name — "Godot shows this"
- files-and-buffers.md:160 — NAMING — HIGH — "jmacs autosaves your unsaved work" — product name — "Godot autosaves"
- files-and-buffers.md:179 — NAMING — HIGH — "When jmacs starts and finds recovery snapshots" — product name — "When Godot starts"
- files-and-buffers.md:203 — NAMING — HIGH — "jmacs asks before exiting" — product name — "Godot asks"
- (Model-B: clean.)

## docs/chapters/search-and-marks.md
- search-and-marks.md:57 — NAMING — HIGH — "jmacs offers three replacement commands" — product name — "Godot offers"
- (Model-B: clean. `.NAME.godot-metadata` at line 139 is the correct current fact.)

## docs/chapters/writing.md
- writing.md:3 — NAMING — HIGH — "jmacs is as much a tool for writing as for code" — product name — "Godot is as much"
- writing.md:111 — NAMING — HIGH — "jmacs gives them as two independent minor modes" — product name — "Godot gives them"
- (Model-B: clean.)

## docs/chapters/productivity.md
- productivity.md:3 — NAMING — HIGH — "jmacs carries a handful of power-user features" — product name — "Godot carries"
- productivity.md:22 — NAMING — HIGH — "Press C-c d again and jmacs finds the next occurrence" — product name — "Godot finds"
- (Model-B: clean. `.<file>.godot-metadata` at line 175 is the correct current fact.)

## docs/chapters/customization.md
- customization.md:7 — NAMING — HIGH — "where jmacs keeps your configuration on disk" — product name — "where Godot keeps"
- customization.md:15 — NAMING — HIGH — "jmacs keeps everything it owns" — product name — "Godot keeps"
- customization.md:52 — NAMING — HIGH — "init.lisp is the jmacs equivalent of Emacs's .emacs" — product name — "the Godot equivalent"
- customization.md:62 — NAMING — HIGH — ";;; init.lisp — your jmacs configuration." — appears verbatim in the user's own config file — "your Godot configuration"
- customization.md:65 — NAMING — HIGH — "It is the jmacs equivalent of .emacs:" — in the written template — "the Godot equivalent"
- customization.md:96 — NAMING — HIGH — ";;; jmacs writes this file" — in the custom.lisp header the user sees — "Godot writes this file"
- customization.md:108 — NAMING — HIGH — "Settings in jmacs are declared, not hard-coded" — product name — "Settings in Godot"
- customization.md:125 — NAMING — HIGH — "the root group is jmacs" — live Customize group identifier the user sees, not just prose — root group should be "godot"
- customization.md:168 — NAMING — HIGH — "jmacs ships fourteen built-in token faces" — product name — "Godot ships"
- customization.md:19-31 — NAMING — LOW — "macOS ~/Library/Application Support/<App>/ …" — config-location fact is superseded: user config now lives in `~/.godot` (`$GODOT_HOME`), config-only — update the data-directory description to `~/.godot`
- (Out-of-scope factual note, not flagged under either dimension: lines 194–201 say "Four themes ship"; the product now ships 7 themes.)
- (Model-B: clean.)

## docs/chapters/extending.md
- extending.md:1 — NAMING — HIGH — "## Extending jmacs" — chapter title — "Extending Godot"
- extending.md:6 — NAMING — HIGH — "Extending jmacs is not a separate activity" — product name — "Extending Godot"
- extending.md:13 — NAMING — HIGH — "this manual's Programming in jmacs Lisp part" — named manual part title — "Programming in Godot Lisp"
- extending.md:23 — NAMING — HIGH — "jmacs has a Lisp read-eval-print loop" — product name — "Godot has"
- extending.md:89 — NAMING — HIGH — "The sources jmacs ships are point…" — product name — "the sources Godot ships"
- extending.md:164 — NAMING — HIGH — "jmacs writes an init.lisp into your config directory" — product name — "Godot writes"
- extending.md:190 — NAMING — HIGH — "Press a key; jmacs reports the command it runs" — product name (table cell) — "Godot reports"
- (Model-B: clean — JS-interop discussion is topology-agnostic.)

## docs/chapters/modes.md
- Clean (no "jmacs"; no Model-B drift — modes described as Lisp data, behaviorally).

## docs/chapters/keys.md
- keys.md:13 — NAMING — HIGH — "the Extending jmacs chapter explains how to change it" — cross-reference to chapter — "Extending Godot"
- keys.md:111 — NAMING — HIGH — "the Extending jmacs chapter shows how to give it a key" — cross-reference — "Extending Godot"
- keys.md:17 / 114-119 — MODEL-B — LOW — "The renderer reports each keystroke to the Lisp… The host's only job is to normalise the event… and hand it to handle-key" — dispatch prose predates the client/server split; it reads as compatible with Model B (client normalises, server resolves) but never states the client→server hop or that keymap resolution is server-authoritative — add a sentence that the thin client hands the key string to the central server, where handle-key/keymap.lisp resolves it

## docs/chapters/latex.md
- Clean (no "jmacs"; no Model-B drift — all behavioral).

## docs/chapters/views.md
- views.md:6 — NAMING — HIGH — "jmacs treats the editing surface as a polymorphic slot" — product name — "Godot treats"
- views.md:70 — NAMING — HIGH — "The chrome is jmacs's own, so it matches the editor" — product name — "Godot's own"
- views.md:202 — NAMING — HIGH — "jmacs ships two directory browsers" — product name — "Godot ships"
- (Model-B: clean — views correctly described as renderer-side display surfaces, consistent with thin-client display state.)

## docs/chapters/windows.md
- windows.md:1, 3-13, 66, 108, 119, 179 — MODEL-B — MED — "## Windows: panes and tabs" … "every split in the window" … "rearranging your windows never throws work away" … "For windows with more than two panes" — a chapter titled *Windows* covers only panes/tabs inside a single editor area and never mentions OS-level multiple windows; "window(s)" is used throughout to mean the single pane tree. This is single-window framing that contradicts multi-window Model B (session restore reinstates "all windows+panes") — add coverage of opening/moving between multiple windows, and disambiguate "window" (OS window) from the pane tree
- (Naming: clean — no "jmacs".)

## docs/chapters/architecture.md
- architecture.md:1 — NAMING — HIGH — "## How jmacs is built" — chapter title — "How Godot is built"
- architecture.md:3 — NAMING — HIGH — "You don't need to read this chapter to use jmacs" — product name — "to use Godot"
- architecture.md:17 — NAMING — HIGH — "jmacs is built in layers" — product name — "Godot is built"
- architecture.md:26 — NAMING — HIGH — "This is the platform jmacs runs on" — product name — "Godot runs on"
- architecture.md:64 — NAMING — HIGH — "jmacs speaks two extension languages" — product name — "Godot speaks"
- architecture.md:73 — NAMING — HIGH — "jmacs is not Emacs" — product name — "Godot is not Emacs"
- architecture.md:154 — NAMING — HIGH — "so jmacs waits for the next key" — product name — "Godot waits"
- architecture.md:180 — NAMING — HIGH — "customization in jmacs feels direct" — product name — "in Godot feels direct"
- architecture.md:15 — MODEL-B — MED — "### One window, five layers, two languages" — heading asserts single-window; Model B is multi-window (server + thin window clients) — "Five layers, two languages" (or add the server/clients topology)
- architecture.md:55-59 — MODEL-B — MED — "L4 — the renderer… subscribes to the buffer's change events and paints them into the window" — describes the renderer subscribing directly to the L2 buffer; under Model B the buffer lives in the server and the thin renderer paints from server-pushed data-source updates — reframe L4 as a thin client rendering server data-sources
- architecture.md:117-118 — MODEL-B — HIGH — "app.js — the renderer entry point: it boots the Lisp, installs the buffer primitives…" — the in-renderer interpreter was DELETED; the renderer no longer boots the Lisp — the Lisp is booted in the central server (spine) — rewrite to place the interpreter in the server, with app.js as a thin client
- architecture.md:146-172 — MODEL-B — HIGH — "The host hands the key to Lisp. app.js calls (handle-key "C-f")… handle-key resolves the key… The renderer redraws. L4, subscribed to that event…" — the entire "life of a keystroke" describes in-renderer, single-process dispatch (local app.js→Lisp call, in-renderer keymap resolution, renderer subscribed to the buffer event); Model B sends the key to the server, resolves the keymap server-side (G5, keymap.lisp is sole resolver in the spine), and pushes results back to the thin client — rewrite the keystroke walkthrough for the client→server→client round trip

---

## FINAL SUMMARY

The dominant problem is naming: **55 HIGH jmacs→Godot findings** spread across 11 of 14 chapters (every one is user-facing product prose, headings, cross-reference titles, or text written verbatim into the user's own config files — e.g. customization.md:96, :125 "root group is jmacs"), plus **1 LOW** config-location note (customization.md:19-31 still describes the OS data dir instead of `~/.godot`). Model-B drift is concentrated exactly where warned: architecture.md carries **2 HIGH** (renderer "boots the Lisp"; the whole in-renderer "life of a keystroke") and **3 MED** (the "One window" heading; L4 subscribing directly to buffer events), getting-started.md **1 MED + 1 LOW**, windows.md **1 MED** (single-window framing / no OS multi-window concept), and keys.md **1 LOW**. Counts by dimension×severity: NAMING = 55 HIGH / 1 LOW; MODEL-B = 2 HIGH / 5 MED / 2 LOW. Clean files: **modes.md** and **latex.md** (no jmacs, no drift); **basic-editing, files-and-buffers, search-and-marks, writing, productivity, customization, extending, views** are Model-B-clean but carry naming hits. **No "OK" jmacs refs were excluded** — none of the chapters contain filesystem repo paths (…/Source/jmacs/…) or explicitly historical references; every jmacs occurrence is live product prose and was flagged.