# Claude Fable code audit — 2026-07-01

A whole-app, port-weighted code audit of the Godot editor at `main` = `efe0fa6d`
(post Model-B port, post session-restore-hardening merge; suite green at 3290 tests).
Requested by the architect; performed by Claude Fable 5 orchestrating 13 read-only
area agents plus an adversarial verification pass over every P0/P1 finding.

**Status: COMPLETE — all 13 areas finished.** Start with `00-EXECUTIVE-SUMMARY.md`, then
`FINDINGS.md` (severity-ranked register with per-finding verification verdicts), then the
numbered area reports. **Headline: 4 verified P0s** — a drive-by RCE from a hostile file
(`MAIN-01`), a whole-app spine crash from ordinary two-window editing (`SPINE-01`), the
documented reload shortcut bricking the window (`SRV-01`), and unsandboxed RCE via a
shared notebook (`MWBC-01`, explicit-eval) — plus a cluster of P1 data-loss/freeze
findings, most reducing to four root causes (see the summary's "cross-cutting themes").
The two areas that initially landed as skeletons (`03-mwb-client-stack`,
`09-stdlib-lisp`) were finished in a dedicated re-run; the stdlib dispatch core came back
sound (no P0/P1). Coverage is now even across all areas.

## Scope and weighting

Everything in `packages/*` and `apps/desktop/*`, with the deepest scrutiny on the
Model B seam (the port): `apps/desktop/mwb/` (spine, server, protocol, pane model,
client stack), `apps/desktop/src/app.js` (the 9.1k-line thin-client arm),
preload/main IPC, and the `SPINE_STDLIB` Lisp. Four dimensions, per the architect:

1. **Correctness & data safety** — state divergence, ordering/races, unclamped
   positions, persistence/migration hazards, crash/freeze paths, pathological-input perf.
2. **Security & IPC** — preload exposure, webviews, subprocesses, path handling,
   DOM sinks (XSS via hostile file content), eval surfaces. Threat model: single-user
   desktop app; hostile *file content*, *filenames*, and *web pages in embedded views*
   are in scope; local same-account attackers are not.
3. **Architecture & consistency** — drift from the documented invariants
   (`docs/MODEL-B-DISPATCH.md`, `docs/VIEWS.md`), pre-Model-B residue, dead code.
4. **Tests & coverage** — what the green suite actually protects; stub masking;
   regression pinning of the known bug families.

## Severity and confidence scale (shared by all reports)

- **P0** — user-reachable crash/freeze/data-loss/security hole in normal use.
- **P1** — real bug on a plausible path, or a security weakness with mild preconditions.
- **P2** — latent hazard, perf cliff, or invariant violation that will bite under evolution.
- **P3** — smell / polish / doc drift worth recording.
- **CONFIRMED** — the auditor traced the full path in code (or demonstrated a repro).
- **PLAUSIBLE** — suspicious but not fully traced. P0/P1 findings additionally went
  through an independent adversarial verification pass; verdicts live in `FINDINGS.md`.

## The reports

| File | Area | Finding prefix |
|---|---|---|
| `00-EXECUTIVE-SUMMARY.md` | Synthesis: top findings, themes, posture | — |
| `FINDINGS.md` | Flat severity-ranked register of every finding + verification verdicts | — |
| `01-spine-server.md` | `apps/desktop/mwb/spine.js` — the Lisp server core | SPINE |
| `02-server-bridge-protocol.md` | `server.js`, `protocol.js`, `client.js`, launch/session-store/atomic-write/autosave | SRV |
| `03-mwb-client-stack.md` | `view-client`, `client-buffer`, `buffer-registry`, `pane-model`, notebook engine, pickers | MWBC |
| `04-app-boot-dispatch.md` | `app.js` half 1: boot/TDZ, port wiring, applyDirective, key routing, config | APPB |
| `05-app-views-panes.md` | `app.js` half 2: views/tablines/panes/kill paths/session-restore client | APPV |
| `06-main-process-security.md` | `main.js`, `preload.mjs`, `serve.js`, `files.js`, subprocesses, IPC allowlist | MAIN |
| `07-desktop-utilities.md` | audio metadata (tag rewriting!), sticky-notes, session.js, faces, projects | DESK |
| `08-lisp-interpreter.md` | `packages/lisp` — reader/eval/printer, TCO, writeString round-trip | LISP |
| `09-stdlib-lisp.md` | `packages/stdlib` — keymap.lisp state machine, SPINE_STDLIB membership, stubs | STD |
| `10-data-layer.md` | `packages/storage`, `buffer`, `pane`, `view` — splice/marker/id math | DATA |
| `11-renderer-core.md` | `packages/renderer` core: view.js paint pipeline, highlight, chrome, server-view-client | RVCORE |
| `12-renderer-view-kinds.md` | The view-kind zoo: pdf/browser/shell/directory/notebook/audio/minimap/… | RVK |
| `13-tests-coverage.md` | The suite itself: real coverage, stub masking, regression pinning | TEST |

## Method

Each area agent read its files in full (the biggest files chunked), audited against
the shared invariant catalogue (the documented recurring traps + the shipped-bug
families from the project memory), and wrote its report directly. Agents were
read-only: no source edits, no git state changes; each wrote exactly one report file.
Every P0/P1 claim was then re-verified by a separate adversarial pass with fresh
context before entering the executive summary. Line numbers cite `main` @ `efe0fa6d`.
