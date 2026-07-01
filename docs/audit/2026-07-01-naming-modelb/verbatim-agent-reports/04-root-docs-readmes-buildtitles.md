I have everything needed. Here is my audit report.

---

# Documentation Audit — Godot (formerly jmacs)

## README.md
`README.md:1 — NAMING — HIGH — "# jmacs" — top-level product title still jmacs — "# Godot"`
`README.md:5 — NAMING — HIGH — "jmacs is an editor whose behaviour *is* code" — opening product description — "Godot is an editor…"`
`README.md:17 — NAMING — HIGH — "![The jmacs editor](docs/screenshot.png)" — user-visible image alt text — "The Godot editor"`
`README.md:41 — NAMING — HIGH — "jmacs is a working, self-hosting, extensible editor." — "What it is" prose — "Godot is a working…"`
`README.md:328 — NAMING — MED — "jmacs was built from an empty repository" — "How it was built" prose — "Godot was built…"`
`README.md:390 — NAMING — HIGH — "jmacs is free software, licensed under…" — License-section prose — "Godot is free software…"`
`README.md:104 — NAMING — LOW — "git clone <repository-url> jmacs" — suggested local clone dir; borderline (repo may still be named jmacs) — optionally "godot"`
`README.md:105 — NAMING — LOW — "cd jmacs" — same clone-dir pair as line 104 — optionally "cd godot"`
`README.md:240 — NAMING — LOW — "jmacs/" (project-layout tree root) — dir-name label, path-like — optionally "godot/"`
`README.md:352 — NAMING — LOW — "…github.com/jmckalex/jmacs/releases" — actual GitHub repo slug (like a repo path) — leave unless repo is renamed`
`README.md:386 — NAMING — LOW — "…github.com/jmckalex/jmacs/issues" — actual GitHub repo slug — leave unless repo is renamed`
`README.md:303 — MODEL-B — MED — "One window; builds target macOS, Linux, and Windows" — lists single-window as a current limitation, but multi-window (Model B / MWB) shipped — drop "One window" from Known limitations`
`README.md:210-235 — MODEL-B — MED — architecture section: "L3 is the extension runtime that hangs off the L2 API… The renderer never mutates the buffer — input is dispatched as commands" — describes the old in-renderer/single-process topology where L3 Lisp lives beside L4; Model B puts the interpreter in the central server (spine) with the renderer a thin client — reframe around server + thin clients`
`README.md:200-204 — MODEL-B — LOW — "The REPL at the foot of the window shares the editor's interpreter and buffers." — "the window" + "shares the editor's interpreter" implies a single in-renderer interpreter; interpreter is now server-side — clarify the REPL is a client onto the server interpreter`

Note (out of scope): line 107/21-style `pnpm dev` conflicts with CLAUDE.md's "don't use pnpm dev" guidance — operational, not naming/Model-B.

## START-HERE.md
Clean on both dimensions. No "jmacs" occurrences (the line-29 "JMarkdown" is the separate markdown tool, correctly not the product name). Aside (out of scope): "pnpm dev" at line 21 is the discouraged launch path per CLAUDE.md.

## ATTRIBUTION.md
Clean on both dimensions. Refers to "this editor"/"the editor" throughout; no "jmacs" refs, no Model-B claims.

## CLAUDE.md
Clean. `grep -in jmacs` returns nothing in file content (the `…/Source/jmacs/…` in the session header is a filesystem repo path — not flagged).

## apps/desktop/README.md
`apps/desktop/README.md:4-5 — MODEL-B — HIGH — "the editor itself (L1–L4, including the Lisp runtime) runs entirely in the renderer process." — directly contradicts Model B: the Lisp runtime/spine is the central SERVER; the renderer is a thin client holding display state only — rewrite (main hosts the Lisp server; renderer is a thin client)`
`apps/desktop/README.md:22-25 — MODEL-B — MED — "src/app.js runs in the renderer and wires a buffer to an editor view… a Lisp REPL. The REPL's buffer primitives operate on the same buffer the editor shows, so Lisp typed into the REPL edits the visible document live." — describes in-renderer Lisp evaluation/buffer; Lisp now evaluates server-side — reframe`
`apps/desktop/README.md:42 — MODEL-B — MED — "src/app.js  renderer entry — wires buffer, view, REPL, Lisp" — same in-renderer-Lisp framing in the layout table — reframe`
Naming: uses `@editor/desktop` internal scope only (OK, not flagged); no "jmacs".

