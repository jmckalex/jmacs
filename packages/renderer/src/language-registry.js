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
 * A spec may optionally declare an `injectionQuery`, in which case the
 * registry threads a `getHighlighter` closure into the language so its
 * outer grammar can splice another language's highlighter into nodes
 * marked `@injection.content` (a fenced code block, a `<script>` body,
 * a `<?php ... ?>` region). See {@link loadLanguageHighlighters}.
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
 *   May be empty for languages reached only via injection (e.g. an
 *   inline-markdown grammar that is never selected by file extension).
 * @property {string[]} [aliases] - Extra tags the injection lookup will
 *   resolve to this language. Markdown fences commonly use shortened
 *   names — ` ```js ` for JavaScript, ` ```py ` for Python — that the
 *   info-string capture matches verbatim. Each alias becomes another
 *   entry in the highlighter map; they are not consulted for filename
 *   matching.
 * @property {string} [injectionQuery] - A second query that marks
 *   `@injection.content` regions paired with a language tag. When set,
 *   the loader threads a `getHighlighter` lookup into the highlighter
 *   so inner ranges render in the injected language's palette.
 * @property {string} [foldQuery] - A query whose `(node) @fold`
 *   captures mark foldable scopes — function bodies, class bodies,
 *   blocks, JSX elements, etc. When set, the highlighter exposes a
 *   `foldCaptures(text)` method the view uses to compute fold ranges
 *   (`./folding.js`). A capture whose node spans a single line is
 *   silently dropped — nothing to fold there.
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
  if (!Array.isArray(spec.suffixes)) {
    throw new Error(`language ${spec.tag}: missing suffixes`);
  }
  if (
    spec.injectionQuery !== undefined &&
    typeof spec.injectionQuery !== 'string'
  ) {
    throw new Error(`language ${spec.tag}: injectionQuery must be a string`);
  }
  if (
    spec.foldQuery !== undefined &&
    typeof spec.foldQuery !== 'string'
  ) {
    throw new Error(`language ${spec.tag}: foldQuery must be a string`);
  }
  if (spec.aliases !== undefined && !Array.isArray(spec.aliases)) {
    throw new Error(`language ${spec.tag}: aliases must be a string[]`);
  }
  /** @type {LanguageSpec} */
  const stored = {
    tag: spec.tag,
    grammar: spec.grammar,
    query: spec.query,
    suffixes: [...spec.suffixes],
  };
  if (spec.injectionQuery !== undefined) {
    stored.injectionQuery = spec.injectionQuery;
  }
  if (spec.foldQuery !== undefined) {
    stored.foldQuery = spec.foldQuery;
  }
  if (spec.aliases !== undefined) {
    stored.aliases = [...spec.aliases];
  }
  registry.set(spec.tag, stored);
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
 * table. Languages registered with an empty `suffixes` list are never
 * selected here (they're reached only via injection).
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
 *
 * Languages whose spec declares an `injectionQuery` get a
 * `getHighlighter` closure threaded into them; that closure reads the
 * map being populated by this loop, so by the time any `highlight()`
 * call actually fires (well after this returns), every sibling is in
 * place. The result: a PHP highlighter can recurse into HTML, which
 * recurses into JavaScript or CSS, all using each other's fully-built
 * highlighters.
 *
 * Each language fails independently — a missing grammar disables only
 * that language. If an injection's inner language is the missing one,
 * the outer face survives on the injected range (see
 * `treesitter.js#captures`).
 *
 * @param {(grammar: string, query: string, options?: {
 *   injectionQuery?: string,
 *   foldQuery?: string,
 *   getHighlighter?: (tag: string) => import('./treesitter.js').Highlighter | undefined,
 *   tag?: string,
 *   overrideStore?: import('./highlight-overrides.js').OverrideStore,
 * }) => Promise<import('./treesitter.js').Highlighter>
 * } create - Build a tree-sitter highlighter from a grammar file, a
 *   query, and (when set) an injection query plus a sibling-lookup, or
 *   a fold query. The language `tag` and the user `overrideStore` are
 *   always threaded in so the highlighter can apply live user rules.
 * @param {(tag: string, error: Error) => void} [onError] - Called when a
 *   language's grammar fails to load. Defaults to ignoring the error.
 * @param {import('./highlight-overrides.js').OverrideStore} [overrideStore] -
 *   The live user-override store. Passed to every highlighter so user
 *   `kind -> face` rules apply on top of the base query, recomputed live.
 * @returns {Promise<{
 *   highlighters: Record<string, ((text: string) =>
 *     import('./highlight.js').Run[][]) & {
 *       captures: (text: string) => import('./treesitter.js').CaptureRange[],
 *       nodeAtPoint: (text: string, pos: number) =>
 *         import('./treesitter.js').NodeInfo | null
 *     }>,
 *   foldCaptures: Record<string, (text: string) =>
 *     import('./folding.js').FoldCapture[]>,
 * }>}
 *   `highlighters` maps each language tag to a `highlight(text)`
 *   callable; the callable also exposes the underlying highlighter's
 *   `captures(text)` and `nodeAtPoint(text, pos)` as properties (the
 *   diagnostic `describe-face-at-point` uses them). `foldCaptures` is
 *   a parallel map of fold-capture functions, populated only for
 *   languages that declared a `foldQuery`.
 */
export async function loadLanguageHighlighters(
  create,
  onError = () => {},
  overrideStore = undefined
) {
  /** @type {Record<string, import('./treesitter.js').Highlighter>} */
  const highlighters = {};
  /** Closure read lazily at highlight time, after the loop populates. */
  const getHighlighter = (tag) => highlighters[tag];

  for (const spec of registry.values()) {
    try {
      // Every language carries its tag and the override store so the
      // highlighter can layer user `kind -> face` rules on its base
      // query. Injection/fold options are added only when declared.
      /** @type {object} */
      const options = { tag: spec.tag };
      if (overrideStore !== undefined) options.overrideStore = overrideStore;
      if (spec.injectionQuery) {
        options.injectionQuery = spec.injectionQuery;
        options.getHighlighter = getHighlighter;
      }
      if (spec.foldQuery) options.foldQuery = spec.foldQuery;
      const highlighter = await create(spec.grammar, spec.query, options);
      highlighters[spec.tag] = highlighter;
      // Alias entries point at the same highlighter so an injection's
      // info-string capture (` ```js `, ` ```py `, …) resolves to the
      // canonical language. Aliases never shadow a real tag — if
      // another language already claimed the name, leave it alone.
      if (Array.isArray(spec.aliases)) {
        for (const alias of spec.aliases) {
          if (!(alias in highlighters)) highlighters[alias] = highlighter;
        }
      }
    } catch (error) {
      onError(spec.tag, error);
    }
  }

  const exposedHighlighters = {};
  const exposedFolds = {};
  for (const [tag, highlighter] of Object.entries(highlighters)) {
    const fn = (text, modeName = null) => highlighter.highlight(text, modeName);
    // Expose the raw capture list + node-at-point as properties on
    // the callable so a caller that wants either reach them without
    // a second registry.
    fn.captures = (text, modeName = null) =>
      highlighter.captures(text, 0, modeName);
    fn.nodeAtPoint = (text, pos) => highlighter.nodeAtPoint(text, pos);
    exposedHighlighters[tag] = fn;
    if (typeof highlighter.foldCaptures === 'function') {
      exposedFolds[tag] = (text) => highlighter.foldCaptures(text);
    }
  }
  return { highlighters: exposedHighlighters, foldCaptures: exposedFolds };
}
