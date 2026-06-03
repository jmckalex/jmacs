/**
 * @file Citation.js wrapper — parse BibTeX / BibLaTeX / CSL-JSON and
 * format entries via CSL styles.
 *
 * The heavy library is committed under `../vendor/citation-js.esm.js`
 * (built by `scripts/build-citation-js.js` from `@citation-js/core` +
 * `@citation-js/plugin-bibtex` + `@citation-js/plugin-csl`). This
 * module is the thin host-facing surface — the desktop app's
 * primitives call into it and route results back to the Lisp side.
 *
 * Internal representation: a *bibliography handle* is the CSL-JSON
 * array of entries the user has loaded. We expose it to Lisp as a
 * JSON-encoded string so primitives don't have to marshal arbitrary
 * shapes; the round-trip is cheap.
 */

import { Cite } from '../vendor/citation-js.esm.js';

/**
 * Parse a citation source (BibTeX / BibLaTeX / CSL-JSON / many
 * others — Citation.js auto-detects from content) and return the
 * resulting CSL-JSON entries as a JSON string.
 *
 * @param {string} source
 * @returns {string} CSL-JSON serialised entries.
 * @throws {Error} when Citation.js can't parse the source.
 */
export function parseCitations(source) {
  const cite = new Cite(source);
  return JSON.stringify(cite.data);
}

/**
 * Format a CSL-JSON entry list (the output of `parseCitations`) as a
 * bibliography using the chosen CSL style and locale.
 *
 * @param {string} cslJsonSource - JSON string of CSL-JSON entries.
 * @param {object} [options]
 * @param {string} [options.style='apa'] - CSL style id.
 *   Common shipped styles: `apa`, `vancouver`, `harvard1`.
 * @param {string} [options.format='text'] - `'text'` | `'html'`.
 * @param {string} [options.lang='en-US'] - BCP-47 locale tag.
 * @returns {string} The formatted bibliography.
 */
export function formatBibliography(cslJsonSource, options = {}) {
  const entries = JSON.parse(cslJsonSource);
  const cite = new Cite(entries);
  return cite.format('bibliography', {
    template: options.style ?? 'apa',
    format: options.format ?? 'text',
    lang: options.lang ?? 'en-US',
  });
}

/**
 * Format a single in-text citation for an entry — `(Smith 2020)` or
 * the style's equivalent. Convenience over `formatBibliography` for
 * the inline-cite case.
 *
 * @param {string} cslJsonSource
 * @param {object} [options]
 * @param {string} [options.style='apa']
 * @param {string} [options.format='text']
 * @param {string} [options.lang='en-US']
 * @returns {string}
 */
export function formatCitation(cslJsonSource, options = {}) {
  const entries = JSON.parse(cslJsonSource);
  const cite = new Cite(entries);
  return cite.format('citation', {
    template: options.style ?? 'apa',
    format: options.format ?? 'text',
    lang: options.lang ?? 'en-US',
  });
}

/**
 * The cite keys (BibTeX `@article{KEY, ...}` keys, or CSL-JSON `id`
 * fields) present in a parsed source. Used by Lisp pickers to show
 * the user a choice of entries to cite from.
 *
 * @param {string} cslJsonSource
 * @returns {string[]}
 */
export function citationKeys(cslJsonSource) {
  const entries = JSON.parse(cslJsonSource);
  return entries.map((e) => (typeof e.id === 'string' ? e.id : '')).filter(Boolean);
}

/**
 * A best-effort projection of each parsed entry into the small shape a
 * citation picker needs: `{ key, author, year, title }`. CSL-JSON is
 * sprawling; this pulls out the few fields a one-line picker row shows.
 *
 *   - `key`    — the CSL `id` (the BibTeX key).
 *   - `author` — the first author's family name (falling back to a
 *                `given family` join, then the `literal` field for
 *                institutional authors); `null` when no author.
 *   - `year`   — the first `issued.date-parts` year as a number;
 *                `null` when absent.
 *   - `title`  — the `title` string; `null` when absent.
 *
 * Missing fields are `null` consistently so the caller can render a
 * placeholder.
 *
 * @param {string} cslJsonSource
 * @returns {Array<{key: string, author: (string|null), year: (number|null), title: (string|null)}>}
 */
export function citationEntries(cslJsonSource) {
  const entries = JSON.parse(cslJsonSource);
  return entries.map((e) => {
    const key = typeof e.id === 'string' ? e.id : '';

    let author = null;
    if (Array.isArray(e.author) && e.author.length > 0) {
      const first = e.author[0];
      if (first && typeof first === 'object') {
        if (typeof first.family === 'string' && first.family !== '') {
          author = typeof first.given === 'string' && first.given !== ''
            ? `${first.given} ${first.family}`
            : first.family;
        } else if (typeof first.literal === 'string' && first.literal !== '') {
          author = first.literal;
        }
      }
    }

    let year = null;
    const parts = e.issued && e.issued['date-parts'];
    if (Array.isArray(parts) && Array.isArray(parts[0]) && parts[0].length > 0) {
      const y = Number(parts[0][0]);
      if (Number.isFinite(y)) year = y;
    }

    const title = typeof e.title === 'string' ? e.title : null;

    return { key, author, year, title };
  });
}
