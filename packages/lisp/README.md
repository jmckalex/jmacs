# @editor/lisp — Layer 3

The Lisp runtime. A custom Lisp dialect for the editor: Scheme-dominant
semantics, Clojure-influenced data literals, a tree-walking evaluator.
This is the layer that gives the editor its character — the primary
language extensions are written in.

## Current state

A working interpreter: reader, evaluator, lexical scoping, closures,
macros, ~75 primitives, error handling, and self-documentation. Enough
to drive the in-editor REPL and to script the buffer.

**Deliberate v0 limitations** (see `docs/spec/lisp.md`):

- **Macros are procedural, not hygienic.** A macro is a function from
  forms to a form. `syntax-case`-style hygiene is the eventual target;
  it is sequenced to land before a macro-heavy standard library exists.
- **No tail-call optimisation.** Deep non-tail recursion can exhaust the
  JavaScript stack.
- **No module system yet.** One global environment for now.
- **Conditions/restarts** are not built; `try`/`catch` is the surface.

## Using it

```js
import { createInterpreter } from '@editor/lisp';

const lisp = createInterpreter({
  write: (text) => process.stdout.write(text), // sink for (print ...)
  primitives: { 'now': () => Date.now() },     // extra host procedures
});

lisp.evaluate('(+ 1 2 3)');                    // => 6
lisp.evaluate('(map (lambda (x) (* x x)) (range 1 5))'); // => (1 4 9 16)
```

## The language at a glance

```lisp
(define (factorial n)
  "Classic recursion."
  (if (= n 0) 1 (* n (factorial (- n 1)))))

(defmacro unless (test . body)            ; procedural macro
  (list 'if test 'nil (cons 'begin body)))

(let ((xs (filter odd? (range 1 10))))    ; lexical scope, HOFs
  (reduce + 0 xs))

(try (error "boom") (catch e (get e :message)))   ; => "boom"
```

Special forms: `quote` `quasiquote` `if` `define` `lambda` `let` `let*`
`letrec` `set!` `begin` `cond` `and` `or` `try` `defmacro`. Everything
else is a procedure or a macro.

## Tests

```
npm test
```

Reader, value model, evaluator, macros, errors and self-documentation.
