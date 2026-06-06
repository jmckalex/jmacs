# 01 — Packaging & First-Run

**Pillar:** a stranger can install and run jmacs in ~5 minutes on macOS,
with a realistic path to Linux/Windows.

**Status of the codebase at time of writing (2026-06-06):** v0.1 beta,
solo-built, ~1700 passing tests, not yet pushed public. There is **no
build/compile step** — ES2022 modules are served live over a custom
`app://` scheme straight from the working tree; third-party libraries are
*vendored* into `packages/*/vendor/` (51 MB of tree-sitter wasm + MathJax
+ citation-js + marked) or loaded directly out of `node_modules` via an
import map. There is currently **no packaging configuration of any kind**
(no electron-builder, no Forge, no icons, no entitlements, no CI).

This plan reconciles "no build step" with "shippable Electron app",
fixes the broken `pnpm dev`, and lays out signing/notarization and a
cross-platform roadmap. Every recommendation is grounded in the repo.

---

## TL;DR — what blocks a public announce vs what can fast-follow

**Hard pre-announce blockers** (a stranger literally cannot get running
without these):

1. **Fix `pnpm dev` / `pnpm install`.** A malformed `allowBuilds` entry
   in `pnpm-workspace.yaml:48` (`citation-js: set this to true or false`)
   breaks `pnpm install`, and the README's documented Quick Start
   (`pnpm install && pnpm dev`, README "Quick start") therefore fails on
   a clean clone. **~15 min.** §1.
2. **A downloadable, double-clickable macOS artifact** *or* a verified
   clean-clone-from-source path. For a *stranger* in *5 minutes*, the
   former is far stronger — building from source needs Node, Corepack,
   pnpm, and a 1.2 GB `node_modules`. A signed-or-clearly-bypassable DMG
   is the real first-run experience. §2, §3, §4.
3. **Gatekeeper guidance.** Without an Apple Developer ID, a downloaded
   `.app` is quarantined and shows "jmacs is damaged / cannot be opened".
   Strangers will bounce. Either notarize (with account) or ship crisp
   bypass instructions (without). §3.

**Fast-follow** (announce without, add within weeks):

- Linux (AppImage/deb) and Windows (NSIS) artifacts. §5.
- GitHub Actions release pipeline (manual local builds are fine for v0.1). §4.
- App icon polish, auto-update. §4, §5.

---

## 0 — How the app actually loads (the constraint to respect)

Everything in this plan turns on *what files the running renderer
fetches*. Confirmed by reading the source:

- **The `app://` scheme resolves to the repository root.**
  `apps/desktop/src/serve.js:16` computes `repoRoot` as three dirs up
  from `apps/desktop/src`, and `serveAppFile` (`serve.js:96`) `readFile`s
  paths under it. The editor page is
  `app://editor/apps/desktop/index.html` (`serve.js:19`).
- **Renderer source is served live, `no-store`** (`serve.js:143`), which
  is why a window reload picks up edits with no build.
- **The renderer fetches out of `node_modules`, not only vendored files:**
  - `apps/desktop/index.html:21` links
    `../../packages/renderer/node_modules/@xterm/xterm/css/xterm.css`.
  - The import map (`index.html:24–38`) maps `@xterm/xterm`,
    `@xterm/addon-fit`, and `pdfjs-dist` to paths under
    `packages/renderer/node_modules/...`.
  - `packages/renderer/src/pdf-view.js:37` sets `PDFJS_BASE =
    'app://editor/packages/renderer/node_modules/pdfjs-dist'` and loads
    the worker, cmaps, and standard fonts from there at runtime. Its own
    comment notes "`readFile` follows symlinks, so this URL reaches the
    pnpm symlink the renderer's local node_modules points at."
  - **These `node_modules` entries are pnpm symlinks into the store.**
    Verified: `packages/renderer/node_modules/pdfjs-dist` →
    `../../../node_modules/.pnpm/pdfjs-dist@5.7.284/node_modules/pdfjs-dist`
    (35 MB resolved); `@xterm` resolves to 6 MB.
