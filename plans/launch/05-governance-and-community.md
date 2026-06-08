# 05 — Governance, Licensing & Community Operations

_Launch-readiness pillar 5 of 5. Sibling plans: [01 Packaging](01-packaging-and-first-run.md),
[02 Extension onboarding](02-extension-onboarding.md), [03 Stability](03-stability-and-data-safety.md),
[04 Positioning](04-positioning-and-launch.md)._

**Scope of this plan.** The standing infrastructure that makes jmacs
*joinable* — license hygiene, contribution rules, community channels, a
stability/versioning contract that reconciles the project's "break
freely" stance with having dependents, a sustainable maintainer model,
contributor-readiness, and a naming decision. This is the pillar where
solo projects usually die: not from bad code, but from an unanswered
"who is allowed to do what, and how much will the author respond?"

**Posture.** jmacs is a solo-built v0.1 beta for a deliberately narrow
audience ("an editor for the people who would have built it themselves if
they'd had time" — `docs/VISION.md:25`). The governance design must serve
*that* project, not an imagined large OSS org. Almost every recommendation
below is biased toward "cheap, honest, and protective of the maintainer's
time." Over-building governance for ten contributors you don't have yet
is its own failure mode.

---

## 0. Findings: the current state of the repo (grounded)

What exists today, verified against the tree:

| Artifact | State | Evidence |
|----------|-------|----------|
| Top-level `LICENSE` | **Present** — full GPL-3.0 text | `/LICENSE` (35 KB, verbatim FSF text) |
| Root `package.json` license field | `GPL-3.0-or-later` | `package.json:8` |
| Per-package license fields | **Consistent** — all 8 say `GPL-3.0-or-later` | `packages/*/package.json`, `apps/desktop/package.json` |
| `package.json` versions | All `0.0.0` (not `0.1`) | root + all packages |
| `package.json` `private` | root + all packages are `private: true` | confirmed |
| `CONTRIBUTING.md` | **Missing** | not in tree |
| `CODE_OF_CONDUCT.md` | **Missing** | not in tree |
| `SECURITY.md` | **Missing** | not in tree |
| `CHANGELOG.md` | **Missing** | not in tree |
| `.github/` (templates, labels, FUNDING) | **Missing entirely** | no `.github` dir |
| README | **Strong, launch-ready** | `/README.md` (already a good front door) |
| Architecture / onboarding docs | **Strong** | `docs/ARCHITECTURE.md`, `docs/VISION.md`, `docs/VIEWS.md`, `docs/spec/lisp.md`, `docs/api/layer2.md`, generated reference under `docs/build/` |
| `CLAUDE.md` working agreements | **Present, but written for AI sub-agents** | `/CLAUDE.md` — branch-per-role, territory, stop-and-ask |
| GitHub remote | **Already exists** | `origin = https://github.com/jmckalex/jmacs.git` |
| Sole contributor | Jason (745/745 commits) | `git shortlog -sne` |

Three findings that change the priority order:

1. **The repo is already pushed to GitHub** (`github.com/jmckalex/jmacs`).
   Visibility (public vs private) could not be confirmed from this
   environment (`gh` is not installed). **First action of this entire
   plan: confirm whether the repo is currently public.** If it is, the
   license/naming/governance gaps are already exposed, and the sequencing
   below compresses to "do P0 immediately." If it is private, you have
   room to land P0 before flipping it public.

2. **The LICENSE is the bare GPL text with no authorship.** The file is
   the verbatim FSF document; the "How to Apply These Terms" section at
   the end still reads `Copyright (C) <year> <name of author>` — i.e.
   there is **no copyright line naming Jason anywhere**, and there are no
   per-file license headers. GPL is chosen and declared in metadata, but
   the *copyright assertion* that makes the license enforceable is absent.
   This is the single highest-value, lowest-effort fix in the plan.

3. **Vendored third-party code is missing its license notices.** The
   tree-sitter grammars under `vendor-grammars/` each kept their `LICENSE`
   (MIT/Apache/MIT — good), but the two vendored web deps did **not**:
   - `apps/desktop/vendor/mathjax/` — MathJax 3.2.2 (Apache-2.0), only a
     `README.md`, **no LICENSE file** (`apps/desktop/vendor/mathjax/README.md`).
   - `apps/desktop/vendor/fontawesome/` — Font Awesome **Free** 7.2.0,
     only a `README.md`, **no LICENSE file** (`apps/desktop/vendor/fontawesome/README.md`).
     FA Free is a *mixed* license (icons CC-BY-4.0, fonts SIL OFL-1.1,
     code MIT) and its terms **require attribution be retained** — this
     is a redistribution obligation, not optional.

   Distributing a GPL app that bundles Apache/CC-BY/OFL code is fine
   (all are GPL-3-compatible), but the upstream attribution/notice
   requirements must be satisfied. Right now they are not.

No GPL-incompatibility was found among npm dependencies that ship at
runtime (`packages/renderer` runtime deps: `marked` MIT, `@xterm/*` MIT,
`pdfjs-dist` Apache-2.0; MathJax Apache-2.0). The tree-sitter grammar
zoo is in `devDependencies`, not shipped. Electron itself is MIT. So the
copyleft posture is clean; the gap is **notice hygiene, not license
conflict**.

---

## 1. License hygiene  `[P0 — do before any public exposure]`

The legal floor. None of this is hard; all of it is load-bearing if the
repo is or becomes public.

### 1.1 Assert copyright (the critical gap)

The GPL only protects what someone holds copyright in and licenses. With
no copyright line, the license is declared but unanchored.

- **Add a `COPYRIGHT` / `AUTHORS` line.** Either a top-of-`README`
  copyright notice, an `AUTHORS` file, or (cleanest) the standard GPL
  header block. Minimum:
  `Copyright (C) 2025–2026 J. McKenzie Alexander`.
- **Decide on per-file headers.** The GPL's own guidance ("attach [the
  notice] to the start of each source file") recommends per-file headers.
  For a ~50-file hand-written codebase this is reasonable and worth doing
  *once*; a short SPDX line is the modern, low-noise form:
  ```js
  // SPDX-License-Identifier: GPL-3.0-or-later
  // Copyright (C) 2025–2026 J. McKenzie Alexander
  ```
  **Recommendation:** SPDX one-liner on every first-party source file
  (`packages/*/src/**`, `apps/desktop/src/**`, `packages/stdlib/lisp/**`).
  Skip generated/vendored files. Effort: ~1 hour with a scripted insert,
  but **review the script's output by hand** — do not blindly prepend.
