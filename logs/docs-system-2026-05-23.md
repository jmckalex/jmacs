# Build log — in-editor documentation system (2026-05-23)

Followed the overnight Track B/D work. The editor's documentation
surface is rebuilt: one JMarkdown source (`docs/MANUAL.jmd` plus four
topic-file includes), a separate `pnpm run docs` build that emits
per-function HTML pages and a `name → path` manifest, a new `doc`
buffer kind that displays the rendered pages with click-through
cross-links, and a live path that renders user-defined docstrings
through the bundled `marked.js` library.

Branch: `agent-docs-system`. Seven commits, linear off the
`agent-d3-multiline-highlight` tip. Not merged.

---

## Phase 1 — build pipeline (commit `db853f3`)

`pnpm run docs` runs `scripts/build-docs.js`, which spawns
`jmarkdown process docs/MANUAL.jmd -o docs/build/MANUAL.html`. The
.jmd source ends with two compile-time `<script>` blocks:

- The `cmd()` registrar (`<script data-type="jmarkdown">`) defines
  `global.cmd = name => '<a href="…" data-jmacs-doc="name">name</a>'`
  and calls `export_to_jmarkdown('cmd')`. Any `cmd(forward-char)`
  inline in the source expands to an `<a>` with both a relative
  `href` (browser-usable) and a `data-jmacs-doc` attribute (the
  in-editor hook).
- The postprocessor (`<script data-type="jmarkdown-postprocess">`)
  binds `$` to a Cheerio instance of the rendered document and
  `require('node:fs')` is available. It walks every `<function>`
  element produced by the new `:::function{name=… path=…}`
  directive, writes the fragment into a per-function page under
  `docs/build/`, and writes `docs/build/manifest.json` mapping each
  name to its path.

A single converted entry (`forward-char`) proved the chain.
`apps/desktop/test/build-docs.test.js` runs the build against a
tiny fixture in a temp dir; skipped when no `jmarkdown` binary is
reachable.

The four existing reference files were renamed `.jmd` → `.md`
because JMarkdown's `[[…]]` includer only accepts `.md`.

## Phase 2 — editor wiring (commit `038324d`)

A new `doc` buffer kind, modelled on `customize` and `image`:

- `packages/renderer/src/doc-view.js` — public API mirrors
  `createImageView`. Click capture-handler intercepts elements
  with `[data-jmacs-doc]` (and `auxclick` for middle-click) and
  calls back through `openDoc(name)`. Plain anchors (in-page
  jumps, external links) follow normally.
- `apps/desktop/src/serve.js` — `app://` gained a `docs` host;
  `app://docs/<path>` resolves under `docs/build/`.
- `apps/desktop/src/files.js` — `doc:manifest` and `doc:read` IPC
  handlers. The manifest is cached in main, refreshed by mtime.
- `apps/desktop/src/app.js` — imports `createDocView`, branches
  `mountView`/`switchToBuffer` on the new kind, adds
  `openDocBuffer(docName)` (find-or-create), and two host
  primitives: `open-doc!` and `load-doc-manifest!`. The manifest
  fetch is fire-and-forget at startup so the renderer never
  blocks on the IPC.
- `packages/stdlib/lisp/docs.lisp` — `*doc-manifest*`,
  `doc-known?`, and the `open-doc` command. The Lisp cache
  re-queries until a non-empty list arrives (the JS-side fetch
  is async).
- `packages/stdlib/lisp/help.lisp` — `describe-key` and
  `describe-named-command` route through `open-doc!` when a
  manifest entry exists, REPL fallback otherwise.

Unit tests cover the click-routing predicate (`docLinkName`)
and the Lisp dispatch (manifest-empty fallback,
`doc-known?` against an unloaded manifest, REPL fallback
shape).

## Phase 2.5 — screenshot helper + smoke arm (commits `5565cf8`,
included in `038324d`)

`pnpm --filter @editor/desktop screenshot-doc [out] [name]`
launches an Electron window, opens the named doc, and writes a
PNG. The smoke gained a `docs` arm: build-skipped when no
manifest, otherwise asserts the doc-view is visible, contains
the page text, exposes a `[data-jmacs-doc]` cross-link, and
that clicking the link opens a second doc buffer.

