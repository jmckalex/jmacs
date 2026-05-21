/**
 * @file Lexical environments. An environment is a frame of bindings
 * plus a link to its enclosing frame; lookup walks the chain outward.
 * This is the whole of the editor Lisp's scoping: lexical, full stop.
 */

import { LispError } from './values.js';

/** A frame of variable bindings with a link to its parent. */
export class Environment {
  /** @param {Environment | null} [parent] */
  constructor(parent = null) {
    /** @type {Map<string, *>} */
    this.vars = new Map();
    this.parent = parent;
  }

  /**
   * Whether `name` is bound in this environment or an enclosing one.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    for (let env = this; env !== null; env = env.parent) {
      if (env.vars.has(name)) return true;
    }
    return false;
  }

  /**
   * Look up a binding, walking outward to enclosing frames.
   * @param {string} name
   * @returns {*}
   * @throws {LispError} If `name` is unbound.
   */
  lookup(name) {
    for (let env = this; env !== null; env = env.parent) {
      if (env.vars.has(name)) return env.vars.get(name);
    }
    throw new LispError(`unbound symbol: ${name}`);
  }

  /**
   * Bind `name` in this frame, shadowing any outer binding.
   * @param {string} name
   * @param {*} value
   * @returns {*} `value`.
   */
  define(name, value) {
    this.vars.set(name, value);
    return value;
  }

  /**
   * Assign to the nearest existing binding of `name`.
   * @param {string} name
   * @param {*} value
   * @returns {*} `value`.
   * @throws {LispError} If `name` is unbound.
   */
  assign(name, value) {
    for (let env = this; env !== null; env = env.parent) {
      if (env.vars.has(name)) {
        env.vars.set(name, value);
        return value;
      }
    }
    throw new LispError(`cannot set! an unbound symbol: ${name}`);
  }
}
