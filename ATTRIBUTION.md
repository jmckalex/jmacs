# Third-party attribution

This editor is licensed under **GPL-3.0-or-later** (see `LICENSE`). It
redistributes the third-party components below — each under its own
license, recorded here. Where a component is *vendored* (committed into the
tree because the editor ships without a bundler) the path is given; the
rest are npm packages bundled into the packaged application.

Licenses seen here — MIT, Apache-2.0, BSD-2/3-Clause, ISC, CC BY 4.0, SIL
OFL 1.1 — are all permissive or weak-copyleft and compatible with a
GPL-3.0 combined work. One component, the `citeproc` CSL formatter, is
**strong copyleft**; it is taken under its **AGPL-3.0-or-later** arm,
which *is* GPL-3.0-compatible — see the note immediately below. A second
copyleft component, the **Stella** Atari 2600 core (GPL-2.0) behind the
*optional* `atari` element-view, carries an unresolved GPLv2↔GPL-3.0
compatibility question — see its note below; it is excludable from a
build and does not affect the rest of the editor.

> ℹ️ **`citeproc` — taken under AGPL-3.0-or-later (GPL-3.0-compatible).**
> The CSL bibliography formatter bundled inside `citation-js` (see
> *Application libraries*) is dual-licensed **CPAL-1.0 OR
> AGPL-3.0-or-later**. Its npm `package.json` records the arm as the SPDX
> id `AGPL-1.0`, but that metadata is **inaccurate**: the package's own
> `LICENSE` grants the AGPL "either version 3 of the AGPL, or (at your
> option) any later version" (preserved verbatim at
> `licenses/citeproc.LICENSE`). We take the **AGPL-3.0** arm.
>
> AGPL-3.0 is explicitly compatible with GPL-3.0: section 13 of each
> license permits conveying a combined work, with the `citeproc` portion
> remaining under the AGPL-3.0 and the rest under GPL-3.0-or-later. The
> full AGPL-3.0 text we convey for that portion is at
> `licenses/AGPL-3.0.txt`. AGPL §13's network-source obligation does not
> arise here: this is a desktop application that does not interpose
> `citeproc` over a network.
>
> *Corresponding source* (AGPL §1/§6): `citeproc` is bundled **unmodified**
> from the published npm package `citeproc@2.4.63`; its source is that
> package and its upstream repository,
> <https://github.com/juris-m/citeproc-js>.

> ⚠️ **Stella (Atari 2600 core) — GPL-2.0; GPLv2↔GPL-3.0 compatibility is
> UNRESOLVED. Confirm before a distributed build.**
> The `<stella-emulator>` web component vendored at
> `apps/desktop/vendor/stella/` embeds the
> [Stella](https://stella-emu.github.io/) emulator core compiled to
> WebAssembly. It backs the *optional* `atari` element-view (`M-x atari`).
> Stella is released under the **GNU GPL, version 2**
> (`licenses/Stella-GPLv2.txt`); *corresponding source* is the upstream
> project at <https://github.com/stella-emu/stella> (the vendored `.wasm`
> is an unmodified build of that source).
>
> This editor is **GPL-3.0-or-later**. GPLv2 combines cleanly into a
> GPL-3.0 work **only if** Stella is offered as "GPLv2 *or later*"; a
> strict **GPLv2-only** grant is *incompatible* with GPL-3.0 in a single
> combined work. Stella conveys the GPLv2 text without an explicit
> project-wide "or later" statement, so this is **not settled here**. Two
> clean resolutions: **(a)** confirm Stella's "or later" intent — then it
> is taken under GPLv3 and is fully compatible; or **(b)** treat the
> emulator as a **separately aggregated program** — it is a self-contained
> WASM module loaded dynamically and interfaced only across the DOM
> custom-element boundary, not linked into the editor's GPL-3.0 code —
> which keeps the licenses from combining. Until decided, the `atari`
> view is **excluded** by removing `element-view-atari.lisp` from
> `STDLIB_FILES` and deleting `apps/desktop/vendor/stella/`; the
> element-view *mechanism* is licence-neutral and unaffected.
>
> The bundled demo ROM **Oystron** (© 1997 Piero Cavina) is **freeware**,
> redistributable together with its documentation — kept paired at
> `apps/desktop/vendor/stella/oystron.{bin,txt}`.

---

## Application libraries (bundled into the packaged app)

