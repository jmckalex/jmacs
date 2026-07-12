# Lisp interpreter (packages/lisp) — audit

**Date:** 2026-07-01 · **Auditor:** agent 8/13 · **Branch:** main @ efe0fa6d · **Suite:** green (3290)

| Scope | Files | Lines |
|---|---|---|
| Value model / printer | `packages/lisp/src/values.js` | 397 |
| Reader | `packages/lisp/src/reader.js` | 278 |
| Evaluator / trampoline / special forms | `packages/lisp/src/eval.js` | 838 |
| Environments | `packages/lisp/src/environment.js` | 70 |
| Primitives | `packages/lisp/src/primitives.js` | 563 |
| Interpreter factory + prelude | `packages/lisp/src/interpreter.js` | 270 |
| Public entry | `packages/lisp/src/index.js` | 28 |
| Cross-reference | `apps/desktop/mwb/spine.js` (interpreter construction, `handleKey`, `deliverMinibuffer`/`deliverPicker`, `replEval`, `write-custom-file!`), `apps/desktop/mwb/server.js` (`applyIntent` error boundary), `packages/stdlib/lisp/commands.lisp` + `keymap.lisp` (dispatch), spec `docs/spec/lisp.md` | — |
| Tests skimmed | `packages/lisp/test/*` (10 files, 254 `test()` calls) | ~86 KB |

All claims marked CONFIRMED were traced in current code and, where feasible, demonstrated with `node -e` repros against `packages/lisp/src/index.js` (included below).

---

## Executive summary

The interpreter core is in good shape: the trampoline TCO is genuinely comprehensive (named let, mutual recursion, `and`/`or`/`cond`/`when`/`let*`/`letrec` bodies, `while`-inside-`try` all verified at 10⁶ iterations in constant stack), `try/finally` semantics are correct and well-tested, environments are clean, and error locations (B6) work. No P0: nothing found that crashes/freezes/corrupts under *normal* editing, and the server's per-intent `catch` keeps the process alive through everything I threw at it.

The bad news clusters in four places, worst first:

1. **The cooperative-interrupt machinery is built, tested — and never wired** (LISP-01). No caller of `setInterruptCheck`/`setStepBudget` exists outside `packages/lisp`. A `(while #t)` in any command or in `custom.lisp` freezes the single-threaded spine forever; C-g is itself a key resolved *by the frozen interpreter*, so every window dies until the process is killed. The eval.js comments describe the exact SharedArrayBuffer/Atomics wiring intended for Model B; it was never done.
2. **JS-recursive helpers have surprisingly low limits and fail with raw `RangeError`s that Lisp `try` cannot catch.** `equal?` overflows on two ~5,000-element lists (LISP-02) — that's `(equal? (string-split a "\n") (string-split b "\n"))` on a 5k-line file. The reader dies at ~3k nesting depth, the printer at ~5k head-depth. All escape as non-`LispError` JS exceptions, invisible to user code, silently swallowed at the intent boundary.
3. **`SPECIAL_FORMS` is a plain object literal, so all 12 `Object.prototype` names are phantom special forms** (LISP-03). `(toString)` evaluates to the string `"[object Undefined]"`, `(constructor …)` returns its own form unevaluated, the other ten throw raw `TypeError`s — and a user-*defined* function named `toString`/`valueOf`/`constructor` is silently uncallable.
4. **The writeString↔read round-trip — the port serialization format and the customize persistence format — is unfaithful at the edges** (LISP-04/08/09): `Infinity`/`NaN`/`-0` print as source that re-reads as *symbols* (and `(min)`, `(apply max nil)` produce Infinity trivially); symbols containing delimiters print unreadably; `nil` inside quoted *data* re-reads as a symbol; and the minibuffer delivery path quotes with `JSON.stringify`, whose escape grammar disagrees with the Lisp reader's, so control characters in a prompt reply are silently corrupted (`\f` → `f`).

Separately, a cross-territory but load-bearing finding: **a `LispError` thrown by a command during key dispatch never reaches the echo area** (LISP-05) — it is logged to the utilityProcess stderr and the user sees nothing.

---

## Findings

### LISP-01: The interrupt/step-budget machinery is never installed — a runaway Lisp loop freezes every window permanently

- **Severity:** P1
- **Dimension:** Security/robustness (resource exhaustion)
- **Location:** machinery `packages/lisp/src/eval.js:57–156` (`setInterruptCheck`, `setStepBudget`, `interruptPoint`); un-wired consumer `apps/desktop/mwb/spine.js:1113` (`createInterpreter({...})`); C-g is a mere command `packages/stdlib/lisp/keymap.lisp:372` (`defcommand keyboard-quit`)
- **Evidence:** `grep -rn "setInterruptCheck\|setStepBudget\|Atomics" apps/desktop --include='*.js'` (excluding tests) returns **zero hits**. The only callers are `packages/lisp/test/interrupt.test.js` and `createInterpreter` itself, which *resets both to the no-op defaults* (`interpreter.js:151–152`). The eval.js doc comments (`eval.js:84`, `interpreter.js:123–125`) describe the intended Model B wiring — `() => Atomics.load(sab, 0) !== 0` — as future work.
- **Failure scenario:** user writes `(while #t)` (or an accidentally non-terminating loop — a `dolist` over an improper structure, a search loop with a bad bound) in a command, in the REPL, or in `custom.lisp`. The spine is a single-threaded utilityProcess and *every keystroke in every window* resolves through `interpreter.call('handle-key', …)`; the evaluation never returns, the intent loop never runs again, C-g cannot be dispatched. Only remedy: kill the process (autosave mitigates data loss; the session does not survive gracefully). The trampoline check-point (`eval.js:207–208`) is already executing on every bounce — the abort would work today if anything installed a check.
- **Fix direction:** wire it. Minimum viable: a per-top-level `setStepBudget(N)` (e.g. 50–100M bounces ≈ seconds of wall time) installed by the spine at boot, so a runaway aborts with `LispInterrupt` and a status message even with no external signal. Full version per the eval.js comment: a `SharedArrayBuffer` flag set by the *main* process on a client's C-g (main can see the client message even while the spine is busy), polled via `Atomics.load` in the interrupt-check. Note two follow-ups: (a) LISP-13 — user `catch` swallows the interrupt; (b) long-running pure-JS *primitives* (`latex-scan`, `string-repeat`, huge `str` joins) never bounce the trampoline and remain un-interruptible regardless.
- **Confidence:** CONFIRMED (absence by exhaustive grep; blast radius traced through `server.js` `applyIntent` → `spine.handleKey` → `interpreter.call`).

