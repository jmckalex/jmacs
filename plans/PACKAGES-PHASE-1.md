# Phase 1 — Local packages, manifest, autoload, list-view

Concrete implementation brief for Phase 1 of `plans/PACKAGES.md`.
Read PACKAGES.md first; this doc assumes its twelve decisions are
locked (convention namespaces, Lisp manifest, userData location,
zero JS, curated baseline TBD, Vladimir's Chest, generic theme
packages, full-Lisp eval, topo + version constraints,
refuse-on-version-fail, package-disable on day one).

## Scope

- **Local packages only.** A package is a directory in
  `<user-data>/packages/`. No git install, no registry, no network.
  Adding a package is `cp -r foo ~/Library/Application\ Support/Godot/packages/foo`
  (or the platform's equivalent) followed by `M-x package-rescan`.

- **Pure Lisp packages.** No `init.js`; no native code surface.
  Decision 4 holds firm in Phase 1.

- **The full Phase-1 command surface.** `list-packages`,
  `install-package-local`, `uninstall-package`, `package-disable`,
  `package-enable`, `package-rescan`, `package-describe`.
  `install-package-from-git` and `update-package` belong to Phase 2.

- **One new view kind**: `package-list`. The browse surface for
  installed packages, in the existing tabline / pane infrastructure.

- **Boot pipeline gains a step.** `loadUserConfig` splits into
  `loadCustomLisp` → `loadPackages` → `loadInitLisp` so the package
  loader sees `custom.lisp`'s settings and `init.lisp` sees the
  packages' contributions.

- **The curated baseline lands**: Decision 5 commits us to shipping
  with a small set of useful packages. The list is settled during
  this phase (see "Curated baseline" below) and each baseline
  package doubles as an integration test.

## What stays unchanged

- The Lisp dialect. No new special forms; package machinery is
  ordinary `defcommand` / `define` / `assoc`-driven data.
- `custom.lisp` and `init.lisp` semantics. The user still writes
  `init.lisp` to extend the editor; what changes is that `init.lisp`
  is now evaluated *after* the packages have contributed their
  autoloads / bindings / defcustoms.
- The kind registry mechanism in `app.js`. We register one new
  kind (`package-list`) through the same `kindRegistry.register(kind,
  spec)` API the existing ten kinds use.
- `STDLIB_FILES` order — we add one entry (`packages.lisp`) near
  the end, after the customisation registry and the face/theme
  files. Packages can register defcustoms, defcommands, and
  defthemes, so the registries those declare in must exist first.
- Existing host IPC surface. We add two narrowly-scoped IPC
  primitives (subdirectory read + manifest-file read); we do not
  generalise the existing `config:read` to take subpaths.

## The data model

A loaded-package record (live in interpreter, not persisted as-is):

```lisp
;; A `package` record (used at runtime; persisted form below)
(package
  :name 'magit
  :version "0.3.1"
  :provenance :local           ; :local | :git | :registry in Phase 2/3
  :path "/Users/jane/Library/Application Support/Godot/packages/magit"
  :manifest <the parsed manifest assoc>
  :loaded? #f
  :disabled? #f
  :pinned? #f)
```

`installed.lisp` (persisted at `<user-data>/packages/installed.lisp`):

```lisp
;; Generated; do not edit by hand. Format is plain Lisp data —
;; an assoc of :installed and :disabled and :pinned lists.
((:installed
   ((magit       "0.3.1" :local)
    (diff-utils  "0.2.4" :local)))
 (:disabled
   (broken-pkg))
 (:pinned
   ((magit "0.3.1"))))
```

A read of `installed.lisp` is the source of truth for what's on
disk plus user state (disabled / pinned). The on-disk directories
under `packages/` are authoritative for the package *contents* —
`installed.lisp` doesn't get a vote on what's actually there. A
package's manifest declares its version; `installed.lisp` only
remembers the version observed at install time so the user can see
"installed 0.3.1, on disk 0.4.0 — re-scan to pick up".

## Boot pipeline change

Today (`app.js` ≈ line 3234):

```js
async function loadUserConfig() {
  // Read + evaluate custom.lisp
  // Read + evaluate init.lisp (or write the template on first boot)
}
```

After Phase 1:

```js
async function loadCustomLisp() { /* unchanged content */ }
async function loadPackages()    { /* see below */ }
async function loadInitLisp()    { /* unchanged content */ }

// boot site (≈ line 3318):
if (keymapReady) {
  await loadCustomLisp();
  await loadPackages();
  await loadInitLisp();
}
```

`reloadStdlib` (≈ line 3258) becomes:

```js
await loadStdlib(...);
installFacePersistence();
if (faceOverridesCache !== null) interpreter.evaluate(/* … */);
await loadCustomLisp();
await loadPackages();   // <— new
await loadInitLisp();
applyCurrentTheme();
applyCurrentFaceStyles();
```

`loadPackages()` body, in prose:

1. Walk `<user-data>/packages/*/package.lisp`.
2. For each: read source, evaluate in a fresh sandbox env, treat
   the resulting form as the manifest (Decision 8).
3. Reject the package (with a clear `repl.appendError`) if the
   manifest is malformed, if `:godot-version` is unsatisfied
   (Decision 11), or if the package is in the persisted
   `disabled-packages` list.
4. Topologically sort the remaining packages by `:depends`. Report
   cycles as errors and skip the affected component.
5. For each package in topo order:
   - Generate autoload stubs (`defcommand` shells that call
     `require!`).
   - If `:eager t`, also evaluate `:sources` immediately.
6. Concatenate the autoload stubs to `.cache/autoloads.lisp` for
   visibility/debugging (write is best-effort; failure logs but
   doesn't abort boot).
7. Update the live `*package-registry*` Lisp variable so
   `list-packages` and friends can read it.

`init.lisp` then evaluates with the autoloads installed; the user's
`(pin-package! 'magit "0.3.1")` and similar commands take effect.

## File-by-file walkthrough

### `apps/desktop/src/files.js` — IPC additions

Add three small IPC handlers (called from main.js via `ipcMain.handle`):

- `'packages:list-dir'` — returns the bare names of directories in
  `<userData>/packages/` (no recursion). Returns `[]` if the dir
  doesn't exist; creates the dir on first call.
- `'packages:read-manifest'` — given a package name, reads
  `<userData>/packages/<name>/package.lisp` and returns the
  source text. Returns `null` if not present. Path is constructed
  from the bare name; never accepts arbitrary paths.
- `'packages:read-source'` — given a package name and a source-file
  relative path, reads `<userData>/packages/<name>/<rel>` and
  returns the text. Validates that the resolved path stays inside
  the package directory (`fs.realpath` + prefix-check) — refuses
  symlink escapes.

Plus matching writes for `installed.lisp` and `.cache/autoloads.lisp`:

- `'packages:read-installed'` / `'packages:write-installed'` — the
  persisted state.
- `'packages:write-autoloads-cache'` — the regenerated stubs file.

All five new handlers follow the `configPath`/`/^[\w.-]+$/` style
of the existing `config:read` — reject anything with path
separators or `..`.

### `apps/desktop/src/preload.mjs`

Expose each of the new IPC channels through `window.host`:

```js
listPackages: () => ipcRenderer.invoke('packages:list-dir'),
readPackageManifest: (name) =>
  ipcRenderer.invoke('packages:read-manifest', { name }),
readPackageSource: (name, rel) =>
  ipcRenderer.invoke('packages:read-source', { name, rel }),
readInstalledRecord: () =>
  ipcRenderer.invoke('packages:read-installed'),
writeInstalledRecord: (text) =>
  ipcRenderer.invoke('packages:write-installed', { text }),
writeAutoloadsCache: (text) =>
  ipcRenderer.invoke('packages:write-autoloads-cache', { text }),
```

Strings only across the IPC boundary. The renderer parses /
serialises Lisp data on its side.

### `apps/desktop/src/main.js`

Register the five handlers. Each routes through the helpers in
`files.js`. No surprises.

### `apps/desktop/src/app.js`

Two contributions:

1. **Boot pipeline split** (lines ~3234, ~3258, ~3318 — see "Boot
   pipeline change" above).
2. **Host primitives** for the package loader. Add to the existing
   primitive-registration block (search for `interpreter.register`
   or the host-primitives section near where citation primitives
   landed):

   ```js
   interpreter.register('host-list-packages', async () =>
     await window.host.listPackages());
   interpreter.register('host-read-manifest', async (name) =>
     await window.host.readPackageManifest(name));
   interpreter.register('host-read-package-source',
     async (name, rel) => await window.host.readPackageSource(name, rel));
   interpreter.register('host-read-installed', async () =>
     await window.host.readInstalledRecord());
   interpreter.register('host-write-installed', async (text) =>
     await window.host.writeInstalledRecord(text));
   interpreter.register('host-write-autoloads-cache', async (text) =>
     await window.host.writeAutoloadsCache(text));
   ```

   The Lisp side calls these through `(host-*)` and wraps them in
   higher-level operations.
3. **Kind registry entry** for `package-list`:

   ```js
   kindRegistry.register('package-list', {
     hasBuffer: false,
     mount: (view) => packageListView.mount(view, editorPaneElement()),
     dispose: (view) => packageListView.unmount(view),
     setView: (view) => packageListView.setView(view),
     focus: () => packageListView.focus(),
     modeline: (view) => ` [packages — ${view.state.rowCount} entries]`,
   });
   ```

### `packages/stdlib/src/package-primitives.js` (new)

The host-side glue: a thin module that registers helpers the Lisp
side calls. Most of the package machinery lives in Lisp; this file
covers the few operations that need JS (sync file I/O via the host
primitives, JSON↔Lisp marshalling for `installed.lisp` if we ever
need it, the topological sort if we'd rather write it in JS than
Lisp — see Q below).

Open question for the implementer: write the topological sort in
JS (faster, less elegant) or in Lisp (slower for huge graphs but
visible in the REPL)? Default to Lisp; only move it to JS if Phase
2's git-install profiling shows it matters.

### `packages/stdlib/lisp/packages.lisp` (new)

The substantial Lisp file. Adds:

- The `(package name :version ...)` reader — actually it's just a
  function `package` that returns its arguments as an assoc, so a
  manifest's `(package ...)` form *is* the parsed manifest.
- `(load-packages!)` — the entry point called from boot.
- `(require! 'name)` — load a package's sources if not already
  loaded; runs the `:after-load` hook.
- `(install-package-local! path)` — copy / move a directory into
  the packages dir and re-scan.
- `(uninstall-package! name)` — remove the directory and re-scan.
- `(disable-package! name)` / `(enable-package! name)` — toggle
  the `disabled-packages` list in `installed.lisp`.
- `(pin-package! name version)` / `(unpin-package! name)` — manage
  the `pinned-packages` list.
- `(package-list)` / `(package-installed?)` / `(package-loaded?)` /
  `(package-disabled?)` / `(package-pinned?)` accessors.
- `(satisfies-version-constraint? version constraint)` — the
  semver matcher for `:depends` and `:godot-version`.
- `(topo-sort-packages packages)` — dependency resolver.
- The `*package-registry*` variable that holds the live records.

The defcommands wrap the above:

```lisp
(defcommand list-packages ()
  "Open the package-list view."
  (let ((view (make-package-list-view!)))
    (switch-to-view! view)))

(defcommand install-package-local ()
  "Prompt for a directory, install it as a package."
  (let ((path (read-directory-from-minibuffer "Package directory: ")))
    (install-package-local! path)
    (message (format "Installed: ~a" path))))

;; … and the rest: uninstall-package, package-disable, package-enable,
;; package-rescan, package-describe.
```

Add `'packages.lisp'` to `STDLIB_FILES` in
`packages/stdlib/src/index.js`. Slot it after `themes.lisp`
(packages can register themes) and before `keymap.lisp` (keymap
hasn't bound the package commands yet because they were just
defined). Actually — packages.lisp defines the *commands* but
doesn't bind them; the binding goes in `keymap.lisp`'s package
section. So load order is: faces → themes → packages → keymap.

### `packages/stdlib/lisp/keymap.lisp`

Add bindings for the package commands. Suggested defaults — tucked
under the `M-x` discoverability surface, no global chord prefix:

```lisp
;; Package-list view local keys (bound on the view's keymap, not
;; the global keymap):
;;   i  install
;;   u  mark for update
;;   d  mark for delete
;;   x  execute marked operations
;;   D  disable package
;;   E  enable package
;;   g  refresh
;;   /  filter
;;   q  close
;;   Enter  describe
```

No global chord for `M-x list-packages`; users add their own in
`init.lisp` if they want one. (Per the editor's halfway-between-
Python-and-Perl design feedback: capable abstractions, not
constrained ones — the user picks.)

### `packages/renderer/src/package-list-view.js` (new)

A new view module. Follows the pattern of
`directory-columns-view.js` for its table-rendering surface;
follows `view-menu.js` for its keyboard handling style.

The view's state shape:

```js
{
  packages: [   // sorted by name
    {
      name: 'magit',
      version: '0.3.1',
      provenance: 'local',
      status: 'loaded' | 'installed' | 'disabled' | 'pinned',
      doc: 'Git integration for Godot.',
      marks: { update: false, delete: false },
    },
    ...
  ],
  filter: '',         // incremental filter string
  selectionRow: 0,
  rowCount: 0,        // derived; in the spec for the modeline
}
```

The view module reads from `*package-registry*` (via a host
primitive that returns the snapshot as JSON or as a Lisp list,
whichever is cheaper) and re-renders on focus and on `g` (refresh).

Visual style: same warm background as `directory-columns-view`,
slightly narrower padding, monospace columns: `[mark] name
version  status  doc`. Filter input docked at the bottom in the
same style as `M-x` echo.

### Tests

- `packages/stdlib/test/packages.test.js`:
  - Manifest parsing — well-formed, missing fields, malformed forms.
  - `satisfies-version-constraint?` — every operator (`>=`, `>`,
    `=`, `*`), boundary cases (`0.10` vs `0.2` not lexicographic).
  - `topo-sort-packages` — linear, branching, cycle detection.
  - Autoload stub generation — produces a `defcommand` that calls
    `require!`; the stub yields control to the real definition
    after `require!` returns.
  - `disable-package!` + `enable-package!` — round-trip through
    the persisted state.
- `apps/desktop/test/packages-fs.test.js`:
  - `host-list-packages` returns directory names.
  - `host-read-manifest` reads and returns text; refuses path
    traversal.
  - `host-read-package-source` refuses symlinks that escape the
    package dir.
- `apps/desktop/scripts/smoke.js` — add a new arm:
  - Drop a one-file test package into a temp directory used as
    `userData`.
  - Boot the editor.
  - Run `M-x list-packages`; assert the test package shows up.
  - Run `(require! 'test-package)`; assert the package's
    contributed defcommand becomes available.
  - Disable the package; restart; assert it didn't load.

Target test count: +25 to +35 for `packages.test.js`, +6 for the
FS-IPC test, +1 smoke arm.

## Manifest semantics

The manifest form is evaluated (Decision 8). A `(package name ...)`
call returns an assoc:

```lisp
;; Equivalent to:
(package magit :version "0.3.1" :depends ((diff-utils ">= 0.2")))
;; …evaluates to:
'((:name . magit)
  (:version . "0.3.1")
  (:depends . ((diff-utils ">= 0.2")))
  (:godot-version . "*")     ; default
  (:sources . ())            ; default
  (:autoload . ())           ; default
  (:provides . ())           ; default
  (:eager? . #f))
```

Manifest is evaluated in a sandbox env that exposes only:
- Constructors: `package`, `keyword`, basic data primitives.
- A few read-only host queries: `godot-version`, `host-platform`.
- *No* file I/O, *no* network primitives, *no* mutation of global
  state.

This is the install-time security gate: a manifest can compute its
fields, but it can't open a socket. The package's `:sources` get
full unrestricted Lisp on load (matching the trust model named in
Decision 8 — installing the package is opting into its code).

## Autoload mechanism

For each `:autoload SYM` in a manifest:

```lisp
;; Generated stub, evaluated at boot:
(defcommand SYM ()
  "Autoloaded from package `PKG-NAME'."
  (require! 'PKG-NAME)   ; loads the real definition
  (SYM))                 ; tail-call into the now-real binding
```

The recursive call works because `defcommand` re-binds the symbol:
the original stub's body still refers to `SYM`, but by the time
the body runs, `SYM` resolves to the post-require definition. The
stub fires once; subsequent dispatches skip it entirely.

`require!` semantics:

1. If `(package-loaded? 'PKG)`, return.
2. If `(package-disabled? 'PKG)`, raise `'package-disabled`.
3. Resolve `:depends` transitively; `require!` each.
4. For each `:source` file:
   a. Read text via `host-read-package-source`.
   b. Evaluate in the global env (not the manifest sandbox).
5. Run `:after-load` hook if declared.
6. Mark loaded; update `*package-registry*`.

A package whose load *raises* (any Lisp condition) is left in a
half-loaded state with a clear error to the REPL. The user can
`M-x package-disable` to skip it next boot. No automatic
roll-back: rolling back partial side effects is a hard problem we
don't need to solve in Phase 1.

## Dependency resolution

Standard topological sort. Cycles are an error reported as:

```
package cycle: magit → diff-utils → magit
```

Version constraint failures during install or `require!`:

```
magit (0.3.1) requires diff-utils >= 0.2; installed 0.1.4
```

The constraint language stays minimal: `>= X`, `> X`, `= X`, `*`.
No carets, no range expressions, no pre-release qualifiers.
Comparison is dotted-integer-tuple (so `0.10 > 0.2`).

## Disable / enable + pinning

Both stored in `installed.lisp` as separate lists.

`disable-package!` writes the package's name to `:disabled` and
flushes `installed.lisp` immediately. Effect: next boot, the
loader sees the name in `:disabled` and skips autoload generation
+ eager loading. The user's existing session keeps running; the
restart is what makes the disable visible.

`enable-package!` removes the name from `:disabled`. Same
restart-to-take-effect rule.

`pin-package! 'NAME "VERSION"` writes `(NAME "VERSION")` to
`:pinned`. The pin doesn't change current-session behaviour; it
causes `(update-package! ...)` in Phase 2 to skip the pinned
package.

`M-x package-describe NAME` shows pin / disable status alongside
the manifest summary so the user knows the current state.

## Package-list view kind

Surface: a new view kind, mounted via the kind registry. Behaves
like `directory-columns-view`:

- Constructed with `(make-package-list-view!)` — returns a view
  handle (per the pane-creating-commands-return-handles convention,
  decision 10 from PANES.md).
- Lives in `views[]` like any other view. Pane / tabline behaviour
  is inherited — no special-casing.
- Re-reads `*package-registry*` on focus (`mount` and `setView`)
  so its display stays current after a `package-rescan` or after
  install / uninstall.

Keymap (view-local; falls through to global on misses):

```
Enter       describe the package on this row
i           install (when row is :available — Phase 2/3, dormant
            in Phase 1)
u           mark for update (Phase 2/3, dormant in Phase 1)
d           mark for delete
D           disable the package
E           enable a previously disabled package
x           execute marked operations (currently: delete)
g           refresh
/           incremental filter (echo-area prompt)
q           close (delete the view)
```

The dormant Phase 2/3 keys are wired but report "not yet
implemented" — the alternative (omitting them) means rebinding
later, which is more work and a bigger surprise for users.

## The curated baseline

Decision 5 commits us to a curated baseline; the actual list is
chosen during Phase 1. Two requirements for a baseline package:

1. **Genuinely useful out of the box.** Something a fresh-install
   user benefits from on day one.
2. **Exercises the package machinery.** Together the baseline
   should cover: `:autoload`, `:eager t`, `:depends`, `:after-load`,
   keymap contribution, defcustom contribution, defface
   contribution.

Suggested initial candidates (final choice ratified before commit):

- **`which-key-lite`** — an enhanced chord-prefix display
  (currently the editor shows the prefix in the echo area;
  which-key-lite would replace that with a richer popup listing
  the continuations). Exercises: `:autoload`, keymap hook,
  defcustom.
- **`project-switcher`** — `M-x project-switcher` opens a
  fuzzy-find over a configured list of project roots. Exercises:
  `:autoload`, defcustom (`*project-list*`), defcommand.
- **`godot-essentials`** — a placeholder integration-test package
  that contributes one of each thing the system supports (one
  defcommand, one defcustom, one defface). Not user-facing
  utility; ships disabled by default but is what the smoke test
  drives.

Decision: ship two real baselines plus one integration-test
package. The actual two are picked by the implementer with one
question to Jason before commit, not in this brief.

The baseline packages live in `packages/godot-baseline/`,
sibling to `packages/stdlib/`. The build / install path copies
them into `<userData>/packages/` on first boot if the directory
doesn't already contain a baseline-marker file.

## Things NOT to do this phase

- **No git install.** `install-package-from-git` is Phase 2.
  Reject `git@…` / `https://….git` URLs in `install-package-local`
  with a clear "use Phase 2" message.
- **No update mechanism.** A package on disk is the package; no
  in-place upgrade. `update-package` is Phase 2.
- **No registry.** Vladimir's Chest is Phase 3.
- **No native code path.** No `init.js`. Decision 4 holds.
- **No optional / peer dependencies.** Decision 9. Hard `:depends`
  only.
- **No package signing.** Phase 3 concern.
- **No host-API stability promise.** A package using a host
  primitive is using something that may evolve; the manifest
  declares `:godot-version`, which is the only stability surface.
- **No JS sandbox for the manifest.** The manifest is Lisp,
  evaluated in a Lisp sandbox env; we don't invent a JS sandbox.
- **No automatic recovery from partial-load failures.** A
  half-loaded package's side effects are kept. The user disables
  + restarts.

## Branch + commit shape

- Branch: `agent-package-system-phase-1`.
- Suggested commit cadence (each passes `pnpm test` + smoke):
  1. `feat(host): IPC primitives for packages/ directory I/O` —
     `files.js`, `preload.mjs`, `main.js` additions. Unit tests
     for the FS surface.
  2. `feat(stdlib): packages.lisp with manifest reader, topo
     resolver, version constraints` — pure-Lisp machinery without
     yet wiring it to the host. Tests in `packages.test.js`.
  3. `feat(app): split loadUserConfig into custom / packages /
     init; call loadPackages between them` — boot pipeline change.
     With no packages on disk, behaviour is identical to today.
  4. `feat(lisp): autoload stub generation + require!` — the
     mechanism that wires manifests into the boot pipeline. Tests
     for autoload firing once and shadowing the stub.
  5. `feat(packages): disable / enable / pin commands` — the
     escape hatches.
  6. `feat(renderer): package-list view kind` — the new view
     module; kind-registry registration; `make-package-list-view!`
     primitive.
  7. `feat(stdlib): list-packages, package-describe, package-rescan,
     install-package-local, uninstall-package commands` — the
     user-facing M-x surface.
  8. `feat(packages): curated baseline (which-key-lite +
     project-switcher + integration test package)` — the actual
     baseline implementation. One short architect note before this
     commit confirms the final two packages.
  9. `test: smoke arm for package boot, disable, baseline load` —
     the integration check.

Merge as `--no-ff` with the sub-commits preserved. Per Jason's
test-before-merge feedback: hand off for live testing in the
running app before merging.

## Test gate

Before each commit:
- `pnpm test` — every package green. Target ~30 new tests by the
  end of the branch.
- `pnpm --filter @editor/desktop smoke` — PASS, including the new
  package smoke arm by the end.
- Live verification: `M-x list-packages` opens; the baseline
  packages show as `loaded`; `M-x package-describe magit` (or
  whichever baseline) renders a sane summary; `M-x package-disable`
  + restart confirms the package is skipped; `M-x package-enable`
  + restart confirms it's back.

## When to stop and write to architect-notes.md

Per CLAUDE.md:

- The baseline-package choice — one architect note before commit
  #8 with the final two picks for ratification.
- If the manifest sandbox env exposes too much / too little —
  worth a pause if a baseline package would *want* a primitive the
  sandbox bans. The principled answer is "manifests can't have
  it"; the practical answer might differ.
- If the autoload mechanism interacts surprisingly with how
  `defcommand` records its metadata — the recursive-call trick
  assumes `defcommand` overwrites previous bindings; if it
  warns/refuses, the strategy needs revising.
- If `*package-registry*` snapshotting for the list view ends up
  needing IPC because the Lisp data is too large to serialise into
  the view module efficiently — unlikely with a curated baseline,
  possible with a heavy user setup.
- If a baseline package needs to do something the host doesn't
  expose (e.g. project-switcher wants directory enumeration with
  glob support and the existing primitives don't suffice). Add
  the primitive, but flag it — the line at which host primitives
  expand matters.

Stop cleanly (committed, tests passing) and write the question.
Don't guess and proceed.

## Effort estimate

A focused two-day effort: one day for the substrate (commits 1–5,
the machinery), one day for the user surface and baseline
(commits 6–9). Comparable to the multi-cursor merge in surface
area, more than the citation work but less than PANES Phase 3B.
The conceptual shift is small (packages are just directories +
manifests); the work is in plumbing and tests.
