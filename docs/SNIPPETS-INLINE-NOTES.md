# Snippets — inline build, and how to repackage it

The snippet engine (`plans/SNIPPETS.md`, Phases 1–3) is built **inline
in the standard library** because the package system (`plans/PACKAGES.md`)
does not exist yet. Everything lives in `packages/stdlib` and loads
through `STDLIB_FILES`, with a small amount of host glue in
`apps/desktop`.

This document maps every piece of the inline build onto the eventual
`godot-snippets` package, so the conversion is a mechanical checklist
once the package loader lands. The placeholder package name is
`godot-snippets` (Decision 2 of SNIPPETS.md is still open).

## What was built (inventory)

### Lisp files (`packages/stdlib/lisp/`)

| File | Role |
|---|---|
| `snippets-parser.lisp` | Pure file-format reader (`parse-snippet-file`) and body parser (`parse-snippet-body`: `$N`, `${N:default}`, `$0`, `$$`, mirrors). No buffer/host access. |
| `snippets.lisp` | The engine: per-mode store, directory walking, `.yas-parents` fallthrough, built-in starter set, commands, the active-snippet record, field navigation, edit reflow, mirrors (Phase 3), settings, faces, the modeline getter. |
| `snippets-keymap.lisp` | TAB / S-TAB rebinding and the ESC / C-g cancel wrappers. Loaded last (after `keymap.lisp` and `multi-cursor.lisp`). |

Registered in `packages/stdlib/src/index.js` `STDLIB_FILES`, in this
order, right after `multi-cursor.lisp`:

```
'snippets-parser.lisp',
'snippets.lisp',
'snippets-keymap.lisp',
```

### Commands (`defcommand`)

`snippet-expand`, `snippet-insert`, `snippet-list`, `snippet-reload`,
`snippet-next-field`, `snippet-prev-field`, `snippet-cancel`,
`snippet-tab`, `snippet-shift-tab`.

Plus two **wrapped existing commands** (they save the prior definition
and call it): `deselect` (ESC) and `keyboard-quit` (C-g) — each cancels
an active snippet before its usual behaviour.

### Settings (`defcustom`, group `snippets`)

`*snippet-directories*`, `*snippet-expand-key*`, `*snippet-mode-aliases*`,
`*snippet-mirror-multi-cursor*`.

### Faces (`defface`)

`snippet-active-face`, `snippet-inactive-face`, `snippet-mirror-face`,
`snippet-exit-face`.

### Group

`(defgroup 'snippets 'godot …)` — a customize subgroup under `godot`.

### Keymap contributions (`snippets-keymap.lisp`)

```
(set! the-keymap (assoc the-keymap "tab"   'snippet-tab))
(set! the-keymap (assoc the-keymap "S-tab" 'snippet-shift-tab))
```

ESC (`"escape"` -> `deselect`) and C-g (`"C-g"` -> `keyboard-quit`) keep
their existing bindings; only the command definitions are wrapped.

### Host primitives (added in `apps/desktop`)

| Primitive | Where | Purpose |
|---|---|---|
| `snippet-user-directory` | `apps/desktop/src/app.js` | Returns `<userData>/snippets` (or `""`). |
| `snippet-date-string` | `apps/desktop/src/app.js` | Formats `date` / `datetime` / `year` for the built-in date snippets' backtick forms. |

Plus the supporting host wiring (not Lisp-visible primitives):

- `apps/desktop/src/preload.mjs` — exposes `host.userDataDirectory`,
  resolved once over a new sync IPC call.
- `apps/desktop/src/files.js` — the `userdata:dir-sync` ipcMain handler.
- `apps/desktop/src/app.js` — `USER_DATA_DIR` constant; the modeline
  appends `(snippet-modeline-indicator)`; buffer `onChange` calls
  `(snippet-after-edit!)`; `dispatchKey` calls
  `(snippet-soft-commit-if-outside)` after each key.

The engine also relies on **already-existing** host primitives:
`read-file-text!`, `list-directory-paths`, and the buffer/cursor
primitives (`point`, `goto!`, `set-mark!`, `clear-mark!`, `insert!`,
`delete-region!`, `buffer-substring`, `buffer-major-mode`,
`add-selection!`, `collapse-to-primary!`, `cursor-count`).

## The manifest sketch

`plans/SNIPPETS.md` already proposes a manifest. The inline build maps
onto it as:

```lisp
(package godot-snippets
  :version "0.1.0"
  :author "Godot"
  :doc "Snippet expansion à la yasnippet."
  :godot-version ">= 0.5"
  :depends ()
  :sources
    ("snippets-parser.lisp"     ; was packages/stdlib/lisp/snippets-parser.lisp
     "snippets.lisp"            ; was packages/stdlib/lisp/snippets.lisp
     "snippets-keymap.lisp")    ; was packages/stdlib/lisp/snippets-keymap.lisp (load last)
  :eager? #t                     ; the TAB binding must be live at boot
  :provides
    (:commands  (snippet-expand snippet-insert snippet-next-field
                 snippet-prev-field snippet-cancel snippet-reload
                 snippet-list snippet-tab snippet-shift-tab)
     :modes     ()
     :keymaps   ()               ; binds into the existing global keymap
     :faces     (snippet-active-face snippet-mirror-face
                 snippet-inactive-face snippet-exit-face)
     :settings  (*snippet-directories* *snippet-expand-key*
                 *snippet-mode-aliases* *snippet-mirror-multi-cursor*))
  :snippets "snippets/")         ; bundled starter set (see below)
```