### LISP-02: `equal?` overflows the JS stack on ~4–5k-element lists, throwing an uncatchable raw `RangeError`

- **Severity:** P1
- **Dimension:** Correctness / robustness
- **Location:** `packages/lisp/src/values.js:284–300` (`equal`), specifically line 287: `return equal(a.head, b.head) && equal(a.tail, b.tail);` — one JS frame per cons cell along the *spine* of the list
- **Evidence (repro):**
  ```
  node --input-type=module -e "
  import { createInterpreter } from './packages/lisp/src/index.js';
  const I = createInterpreter();
  console.log(I.evaluate('(equal? (range 2000) (range 2000))'));   // true
  I.evaluate('(equal? (range 5000) (range 5000))');                 // RangeError: Maximum call stack size exceeded
  "
  ```
  Also fails at 10k and 100k. `member` (primitives.js:233–241) iterates the outer list but calls `equal` per element, so it inherits the limit for element-wise deep comparisons.
- **Failure scenario:** any command comparing two modest lists — `(equal? (string-split (buffer-text) "\n") old-lines)` on a 5,000-line buffer is enough. The `RangeError` is not a `LispError`, so `(try … (catch e …))` does **not** catch it (`eval.js:764` deliberately rethrows non-LispErrors); it unwinds to `server.js:1085` and is logged to stderr. The user sees a command silently do nothing; if the command had already made edits, they are half-applied (Lisp `finally` clauses *do* still run — the JS `finally` at `eval.js:772` fires for any throw).
- **Fix direction:** make `equal` iterative over the tail (loop on `a = a.tail, b = b.tail` with recursion only into heads), exactly as `render` already does for printing (`values.js:337–343`). ~6 lines. Heads-deep structures would still recurse, but head-depth 5k is exotic where spine-length 5k is routine.
- **Confidence:** CONFIRMED (repro above).

### LISP-03: `SPECIAL_FORMS` inherits `Object.prototype` — 12 phantom special forms; user functions with those names are uncallable

- **Severity:** P1
- **Dimension:** Correctness (with a robustness edge: raw TypeErrors escape)
- **Location:** `packages/lisp/src/eval.js:503` (`const SPECIAL_FORMS = { … }` — a plain object literal) and `eval.js:252–254`:
  ```js
  const special = SPECIAL_FORMS[head.name];
  if (special !== undefined) { return special(form, env); }
  ```
- **Evidence (repro):**
  ```
  node --input-type=module -e "
  import { createInterpreter, writeString } from './packages/lisp/src/index.js';
  const I = createInterpreter();
  console.log(writeString(I.evaluate('(toString)')));                       // \"[object Undefined]\"
  console.log(writeString(I.evaluate('(constructor 1 2)')));                // (constructor 1 2)  — the form itself, unevaluated
  console.log(writeString(I.evaluate('(define (toString) 42) (toString)'))); // \"[object Undefined]\"  — user definition silently ignored
  I.evaluate('(__proto__)');                                                 // TypeError: special is not a function
  "
  ```
  Full behaviour census (all confirmed): `toString` → garbage string; `constructor` → returns the form (an accidental quote); `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `valueOf`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__` → raw `TypeError: Cannot convert undefined or null to object` (or similar); `__proto__` → `TypeError: special is not a function`. All the TypeErrors are non-LispErrors: uncatchable by Lisp `try`, swallowed silently at the intent boundary.
- **Failure scenario:** a user (or stdlib author) defines `(define (valueOf x) …)` — a perfectly natural name in a JS-flavoured editor — and every call site silently misbehaves; the definition *succeeds* (`define` is a real special form), only calls break, which makes it maddening to debug. The lookup happens *before* the environment check (`eval.js:252` vs `eval.js:256`), so no binding can ever win.
- **Fix direction:** one line: build the table with a null prototype — `const SPECIAL_FORMS = Object.assign(Object.create(null), {...})` — or use a `Map`, or guard with `Object.hasOwn(SPECIAL_FORMS, head.name)` (the codebase already uses `Object.hasOwn` in the reader, reader.js:218).
- **Confidence:** CONFIRMED (repros above).

### LISP-04: Number printing is not read-faithful — `Infinity`/`NaN` become *symbols* on re-read, `-0` becomes `0`; ordinary primitives produce them

- **Severity:** P1
- **Dimension:** Correctness — the writeString↔read port/persistence format
- **Location:** printer `packages/lisp/src/values.js:329` (`if (typeof value === 'number') return String(value);`); reader `packages/lisp/src/reader.js:26` (`NUMBER_RE` matches neither `Infinity` nor `NaN`); producers `packages/lisp/src/primitives.js:127–128` (`(min)` → `Math.min()` = `Infinity`, `(max)` → `-Infinity`), `:131` (`expt` unguarded), `:96–97` (`+`/`*` overflow)
- **Evidence (repro):**
  ```
  node --input-type=module -e "
  import { createInterpreter, writeString, read } from './packages/lisp/src/index.js';
  const I = createInterpreter();
  const v = I.evaluate('(* 1e308 10)');            // Infinity
  const s = writeString(v);                        // 'Infinity'
  console.log(s, read(s)[0].constructor.name);     // Infinity Sym   <-- a SYMBOL
  console.log(writeString(I.evaluate('(min)')));   // Infinity
  console.log(writeString(I.evaluate('(- 0)')));   // 0   (-0 lost)
  "
  ```
  Finite floats are fine — `String(0.1)` is V8's shortest round-trip form and `NUMBER_RE` accepts `1e+21`-style exponents, so `0.1`, `1e-7`, huge finite doubles all survive. `1e400` *in source* silently reads as `Infinity` (reader → `Number(token)`), which then can't round-trip back.
