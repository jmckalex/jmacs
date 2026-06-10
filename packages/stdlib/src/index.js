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
export { parseSynctexView, parseSynctexEdit } from './synctex-parse.js';
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
  // The utility-pane Lisp surface (toggle/focus/cycle + output helpers).
  // After system.lisp (reuses toggle-repl!); before latex-compile.lisp,
  // which routes its build output through `utility-output`.
  'utility-pane.lisp',
  'modes.lisp',
  // The face registry loads before themes.lisp, which registers all
  // built-in faces via `defface`.
  'faces.lisp',
  'themes.lisp',
  // The Lisp surface for user `kind -> face` highlight overrides. Loads
  // after faces.lisp (reuses `*face-overrides-saver*` for persistence)
  // and modes.lisp (rules are keyed by major-mode display name). The
  // host primitive `set-highlight-overrides!` recompiles queries live.
  'highlight-rules.lisp',
  'keymap.lisp',
  // multi-cursor.lisp needs `expand-region-word-bounds` (expand-region.lisp)
  // and rebinds `keyboard-quit` (keymap.lisp), so it loads after both.
  // The keymap binds C-c d / C-c D to the commands by *symbol*; symbols
  // resolve at dispatch time, so the order with keymap.lisp doesn't matter
  // for those bindings.
  'multi-cursor.lisp',
  // Snippets (yasnippet-style expansion). The parser is pure and loads
  // first; `snippets.lisp` declares the commands, settings and faces and
  // the active-snippet navigation; `snippets-keymap.lisp` rebinds
  // TAB/S-TAB through the snippet dispatch and so must load after
  // `keymap.lisp` (above) and after `multi-cursor.lisp` (whose
  // keyboard-quit extension the snippet cancel further wraps).
  'snippets-parser.lisp',
  'snippets.lisp',
  'snippets-keymap.lisp',
  // These read the keymap, so they load after it.
  'auto-pair.lisp',
  'menus.lisp',
  // The general math-preview minor mode loads before the mode files that
  // build their toggles on it (markdown.lisp, latex.lisp).
  'math-preview.lisp',
  'markdown.lisp',
  'latex.lisp',
  // latex-compile.lisp extends latex.lisp's `latex-c-c-map`, so it must
  // load after it (the AUCTeX Phase-1 compile/view loop).
  'latex-compile.lisp',
  'makefile.lisp',
  'view-menu.lisp',
  'sticky-notes.lisp',
  'bookmarks.lisp',
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
  // RefTeX R3 — citations (reftex-citation, C-c [). Loads after
  // reftex-refs.lisp (it reuses R2's origin bookkeeping + extends the
  // `latex-c-c-map` with `[`) and reftex.lisp (R1 DB + bib paths). The
  // cite picker formats references via the host citation.js bridge.
  'reftex-cite.lisp',
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
  // AUCTeX-style `LaTeX-fill-paragraph` (M-q). Loads after latex-nav.lisp:
  // it reuses latex-insert.lisp's pure \begin/\end env-marker scanner
  // (generalised to the full open-env stack for depth) and `assoc`s an
  // M-q slot onto latex-mode-map, overriding keymap.lisp's global
  // M-q -> fill-paragraph for LaTeX buffers. Adds `*latex-indent-level*`
  // (and `*latex-item-indent*`) to the `latex` customize group.
  'latex-fill.lisp',
  // AUCTeX Phase 6 — SyncTeX forward & inverse search. Loads after
  // latex-compile.lisp (it redefines `latex-view` to fold in forward
  // search) and after reftex.lisp (so `latex-master-file` is the
  // master-detecting R1 version). Defines `latex-forward-search` and
  // `latex-synctex-inverse`; adds no keybindings of its own (forward is
  // folded into C-c C-v; inverse is the host's Option-click callback).
  'latex-synctex.lisp',
  // The structured (grouped) LaTeX mode menu. Loads LAST among the
  // LaTeX/RefTeX files: it names every latex-* / reftex-* command in its
  // sections, so all those symbols must already exist. Uses the generic
  // `register-mode-menu!` from menus.lisp; purely additive (the flat
  // `mode-menu-entries` and every other mode's menu are unaffected).
  'latex-menu.lisp',
]);

/**
 * A standard-library file that failed to load.
 *
 * @typedef {object} StdlibLoadFailure
 * @property {string} name - The file's name (e.g. `'keymap.lisp'` or
 *   `'languages/rust.lisp'`).
 * @property {'fetch' | 'evaluate' | 'list'} phase - Where it failed:
 *   fetching the source, evaluating it, or listing the language dir.
 * @property {Error} error - The thrown error.
 */

/**
 * Load the standard library into an interpreter.
 *
 * Each file is loaded in isolation: if one fails to fetch or evaluate,
 * it is recorded and loading continues with the rest, rather than
 * aborting the whole standard library. A single broken file (a syntax
 * error, an unbound reference) therefore degrades the editor — the
 * commands from that file are missing — instead of bricking it with no
 * keymap and no `M-x` at all. The caller surfaces the returned failures.
 *
 * (Files do have load-order dependencies — `keymap.lisp` binds commands
 * defined earlier, for instance — so an early failure can cascade into
 * later files that build on it. Those later files are still *attempted*;
 * the editor recovers as much functionality as the breakage allows.)
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
 * @returns {Promise<{ failures: StdlibLoadFailure[] }>} The files that
 *   failed to load, in the order they were attempted (empty on success).
 */
export async function loadStdlib(interpreter, getSource, options = {}) {
  /** @type {StdlibLoadFailure[]} */
  const failures = [];

  async function loadOne(name) {
    let source;
    try {
      source = await getSource(name);
    } catch (error) {
      failures.push({ name, phase: 'fetch', error });
      return;
    }
    try {
      interpreter.evaluate(source);
    } catch (error) {
      failures.push({ name, phase: 'evaluate', error });
    }
  }

  for (const name of STDLIB_FILES) {
    await loadOne(name);
  }

  if (typeof options.listLanguageFiles === 'function') {
    let files = [];
    try {
      files = await options.listLanguageFiles();
    } catch (error) {
      failures.push({ name: 'languages/', phase: 'list', error });
      files = [];
    }
    for (const name of files) {
      if (!name.endsWith('.lisp')) continue;
      await loadOne(`languages/${name}`);
    }
  }

  return { failures };
}
