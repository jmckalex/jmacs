# 04 — Positioning, README & Launch Go-to-Market

**Pillar:** the message, the show-don't-tell assets, and where/how/when to
announce.

**Status of this document:** a plan, not an implementation. Nothing here is
built yet. Claims about the editor are grounded in the repo as of `main @
2f6e970` (1725 tests green per `HANDOVER.md`).

**The honest framing that governs everything below:** this is a v0.1 beta,
solo-built, macOS-only, with no view virtualisation, no LSP, procedural
(non-hygienic) macros, per-keystroke undo, and no package manager
(`README.md` §"Known limitations"; `plans/ROADMAP.md`). The launch must
*lead with the soul* (Lisp-as-living-environment, beautiful-by-default,
legible architecture) and be *scrupulously honest about the edges*. The
fastest way to fail this launch is to oversell stability or completeness to
an audience (ex-Emacs people) that will install it in five minutes and find
the seams.

---

## 0. Dependencies on the other pillars (read first)

This pillar is the *last* to fire. It is gated by the others, and the
launch-day playbook (§7) assumes they are done:

| Depends on | Pillar | Why it blocks launch |
|---|---|---|
| A stranger can `install && run` in ~5 min on a clean Mac | **01 Packaging & first-run** | A README "above the fold" demo is worthless if step 1 (install) fails. Hard blocker. |
| Doesn't crash, doesn't lose data on the happy path | **03 Stability & data safety** | A front-page surge will find the crash. Data loss on launch day is reputational death. Hard blocker. |
| `init.lisp` + a documented "first extension" path + API reference reachable | **02 Extension onboarding & docs** | The whole pitch is "you can extend it." The README's "first extension" link (§3) must land on real docs. Hard blocker. |
| LICENSE clarity, CONTRIBUTING, issue templates, "I am one solo maintainer" expectation-setting | **05 Governance & community** | Needed to survive the issue surge (§7.4). Soft blocker — can ship thin. |

**Sequencing rule:** do not announce until 01 + 03 + 02 are at their
"minimum viable launch" bar (§6). Positioning/README work (§1–§4) can and
should proceed *in parallel* with those — it has no code dependency and the
assets take real time to produce well.

---

## 1. The one-sentence pitch and the "why this exists" narrative

### 1.1 The pitch (canonical, one sentence)

The repo already has three candidate one-liners. They are good and should be
reused, not reinvented:

- `docs/VISION.md:5` — the full, literary version (one long sentence).
- `README.md:3` — *"A Lisp-extensible text editor — a successor in spirit to
  Emacs, on a clean foundation."*
- `package.json` — *"A Lisp-extensible editor with an Electron presentation
  layer."* (too dry for marketing; keep for metadata only.)

**Recommended canonical pitch (the one that goes in the GitHub repo
description, Show HN title, og:description, Mastodon bio):**

> **jmacs — a Lisp-extensible editor that takes Emacs's best idea (the
> editor as a living environment you reshape from inside) and rebuilds it on
> a clean, legible foundation.**

For the *Show HN title* specifically (HN penalises adjectives and hype),
strip it to:

> **Show HN: jmacs – a Lisp-extensible editor, a clean-foundation successor
> to Emacs**

### 1.2 The differentiator sentence (the thing nobody else says)

The single most defensible, true, and *non-obvious* claim — and the one to
hammer — is the **Lisp-UI / JS-engine split**
(`MEMORY.md` → `feedback_lisp_ui_js_engine`; first realised in the
face-customization feature):

> **The customization surface is a custom Lisp; the heavy lifting is
> JavaScript; and the JavaScript defaults are overridable from Lisp, live,
> while the editor runs.** That is a deliberate answer to Emacs's
> "everything is in Elisp, so everything is slow and tangled" problem.

Nobody in the comparison set (§1.4) makes exactly this trade. It is the
spine of the narrative.

