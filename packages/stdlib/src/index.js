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
export { createViewPrimitives } from './view-primitives.js';

/**
 * The standard-library Lisp files, in load order. The command files
 * (`editing.lisp`, `files.lisp`) come first; `keymap.lisp` binds the
 * commands and must load last.
 */
export const STDLIB_FILES = Object.freeze([
  // The command system loads first — every command file declares its
  // commands with `defcommand`.
  'commands.lisp',
  'editing.lisp',
  // The customisation registry loads early — later files declare
  // their settings with `defcustom`.
  'custom.lisp',
  'files.lisp',
  'views.lisp',
  'search.lisp',
  'regex-search.lisp',
  'kill.lisp',
  'yank-pop.lisp',
  'line-ops.lisp',
  'occur.lisp',
  'expand-region.lisp',
  'system.lisp',
  'modes.lisp',
  // The face registry loads before themes.lisp, which registers all
  // built-in faces via `defface`.
  'faces.lisp',
  'themes.lisp',
  'keymap.lisp',
  // These read the keymap, so they load after it.
  'auto-pair.lisp',
  'menus.lisp',
  'markdown.lisp',
  'latex.lisp',
  'makefile.lisp',
  'view-menu.lisp',
  'sticky-notes.lisp',
  'jukebox.lisp',
  'directory-tree.lisp',
  'directory-columns.lisp',
  'shell.lisp',
  'palette.lisp',
  'docs.lisp',
  'help.lisp',
  'face-info.lisp',
  'inline-eval.lisp',
  'folding.lisp',
]);

/**
 * Load the standard library into an interpreter.
 *
 * After the ordered `STDLIB_FILES`, `loadStdlib` loads every Lisp file
 * in the `languages/` subdirectory (when the caller supplies a lister).
 * Languages are mutually independent — load order among them is
 * unspecified. See `packages/stdlib/lisp/languages/README.md`.
 *
 * @param {import('@editor/lisp').Interpreter} interpreter
 * @param {(name: string) => (string | Promise<string>)} getSource -
 *   Returns the source text of a stdlib file given its name. Language
 *   files are requested as `'languages/<name>.lisp'`.
 * @param {object} [options]
 * @param {() => (string[] | Promise<string[]>)} [options.listLanguageFiles] -
 *   Returns the filenames in `lisp/languages/` (bare names, e.g.
 *   `'javascript.lisp'`). When absent, no language files are loaded —
 *   the caller has none.
 * @returns {Promise<void>}
 */
export async function loadStdlib(interpreter, getSource, options = {}) {
  for (const name of STDLIB_FILES) {
    interpreter.evaluate(await getSource(name));
  }
  if (typeof options.listLanguageFiles === 'function') {
    const files = await options.listLanguageFiles();
    for (const name of files) {
      if (!name.endsWith('.lisp')) continue;
      interpreter.evaluate(await getSource(`languages/${name}`));
    }
  }
}
