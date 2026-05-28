# Package management — guide notes

Design document for an extension package system. **Plan, not
implementation.** The intent is to surface the design choices that
need a decision, identify the implementation phases, and name the
risks; no code lands until the open questions at the end have answers.

## Motivation

Godot is Lisp-extensible by design. Today that means: users add code
to `~/.config/Godot/init.lisp`. Two pressures suggest it's time to
formalise the next layer:

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

    ~/.config/Godot/packages/
      magit/
        package.lisp           ← the manifest
        magit.lisp             ← the main source
        magit-blame.lisp       ← supporting source
        magit-keymap.lisp      ← bindings (loaded last)
        README.md              ← human-readable docs
        assets/                ← optional non-Lisp resources
          magit-icon.png

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

**Recommendation: ship (A) in the MVP, design toward (B) as a
follow-up.** Convention works in the small; the editor's standard
library is itself an existence proof. Modules become worth their
implementation cost once the package ecosystem is large enough that
collisions are routine. We'd rather not block the package system on
a language change.

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

Drop a directory into `~/.config/Godot/packages/`. The package
loader discovers it on next boot (or on `M-x package-rescan`). No
network, no registry, no signatures.

This is enough to:
- Develop a package locally (`~/Source/magit/` symlinked into the
  packages dir).
- Install something a friend zipped you.
- Distribute via git: `git clone … ~/.config/Godot/packages/magit`.

### Layer 2 — Git-based install

`M-x package-install-from-git` prompts for a URL and a ref. The host
clones into `~/.config/Godot/packages/<name>/`, reads the manifest
to confirm shape, and registers. Updates: `M-x package-update`
walks every git-installed package and pulls; failed updates leave
the package at its last good ref.

This adds:
- A real install/update UX.
- Dependency packages that themselves resolve to git URLs (declared
  in the manifest as `:source-url`).
- No central registry — discovery is "someone tells you the URL".

### Layer 3 — Centralised registry (GELPA — Godot ELPA)

A JSON index hosted somewhere stable (GitHub Pages of a single repo
is plenty for v1). Each entry: package name, version, manifest,
tarball URL, signing key.

`M-x list-packages` shows the registry. `M-x package-install` picks
by name. Versions resolve through the registry. Trust model: signed
manifests, signed tarballs, signing-key pinning per package on first
install.

### Why this staging?

Each layer is a real, useful product on its own. We don't need a
registry to start; we don't need git auto-update for local
development. The earlier layers don't go away when later ones
arrive — they remain the developer workflow even when GELPA is the
end-user path.

## Installation, updates, uninstall

### Where packages live

    ~/.config/Godot/packages/
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
3. Resolve dependencies; install transitively.
4. Move into `packages/<name>/`.
5. Generate autoload stubs into `.cache/autoloads.lisp`.
6. Run a `:install-hook` if the manifest declares one.
7. Update `installed.lisp` (the record of installed packages with
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

## Open questions

These are the design choices that need a decision before
implementation begins. Each is a real fork in the road, not a
bikeshed.

1. **Namespace approach.** Convention (A), real modules (B), or
   implicit (C)? The plan recommends (A); confirming this commits us
   for at least Phase 1 and 2.

2. **Manifest format.** The Lisp-form proposal above feels right
   for the editor's character. A TOML / JSON alternative would be
   more parseable by external tools but breaks the
   data-as-code-as-data symmetry. Confirm Lisp-form, or pick another.

3. **Should the package directory live under `~/.config/` or
   under the platform's userData directory** (where `init.lisp` and
   `custom.lisp` already live)? They should agree. Today the editor
   uses platform userData. Moving to `~/.config/Godot/` for both
   is a related but separable decision.

4. **The host-primitive escape hatch.** Should the MVP support
   *any* native code, e.g. a per-package `init.js` that the host
   loads with restricted IPC access? Or hold the line at zero JS?
   Holding the line is the recommendation; confirm.

5. **Default-installed packages.** Should a fresh Godot install
   ship with zero packages, or with a curated baseline (e.g. a
   `magit` equivalent, a `which-key` equivalent)? Recommendation:
   ship empty, document a "first packages to consider" list.

6. **Naming.** GELPA is a working title parallel to ELPA. Is that
   the long-term name? Or "Godot Packages" / "GPM" / "Vladimir's
   Chest" / something else?

7. **Should themes count as packages?** They could be a special
   case (lightweight: one file, no code) or a generic package. The
   generic-package answer keeps the system simple; the special-case
   answer is faster to install for non-coder users.

8. **The `package.lisp` manifest is evaluated, not just parsed.**
   That's powerful (a manifest can compute its `:provides` list)
   but it's also a code-execution surface at install time. Should
   manifests be plain data (read but not evaluated), or full Lisp
   forms? Recommendation: full Lisp, document the trust model. But
   this is a real choice.

9. **Dependency resolution scope.** Topological sort + version
   pins is enough for v1; do we need richer semantics later (peer
   dependencies, optional dependencies, dependency groups)?
   Probably eventually; not for the MVP.

10. **Test packages.** Does the registry's metadata include test
    suites? Is `pnpm test`-style verification part of package CI?
    Out of scope for MVP, but worth noting.

11. **What happens when a package's `:godot-version` constraint
    fails?** Refuse to install (recommendation)? Install but warn?
    Install but disable autoloads?

12. **Updating Godot itself.** If a Godot version bump breaks a
    package, what's the user's recovery path? `M-x package-disable
    foo` to skip a single package at boot is probably the right
    escape hatch — confirm we ship it from day one.

## Suggested phasing

### Phase 1 — Local packages, manifest, autoload

- Manifest spec (`package.lisp`).
- Discovery of `~/.config/Godot/packages/*/package.lisp`.
- Dependency resolution (topo + version constraint).
- Autoload stub generation.
- `require!` mechanism.
- `M-x` commands: `list-packages`, `package-rescan`,
  `package-describe`, `install-package-local`, `uninstall-package`.
- Package-list view (kind `package-list`).
- Pinning support.

Tests: package discovery, dependency cycle detection, autoload stub
shadowing, version constraint matching, conflict reporting.

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

### Phase 3 — Registry (GELPA)

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
  good package, the system has no demonstration of value. Plan
  recommends the maintainer write one as the system ships — a
  small, useful, exemplary package that doubles as the integration
  test (`godot-essentials` or similar).

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
crossing carefully. The MVP — local packages, manifest, autoloads,
no network — gets a working substrate in place without taking
positions on the harder questions (centralised distribution, native
extensibility, trust model). Each subsequent phase makes a deliberate
choice on those, with the option to stop at any phase if the next
isn't worth the cost.

The waiting, as the play knows, is the point. But the editor is the
substrate the waiting happens on, and the substrate is now ready to
ask "what comes next?" in a serious voice.
