/**
 * @file The interpreter — ties the reader, evaluator and primitives
 * into something a host can use. `createInterpreter` builds a global
 * environment, installs the primitives, runs the prelude, and returns
 * an object that evaluates Lisp source.
 */

import { Environment } from './environment.js';
import {
  applyProcedure,
  attachErrorLocation,
  evaluate,
  resetErrorLocation,
} from './eval.js';
import { installPrimitives } from './primitives.js';
import { read } from './reader.js';
import {
  LispError,
  LispMacro,
  listToArray,
  NIL,
  Pair,
  Primitive,
  Sym,
} from './values.js';

/**
 * The prelude — a little Lisp layered on top of the primitives.
 * Defining the common control macros here dogfoods the macro system.
 */
const PRELUDE = `
  ;; Control-flow macros, built from the 'if' special form.
  (defmacro when (test . body)
    (list 'if test (cons 'begin body)))

  (defmacro unless (test . body)
    (list 'if test 'nil (cons 'begin body)))

  ;; Iteration macros. Each expands to a letrec-bound loop procedure
  ;; whose self-call sits in tail position, so a million iterations run
  ;; in constant stack (eval.js's trampoline). The loop procedure's name
  ;; is a gensym, so it cannot capture a caller binding. All return nil.

  ;; (while test body...) — evaluate body while test is truthy.
  (defmacro while (test . body)
    (let ((loop (gensym "while")))
      \`(letrec ((,loop (lambda ()
                         (when ,test ,@body (,loop)))))
         (,loop))))

  ;; (dotimes var count body...) — evaluate body with var bound to
  ;; 0, 1, ... count-1. count is evaluated once, before the loop.
  (defmacro dotimes (var count . body)
    (let ((loop (gensym "dotimes"))
          (n (gensym "count")))
      \`(let ((,n ,count))
         (letrec ((,loop (lambda (,var)
                           (when (< ,var ,n)
                             ,@body
                             (,loop (+ ,var 1))))))
           (,loop 0)))))

  ;; (dolist var lst body...) — evaluate body with var bound to each
  ;; element of the list lst in order. lst is evaluated once. Lists
  ;; only — for a vector, use for-each (or vector->list).
  (defmacro dolist (var lst . body)
    (let ((loop (gensym "dolist"))
          (rest (gensym "rest")))
      \`(letrec ((,loop (lambda (,rest)
                         (when (pair? ,rest)
                           (let ((,var (car ,rest)))
                             ,@body)
                           (,loop (cdr ,rest))))))
         (,loop ,lst))))

  ;; Composed list accessors.
  (define (caar p) (car (car p)))
  (define (cadr p) (car (cdr p)))
  (define (caddr p) (car (cdr (cdr p))))
  (define (cddr p) (cdr (cdr p)))

  ;; A couple of everyday helpers.
  (define (second lst) (cadr lst))
  (define (third lst) (caddr lst))

  ;; Sequence predicates. Strict booleans (the ? convention), short-
  ;; circuiting: any? stops at the first truthy result, every? at the
  ;; first false one. SEQ may be a list or a vector.
  (define (any? pred seq)
    "Whether (pred x) is truthy for SOME element of SEQ (#f when empty)."
    (let loop ((rest (if (vector? seq) (vector->list seq) seq)))
      (cond
        ((nil? rest) #f)
        ((pred (car rest)) #t)
        (else (loop (cdr rest))))))

  (define (every? pred seq)
    "Whether (pred x) is truthy for EVERY element of SEQ (vacuously #t
     when empty)."
    (let loop ((rest (if (vector? seq) (vector->list seq) seq)))
      (cond
        ((nil? rest) #t)
        ((pred (car rest)) (loop (cdr rest)))
        (else #f))))
`;

