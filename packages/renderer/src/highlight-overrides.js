/**
 * @file highlight-overrides.js — the JS engine that applies the user's
 * Lisp-defined `kind -> face` highlight rules ON TOP of a language's
 * built-in tree-sitter highlight query.
 *
 * The governing principle: JavaScript holds the DEFAULTS (the per-language
 * `QUERY` strings in `./languages/*.js`); the user OVERRIDES/EXTENDS them
 * from Lisp, live. The user's rules never edit those files. Instead Lisp
 * pushes a rule set into this engine; the highlighter appends the rules to
 * the base query string, recompiles the tree-sitter `Query`, and re-paints
 * — no restart.
 *
 * A *rule* maps a tree-sitter pattern to a face name:
 *
 *   { pattern: '(identifier)', face: 'variable' }
 *   { pattern: '(generic_command (command_name) @x)', face: 'keyword' }
 *
 * The pattern is a tree-sitter query fragment. The simple case is a bare
 * node-type — `augmentQuery` wraps it so `command` becomes `(command)`. A
 * fragment that already contains its own `@capture` is appended verbatim
 * EXCEPT its capture name is rewritten to the rule's face, so the user
 * picks the face by name, not by editing the capture.
 *
 * Two scopes (mirrored in the Lisp store, see `highlight-rules.lisp`):
 *   - per major-mode  — applies only when the buffer is in that mode
 *   - per language    — applies to every buffer of that language ("everywhere")
 *
 * This module is pure data/string transformation plus a small stateful
 * store; it owns no tree-sitter objects. The grammar-bearing recompile
 * lives in `treesitter.js` (which calls `augmentQuery` + `new Query`).
 * Keeping the transforms here lets the unit suite exercise them without a
 * tree-sitter runtime.
 */

/**
 * @typedef {{ pattern: string, face: string }} HighlightRule
 *   A user rule: a tree-sitter pattern fragment mapped to a face name.
 */

/** True for a bare node-type token like `identifier` or `command_name`
 *  (letters, digits, underscores only — no parens, no capture). */
function isBareNodeType(pattern) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(pattern.trim());
}

/**
 * Render one rule as a tree-sitter query clause that captures onto the
 * rule's face. Three shapes are accepted for `pattern`:
 *
 *   - a bare node type  → `(type) @face`
 *   - a parenthesised pattern with no capture → `(pattern) @face`
 *   - a fragment that already carries `@something` → its LAST capture is
 *     rewritten to `@face` (the user names the face; the fragment shape
 *     decides which node is captured)
 *
 * @param {HighlightRule} rule
 * @returns {string}
 */
export function ruleToClause(rule) {
  const face = String(rule.face ?? '').trim();
  const raw = String(rule.pattern ?? '').trim();
  if (face === '' || raw === '') return '';
  if (isBareNodeType(raw)) {
    return `(${raw}) @${face}`;
  }
  // Does the fragment already declare a capture? Rewrite the last one.
  if (/@[A-Za-z_][A-Za-z0-9_.]*/.test(raw)) {
    return raw.replace(/@[A-Za-z_][A-Za-z0-9_.]*(?![\s\S]*@)/, `@${face}`);
  }
  // A parenthesised pattern with no capture — capture the whole thing.
  return `${raw} @${face}`;
}

/**
 * Append the user rules to a base highlight query. The extra clauses come
 * AFTER the base ones; tree-sitter's "first match in document order wins"
 * combined with the editor's smallest-range preference means a narrow user
 * rule still surfaces where it should, and a user rule for an otherwise
 * unpainted node simply adds a new capture.
 *
 * Rules with an empty face or pattern are skipped. The result is always a
 * superset of the base query string.
 *
 * @param {string} baseQuery - The language's built-in highlight query.
 * @param {HighlightRule[]} rules - The user rules to layer on top.
 * @returns {string}
 */
export function augmentQuery(baseQuery, rules) {
  const base = typeof baseQuery === 'string' ? baseQuery : '';
  if (!Array.isArray(rules) || rules.length === 0) return base;
  const clauses = rules
    .map(ruleToClause)
    .filter((c) => c !== '');
  if (clauses.length === 0) return base;
  return (
    `${base}\n; --- user highlight overrides ---\n${clauses.join('\n')}\n`
  );
}

