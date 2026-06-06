# Launch readiness plans

Concrete plans for taking jmacs from "ready to be seen" to "ready to be
joined" — i.e. a public announcement + community. One plan per pillar
(written by a focused planning pass); a synthesized roadmap with
cross-cutting sequencing is appended at the bottom once all are in.

| # | Plan | Pillar |
|---|------|--------|
| 01 | [Packaging & first-run](01-packaging-and-first-run.md) | A stranger can install & run in ~5 min |
| 02 | [Extension onboarding & docs](02-extension-onboarding.md) | The extender on-ramp + API reference |
| 03 | [Stability & data safety](03-stability-and-data-safety.md) | Doesn't crash, doesn't lose data |
| 04 | [Positioning & launch](04-positioning-and-launch.md) | The message, the demo, the go-to-market |
| 05 | [Governance & community](05-governance-and-community.md) | Legal, contribution, maintainer model |

---

## Synthesis — the integrated critical path

Three cross-cutting findings tie the five plans together:

1. **The scariest gap is data loss, and it's live today.** File save is a bare
   `writeFile` (truncates the real file on a mid-write crash); Cmd+Q bypasses
   the only dirty-buffer prompt (no `before-quit` handler); there is no
   autosave / crash recovery; and the session never persists buffer *contents*
   (and drops unsaved, path-less buffers entirely). An editor that can eat your
   work loses trust permanently — this is the one thing a launch cannot ship
   with. (Plan 03.)

2. **Much of the rest is cheaper than it looks** — finishing or *surfacing*
   things that already exist, not building them: the `init.lisp` user-config
   mechanism is fully wired but undocumented (Plan 02); the atomic
   temp+rename save pattern already exists in-repo, just not used for file save
   (Plan 03); the pitch is already written in `VISION.md` (Plan 04); the
   contribution discipline already exists in `CLAUDE.md`, it just needs
   translating for humans (Plan 05). The standout exception is the data-loss
   work, which is genuine new building (~1 week).

3. **One bug blocks first contact for everyone** — `pnpm dev` fails on a
   one-line `pnpm-workspace.yaml` placeholder (`citation-js: set this to true
   or false` → `false`). Plans 01, 04, and 05 all hit it independently. ~15
   minutes; do it first.

### Phasing (rough; the launch *event* gates on Phases A–C)

- **Phase A — Correctness & safety (P0, ~1 week).** The `pnpm dev` one-liner;
  the data-loss quartet (atomic save, `before-quit` dirty prompt, autosave +
  crash recovery, persist unsaved buffers); fix the stale smoke `bufferMenu`
  arm + per-arm isolation; add a renderer error boundary. *Go/no-go bar for the
  whole launch: a closed beta with zero unresolved data-loss reports.*
- **Phase B — Distributable & on-ramp (~1–1.5 weeks, parallelizable).**
  Packaging (electron-builder, `serve.js` `repoRoot` switch, `extraResources`
  unpacked, an app icon) + macOS signing/notarization (**start Apple Developer
  enrollment now — it's the long pole**); the extension on-ramp (`(load PATH)`
  primitive, `open-init-file` command, richer first-run template, the
  "first extension in 5 minutes" tutorial, a config guide).
- **Phase C — Message & legal (~few days, parallel).** README revision
  (show-don't-tell; fix the `pnpm dev` caveat), `COMPARISON.md`; license
  copyright line + vendored-dep notices (MathJax Apache-2.0, Font Awesome
  attribution) + `STABILITY.md` (write down the honest "0.x breaks freely but
  we always migrate your data" contract) + `CONTRIBUTING.md`/`CODE_OF_CONDUCT`;
  resolve the `jmacs` vs `@editor/*` vs `<title>editor</title>` naming split.
- **Phase D — Launch assets & event.** The 8-shot screencast/GIF set (**also a
  long pole — start filming early**; hero = REPL acting on the live buffer);
  GTM staging (Mastodon soft-launch → Lobsters/Show HN at T-0 → r/emacs & r/lisp
  at T+1 → blog deep-dive), with solo-maintainer surge survival (pinned
  known-issues, triage don't fix live).
- **Phase E — Fast-follow (post-launch).** GitHub Actions release pipeline;
  Linux/Windows builds; extension registry; performance (idle-debounce
  highlighting + file-size guard are cheap and maybe pre-launch; incremental
  tree-sitter parse and the piece-tree are deferrable); governance
  formalization / co-maintainer.

### Two long poles — start immediately, in parallel with Phase A
- **Apple Developer enrollment** (if signing Path B) — latency, not effort.
- **Screencast assets** — the demo *is* the launch; they take longest to make good.

### Decisions only the architect can make
1. **Is the repo already public?** (`github.com/jmckalex/jmacs` — Plan 05 couldn't confirm.) Determines how urgent the governance/license gaps are.
2. **Apple Developer account?** Path B (signed+notarized, recommended) vs Path A (unsigned + `xattr` bypass instructions). Enroll now if B.
3. **The name.** Keep `jmacs` (note: collides with JOE's existing `jmacs`) or rename — but the `jmacs`/`editor` split must be resolved either way.
4. **Maintainer model.** BDFL-with-explicit-response-limits (recommended) / recruit a co-maintainer / "forks welcome."
5. **Recovery-file location** (userData recommended) and **native Save/Don't-Save/Cancel dialog** vs the current renderer `window.confirm`.
6. **Launch channel & scope.** Lobsters vs Show HN as primary; macOS-only first vs waiting for Windows.

See each pillar's plan for the concrete, file-cited steps, effort estimates, and per-pillar decision lists.
