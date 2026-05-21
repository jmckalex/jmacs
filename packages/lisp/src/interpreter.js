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
  const global = new Environment();

  installPrimitives(global, { write });
  // `eval` needs the global environment, so it is installed here rather
  // than in primitives.js. `(eval form)` evaluates a form — and, given a
  // symbol, resolves it to its current binding, which is what lets the
  // keymap bind command *names* and pick up redefinitions.
  global.define(
    'eval',
    new Primitive('eval', (args) => evaluate(args[0], global))
  );
  for (const form of read(PRELUDE)) {
    evaluate(form, global);
  }
  if (options.primitives) {
    for (const [name, fn] of Object.entries(options.primitives)) {
      global.define(name, new Primitive(name, fn));
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