/**
 * Collapse capture ranges that share an EXACT (start, end) span, keeping
 * the LAST one. A user override rule is appended after the base query, so
 * when it captures the very same node as a built-in rule both produce a
 * range with identical bounds; keeping the last makes the user's face win
 * and — crucially — removes the exact-overlap that would otherwise make
 * `splitIntoLineRuns` emit a (harmless but noisy) overlap warning on
 * every highlight. Genuinely *nested* ranges (different bounds) are left
 * untouched; the line splitter resolves those as it always has.
 *
 * Order within the input is otherwise preserved (the result is filtered
 * in place by a last-wins map keyed on `start:end`).
 *
 * @param {CaptureRangeLike[]} ranges
 * @returns {CaptureRangeLike[]}
 * @typedef {{ start: number, end: number, face: string }} CaptureRangeLike
 */
export function dedupeExactRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return ranges;
  // Index of the LAST occurrence for each exact span.
  const lastIndex = new Map();
  for (let i = 0; i < ranges.length; i += 1) {
    const r = ranges[i];
    lastIndex.set(`${r.start}:${r.end}`, i);
  }
  // Fast path: no exact duplicates → return the input unchanged.
  if (lastIndex.size === ranges.length) return ranges;
  const out = [];
  for (let i = 0; i < ranges.length; i += 1) {
    const r = ranges[i];
    if (lastIndex.get(`${r.start}:${r.end}`) === i) out.push(r);
  }
  return out;
}

/**
 * A stable signature for a rule list — used as a cache key so the
 * highlighter recompiles the `Query` only when the rule set actually
 * changes. Order matters (it changes match precedence), so this is NOT
 * sorted.
 *
 * @param {HighlightRule[]} rules
 * @returns {string}
 */
export function rulesSignature(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  return rules.map((r) => `${r.pattern ?? ''}=>${r.face ?? ''}`).join('|');
}

/**
 * The live store of user highlight rules, keyed by scope.
 *
 * Scope keys are plain strings:
 *   - a language tag for "everywhere (this language)" rules
 *   - a `mode:<Mode Name>` key for "this major mode only" rules
 *
 * Keeping mode and language buckets in one flat map (disambiguated by the
 * `mode:` prefix) lets the highlighter assemble the effective rule list
 * for a given (language, modeName) with two lookups.
 */
export function createHighlightOverrideStore() {
  /** @type {Map<string, HighlightRule[]>} */
  let buckets = new Map();
  /** Bumped on every replace so the highlighter can detect staleness
   *  even when a recompile would otherwise hit a same-text cache. */
  let generation = 0;

  /** The scope key for a major-mode bucket. */
  const modeKey = (modeName) => `mode:${modeName}`;

  return {
    /**
     * Replace the whole store from a flat list of scoped rules. Called by
     * the host primitive that pushes the Lisp rule set in. Each entry is
     * `{ scope: 'language'|'mode', key, pattern, face }` where `key` is
     * the language tag (for `language`) or the mode display name (for
     * `mode`).
     *
     * @param {{ scope: string, key: string, pattern: string, face: string }[]} entries
     */
    replaceAll(entries) {
      const next = new Map();
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (!e || typeof e.pattern !== 'string' || typeof e.face !== 'string') {
            continue;
          }
          const bucket =
            e.scope === 'mode' ? modeKey(String(e.key)) : String(e.key);
          if (!next.has(bucket)) next.set(bucket, []);
          next.get(bucket).push({ pattern: e.pattern, face: e.face });
        }
      }
      buckets = next;
      generation += 1;
    },

    /**
     * The effective rules for a buffer of LANGUAGE in MODENAME: the
     * language ("everywhere") rules first, then the mode-scoped rules.
     * Mode rules come last so a mode-specific override wins where it
     * overlaps a language-wide one (later clause, smaller range, etc.).
     *
     * @param {string} language - The tree-sitter language tag.
     * @param {string | null} modeName - The buffer's major-mode display name.
     * @returns {HighlightRule[]}
     */
    rulesFor(language, modeName) {
      const out = [];
      const lang = buckets.get(language);
      if (lang) out.push(...lang);
      if (modeName) {
        const mode = buckets.get(modeKey(modeName));
        if (mode) out.push(...mode);
      }
      return out;
    },

    /** The current generation counter (changes on every replaceAll). */
    generation() {
      return generation;
    },
  };
}
