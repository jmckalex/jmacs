/**
 * @file The language registry — the JS-side plug-in point for adding a
 * tree-sitter language to the editor.
 *
 * Each tree-sitter language is a self-contained module in `./languages/`
 * that calls {@link registerLanguage} at module top level. The module
 * declares a language *tag* (the key the view uses to look up its
 * highlighter), the grammar's `.wasm` filename in `../vendor/`, the
 * highlight query, and the filename suffixes the language claims.
 *
 * The host app discovers language modules at startup and imports each
 * one; loading a module is what registers it. There are no other
 * touch-points: adding a language is a drop of one JS module here, one
 * `.lisp` mode file in `packages/stdlib/lisp/languages/`, and the
 * grammar's `.wasm` in `../vendor/`. See `./languages/README.md`.
 *
 * The registry is a *data* registry. It does not load the grammars
 * itself — call {@link loadLanguageHighlighters} from a place that knows
 * how to create a tree-sitter highlighter (the desktop app does, in
 * `app.js`).
 */

/**
 * @typedef {object} LanguageSpec
 * @property {string} tag - The language key the view uses (e.g. `'javascript'`).
 * @property {string} grammar - The grammar `.wasm` filename in `../vendor/`.
 * @property {string} query - The highlight query (a tree-sitter S-expression).
 * @property {string[]} suffixes - Filename suffixes that pick this language.
 */

/** @type {Map<string, LanguageSpec>} */
const registry = new Map();

/**
 * Register a tree-sitter language. Called from the language's module at
 * import time. Idempotent: re-registering the same tag replaces the
 * earlier registration (a hot reload re-runs the module).
 *
 * @param {LanguageSpec} spec
 */
export function registerLanguage(spec) {
  if (typeof spec?.tag !== 'string' || spec.tag === '') {
    throw new Error('language: missing tag');
  }
  if (typeof spec.grammar !== 'string' || spec.grammar === '') {
    throw new Error(`language ${spec.tag}: missing grammar`);
  }
  if (typeof spec.query !== 'string') {
    throw new Error(`language ${spec.tag}: missing query`);
  }
  if (!Array.isArray(spec.suffixes) || spec.suffixes.length === 0) {
    throw new Error(`language ${spec.tag}: missing suffixes`);
  }
  registry.set(spec.tag, {
    tag: spec.tag,
    grammar: spec.grammar,
    query: spec.query,
    suffixes: [...spec.suffixes],
  });
}

/**
 * All registered languages, in registration order.
 * @returns {LanguageSpec[]}
 */
export function registeredLanguages() {
  return Array.from(registry.values());
}

/**
 * Forget every registered language. Tests use this to reset between
 * runs; production code should not.
 */
export function clearLanguages() {
  registry.clear();
}

/**
 * Find the language tag whose suffixes match a buffer name. Returns
 * `null` when nothing matches — the caller falls back to its built-in
 * table.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function languageForFilename(name) {
  if (typeof name !== 'string') return null;
  for (const spec of registry.values()) {
    for (const suffix of spec.suffixes) {
      if (name.endsWith(suffix)) return spec.tag;
    }
  }
  return null;
}

/**
 * Instantiate a tree-sitter highlighter for every registered language.
 * The caller supplies the grammar-loading factory (it depends on the
 * runtime's vendored `.wasm` path); each language fails independently,
 * so a missing grammar disables only that language.
 *
 * @param {(grammar: string, query: string) =>
 *   Promise<{highlight: (text: string) => import('./highlight.js').Run[][]}>
 * } create - Build a tree-sitter highlighter from a grammar file and a query.
 * @param {(tag: string, error: Error) => void} [onError] - Called when a
 *   language's grammar fails to load. Defaults to ignoring the error.
 * @returns {Promise<Record<string, (text: string) => import('./highlight.js').Run[][]>>}
 *   A map from language tag to a `highlight(text)` function.
 */
export async function loadLanguageHighlighters(create, onError = () => {}) {
  /** @type {Record<string, (text: string) => import('./highlight.js').Run[][]>} */
  const highlighters = {};
  for (const spec of registry.values()) {
    try {
      const highlighter = await create(spec.grammar, spec.query);
      highlighters[spec.tag] = highlighter.highlight;
    } catch (error) {
      onError(spec.tag, error);
    }
  }
  return highlighters;
}
