---
name: run-and-verify
description: Use when running, launching, or verifying a change in the Godot editor app — especially Model B server-side changes (spine.js / server.js / protocol.js / keymap.lisp or any SPINE_STDLIB *.lisp) and embedded-Lisp commands. Covers the launch command, the reload rules (renderer vs server vs lisp), node --check for the files the test suite does not cover, and the throwaway interpreter-harness trick for validating embedded Lisp before a live launch. Fires whenever you are about to hand a change off for live testing or are unsure how to confirm it works.
---

# Run & verify a Godot change

The architecture is Model B: a Lisp **server** (the *spine*) plus thin per-window clients. See `docs/MAP.md` and `docs/MODEL-B-DISPATCH.md` for the model; this skill is the *procedure* for proving a change works.

## The one reality that shapes everything

**The build side cannot launch the GUI — the architect (Jason) live-verifies every change.** So your job before handoff is to make the change *maximally verified by other means*, then hand Jason a precise, minimal verification script. A wasted launch cycle is the scarce resource; spend effort to avoid one.

## Launch (what Jason runs)

```
cd /Users/jalex/Source/jmacs/main/apps/desktop && ./node_modules/.bin/electron .
```

Model B is the only mode now — a bare launch boots it (the `GODOT_SERVER` flag is gone; see `plans/MODEL-B-DEFAULT.md`). Add `--enable-logging=stderr` to surface renderer console + errors (also how you diagnose the `app.js` init TDZ trap: `… | grep "before initialization"`). Do **not** use `pnpm dev` (its pre-run check fails on a `citation-js` placeholder).

## Reload rules — which edit needs what

| Edited | To pick up |
|---|---|
| `app.js`, `server-view-client.js`, `packages/renderer/src/*`, renderer-loaded `*.lisp`, `styles.css` | **window reload** (Ctrl+Cmd+R) |
| `spine.js`, `server.js`, `protocol.js`, `src/main.js`, `preload.mjs`, **any `*.lisp` in `SPINE_STDLIB`** (incl. `keymap.lisp`) | **quit + relaunch** |

If you changed both a server file and a renderer file, a quit + relaunch covers both.

## Pre-handoff checklist

1. **`pnpm test`** (root) — the full suite. `pnpm --filter @editor/<pkg> test` for one package. Suite is currently ~3173 tests.
   - Note: the suite has an **intermittent CPU-spin hang** (a `node --test` worker that never exits). If a run pegs a core for minutes when it normally finishes in under one, it is hung, not slow — kill it (`kill -9` the worker) and re-run; it usually passes. Watch for orphaned `node --test` zombies left behind.
2. **`node --check <file>`** for every file the suite does **not** cover: `spine.js`, `server.js`, `app.js`, `main.js`. (`grep -a` on `spine.js` — it reads as binary.)
3. **Harness any embedded Lisp** you added to `spine.js` (next checklist).
4. Hand Jason the **exact** keystrokes to verify (below).

## The throwaway-harness trick (validate embedded Lisp without the GUI)

Commands in the `spine.js` embedded block are **invisible to `pnpm test`**. Validate them by loading the *real* stdlib and evaluating the *exact* embedded source in a scratch script. This catches reader/escaping errors, wrong primitive names, and bad directive payloads before a live launch (it has paid for itself repeatedly).

Put the scratch file **inside a package** (so `@editor/*` resolves), e.g. `packages/stdlib/_scratch.mjs`, run it, then delete it:

```js
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createInterpreter, NIL, listToArray } from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '@editor/stdlib';

const lispDir = join(process.cwd(), 'lisp');          // from packages/stdlib
const captured = [];
const primitives = { ...createBufferPrimitives({ current: null }) };
primitives['show-status!'] = (a) => (captured.push(String(a[0] ?? '')), NIL);
// Stub the spine host primitives your command calls, capturing their args:
primitives['-emit-client-directive!'] = (a) => (captured.push({
  ids: listToArray(a[0] ?? NIL), name: String(a[1] ?? ''),
  args: listToArray(a[2] ?? NIL).map(String),
}), NIL);

const I = createInterpreter({ write: () => {}, primitives });
await loadStdlib(I, (n) => readFile(join(lispDir, n), 'utf8'),
  { listLanguageFiles: async () =>
      (await readdir(join(lispDir, 'languages'))).filter((n) => n.endsWith('.lisp')) });

// Paste the EXACT embedded Lisp here. Note: in spine.js a newline is written
// `\\n` (the JS template eats one level); in a String.raw`` literal here write
// `\n`. Backticks are forbidden in the spine template — keep them out here too.
I.evaluate(String.raw`(begin  /* your -helper + defcommand */  )`);

I.call('your-command', 'arg');     // or: I.call('handle-key', 'C-q') for a key
assert.deepEqual(captured.at(-1), /* expected */);
console.log('OK');
```

Run with `node _scratch.mjs` from the package dir; remove it after.

## Hand Jason a precise verification script

State: the launch command (if a server/lisp file changed → quit + relaunch; else → window reload), then the **exact** keystrokes and the **expected** observable result. Example: "Quit + relaunch. Press `C-h k` then `C-f` → a *Help* tab opens in the bottom dock with forward-char's docstring. Press `C-x` → echo only, no tab."

## Pointers

- Model + traps (escaping, SPINE_STDLIB membership, directive channel, FLAT args): `docs/MODEL-B-DISPATCH.md`
- Where everything lives: `docs/MAP.md`
- View/pane invariants: `docs/VIEWS.md`
