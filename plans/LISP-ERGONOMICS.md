# Lisp Ergonomics — fixes surfaced by writing the language manual

Decided with the architect 2026-06-12, after the "Programming in jmacs
Lisp" manual exercise (branch `docs-lisp-guide`) catalogued every place
the documentation had to say "there is no X, here is the workaround".

## Decisions (architect-approved)

1. **Loops**: `while`, `dotimes`, `dolist` as *prelude macros*
   (when/unless precedent; core stays 17 special forms) **plus named
   `let`** in the core `let` form.
2. **`finally`**: extend `try` — `(try body… (catch e …)? (finally …)?)`,
   at least one clause required. An error raised inside `finally`
   replaces the propagating one (JS semantics). No separate
   `unwind-protect`.
3. **Markers v1**: `make-marker` / `marker-position` / `set-marker!` /
   `release-marker!` + scoped `with-marker` macro; `save-excursion` on
   top. Markers carry their buffer; `marker-position` readable from
   anywhere, mutation only while the marker's buffer is current.
   Overlays explicitly deferred.
4. **Boundary coercion**: host primitives returning JS `undefined` OR
   `null` yield `nil`, applied once at the packages/lisp boundary.
5. **Truthiness**: `nil` STAYS truthy (only `#f` is false — settled).
   The fix is the miss-convention sweep: *absence → `#f`, emptiness →
   `nil`*. Misses return `#f`: `get` (no fallback), `doc`,
   `where-defined`, `find-string-forward`/`find-regexp-*`. Emptiness
   keeps `nil`: `first`, `rest`, `last`.
6. **sort**: `(sort seq less?)`, Scheme-style boolean `less?`,
   optional with a numbers/strings default; stable; returns the input's
   type (list→list, vector→vector).
7. **Sequencing**: refresh + land B6 (`lisp-error-locations`) BEFORE
   the `try` grammar changes; its source-location keys may join the
   condition map and the manual updates then.

## Branches

### 0. B6 refresh (`lisp-error-locations`)
Merge current `main` into the branch, full suite, hand to the architect
for live test. Must land before branch 3 to avoid `try`-grammar
conflicts.

### 1. `lisp-warts` (small)
- `cond` singleton clause `(test)`: evaluate the test ONCE (today it
  evaluates twice — truth check + TailCall re-eval). eval.js ~474.
- `register-command!` returns the command name symbol (today: the whole
  `*commands*` registry map, which the REPL then prints).
- `undefined`/`null` → `NIL` coercion at the primitive-apply site in
  packages/lisp; audit host primitives for intentional null returns.
- Regression tests for all three.

### 2. `lisp-loops`
- Prelude macros (gensym-disciplined, letrec-based expansions,
  TCO-safe to 10^6 — test that): `while`, `dotimes`, `dolist` (lists;
  use for-each for vectors). All return `nil`.
- Named `let`: `(let name ((var init)…) body…)` rewritten internally to
  `((letrec ((name (lambda (var…) body…))) name) init…)` — inits in
  the outer scope, recursion TCO'd via ordinary application.
- `macroexpand-1` / `macroexpand` primitives (resolve macros in the
  global env, like `eval`; `macroexpand` fixpoint-capped with an error).
- `sort` primitive per decision 6; `any?`/`every?` (strict booleans,
  short-circuiting) in the prelude.
- Editor payoff: `sort-lines` defcommand (region, atomic-change-group,
  unbound — M-x/menu).
- Update `docs/spec/lisp.md` where touched (let row, prelude list, the
  stale "no TCO" note in §3).

### 3. `lisp-finally` (after B6 lands)
- `finally` clause on `try`, implemented on JS try/finally — which also
  runs cleanup when a *raw JS exception* passes through (the hand-rolled
  both-paths pattern cannot; today a host fault inside
  `atomic-change-group` leaves the undo group open).
- Rewrite `call-with-atomic-undo` on `finally`.

### 4. `lisp-markers` (after 3)
- L2 markers exposed per decision 3; `save-excursion` macro built on
  markers + `finally`, replacing the integer-restore idiom.

### 5. `lisp-miss-convention` (last, riskiest)
- The absence→`#f` sweep per decision 5; audit every caller of the
  changed functions across the stdlib.

### Host-side (no design input; any time)
- `describe-key` should consult the buffer's keymap chain, not only
  `the-keymap`.
- customize's `:number` widget applies a string (customize.js) — apply
  a number.

## Manual ledger (apply on `docs-lisp-guide` as each branch lands)

- B1: delete the cond caveat (control-flow, style-pitfalls); soften
  "Truthy Ghosts"; defcommand-echo note (commands chapter flag).
- B2: rewrite "Iterating Without Loops"; macros chapter's `dotimes`
  becomes "how the real one is defined"; functions chapter gains named
  let (and drops "it does not exist"); text-editing capstone →
  sort-lines.
- B3: shrink "What try Does Not Provide"; errors chapter gains finally;
  macros capstone simplifies.
- B4: rewrite "What the Lisp Does Not Expose".
- B5: truthiness sections teach "absence → #f, emptiness → nil".
- B6: errors chapter's "exactly :message and :irritants" gains the
  location keys.

Final step once all land: refresh `docs/spec/lisp.md` wholesale and
re-merge main into `docs-lisp-guide`.
