# Package management — guide notes

Design document for an extension package system. **Plan, not
implementation.** The intent is to surface the design choices that
need a decision, identify the implementation phases, and name the
risks. The twelve structural decisions are settled (see the
**Decisions** section); Phase 1 is now ready to brief and implement.

## Motivation

Godot is Lisp-extensible by design. Today that means: users add code
to `init.lisp` in the editor's user-data directory. Two pressures
suggest it's time to formalise the next layer:

1. **Shareable extensions.** A user who writes a `magit`-equivalent
   has no good story for distributing it. Pasting into `init.lisp`
   doesn't scale past two or three additions; copy-pasting from a
   gist doesn't survive updates.

2. **Modular structure.** `init.lisp` accumulates indefinitely. With
   no module system, every binding lives in one global env. As more
   substantial extensions arrive, name collisions are inevitable.

3. **Ecosystem leverage.** The architectural decisions that make
   Godot characterful (Lisp at the seams, `defcustom` / `defcommand`
   / `defface` as data) reach further if people other than the
   author can write extensions. A package system is the substrate
   for that.

A package system is also a major commitment: once installed packages
exist on real users' machines, the surface freezes. Best to design
it once, carefully, with explicit phasing.

## What a package is

A package is a **directory** with a manifest at its root. Concretely:

    <user-data>/packages/
      magit/
        package.lisp           ← the manifest
        magit.lisp             ← the main source
        magit-blame.lisp       ← supporting source
        magit-keymap.lisp      ← bindings (loaded last)
        README.md              ← human-readable docs
        assets/                ← optional non-Lisp resources
          magit-icon.png

