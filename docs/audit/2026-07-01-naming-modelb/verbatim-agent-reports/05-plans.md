# plans/ Audit Report — Naming (jmacs→Godot) & Model-B Drift

**Scope:** 63 files under `plans/` + `plans/launch/`. Method: full `grep -rin jmacs` (104 hits across 18 files), classification of every plan by its status header, deep-read of the ground-truth Model-B docs and every plan that post-dates Model B or reads as current/authoritative.

---

## NAMING HITS ("jmacs" as current product name)

The 104 hits cluster almost entirely in `plans/launch/` (~78). Highest signal first.

### HIGH — public-facing launch copy that names the product "jmacs"
`plans/launch/04-positioning-and-launch.md` is the launch messaging doc; its strings are meant to be lifted verbatim, and the rename to **Godot** is already complete and recorded (see `06-audit-remediation.md:214`). Every product-name occurrence is now wrong.
- `plans/launch/04-positioning-and-launch.md:57` — HIGH — `"jmacs — a Lisp-extensible editor that takes Emacs's best idea…"` — rename to **Godot** (elevator pitch).
- `plans/launch/04-positioning-and-launch.md:64` — HIGH — `"Show HN: jmacs – a Lisp-extensible editor…"` — the actual Show HN title → **Godot**.
- `plans/launch/04-positioning-and-launch.md:120,124,125,126` — HIGH — competitor comparison table + honest-line quotes all say "jmacs" (`"That's the whole point of jmacs."`, `"jmacs is the opposite philosophy…"`) → **Godot**.
- `plans/launch/04-positioning-and-launch.md:364,477,544` — MED — HN/issue-template copy and the "is 'jmacs' final for the public name?" open question → the name question is *resolved* (Godot); update or mark resolved.

### MED-HIGH — packaging / governance / stability docs with product-name and identifier strings
- `plans/launch/01-packaging-and-first-run.md:279-280` — MED-HIGH — `appId: dev.jmacs.editor` / `productName: jmacs` — superseded by `com.godot.editor` + `productName: Godot` (per `06-audit-remediation.md:215`); the config here is stale.
- `plans/launch/01-packaging-and-first-run.md:37,358,366,379,428,442,474` — MED — Gatekeeper/notarization walk-through strings and paths (`/Applications/jmacs.app`, `"jmacs is damaged"`, `release/jmacs-<ver>.dmg`) → **Godot**.
- `plans/launch/05-governance-and-community.md` (25 hits) — MED-HIGH — the doc concludes "the public name is 'jmacs'" (`:486`), weighs the JOE-`jmacs` trademark collision (`:495-509`), SECURITY.md text `"jmacs is beta software…"` (`:226,288,316`), and the dev-setup title `"Hacking on jmacs"` (`:462`). The whole naming §5 is now moot — Godot was chosen. Add a "RESOLVED: renamed to Godot" banner.
- `plans/launch/03-stability-and-data-safety.md:3,272` — MED — recovery-prompt copy `"jmacs found unsaved changes…"` and pillar line → **Godot**. `:225` `${target}.jmacs-tmp-${pid}` — MED — the temp-file suffix; verify against shipped code (likely `.godot-tmp`).
- `plans/launch/README.md:3,63,80,82` — MED — index still frames the open problem as "the `jmacs` vs `@editor/*` vs `<title>editor</title>` split"; resolved by the rename.

### MED — content drift, not just a name: the `~/.jmacs/` config convention
- `plans/launch/02-extension-onboarding.md:90,137,139,370,371,387,388,402,553,581,610` — MED — repeatedly proposes a `~/.jmacs/` visible config dir + `~/.jmacs/lisp/*.lisp` autoload. This is **doubly stale**: renamed *and* the config home shipped as **`~/.godot`** (`$GODOT_HOME`, `config-home.js`; MERGED 2026-06-30). This plan's central open question ("visible `~/.jmacs/` vs userData?") is already answered on disk. Worth a banner: "config home shipped as `~/.godot` — see project_config_home."

### LOW — internal design docs (prose/titles; low visibility)
- `plans/AUCTEX.md:1,5,14,149` (title `# AUCTeX-style LaTeX authoring for jmacs`), `plans/RefTeX.md:1` (title `# RefTeX for jmacs`), `plans/COMMAND-SYSTEM.md:4,14,23,29,31,81`, `plans/CUSTOMISATION.md:11,15,24,105`, `plans/EVALUATOR.md:8,29,69`, `plans/FACE-CUSTOMISATION.md:112`, `plans/PANES.md:338,574`, `plans/PANES-PHASE-1.md:12`, `plans/PANES-PHASE-2.md:18`, `plans/OVERNIGHT-2026-05-22.md:8`, `plans/LISP-ERGONOMICS.md:3` — all LOW — "jmacs" in body prose or an H1 title. Titles (AUCTeX, RefTeX) are the most visible of the batch → LOW/MED. Bulk find-replace when convenient.

### OK — do NOT flag (repo paths / historical / legacy-migration / `@editor/*`)
- `plans/MWB-STATE.md:10,25` — filesystem worktree paths `/Users/jalex/Source/jmacs/godot-mw-b` — repo path, keep.
- `plans/launch/05…:44,49,481`, `plans/launch/06…:32`, `plans/launch/README.md:80,82` — the git remote `github.com/jmckalex/jmacs.git` — actual repo URL, keep (rename of the GitHub repo is a separate decision).
- `plans/launch/01…:170` — `git clone <url> jmacs && cd jmacs` — clone dir example, keep.
- `plans/launch/06-audit-remediation.md:214-215` — this doc *records* the rename ("no user-facing 'jmacs' strings remain"; legacy `.jmacs-metadata` migration path deliberately retained) — correct historical/legacy references, keep.
- All `@editor/*` and proposed `@jmacs/*` scope references — per audit rules, not flagged.

