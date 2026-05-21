/**
 * @file Layer 3 — the Lisp runtime, public entry point.
 *
 * The editor's custom Lisp dialect: Scheme-dominant semantics, Clojure
 * influence in its data literals, a tree-walking evaluator. This module
 * re-exports the value model, the reader, the evaluator and the
 * interpreter.
 *
 * Typical use:
 *
 *     import { createInterpreter } from '@editor/lisp';
 *     const lisp = createInterpreter();
 *     lisp.evaluate('(+ 1 2 3)'); // => 6
 */

export * from './values.js';
export * from './reader.js';
export { Environment } from './environment.js';
export { evaluate, applyProcedure, specialFormNames } from './eval.js';
export { installPrimitives } from './primitives.js';
export { createInterpreter } from './interpreter.js';