`<user-data>` is the editor's user-data directory — the same place
`init.lisp`, `custom.lisp`, `faces.json`, and `session.json` already
live. On macOS that's `~/Library/Application Support/Godot/`; on
Linux, `~/.config/Godot/`; on Windows, `%APPDATA%\Godot\`. The
Electron userData directory, in other words.

The manifest is a single Lisp form. Same dialect as everywhere else
in the editor — data, not config syntax:

    (package magit
      :version "0.3.1"
      :author "Some Person <them@example.org>"
      :doc "Git integration for Godot — status, blame, log."
      :godot-version ">= 0.1"
      :depends
        ((diff-utils ">= 0.2")
         (git-shell "*"))
      :sources
        ("magit.lisp"
         "magit-blame.lisp"
         "magit-keymap.lisp")
      :autoload
        (magit-status
         magit-blame
         magit-log)
      :provides
        (:commands  (magit-status magit-blame magit-log)
         :modes     (magit-status-mode)
         :keymaps   (magit-mode-map)
         :faces     (magit-diff-add magit-diff-delete magit-branch-current)
         :settings  (*magit-history-depth* *magit-default-remote*)))

Reading the manifest tells you, with no further investigation: what
this package adds to the editor, what it depends on, what loads
eagerly vs lazily, and what version any other package can require it
at.

### What a package can contribute

Anything the existing stdlib can declare:

- `defcommand` — interactive commands.
- `defcustom` — settings (visible under `M-x customize`).
- `defface` — named token / decoration faces.
- `defmacro` / `define` — helper procedures and macros.
- `define-mode` — major modes.
- `define-theme` — colour themes.
- Keymap bindings (`(set! the-keymap (assoc the-keymap "C-x g" 'magit-status))`).
- Mode hooks.

It can also bundle non-Lisp assets the host knows how to install:

- **Themes** that need CSS variables — already covered by `define-theme`.
- **Tree-sitter grammars** — a `.wasm` file plus a `(register-language …)`
  form in one of the package's sources.
- **Faces.json overrides** — by writing through the customise API,
  not by editing `faces.json` directly.

What it **cannot** contribute, in the MVP:

- New JavaScript host primitives.
- New view kinds.
- New IPC handlers / native code.

(See "The host-primitive question" below for what we do with this
later.)

### Identity and naming

A package's **identity** is its name (a symbol) plus its version (a
semver string). The directory name and the manifest `:name` must
agree. Versions follow semver loosely: `MAJOR.MINOR.PATCH` with the
usual ordering.

Within a package, every public symbol should be prefixed with the
package name plus `/` — `magit/status`, `magit/blame-line`,
`magit/*history-depth*`. The package system enforces this by
convention in the MVP (warnings on collision); a real module system
can come later.

## The module / namespace question

The Lisp dialect has no module system today. Every `define` lives in
one global env. Three options for packages:

### A. Convention only — prefix every public name

`magit-status`, `magit-blame`, `*magit-history-depth*`. Same approach
Emacs took for decades. Cheap, no language changes. Collisions are
detectable at install time (the manifest's `:provides` declares
every public symbol; we check before activating).

### B. A real module system

`(module magit (export status blame log) ...)` with import-by-name
in other modules. Adds genuine namespace isolation; requires
extending the evaluator. The handover-flagged "no module system" gap
gets filled simultaneously.

### C. Implicit namespacing at load

The package loader wraps every `define` in a per-package namespace,
re-exposing only the symbols listed in `:provides`. Less invasive
than (B); but every Lisp file in the package has to use a different
internal form of `define`, which breaks `init.lisp`-style direct
authoring.

**Decision: ship (A) in the MVP, design toward (B) as a follow-up.**
Convention works in the small; the editor's standard library is itself
an existence proof. Modules become worth their implementation cost
once the package ecosystem is large enough that collisions are
routine. We'd rather not block the package system on a language
change. (See Decision 1 below.)

## Loading and the boot pipeline

Today's boot:

    loadStdlib()          → packages/stdlib/lisp/*.lisp in STDLIB_FILES order
    loadFaceOverrides()   → faces.json applied
    loadUserConfig()      → custom.lisp, then init.lisp
    applyCurrentTheme()
    applyCurrentFaceStyles()

The package system inserts a new step **between `loadUserConfig`'s
`custom.lisp` and its `init.lisp`**:

    loadStdlib()
    loadFaceOverrides()
    loadCustomLisp()       ← from loadUserConfig, split
    loadPackages()         ← NEW
    loadInitLisp()         ← from loadUserConfig, split

Why between `custom.lisp` and `init.lisp`?

- After `custom.lisp` so user-set values (like `*tab-width*`) are in
  effect when packages read them.
- Before `init.lisp` so the user can extend, override, or pin
  package behaviour from a single place they own.

### Eager vs lazy

Each `:autoload` symbol in a manifest gets a stub installed at
package-discovery time:

    ;; Synthesised by the package loader, before any source is read:
    (defcommand magit-status ()
      "Autoloaded from package `magit'."
      (require! 'magit)
      (magit-status))   ; the real definition shadows this after load

`require!` loads the package's `:sources` in order, marks the
package as loaded, and runs any `:after-load` hook the manifest
declares. After that, `magit-status` resolves to the real
definition. The autoload stub fires once; subsequent calls go
straight to the real binding.

A package can also declare `:eager t` in its manifest if it must
load at boot (e.g. a theme package whose `define-theme` form has to
register before `apply-theme!` runs). The cost of eager loading is
real — N packages add N stdlib's worth of work to startup — so this
should be the exception.

### Dependency resolution

When `require!` is called (whether by an autoload stub or directly):

1. Walk the dependency graph from the requested package.
2. Topologically sort. Cycles are an error.
3. For each dependency in topo order: if not already loaded, recurse.
4. Read every `:source` file; evaluate in the global env.
5. Mark loaded.

Version constraints are checked against installed versions. A
mismatch is a clear error (`magit requires diff-utils >= 0.2 but
0.1.4 is installed`). No SAT solver; the constraint language is
intentionally minimal (`>= X`, `> X`, `= X`, `*`).

### After-load hooks

A package can register code to run after another package loads:

    :after-load
      ((markdown-mode . (lambda () (set! markdown-mode-map ...)))
       (lsp-client   . (lambda () (lsp-register-server ...))))

This is the integration glue between packages without forcing them
to know about each other.

## Distribution

Three layers, each more centralised than the last. The MVP ships
Layer 1 only; Layer 2 is the first growth step; Layer 3 is a long
horizon.

### Layer 1 — Local install

Drop a directory into `<user-data>/packages/`. The package loader
discovers it on next boot (or on `M-x package-rescan`). No network,
no registry, no signatures.

This is enough to:
- Develop a package locally (`~/Source/magit/` symlinked into the
  packages dir).
- Install something a friend zipped you.
- Distribute via git: `git clone … <user-data>/packages/magit`.

### Layer 2 — Git-based install

`M-x package-install-from-git` prompts for a URL and a ref. The host
clones into `<user-data>/packages/<name>/`, reads the manifest to
confirm shape, and registers. Updates: `M-x package-update` walks
every git-installed package and pulls; failed updates leave the
package at its last good ref.

This adds:
- A real install/update UX.
- Dependency packages that themselves resolve to git URLs (declared
  in the manifest as `:source-url`).
- No central registry — discovery is "someone tells you the URL".

### Layer 3 — Centralised registry (Vladimir's Chest)

A JSON index hosted somewhere stable (GitHub Pages of a single repo
is plenty for v1). Each entry: package name, version, manifest,
tarball URL, signing key.

`M-x list-packages` shows the registry. `M-x package-install` picks
by name. Versions resolve through the registry. Trust model: signed
manifests, signed tarballs, signing-key pinning per package on first
install.

The name (Vladimir's Chest) parallels the editor's own name: in
*Waiting for Godot*, Vladimir's chest is the supply of food that
sustains the waiting. The registry is the supply of packages that
sustains the editor.

### Why this staging?

Each layer is a real, useful product on its own. We don't need a
registry to start; we don't need git auto-update for local
development. The earlier layers don't go away when later ones
arrive — they remain the developer workflow even when Vladimir's
Chest is the end-user path.

## Installation, updates, uninstall

### Where packages live

    <user-data>/packages/
      <name>/               ← directory per package
        package.lisp
        ...
      .cache/
        loaded.json         ← record of what was loaded last boot
        autoloads.lisp      ← generated; concatenated autoload stubs

Both `.cache/loaded.json` and `.cache/autoloads.lisp` are regenerated
on package rescan. The user never edits them.

### Installation lifecycle

`(install-package! name [version])` (and its `M-x` equivalents):

1. Resolve source — local path, git URL, or registry.
2. Verify the manifest is well-formed.
3. Check the package's `:godot-version` constraint against the
   running editor. If unsatisfied, abort with a clear error
   (`magit requires Godot >= 0.5; running 0.4. Upgrade Godot or
   install an older magit.`). No install-but-warn mode.
4. Resolve dependencies; install transitively.
5. Move into `packages/<name>/`.
6. Generate autoload stubs into `.cache/autoloads.lisp`.
7. Run a `:install-hook` if the manifest declares one.
8. Update `installed.lisp` (the record of installed packages with
   their versions and provenance).

### Updates

`(update-package! name)`:

1. Check for a newer version (registry lookup or git pull).
2. Run `:pre-update-hook` if declared.
3. Replace the package directory.
4. Regenerate autoloads.
5. Run `:post-update-hook`.
6. Warn if the package was loaded in the current session and an
   eager re-load isn't safe — suggest restart.

### Uninstall

`(uninstall-package! name)`:

1. Run `:uninstall-hook`.
2. Refuse if other installed packages depend on this one (unless
   `:force`).
3. Remove the directory.
4. Regenerate autoloads.
5. Warn the user that loaded definitions persist in the current
   session — restart for a clean state.

### Disable / enable

`(disable-package! name)`:

1. Add the package to a `disabled-packages` list in
   `installed.lisp`.
2. Do not unload the package from the current session — restart
   for full effect.
3. Subsequent boots skip the package's autoload stub generation
   and any `:eager` loading.

`(enable-package! name)` is the inverse: drop from
`disabled-packages` and re-register on next rescan.

This is the escape hatch when a Godot version bump breaks a
package. The user disables, restarts, and is back to a working
editor; the package author has time to publish a fix. Cheap to
ship from day one; expensive to need and not have.

### Pinning

The user can pin a package to a specific version in `init.lisp`:

    (pin-package! 'magit "0.3.1")

Subsequent updates skip pinned packages. This is the escape hatch
for users who've worked around a bug and don't want a fix to break
the workaround.

## The host-primitive question

The MVP says **packages are pure Lisp**. They can call any primitive
the host already exposes (every `(host-primitive ...)` that exists
in `app.js`), but they cannot introduce new ones.

This is a real limitation. A package can't:
- Add a new file dialog.
- Spawn a subprocess directly.
- Bundle a vendored library and call into it.
- Add a new view kind.

It can do these things only by going through host primitives the
editor already exposes — which is enough for a surprising amount
(`open-file-path!`, `read-file-text!`, the citation bridges, etc.)
but obviously not everything.

**Why this limitation?** Three reasons:

1. **Security.** A package with native code is arbitrary JavaScript
   running with full Electron-renderer privileges — file system,
   network, IPC into the main process. The trust model for that is
   "a package is a piece of software you've decided to run." That's
   defensible but it's a strong claim to ship without thought.

2. **Compatibility.** A pure-Lisp package can run unchanged across
   Godot versions as long as the Lisp surface is stable. A package
   with native code is bound to the host's internal API, which is
   not stable and won't be.

3. **Reach.** A Lisp-only ecosystem still leaves the JavaScript
   layer as the maintainer's responsibility — which keeps the
   editor's character coherent. Packages that need native code can
   contribute back to the host instead of forking around it.

The longer-term plan is **two-tier extensibility**:

- **Packages** — Lisp-only, freely installable.
- **Plugins** — native code, vetted, distributed differently (maybe
  a separate review process, signed binaries, opt-in by the user).

The MVP ships the first tier; the second is a Phase 3+ conversation.

## The user-facing surface

### Commands

Minimal MVP set, all `M-x`-able:

    M-x list-packages              ; browse installed + (Layer 3) registry
    M-x install-package            ; prompt for name; resolves through registry
    M-x install-package-from-git   ; prompt for URL + ref
    M-x install-package-local      ; prompt for a directory
    M-x update-package             ; prompt for name; "all" updates everything
    M-x uninstall-package          ; prompt for name
    M-x package-disable            ; mark a package as skip-at-load
    M-x package-enable             ; re-enable a previously disabled package
    M-x package-rescan             ; re-walk packages/, useful in dev
    M-x package-describe           ; show a package's manifest + commands + faces

### The package list view

A first-class view (kind `package-list`), reachable via
`M-x list-packages`. Each row: name, version, source (local / git /
registry), status (loaded / installed / available / outdated), one-line
doc.

Keys, Sublime-table style:

    Enter       — describe the package (manifest, commands, faces)
    i           — install (when on an available row)
    u           — mark for update
    d           — mark for delete
    x           — execute marked operations
    g           — refresh
    /           — incremental filter
    q           — close

### Customisation surface

Two new defcustoms:

- `*package-archives*` — list of registry URLs in priority order.
- `*package-auto-update*` — boolean; if `#t`, the editor checks for
  updates on a background timer (low frequency, e.g. daily).

Both default to safe values — no archives until Layer 3 ships;
auto-update off.

## Decisions

The twelve design choices that needed answers, and the answers,
in the order they surfaced during exploration. Each is a real fork
in the road that got walked deliberately.

### 1. Namespace approach — convention only (option A)

Public symbols are prefixed by package name (`magit/status`,
`magit/blame-line`, `*magit/history-depth*`). The `:provides`
declaration in the manifest is the source of truth for what's
public; the installer warns on collisions across packages. A real
module system stays a follow-up if the ecosystem demands it.

**Why:** Convention works in the small, and the editor's standard
library is its own existence proof. Modules become worth their
implementation cost only once collisions are routine — that's a
future-us problem. We'd rather not block the package system on a
language change.

### 2. Manifest format — single Lisp form

`package.lisp` is one Lisp form (see "What a package is" above).
Not TOML, not JSON.

**Why:** Keeps the data-as-code-as-data symmetry the editor's
character relies on. External tooling that needs to read manifests
can do so through the same reader the editor uses (or a small
purpose-built reader, when one is genuinely needed). Slightly
less parseable by random third-party tools — acceptable cost for
the consistency.

### 3. Package directory location — alongside `init.lisp` in userData

Packages live in `<user-data>/packages/`, where `<user-data>` is
the editor's existing user-data directory. On macOS that's
`~/Library/Application Support/Godot/packages/`; on Linux,
`~/.config/Godot/packages/`; on Windows,
`%APPDATA%\Godot\packages\`.

**Why:** Everything user-modifiable in one place. No new migration
story; we already know how to point users at this directory. The
rename to Godot will need a userData migration anyway, and
packages ride along with that single migration.

### 4. Host-primitive escape hatch — none in MVP

Packages are pure Lisp. They call existing host primitives only.
A package cannot ship `init.js`, cannot spawn subprocesses
directly, cannot register new view kinds.

**Why:** Three reasons. **Security** — native code runs with full
Electron-renderer privileges (file system, network, IPC into the
main process). The trust model for that is "a package is a piece
of software you've decided to run", which is defensible but not
something to ship without thought. **Compatibility** — a pure-Lisp
package can run unchanged across Godot versions as long as the
Lisp surface is stable; a native package binds to host internals
that are not stable and won't be. **Reach** — a Lisp-only
ecosystem leaves the JS layer as the maintainer's responsibility,
which keeps the editor's character coherent. Two-tier
extensibility (packages + native plugins) is a Phase 4+
conversation.

### 5. Default-installed packages — curated baseline, list TBD

A fresh Godot install ships with a small curated baseline. The
actual list is deferred to Phase 1 — the substrate needs to
stabilise before we commit to which packages get the maintenance
burden.

**Why:** Demonstrates the system on day one; gives the package
infrastructure real exercise from boot zero; addresses the "first
package" risk preemptively. The cost — the baseline becomes a
maintenance commitment for the editor's author — is real but
explicit.

### 6. Registry name — Vladimir's Chest

The Layer 3 centralised registry is **Vladimir's Chest**.
`M-x list-packages` reads "from Vladimir's Chest" in its
descriptions.

**Why:** Parallel to the Godot name itself, drawing on the same
play. In *Waiting for Godot*, Vladimir's chest of food is what
sustains the waiting; in this editor, the registry is what
sustains the ecosystem. The literary thread that names the editor
also names the supply line.

### 7. Themes-as-packages — generic packages, no special case

A theme ships as a package whose `:provides` is mostly `:faces`
and which calls `define-theme`. Same install / update / uninstall
machinery as any other package.

**Why:** One mechanism, not two. Theme distribution becomes a
substring of package distribution; we don't pay the maintenance
cost of two parallel surfaces. The lightweight-file-drop pattern
can return as a convenience helper later if the friction matters.

### 8. Manifest evaluated, not just parsed — full Lisp

`package.lisp` is evaluated, not merely read. Manifests can
compute `:provides`, branch on `(godot-version)`, etc.

**Why:** Power and consistency. The editor evaluates Lisp; the
manifest is Lisp; making the manifest the one exception would be
surprising. The trust model gets named explicitly: installing a
package is running its code, starting at install time. The same
trust model applies to load time, so install time isn't
materially worse.

### 9. Dependency resolution — topological sort + version constraints only

The resolver supports `:depends` with constraints `>= X`, `> X`,
`= X`, `*`. Cycles are errors. No peer / optional / group
dependencies in the MVP.

**Why:** Sufficient for v1. If a real pattern emerges in Phase 1
or 2 (e.g. "this package integrates with X if X is installed"),
that's when optional-dependency support gets added — driven by
real packages, not speculation.

### 10. Test packages — out of scope for MVP

Phase 1 doesn't say anything about package tests. Authors run
their own tests against their own setup. Worth revisiting when
Vladimir's Chest's metadata schema is designed in Phase 3.

**Why:** With no registry yet, there's no place to record test
information that's load-bearing for anyone but the author. A
convention may emerge organically before we have to standardise.

### 11. `:godot-version` constraint failure — refuse to install

If a package's `:godot-version` constraint isn't satisfied by the
running editor, the install aborts with a clear error
(`magit requires Godot >= 0.5; running 0.4. Upgrade Godot or
install an older magit.`).

**Why:** Predictable behaviour. An install-but-warn mode confuses
users who don't read warnings; an install-but-disable mode
confuses users who can't see why a package isn't working. The
error message makes the user's options explicit and the
behavioural rule one-line memorable.

### 12. Recovery from a Godot bump — `M-x package-disable` from day one

`M-x package-disable foo` adds `foo` to a `disabled-packages`
list in `installed.lisp`. A disabled package stays on disk but
the loader skips it. The inverse is `M-x package-enable`.

**Why:** A user whose editor stopped booting because a package
broke needs a fast path back to a working editor. This is it.
Cheap to implement, expensive to need and not have. Phase 1
surface.

## Suggested phasing

### Phase 1 — Local packages, manifest, autoload

- Manifest spec (`package.lisp`).
- Discovery of `<user-data>/packages/*/package.lisp`.
- `:godot-version` constraint check (refuse-to-install path).
- Dependency resolution (topo + version constraint).
- Autoload stub generation.
- `require!` mechanism.
- Disable / enable mechanism (`disabled-packages` persisted to
  `installed.lisp`).
- `M-x` commands: `list-packages`, `package-rescan`,
  `package-describe`, `install-package-local`, `uninstall-package`,
  `package-disable`, `package-enable`.
- Package-list view (kind `package-list`).
- Pinning support.
- The curated-baseline list lands (Decision 5): which two or three
  packages ship by default. Each doubles as the first integration
  test of the system.

Tests: package discovery, dependency cycle detection, autoload stub
shadowing, version constraint matching, conflict reporting,
disable-skips-load, host-version refusal, baseline-package boot.

This phase makes packages real but doesn't add networked install.
Sufficient for early adopters to start authoring and exchanging
packages.

### Phase 2 — Git-based install, updates

- `M-x install-package-from-git`.
- `M-x update-package` (all + by name).
- `:source-url` in manifests so transitive deps can be installed.
- `:pre-update-hook` / `:post-update-hook` / `:uninstall-hook`.

Tests: git-clone integration, update path, hook execution.

This phase makes Godot a viable host for an actual third-party
ecosystem without yet needing centralised infrastructure.

### Phase 3 — Registry (Vladimir's Chest)

- A JSON registry format.
- A registry server (initial: GitHub Pages of a single repo).
- `M-x install-package` resolves through the registry.
- Curated index; signing model TBD.
- `*package-archives*` defcustom for users to add custom indexes.

Tests: registry fetch, dependency resolution against registry,
signing verification.

### Phase 4 (or never) — Native plugins

The two-tier extensibility story. Out of scope until needed; called
out so future-us doesn't pretend the limit doesn't exist.

## Risks

- **Ecosystem trust.** Once a package can run arbitrary Lisp at
  load, the user is trusting every package they install. Loading
  hooks at boot is a code-execution surface. This is the same risk
  Emacs has lived with for decades — it's manageable, but worth
  naming up front.

- **Macros across package boundaries.** Unhygienic `defmacro` from
  a package can capture variables in user code, or in another
  package's code, in surprising ways. The convention-based
  namespace approach (A) doesn't help here. If the ecosystem grows
  to the point where this matters, hygienic macros (or a real
  module system) becomes load-bearing.

- **Version-constraint hell.** Even simple semver resolution can
  paint the user into a corner if two packages disagree on a shared
  dependency. The plan deliberately picks a thin constraint
  language to defer this — but real conflicts will arrive, and the
  resolver's error messages need to be honest about them.

- **Boot-time accretion.** A user with 30 eager-loaded packages has
  a much slower startup than a user with 0. The autoload-by-default
  rule is the main defence; the second defence is making lazy load
  the path of least resistance (`:autoload` is shorter than `:eager
  t`).

- **The "first package" problem.** Until someone writes the first
  good package, the system has no demonstration of value. The
  curated-baseline decision (Decision 5) addresses this directly:
  ship with a small set of useful packages out of the box, each
  doubling as an integration test for the system. The actual
  baseline list is deferred to Phase 1, but the commitment to
  having one is firm.

- **The host-primitive boundary moves.** Pure-Lisp packages are
  great until the first package that *would* exist if it could
  bundle one JS file. The MVP holds the line; future-us has to
  decide where the line actually goes.

## What this plan deliberately doesn't do

- It doesn't specify the JSON shape of the registry. That's Phase 3
  work, after the local-package experience tells us what fields
  matter.
- It doesn't pick a signing algorithm. Same reason.
- It doesn't define a sandbox model for hypothetical native
  plugins. Phase 4 work.
- It doesn't propose a UI for browsing the registry beyond the
  list-view sketch. The list view is enough for Phase 3; richer
  browse / search comes after.
- It doesn't specify how package documentation surfaces in `C-h f`
  / `C-h k`. Worth doing; not on the critical path.

## Closing note

The package system is the bridge between "the editor's author
extends it" and "the editor has an ecosystem." That bridge is worth
crossing carefully. The twelve decisions above settle the structural
questions — namespace, manifest, location, native-code stance,
defaults, naming, themes, evaluation, dependencies, tests, version
constraints, recovery — so Phase 1 has a concrete spec to brief.
Each subsequent phase still gets its own deliberate choice on what
it adds; we keep the option to stop at any phase if the next isn't
worth the cost.

The waiting, as the play knows, is the point. But the editor is the
substrate the waiting happens on, and the substrate is now ready to
ask "what comes next?" in a serious voice — and to answer it with
Vladimir's chest open and the supply lines drawn.