/**
 * @typedef {object} Interpreter
 * @property {Environment} globalEnv - The global environment.
 * @property {(source: string) => *} evaluate - Evaluate Lisp source,
 *   returning the value of the last form. Throws `LispError` on error.
 * @property {(name: string, value: *) => *} define - Bind a value in
 *   the global environment.
 * @property {(name: string, ...args: *[]) => *} call - Apply a global
 *   procedure to JavaScript arguments. The host's way into Lisp — used,
 *   for example, to run the keymap's `handle-key` on every keystroke.
 */

/**
 * Create an interpreter.
 *
 * @param {object} [options]
 * @param {(text: string) => void} [options.write] - Output sink for
 *   `print`, `display` and friends. Defaults to discarding output.
 * @param {Record<string, (args: *[]) => *>} [options.primitives] -
 *   Extra host primitives to install (e.g. buffer operations). Each is
 *   a function taking an array of evaluated arguments.
 * @returns {Interpreter}
 */
export function createInterpreter(options = {}) {
  const write = options.write ?? (() => {});

  // The base environment holds the primitives, the prelude, host
  // primitives and the module registry. The global environment and
  // every module are children of it: they share the base but not each
  // other's bindings, which is what gives modules their namespaces.
  const base = new Environment();
  installPrimitives(base, { write });
  base.modules = new Map();

  // Top-level user code — the REPL and the standard library — runs in
  // the global environment.
  const global = new Environment(base);

  // `eval` evaluates a form in the global environment; given a symbol
  // it resolves the current binding, which is what lets the keymap
  // bind command *names* and pick up redefinitions. Installed here
  // because it needs the global reference.
  base.define(
    'eval',
    new Primitive('eval', (args) => evaluate(args[0], global))
  );

  // `macroexpand-1` / `macroexpand` expand a macro use as DATA, without
  // evaluating the result. Like `eval`, they close over the global
  // environment: the head symbol is resolved there, and if it names a
  // macro the transformer is applied to the unevaluated argument forms.
  // Anything else — non-pairs, special forms, procedure calls — passes
  // through unchanged.
  const macroexpand1 = (form) => {
    if (
      form instanceof Pair &&
      form.head instanceof Sym &&
      global.has(form.head.name)
    ) {
      const binding = global.lookup(form.head.name);
      if (binding instanceof LispMacro) {
        return {
          expanded: true,
          form: applyProcedure(binding.transformer, listToArray(form.tail)),
        };
      }
    }
    return { expanded: false, form };
  };
  base.define(
    'macroexpand-1',
    new Primitive('macroexpand-1', (args) => macroexpand1(args[0]).form)
  );
  base.define(
    'macroexpand',
    new Primitive('macroexpand', (args) => {
      let form = args[0];
      // Repeat until the head is no longer a macro, with a hard cap so
      // a self-expanding macro cannot hang the editor.
      for (let step = 0; step < 1000; step += 1) {
        const result = macroexpand1(form);
        if (!result.expanded) return result.form;
        form = result.form;
      }
      throw new LispError('macroexpand: expansion did not terminate');
    })
  );

  for (const form of read(PRELUDE)) {
    evaluate(form, base);
  }
  if (options.primitives) {
    for (const [name, fn] of Object.entries(options.primitives)) {
      base.define(name, new Primitive(name, fn));
    }
  }

  return {
    globalEnv: global,

    evaluate(source) {
      let value = NIL;
      for (const form of read(source)) {
        // Reset per top-level form so an error before any located subform
        // can't inherit a stale location; tag any escaping error with
        // where it happened (B6).
        resetErrorLocation();
        try {
          value = evaluate(form, global);
        } catch (error) {
          throw attachErrorLocation(error);
        }
      }
      return value;
    },

    define(name, value) {
      return global.define(name, value);
    },

    call(name, ...args) {
      // The keystroke / host entry path. Tag an escaping error with the
      // offending form's location too, so handle-key failures report it.
      try {
        return applyProcedure(global.lookup(name), args);
      } catch (error) {
        throw attachErrorLocation(error);
      }
    },
  };
}
