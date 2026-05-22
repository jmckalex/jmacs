# Plan — re-architecting the evaluator (concurrency and tail calls)

**Status: planned, not started.** A design for review; gated by a
performance spike.

## Context

jmacs Lisp has two known limitations, and they share one root cause.

**No concurrency.** The interpreter is a synchronous, run-to-completion
tree-walker. A Lisp computation cannot suspend and resume — it cannot
`await`. Anything asynchronous — an LSP reply, a timer, a subprocess, a
file watcher, the user typing — is reachable only by inverting the Lisp
into host-side callbacks (`read-next-key`, `minibuffer-read`). The spec
(`docs/spec/lisp.md §8`) plans coroutines and CSP-style channels "on
JavaScript's async/await"; the v0 runtime is synchronous.

**No tail-call optimisation.** A *tail call* is a call in the last
position of a function — its result becomes the caller's result, with
nothing left to do afterward:

```lisp
(define (count-down n)
  (if (= n 0) 'done
      (count-down (- n 1))))   ; tail position
```

With TCO the dead frame is reused, and the recursion runs in constant
stack space — a loop. jmacs has none: the evaluator is a recursive
tree-walker in JavaScript, a Lisp call is a JS call, and V8 (Node,
Electron) does not implement ES2015 proper tail calls. So deep Lisp
recursion grows the JS stack until `RangeError: Maximum call stack size
exceeded`. In a Scheme-family Lisp — where the idiomatic loop *is* a
tail-recursive function — that is a real expressiveness wart; the
codebase already works around it (the reactive-notebook plan mandates
iterative graph walks; the stdlib keeps recursion shallow).

**The shared root cause.** The evaluator lives on the JavaScript call
stack. A Lisp call is a JS call. So it cannot pause — you cannot
suspend a JS call stack — *and* deep recursion overflows that stack.
Get the evaluator **off** the JS call stack and both limits fall at
once. This plan is that one re-architecture.

## Three designs

The interpreter is itself JavaScript — that is leverage: JS already
provides suspension (`async`/`await`, generators). The question is how
much to lean on it.

| Design | Concurrency | TCO | Notes |
|--------|:-----------:|:---:|-------|
| **A. Async evaluator** | ✓ | ✗ | Every eval function becomes `async`; a Lisp `(await p)` becomes a JS `await`. Least machinery — but an async recursive walker still grows the async call stack, so tail calls are *not* fixed. |
| **B. Generator + trampoline** | ✓ | ✓ | The evaluator is a generator; a driver loop runs it. `(await p)` `yield`s the promise — the driver `await`s it and resumes. A tail call returns a thunk to the driver instead of recursing — the driver loops. Both limits, one design. |
| **C. Explicit-stack VM** | ✓ | ✓ | The evaluator manages its own stack and continuations as data. First-class continuations become possible; best performance ceiling; the largest, most from-scratch rewrite. |

## Recommendation — design B

**The generator-and-trampoline evaluator.** It fixes *both* limits in
one rewrite, and it still leverages JS — a generator's `yield` is the
suspension mechanism, so no continuation machinery is hand-built. A is
simpler but leaves TCO unsolved, which means two rewrites instead of
one. C is the purest and the fastest ceiling, but it hand-builds what
B gets from the language for free.

Real OS threads (Web Workers) are deliberately *not* in scope: a Worker
has an isolated heap and cannot touch the buffer or DOM, so it suits
only pure CPU offload — not "await an LSP reply, then edit the buffer."
And Emacs's own threads are cooperative, not parallel — the same model
B provides. The concurrency jmacs needs is cooperative, single-threaded
suspension, which B delivers.

## The gating unknown — performance

A generator-driven evaluator does more work per AST node than a plain
recursive walk, and the evaluator is the editor's hot path (it runs
every keystroke handler). Whether the overhead is acceptable is the
**one real unknown**, and **phase 0 is a spike to settle it**: build
B's eval loop behind a branch, benchmark the keystroke / eval hot path
against the current synchronous walker, and decide from real numbers.

The mitigation, if the overhead is too high: a **two-mode evaluator** —
a synchronous fast path used until a computation actually needs to
suspend, falling back to the generator path only then. More complex,
held in reserve pending the spike's numbers.

## The host-boundary ripple

Once the evaluator can suspend, `interpreter.evaluate()` returns a
promise. The host's synchronous Lisp-call sites — `handle-key`,
`run-command`, key dispatch, the modeline — become asynchronous. Key
dispatch needs a **queue** so fast typing stays ordered (await one
keystroke's dispatch before the next). Conversely, the existing
callback-into-host primitives (`read-next-key`, `minibuffer-read` /
`minibuffer-delivered`) can be *simplified* — once Lisp can `await`,
those inversions become ordinary sequential code.

## The concurrency model on top

With a suspendable evaluator in place, the user-facing model from spec
`§8` follows: an `await` form; then coroutines and CSP-style channels,
driven by a cooperative scheduler. A computation suspends only at an
explicit `await`, so between awaits it runs atomically — the safety
property Emacs's cooperative threads rely on, and the reason no locking
is needed.

## Phasing

0. **The performance spike.** A hard gate — decides whether B is viable
   as-is or needs the two-mode fast path.
1. **The generator-trampoline evaluator, with TCO.** Same language
   semantics as today, plus proper tail calls. This is shippable and
   testable on its own — deep recursion simply stops overflowing — with
   no new language surface. The existing `packages/lisp` test suite is
   the safety net: semantics must not change.
2. **`await` and the async host boundary.** `interpreter.evaluate()`
   returns a promise; the host call sites and key dispatch go async;
   the callback-into-host primitives are simplified.
3. **Coroutines and channels.** The user-facing concurrency model.

## Risks

- **Performance** — the central risk; phase 0 exists to measure it
  before any commitment.
- **Pervasive change** — the whole evaluator plus every host site that
  calls Lisp. Mechanical but wide; the `packages/lisp` tests and the
  stdlib tests are the regression net, and phase 1 deliberately changes
  *no* semantics so they stay valid.
- **Ordering** — async key dispatch must be queued.
- This is the deepest change to the project so far; it re-architects
  Layer 3 wholesale. It also unblocks much that is currently parked —
  the reactive notebook's async cells, an LSP client, file watchers.

## Critical files

- `packages/lisp/src/` — `eval.js`, `interpreter.js`: the evaluator,
  re-architected.
- `packages/lisp/test/` — the semantics safety net; new tail-recursion
  tests (deep recursion runs in constant stack space).
- `apps/desktop/src/app.js` — the host's Lisp-call sites become async;
  the key-dispatch queue.