- **Failure scenario:** the concrete amplifier is persistence: `write-custom-file!` (`apps/desktop/mwb/spine.js:1888–1897`) serializes every saved customize value as `(custom-set-saved! (quote NAME) (quote VALUE))` using `writeString`, into `~/.godot/custom.lisp`, which the spine evaluates at every boot (`spine.js:2737–2742`). A numeric setting that ever becomes `Infinity` (e.g. computed as `(apply min candidate-list)` over an *empty* list — `Math.min()` of nothing) persists as `(quote Infinity)` and boots back as the *symbol* `Infinity`; every numeric consumer of that defcustom then misbehaves. The same infidelity applies to any value crossing the client↔server port as writeString source (the architecture's stated serialization rule).
- **Fix direction:** print non-finite numbers as evaluable forms or dedicated literals the reader knows — e.g. emit `(/ 1 0)`-style is ugly; better: teach the printer `+inf`/`-inf`/`nan` tokens and the reader to recognise them (2 lines each side), or refuse: make `writeString` throw a `LispError` on non-finite numbers so the corruption is loud at write time. Guard `(min)`/`(max)` with `arity(…, 1, Infinity)`.
- **Confidence:** CONFIRMED (repros above; persistence path traced).

### LISP-05: A command error during key dispatch never reaches the user — logged to server stderr only

- **Severity:** P1 (cross-territory: the fix likely lands in `server.js`/`keymap.lisp`, flagged per the territory rule)
- **Dimension:** Error propagation / architecture
- **Location:** throw path: `packages/stdlib/lisp/commands.lisp:129–140` (`run-command` — no `try`), `packages/stdlib/lisp/keymap.lisp:445–457` (dispatch — no `try`), `apps/desktop/mwb/spine.js:5455–5487` (`handleKey` — no catch), terminating at `apps/desktop/mwb/server.js:1085–1087`:
  ```js
  } catch (error) {
    console.error(`[mwb-server] intent error: ${error.message}`);
  }
  ```
- **Evidence:** traced end-to-end; there is no `try` anywhere on the dispatch path and the intent boundary's catch does not call `onStatus`/`sendStatusTo`. Compare the paths that *do* surface errors: `replEval` (`spine.js:5813–5820`) and `inlineEvalForm` (`spine.js:4076–4084`) both catch and report `error.lispMessage`.
- **Failure scenario:** any command that signals — `(error "this command needs an active region")` from `-region-bounds` (`commands.lisp:78–83`) when a region command runs without a mark, an unbound-symbol error from a typo'd `init`-style binding, an arity error in user Lisp — produces *no visible feedback*. The command appears to be a dead key. Half-applied edits (a command that inserted, then threw) stay applied with no message. This also pre-swallows a future wired `LispInterrupt` (LISP-01): the "quit" would be equally invisible.
- **Fix direction:** in `applyIntent`'s catch, distinguish `error.lispMessage != null` (a Lisp-level error) and route it to the active client's echo area (`sendStatusTo(client, …)` with the `:line/:column` from `error.location` when present), keeping the stderr log for raw JS errors. Alternatively (Lisp-side) wrap the `run-command` call in `keymap.lisp` with `(try … (catch e (show-status! (get e :message))))` — but that would also swallow interrupts once wired, so the JS boundary is the better seam.
- **Confidence:** CONFIRMED (traced; not live-tested in the running app).

### LISP-06: Reader recursion overflows at ~2–4k nesting depth — raw `RangeError` from user-reachable inputs

- **Severity:** P2
- **Dimension:** Security/robustness (hostile/degenerate input)
- **Location:** `packages/lisp/src/reader.js:96–128` (`readForm`) ↔ `:149–199` (`readSequence`) mutual recursion, one level per bracket depth
- **Evidence (repro):** `read('('.repeat(4000) + ')'.repeat(4000))` → `RangeError: Maximum call stack size exceeded`; depth 2000 is fine. (Node default stack; the spine's utilityProcess will be in the same range.)
- **Failure scenario / exposure map (where `read` meets non-config input at runtime):**
  | Entry | Input | Guarded? |
  |---|---|---|
  | `replEval` (`spine.js:5813`) | REPL line | ✅ catch-all, error text returned |
  | `inlineEvalForm` (`spine.js:4076`) | **arbitrary buffer text** slice (C-x C-e) | ✅ catch-all |
  | `read-string` primitive (`primitives.js:389–392`) | **arbitrary buffer text** (notebook-cells engine) | ⚠️ `RangeError` is not a `LispError` → the calling Lisp's `try` cannot catch it; escapes to the intent boundary, silent failure |
  | `custom.lisp` boot load (`spine.js:2737–2742`) | user file | ✅ try/catch — but failure = *all* customizations silently skipped (see LISP-09) |
  | `deliverMinibuffer`/`deliverPicker` (`spine.js:5626, 5663`) | user prompt reply, JSON-quoted | ✅ inside `applyIntent`'s catch (but see LISP-08) |
  | `evaluate`/`call` throughout spine | trusted stdlib + spliced fragments | intent-boundary catch |
  So a paren-bomb in a buffer under notebook-cells mode, or pasted into the REPL, degrades to a silent no-op rather than a crash — acceptable-ish, but invisible, and `read-string`'s failure mode is uncatchable *from Lisp*, which the notebook engine can't defend against.
- **Fix direction:** an explicit depth counter in `Reader` (increment in `readSequence`, throw `LispError('nesting too deep (limit N)')` at, say, 500) makes hostile input a *clean, catchable* Lisp error and documents the limit. Same trick fixes the printer (LISP-07).
- **Confidence:** CONFIRMED (repro; exposure traced).

### LISP-07: Printer (`writeString`/`displayString`) recursion overflows at ~5k head-depth; no cycle guard

- **Severity:** P2
- **Dimension:** Robustness — and this is the port serializer
- **Location:** `packages/lisp/src/values.js:325–359` (`render`): iterative along list *tails* (good) but recursive into heads, vector elements, and map keys/values
- **Evidence (repro):** `writeString` of `(reduce (lambda (a x) (list a)) nil (range 5000))` (a 5,000-deep head-nested list) → `RangeError`. Long flat lists (10⁶ elements) print fine.
- **Failure scenario:** a deeply nested structure built by accumulation reaches `writeString` in `replEval`, `write-custom-file!`, or the inline-eval pill → raw RangeError at the *serialization* step. Guarded at those call sites, but again invisible and uncatchable from Lisp. Cycles: pure Lisp cannot build one (`Pair`s and vectors are frozen; `assoc`/`dissoc` copy), but a *host primitive* returning a self-referential `Map` (maps are not frozen, `m.set(k, m)` is one line of host code away) gives `render` unbounded recursion → RangeError; a cyclic *tail* chain (impossible today, but nothing asserts it) would be an infinite `while` loop — a true hang. Defensively absent rather than safe.
- **Fix direction:** depth counter in `render` (throw `LispError` past N); optionally a `WeakSet` of in-progress containers to print `#<cycle>` instead of dying. Cheap, and makes the load-bearing serializer total.
- **Confidence:** CONFIRMED (repro; cycle path is PLAUSIBLE, unreachable from pure Lisp today).

### LISP-08: Minibuffer/picker replies are quoted with `JSON.stringify` but parsed by the Lisp reader — control characters are silently corrupted

- **Severity:** P2
- **Dimension:** Correctness (data corruption on a real input path)
- **Location:** `apps/desktop/mwb/spine.js:5626–5631` (`deliverMinibuffer`: `` `(minibuffer-delivered ${JSON.stringify(String(value))})` ``), `:5663–5668` (`deliverPicker`); reader escape table `packages/lisp/src/reader.js:217–218` — only `n t r 0 \ "` are known; **any other escape yields the escaped character itself** (`\f` → `f`, `` → `u0008`)
- **Evidence (repro):**
  ```
  node --input-type=module -e "
  import { read } from './packages/lisp/src/index.js';
  const FF = String.fromCharCode(12), SOH = String.fromCharCode(1);
  console.log(JSON.stringify(read(JSON.stringify('a'+FF+'b'))[0]));   // \"afb\"    — form feed DELETED
  console.log(JSON.stringify(read(JSON.stringify('a'+SOH+'b'))[0]));  // \"au0001b\" — garbage INSERTED
  "
  ```
  (JSON emits `"a\fb"` and `"ab"`; the Lisp reader doesn't speak `\f` or `\uXXXX`.)
- **Failure scenario:** paste text containing a form feed / vertical tab / any C0 control into a `replace-string` or search prompt → the delivered string differs silently from what was typed; the replacement inserts corrupted text. Low frequency, real corruption. (`\n`, `\t`, `\r`, `"` and `\` are the overlap of the two grammars and are fine; ` / ` pass raw and are fine.)
- **Fix direction:** stop translating grammars: quote with the Lisp printer's own `escapeString` (export a `writeString`-for-strings from `@editor/lisp`, which the spine already imports) instead of `JSON.stringify`. Alternatively teach the reader `\uXXXX` and the JSON single-char escapes (`\b \f \v /`) — but printer-quoting is the principled fix (one grammar, owned by the interpreter).
- **Confidence:** CONFIRMED (repro).

### LISP-09: Symbol/keyword/nil data round-trips are unfaithful; one bad persisted value poisons all of `custom.lisp`

- **Severity:** P2
- **Dimension:** Correctness — port/persistence format
- **Location:** printer `packages/lisp/src/values.js:333–334` (symbols/keywords print as raw names — no `|…|` escape syntax exists); `values.js:326` (`NIL` prints as `nil`, but the reader has no nil literal — `nil` reads as a *symbol*); producers `primitives.js:397` (`string->symbol` accepts any string), `:403` (`string->keyword`); consumer `spine.js:1888–1897` (`write-custom-file!`) + `spine.js:2737–2742` (boot load, one try/catch around the whole file)
- **Evidence (repros, all confirmed):**
  - `(string->symbol "foo bar")` prints `foo bar` → re-reads as **two** symbols.
  - `(string->symbol "")` prints as the empty string → re-reads as **zero** forms.
  - `(string->symbol "42")` prints `42` → re-reads as a **number**.
  - `(string->symbol "a\"b")` / `"a(b"` / `"a;b"` print source that **throws** on re-read (unclosed string / unclosed paren / rest-of-line eaten as a comment).
  - `(string->symbol ".")` inside a list prints `(.)` → re-read error (`unexpected ')'`).
  - `(list 1 nil 2)` prints `(1 nil 2)` → re-reads as `Number, `**`Sym`**`, Number` — faithful only after *evaluation* (the global `nil` binding), not as data. Any `(quote …)`-wrapped structure containing nil changes type across the port.
  - A `Lambda` in a serialized structure prints `#<procedure f>` → re-read throws `unknown # syntax`.
- **Failure scenario:** the sharp end is `write-custom-file!`: one customize value containing any of the above (a symbol minted from user text via `string->symbol`, a structure containing a procedure) produces a `custom.lisp` that fails to parse at the *next boot* — and because the boot load wraps the **whole file** in one try/catch, **every** customization (theme included) is silently dropped for that session, with only a stderr line. Same class of infidelity applies to anything sent over the port as writeString source.
- **Fix direction:** (a) make `writeString` refuse or escape unreadable atoms — either a `|foo bar|` pipe syntax in printer+reader, or `LispError` on symbols that fail a round-trip regex (`^[^\s()\[\]{}"';,`#][^\s()\[\]{}"';,`]*$`-ish) and on procedures; (b) make the `custom.lisp` boot load per-form (read all, evaluate each in its own try) so one bad value costs one setting, not all of them; (c) consider a real `nil` reader literal to close the data/eval gap.
- **Confidence:** CONFIRMED (all repros above; boot path traced).

### LISP-10: Degenerate special-form uses leak raw JS `undefined` into Lisp values

- **Severity:** P2
- **Dimension:** Correctness
- **Location:** `packages/lisp/src/eval.js:504–506` (`quote(form) { return form.tail.head; }` — `(quote)` has `form.tail === NIL`, and `NIL.head` is `undefined`); `:508–510` (`(quasiquote)` same shape); `:627–632` (`let` binding destructure: `(let ((x)) …)` gives `valueForm === undefined`, and `evaluate(undefined, env)` returns `undefined` via the self-evaluating fall-through at `:237`)
- **Evidence (repro):** `typeof I.evaluate('(quote)')` → `"undefined"`; `typeof I.evaluate('(let ((x)) x)')` → `"undefined"`. `writeString(undefined)` → the string `undefined` (via `String(value)` fall-through, values.js:358), which re-reads as a symbol.
- **Failure scenario:** `undefined` is outside the value model: `typeName` calls it `value`, `isTruthy` calls it true, `equal?` compares it by identity, host primitives receiving it can raw-TypeError. The `?? NIL` guard at the *primitive* boundary (`eval.js:310`) shows the invariant is intended — "Lisp never sees a raw JS null/undefined" — but special forms bypass it. Reachable only from malformed source (typos, macro bugs), which is exactly when you want a clean error, not a poisoned value.
- **Fix direction:** arity-check `quote`/`quasiquote` (`form.tail instanceof Pair` else `LispError`), and validate `let` bindings are 2-lists. Three small guards.
- **Confidence:** CONFIRMED (repros).

### LISP-11: Map keys use JS identity (SameValueZero) — compound keys never match; drift from the Clojure-style data story

- **Severity:** P2
- **Dimension:** Correctness / spec drift
- **Location:** map literal construction `packages/lisp/src/reader.js:186–194` (`new Map()`/`map.set`), `get` `packages/lisp/src/primitives.js:447–455` (`a[0].has(a[1])`), `assoc`/`dissoc`/`contains?` likewise; `equal` exists (values.js:284) but is never used for keys
- **Evidence (repro):** `(get {[1 2] :hit} [1 2])` → `#f`. The literal's key and the query key are distinct frozen arrays; `Map.has` is identity. Strings/numbers/booleans work (SameValueZero); interned symbols/keywords work (identity = equality); vectors, lists and maps as keys silently never match — even within a single expression, and *a fortiori* across a writeString round-trip (re-read allocates fresh objects).
- **Failure scenario:** any user or stdlib code keying a map by a pair/vector (a natural move in a Clojure-literate dialect — `{[line col] mark}`) gets 100% misses with no error. The spec (§1, §2) sells the map literal as Clojure-influenced; Clojure maps hash structurally.
- **Fix direction:** either document loudly in `docs/spec/lisp.md` ("map keys compare by identity; use strings/numbers/symbols/keywords") — the cheap, honest fix — or implement structural keying (canonical-key stringification via `writeString`, or an equal-based probe on miss). Given `equal`'s own recursion issue (LISP-02), documentation now, structural keys later.
- **Confidence:** CONFIRMED (repro).

### LISP-12: `gensym` returns *uninterned* `Sym`s — breaking the "equal symbols are identical" invariant and the port round-trip

- **Severity:** P2
- **Dimension:** Correctness / architecture
- **Location:** `packages/lisp/src/primitives.js:485–489`: `return new Sym(\`${prefix}__${gensymCounter}\`)` — bypasses `sym()` interning (values.js:39–46)
- **Evidence (repro):** `(eq? g (string->symbol (symbol->string g)))` → `#f` for `g` a gensym. Worse, `equal?` is *also* `#f` (equal falls through to `===` for Syms), so two symbols with the *same name* are neither eq? nor equal?, yet print identically — `(a__2 a__3)` from two gensyms is indistinguishable from interned symbols in output, and re-reading interns them, silently changing identity across the port.
- **Failure scenario:** in practice the macro-hygiene use survives because *environment bindings key on the name string* (environment.js `Map<string,*>`), not on symbol identity — the prelude's `while`/`dotimes`/`dolist` gensyms work because their counter-suffixed *names* are unique. But any code doing symbol-identity bookkeeping (`(member g list-of-syms)` with `eq?` semantics, symbols as map keys — identity per LISP-11) gets phantom mismatches; and a data structure containing a gensym does not round-trip to an `eq?`-equal structure.
- **Fix direction:** intern gensyms too (`return sym(\`${prefix}__${gensymCounter}\`)`) — uniqueness already comes from the monotonic counter, not from object identity; uninterned-ness buys nothing here and violates the stated invariant (spec §2 "Interned: equal symbols are identical", values.js:23).
- **Confidence:** CONFIRMED (repro).

### LISP-13: A user `catch` swallows `LispInterrupt` — quit will be defeatable once wired

- **Severity:** P2 (latent until LISP-01 is fixed, then immediately relevant)
- **Dimension:** Robustness / architecture
- **Location:** `packages/lisp/src/values.js:246–254` (`LispInterrupt extends LispError` — deliberately, per the comment); `eval.js:758–771` (`try`'s catch tests `error instanceof LispError`, so interrupts are caught like any error)
- **Evidence (repro):** with `setStepBudget(50000)`: `(try (while #t) (catch e (get e :message)))` → returns `"step budget exceeded (50000 steps)"` — the interrupt was consumed by user code. (The package's own interrupt.test.js asserts this as a feature: "unwinds cleanly through … a Lisp catch".)
- **Failure scenario:** any defensive `(try (main-loop) (catch e (retry)))` wrapper — a completely reasonable pattern — turns C-g into a no-op and re-enters the loop: the freeze becomes un-abortable *even with LISP-01 fixed*.
- **Fix direction:** Emacs's answer is that quit is only *deferrable*, not consumable. Cheapest faithful version: `try`'s catch clause re-checks `error instanceof LispInterrupt` and rethrows after running `finally` (cleanup still runs; handlers don't see quits), with an explicit `(catch-interrupt …)` escape hatch if ever needed. Decide before wiring LISP-01.
- **Confidence:** CONFIRMED (repro; the design intent is explicit in comments, so this is a *disagree-with-the-design* finding, flagged for the architect).

### LISP-14: Primitive argument-validation gaps — silent wrong answers and raw JS errors

- **Severity:** P3 (class)
- **Dimension:** Correctness / robustness
- **Location + evidence (each confirmed by repro or trace):**
  - `(min)` / `(max)` → `Infinity` / `-Infinity` (primitives.js:127–128, no arity check) — feeds LISP-04.
  - `(apply min (range 200000))` → **raw `RangeError`** (spread `Math.min(...a)` argument-count limit ~125k).
  - `(nth '(1 2 3) 1.5)` / `(vector-ref [1 2 3] 1.5)` and NaN indexes → the bounds test `i < 0 || i >= len` is false for NaN/fractions → `items[1.5]` is `undefined` → **silently coerced to `nil`** by the `?? NIL` boundary (eval.js:310). Wrong answer, no error; `(/ 3 2)` = `1.5` makes fractional indexes routine. `num()` (primitives.js:52) should reject non-integers where an index is meant.
  - `(nil?)` → `#f`, `(eq?)` → `#t` (no arity checks; `undefined === undefined`).
  - `(string-repeat "xy" 1000000000)` → **raw `RangeError: Invalid string length`**; the `n | 0` clamp (primitives.js:359) also silently wraps `2^31`-plus counts.
  - `(string->number "")` → `0`, `(string->number "0x10")` → `16` (JS `Number` semantics; spec-silent).
- **Failure scenario:** the raw RangeErrors are uncatchable in Lisp (per LISP-02's mechanism); the silent-nil index reads corrupt logic quietly.
- **Fix direction:** an `intIndex(name, v)` helper (finite, integer, else LispError); arity guards on the zero-arg predicates and min/max; loop instead of spread for min/max over arrays; validate `string-repeat`'s count against a sane ceiling.
- **Confidence:** CONFIRMED (repros).

### LISP-15: Lisp source is assembled by string splicing at several host seams — unquoted interpolation

- **Severity:** P3
- **Dimension:** Robustness (the clients are same-app renderers, so not a trust-boundary break today)
- **Location:** `spine.js:5493–5495` (`runCommand`: `` `(run-command (quote ${name}))` `` — `name` arrives from the client `RUN_COMMAND` intent as an arbitrary string); `spine.js:2888–2898` (`applyCustomizeChange`: `name` and `valueSrc` off the wire, spliced raw into `(custom-apply! (quote ${name}) (quote ${valueSrc}))`)
- **Evidence:** a `name` containing `) (…) (quote x` evaluates attacker-chosen forms in the spine. Callers are the app's own menus/customize UI, so exploitation requires a compromised renderer — but the renderer hosts `<webview>` content (browser-view), so the spine should not extend it blind textual trust.
- **Fix direction:** validate `name` against the command registry / defcustom registry before splicing (the registry lookup already exists — `commandNames()`), or pass values via `interpreter.call` with real arguments instead of source assembly.
- **Confidence:** CONFIRMED (code trace; exploitability PLAUSIBLE only via a compromised client).

### LISP-16: Macro uses are re-expanded on every evaluation — no expansion cache on the keystroke path

- **Severity:** P3
- **Dimension:** Architecture / performance
- **Location:** `packages/lisp/src/eval.js:256–268`: a macro head is looked up and its transformer *applied* each time the form is evaluated. A `(when …)` inside a `while` body runs the `when` transformer (a full Lambda application plus list construction) on **every loop iteration**; every `handle-key` dispatch re-expands every macro use it passes through.
- **Evidence:** code shape (no memoization; `TailCall(expanded, env)` discards the expansion immediately). Correctness is unaffected — this is why redefining a macro takes effect instantly, which the hot-reload story may *want*.
- **Fix direction:** if dispatch latency ever matters: cache expansion per `(form, macro-identity)` in a WeakMap, invalidated when the macro binding changes; or accept the cost and note it in the spec (macro redefinition semantics are currently *late-bound*, which should be a documented feature, not an accident).
- **Confidence:** CONFIRMED (trace).

### LISP-17: `module` reload clears the module environment before evaluating the new body — an error mid-reload guts the module

- **Severity:** P3 (the module system is unused in production — zero `(module …)` forms in `packages/stdlib/lisp/`)
- **Dimension:** Correctness (hot-reload path)
- **Location:** `packages/lisp/src/eval.js:810–817`: `moduleEnv.vars.clear();` then `for (const f of body) evaluate(f, moduleEnv);` — a throw partway leaves the registry pointing at a half-empty environment; closures resolving through it start throwing `unbound symbol`.
- **Fix direction:** evaluate into a fresh child, swap on success (or snapshot `vars` and restore on throw).
- **Confidence:** CONFIRMED (trace); impact PLAUSIBLE-only while modules stay unused.

### LISP-18: Interpreter state is module-global — a second `createInterpreter` silently clears the first's interrupt/budget; `eval`'s reader errors skip location tagging

- **Severity:** P3
- **Dimension:** Architecture
- **Location:** `packages/lisp/src/eval.js:87–99` (`interruptCheck`/`stepBudget`/`stepCount`/`currentLocation` are module lets); `interpreter.js:151–152` resets them in *every* `createInterpreter` call — deliberate ("a deployment has one shared interpreter") but it means any in-process second instance (tests do this constantly; a future embedded interpreter would too) disarms the spine's watchdog the moment it's constructed. Also `interpreter.js:230` — `read(source)` sits *outside* the try in `evaluate`, so reader `LispError`s skip `attachErrorLocation` (they carry line:col in the message text only, not in `error.location`).
- **Fix direction:** move the interrupt/budget/location state onto the interpreter instance (threaded via the env root, like `modules`), or at least stop resetting globals in the factory.
- **Confidence:** CONFIRMED (trace).

### LISP-19: `print`/`display` output is discarded in the spine

- **Severity:** P3 (cross-territory UX seam)
- **Dimension:** Architecture
- **Location:** `apps/desktop/mwb/spine.js:1114` — `write: () => {}`. `(print "x")` from the REPL or any command produces nothing anywhere; the REPL shows only the return value (`replEval` returns `writeString(result)` alone).
- **Fix direction:** buffer writes during `replEval` and return them with the result; route stray writes to the echo area or a `*Messages*`-style log.
- **Confidence:** CONFIRMED (trace).

---

## Spec conformance

Code vs `docs/spec/lisp.md`, both directions:

| § | Spec says | Code does | Verdict |
|---|---|---|---|
| §2 | Escapes `\n \t \r \0 \\ \"` | Reader also accepts **any** unknown escape as the raw escaped char (`\f`→`f`, `\q`→`q`) — reader.js:217–218 | Undocumented lenience; it is the mechanism behind LISP-08. Spec should state unknown-escape behaviour (better: reject). |
| §2 | Symbols "any token that is not a number… Interned: equal symbols are identical" | `gensym` mints **uninterned** Syms (LISP-12); `string->symbol` can mint unprintable symbols (LISP-09) | Drift both ways. |
| §2 | Numbers: integers/floats, optional sign/exponent | `1e400` reads as `Infinity` silently; `Infinity`/`NaN` print as symbol-shaped source (LISP-04) | Spec silent on non-finite numbers; the format is lossy. |
| §3 | "Vector or map evaluates its elements" | Matches (eval.js:225–234); evaluated vectors are frozen, evaluated maps are **not** frozen | Matches §1's frozen list (maps excluded) — OK, worth an explicit sentence. |
| §4 | "Special-form names… not shadowable in v0" | True for the 17 real ones; **plus 12 accidental `Object.prototype` phantoms** (LISP-03) | Violation (of spirit). |
| §4 | `(cond (else))` — table doesn't cover a bare else clause | Tail-evaluates the *symbol* `else` (eval.js:663–668, "documented behaviour" per comment) | Documented only in a code comment, not the spec. |
| §5 | Macros procedural, non-hygienic; `gensym` for temporaries | Matches; prelude dogfoods it. Macro *lookup* is late-bound and re-expands per use (LISP-16) — spec silent on redefinition semantics | Document late binding (it's load-bearing for hot reload). |
| §6 | Module hot reload "reuses the environment (clearing it first)" | Matches, including the clear-then-fail gutting hazard (LISP-17). No `(module …)` exists in the shipped stdlib | Spec oversells the feature's exercise. |
| §7 | `catch` binds a condition map `:message :irritants :line :column`; finally on every exit incl. raw JS exceptions | Matches exactly (eval.js:712–781; verified by error-and-macro.test.js) | ✅ Conforms. Note: only `LispError`s are catchable — raw JS errors (incl. all RangeErrors in this report) are *not*, which §7 implies but should state plainly. |
| §9 | "Each primitive receives an array of evaluated arguments"; lists↔arrays, vectors=arrays, maps=Maps | Matches; plus the undocumented `undefined/null → nil` coercion at the primitive boundary (eval.js:307–310) | Document the coercion (it silently repairs LISP-14's index reads). |
| §10 | "~80 primitives" | ~110 `def(…)` calls plus `eval`/`macroexpand-1`/`macroexpand` in the factory | Stale count; harmless. |
| §10 | Miss convention: absence `#f`, emptiness `nil` | Primitives audited comply (`get`, `doc`, `where-defined`, `member` → `#f`; `first`/`rest`/`last` → `nil`) | ✅ Conforms. |
| §11 | `doc`/`where-defined`/`describe` | Match, including `describe`'s `:doc nil` *inside* the record per the convention | ✅ Conforms. |
| §3/§4 | TCO: trampoline; named let and prelude loops iterate indefinitely | Verified at 10⁶ iterations: named let, mutual recursion, `and`/`or`/`cond`/`when`/`begin`/`let*`/`letrec` tails, `while`/`dotimes`/`dolist`, `while` *inside* `try` | ✅ Conforms — impressively so. |
| §3 | "Deep non-tail recursion… can still exhaust the stack" | True; measured ~4k–10k frames; **and it surfaces as an uncatchable raw RangeError**, which the spec doesn't say | Add: non-tail overflow is not a `LispError`. |
| §2 | "Planned: positions on atoms" | Confirmed: only `Pair`s carry positions (`sourceLocations` WeakMap) | As declared. |

---

## Architecture observations

- **The writeString-source-over-port convention is forced by structuredClone, and the printer wasn't hardened for the job it inherited.** `Sym`/`Keyword`/`Pair` are class instances with a frozen shape; structuredClone strips the prototypes (hence the memory note "symbols get mangled"). The chosen fix — serialize via `writeString`, re-read/evaluate on the far side — quietly promoted a REPL pretty-printer into a wire format. Everything in LISP-04/07/09 follows from that promotion: no non-finite-number syntax, no symbol escaping, no cycle/depth guards, `nil` prints as a token that only *evaluates* (not reads) back to NIL, and procedures print as unreadable `#<…>`. A deliberate `writeData`/`readData` pair (a strict, total, documented subset) would let the port and `custom.lisp` refuse unserializable values loudly instead of corrupting quietly.
- **Two error taxonomies cross the same boundary.** Everything user-visible hinges on `error instanceof LispError`: Lisp `try` catches only those; the spine's guarded call sites report `lispMessage`; everything else (RangeError from depth, TypeError from LISP-03, string-length RangeError) is a second, invisible class that only ever reaches stderr. Since several of those raw errors are *provoked by ordinary Lisp* (`equal?` on a 5k list), the taxonomy leaks. Either convert at the eval boundary (catch RangeError in `interpreter.evaluate`/`call`, rethrow as `LispError('stack exhausted')` — with care, since the stack is scarce right then) or eliminate the provokers (iterative `equal`, depth-limited reader/printer).
- **The interrupt design is right and dark** (LISP-01). Cooperative check every 4096 bounces, `LispInterrupt` distinguishable by flag, per-top-level budget reset (`interpreter.js:234–236, 254`), tested for cleanup-through-finally. The remaining design decision — should user `catch` consume a quit (LISP-13) — should be settled *before* wiring, or the wiring will ship with an escape hatch open.
- **Command/primitive single namespace, mechanically:** primitives live in the `base` frame, all stdlib/user code (including every `defcommand`'s `define`) in the `global` child frame (`interpreter.js:158–164`); `Environment.lookup` walks child→parent, so a same-named command shadows a primitive for **all** callers, silently (`environment.js:36–41`). `keyboard-quit` is defined three times across `keymap.lisp`/`multi-cursor.lisp`/`snippets-keymap.lisp` — last-load-wins is the (fragile, load-order-dependent) mechanism. Macros, unlike special forms, *are* shadowable by local bindings (`env.has` gates the macro check, eval.js:256).
- **Suspended-command "continuations" are just stored closures — reentrancy is safe but single-slot.** `minibuffer-read` parks the rest of the command in `*minibuffer-reader*` (commands.lisp:63–75) and *returns*; no JS stack is held, so `interpreter.call` during a "suspension" is harmless (fresh trampoline, shared-but-monotonic `stepCount`). The hazards are the single slots: a second prompt opened before the first resolves (possible with two windows interleaving intents) silently drops the first continuation — the first command just never finishes; `deliverMinibuffer` clears the slot *before* invoking the reader (commands.lisp:73–75) and closes the prompt before evaluating (spine.js:5623–5631), so an error mid-continuation cannot wedge the prompt state. `abortMinibuffer` (spine.js:5678) nils the reader explicitly. This part is sound.
- **The reader maps escapes at read time** (per the known-context note) and the printer re-escapes — the asymmetry is that the printer escapes only `" \\ \n \t \r` (values.js:305–316) while the reader additionally knows `\0` and forgives everything else. A NUL round-trips *raw* — correct over the port, but a NUL inside a persisted customize string writes a raw 0x00 into `custom.lisp`, tripping the project's own known "NUL makes files binary" trap for git/grep.
- **Dead/dark code:** the module system (`module`/`import`, 2 test files, ~230 lines of eval.js) has no production user; `setInterruptCheck`/`setStepBudget` likewise. Both are good code waiting for callers — worth either wiring or noting as dormant in MAP/spec so future agents don't assume they're exercised.

---

## Test coverage

254 `test()` calls across 10 files; assertion quality is high — behavioural, specific, well-named, with real negative tests (arity errors assert *which* form the location points at; sort asserts stability and input-non-mutation; named-let tests cover init-scoping, non-leakage, and constant-stack at 10⁵–10⁶ iterations; try/finally covers all eight exit paths including raw-JS-exception passthrough and handler re-raise). interrupt.test.js is thorough on the machinery (16 tests: abort, budget, cleanup-through-finally, reusability, no-spurious-fires).

What's **not** covered (gaps that map 1:1 onto this report's findings):

- No round-trip property tests for `writeString↔read` — nothing would have caught LISP-04/09 (non-finite numbers, hostile symbols, nil-as-data).
- No hostile-input reader tests: depth bombs, enormous atoms, unknown escapes' exact behaviour, NUL handling.
- No stack-depth tests for the JS-recursive helpers (`equal`, `render`, reader) — LISP-02/06/07.
- No test evaluates a form whose head is an `Object.prototype` name — LISP-03.
- Arity-gap primitives (`(min)`, `(eq?)`, fractional `nth`) untested.
- The `?? NIL` primitive-boundary coercion is untested directly.
- Nothing exercises two interpreters in one process interacting with the shared eval.js module state (LISP-18) — tests *create* many interpreters but serially, which is why the factory's global reset never bit.
- Cross-boundary behaviour (what escapes `interpreter.call`, the JSON-quoting seam) lives in spine/server tests, outside this package — the JSON↔reader mismatch (LISP-08) falls between the two suites.

The known project caveat applies in reverse here: packages/lisp tests run the *real* interpreter (no stubs), so green means more than in the app packages. A small `roundtrip.test.js` (property-style: for a corpus of values, `read(writeString(v))` equals `v` or throws *cleanly*) would lock the port format down.

---

## What's solid

- **TCO/trampoline:** genuinely complete across every tail-position form; mutual recursion and named let verified at 10⁶ frames-worth in constant stack; `TailCall` provably cannot leak (bounced in `evaluate`, `applyProcedure` re-bounces for host callers); `try` correctly forces eager bodies so no TailCall escapes a live JS frame — and loops *inside* a try body still trampoline (verified).
- **try/catch/finally:** correct on every exit path; finally runs even for raw JS exceptions; condition maps carry message/irritants/line/column; the innermost-location-wins tagging (`attachErrorLocation` + `currentLocation` re-stamping around macro expansion and argument evaluation, eval.js:262–277) is careful, subtle, and tested.
- **Environments:** minimal and correct; `define` vs `set!` semantics exactly as spec'd (`set!` on unbound throws); closure capture per-iteration in `dotimes`/`dolist` verified by macro structure (fresh frames).
- **The `?? NIL` host boundary** (eval.js:310) — a one-character guard that stopped three of my attempted `undefined`-leak repros dead.
- **`macroexpand` has a 1000-step self-expansion cap** (interpreter.js:207–213) — someone thought about the hang.
- **The reader's error messages** carry line:col and open-bracket provenance ("unclosed '(' opened at 1:2"); dotted-pair handling (`isDotMarker`, `.5`/`...`-as-atoms) is careful.
- **Prelude loop macros** are textbook: gensym'd loop names, count/list evaluated exactly once (tested), tail self-calls.
- **String escape round-trip for the printable + `\n\t\r"\` set**, astral characters (code-point iteration in `escapeString`), and NUL all survive `writeString↔read`.
- **The step-budget reset discipline** (`resetStepCounter` per top-level form and per `call`) is exactly right for a per-command budget once wired.

---

## Open questions

1. **Where should the C-g signal originate?** The spine can't poll its own port while evaluating (single-threaded), so the interrupt-check must read shared memory written by *another* process — main seems right (it owns the windows' input path). Does `utilityProcess` + `MessageChannelMain` make `SharedArrayBuffer` transfer awkward enough to prefer a step-budget-only first cut?
2. **Is late-bound macro expansion (re-expand per use) a feature?** It makes `reload-stdlib` pick up macro redefinitions live — if that's relied on, an expansion cache needs explicit invalidation, and the spec should state the semantics either way.
3. **Should `LispInterrupt` be consumable by user `catch` (LISP-13)?** The tests assert yes; Emacs experience says quits must survive handlers. Architect call before LISP-01 is wired.
4. **Map key semantics (LISP-11):** document identity keys, or move to structural keys? Structural keys interact with LISP-02 (`equal`'s recursion) and with mutable-map hashing — worth a small design note before stdlib grows map-keyed registries.
5. **Is the module system load-bearing anywhere planned** (the spec's hot-reload §6 narrative), or should it be marked dormant to spare future auditors the trace?
6. `symbol->string` accepting keywords (primitives.js:398–402) — intended lenience or accident? (Docstring says "expected a symbol".)

---

## Stats

```
Files read in full:        7 (packages/lisp/src/*, 2,444 lines)
Spec read:                 docs/spec/lisp.md (327 lines)
Cross-referenced:          spine.js (6,103 lines, targeted regions), server.js (targeted),
                           commands.lisp, keymap.lisp (targeted), interpreter tests (10 files, 254 tests)
node -e repro batches:     6 (≈45 individual probes; all repros in this report reproduced on
                           branch main @ efe0fa6d, macOS/V8 default stack)
Findings:                  19  (P0: 0, P1: 5, P2: 8, P3: 6)
  CONFIRMED:               18   PLAUSIBLE-impact-only: 1 (LISP-17; mechanism confirmed, unused in prod)
Spec-conformance rows:     16 (2 violations, 5 drift/undocumented, 9 conforming)
Writes performed:          this report only
```
