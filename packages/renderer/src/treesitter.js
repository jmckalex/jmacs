/**
 * @file Tree-sitter syntax highlighting. Loads the web-tree-sitter
 * WebAssembly runtime and a prebuilt grammar (both vendored in
 * `../vendor/`), parses a buffer into a real syntax tree, and turns
 * highlight-query captures into per-line runs.
 *
 * This module knows nothing about individual languages. The grammar
 * filenames and highlight queries live in `./languages/<name>.js`,
 * registered through `./language-registry.js`; adding a language never
 * touches this file. See `./languages/README.md`.
 *
 * Highlight queries capture leaf nodes (tokens and identifiers) onto
 * the faces the theme styles. Where a capture nests inside another —
 * a call inside an f-string, say — `splitIntoLineRuns` keeps the outer
 * one.
 *
 * Some grammars (Markdown, HTML, PHP) describe documents whose nodes
 * contain source in *another* language: a fenced code block, a
 * `<script>` body, a `<?php ... ?>` block. An optional second query —
 * the *injection query* — captures those regions paired with a
 * language tag, and the highlighter runs the inner language's
 * highlighter recursively on each region. The outer face on an
 * injected region is dropped; the inner ranges take its place.
 * Recursion is depth-capped to guard against grammar-pair cycles.
 */

import { Language, Parser, Query } from '../vendor/web-tree-sitter.js';
import { splitIntoLineRuns } from './runs.js';
import {
  augmentQuery,
  rulesSignature,
  dedupeExactRanges,
} from './highlight-overrides.js';

/** Where the vendored WebAssembly files are served. */
const VENDOR = 'app://editor/packages/renderer/vendor';

/**
 * Maximum nesting depth for language injection. PHP → HTML → JS/CSS is
 * a legitimate three-level chain; four is one beyond that, leaving room
 * for one unanticipated layer while still terminating any pathological
 * grammar-pair that injects each other. When the cap is reached, the
 * outer face survives on the would-be-injected range.
 *
 * Exported so tests can assert against the limit without hard-coding.
 */
export const MAX_INJECTION_DEPTH = 4;

/**
 * @typedef {{ start: number, end: number, face: string }} CaptureRange
 *   Absolute character offsets in the highlighted text.
 */

/**
 * @typedef {object} NodeInfo
 * @property {string} type - The tree-sitter node type at the position.
 * @property {number} start - Start offset (inclusive).
 * @property {number} end - End offset (exclusive).
 * @property {string[]} ancestors - The node-type chain from the
 *   immediate parent outward, capped at a small number of levels.
 */

/**
 * @typedef {object} Highlighter
 * @property {(text: string, modeName?: string | null) =>
 *   import('./highlight.js').Run[][]} highlight -
 *   Highlight source into one array of runs per line. The optional
 *   `modeName` (the buffer's major-mode display name) selects mode-scoped
 *   user override rules; omit it for a base highlight.
 * @property {(text: string, depth?: number, modeName?: string | null) =>
 *   CaptureRange[]} captures -
 *   Raw absolute-offset capture ranges. Used by the injection pipeline
 *   to splice an inner language's tokens into an outer document.
 * @property {(text: string, pos: number) => NodeInfo | null} nodeAtPoint -
 *   The smallest tree-sitter node covering POS in TEXT, plus its
 *   parent-type chain. Powers the diagnostic side of
 *   `describe-face-at-point`: when no capture covers point, the user
 *   still needs to know what tree-sitter calls the construct so they
 *   can write a query rule. Returns null for empty input or when no
 *   node covers POS.
 * @property {(text: string) => import('./folding.js').FoldCapture[]} [foldCaptures] -
 *   Absolute-offset ranges of foldable scopes (`(node) @fold` matches),
 *   present when the language declared a `foldQuery`. Single-line
 *   captures are *not* filtered here — the pure `foldRanges` consumer
 *   handles that.
 */

/**
 * @typedef {object} CreateHighlighterOptions
 * @property {string} [injectionQuery] -
 *   A second tree-sitter query whose matches each pair an
 *   `@injection.content` capture (the region to inject into) with a
 *   language tag — either an `@injection.language` capture whose text
 *   is the tag, or a `(#set! injection.language "name")` predicate.
 * @property {(tag: string) => Highlighter | undefined} [getHighlighter] -
 *   Look up the highlighter to use for an injection's language tag.
 *   Required when `injectionQuery` is set; missing inner highlighters
 *   degrade gracefully (the outer face survives on that region).
 * @property {string} [foldQuery] -
 *   A query whose `@fold` captures mark foldable nodes. When set, the
 *   returned highlighter exposes `foldCaptures(text)` for the view
 *   layer to consume (`./folding.js`).
 * @property {string} [tag] -
 *   The language tag for this highlighter. Required to consult the
 *   user-override store (rules are keyed by language tag and major-mode
 *   name). Absent for injection-only or test highlighters.
 * @property {import('./highlight-overrides.js').OverrideStore} [overrideStore] -
 *   The live store of user-defined `kind -> face` highlight rules. When
 *   present, `highlight`/`captures` augment the base query with the
 *   effective rules for the (tag, modeName) being highlighted, recompiling
 *   the `Query` only when the effective rule set changes.
 */