- **The renderer scans directories at startup via `?list`.**
  `serveAppFile` answers `…/?list` with a JSON array of filenames
  (`serve.js:124`). `apps/desktop/src/app.js` uses this to discover
  stdlib language files (`app.js:4713`) and renderer language modules
  (`app.js:4726`, then dynamic `import()` of each). **A packaged app must
  preserve real on-disk directories** for these scans — a flattened/asar
  layout that breaks `readdir` would break language discovery.
- **User data lives in Electron's `userData`, not the repo.**
  `apps/desktop/src/files.js:167` resolves config files (init.lisp,
  custom.lisp, faces.json, panes.json, session JSON) under
  `app.getPath('userData')`. Good — nothing the user writes lands inside
  the app bundle, so a read-only bundle is fine.
- **No bundled helper files to chase.** The shell PTY helper is an inline
  `python3 -c '…'` string (`apps/desktop/src/shell.js:181, 206`), not a
  shipped `.py`. The general process runner (`process.js:70`) spawns
  user-named programs. Neither depends on a repo-relative helper path.

**The core reconciliation:** "no build step" really means "no *bundler*."
Packaging here is **not** bundling — it is *copying the working tree
(plus the handful of needed `node_modules` subtrees, symlinks
dereferenced) into the app resources directory and pointing the `app://`
root at it.* The `app://` scheme keeps doing exactly what it does in dev.
We change *where `repoRoot` points* in a packaged build, and nothing else
about how modules load.

---

## 1 — Fix `pnpm dev` and a reproducible clean-clone → running path

### 1.1 Root cause of the broken `pnpm dev` (confirmed)

`pnpm-workspace.yaml` carries an `allowBuilds:` map that tells pnpm 11
which dependencies are permitted to run install scripts (pnpm blocks
dependency lifecycle scripts by default). Line 48 reads:

```yaml
  citation-js: set this to true or false
```