## apps/desktop/build/README.md
Clean, and already correctly Godot-branded ("*Waiting for Godot*", line 15). No "jmacs".

## packages/buffer/README.md
Clean on both dimensions. `@editor/buffer` scope (OK); L2 package API is still accurate under Model B.

## packages/lisp/README.md
Clean on naming (no "jmacs"; `@editor/lisp` scope OK). No Model-B drift — it documents the `createInterpreter` runtime the server uses. Aside (out of scope, factual staleness): lines 19-20 claim "No tail-call optimisation" but per MEMORY the interpreter now has TCO; and "~75 primitives" conflicts with README's "over a hundred."

## packages/renderer/README.md
`packages/renderer/README.md:3-6 — MODEL-B — MED — "The renderer projects L2 buffer state into the DOM… It never mutates the buffer directly — input dispatches commands, the buffer emits events" — assumes an in-process L2 buffer the renderer observes; under Model B the buffer/state is server-side and the renderer is a thin display client — reframe`
`packages/renderer/README.md:11-12 — MODEL-B — MED — "routes keystrokes to a host dispatcher (the editor's Lisp keymap)." — keymap is now server-side (keymap.lisp is the sole resolver in the spine); renderer forwards keys to the server — clarify keys go to the server keymap`
`packages/renderer/README.md:49-51 — MODEL-B — LOW — REPL "onSubmit: (source) => { /* evaluate, then repl.appendResult(...) */ }" — implies local evaluation; eval happens in the server — minor clarify`
Naming: `@editor/renderer` scope only (OK); no "jmacs".

## packages/renderer/src/languages/README.md
Clean on both dimensions. No "jmacs"; language-registration mechanics unaffected by Model B.

## packages/stdlib/README.md
`packages/stdlib/README.md:18-27 — MODEL-B — MED — "How it fits together": "The host builds buffer primitives for a buffer… installs them in an interpreter… On every keystroke the renderer reports a normalised key string and the host calls (handle-key …)" — this is the old in-renderer single-interpreter dispatch; in Model B the server owns the interpreter and calls handle-key, renderer only reports the key — reframe around server dispatch`
`packages/stdlib/README.md:29-39 — MODEL-B — MED — code example createInterpreter + createBufferPrimitives + interpreter.call('handle-key','right') presented as the editor's dispatch path — valid as package API but frames a per-renderer interpreter as the live model — note it's the server's runtime`
Naming: `@editor/stdlib` scope (OK); no "jmacs". Aside (out of scope): line 51 "A command palette (M-x)… are next" is stale (M-x exists).

## packages/stdlib/lisp/languages/README.md
Clean on both dimensions. No "jmacs"; no old-model claims.

## packages/storage/README.md
Clean on both dimensions. `@editor/storage` scope (OK); L1 API accurate.

## sample-documents/README.md
Clean. `grep -in jmacs` returns nothing; no Model-B relevance.

## scripts/build-docs.js
`scripts/build-docs.js:3 — NAMING — MED — "@file build-docs — render the jmacs documentation." — @file doc comment (dev-facing) still says jmacs — "render the Godot documentation."`
`scripts/build-docs.js:98 — NAMING — LOW — "process.env.JMACS_DOCS_OUT" — internal env-var contract (also read by docs/MANUAL.jmd:106); internal identifier — optional coordinated rename to GODOT_DOCS_OUT (change both sites) or leave`
No Model-B relevance. Note: this script does not contain the book-title strings — it invokes `jmarkdown` on `docs/MANUAL.jmd`; the titles live in that source (below).

---