| Component | Version | License |
|-----------|---------|---------|
| [Electron](https://www.electronjs.org/) — bundles **Chromium** (BSD-3-Clause and others) and **Node.js** (MIT) | 42.2.0 | MIT |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) — the PDF view | 5.7.284 | Apache-2.0 |
| [@xterm/xterm](https://xtermjs.org/) + [@xterm/addon-fit](https://github.com/xtermjs/xterm.js) — the terminal grid | 6.0.0 / 0.11.0 | MIT |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) — canvas backend for pdf.js rendering | (current) | MIT |
| [marked](https://marked.js.org/) — Markdown (CommonMark + GFM) | 18.0.4 | MIT |
| [morphdom](https://github.com/patrick-steele-idem/morphdom) — DOM diffing | 2.7.8 | MIT |
| [citation-js](https://citation.js.org/) — `@citation-js/core` + `plugin-bibtex` + `plugin-csl`; BibTeX/BibLaTeX/CSL-JSON parsing and CSL formatting | 0.7.22 | MIT — **bundles `citeproc` (CPAL-1.0 OR AGPL-3.0-or-later; taken under the AGPL-3.0 arm — see the note above and `licenses/`)** |

Vendored bundles of the last three live at
`packages/renderer/vendor/{marked,morphdom,citation-js}.esm.js`.

## Vendored UI assets

| Component | Version | License | Path |
|-----------|---------|---------|------|
| [Font Awesome Free](https://fontawesome.com/) | 7.2.0 | Icons **CC BY 4.0**, Fonts **SIL OFL 1.1**, Code **MIT** | `apps/desktop/vendor/fontawesome/` |
| [MathJax](https://www.mathjax.org/) (`tex-svg`) | 3.2.2 | Apache-2.0 | `apps/desktop/vendor/mathjax/` |
| [Stella](https://stella-emu.github.io/) — Atari 2600 core (WebAssembly) behind the optional `atari` element-view ⚠️ *see the Stella note above* | vendored bundle | **GPL-2.0** | `apps/desktop/vendor/stella/` |
| Oystron © 1997 Piero Cavina — freeware demo ROM (ship paired with its `.txt`) | — | Freeware | `apps/desktop/vendor/stella/oystron.{bin,txt}` |
| [web-tree-sitter](https://tree-sitter.github.io/tree-sitter/) — the tree-sitter runtime + its wasm | 0.26.9 | MIT | `packages/renderer/vendor/web-tree-sitter.*` |

## Syntax grammars (tree-sitter `.wasm`, in `packages/renderer/vendor/`)

Compiled grammars vendored for highlighting. Grouped by license; versions
are recorded in `packages/renderer/vendor/README.md`.

- **MIT:** bash, c, c-sharp, clojure, cpp, css, dockerfile, go, haskell,
  html, java, javascript, json, kotlin, latex, lua, make, markdown (block
  + inline), nix, ocaml, perl, php, python, ruby, rust, scheme, sql,
  swift, toml, typescript, yaml
- **Apache-2.0:** elixir, erlang
- **BSD-3-Clause:** zig
- **ISC:** graphql, xml

(The editor's own Lisp dialect has no grammar — it is tokenized by
`packages/renderer/src/highlight.js`, original to this project.)

## Build- and development-only tools (NOT distributed)

These run at build/dev time and are **not** part of the shipped
application, so they impose no distribution obligation. Listed for
completeness: `esbuild` (MIT), `tree-sitter-cli` (MIT), the
`@tree-sitter-grammars/*` and other grammar source packages (MIT/Apache),
and the citation-js CLI/plugins used only to produce the vendored bundle.

---

## Bundled license texts

Full license texts for the copyleft components we convey live in
`licenses/`:

- `licenses/AGPL-3.0.txt` — the GNU Affero General Public License v3, for
  the `citeproc` portion of the vendored `citation-js` bundle.
- `licenses/citeproc.LICENSE` — `citeproc`'s own copyright and dual-license
  notice, verbatim.
- `licenses/Stella-GPLv2.txt` — the GNU GPL v2, for the vendored Stella
  Atari 2600 core (`apps/desktop/vendor/stella/`) behind the `atari`
  element-view. See the ⚠️ Stella note above on GPLv2↔GPL-3.0.

The editor's own GPL-3.0-or-later license is in `LICENSE`.

---

*To regenerate the dependency license inventory:* `pnpm licenses list`
(add `--prod` to see only runtime-bundled packages). The vendored asset
versions and refresh steps are documented in each `vendor/README.md`.
