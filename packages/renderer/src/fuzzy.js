/**
 * @file Fuzzy filtering — ranking a list of strings against a query.
 * Pure and DOM-free, so it is tested on its own. Used by the command
 * palette to match command names.
 *
 * A candidate matches when the query's characters appear in it in
 * order (a subsequence). Matches are ranked: tighter ones (fewer gaps,
 * starting earlier) come first, then shorter candidates.
 */

/**
 * Score a query against a candidate. Lower is better.
 * @param {string} query - Lower-cased query.
 * @param {string} text - Lower-cased candidate.
 * @returns {number | null} The score, or `null` if it does not match.
 */
function score(query, text) {
  let from = 0;
  let gaps = 0;
  let firstIndex = -1;
  for (const ch of query) {
    const at = text.indexOf(ch, from);
    if (at === -1) return null;
    if (firstIndex === -1) firstIndex = at;
    gaps += at - from;
    from = at + 1;
  }
  return gaps + firstIndex;
}

/**
 * Filter and rank `items` against `query`.
 *
 * @param {string} query - The search query; empty returns all items
 *   sorted alphabetically.
 * @param {string[]} items - The candidates.
 * @returns {string[]} Matching items, best first.
 */
export function fuzzyFilter(query, items) {
  if (query === '') {
    return [...items].sort();
  }
  const lowered = query.toLowerCase();
  const scored = [];
  for (const item of items) {
    const s = score(lowered, item.toLowerCase());
    if (s !== null) {
      scored.push({ item, score: s });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.item.length - b.item.length);
  return scored.map((entry) => entry.item);
}