---

## MODEL-B / CURRENT-STATE FINDINGS

Key result: **no post-Model-B plan falsely describes the renderer running Lisp or a single-window architecture.** The recent plans I deep-read are all Model-B-correct — `JMD-LIVE-PREVIEW.md`, `JMARKDOWN-WATCH-PREVIEW.md`, `JMARKDOWN-PREVIEW-SYNC.md` (spine directive + renderer↔MAIN, `GODOT_SERVER=1`), `SPINE-KEYMAP-FROM-LISP.md` ("the in-renderer interpreter is being retired… `keyEventToString` stays in the renderer"), `B5-B7-TEARDOWN-AUDIT.md`, `SHELL-MODEL-B.md`, and `CODE-TOC-VIEW.md` (explicitly reasons server-vs-renderer and picks *parse in the server*; its `:32` "tree-sitter currently lives only in the renderer" is a true statement about grammar location, not the interpreter — not drift).

Note: the `grep` "model b" hit in `EVALUATOR.md:69` is a **false positive** — it refers to design *option B* (generator-driven evaluator), not the Model-B server topology.

Two genuine current-state hazards remain, both in reference-style docs that carry no "superseded" marker:

- `plans/MULTI-WINDOW.md:20-34` — MED — Reads as *the* multi-window plan (status "planning… the last huge outstanding task") but describes the pre-Model-B world as current: "Turn the single-window app into a multi-window one… almost all editor state is module-level in the renderer… the Lisp `interpreter`… a second `BrowserWindow` is a second renderer with its own independent copy." This is exactly what Model B replaced. It sits one directory-listing line above `MULTI-WINDOW-MODEL-B.md` with a near-identical name and no banner — an onboarding reader can easily open the wrong one. Fix: add a top banner "SUPERSEDED — the multi-window work was done the Model-B way; see `MULTI-WINDOW-MODEL-B.md` / `MWB-GRADUATION.md`."
- `plans/PANES.md:296-311` — MED — Guide-notes doc (present tense, reads as reference). The "Where the lisp VM lives" section presents "Today the VM runs in the renderer" and offers "three options" as an **open** architectural decision. That decision is closed — Model B chose option (a), one VM in the server. Fix: banner or a one-line note that the VM-location question is resolved by Model B.

---

## SUPERSEDED PLANS (pre-Model-B; would benefit from a one-line "superseded by [[MODEL-B-DEFAULT]]" banner — no per-line findings needed)

Architecture-describing docs whose core is contradicted by Model B:
- `plans/MULTI-WINDOW.md` — wholly replaced by `MULTI-WINDOW-MODEL-B.md` (see finding above; most urgent banner).
- `plans/PANES.md` — renderer-VM / one-renderer-per-window design discussion (see finding above).
- `plans/VIEWS-AS-CUSTOM-ELEMENTS.md` — guide-notes; renderer-side view-warehouse/session model, "current architecture" language predating the server split.
- `plans/MASTER.md`, `plans/WEEK-BY-WEEK.md`, `plans/CANONICAL-USE-CASE.md`, `plans/LAYER2-API.md`, `plans/EVENT-PROTOCOL.md`, `plans/LISP-SPEC.md`, `plans/RISKS.md` — the original three-week L0–L4 **in-renderer** build plan and its sub-docs. Purely historical; MASTER.md is the navigation root for that era.
- `plans/PANES-PHASE-1.md`, `PANES-PHASE-2.md`, `PANES-PHASE-3A.md`, `PANES-PHASE-3B.md`, `PANES-PLACEHOLDER.md`, `PANES-SWAP-PERMUTE.md` — the pre-Model-B pane-build phases (single-renderer assumptions, e.g. `PANES-PHASE-2.md:18`).
- `plans/OVERNIGHT-2026-05-22.md` — a dated overnight-build plan, historical.
- `plans/MWB-STATE.md` — already self-marked "⚠️ STALE (~70 commits behind)"; a formal superseded/archive tag would remove it from the live set.

Feature-design plans that predate Model B but whose feature designs largely carried over (CUSTOMISATION, COMMAND-SYSTEM, PACKAGES, SNIPPETS, FACE-CUSTOMISATION, LATEX-MATH-PREVIEW, AUCTEX, RefTeX, LANGUAGE-INJECTION, etc.) are **not** architecture-superseded — they only need the naming pass above, not a Model-B banner.

Minor aside (out of scope, noted for completeness): `plans/ROADMAP.md:22` links `REACTIVE-NOTEBOOK.md`, which is not present in `plans/` — a dead cross-reference.

---

## FINAL SUMMARY

plans/ doc health is good on architecture and weak on naming. **104 "jmacs" occurrences across 18 files**, ~78 of them concentrated in the four `plans/launch/` docs (01/02/04/05) that are the highest-severity hits because they hold public-facing launch copy and shipping identifiers that name a product now called **Godot** — while a sibling, `06-audit-remediation.md`, already records the rename as complete, making the launch cluster internally contradictory. On Model-B drift the codebase is clean: **zero** post-Model-B plans misdescribe the architecture; the only current-state hazards are two unbannered reference docs (`MULTI-WINDOW.md`, `PANES.md`) plus ~18 clearly pre-Model-B plans that would read more safely with a "superseded by Model B" banner — most urgently `MULTI-WINDOW.md`, which is one confusable filename away from `MULTI-WINDOW-MODEL-B.md`.