That value is a YAML **string** (`"set this to true or false"`), where
pnpm expects a **boolean**. `citation-js@0.7.22` has
`"postinstall": "patch-package"` (confirmed in its installed
`package.json`), so pnpm surfaced it for an explicit allow/deny decision
and someone left the placeholder in. The malformed value makes
`pnpm install` choke, and because `pnpm dev` (root `package.json:11`
→ `pnpm --filter @editor/desktop dev`) runs through pnpm's pre-run
dependency check, the whole dev launch fails. This is exactly the symptom
CLAUDE.md records ("`pnpm dev` is currently BROKEN due to an unresolved
`citation-js` ignored-build placeholder").

### 1.2 The fix — set it to `false`

`citation-js` and the three `@citation-js/*` packages are **build-time-
only** dependencies: they exist solely so `scripts/build-citation-js.js`
can esbuild them into the committed bundle
`packages/renderer/vendor/citation-js.esm.js` (1.2 MB, already present and
committed). The runtime imports the *vendored* bundle, never the npm
package. Therefore `citation-js`'s `patch-package` postinstall is
irrelevant to producing a working bundle — it patches the package's own
distributed build, which we don't ship.

**Change `pnpm-workspace.yaml:48` to:**

```yaml
  citation-js: false
```

`false` is correct: we do not need the postinstall to run, the vendor
bundle is already built, and skipping it makes `pnpm install`
deterministic and script-free. (If a future citation-js refresh ever
*requires* the postinstall to produce a clean esbuild input, flip it to
`true` then — but it currently builds fine without it, since the bundle
in the tree was produced from this exact dependency set.)

Effort: **~5 min** to change + 1 line. **~10 min** to verify a clean
`pnpm install` and `pnpm dev` from a fresh checkout.

### 1.3 Move citation-js deps off the root, optionally

The four `@citation-js/*` / `citation-js` packages are declared as root
`devDependencies` (`package.json:15–18`) but used only by one script.
That's acceptable. Leave as-is for v0.1 — they're correctly dev-only and
moving them risks churn. Note it for a later cleanup, not a blocker.

### 1.4 The clean-clone → running checklist (to verify and then document)

This is the path a from-source user takes; it must be *tested on a fresh
clone* (ideally on a second machine or a clean container) before
announce:

```bash
# Prereqs: Node 20+ (repo uses Node 23 locally; 20 LTS is the floor the
# README claims — verify the floor actually works), Corepack.
corepack enable pnpm
git clone <url> jmacs && cd jmacs
pnpm install            # must now succeed end-to-end (after §1.2)
pnpm --filter @editor/desktop exec electron .   # or `pnpm dev`
pnpm test               # ~1700 tests green
```

Two caveats to document in the README's Quick Start:

- **Docker + tree-sitter CLI are NOT needed for a normal checkout.** The
  vendored `.wasm` files are committed; `scripts/build-grammars.sh` is a
  maintainer-only refresh step (its own header says "developers do not
  run this per-checkout"). New contributors should not be scared off by
  the Docker requirement — make that explicit.
- **`pnpm dev` vs the direct invocation.** Once §1.2 lands, `pnpm dev`
  should work and the README's documented command becomes true again.
  Keep the `electron .` fallback (CLAUDE.md's launch command) documented
  as a belt-and-braces alternative.

Effort for §1 total: **~30 min** including a real clean-clone test.

---

## 2 — Packaging approach (and how it coexists with "no build step")

### 2.1 Tool choice: **electron-builder**

Three realistic options:

| Tool | Fit for jmacs | Verdict |
|------|---------------|---------|
| **electron-builder** | Mature DMG/zip/AppImage/deb/NSIS in one config; built-in macOS sign + notarize (`afterSign` + `notarize: true`); handles asar and `extraResources`; `files`/`extraResources` globbing copies arbitrary trees; dereferences symlinks into asar. | **Recommended.** |
| **Electron Forge** | Nice DX, plugin model, but its strength (the Vite/Webpack bundler plugins) is exactly what we don't use; for a no-bundler app it's the same "copy a tree" job with more ceremony. | Workable, no advantage here. |
| **Manual** (`@electron/packager` + `@electron/osx-sign` + `@electron/notarize`) | Maximum control, matches the "boring plumbing" ethos; more glue to write for DMG creation and multi-platform. | Fallback if electron-builder's opinions fight the layout. |

Go with **electron-builder**. It is one pinned devDependency and one
config file; it solves signing, notarization, DMG, and cross-platform
targets in one place; and its `extraResources` + `asarUnpack` knobs map
cleanly onto "copy the working tree and keep real directories." Pin an
exact version (per CLAUDE.md's no-`^` rule), e.g.
`electron-builder: "26.x.y"` (latest stable at build time).

### 2.2 The packaging shape: ship the working tree as app resources

Because the renderer loads modules by path over `app://` (resolving to
`repoRoot`), the simplest correct package is: **put the project tree
inside the app and repoint `repoRoot` at it.**

Concretely:

1. **What must be inside the bundle** (the renderer fetches these at
   runtime):
   - `apps/desktop/` (index.html, src/, styles.css, vendor/fontawesome,
     vendor/mathjax)
   - `packages/*/src/` and `packages/*/lisp/` (all layers + stdlib Lisp)
   - `packages/renderer/vendor/` (the 51 MB of wasm/esm)
   - `packages/renderer/node_modules/{pdfjs-dist,@xterm/xterm,@xterm/addon-fit}`
     — **symlinks dereferenced to real files** (pdfjs worker/cmaps/fonts,
     xterm lib + css). This is the one `node_modules` subtree the runtime
     genuinely needs.
   - `docs/build/` *if* shipping built docs (optional; the `app://docs/`
     host 404s gracefully when absent — `serve.js:118`). Build with
     `node scripts/build-docs.js` (root `package.json:12`) before
     packaging, or ship without and let in-app docs degrade.
   - Electron's own runtime (electron-builder handles this).
2. **What must NOT be inside:** the full 1.2 GB `node_modules` (tree-
   sitter *source* dev deps, citation-js npm package, esbuild, the
   tree-sitter CLI). None are needed at runtime — grammars are vendored
   wasm. Excluding them is the difference between a ~120 MB and a 1.3 GB
   download.

### 2.3 Repointing `repoRoot` for a packaged build

`serve.js:16` derives `repoRoot` from `import.meta.url` assuming the
`apps/desktop/src → repo root` layout. **This must change for packaging.**
Recommended approach (a *small, reviewed* source change — flag for the
architect since it touches `apps/desktop/` territory):

```js
// serve.js — pseudocode
import { app } from 'electron';
const repoRoot = app.isPackaged
  ? process.resourcesPath          // electron-builder's Resources/ dir
  : join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
```

Then lay the project tree out *under* `Resources/` so that
`app://editor/apps/desktop/index.html`,
`app://editor/packages/...`, etc. resolve correctly. With
electron-builder, the cleanest way to get a predictable, `readdir`-able
on-disk layout (needed for `?list`) is to ship the whole tree via
**`extraResources`** (which copies into `Resources/`, *not* into asar) so
directory listing keeps working and dynamic `import()` of discovered
language modules works against real files.

> **Why not asar?** asar is a single archive; Electron patches `fs` to
> read inside it transparently, *but* (a) `protocol.handle` + `readFile`
> on an asar path works, while (b) `readdir` for `?list` and dynamic
> ESM `import()` over `app://` of files *inside* asar are the fragile
> parts. The low-risk v0.1 choice is **`extraResources` (unpacked tree),
> no asar for the project files.** Revisit asar+`asarUnpack` only if
> startup file-count becomes a perf issue. Keep Electron's own JS in
> asar (the default); only the *project tree* goes to `extraResources`.

### 2.4 The `electron-builder.yml` sketch (config, not a build step)

This is configuration; it does not introduce a compile of the source.
Place at repo root:

```yaml
appId: dev.jmacs.editor          # reverse-DNS; pick a real domain
productName: jmacs
directories:
  output: release                # already gitignored (.gitignore "release/")
  buildResources: build          # icons live here
# We package the project tree as resources (no bundler). Electron's own
# files stay in the default asar; the project tree is copied verbatim.
files:
  - "apps/desktop/src/main.js"   # the electron entry must be resolvable
  - "apps/desktop/src/**/*"
  - "apps/desktop/index.html"
  - "apps/desktop/styles.css"
  - "package.json"
extraResources:
  # Copied into Contents/Resources/ ; repoRoot points here when packaged.
  - from: "apps/desktop"
    to: "apps/desktop"
    filter: ["**/*", "!node_modules"]
  - from: "packages"
    to: "packages"
    filter:
      - "**/src/**"
      - "**/lisp/**"
      - "renderer/vendor/**"
      - "**/package.json"
      - "renderer/node_modules/pdfjs-dist/**"
      - "renderer/node_modules/@xterm/**"
  - from: "docs/build"           # optional
    to: "docs/build"
    filter: ["**/*"]
mac:
  category: public.app-category.developer-tools
  target: [{ target: dmg }, { target: zip }]   # zip enables auto-update later
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
dmg:
  sign: false                    # sign the .app, not the DMG container
```

Two things to get right and verify in the running packaged app:

- **Symlink dereferencing.** The `renderer/node_modules/pdfjs-dist` and
  `@xterm` entries are pnpm symlinks. electron-builder dereferences
  symlinks when copying into the bundle by default, but **verify the
  copied tree contains real files** (open a PDF and a shell in the
  packaged app — those are the two features that depend on it).
- **The Electron `main`.** The app's entry is
  `apps/desktop/src/main.js` (`apps/desktop/package.json:5`), an ESM
  module. The packaged `package.json` (electron-builder writes one) must
  keep `"type": "module"` and a `main` that resolves. Verify the ESM
  preload (`preload.mjs`, sandbox-off per `main.js:46`) still loads in
  the packaged app — this is the highest-risk single item.

### 2.5 Effort & risk for §2

- Initial electron-builder config + `repoRoot` change + first successful
  unsigned local `.app`: **0.5–1.5 days**, most of it iterating on the
  `extraResources` filters and confirming `?list`/dynamic-import work
  packaged.
- **Top risks:** (1) ESM main/preload under packaging; (2) `?list`
  directory scans against the packaged layout; (3) dynamic `import()` of
  discovered language modules over `app://` from `Resources/`; (4) symlink
  dereference of pdfjs-dist/@xterm. **All four must be smoke-tested in the
  packaged build, not just in dev** — CLAUDE.md's caveat that unit tests
  stub host primitives applies doubly here.

---

## 3 — macOS signing & notarization

Two supported paths. **Decide which before announce** — it changes the
download UX dramatically.

### 3.1 Path A — no Apple Developer account (free, $0)

The app is unsigned (or ad-hoc signed). On the *build* machine it runs.
On a *downloaded* copy, macOS sets the `com.apple.quarantine` attribute
and Gatekeeper refuses it ("jmacs is damaged and can't be opened" — the
infamous misleading message that actually means *unsigned + quarantined*).

**Ship clear bypass instructions** (put them in the README's download
section and on the release page). The reliable, current options:

1. **Strip the quarantine attribute** (most robust, works headless):
   ```bash
   xattr -dr com.apple.quarantine /Applications/jmacs.app
   ```
   Document this as the recommended step right after dragging to
   `/Applications`.
2. **Right-click → Open** (older flow): on recent macOS (Sequoia+),
   Apple removed the simple right-click-Open bypass for unsigned apps;
   the path is now **System Settings → Privacy & Security → "Open
   Anyway"** after the first blocked launch. Document both, noting the
   `xattr` command is the surest.

Also: **ad-hoc sign locally** so the app at least has a stable code
signature (helps with TCC prompts and the hardened runtime):
```bash
codesign --force --deep --sign - /Applications/jmacs.app
```
electron-builder will do an ad-hoc sign when no identity is configured.

**Honest assessment:** for a *stranger in 5 minutes*, an unsigned DMG +
`xattr` instruction is a real friction point and a trust hit (the
"damaged" message reads like malware). It is acceptable for a v0.1 beta
announced to a technical audience that will follow one extra command. It
is **not** acceptable as the long-term story.

Effort: **~0 build effort**, **~30 min** to write airtight instructions
and test the downloaded-quarantine flow on a second Mac / fresh account.

### 3.2 Path B — with an Apple Developer account ($99/yr)

The strong story: a notarized, stapled DMG opens with a normal
double-click and no warnings.

Steps:

1. Enroll in the Apple Developer Program ($99/yr). Create a **Developer
   ID Application** certificate (this is the cert type for distribution
   *outside* the Mac App Store).
2. Create an **app-specific password** (or an App Store Connect API key —
   the API-key path is preferred by `@electron/notarize` now).
3. `build/entitlements.mac.plist` for the **hardened runtime** — jmacs
   needs at minimum the JIT entitlement (Electron/V8) and, because it
   spawns child processes (shells, gnuplot, latex, user programs via
   `process.js`), the relevant allowances:
   ```xml
   <key>com.apple.security.cs.allow-jit</key> <true/>
   <key>com.apple.security.cs.allow-unsigned-executable-memory</key> <true/>
   <key>com.apple.security.cs.allow-dyld-environment-variables</key> <true/>
   <key>com.apple.security.cs.disable-library-validation</key> <true/>
   ```
   (`disable-library-validation` is needed so the spawned `python3`/shell
   children and any unsigned dylibs in dereferenced node_modules load
   under the hardened runtime. Trim to the minimum that actually passes
   notarization + runs.)
4. electron-builder config additions:
   ```yaml
   mac:
     hardenedRuntime: true
     notarize: true            # uses APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER env
   ```
   Set `CSC_LINK`/`CSC_KEY_PASSWORD` (the Developer ID cert) and the
   notarization API-key env vars at build time.
5. electron-builder signs, submits to Apple's notary service, and
   **staples** the ticket to the DMG automatically. Verify with
   `spctl -a -vvv -t install /Applications/jmacs.app` (should report
   "accepted, source=Notarized Developer ID").

**The spawn-children wrinkle:** jmacs's shell view and process runner
spawn `python3`, `$SHELL`, `gnuplot`, `latexmk`, etc. (`shell.js`,
`process.js`, `gnuplot.js`). Under the hardened runtime these are *system*
binaries the user already has, spawned as separate processes — they are
not loaded into jmacs's address space, so they don't need to be signed by
us. This generally passes notarization. The thing to watch is any
**unsigned native `.node`/`.dylib`** that gets dereferenced from
node_modules into the bundle — we believe there are none at runtime
(grammars are wasm, pdfjs/xterm are pure JS), but **scan the packaged
`.app` for Mach-O binaries before the first notarization attempt**:
```bash
find /Applications/jmacs.app -type f \
  -exec sh -c 'file "$1" | grep -q Mach-O && echo "$1"' _ {} \;
```
Any hit other than Electron's own framework must be signed (electron-
builder signs nested binaries it knows about; stray ones in
extraResources it may not).

Effort: **~0.5–1 day** the first time (cert dance + entitlement
iteration + first notarization round-trips), **~minutes** thereafter.
Plus the $99 and ~1–2 days of Apple enrollment latency — **start the
enrollment early** if going this route.

### 3.3 Recommendation

- **For the announce:** if budget/timeline allow, **Path B**. The
  "double-click, no warnings" experience is the single biggest lever on
  "5-minute stranger install" and on not looking like malware.
- **If not:** **Path A** with a polished `xattr` instruction is a
  defensible v0.1 beta posture for a developer audience. Make notarization
  the very next fast-follow.

---

## 4 — Downloadable artifacts (DMG/zip) + optional GitHub Actions

### 4.1 Local artifact production (do this first)

Once §2's config exists:

```bash
pnpm add -Dw electron-builder@<pinned>        # root dev dep, pinned
node scripts/build-docs.js                      # optional: built docs
pnpm exec electron-builder --mac dmg zip        # → release/jmacs-<ver>.dmg, .zip
```

Outputs land in `release/` (already gitignored). The **DMG** is the
primary download; the **zip** is the auto-update feed format (ship both
so auto-update is possible later without rebuilding the story).

**Version the app.** Root `package.json:3` is `"version": "0.0.0"` and
`apps/desktop/package.json` is `0.0.0`. Set a real `0.1.0` before
cutting an artifact — electron-builder uses it for filenames, the DMG
volume name, and the Sparkle/auto-update feed.

### 4.2 GitHub Releases (the distribution channel)

Cut a tagged GitHub Release (`v0.1.0`) and attach the DMG + zip +
`SHA256SUMS`. The README's download section links to "latest release."
Include, on the release page itself: the `xattr` bypass note (Path A) or
"notarized — just open it" (Path B), and the minimum macOS version.

### 4.3 GitHub Actions release pipeline (fast-follow, not a blocker)

A `.github/workflows/release.yml` triggered on `v*` tags. There is **no
CI today** (no `.github/`), so this is greenfield.

Sketch:

```yaml
name: release
on: { push: { tags: ["v*"] } }
jobs:
  mac:
    runs-on: macos-14            # arm64 runner; matrix to add macos-13 (x64)
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: corepack enable pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test            # gate the release on green tests
      - run: pnpm exec electron-builder --mac dmg zip --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # Path B secrets (omit for Path A unsigned builds):
          CSC_LINK: ${{ secrets.MAC_CERT_P12_BASE64 }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
```

Notes:
- **Universal vs per-arch.** `macos-14` is Apple Silicon; to serve Intel
  Macs either build a **universal** binary (electron-builder
  `--mac --universal`, larger download) or matrix `macos-13`/`macos-14`.
  Universal is simpler for users; pick it unless size matters.
- **Notarization in CI** needs the Developer ID cert as a base64 secret
  and the notary API key — only relevant on Path B.
- **The frozen-lockfile install in CI is the canary** that §1.2's fix
  actually took: if `pnpm-workspace.yaml` is still malformed, this step
  fails loudly.

Effort: **~0.5 day** for a working mac-only release workflow; **~1 day**
to add the cross-platform matrix (§5).

---

## 5 — Cross-platform roadmap (Linux / Windows)

The architecture is favorable: pure JS + wasm + Electron, no platform-
specific native addons at runtime. The same `extraResources` layout works
everywhere. electron-builder targets all three from one config.

### 5.1 Linux

- **Targets:** `AppImage` (universal, no install, just `chmod +x && run`)
  and `deb` (for Debian/Ubuntu). Add to config:
  ```yaml
  linux:
    target: [AppImage, deb]
    category: Development
    desktop: { Name: jmacs }
  ```
- **Build on `ubuntu-latest`** in CI.
- **Watch-items:**
  - The shell view's PTY path uses `python3 -c 'import pty'`
    (`shell.js:181`); on Linux `pty` is stdlib, so PTY works where
    `python3` exists, else falls back to pipes. Document `python3` as an
    optional dependency for the rich shell.
  - File-trash uses Electron's `shell.trashItem` (verify in `files.js`);
    that maps to the freedesktop trash on Linux — fine.
  - No code signing needed; some users will want the AppImage's embedded
    signature, but it's optional. Sandboxing/AppArmor on newer Ubuntu can
    block the SUID chrome-sandbox — electron-builder handles this for
    AppImage; verify launch on Ubuntu 24.04.
- **Effort:** **~0.5 day** once the mac config exists (mostly testing on
  a real Ubuntu box/VM).

### 5.2 Windows

- **Target:** `nsis` (a standard installer) and/or `portable`.
  ```yaml
  win:
    target: [nsis]
  ```
- **Build on `windows-latest`** in CI.
- **Watch-items (higher risk than Linux):**
  - **Path assumptions.** `app://` paths are POSIX-style; `serve.js`
    `join`s them against `repoRoot` — on Windows `join` yields
    backslashes, and the `filePath.startsWith(base + '/')` guard
    (`serve.js:121`) uses a hardcoded `/`. **This guard will misbehave on
    Windows and must be made separator-aware** before a Windows build is
    trustworthy. (Flag: `apps/desktop/` territory.)
  - **Shell view.** The `python3 pty` approach is POSIX-only; Windows has
    no `pty` module. The shell falls back to plain pipes (already the
    documented v1 limit) — acceptable, but the rich terminal is degraded
    on Windows. A proper Windows PTY (ConPTY via a native addon) is a
    later, separate effort and would reintroduce a native dependency —
    out of scope for v0.1.
  - **Home-dir / tilde expansion** in `preload.mjs:15` (`homedir()`) is
    cross-platform fine, but any Lisp/user code assuming `/`-paths is a
    risk surface.
  - **Code signing** on Windows is its own world (Authenticode cert,
    SmartScreen reputation). Unsigned Windows installers trigger
    SmartScreen warnings much like Gatekeeper. Treat Windows signing as a
    separate fast-follow; ship unsigned with a SmartScreen "More info →
    Run anyway" note initially.
- **Effort:** **~1–1.5 days** including fixing the path-separator guard
  and verifying the pipe-fallback shell, plus testing on a real Windows
  box.

### 5.3 Cross-platform sequencing

1. macOS first (the author's platform; fastest feedback loop).
2. Linux second (lowest risk, same POSIX assumptions).
3. Windows third (path-separator fix + degraded shell + SmartScreen).

None of Linux/Windows is a pre-announce blocker *if* the announce frames
jmacs as "macOS (Linux/Windows builds coming)". Be explicit about
platform support on the download page so a Windows stranger isn't
surprised by a degraded shell.

---

## 6 — Consolidated sequence, effort, and risk

| # | Item | Effort | Blocker? | Notes / risk |
|---|------|--------|----------|--------------|
| 1.2 | Fix `pnpm-workspace.yaml:48` → `false` | ~15 min | **Pre-announce** | Trivial; unblocks all of install/dev/CI. |
| 1.4 | Verify clean-clone path on a fresh machine; fix README Quick Start caveats | ~30 min | **Pre-announce** | Source path must actually work. |
| 2.3 | `repoRoot` packaged-vs-dev switch in `serve.js` | ~1–2 hr | **Pre-announce (if shipping a binary)** | Touches `apps/desktop/`; small, reviewable. |
| 2.4 | electron-builder config; first unsigned local `.app` | ~0.5–1.5 day | **Pre-announce (if shipping a binary)** | `?list`/dynamic-import/ESM-preload/symlink smoke tests in the *packaged* app are the real work. |
| 3.1 | Path A: Gatekeeper bypass instructions + ad-hoc sign | ~30 min | Pre-announce *if* Path A | Friction; trust hit. |
| 3.2 | Path B: Developer ID + hardened runtime + notarize | ~0.5–1 day + $99 + enroll latency | Strongly recommended pre-announce | Start enrollment early. |
| 4.1 | Version bump to 0.1.0; cut DMG+zip locally | ~1 hr | **Pre-announce** | `package.json` is still `0.0.0`. |
| 4.2 | GitHub Release with artifacts + checksums + bypass note | ~1 hr | **Pre-announce** | The actual download channel. |
| 4.3 | GitHub Actions release workflow | ~0.5 day | Fast-follow | Manual local builds fine for v0.1. |
| 5.1 | Linux AppImage/deb | ~0.5 day | Fast-follow | Low risk. |
| 5.2 | Windows NSIS (+ path-separator fix) | ~1–1.5 day | Fast-follow | Fix `serve.js:121` separator guard; degraded shell. |
| — | App icon (.icns/.ico/.png) in `build/` | ~1 hr | Polish, pre-announce-nice | None exist (`find` for icons returned nothing). |

**Critical path to announce (macOS, Path B):**
1.2 → 1.4 → 2.3 → 2.4 → (icon) → 3.2 → 4.1 → 4.2. Roughly **2–4
focused days** of work plus Apple enrollment latency.

**Critical path to announce (macOS, Path A, leanest):**
1.2 → 1.4 → 2.3 → 2.4 → 4.1 → 4.2 → 3.1. Roughly **1.5–2.5 days**,
no spend, with the Gatekeeper-friction caveat.

---

## 7 — Open questions for the architect

1. **Apple Developer account — yes/no for v0.1?** Determines Path A vs B
   and is the single biggest lever on first-run UX. If yes, *enroll now*;
   the cert/enrollment latency is the long pole.
2. **`appId` / domain.** Need a stable reverse-DNS `appId` (e.g.
   `dev.jmacs.editor`) and ideally a real domain for it. Pick before the
   first signed build (changing it later churns code-signing identity and
   auto-update feeds).
3. **`repoRoot` switch ownership.** §2.3 changes `apps/desktop/src/serve.js`
   (and possibly `main.js`). That's `apps/desktop/` territory — confirm
   who lands it, since this plan is non-implementing.
4. **Universal vs per-arch macOS binary.** Universal = one simpler
   download, larger size; per-arch = two downloads, smaller each. Default
   recommendation: universal.
5. **Ship built docs in the bundle?** Optional (the `app://docs/` host
   404s gracefully). Including `docs/build/` adds a few MB and makes the
   in-app manual work offline out of the box — recommended yes.
6. **Windows scope for v0.1.** Acceptable to announce macOS-only and add
   Windows later with the degraded (pipe) shell, or hold Windows until a
   real ConPTY? Recommendation: announce macOS-first, Windows fast-follow
   with the documented shell limitation.