### 1.3 The "why this exists / why not X" narrative (the essay)

A tight 4-paragraph version for the README "What it is" / a blog post /
the HN top comment the author posts themselves. Grounded in `docs/VISION.md`.

1. **The itch.** Emacs is the only editor that treats the boundary between
   "user" and "developer of the editor" as artificial — and its users love
   it past all reason for exactly that. But it carries forty years of
   incidental complexity, its aesthetics are an afterthought, and its
   "everything in Elisp" model means the extension language is also the
   performance bottleneck. (`VISION.md` §"The Organising Principle",
   §"Aesthetic Commitment".)

2. **The bet.** Three things converged in 2026 that make a clean rebuild
   tractable for one person: tree-sitter as a universal parser, LSP as a
   universal language-integration protocol, and AI-assisted coding
   collapsing the implementation distance. (`VISION.md` §"Why Now".) jmacs is
   what one person with taste can now build that used to need a team.

3. **The shape.** Five layers, each with a narrow interface
   (`docs/ARCHITECTURE.md`): host (Electron) → storage (rope) → buffer
   (the semantic model) → Lisp runtime → renderer. The Lisp is the *idiom*;
   JavaScript is the *engine*; both bind to the same buffer API; Lisp can
   override JS defaults live. The organising principle is **legibility** —
   when two designs conflict, the more comprehensible one wins.

4. **The honest scope.** It is not an Emacs clone and runs zero Emacs code
   (`ARCHITECTURE.md` §"What the Architecture Is Not"). It is not trying to
   be VS Code. It is built for "the people who would have built it
   themselves if they'd had time" — and if a hundred such people use it
   seriously, that's success. It is a v0.1 beta, macOS-only, one window.

### 1.4 Honest positioning against the field

Keep this table *in the launch blog post / a `COMPARISON.md`*, **not** in the
README above-the-fold (it invites flame wars in the wrong context). Every
cell must be defensible.

| Editor | What it has that jmacs doesn't | What jmacs offers instead | The honest line |
|---|---|---|---|
| **Emacs** | 40 years of packages; an enormous community; cross-platform; battle-tested | Clean legible architecture; beautiful by default; Lisp-UI/JS-engine split; tree-sitter highlighting standard, not bolted on | "A successor in spirit, not a continuation. We run no Elisp and don't try to." |
| **Neovim** | Huge plugin ecosystem; Lua + fast core; ubiquitous | Lisp as a real Lisp (closures, macros, modules, hot reload); a graphical substrate (browser/PDF/shell/notebook views) without a terminal ceiling | "Neovim's extension story is excellent; ours is a different language and a richer presentation layer." |
| **Zed** | Native performance; collaboration; a real company behind it; multi-platform | Live in-editor extensibility in a Lisp REPL against your live buffers — no recompile, no extension API ceremony | "Zed is fast and polished and not built to be reshaped from inside while running. That's the whole point of jmacs." |
| **Helix** | Modal editing; tree-sitter + LSP out of the box; no-config | A full extension language and a graphical substrate | "Helix is a beautiful no-config tool. jmacs is the opposite philosophy: a substrate you live inside and reshape." |
| **Lem** | A Common Lisp editor, genuinely Lisp-extensible, mature-ish | A clean custom dialect designed for the editor; a graphical Electron substrate; beautiful-by-default aesthetics; the JS engine | "Lem is the closest peer. The honest difference: Lem is CL-on-a-terminal; jmacs is a purpose-built dialect on a graphical substrate with a JS engine underneath." |
| **VS Code** | Everything, for everyone | Not trying to be VS Code (`VISION.md` §"What It's Not Trying To Do") | Don't compare. State the non-goal and move on. |

**Lem is the comparison that matters most** and the one a sharp HN/Lobsters
commenter *will* raise. Pre-empt it: have the answer ready in the launch post
and in the author's own first HN comment. Being caught flat-footed on "isn't
this just Lem?" is the single most likely way the launch narrative wobbles.

