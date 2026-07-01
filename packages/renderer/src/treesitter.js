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
 * @typedef {object} ProvidedCaptures
 * @property {CaptureRange[]} captures - Code-driven captures to paint,
 *   merged after the injection splice. They may overlap grammar
 *   captures: the run splitter resolves overlaps innermost-wins, with
 *   exact-span ties going to the later input — i.e. to these.
 * @property {{ start: number, end: number }[]} [regions] - Spans the
 *   provider *owns*. Grammar and injected captures are clipped out of
 *   them (exactly as injection regions clip outer captures), so a
 *   construct the grammar mis-parses — a `:::` directive line read as a
 *   paragraph, a metadata header read as a setext heading — renders
 *   only the provider's faces.
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
 * @property {(text: string) => ProvidedCaptures} [captureProvider] -
 *   A code-driven capture source for constructs the grammar has no
 *   nodes for (a dialect's extra syntax over a stock grammar). Runs on
 *   the *whole* document — never on injected slices — after the
 *   injection splice. See {@link ProvidedCaptures} and
 *   {@link applyCaptureProvider}.
 * @property {(text: string) => import('./folding.js').FoldCapture[]} [foldProvider] -
 *   A code-driven fold source, merged with `foldQuery`'s captures (a
 *   language may declare either or both). For foldable constructs the
 *   grammar has no nodes for — `:::` directive blocks, `@begin/@end`
 *   environments.
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
 * Copy a fold capture produced by a `foldProvider` (a custom scanner such as
 * jmarkdown's), preserving the optional fold flavours — inner-fold delimiter
 * offsets and the `block` marker (jmarkdown @begin/@end) — not just
 * `start`/`end`. Pure; the regression guard for the bug where these flags were
 * dropped on the way from the scanner to the view.
 *
 * @param {import('./folding.js').FoldCapture} r
 * @returns {import('./folding.js').FoldCapture}
 */
export function normalizeProviderFold(r) {
  const range = { start: r.start, end: r.end };
  if (typeof r.innerStart === 'number') range.innerStart = r.innerStart;
  if (typeof r.innerEnd === 'number') range.innerEnd = r.innerEnd;
  if (r.block) range.block = true;
  return range;
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
  const captureProvider =
    typeof options.captureProvider === 'function'
      ? options.captureProvider
      : null;
  const foldProvider =
    typeof options.foldProvider === 'function' ? options.foldProvider : null;
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
    const spliced = spliceInjections(
      text,
      outerRanges,
      injections,
      getHighlighter,
      depth
    );
    return captureProvider
      ? applyCaptureProvider(spliced, captureProvider(text))
      : spliced;
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
   * Collect foldable scopes over `text` as absolute character offsets:
   * the fold query's `@fold` captures (when a query was given), the fold
   * provider's ranges (when one was given), and — crucially — the folds
   * of any *injected* regions, recursively, offset-adjusted into this
   * text's coordinates. That last part is what lets a PHP buffer fold its
   * embedded HTML elements and an HTML buffer fold the JS inside a
   * `<script>`. Single-line captures are kept here; the pure `foldRanges`
   * consumer drops them.
   *
   * @param {string} text
   * @param {number} [depth] - Injection nesting depth; outermost is 0.
   * @returns {import('./folding.js').FoldCapture[]}
   */
  function foldCaptures(text, depth = 0) {
    /** @type {import('./folding.js').FoldCapture[]} */
    const ranges = [];
    /** @type {{ start: number, end: number, language: string }[]} */
    const injections = [];
    // One parse serves both the fold query and injection collection.
    if (foldQuery || injectionQuery) {
      const tree = parser.parse(text);
      if (foldQuery) {
        for (const m of foldQuery.captures(tree.rootNode)) {
          const range = { start: m.node.startIndex, end: m.node.endIndex };
          // `@fold.inner` opts a delimited construct into column-aware
          // folding: collapse the *inner* content, leaving the opening
          // and closing delimiters (`<p>…</p>`, `{…}`). The delimiters
          // are the node's first and last children; their inner edges
          // become cut columns in the pure `foldRanges`. A degenerate
          // span (no inner gap) silently degrades to a line-based fold.
          if (m.name === 'fold.inner') {
            const open = m.node.firstChild;
            const close = m.node.lastChild;
            if (open && close && open !== close && open.endIndex < close.startIndex) {
              range.innerStart = open.endIndex;
              range.innerEnd = close.startIndex;
            }
          }
          ranges.push(range);
        }
      }
      if (injectionQuery) {
        injections.push(...collectInjections(injectionQuery, tree.rootNode));
      }
      tree.delete();
    }
    if (foldProvider) {
      // Carry the optional fold flavours a scanner can set (inner-fold
      // delimiter offsets, the `block` marker) — not just start/end, or the
      // view never sees them.
      for (const r of foldProvider(text)) ranges.push(normalizeProviderFold(r));
    }
    if (injectionProvider) {
      for (const inj of injectionProvider(text)) injections.push(inj);
    }
    return mergeInjectedFolds(text, ranges, injections, getHighlighter, depth);
  }

  /** @type {Highlighter} */
  const highlighter = {
    highlight(text, modeName = null) {
      return splitIntoLineRuns(text, captures(text, 0, modeName));
    },
    captures,
    nodeAtPoint,
  };
  // Publish `foldCaptures` when the language can produce folds: its own
  // (query/provider) OR folds reachable through an injection (so a PHP
  // buffer with no PHP-level fold query still folds its embedded HTML).
  if (
    foldQuery ||
    foldProvider ||
    ((injectionQuery || injectionProvider) && getHighlighter)
  ) {
    highlighter.foldCaptures = foldCaptures;
  }
  return highlighter;
}

/**
 * Merge a capture provider's output into the (already injection-spliced)
 * capture list. The pure counterpart of {@link spliceInjections} for the
 * `captureProvider` option, exported so tests can exercise it without
 * loading a grammar.
 *
 * The provider's `regions` are spans it owns: every existing range is
 * clipped against them, exactly as injection regions clip outer
 * captures, so a grammar's mis-parse of dialect syntax cannot bleed
 * through. The provider's `captures` are then appended — last, so an
 * exact-span tie with a grammar capture resolves to the provider in
 * `flattenInnermost` (later input wins).
 *
 * @param {CaptureRange[]} ranges - Captures after the injection splice.
 * @param {ProvidedCaptures} provided - The capture provider's output.
 * @returns {CaptureRange[]}
 */
export function applyCaptureProvider(ranges, provided) {
  if (!provided || typeof provided !== 'object') return ranges;
  const captures = Array.isArray(provided.captures) ? provided.captures : [];
  const regions = Array.isArray(provided.regions) ? provided.regions : [];
  const base =
    regions.length === 0
      ? ranges
      : ranges.flatMap((r) => clipRangeAgainstRegions(r, regions));
  return captures.length === 0 ? base : base.concat(captures);
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
 * Live injections may themselves overlap — a code-driven provider's
 * region (LaTeX into a dialect's verbatim block) inside a query's
 * region (a paragraph into an inline grammar). The *later* injection
 * in the list wins the overlap: an earlier injection's inner ranges
 * are clipped against every later live region, exactly as outer ranges
 * are clipped against all of them. Provider injections are appended
 * after query injections (see `captures`), so a provider can override
 * the grammar's injection on the spans it knows better.
 *
 * Recursion stops at {@link MAX_INJECTION_DEPTH}: at the cap the
 * outer ranges are returned as-is, leaving the outer face on what
 * would have been an injected region.
 *
 * An injection may carry optional `wrapPrefix`/`wrapSuffix` strings:
 * the inner highlighter then runs on `wrapPrefix + slice + wrapSuffix`
 * and its captures are mapped back onto the real slice (shifted by the
 * prefix, clipped to the slice). Only code-driven injections set them —
 * JMarkdown wraps a directive's `{…}` attribute list as `<x … />` so
 * tree-sitter-html captures the attributes. The live-injection region
 * is always the real span, so clipping is unaffected.
 *
 * @param {string} text - The text the outer captures are over.
 * @param {CaptureRange[]} outerRanges
 * @param {{ start: number, end: number, language: string,
 *   wrapPrefix?: string, wrapSuffix?: string }[]} injections
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
  /** @type {CaptureRange[][]} Inner ranges per live injection, in order. */
  const innerByInjection = [];

  for (const injection of injections) {
    const inner = getHighlighter(injection.language);
    if (!inner || typeof inner.captures !== 'function') continue;
    const raw = text.slice(injection.start, injection.end);
    // A code-driven injection may ask to be highlighted inside a
    // synthetic context the inner grammar needs but the document does
    // not contain: JMarkdown injects a directive's `{…}` attribute list
    // into html wrapped as `<x … />`, because tree-sitter-html only
    // captures attributes that sit inside a tag. The inner highlighter
    // runs on `wrapPrefix + raw + wrapSuffix`; its captures are shifted
    // back by the prefix length and clipped to the real span, so the
    // wrapper's own captures (the synthetic `<x` / `/>`) fall away and
    // only faces landing on document text survive. Absent a wrapper —
    // every query injection and most providers — the prefix/suffix are
    // '' and this is the identity mapping the callers relied on before.
    const pre =
      typeof injection.wrapPrefix === 'string' ? injection.wrapPrefix : '';
    const suf =
      typeof injection.wrapSuffix === 'string' ? injection.wrapSuffix : '';
    const ranges = inner.captures(pre + raw + suf, depth + 1);
    /** @type {CaptureRange[]} */
    const mapped = [];
    for (const r of ranges) {
      const s = r.start - pre.length;
      const e = r.end - pre.length;
      if (e <= 0 || s >= raw.length) continue; // wholly inside the wrapper
      mapped.push({
        start: Math.max(0, s) + injection.start,
        end: Math.min(raw.length, e) + injection.start,
        face: r.face,
      });
    }
    innerByInjection.push(mapped);
    liveInjections.push({ start: injection.start, end: injection.end });
  }

  if (liveInjections.length === 0) return outerRanges;

  // Where live injections overlap, the later one owns the overlap: clip
  // each injection's inner ranges against every *later* live region.
  /** @type {CaptureRange[]} */
  const innerRanges = [];
  for (let k = 0; k < innerByInjection.length; k += 1) {
    const laterRegions = liveInjections.slice(k + 1);
    if (laterRegions.length === 0) {
      innerRanges.push(...innerByInjection[k]);
    } else {
      for (const r of innerByInjection[k]) {
        innerRanges.push(...clipRangeAgainstRegions(r, laterRegions));
      }
    }
  }

  // Clip every outer range against the live injection regions: the inner
  // highlighter owns those regions, so the outer range keeps only the
  // sub-spans that fall outside every injection. Fully-contained outer
  // ranges clip to nothing (the old drop behaviour); a range that merely
  // *crosses* an injection boundary — common where the outer grammar
  // captures the math delimiters the LaTeX injection also spans — keeps
  // its outside part and yields the overlap to the inner face. This is
  // what stops `splitIntoLineRuns` seeing overlapping input (the warning),
  // and renders the boundary with the injected language's face.
  const clippedOuter = outerRanges.flatMap((r) =>
    clipRangeAgainstRegions(r, liveInjections)
  );
  return clippedOuter.concat(innerRanges);
}

/**
 * Merge the folds of injected regions into an outer fold list. For each
 * injection whose inner highlighter exposes `foldCaptures`, recurse into
 * the region, offset-adjust every fold (its `start`/`end` and the
 * optional inner-fold cut offsets `innerStart`/`innerEnd`) back into the
 * outer text's coordinates, and append. This is what lets a PHP buffer
 * fold its embedded HTML and an HTML buffer fold the JS inside a
 * `<script>`. The pure analog of {@link spliceInjections} for folding —
 * exported so it can be tested with stub highlighters, no grammar load.
 *
 * Unlike highlight splicing, folds need no clipping: the pure
 * `foldRanges` / `indexFoldRanges` already sort, dedup by start line and
 * nest by containment, so overlapping outer/inner folds resolve cleanly.
 * Recursion stops at {@link MAX_INJECTION_DEPTH}; at the cap the outer
 * folds are returned unchanged.
 *
 * @param {string} text - The text the outer folds are over.
 * @param {import('./folding.js').FoldCapture[]} outerFolds
 * @param {{ start: number, end: number, language: string }[]} injections
 * @param {((tag: string) => { foldCaptures?: Function } | undefined) | undefined} getHighlighter
 * @param {number} depth - Outer call is 0; recursive call is parent + 1.
 * @returns {import('./folding.js').FoldCapture[]}
 */
export function mergeInjectedFolds(text, outerFolds, injections, getHighlighter, depth) {
  if (
    !getHighlighter ||
    injections.length === 0 ||
    depth >= MAX_INJECTION_DEPTH
  ) {
    return outerFolds;
  }
  const merged = outerFolds.slice();
  for (const injection of injections) {
    const inner = getHighlighter(injection.language);
    if (!inner || typeof inner.foldCaptures !== 'function') continue;
    const sliced = text.slice(injection.start, injection.end);
    for (const f of inner.foldCaptures(sliced, depth + 1)) {
      const adjusted = {
        start: f.start + injection.start,
        end: f.end + injection.start,
      };
      if (typeof f.innerStart === 'number') {
        adjusted.innerStart = f.innerStart + injection.start;
      }
      if (typeof f.innerEnd === 'number') {
        adjusted.innerEnd = f.innerEnd + injection.start;
      }
      merged.push(adjusted);
    }
  }
  return merged;
}

/**
 * Subtract `regions` from range `r`, returning the sub-ranges of `r`
 * (0, 1, or more) that fall outside every region, each carrying `r`'s
 * face. A region that splits `r` in two yields a left and a right
 * piece; a region covering `r` yields none.
 *
 * @param {CaptureRange} r
 * @param {{ start: number, end: number }[]} regions
 * @returns {CaptureRange[]}
 */
function clipRangeAgainstRegions(r, regions) {
  let pieces = [{ start: r.start, end: r.end }];
  for (const region of regions) {
    const next = [];
    for (const p of pieces) {
      if (region.end <= p.start || region.start >= p.end) {
        next.push(p); // no overlap — keep the piece whole
        continue;
      }
      if (p.start < region.start) next.push({ start: p.start, end: region.start });
      if (region.end < p.end) next.push({ start: region.end, end: p.end });
      // The span inside the region is dropped (the inner face owns it).
    }
    pieces = next;
  }
  return pieces.map((p) => ({ start: p.start, end: p.end, face: r.face }));
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