## IN-APP BOOK TITLES (the SPECIAL TASK)
The three book titles the running app's Help shows are **H1 headings in `docs/MANUAL.jmd`** (the `--source` build-docs.js processes). The `.jmd` postprocessor turns each H1 into a navigation `node` whose `title` is the heading text (`docs/MANUAL.jmd:262` `const title = $h.text().trim()`), writes it into `manifest.json`, and the in-app manual renders those node titles. Exact source locations:

`docs/MANUAL.jmd:6 — NAMING — HIGH — "# The jmacs Manual" — book node title users see in Help — "# The Godot Manual"`
`docs/MANUAL.jmd:39 — NAMING — HIGH — "# The jmacs Reference" — book node title users see in Help — "# The Godot Reference"`
`docs/MANUAL.jmd:60 — NAMING — HIGH — "# Programming in jmacs Lisp" — book node title users see in Help — "# Programming in Godot Lisp"`

Supporting title strings in the same file (also user-facing):
`docs/MANUAL.jmd:1 — NAMING — HIGH — "Title: The jmacs Manual" — document front-matter title — "The Godot Manual"`
`docs/MANUAL.jmd:8 — NAMING — HIGH — "This is the manual for *jmacs* — a Lisp-extensible editor" — intro prose — "*Godot*"`
`docs/MANUAL.jmd:46 — NAMING — HIGH — "read *Programming in jmacs Lisp*" — cross-reference to the guide book — "*Programming in Godot Lisp*"`
`docs/MANUAL.jmd:145 — NAMING — HIGH — "<title>${escapeHtml(title)} — jmacs</title>" — HTML <title> suffix on every generated Help page — "— Godot"`

Regeneration note: `docs/build/manifest.json`, `docs/build/MANUAL.html`, and `docs/build/nodes/*.html` (e.g. `the-jmacs-manual.html`, `the-jmacs-reference.html`, `programming-in-jmacs-lisp.html`) also contain "jmacs" but are **generated artifacts** — fixing `docs/MANUAL.jmd` and rebuilding (`node scripts/build-docs.js`) regenerates them. Out-of-scope pointer: the included chapter/guide/reference sources (`docs/chapters/*.md`, `docs/guide/*.md`, `docs/reference/*.md`) contain many "jmacs Lisp" body refs and some sub-node headings — a follow-up sweep beyond the assigned file set.

---

## FINAL SUMMARY
Naming drift is heavy and user-facing: **README.md** (title, image alt, prose, license — 6 HIGH + 5 LOW) and **docs/MANUAL.jmd** (the true source of the three in-app Help book titles plus the per-page `<title>` suffix — 7 HIGH) are the priorities; `scripts/build-docs.js` adds 1 MED + 1 LOW. Model-B drift concentrates in the package/app READMEs: **apps/desktop/README.md:4-5** is the flagship (1 HIGH "Lisp runtime runs entirely in the renderer"), with MED reframes needed across apps/desktop, renderer, and stdlib READMEs, plus README.md's "One window" limitation and architecture section. **Counts** — NAMING: HIGH 13, MED 1, LOW 8; MODEL-B: HIGH 2, MED 6, LOW 2. **Clean files:** START-HERE.md, ATTRIBUTION.md, CLAUDE.md, apps/desktop/build/README.md, packages/buffer/README.md, packages/lisp/README.md, packages/renderer/src/languages/README.md, packages/stdlib/lisp/languages/README.md, packages/storage/README.md, sample-documents/README.md.

**OK jmacs refs NOT flagged (or flagged LOW):** the `…/Source/jmacs/…` filesystem/repo paths; the `@editor/*` internal package scope in every package README; the `github.com/jmckalex/jmacs/{releases,issues}` GitHub repo slugs (actual repo URL, LOW); the `git clone … jmacs` / `cd jmacs` / `jmacs/` layout clone-dir labels (path-like, LOW); the `JMACS_DOCS_OUT` internal env-var identifier (LOW); and START-HERE's "JMarkdown" (a different product, not the editor).