---

## 2. Differentiators to showcase, and HOW — the shot list

The README's current "Highlights" (`README.md:58–93`) **undersells the
editor**. It omits the most demo-worthy recent work. Verified in the repo,
these are the flagship demos that are *real and shippable today*:

- **Tree-sitter highlighting across ~40 languages** — 38 grammars in
  `packages/renderer/vendor/tree-sitter-*.wasm` (bash, c, clojure, cpp,
  csharp, css, dockerfile, elixir, erlang, go, graphql, haskell, html,
  java, javascript, json, kotlin, latex, lua, make, markdown, nix, ocaml,
  perl, php, python, ruby, rust, scheme, sql, swift, toml, typescript, xml,
  yaml, zig, …), each wired in `packages/renderer/src/languages/`.
- **Language injection** — fenced code blocks in Markdown highlight in their
  own language, paragraphs inject `markdown_inline`, and **LaTeX math inside
  Markdown highlights with the full LaTeX palette** (`languages/markdown.js`
  injection query; `math-highlight-test-2.md`,
  `sample-documents/math-highlight-test.md`). PHP↔HTML injection too
  (`languages/php.js`, `php-only.js`).
- **The LaTeX / AUCTeX / RefTeX / SyncTeX stack** — 12 Lisp files in
  `packages/stdlib/lisp/` (`latex*.lisp`, `reftex*.lisp`, `cite.lisp`,
  `latex-synctex.lisp`): compile, navigate, fill, insert, citation pickers,
  forward/inverse SyncTeX search.
- **MathJax math preview** — a mode-agnostic engine
  (`packages/renderer/src/math-preview.js`, `math-preview-providers.js`,
  `typeset-math.js`; vendored MathJax in `apps/desktop/vendor/mathjax`), live
  in latex-mode and markdown-mode (`C-c C-p`).
- **Live face customization** — `C-h F` inspects the face under point; `C-h
  C-f` (`highlight-construct-at-point`) creates and assigns a face to a
  construct (this-mode or whole-language), live (`face-info.lisp`,
  `faces.lisp` → `create-face!`; `faces.json` v2).
- **The Lisp REPL sharing live editor buffers** — already the subject of the
  current screenshot: `(insert! …)` edits the visible document; modules and
  hot reload work against the running editor.
- **Eight view kinds** — `view-elements.js`: browser, pdf, image, shell
  (xterm + real pty), audio, gnuplot, notebook, video.

### 2.1 The asset strategy

