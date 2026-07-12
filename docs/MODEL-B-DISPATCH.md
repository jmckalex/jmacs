# Model-B key dispatch & the directive channel

A reference for myself (Claude) and future versions of myself. The editor runs as a server (the *spine*, an Electron `utilityProcess`) that owns dispatch, plus one thin client per window, with a directive channel that drives them. Model B is the only mode — there is no flag (a bare `electron .` launches it). There is one keymap and one resolver, both server-side. The same handful of facts get re-derived from `grep` every session — this is them, written down once.

Read `docs/MAP.md` for the index and `docs/VIEWS.md` for the view/pane half. This document is the **dispatch + directive** half: how a keystroke becomes a command, where commands may live, and how a command makes something happen in a renderer it doesn't share a process with.

---

## The principle

> The **server (spine) is the only thing that resolves a key.** A renderer-side effect is never decided client-side — it is an instruction the server sends to a chosen set of clients.

This is what makes `close-other-windows`, `quit`, `show-help`, or a hypothetical `toggle-theme-everywhere` expressible: the command runs **once** on the server (the `utilityProcess` spine), which then addresses *whichever* clients it wants. A keystroke in window A can drive windows B and C.

---

## The pieces and where they live

```
 renderer / client (one per window)            spine / server (utilityProcess)
 ─────────────────────────────────             ───────────────────────────────
 keyEventToString(event)  ── KEY intent ─────▶  handleKey → interpreter.call(
   packages/renderer/src/keymap.js                'handle-key', key)   [keymap.lisp]
   (IME/composition guard; NO local              ├─ resolve via keymap-chain
    key resolution here)                         │   (minor → major → the-keymap)
                                                 ├─ prefix? hold chord state (Lisp)
                                                 ├─ command? command-registered?
 ◀── CLIENT_DIRECTIVE(name,args) ── port ──────┤   │   ├─ yes → run-command
   server-view-client.js                        │   │   └─ no  → no-op + status
     applyDirectiveDom(name,args)               ├─ buffer edit → already synced
   → app.js chrome.applyDirective(name,args)    └─ self-insert → insert! + echo
```

- **`packages/renderer/src/keymap.js` `keyEventToString`** stays in the renderer. It's pure event→string ("C-x", "M-left", "S-tab"); it does **no** resolution — the server resolves every key.
- **`apps/desktop/mwb/spine.js`** is the server. It loads the stdlib slice `SPINE_STDLIB`, then evaluates an **embedded Lisp block** of server-only commands, then `handleKey(key)` delegates to `interpreter.call('handle-key', key)`.
- **`packages/stdlib/lisp/keymap.lisp`** is the *one* keymap and the dispatch engine: `handle-key`, `lookup-key`, `keymap-chain`, `lookup-in-chain`, `-prefix-maps-for`, the prefix-map stack, and the key-reader (`*key-reader*` / `read-next-key`). It is authoritative and disk-editable; the old JS keymap tables are gone.
- **`apps/desktop/mwb/server.js`** is the bridge: it routes intents into the spine and posts the spine's outputs (views, directives) to the right client ports.
- **`apps/desktop/src/server-view-client.js`** is the client half in the renderer: it sends KEY intents and applies what comes back.

---

## Key resolution (keymap.lisp)

`handle-key` (keymap.lisp) is the whole state machine. At rest, a key is resolved through the **chain**, highest precedence first:

```
(keymap-chain) = (minor-mode-keymaps) ++ (list (major-mode-keymap) the-keymap)
```

`lookup-in-chain` returns the first binding among those maps. A binding is either a **command name** (a symbol) or a **nested keymap** (a prefix). Press a prefix key (`C-x`) and `handle-key` pushes the prefix-map stack (`-prefix-maps-for`) so the next key resolves within it — that's how `C-x C-f` works, and how a mode-local prefix falls through to the global one for keys it doesn't itself bind.

`read-next-key` routes the **next** keystroke to a callback instead of the keymap (this is how `describe-key`, `query-replace`, the quit walk read a key). It **auto-clears after one key** (`handle-key` nils `*key-reader*` before invoking the callback). A modal reader that re-prompts must re-arm the reader *and* offer a clean abort (C-g/Escape) that leaves **no** pending reader — otherwise the next chord gets eaten. (This bit the quit walk.)

Real `keyEventToString` names matter and the old JS tables used fictions: Shift+. is **`M-S-period`** (not `M-greater`), Cmd+] is **`M-]`** (literal).

