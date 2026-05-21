/**
 * @file The standard library — public entry point.
 *
 * The standard library is Lisp source (`../lisp/*.lisp`) defining the
 * editor's commands and keybindings. This module exposes the host glue
 * needed to load it: the buffer primitives the Lisp is written against,
 * and a loader that evaluates the Lisp files in order.
 *
 * The loader does not read the files itself — the caller supplies the
 * source text. That keeps it environment-agnostic: the desktop app
 * fetches the files over the `app://` scheme, while tests read them
 * from disk.
 */

export { createBufferPrimitives } from './buffer-primitives.js';

/**
 * The standard-library Lisp files, in load order. `editing.lisp`
 * defines the commands; `keymap.lisp` binds them and must load after.
 */
export const STDLIB_FILES = Object.freeze(['editing.lisp', 'keymap.lisp']);

/**
 * Load the standard library into an interpreter.
 *
 * @param {import('@editor/lisp').Interpreter} interpreter
 * @param {(name: string) => (string | Promise<string>)} getSource -
 *   Returns the source text of a stdlib file given its name.
 * @returns {Promise<void>}
 */
export async function loadStdlib(interpreter, getSource) {
  for (const name of STDLIB_FILES) {
    interpreter.evaluate(await getSource(name));
  }
}