- **Format:** short, captioned, *muted/looping* MP4 (convert to GIF only as a
  fallback for sites that won't embed video; GIFs of code are huge and ugly).
  Keep each clip **8–20 seconds**, one idea per clip. No music. A subtle
  keystroke overlay (show the chord being pressed) is worth the effort for
  the Lisp/REPL clips.
- **Recording surface:** the real app, on a Retina Mac, at the existing
  beautiful default theme. Use a clean window (no dev console). Capture at
  2x then downscale for crispness.
- **The hero asset (above-the-fold):** ONE clip, ≤20s, that shows the *whole
  thesis in a single take*: edit a `define` in a `.lisp` buffer → switch to
  the REPL → call the function you just changed → watch the buffer update.
  This is the "living environment" claim, demonstrated, not asserted. The
  current static screenshot (`docs/screenshot.png`) already stages exactly
  this scene — the hero clip is the moving version of it.

### 2.2 The shot list (priority-ordered)

Each entry: **what to film · the chord/keys · the "aha" · why it's
load-bearing.** Numbered by launch priority.

1. **Hero — REPL acts on the live buffer.**
   *Film:* a `.lisp` buffer with `(define (greet n) …)`; edit it; `C-x p`
   open REPL; type `(greet "world")` → answer; type `(insert! "…")` → the
   buffer above visibly changes.
   *Aha:* the editor is a running Lisp you talk to.
   *Load-bearing:* this is the entire pitch. If only one asset exists, it's
   this one. (Stages the existing screenshot scene.)

2. **Live `C-h C-f` face customization.**
   *Film:* point on some syntactic construct; `C-h F` shows what face it is;
   `C-h C-f`; pick a colour; the construct (and all siblings) recolour
   *instantly*, no reload.
   *Aha:* you can re-theme a single syntactic category, live, in two
   keystrokes.
   *Load-bearing:* the cleanest 12-second proof of Lisp-UI/JS-engine — the
   override layer is Lisp, the rendering is JS, and you see it happen live.

3. **Math preview updating as you type.**
   *Film:* a markdown or `.tex` buffer; `C-c C-p`; type
   `$\frac{-b \pm \sqrt{b^2-4ac}}{2a}$` and watch MathJax typeset it as you
   go. Use `sample-documents/math-highlight-test.md` as the source.
   *Aha:* a real math/writing tool, not a toy.
   *Load-bearing:* speaks to the *actual user* (the author writing a book)
   and to the math/academic slice of the audience.

4. **Markdown ↔ LaTeX-math injection (the new highlighter).**
   *Film:* open `math-highlight-test-2.md`; show that `$E=mc^2$` and a
   display-math block light up with the *full LaTeX palette* inside a
   markdown buffer; fenced ```python / ```rust blocks highlight in their own
   language in the same buffer.
   *Aha:* one document, many languages, all correctly highlighted.
   *Load-bearing:* the "~40 languages + injection" claim, shown in one frame.

5. **The book-authoring workflow (the author's real loop).**
   *Film:* the JMarkdown-style writing flow — prose with embedded math and
   citations; `C-c` RefTeX citation picker; compile; SyncTeX jump from source
   to PDF in the `pdf-view`.
   *Aha:* this is a serious authoring environment, used to write a real book.
   *Load-bearing:* the credibility multiplier — "the author writes their book
   in it" is the strongest possible dogfooding signal (`VISION.md`
   §"Personal Context"). Keep this one *longer* (30–45s) as a deep-dive on
   the project page, not above-the-fold.

6. **Hot reload of the editor's own stdlib.**
   *Film:* edit `forward-word` in a stdlib `.lisp` file; `C-x C-r`; the
   behaviour changes immediately.
   *Aha:* the editor edits and reloads itself.
   *Load-bearing:* the self-hosting claim, made concrete.

7. **The graphical substrate montage.**
   *Film:* a fast cut through the non-text views — a `browser-view`, a
   `pdf-view`, a `shell-view` (real terminal), a `gnuplot-view` rendering a
   plot, an `image-view`, the notebook. 2–3s each.
   *Aha:* this isn't a terminal editor; it's a graphical substrate.
   *Load-bearing:* differentiates hard from Emacs/Neovim/Helix/Lem.

8. **Panes & tabs.**
   *Film:* `C-x 2` / `C-x 3` splits; tab strips; `C-x +` add-pane mode.
   *Aha:* real window management.
   *Load-bearing:* table-stakes; reassures that the basics are there.

**Build order for assets:** 1 → 2 → 3 → 4 are the launch-critical four (the
README above-the-fold and the HN/Lobsters submission lean on these). 5–8 are
for the project page and the "deep dive" blog post; nice-to-have for day one.

---

## 3. README structure

The current `README.md` is already strong (13.6 KB, well-organised) — this is
a **revision, not a rewrite.** The biggest gaps: (a) no above-the-fold
*moving* demo, (b) "Highlights" omits the flagship features in §2, (c) the
"first extension" on-ramp isn't surfaced. Target structure:

1. **Above-the-fold (first screenful, before any heading).**
   - Name + the one-sentence pitch (§1.1).
   - **The hero clip (shot #1)** embedded immediately — moving, captioned.
   - A 2–3 line "what it is" with the differentiator sentence (§1.2).
   - Three badges max: license (GPL-3.0), platform (macOS), status
     (**v0.1 beta / alpha-quality** — be loud about this).
   - One line: *"macOS only · solo-built · expect rough edges — see
     [Status](#status)."* Set expectations before the reader is excited.

2. **A 4-clip "see it" strip** — shots #2 (face), #3 (math), #4 (injection),
   #6 (hot reload), each with a one-line caption. This replaces a wall of
   prose; it *shows* the differentiators.

3. **Why it exists / why not Emacs/Zed/…** — the 4-paragraph narrative
   (§1.3), condensed. Link out to `COMPARISON.md` for the full table (§1.4)
   rather than inlining it.

4. **Install / Quick start.** Whatever pillar 01 ships. If it's a notarised
   `.dmg`, that's the headline; the `git clone && pnpm install && pnpm dev`
   path becomes the "build from source" fallback. **Fix the known caveat:**
   `CLAUDE.md` says `pnpm dev` currently fails on a `citation-js` ignored-
   build placeholder and the real launch is `cd apps/desktop &&
   ./node_modules/.bin/electron .` — the README *must not* tell a stranger to
   run a command the maintainer themselves avoids. (Flag to pillar 01.)

5. **Your first extension** — a 10-line, copy-pasteable example that edits
   `init.lisp` (which the app writes into the per-user config dir on first
   run — `apps/desktop/src/app.js:204`, `INIT_TEMPLATE`) and a link to the
   full extension guide (pillar 02). This is the "you can shape this tool"
   promise made actionable in the first 60 seconds. **There is no package
   manager yet** — the first extension is `init.lisp` + the REPL, full stop.
   Do not imply an extension marketplace.

6. **The Lisp** — keep the existing section (`README.md:159–199`); it's good.
   Keep the honest note that macros are procedural, not hygienic.

7. **Architecture** — keep the existing five-layer table (`README.md:200`);
   it's excellent and on-brand for "legibility."

8. **Status & expectations** — keep and *strengthen* the existing
   "Known limitations" list (`README.md:284`). Add an explicit alpha banner:
   *"This is software one person uses daily and is sharing early. It will
   have bugs. It is macOS-only. There is no auto-update, no package manager,
   no LSP yet. File issues; be patient with a solo maintainer."*

9. **Development / Contributing / License** — keep; thin links to pillar 05
   artifacts (CONTRIBUTING, governance).

**README anti-patterns to avoid:** no feature-count bragging ("90+
primitives!" reads as defensive); no benchmarks (there's no virtualisation —
don't invite the large-file test); no roadmap promises with dates; no
"compare us to Emacs" table above-the-fold.

---

## 4. Landing page / site — build or not?

**Recommendation: a one-page static site, yes — but only if pillar 01/03/02
are done and there's slack. It is a *multiplier*, not a *blocker*.**

The repo already has most of the raw material:
- A built HTML doc site under `docs/build/` (`MANUAL.html`, a `reference/`
  tree, `manifest.json`, `assets/`) generated by `scripts/build-docs.js`.
- A 538-line `docs/MANUAL.jmd` manual.
- The screenshot and (soon) the shot-list clips.

So the marginal cost of a landing page is low. What it needs, minimally:

- **One page**, the hero clip auto-playing (muted, loop), the pitch, the
  4-clip strip, a big "Download for macOS" button (or "Build from source"),
  and a link to the docs site and the GitHub repo.
- **Good `og:` / Twitter-card meta** — when the HN/Mastodon link is shared,
  the card should show the hero frame and the pitch. This single detail
  drives a meaningful fraction of click-through; do not skip it.
- **Host on GitHub Pages** (the doc build already targets static hosting).
  Custom domain optional; `jmacs` on a `github.io` subdomain is fine for v0.1.
- **No analytics that need a cookie banner.** A privacy-respecting counter
  (or none) fits the audience's values and avoids the banner.

**Do not** build a multi-page marketing site, a blog engine, a newsletter
signup, or anything with a backend. The audience trusts a GitHub repo more
than a slick site; over-polish reads as a product-launch, which contradicts
the "built for me, sharing early" honesty that is the project's credibility.

If time is tight: **skip the landing page, point everything at the GitHub
repo.** A great README + the doc site is a complete minimum viable presence.

---

## 5. Go-to-market — channels, audience fit, timing

### 5.1 Channel map (audience fit, ranked)

| Channel | Fit | Why / how to play it | Risk |
|---|---|---|---|
| **Lobsters** (`lobste.rs`) | **Highest** | The exact audience: language/editor/PL nerds who value legibility and a clean writeup. Tag `compsci`, `programming`, `plt`. They reward honesty and *punish* hype harder than HN. | Needs an invite to post; arrange ahead of time. |
| **Hacker News (Show HN)** | **High** | Largest reach for this audience; "Show HN: jmacs" can hit the front page. The author *must* be present in the thread all day (§7). | Front-page = traffic + issue surge + harsh comments. Survivable only if 01/03 are solid. |
| **r/emacs** | **High** | The spiritual home of the target user — but frame carefully: *"a successor in spirit, not a replacement; runs no Elisp."* Lead with respect for Emacs. | Defensiveness about "you'll never replace Emacs" — pre-empt it (you're not trying to). |
| **Mastodon (fosstodon / hachyderm)** | **High** | The author's own network + the FOSS/PL crowd; long-lived, kind, shares well. Pin the hero clip. Good *first* place to soft-launch. | Lower burst reach than HN; that's a feature for a soft launch. |
| **r/programming** | **Medium** | Broad reach but noisy; the legibility/Lisp angle can land. Secondary. | Generic audience may bikeshed "why not VS Code." |
| **r/lisp, r/ProgrammingLanguages** | **Medium** | Loves a hand-written interpreter + custom dialect; lead with the Lisp spec. | Small but high-quality. |
| **Tildes, lambda-the-ultimate, /r/Common_Lisp** | **Niche** | High-signal, low-volume; good for the deep-dive blog post. | Tiny reach. |
| **HN "Show HN" reposts / X/Twitter / LinkedIn** | **Low** | Skip or treat as afterthoughts; not the audience. | Time sink. |

### 5.2 Timing

- **Day of week:** Tuesday–Thursday, US morning (≈8–10am ET). Avoids the
  weekend graveyard and Monday firehose.
- **Don't multi-post simultaneously.** Stagger so the author can actually be
  present in each thread:
  - **T-7 to T-1 (soft launch):** Mastodon post with the hero clip; let
    friends/early followers kick the tires; fix whatever they find. This is
    the real "minimum viable launch" test (§6).
  - **T-0 morning:** Show HN **or** Lobsters (pick *one* as the primary;
    Lobsters if you have an invite and want the gentler first contact, HN if
    you want reach and are confident in 01/03). Post the other ~24h later if
    the first went well.
  - **T+1/T+2:** r/emacs (with the careful framing), r/lisp.
  - **T+3 onward:** the deep-dive blog post (the §1.3 essay expanded +
    shot #5 the book workflow + shot #7 the substrate montage) → resubmit to
    the niche channels.
- **Never launch the day before you're unavailable.** A front-page Show HN
  needs the author at the keyboard for ~12 hours. If the next 2 days are
  blocked, postpone.

### 5.3 Launch-day assets checklist (have these staged *before* posting)

- [ ] README finalised with hero clip + 4-clip strip (§3).
- [ ] The 4 launch-critical clips (#1–#4) rendered, captioned, hosted.
- [ ] `COMPARISON.md` written, with the Lem answer ready (§1.4).
- [ ] The author's *own first HN/Lobsters comment* pre-drafted: the §1.3
      narrative + the explicit "here's what's NOT done yet" list + the Lem
      comparison. Posting this yourself, first, sets the thread's tone.
- [ ] Install path verified on a *clean* Mac (pillar 01).
- [ ] Issue templates + CONTRIBUTING live (pillar 05).
- [ ] A pinned "Known issues / FAQ" GitHub issue (§7.4).

---

## 6. The minimum-viable-launch bar

The lowest bar at which announcing is *responsible* (below this, don't post):

1. **Installs and runs on a clean macOS machine** without the maintainer's
   dev environment (pillar 01). A stranger gets to a working editor.
2. **Survives the happy path without crashing or losing data** — open, edit,
   save, switch buffers, open the views, quit and reopen (pillar 03). Data
   loss on day one is unrecoverable reputationally.
3. **The hero demo (shot #1) actually works** as filmed, on a fresh install.
4. **The README is honest** about being v0.1/alpha, macOS-only, solo-built,
   no LSP / no package manager / no virtualisation (§3.8). Nothing claimed
   that isn't real.
5. **The "first extension" path works** — editing `init.lisp` takes effect,
   and the doc it links to exists (pillar 02).
6. **A place to report bugs** with a maintainer-expectations note (pillar 05).

That's it. It does **not** require: the landing page, all 8 clips, LSP, the
package manager, Linux/Windows, multi-window, or virtualisation. Those are
explicitly post-launch (`plans/ROADMAP.md`). The soft launch on Mastodon
(§5.2) is the test that the bar is cleared.

---

## 7. The launch-day playbook (surviving a front-page surge solo)

The author is a *solo maintainer*. A front-page Show HN can mean thousands of
visitors, dozens of issues, and a harsh comment thread within hours. The goal
is not to "win" — it's to make a good first impression, learn what's broken,
and not burn out.

### 7.1 Before you post (the morning of)

- Clear the calendar for the day. Be present.
- Re-verify the install path on a clean machine *that morning*.
- Open the repo's Issues, Discussions, and the HN/Lobsters tab; have them
  side by side.
- Post the author's own framing comment *immediately after submitting* (§5.3)
  — it anchors the thread in honesty and pre-empts the obvious objections
  (Lem, "why not Emacs", stability).

### 7.2 During the surge

- **Respond fast, calm, and honestly.** "Yes, that's a known limitation,
  here's the plan" beats silence or defensiveness every time. The audience
  rewards a maintainer who owns the rough edges.
- **Triage, don't fix live.** Resist the urge to ship fixes mid-thread.
  Label issues (`bug`, `known`, `wontfix-for-now`, `good-first-issue`); batch
  the fixes for after. A hot-patch pushed under pressure is how data-loss bugs
  ship.
- **Don't argue with the dismissive.** "Why not just use Emacs/VS Code?" gets
  one polite reply (link the §1.3 narrative) and then disengagement. Spend
  energy on the curious, not the contemptuous.
- **Let the demos do the talking.** When someone doubts a claim, link the
  clip. Show, don't argue.

### 7.3 Capacity / infrastructure

- **The download host must survive a spike.** GitHub Releases / GitHub Pages
  handle this; do not self-host the binary on a personal VPS.
- **No telemetry endpoint** that could fall over (there shouldn't be any —
  fits the audience anyway).
- If a `.dmg` is the install path, make sure it's **notarised** (pillar 01) —
  Gatekeeper blocking the binary on day one wastes the whole surge.

### 7.4 Issue-surge survival as a solo maintainer

- **Pin a "Known issues & FAQ" issue** before launch listing every limitation
  from `README.md` §"Known limitations" + the Lem/Emacs framing. Most
  incoming issues will be dupes of these; you close them with a link.
- **Set expectations in the issue template:** "jmacs is built and maintained
  by one person as a v0.1 beta. I read everything; I can't fix everything
  quickly. Thank you for your patience." (pillar 05 owns the template; this
  is the *content* it needs.)
- **Disable/lightly-moderate Discussions** if it becomes a support firehose;
  funnel to issues with the FAQ.
- **It's OK to step away.** Post "back tomorrow, keep the reports coming,"
  then sleep. A solo maintainer who paces themselves outlasts one who
  flames out in 48 hours. The success criterion (`VISION.md`) is *daily use
  and a handful of like-minded users*, not a viral moment.

### 7.5 What NOT to claim (the don't-say list)

- ❌ "Faster than Emacs/VS Code." (No virtualisation; large files are slow.
  `README.md` §"Known limitations".)
- ❌ "Production-ready" / "stable" / "1.0." It's v0.1 beta.
- ❌ "Cross-platform." macOS only (`ARCHITECTURE.md`).
- ❌ "Has LSP / completion / diagnostics." Not built (`ROADMAP.md`).
- ❌ "Install packages / extension marketplace." No package manager yet
  (`ROADMAP.md` — planned, 12 open questions).
- ❌ "Hygienic macros." They're procedural in this version (`README.md`).
- ❌ "Multi-window." Single window by design today.
- ❌ Any benchmark, any uptime claim, any "drop-in Emacs replacement."
- ✅ **Do** say: "v0.1 beta", "macOS only", "built by one person", "sharing
  early", "expect rough edges", "this is the editor I use to write my book."
  Underselling is the correct error to make with this audience.

---

## 8. Prioritised, sequenced work for this pillar

**Phase A — can start now (no code dependency, runs parallel to 01/02/03):**

1. Lock the canonical pitch + differentiator sentence (§1.1–1.2). *0.5 day.*
2. Write the §1.3 narrative essay and `COMPARISON.md` with the Lem answer
   (§1.4). *1 day.*
3. Record + caption the 4 launch-critical clips (#1 hero, #2 face, #3 math,
   #4 injection) (§2.2). *2–3 days — this is the long pole.*
4. Revise `README.md` per §3 (hero clip, 4-clip strip, surface `init.lisp`
   first-extension, strengthen the status banner, fix the `pnpm dev`
   install-command caveat). *1 day.*

**Phase B — gated on 01 (install) + 03 (stability) reaching MVL:**

5. Finalise the install section of the README against whatever 01 ships.
6. Build the one-page static landing site with `og:` cards (§4) — *only if
   slack; skippable.* *1 day if done.*
7. Stage the launch-day checklist (§5.3): pinned FAQ issue, pre-drafted first
   comment, clean-machine verification.

**Phase C — launch:**

8. Soft launch on Mastodon (T-7..T-1); fix what early users find.
9. Primary launch (Show HN *or* Lobsters), author present all day (§7).
10. Staggered follow-ups (r/emacs, r/lisp), then the deep-dive blog post with
    clips #5 (book workflow) and #7 (substrate montage).

**The long pole is the video assets (A3).** Start them first; everything
visual depends on them and good clips take iteration.

---

## 9. Open questions for the architect

- **Primary launch venue:** Lobsters (gentler, needs invite) or Show HN
  (bigger, harsher) for T-0? Recommendation: Lobsters first if you can get an
  invite, HN ~24h later — but your call on appetite for the HN surge.
- **Repo name vs. project name:** is "jmacs" final for the public name? It
  reads as "J's Emacs" / "JavaScript Emacs" — both are fine and on-brand, but
  worth a conscious decision before it's on a front page.
- **How much of the book to show:** shot #5 (the book-authoring workflow) is
  the strongest credibility asset but exposes your in-progress book. How much
  real content are you comfortable filming?
- **Landing page:** build it, or point everything at the GitHub repo for v0.1?
  (Recommendation: repo-only is a complete MVL; landing page is a multiplier
  to add only if 01/03/02 are comfortably done.)
- **License vs. expectations:** GPL-3.0 is set and fine; confirm pillar 05
  has the contributor/expectation framing ready before launch.