---

## What runs server-side: SPINE_STDLIB vs not

`SPINE_STDLIB` (a frozen array in `spine.js`) is the exact list of `*.lisp` files the server loads, **in order**. If a file isn't in it, its definitions **do not exist server-side**. This is the second-most-common source of "my command says *not available here*."

- **Loaded:** `commands.lisp` (defcommand/run-command/interactive), `keymap.lisp`, `editing.lisp`, `custom.lisp`, `modes.lisp`, `occur.lisp`, the mode files, `panes.lisp`, `minimap.lisp`, `shell.lisp`, etc.
- **NOT loaded:** `help.lisp`, `docs.lisp` (they use renderer-only primitives like `println` / `open-doc!` / `start-doc-search!`). So `doc-known?`, `open-doc!`, the doc manifest, `start-describe-command!` are **absent** on the server.

**Primitives are split too.** A primitive is registered either in `packages/lisp/src/primitives.js` (core, everywhere), in the spine's host block (`spine.js`, server-side), or in the renderer's host block (`app.js`, renderer-side). The server cannot call a renderer primitive (e.g. `utility-panel-open!`, `open-docstring-page!`) directly — it must emit a **directive** (below). Before scoping any port, check which side a primitive lives on; don't trust a `.lisp` doc-comment (e.g. `shell` was already a real PTY+xterm — see `feedback_verify_impl_not_stale_comments`).

---

## Where a new command goes (and the testability cost)

Two homes for a server command:

1. **A `SPINE_STDLIB` `.lisp` file** (e.g. add to `occur.lisp` or a new file added to the array). **Unit-testable** via the stdlib suite (`createInterpreter` + `loadStdlib`). Prefer this when the command is pure-ish Lisp over available primitives.
2. **The `spine.js` embedded block** (next to `quit-editor`, `close-window`, the help commands). Use this when the command needs the spine's own host primitives or is server-topology glue. **Cost:** `spine.js` is **not in the test suite**, so embedded commands are invisible to `pnpm test`. Validate them with `node --check` + a **throwaway interpreter harness** (load the real stdlib, eval the exact embedded source, drive it), then **live-verify**. See `run-and-verify`.

> The harness is not optional ceremony — this session it caught a real directive-payload bug (`(list …)` nesting, below) before it reached a live launch. If you write embedded Lisp, harness it.

---

## The interactive minibuffer round-trip

A command reads an argument with an `(interactive …)` spec. The shapes:

```lisp
;; Named-param form — the body RUNS with the value. Use this for prompts
;; the server fulfils itself.
(defcommand occur (pattern)
  "..." (interactive (string "Occur: "))
  (let ((result (occur-result-text pattern (buffer-text)))) ...))

;; Lambda/placeholder form — the body is a DEAD placeholder; the host
;; intercepts the prompt and does the work. Only for host-intercepted
;; prompts (M-x, find-file).
(defcommand execute-command ()
  "..." (interactive (string "M-x ")) (lambda (name) name))
```

`run-command` (commands.lisp) gathers the spec's values and does `(apply (eval name) args)` — so the named-param form receives the value.

**The dispatch fork is in `server.js` `handleMinibufferSubmit`:** it switches on `spine.activePrompt`. A handful of prompts are special-cased ("M-x ", "Find file: ", "Switch to buffer: ", …); **every other prompt falls through to `spine.deliverMinibuffer(value)`**, which resumes the suspended Lisp continuation (the named-param body) with the typed string.

Consequences worth knowing:

- A new prompt string you invent (e.g. "Describe command: ", "Apropos: ") **just works** as pure embedded Lisp — no `server.js` change — because it falls through to `deliverMinibuffer`.
- **There is no interactive TAB completion** for M-x-style prompts (only find-file gets path completion). What looks like "M-x completion" is the **submit-time** lenient match `bestCommandMatch` (exact name, else the shortest registered name containing the input). To match a command name in Lisp, mirror that: exact `command-registered?`, else shortest-substring over `registered-command-names`.

---

## The directive channel (server → chosen clients)

A command whose effect is renderer-side does **not** mutate a server buffer — it emits a directive.

```lisp
;; spine.js embedded block. emit-client-directive! is VARIADIC: (ids name . args)
(emit-client-directive! (list (this-window-id)) 'show-help heading body)
```