Both fixes that came out of this phase are worth noting: (a)
the original `screenshot-doc` script didn't wire the preload,
so `window.host.readDocManifest()` was undefined and the
captured image was an empty editor with a REPL error — wired
the preload exactly as `main.js` does. (b) The first smoke run
hung visibly (dock icon bouncing) because app.js had a
top-level `await window.host.readDocManifest()` — the IPC took
long enough on first launch that it stalled module load.
Changed it to fire-and-forget; the Lisp side re-queries until
the value arrives.

## Phase 3 — migration (commit `aaec518`)

All 251 reference entries (119 in commands, 62 in
buffer-primitives, 70 in lisp-core) were wrapped in
`:::function{name=… path=…}` directives by a one-shot Node
script. Compound headings (`### \`car\` / \`cdr\``,
`### \`mod\` / \`quotient\` / \`remainder\``, …) became one
entry with a leading `name=…` and a space-separated
`aliases="…"` attribute. The postprocessor now reads
`aliases`, adds each to the manifest pointing at the same
page, and warns on a name collision. The current tree has
one — `newline` (a primitive vs a command). The lisp-core
page wins in the manifest; the command page exists on disk
but isn't reachable by name.

Final counts: 251 unique HTML pages, 297 manifest entries.

## Phase 4 — live docstring rendering (commit `e22cd35`)

Two changes to make live, in-editor Markdown rendering of
user-defined docstrings work:

- **Renamed `*jmarkdown-command*` to `*markdown-interpreter*`.**
  Default value is the magic string `"marked"`, which selects
  the newly-vendored marked.js v18.0.4 (`packages/renderer/
  vendor/marked.esm.js`). Any other string is still treated as
  a shell command — the original integration path, kept for
  users who want JMarkdown / pandoc features.
- **Live path in `(open-doc …)`.** When no manifest entry
  exists for a name, `doc-source-for-name` retrieves the
  procedure's docstring; if it's a string, the new host
  primitive `open-docstring-page!` renders it through
  `*markdown-interpreter*` and shows the result in a
  `doc`-kind buffer with the same typography as the static
  pages.

Three new stdlib tests cover the live path:
`(open-doc "user-fn")` invokes `open-docstring-page!`;
without a docstring it falls back to the REPL.

## Phase 5 — live-docs smoke arm (commit `20b31ad`)

`liveDocs` arm now exercises the full pipeline: defines a
procedure with a multi-paragraph Markdown docstring, opens
it, asserts the doc-view contains `<strong>bold</strong>`,
`<em>live</em>` and `<ul>…<li>` from marked's output.

One bug surfaced here that only an end-to-end test could
catch: earlier smoke arms set `*markdown-interpreter*` to
`"cat"` / `"echo smoke"` for their own purposes, and that
state leaked into the live-docs arm — so "smoke" (literally
the word echo'd by the shell) ended up as the rendered doc
body. Fix: the live-docs arm resets the interpreter to
`"marked"` first. Worth keeping in mind: the smoke is a
single Lisp session; state set in one arm persists.

## Tests, smoke and figures

| Package | Tests |
|---------|-------|
| `apps/desktop` | 12 |
| `packages/storage` | 47 |
| `packages/lisp` | 68 |
| `packages/buffer` | 35 |
| `packages/renderer` | 143 (+6 doc-view + +1 marked smoke) |
| `packages/stdlib` | 197 (+5 docs.lisp + live-doc tests) |

`pnpm --filter @editor/desktop smoke` — PASS, with the
`docs:` and `liveDocs:` arms both green.

Screenshots captured during build for review:
`/tmp/doc-view.png` (forward-char page),
`/tmp/doc-view-cons.png` (cons page),
`/tmp/doc-view-live.png` (live-rendered user docstring).

## Commits on `agent-docs-system`

- `db853f3` feat(docs): jmarkdown build pipeline for the
  in-editor manual
- `038324d` feat(docs): doc-view, app://docs routing and Lisp
  help integration
- `5565cf8` chore(desktop): `pnpm screenshot-doc` for capturing
  the doc-view
- `aaec518` feat(docs): convert every reference entry to
  `:::function` directives
- `e22cd35` feat(docs): live Markdown rendering for
  user-defined docstrings
- `20b31ad` test(smoke): live docstring path through marked.js

Plus this log entry.