/** The web-tree-sitter runtime is initialised once, lazily. */
let runtimeReady = null;
function initRuntime() {
  if (runtimeReady === null) {
    runtimeReady = Parser.init({ locateFile: (name) => `${VENDOR}/${name}` });
  }
  return runtimeReady;
}

/**
 * Create a tree-sitter highlighter from a vendored grammar and a query.
 * Asynchronous: it loads the runtime and the grammar.
 *
 * @param {string} grammarFile - A `.wasm` file name in `../vendor/`.
 * @param {string} querySource - The highlight query.
 * @param {CreateHighlighterOptions} [options]
 * @returns {Promise<Highlighter>}
 */
export async function createTreeSitterHighlighter(
  grammarFile,
  querySource,
  options = {}
) {
  await initRuntime();

  const response = await fetch(`${VENDOR}/${grammarFile}`);
  const language = await Language.load(
    new Uint8Array(await response.arrayBuffer())
  );

  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, querySource);
  const injectionQuery = options.injectionQuery
    ? new Query(language, options.injectionQuery)
    : null;
  const foldQuery = options.foldQuery
    ? new Query(language, options.foldQuery)
    : null;
  const getHighlighter = options.getHighlighter;
  const injectionProvider =
    typeof options.injectionProvider === 'function'
      ? options.injectionProvider
      : null;
  const tag = typeof options.tag === 'string' ? options.tag : null;
  const overrideStore = options.overrideStore ?? null;

  // The augmented `Query` is cached by the effective rule-set signature
  // so a recompile happens only when the user's rules change — not on
  // every keystroke. A signature of '' means "no rules", and we fall back
  // to the base `query` (no recompile, ever, in the common case).
  let cachedSig = null;
  /** @type {Query | null} */
  let cachedQuery = null;

  /**
   * The `Query` to run for a buffer in MODENAME: the base query when the
   * user has no rules for this (tag, mode), or a cached augmented query
   * otherwise. A user rule that fails to compile is dropped wholesale for
   * that signature (we keep the base query) so a bad rule never blanks the
   * buffer — the engine "guards" exactly as the spike showed it must.
   *
   * @param {string | null} modeName
   * @returns {Query}
   */
  function queryFor(modeName) {
    if (!overrideStore || !tag) return query;
    const rules = overrideStore.rulesFor(tag, modeName ?? null);
    const sig = rulesSignature(rules);
    if (sig === '') return query;
    if (sig === cachedSig && cachedQuery) return cachedQuery;
    try {
      const compiled = new Query(language, augmentQuery(querySource, rules));
      if (cachedQuery && cachedQuery !== query) cachedQuery.delete?.();
      cachedQuery = compiled;
      cachedSig = sig;
      return compiled;
    } catch {
      // A malformed user pattern: keep painting with the base query.
      cachedSig = sig;
      cachedQuery = query;
      return query;
    }
  }

  /**
   * @param {string} text
   * @param {number} depth - Current nesting depth; outermost call is 0.
   * @param {string | null} [modeName] - The buffer's major-mode display
   *   name, used to pick mode-scoped user rules. Null for injected
   *   regions (their host mode does not transfer) and test callers — they
   *   still get any language-wide ("everywhere") rules.
   * @returns {CaptureRange[]}
   */
  function captures(text, depth = 0, modeName = null) {
    const tree = parser.parse(text);
    const activeQuery = queryFor(modeName);
    /** @type {CaptureRange[]} */
    let outerRanges = activeQuery.captures(tree.rootNode).map((capture) => ({
      start: capture.node.startIndex,
      end: capture.node.endIndex,
      face: capture.name,
    }));
    // When an augmented (user-rule) query ran, a user rule may capture the
    // very same node as a built-in rule; collapse those exact-span twins
    // (user-appended-last wins) so the override takes effect cleanly and
    // the line splitter sees no spurious exact overlap. Skipped on the
    // base path (activeQuery === query) — zero overhead for the common case.
    if (activeQuery !== query) {
      outerRanges = dedupeExactRanges(outerRanges);
    }
    const injections = injectionQuery
      ? collectInjections(injectionQuery, tree.rootNode)
      : [];
    // A code-driven injection source (e.g. Markdown `$…$` math → latex)
    // supplements the query matches. Its ranges are offsets into `text`.
    if (injectionProvider) {
      for (const inj of injectionProvider(text)) injections.push(inj);
    }
    tree.delete();
    return spliceInjections(
      text,
      outerRanges,
      injections,
      getHighlighter,
      depth
    );
  }

  /**
   * @param {string} text
   * @param {number} pos
   * @returns {NodeInfo | null}
   */
  function nodeAtPoint(text, pos) {
    if (typeof text !== 'string' || text.length === 0) return null;
    const tree = parser.parse(text);
    const node = tree.rootNode.descendantForIndex(pos, pos);
    if (!node) {
      tree.delete();
      return null;
    }
    const ancestors = [];
    let current = node.parent;
    // Four levels is enough context to write a query rule against
    // without flooding the report.
    while (current && ancestors.length < 4) {
      ancestors.push(current.type);
      current = current.parent;
    }
    const info = {
      type: node.type,
      start: node.startIndex,
      end: node.endIndex,
      ancestors,
    };
    tree.delete();
    return info;
  }

  /**
   * Collect `@fold` captures over `text` as absolute character offsets.
   * Returns an empty list when no fold query was given. Single-line
   * captures are kept here; the pure `foldRanges` consumer drops them.
   *
   * @param {string} text
   * @returns {import('./folding.js').FoldCapture[]}
   */
  function foldCaptures(text) {
    if (!foldQuery) return [];
    const tree = parser.parse(text);
    const matches = foldQuery.captures(tree.rootNode);
    /** @type {import('./folding.js').FoldCapture[]} */
    const ranges = matches.map((m) => ({
      start: m.node.startIndex,
      end: m.node.endIndex,
    }));
    tree.delete();
    return ranges;
  }

  /** @type {Highlighter} */
  const highlighter = {
    highlight(text, modeName = null) {
      return splitIntoLineRuns(text, captures(text, 0, modeName));
    },
    captures,
    nodeAtPoint,
  };
  if (foldQuery) highlighter.foldCaptures = foldCaptures;
  return highlighter;
}

