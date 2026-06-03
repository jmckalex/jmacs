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
export { createPanePrimitives } from './pane-primitives.js';
export { createLatexPrimitives } from './latex-primitives.js';
export { scanLatex } from './latex-scan.js';
export { pathDirname, pathBasename, pathResolve, normalizePath } from './path-resolve.js';

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
  // Indent / tab settings load right after custom — `insert-tab` (in
  // editing.lisp, loaded earlier) references the variables but only
  // at command-dispatch time, so order between editing and indent
  // doesn't matter for that. The mode-aware helpers (`-tab-width-effective`
  // etc.) need to be in place before any mode-aware indent runs.
  'indent.lisp',
  'files.lisp',
  'views.lisp',
  'panes.lisp',
  'tabline.lisp',
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
  // multi-cursor.lisp needs `expand-region-word-bounds` (expand-region.lisp)
  // and rebinds `keyboard-quit` (keymap.lisp), so it loads after both.
  // The keymap binds C-c d / C-c D to the commands by *symbol*; symbols
  // resolve at dispatch time, so the order with keymap.lisp doesn't matter
  // for those bindings.
  'multi-cursor.lisp',
  // These read the keymap, so they load after it.
  'auto-pair.lisp',
  'menus.lisp',
  'markdown.lisp',
  'latex.lisp',
  // latex-compile.lisp extends latex.lisp's `latex-c-c-map`, so it must
  // load after it (the AUCTeX Phase-1 compile/view loop).
  'latex-compile.lisp',
  'makefile.lisp',
  'view-menu.lisp',
  'sticky-notes.lisp',
  'jukebox.lisp',
  'directory-tree.lisp',
  'directory-columns.lisp',
  'shell.lisp',
  'gnuplot.lisp',
  'notebook.lisp',
  'notebook-commands.lisp',
  'palette.lisp',
  'docs.lisp',
  'help.lisp',
  'face-info.lisp',
  'inline-eval.lisp',
  'folding.lisp',
  // Citation support — depends on the host providing `citation-parse`
  // etc. (renderer-side citation.js bundle). Defcustoms registered
  // after `custom.lisp`'s load.
  'cite.lisp',
  // RefTeX R1 — the multi-file document model + label/section/cite DB.
  // Loads after latex-compile.lisp (it redefines that file's
  // `latex-master-file` seam) and after cite.lisp (it reads
  // `*citation-bib-path*` and uses the citation bridge for cite keys).
  'reftex.lisp',
  // RefTeX R2 — labels & references (reftex-label, reftex-reference).
  // Loads after reftex.lisp (it queries the R1 DB and reuses its
  // `*reftex-env-types*` / type-inference helpers) and extends the
  // `latex-c-c-map` further with the `(` and `)` slots.
  'reftex-refs.lisp',
  // AUCTeX Phase 2 — smart insertion (environment / macro / section /
  // font). Loads after reftex-refs.lisp: it extends `latex-c-c-map`
  // further (C-c C-e/]/C-m/C-s/C-f), redefines `minibuffer-tab-complete`
  // once more to add a third completion source (delegating to RefTeX's
  // dispatcher, then find-file), and softly reuses RefTeX's
  // `*reftex-label-prefixes*` for figure/table/section label keys.
  'latex-insert.lisp',
  // AUCTeX Phase 3 — LaTeX-math-mode (math symbol abbreviations). Loads
  // after latex-insert.lisp: it reuses that file's shared completion
  // dispatch (`*latex-insert-candidates*` / `*latex-insert-tab-complete*`)
  // for the unknown-key completion fallback and extends `latex-c-c-map`
  // with the C-c ~ toggle slot.
  'latex-math.lisp',
  // AUCTeX Phase 5 — navigation & niceties (section next/prev, \begin <->
  // \end matching jump, M-RET insert-\item, smart quotes). Loads after
  // latex-math.lisp: it reuses latex-insert.lisp's `-latex-innermost-open-env`
  // for list detection, extends `latex-c-c-map` (C-c C-n/C-r/%), and adds
  // two top-level keys (M-RET, ") to latex-mode-map.
  'latex-nav.lisp',
  // The structured (grouped) LaTeX mode menu. Loads LAST among the
  // LaTeX/RefTeX files: it names every latex-* / reftex-* command in its
  // sections, so all those symbols must already exist. Uses the generic
  // `register-mode-menu!` from menus.lisp; purely additive (the flat
  // `mode-menu-entries` and every other mode's menu are unaffected).
  'latex-menu.lisp',
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
