/**
 * @file The interpreter — ties the reader, evaluator and primitives
 * into something a host can use. `createInterpreter` builds a global
 * environment, installs the primitives, runs the prelude, and returns
 * an object that evaluates Lisp source.
 */

import { Environment } from './environment.js';
import { applyProcedure, evaluate } from './eval.js';
import { installPrimitives } from './primitives.js';
import { read } from './reader.js';
import { NIL, Primitive } from './values.js';

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
        value = evaluate(form, global);
      }
      return value;
    },

    define(name, value) {
      return global.define(name, value);
    },

    call(name, ...args) {
      return applyProcedure(global.lookup(name), args);
    },
  };
}
