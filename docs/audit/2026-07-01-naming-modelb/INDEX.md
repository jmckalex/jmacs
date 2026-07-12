# Documentation audit — jmacs→Godot naming & Model-B drift (2026-07-01)

Read-only fan-out of 5 agents auditing the docs on two axes:
1. **Naming** — stale "jmacs" where the product is now **Godot** (user-facing prose, titles, identifiers).
2. **Model-B drift** — docs that describe the retired in-renderer / single-window architecture as current.

Finding format used by the agents: `path:LINE — DIMENSION — SEVERITY — "quote" — problem — fix`.

## The five verbatim reports (`verbatim-agent-reports/`)

These are the agents' **final reports, verbatim** — not synthesized or edited. Recovered from the previous
session's subagent transcripts after a `/clear` (`~/.claude/projects/-Users-jalex-Source-jmacs-main/
4dc9d72f-bcff-46c7-aea4-e0cb2a928486/subagents/agent-*.jsonl`).

| file | agent partition | agent id |
|---|---|---|
| `01-architecture-docs.md` | authoritative architecture docs (MAP, ARCHITECTURE, VIEWS, MODEL-B-DISPATCH, spec/, api/) | `agent-aafe163725e354b3e` |
| `02-manual-chapters.md` | in-app manual chapters (`docs/chapters/*`) | `agent-a67500ca9610da08d` |
| `03-lisp-guide-reference.md` | Lisp guide + reference (`docs/guide/*`, `docs/reference/*`) | `agent-a344721029af33c57` |
| `04-root-docs-readmes-buildtitles.md` | root docs, package READMEs, doc-build titles (incl. `docs/MANUAL.jmd`) | `agent-abaeab1d945720ad8` |
| `05-plans.md` | `plans/` + `plans/launch/` | `agent-a112760c68925431f` |

## Headline totals (per the agents' own summaries)

- **Naming** — dominant, heavily user-facing: ~55 HIGH across `docs/chapters/*`, ~47 HIGH across
  `docs/guide/*`+`docs/reference/*`, 13 HIGH across README + `docs/MANUAL.jmd` (the in-app book titles),
  plus ~78 hits across `plans/launch/*` (incl. shipping ids `appId dev.jmacs.editor` / `productName jmacs`).
- **Model-B drift** — concentrated: `docs/ARCHITECTURE.md` (incl. false "not multi-window" line 102),
  `docs/chapters/architecture.md` (2 HIGH), `apps/desktop/README.md:4-5` (HIGH), package READMEs,
  `docs/api/layer2.md`, `docs/chapters/windows.md`; `plans/MULTI-WINDOW.md` + `plans/PANES.md` mis-read as
  current; ~18 pre-Model-B plans want a "superseded" banner. MAP / MODEL-B-DISPATCH / VIEWS are clean.

## Cross-cutting items (appear in several partitions — de-dupe when remediating)

- **Customize root group symbol `jmacs` → `godot`** (a coordinated stdlib CODE change, not doc-only):
  `custom-faces.md:35/84/118/127/319`, `help-and-config.md:241`, `customization.md:125`,
  `SNIPPETS-INLINE-NOTES.md:55`.
- **Wrong sidecar name `.jmacs-metadata` → `.godot-metadata`**: `docs/reference/commands.md:1047`,
  `docs/reference/productivity.md:157`.
- **Stale config home** (Electron `userData` / `~/Library/Application Support/<App>/` → `~/.godot`):
  `customization.md:19-31`, `guide/modules.md:273-278`, `reference/productivity.md:61`.
- **In-app book titles** live in `docs/MANUAL.jmd` H1s (`:6`, `:39`, `:60`) + front-matter `:1` + per-page
  `<title> — jmacs` `:145`; regenerate after editing with `node scripts/build-docs.js`.