Pick recipients with the id-set helpers (spine host primitives): `this-window-id`, `other-window-ids`, `all-window-ids`.

The path, end to end:

1. **`emit-client-directive!`** (Lisp) → `-emit-client-directive!` (spine host) converts NAME symbol→string and **each arg** to a plain JS value (number stays; symbol→name; else `lispString`). Nothing raw-Lisp crosses the port (structured-clone-safe).
2. **`server.js onClientDirective` → `sendClientDirective(ids, name, args)`** posts `{type: CLIENT_DIRECTIVE, directive:{name, args}}` to just those windows' ports.
3. **`server-view-client.js`** `case MSG.CLIENT_DIRECTIVE` → `applyDirectiveDom(name, args)` → **`app.js` `chrome.applyDirective(name, args)`**, a `switch` on `name`.
4. Add a new effect as a new `case` in `applyDirective` (close-window, quit, show-help, show-apropos live there).

### ⚠️ Pass directive args FLAT

`emit-client-directive!` is `(ids name . args)` — the args are **already** collected into a list by the rest-parameter. Passing `(list a b)` as a single argument **nests** them: the host then sees one arg whose value is a Lisp list, serializes it to `[object Object]`, and the renderer gets garbage. Correct:

```lisp
(emit-client-directive! (list (this-window-id)) 'show-help heading body)        ; ✓ flat
(emit-client-directive! (list (this-window-id)) 'show-help (list heading body)) ; ✗ nested
```

(The harness caught exactly this in the show-help work.)

---

## Worked example: `show-help` / `show-apropos` (C-h k / C-h f / C-h a)

The pattern for "a server command surfaces something in the window's chrome." The help commands resolve a command on the server (which owns the keymap *and* the docstrings) and render the result into the utility dock — renderer chrome — via the directive channel.

**Server (`spine.js` embedded block):**
```lisp
(define (-show-help! heading info)              ; args FLAT
  (emit-client-directive! (list (this-window-id)) 'show-help
                          heading (if (string? info) info "")))

(defcommand describe-command (typed)
  "..." (interactive (string "Describe command: "))
  (let ((name (-command-name-match typed)))     ; exact, else shortest-containing
    (cond ((nil? name) (show-status! (str "No command matching: " typed)))
          (else (-show-help! name (doc (eval (string->symbol name))))
                (show-status! name)))))
```

`describe-key` reads one key (`read-next-key`), resolves it through `(lookup-in-chain key (keymap-chain))`, and `cond`s on unbound / `map?` (prefix) / not-`command-registered?` / else (emit `show-help` with the docstring). `apropos-doc` matches name **or** docstring (case-insensitive) over `registered-command-names` and emits `show-apropos` with a Markdown bullet list.

**Renderer (`app.js`):**
```js
// applyDirective switch:
} else if (name === 'show-help') {
  displayDocPanel({ id: HELP_TAB_ID, title: 'Help', icon: '…',
    heading: String(args?.[0] ?? ''), body: String(args?.[1] ?? ''),
    empty: '_No documentation._' });
}
```

`displayDocPanel` renders BODY as Markdown, frames it in the `doc-page` shape the `<doc-view>` lifts, and opens **or refills in place** one reusable dock tab (the Completions-tab idiom: `utilityDock.hasTab(id) ? getPanel(id).setHtml(html) : openUtilityPanel({…, makePanel: createDocPanel})`). Reuse, not a fresh tab per call.

**Design rule learned here:** transient, read-only reference output (describe/apropos) belongs in the **utility dock**, not a main-pane buffer (no buffer-list clutter, `q`-dismissable). Long-form browseable docs (the manual, C-h d) stay in a **main-pane** `doc-view` via `showDocInPane`.

---

## The recurring traps (each with the why)