- **Replace placeholders is not needed** in `/LICENSE` itself (the "How
  to Apply" section is meant to stay as the template); the copyright
  assertion belongs in the source headers and/or `README`/`AUTHORS`, not
  by editing the GPL text body.

### 1.2 Vendored third-party notices

- **MathJax:** copy `LICENSE` (Apache-2.0) into
  `apps/desktop/vendor/mathjax/`. The vendor README already documents the
  refresh procedure (`npm pack mathjax@<v>`); add "copy `package/LICENSE`"
  to that procedure so it never drifts again.
- **Font Awesome Free:** copy the FA Free license text (the combined
  CC-BY-4.0 / SIL-OFL-1.1 / MIT notice that ships in the package) into
  `apps/desktop/vendor/fontawesome/`. Add the same "copy LICENSE" step to
  its vendor README. FA's attribution clause is the most demanding of the
  bundled deps — do not skip it.
- **tree-sitter grammars** under `vendor-grammars/` already retain their
  `LICENSE` files — leave as-is; spot-check no new grammar gets added
  without one.

### 1.3 A `THIRD-PARTY-NOTICES.md` (aggregate notice)

For a distributed binary app, the cleanest single artifact is an
aggregate notices file at the repo root (or `docs/`) listing every
bundled/redistributed third-party component, its license, and a link.
This is the thing you point to from an About box and from the GPL §6
"appropriate copyright notice" requirement. Seed it from:
- vendored: MathJax (Apache-2.0), Font Awesome Free (CC-BY/OFL/MIT),
  the three `vendor-grammars/*`.
- shipped npm runtime deps: `marked`, `@xterm/xterm`, `@xterm/addon-fit`,
  `pdfjs-dist`, Electron.
- (defer the devDep grammar list — those aren't redistributed.)

A `license-checker`-style tool can generate a first draft, but **commit a
reviewed, hand-curated file**, not raw tool output — the runtime-vs-dev
distinction matters and tools get it wrong.

### 1.4 The "private: true" question

Every `package.json` is `private: true` and versioned `0.0.0`. This is
correct *if* you never publish to npm and only distribute the built
Electron app. **Decision needed:** do you intend the `@editor/*` packages
(or a future `@jmacs/*`) to be installable from npm? If no — keep
`private: true`, and this is a non-issue. If yes — that's a separate,
larger workstream (public package names, real versions, an exported API
surface, README per package) that should **not** be bundled into launch.
**Recommendation:** keep private for launch; the app is the deliverable,
not the libraries. Revisit only if extension authors actually ask to
depend on the packages directly.

**Effort for §1:** half a day total. **Sequence:** 1.1 first (it's the
legal anchor), then 1.2/1.3 together, 1.4 is a one-line decision.

---

## 2. Community health files & GitHub setup  `[P0/P1]`

### 2.1 `CONTRIBUTING.md`  `[P0]` — translate `CLAUDE.md` for humans

`CLAUDE.md` already encodes a *complete and thoughtful* contribution
discipline — but it is written for AI sub-agents ("Sub-agents work on
branches named for their role"; territory ownership phrased as agent
assignment; stop-and-ask via `architect-notes.md`). An outside human
reading it would be confused about what applies to them.

`CONTRIBUTING.md` should **extract the human-relevant subset** and
re-voice it. The mapping:

| `CLAUDE.md` rule | Human translation |
|---|---|
| "Never commit directly to `main`" + pre-commit hook (`.githooks/pre-commit`) | "Work on a branch, open a PR. The pre-commit hook runs tests and blocks `main` — enable it: `git config core.hooksPath .githooks`." |
| Branch naming `agent-N-role` | Humans use `feature/…`, `fix/…`, `docs/…` (the hook already accepts these — `.githooks/pre-commit` regex). |
| "Commit often, Conventional Commits, subject < 72 chars" | Keep verbatim; this is good universal advice. |
| "Every commit must pass tests" / "Run the full suite before committing" | Keep. Document `pnpm test`, `pnpm --filter @editor/<pkg> test`, the smoke caveat (unit tests stub host primitives — see `CLAUDE.md`). |
| Territory ownership (one package per role) | Reframe as the **package map** (see §5) so a contributor knows where a change belongs and what its blast radius is. |
| "Stop and write to `architect-notes.md`" | Humans → "open an issue or a draft PR and ask" instead. |
| `docs/VIEWS.md` must-read for view/pane work | Keep, prominently — it's the highest-leverage onboarding warning in the repo. |
| `docs/GUARDRAILS.md` (overnight AI runs) | **Omit** from CONTRIBUTING — it's AI-ops, not human contribution. |

Also state explicitly, because they're real and a contributor will hit
them:
- **The CLA/copyright-assignment stance.** Decision needed (§4): by
  default, GPL inbound=outbound (contributors license their patches under
  GPL-3.0-or-later, no assignment). State this in one sentence — it's the
  least friction and the honest default. Avoid a CLA unless you have a
  concrete relicensing plan; CLAs deter exactly the small contributors
  this project wants.
- **The stability contract** (link to §3): "APIs and keybindings change
  freely at this stage — read STABILITY.md before building on internals."
- **The "no build step" invariant** — contributors must not introduce a
  bundler/transpiler; it's an architectural commitment
  (`README.md:251`, "There is **no bundler**").

Fix while writing it: the README says `pnpm dev` (`README.md:103`) but
`CLAUDE.md` documents that `pnpm dev` is currently broken (citation-js
ignored-build placeholder) and the working invocation is
`cd apps/desktop && ./node_modules/.bin/electron .`. **Pick one truth and
make README + CONTRIBUTING agree.** A first-time contributor following the
README will hit the broken path immediately. (This overlaps with pillar
01 Packaging — coordinate so it's fixed once.)

### 2.2 `CODE_OF_CONDUCT.md`  `[P1]`

Adopt **Contributor Covenant 2.1** verbatim, with Jason's email
(`jmckalex@gmail.com`, already public in `package.json`) as the contact.
This is a 10-minute task with outsized signalling value (it tells
strangers the space is safe to enter) and essentially zero ongoing cost
at this scale. Don't write a custom one.

### 2.3 `SECURITY.md`  `[P1]`

Short. "jmacs is beta software; report vulnerabilities privately to
<email> rather than a public issue; expect best-effort, not SLA-backed,
response." Electron apps have a real attack surface (the app runs a pty,
fetches URLs in `<browser-view>`, executes Lisp/JS) — a one-paragraph
honest policy is appropriate and protective.

### 2.4 `.github/` scaffolding  `[P1]`

Create `.github/` with:
- **Issue templates** (`ISSUE_TEMPLATE/`): `bug_report.md`,
  `feature_request.md`, and a `config.yml` that points "questions" to
  Discussions (§2.5). Keep them short — long templates suppress reports.
- **PR template** (`PULL_REQUEST_TEMPLATE.md`): checklist — branch not
  `main`, `pnpm test` green, conventional-commit title, touched
  `docs/VIEWS.md` if views/panes changed, added a regression test for
  bug fixes (mirrors `CLAUDE.md` testing discipline).
- **Labels:** a small, curated set, not GitHub's defaults. Recommended:
  `good first issue`, `help wanted`, `bug`, `enhancement`, `lisp`,
  `view/pane`, `docs`, `breaking`, `wontfix`, `needs-design`. The
  per-package territory (§5) can map to labels (`area:buffer`,
  `area:lisp`, `area:renderer`, …) so triage routes by blast radius.
- **`FUNDING.yml`** (optional, §4): only if Jason wants a sponsor link.
  Low cost; sets no expectation by itself.

### 2.5 Discussion channel: GitHub Discussions vs Discord/Matrix  `[P1]`

| Option | Pros | Cons | Fit for jmacs |
|---|---|---|---|
| **GitHub Discussions** | Zero new infra; searchable/indexed; lives next to code; async (protects maintainer time); no moderation-presence expectation | Less "alive"; no real-time help | **Recommended.** Matches the async, low-pressure maintainer posture and the narrow audience. |
| Discord | Real-time, community feel | Expects presence; not indexed by search; history rots; moderation burden; another inbox | Premature — a real-time channel for ~10 users is mostly an obligation. |
| Matrix/IRC | Open, self-hostable, aligns with FOSS ethos | Smaller reach; still real-time-presence pressure | Defer. |

**Recommendation:** turn on **GitHub Discussions**, seed it with an
"Announcements" post and a "Show your config" category (the audience is
people who customise their tools — that category will carry the
community). Revisit a chat platform only if Discussions gets busy enough
to justify the presence cost. The defining constraint here is the
maintainer is one person who should be allowed to be asynchronous.

**Effort for §2:** CONTRIBUTING is the real work (half a day to do well —
it's a translation task, not a template drop). The rest is templates +
toggles, ~2 hours combined.

---

## 3. Stability, versioning & deprecation policy  `[P0 — this is the keystone]`

This is the section that actually resolves the brief's central tension.
The project's standing stance is **"break freely, no backward
compatibility"** (memory `feedback_no_backward_compat`, with the one
exception that *persisted data must be migrated*). That stance is correct
for a solo v0.1 — but the moment the repo is public, a stranger can build
a config, an extension, or a muscle-memory keybinding on top of it, and
"break freely" silently becomes "break *them* freely." Governance's job
is not to abolish that stance (it's a genuine asset — see memory
`feedback_python_perl_design`) but to **make it a stated, honest contract
instead of an ambush.**

### 3.1 The reconciliation: a stated alpha/beta contract

Add a `STABILITY.md` (root or `docs/`) that says, in plain language:

> **jmacs is beta software (0.x). There are no API-stability guarantees.**
> Commands, keybindings, Lisp primitives, the stdlib, and the package
> internals may change or be removed in any release. If you build on them,
> pin a commit. The *one* thing we promise not to break is **your saved
> data**: when an on-disk format changes (sessions, faces, sticky-note
> sidecars, bookmarks, config), we ship a migration so old data still
> loads.

This is not new policy — it is the *existing* policy, written down so a
newcomer reads it before, not after, getting burned. The data-migration
exception is already a real, honored invariant in the codebase
(`session.js`, `faces.json` v2 migration, `.godot-metadata` sidecars per
the memory notes) — STABILITY.md should **point at those as evidence the
promise is kept**, which makes the "we break code but never your data"
contract credible rather than aspirational.

### 3.2 Versioning intent (semver, honestly applied to 0.x)

- Adopt **SemVer with the 0.x reading**: while `0.y.z`, the leading `0`
  *means* "anything can break," and that is communicated, not hidden.
  Bump `0.MINOR` on any breaking change, `0.0.PATCH` for fixes. This is
  semver-legal and exactly matches "break freely."
- **Start cutting tagged releases.** Today everything is version `0.0.0`
  with no tags surfaced. Move root `package.json` to a real `0.1.0` at
  launch and tag it. A version number is the unit a stability promise
  attaches to; "break freely between 0.x releases, here is which release
  you have" is a coherent contract. "Break freely against an untagged
  rolling `main`" is not.
- **State the eventual 1.0 meaning:** "When jmacs reaches 1.0, a defined
  subset (the Lisp language core + the L2 buffer API documented in
  `docs/api/layer2.md`) becomes a stability surface; everything else
  stays fluid." This gives contributors a sense of where the ground will
  eventually harden without committing you to it now.

### 3.3 Change-communication channel: a `CHANGELOG.md`

The minimum viable deprecation policy for a "break freely" project is
**not** a deprecation *cycle* (that contradicts the stance) — it is
**reliable change announcement**. Add a `CHANGELOG.md` (Keep-a-Changelog
format) with an explicit **`### Breaking`** section per release. The
contract becomes: *we break things, but every break is listed in one
place you can read before upgrading.* That is the honest, low-cost
substitute for a deprecation pipeline, and it fits the solo cadence
(`architect-notes.md` already functions as a running decision log — the
CHANGELOG is its public, curated face).

For the rare case where a deprecation *warning* is cheap and kind (e.g. a
removed command), a one-line "X was removed in 0.N, use Y" in the
CHANGELOG and, optionally, a transient `M-x` notice is enough. Do not
build a general deprecation-shim framework — that's exactly the cost the
"no backward compat" stance exists to avoid.

**Effort for §3:** STABILITY.md ~1 hour (it's writing down what's already
true); CHANGELOG.md scaffold ~30 min + ongoing discipline; the version
bump + first tag ~30 min. **This is P0 because it is the precondition
that makes a public launch honest** — without it, "break freely" plus
public users is a credibility trap.

---

## 4. Maintainer-load model  `[P0 decision, low implementation cost]`

The brief is right that this is where solo projects die or burn out the
author. The governance choice is **which promise Jason makes about his
own time** — and the cardinal rule is *under-promise*. Three viable
models:

### Model A — BDFL with explicit response limits  `[recommended]`

Jason remains sole decision-maker, and the project **states up front that
response is best-effort and may be slow or absent**. Concretely:
- A line in README/CONTRIBUTING: *"This is a personal project maintained
  by one person in spare time. Issues and PRs are read but may not get a
  response. I merge what fits the vision; I may decline good PRs that
  don't. Forks are welcome and encouraged."*
- Discussions (not real-time chat) as the contact surface (§2.5).
- No SLA, no triage cadence promised.

**Pros:** matches reality; protects the author; sets correct
expectations; preserves the singular design vision that *is* the project
(`docs/VISION.md`). **Cons:** some contributors bounce off "may not
respond." That is an acceptable, even desirable, filter for an audience
defined as "people who'd have built it themselves" — they fork.

### Model B — Recruit a co-maintainer

Add a second committer to share triage/review.
**Pros:** bus-factor > 1; sustainability. **Cons:** premature — there is
no contributor community yet (745/745 commits are Jason's); a
co-maintainer with no shared history dilutes the vision; recruiting and
onboarding one is itself a time cost. **Verdict:** not now. Revisit
*after* a contributor has organically landed several quality PRs — that
person self-selects into the role. Don't appoint, let it emerge.

### Model C — "Personal project, forks welcome" (no contribution intake)

Explicitly close the door: "I share this so you can use and fork it; I'm
not accepting PRs."
**Pros:** maximal author-time protection; brutally honest. **Cons:**
forecloses the small upside of good drive-by fixes; slightly colder than
the audience deserves; arguably wastes the strong onboarding docs already
written. **Verdict:** too closed given how *landable* the codebase
already is (§5) — but it's the correct fallback if intake ever becomes a
burden.

**Recommendation: Model A.** It is the honest description of the project,
it costs one paragraph, and it keeps the door open without promising what
can't be sustained. The GPL inbound=outbound default (§2.1) pairs with it:
no CLA, contributors keep their copyright, patches come in under GPL.

**On funding (`FUNDING.yml`):** orthogonal to the maintainer model. A
GitHub Sponsors / Ko-fi link is a low-cost, no-obligation add that some
of the "people who'd build it themselves" will use to say thanks. It does
**not** convert Model A into an SLA — state that explicitly if added.
**Recommendation:** optional, Jason's call; if added, one line clarifying
it buys gratitude, not guaranteed response.

---

## 5. Contributor-readiness — what makes this landable by a stranger  `[P1]`

Good news first: **the codebase is unusually landable for a solo project.**
The README is genuinely good (architecture table, layer map, quick start,
keybindings, design principles — `README.md`), `docs/ARCHITECTURE.md`
explains the five layers, `docs/VIEWS.md` is a hard-won bug-family
playbook, `docs/spec/lisp.md` specifies the language, `docs/api/layer2.md`
documents the core API, and there's a generated reference under
`docs/build/`. Most projects launch with far less. The gaps are
*organizational*, not *missing content*.

What to add:

### 5.1 A package-territory map (turn `CLAUDE.md` territory into a contributor map)

`CLAUDE.md` already enumerates which package owns which layer; the README
has the layer table. Promote this into an explicit **"where does my
change go / what's its blast radius"** map in CONTRIBUTING:

| Area | Package | Touch this when… | Blast radius |
|---|---|---|---|
| Host/Electron | `apps/desktop` | window, FS, IPC, native | main-process; needs full relaunch to test |
| Storage (L1) | `packages/storage` | text data structure, edit events | everything above it |
| Buffer (L2) | `packages/buffer` | cursor, selection, edits, events | the API every extension uses |
| Lisp (L3) | `packages/lisp` | the interpreter | every command/stdlib |
| Renderer (L4) | `packages/renderer` | DOM projection, input, highlighting | display only (never mutates buffer) |
| View | `packages/view` | per-tab surfaces | **read `docs/VIEWS.md` first** |
| Pane | `packages/pane` | split-tree layout | **read `docs/VIEWS.md` first** |
| Stdlib | `packages/stdlib/lisp` | commands, keymap (in Lisp) | user-facing behaviour; hot-reloadable |

Add the **reload semantics** a contributor needs (already in `CLAUDE.md`,
surface it): renderer/Lisp/stdlib edits → Cmd+R reload; main-process
edits → full relaunch. And the **test caveat** (unit tests stub host
primitives, so primitive bodies must be sanity-checked in the running
app, not just via green suites).

### 5.2 "Good first issues"

The single most effective contributor-acquisition lever. Seed 5–10 issues
that are real, small, and self-contained, labelled `good first issue`,
each with a pointer to the relevant package and doc. Candidates visible
from the repo state:
- Bind the already-built-but-unbound `swap-views`/`permute-views` commands
  (memory: "commands left UNBOUND … bind if wanted").
- Reconcile the `pnpm dev` README/CLAUDE discrepancy (good doc-first task).
- Add a tree-sitter grammar following the `vendor-grammars/` pattern
  (well-documented, isolated, satisfying).
- Add missing vendored `LICENSE` files (§1.2) — trivial, teaches the repo
  layout.
- The shell-view residual-strip cosmetic bug (memory
  `project_shell_v4_residual_strip`) — scoped, visible payoff.

Each "good first issue" should name the file(s) and the test command — the
docs to do this already exist; the work is writing the issues.

### 5.3 A one-page "Hacking on jmacs" / dev-setup doc

A short `docs/DEVELOPMENT.md` (or a CONTRIBUTING section) that is the
*verified* path from clone to running editor to passing tests, including
the `electron .` vs `pnpm dev` truth, the smoke test, the screenshot
script, and the reload model. README has fragments; one authoritative
verified page removes the first-hour friction. (Coordinate with pillar 01.)

**Effort for §5:** the map is an hour (content exists). Good-first-issues
are ~2–3 hours of issue-writing but the **highest-ROI community
investment** in this plan. DEVELOPMENT.md ~half a day, overlapping 01.

---

## 6. Naming / branding decision  `[P1 — resolve before launch]`

There is a real, visible naming inconsistency:

- The project / repo / root package is **`jmacs`** (`package.json:2`,
  `README.md:1`, `github.com/jmckalex/jmacs`).
- The npm package scope is **`@editor/*`** (all packages), and the app
  window title is literally **`<title>editor</title>`**
  (`apps/desktop/index.html:9`).

So the public name is "jmacs" but the *code* calls itself "editor"
throughout. A visitor who installs it sees a window titled "editor". This
must be reconciled before launch — not because either name is wrong, but
because the split reads as unfinished.

**Naming considerations specific to "jmacs":**
- **Pro:** instantly communicates the lineage ("Emacs-like, by jm"); the
  README leans into "a successor in spirit to Emacs" (`README.md:3`); it's
  short and the domain/repo are taken.
- **Con/risk:** "jmacs" is an *existing, unrelated* program (Joe's own
  editor / a long-standing `jmacs` alias of JOE). That's a genuine
  name-collision risk for discoverability and a potential trademark
  irritant. Also, "X-macs" names invite "is this an Emacs fork?" — the
  README spends two paragraphs rebutting exactly that (`README.md:12`),
  which suggests the name is fighting the positioning.

**Decision process (not a unilateral rename — this is the architect's
call and ties into pillar 04 Positioning):**
1. **Decide the question, not just the name:** is the name meant to
   foreground the Emacs lineage (then "jmacs" is on-message and the JOE
   collision is the cost) or to stake out independence (then a
   non-"-macs" name serves better)?
2. **Clear the collision:** a 30-minute check — is "jmacs" actively
   confusing against JOE's jmacs / any trademark? Document the finding.
3. **Pick one name and make the code agree** (the actual work, regardless
   of choice):
   - app window title `<title>` → the chosen name (`apps/desktop/index.html:9`).
   - About box / splash (`apps/desktop/src/splash.js`) → chosen name +
     copyright + license (satisfies GPL §6 interactive-notice guidance).
   - decide whether the `@editor/*` scope is renamed to `@jmacs/*`. Since
     packages are `private: true`, this is cosmetic-only and **low
     priority** — defer unless you publish to npm. Don't let it block
     launch.
4. **Coordinate with pillar 04** — the name is a positioning decision as
   much as a governance one; this plan owns "make the artifacts
   *consistent* with whatever is chosen," pillar 04 owns "what the name
   *says*."

**Recommendation:** treat the name as Jason's editorial decision (do not
auto-rename). The governance deliverable is: (a) run the collision check,
(b) eliminate the `jmacs`/`editor` split so the app and repo agree, (c)
ensure the chosen name appears with copyright+license in the About/splash
for GPL compliance. The `@editor/*`→`@jmacs/*` scope rename is explicitly
**out of launch scope** (private packages, no functional effect).

---

## 7. Prioritized roadmap (effort × sequence)

Legend: **P0** = blocks an honest public launch · **P1** = should ship
with launch · **P2** = post-launch.

### P0 — before the repo is public (or immediately, if it already is)

1. **Confirm GitHub repo visibility** (5 min). Everything downstream
   depends on whether the gaps are already exposed.
2. **Assert copyright** — `AUTHORS`/README line + SPDX headers on
   first-party source (§1.1). ~1–2 h.
3. **Vendored license notices** — MathJax + Font Awesome `LICENSE` files
   + `THIRD-PARTY-NOTICES.md` (§1.2/1.3). ~2 h.
4. **`STABILITY.md`** — write down the existing "break freely, never your
   data" contract; bump version to `0.1.0`; cut the first tag (§3). ~2 h.
5. **`CONTRIBUTING.md`** — translate `CLAUDE.md` for humans; fix the
   `pnpm dev` discrepancy (§2.1). ~half day.

### P1 — ships with launch

6. **`CODE_OF_CONDUCT.md`** (Contributor Covenant 2.1) + **`SECURITY.md`**
   (§2.2/2.3). ~30 min.
7. **`.github/` scaffolding** — issue/PR templates, label set (§2.4). ~2 h.
8. **Enable GitHub Discussions**, seed it (§2.5). ~30 min.
9. **`CHANGELOG.md`** with a `### Breaking` section + first entry (§3.3).
   ~30 min.
10. **Resolve the naming split** — collision check + make app title/splash
    agree with repo name + license-in-About (§6). ~2 h (excludes scope
    rename).
11. **Package-territory map** in CONTRIBUTING + **5–10 good-first-issues**
    (§5.1/5.2). ~half day — highest community ROI.
12. **Maintainer-model paragraph** (Model A) in README/CONTRIBUTING (§4).
    ~15 min.

### P2 — after there are actual contributors

13. `docs/DEVELOPMENT.md` authoritative verified setup (overlaps pillar
    01). 
14. Decide co-maintainer (Model B) only if/when one self-selects (§4).
15. `@editor/*`→`@jmacs/*` scope rename + npm publication — only if
    extension authors ask to depend on packages (§1.4/§6).
16. `FUNDING.yml` — Jason's call, anytime (§4).

**Critical path to "joinable":** P0 items 1–5 make the launch *honest and
legal*. P1 items 5–11 make it *joinable*. Everything in P2 is demand-driven
— deliberately deferred so launch governance is not over-built for a
community that doesn't exist yet.

---

## 8. Decisions the architect must make (the stop-and-ask list)

These cannot be decided unilaterally; they are editorial/legal/personal:

1. **Copyright form** — `AUTHORS` line only, or full per-file SPDX headers?
   (Recommend: SPDX headers — §1.1.)
2. **CLA vs inbound=outbound** — any plan to relicense later that would
   need a CLA? (Recommend: no CLA, GPL inbound=outbound — §2.1/§4.)
3. **Maintainer model** — A (BDFL, best-effort), B (co-maintainer), or C
   (forks-only)? (Recommend: A — §4.)
4. **Name** — keep "jmacs" (lean into lineage, accept JOE collision) or
   rename (stake independence)? Either way the `jmacs`/`editor`
   inconsistency gets fixed. (Architect's call — §6.)
5. **npm publication** — keep packages `private`, or publish? (Recommend:
   private for launch — §1.4.)
6. **Funding link** — add `FUNDING.yml` or not? (Optional — §4.)

Each has a recommendation above; none should block the P0 legal/stability
work, which is correct regardless of how these land.