/**
 * Merge outer-grammar captures with the inner-language captures their
 * injection regions produce. The pure heart of the injection algorithm
 * — no parser, no query, no I/O — so the test suite can exercise it
 * directly without loading any grammar.
 *
 * For each injection, the inner highlighter (looked up via `getHighlighter`)
 * is called recursively with `depth + 1`; its returned ranges are
 * shifted by the injection's start so they live in the outer
 * coordinate space. Outer ranges fully contained in any *live*
 * injection (one whose inner highlighter resolved) are dropped — the
 * inner ranges take their place. Outer ranges that fall outside every
 * live injection, or inside a missing one, survive untouched.
 *
 * Recursion stops at {@link MAX_INJECTION_DEPTH}: at the cap the
 * outer ranges are returned as-is, leaving the outer face on what
 * would have been an injected region.
 *
 * @param {string} text - The text the outer captures are over.
 * @param {CaptureRange[]} outerRanges
 * @param {{ start: number, end: number, language: string }[]} injections
 * @param {((tag: string) => Highlighter | undefined) | undefined} getHighlighter
 * @param {number} depth - Outer call is 0; recursive call is parent + 1.
 * @returns {CaptureRange[]}
 */
export function spliceInjections(
  text,
  outerRanges,
  injections,
  getHighlighter,
  depth
) {
  if (
    !getHighlighter ||
    injections.length === 0 ||
    depth >= MAX_INJECTION_DEPTH
  ) {
    return outerRanges;
  }

  /** @type {{ start: number, end: number }[]} */
  const liveInjections = [];
  /** @type {CaptureRange[]} */
  const innerRanges = [];

  for (const injection of injections) {
    const inner = getHighlighter(injection.language);
    if (!inner || typeof inner.captures !== 'function') continue;
    const sliced = text.slice(injection.start, injection.end);
    const ranges = inner.captures(sliced, depth + 1);
    for (const r of ranges) {
      innerRanges.push({
        start: r.start + injection.start,
        end: r.end + injection.start,
        face: r.face,
      });
    }
    liveInjections.push({ start: injection.start, end: injection.end });
  }

  if (liveInjections.length === 0) return outerRanges;

  const filteredOuter = outerRanges.filter(
    (r) => !rangeFullyContainedInAny(r, liveInjections)
  );
  return filteredOuter.concat(innerRanges);
}

/**
 * Pull `{ start, end, language }` from an injection query's matches.
 * The language tag comes from either an `@injection.language` capture
 * (its node text) or a `(#set! injection.language "name")` directive.
 * Matches missing either the content capture or the language tag are
 * silently skipped — that's how the grammar marks "no inner language
 * for this region".
 *
 * @param {object} injectionQuery
 * @param {object} rootNode
 * @returns {{ start: number, end: number, language: string }[]}
 */
function collectInjections(injectionQuery, rootNode) {
  const matches = injectionQuery.matches(rootNode);
  const result = [];
  for (const match of matches) {
    let contentNode = null;
    let languageFromCapture = null;
    for (const capture of match.captures) {
      if (capture.name === 'injection.content') contentNode = capture.node;
      else if (capture.name === 'injection.language') {
        languageFromCapture = capture.node.text;
      }
    }
    if (!contentNode) continue;
    const language =
      languageFromCapture ??
      match.setProperties?.['injection.language'] ??
      null;
    if (!language) continue;
    result.push({
      start: contentNode.startIndex,
      end: contentNode.endIndex,
      language,
    });
  }
  return result;
}

/**
 * True if range `r` is fully inside any of the given regions. Used to
 * drop outer-highlighter captures that the inner highlighter is about
 * to replace.
 *
 * @param {{ start: number, end: number }} r
 * @param {{ start: number, end: number }[]} regions
 */
function rangeFullyContainedInAny(r, regions) {
  for (const region of regions) {
    if (r.start >= region.start && r.end <= region.end) return true;
  }
  return false;
}