`:eager? #t` is load-bearing: the TAB binding has to be installed at
boot, before the user invokes anything.

## Conversion checklist (inline -> package)

1. **Move the three Lisp files** from `packages/stdlib/lisp/` into the
   package directory `packages/godot-snippets/` (or
   `<userData>/packages/godot-snippets/`). Keep the load order:
   `snippets-parser.lisp`, `snippets.lisp`, `snippets-keymap.lisp`.

2. **Remove the three entries** from `STDLIB_FILES` in
   `packages/stdlib/src/index.js`. The package loader now supplies them
   via `:sources` and `:eager? #t`.

3. **Namespace the public symbols** per PACKAGES.md Decision 1
   (convention-only). Today the symbols are bare (`snippet-expand`,
   `*snippet-directories*`, `snippet-active-face`). The package convention
   is a `godot-snippets/` prefix — e.g. `godot-snippets/expand`. The
   commands a user types at `M-x` and the faces a theme references are
   the user-facing surface, so prefer keeping the friendly
   `snippet-…` names as the *public* aliases and prefixing only internal
   helpers. (Decision 1 leaves the exact convention to the author.) The
   `-`-prefixed helpers in these files are already private by
   convention.

4. **Bundle the starter set.** It currently lives as the
   `*snippet-builtins*` list literal in `snippets.lisp`
   (`fundamental-mode`: date, datetime, sig, todo, fixme, copyright;
   `prog-mode`: shebang, if, for; `js-mode`: fn, log). Convert each entry
   to a file under the package's `snippets/<mode>/<key>` directory (a
   `# key:`/`# name:`/`# --`/body file), and register that directory as a
   **package snippet root** (priority below the user directory). Drop the
   `*snippet-builtins*` list and `-builtins-for-mode` once the files
   exist, or keep them as a fallback if the package wants
   zero-filesystem operation. The package's snippet root is contributed
   to `*snippet-directories*` by the loader (`:snippets "snippets/"`),
   per SNIPPETS.md "Package snippets" location.

5. **Keep the host primitives in the host.** `snippet-user-directory`,
   `snippet-date-string`, the `userdata:dir-sync` IPC, the modeline hook,
   and the `snippet-after-edit!` / `snippet-soft-commit-if-outside`
   dispatch hooks are **host territory** (`apps/desktop`) and cannot move
   into a pure-Lisp package (PACKAGES.md Decision 4 — packages add no new
   JS primitives). They stay in `apps/desktop`. The package documents
   them as a host dependency in `:godot-version` (they ship from the
   version that introduced them). If the package were ever distributed
   for an older Godot, the `:godot-version` constraint refuses the
   install (Decision 11).

6. **Register settings / faces / commands via the loader.** Today they
   self-register at load via `defcustom` / `defface` / `defcommand`,
   which is exactly what the package loader evaluates. No code change —
   the `:provides` block is declarative metadata the installer checks
   against the actual registrations for collision detection.

7. **The keymap contribution stays a `set!` on `the-keymap`** in
   `snippets-keymap.lisp`. The package loader runs this at load; with
   `:eager? #t` it runs at boot. No keymap-merge machinery is needed.

## Notes / deviations worth flagging at conversion time

- **Built-in starter set lives in code, not files** (item 4). The brief
  asked for a "small built-in starter set … so it works out of the box
  even before the user adds files." Inline, the simplest way to guarantee
  zero-filesystem operation was a Lisp literal. When packaged, these
  become bundled snippet *files* (the SNIPPETS.md model), which is
  cleaner; the literal can then be dropped.

- **Mode resolution** derives the store key from the major mode's display
  name (`JavaScript` -> `javascript-mode`) then normalises through
  `*snippet-mode-aliases*` (-> `js-mode`). A real Godot may grow a direct
  mode-symbol -> snippet-dir mapping; if so, point `-current-mode-name`
  at it and the alias table becomes purely a yasnippet-compatibility
  shim.

- **Embedded code is a tiny allow-list.** Only the backtick tokens
  `` `date` ``, `` `datetime` ``, `` `year` `` are resolved (via
  `snippet-date-string`), enough for the starter set. General embedded
  code (`` `(form)` ``) and transformations (`${1:$(form)}`) are Phase 4
  and deliberately not built.

- **`# condition:` is parsed but not evaluated.** `parse-snippet-file`
  captures `:condition`; nothing consumes it (Phase 4). The
  `*snippet-condition-eval*` setting from SNIPPETS.md is therefore not
  defined yet — add it when conditions land.

- **One active snippet across the editor, not strictly buffer-local.**
  `*active-snippet*` is a module variable, not a per-buffer slot (the
  renderer exposes no buffer-local Lisp storage yet). In single-buffer
  interactive use this matches the one-snippet-per-buffer invariant;
  switching buffers mid-snippet soft-commits via
  `snippet-soft-commit-if-outside`. A true buffer-local slot is the
  correct long-term home.