- **`nil` is truthy.** Test with `nil?`, never `null?`. An absent value that should be false is `#f`/empty, not `nil`.
- **Backticks in embedded Lisp.** A literal `` ` `` inside the `spine.js` embedded-Lisp **JS template literal** closes the template → syntax error. Use `'foo`, never `` `foo` ``, even in comments/strings there.
- **Escapes in embedded Lisp.** The JS template eats one backslash level. For the Lisp source `"\n"` (a newline), write **`"\\n"`** in `spine.js`; for `"\""` (a quote), write **`"\\""`**. (`packages/lisp/src/reader.js` maps `\n`→newline at read time.)
- **`spine.js` / `server.js` / `app.js` / `main.js` are not in the suite.** `node --check` for JS syntax; a throwaway interpreter harness for embedded Lisp; then **live-verify**. (`spine.js` *used* to read as binary to `grep` — a stray literal NUL byte in a string literal, since fixed to the `'\0'` escape; keep raw control bytes out of source so it stays greppable. If a file ever silently turns up empty under `grep`, suspect a NUL and bisect for it — `grep -a` forces text.)
- **`app.js` init TDZ.** The initial focus paint runs before later `let`/`const` declarations; adding a read of a later-declared variable aborts the whole renderer boot (window paints but is frozen). Hoist the var. Diagnose with `electron . --enable-logging=stderr | grep "before initialization"`.
- **Directive args must be FLAT and structured-clone-safe** (no raw Lisp symbols). See above.
- **Command/primitive namespace is shared** and **later-load-wins**; a command shadows a same-named primitive, and a `define`/`defcommand` in a *later*-loaded file silently clobbers an earlier one of the same name. This bites when a new top-level file names a command that a `languages/*.lisp` file (which loads *last*) already defines: the language file wins and your version vanishes. Grep for the name before defining; if you want both, name yours differently (e.g. `jmarkdown-environment` for the smart picker alongside the mode's quick `jmarkdown-insert-environment`). Use a distinct helper prefix per file (`-jmd-`/`-jmnav-`/`-jmref-`) so private helpers never collide.
- **A new stdlib `.lisp` file must be added to BOTH load lists** — `STDLIB_FILES` (`packages/stdlib/src/index.js`, the production loader + the test suite) *and* `SPINE_STDLIB` (`spine.js`, the server) — in a dependency-correct position. In *only* `STDLIB_FILES` → it loads in production but its commands are "not available here" server-side; in *only* `SPINE_STDLIB` → the production loader breaks. There is no single source of truth (a known scale papercut; deriving one from the other is a worthwhile cleanup).
- **`languages/*.lisp` load order is unspecified (effectively alphabetical) and they load AFTER `STDLIB_FILES`.** Consequences: (a) a language file cannot depend at *load time* on another language file (only late symbol binding is safe); (b) `"jmarkdown-auctex.lisp"` sorts *before* `"jmarkdown.lisp"` (`-` < `.`), so a separate wiring file would run before the mode it extends exists — mode keymap/menu wiring that references `jmarkdown-mode-map` must live *inside* `languages/jmarkdown.lisp`, not a sibling; (c) top-level authoring files (compile/insert/nav/ref) go in `STDLIB_FILES`+`SPINE_STDLIB` and load *before* the language file, so they must NOT touch the mode map at load — they only `define` commands, which the language file's wiring binds by symbol.
- **The renderer interpreter is INERT under the server.** Any `interpreter.call(...)` in `app.js` (e.g. `interpreter.call('major-mode-name')`) returns nothing/wrong — the server owns the interpreter. Read server-pushed state via the `resolved*` helpers (`resolvedMajorModeName`, `resolvedMathPreviewActive`), which prefer a pushed VIEW field (`buffer.majorModeName`) over the inert call. Hit by math-preview AND markdown-preview.
- **Stubbed spine primitives.** A server-registered command (a `SPINE_STDLIB` `.lisp` defcommand) may call a host primitive that is a no-op STUB in the spine (a deferred "render-side, build later"). The command "resolves" but does nothing. When porting a feature, grep the spine for the primitive and check it isn't a stub; route the effect through the directive channel.
- **Duplicate object keys silently shadow** (last wins). The spine host-primitives are one big object literal; adding a key that already exists elsewhere is silently overridden by the later one. Grep for an existing primitive before adding it (a leftover `markdown-preview!` stub shadowed a new one this way — the harness caught it: no directive emitted).
- **Opening dock chrome from a directive steals focus.** `utility-dock`'s `activateUtilityTab` force-focuses the panel, and the key router only forwards keys while the **editing surface** is focused — so the next chord is dropped until a click. After opening dock chrome with `focus:false`, return focus to the editor (the `refocusServerView` pattern: `serverViewClient.getView().focus()` next frame, guarded by `minibuffer.isOpen()`).

---

## Porting a renderer feature to Model B

The recurring task (help commands, math-preview, the minimap, markdown-preview). A renderer feature breaks under the server in up to **three** independent ways — check all three:

1. **Command dispatch.** If the command lives in a `SPINE_STDLIB` `.lisp` file it runs *server-side*. Its body must reach the renderer: either it calls a host primitive that emits a **directive** (the right pattern), or that primitive is a silent **stub** (broken — wire it to a directive). A renderer-only command *not* in SPINE_STDLIB instead routes via the M-x `RUN_CLIENT_COMMAND` fallback (gated to element-view commands).
2. **The effect.** A renderer-side effect is a `CLIENT_DIRECTIVE` → an `applyDirective` case in `app.js` that drives the chrome. Carry any data the renderer needs (e.g. the buffer's file path) in the directive args (FLAT, clone-safe).
3. **The renderer's own reads.** Code that read editor state through the (now-inert) interpreter must read **server-pushed VIEW fields** instead (`resolved*` helpers). This is the subtle one — the toggle can fire yet the feature still no-ops because a mode/active check came back false.

Worked example: the help family (`show-help`) covers 1+2; the markdown-preview port additionally hit 2 (the stub) and 3 (the inert mode check).

---

## Where to look — code & specs

The sections above describe the seams; this is where each one lives, so you can go straight in. **Files + symbols, not line numbers** — a symbol survives edits (grep it); a line number doesn't.

| Seam / concept | File | Symbols (grep these) |
|---|---|---|
| Key event → normalised string | `packages/renderer/src/keymap.js` | `keyEventToString` |
| Client: send KEY intent, apply directives | `apps/desktop/src/server-view-client.js` | `dispatchKey`, `applyDirectiveDom`, `case MSG.CLIENT_DIRECTIVE` |
| Server: dispatch entry, stdlib load, embedded commands | `apps/desktop/mwb/spine.js` | `handleKey`, `SPINE_STDLIB`, the embedded `interpreter.evaluate(...)` block, `deliverMinibuffer` |
| The one keymap + dispatch engine | `packages/stdlib/lisp/keymap.lisp` | `handle-key`, `lookup-key`, `keymap-chain`, `lookup-in-chain`, `-prefix-maps-for`, `read-next-key`, `the-keymap`, `c-x-keymap`, `c-h-keymap` |
| Command machinery (defcommand / run / interactive) | `packages/stdlib/lisp/commands.lisp` | `defcommand`, `run-command`, `command-registered?`, `registered-command-names` |
| Directive emit (Lisp wrapper + host) | `apps/desktop/mwb/spine.js` (embedded) | `emit-client-directive!`, `-emit-client-directive!`, `this-window-id`, `other-window-ids`, `all-window-ids` |
| Server routing + minibuffer-submit fork | `apps/desktop/mwb/server.js` | `onClientDirective`, `sendClientDirective`, `handleMinibufferSubmit`, `bestCommandMatch` |
| Wire protocol / message types | `apps/desktop/mwb/protocol.js` | `CLIENT_DIRECTIVE`, `MSG` |
| Renderer effect handlers | `apps/desktop/src/app.js` | `applyDirective` (chrome hook), `displayDocPanel`, `showDocInPane`, `performShutdown` |
| Core primitives + reader escape map | `packages/lisp/src/` | `primitives.js`, `reader.js` |
| Help worked example (this session) | `spine.js` (embedded) · `app.js` · `packages/renderer/src/doc-panel.js` | `describe-key`, `describe-command`, `apropos-doc`, `-show-help!` · `displayDocPanel`, `HELP_TAB_ID` · `createDocPanel` |

**Deeper (authoritative detail):** the Lisp dialect → `docs/spec/lisp.md`; major/minor modes → `docs/spec/modes.md`.
**Related playbooks:** views & panes → `docs/VIEWS.md`; adding a new on-screen surface → `docs/CUSTOM-VIEWS.md`.
**Up (the index):** `docs/MAP.md`.

---

## Reload rules (which edits need what)

| Edited | To pick up |
|---|---|
| `app.js`, `server-view-client.js`, `packages/renderer/src/*`, `*.lisp` *consumed by the renderer*, `styles.css` | window reload (Ctrl+Cmd+R) |
| `spine.js`, `server.js`, `protocol.js`, `src/main.js`, `preload.mjs`, **any `*.lisp` in `SPINE_STDLIB`** (incl. `keymap.lisp`) | quit + relaunch |

The build side can't launch the GUI — the architect live-verifies. See the `run-and-verify` skill for the exact dance.
