/**
 * @file Citation host bridge — the SERVER-SIDE provision of the
 * `citation-*` host primitives.
 *
 * In the real (in-renderer) app these primitives live in `app.js` and
 * call into `packages/renderer/src/citation.js` — a thin wrapper over the
 * vendored Citation.js bundle (`packages/renderer/vendor/citation-js.esm.js`,
 * built from `@citation-js/core` + `@citation-js/plugin-bibtex` +
 * `@citation-js/plugin-csl`). That bundle is pure ESM with NO DOM/Electron
 * dependency, so under Model B the server (a Node `utilityProcess` / a bare
 * `node --test` process) imports the SAME `citation.js` directly and serves
 * the SAME primitives. No `/tmp`-resolution games: the import is a fixed
 * relative path into the repo's `packages/renderer/src`, so it resolves
 * against the repo's installed/vendored modules exactly like the renderer.
 *
 * The primitive bodies here MIRROR app.js's (same arg coercion, same
 * defaults — `apa` / `text` / `en-US`, same absence convention) so a bib
 * parses + formats to the SAME CSL string in both worlds. Two windows
 * showing the same document can't legitimately disagree about how a
 * bibliography formats → this is model-side state the server owns
 * (PRIMITIVE-SPLIT.md "RefTeX / citations").
 *
 * The bridge is DOM-free and takes no collaborators, so it is unit-tested
 * under `node --test` (citation-bridge.test.js) with no harness.
 */

import { keyword, cons, NIL, arrayToList } from '@editor/lisp';

import {
  parseCitations,
  parseCitationsLenient,
  formatBibliography,
  formatCitation,
  citationKeys,
  citationEntries,
  formatBibliographyEntries,
  registerCslStyle,
} from '../../../packages/renderer/src/citation.js';

/** Build a Lisp record (a JS `Map` with keyword keys) from a plain object.
 *  `null`/`undefined` values become NIL. Mirrors the convention in
 *  latex-primitives.js / app.js's `record`. */
function record(fields) {
  const map = new Map();
  for (const [key, value] of Object.entries(fields)) {
    map.set(keyword(key), value === null || value === undefined ? NIL : value);
  }
  return map;
}

/** A non-empty string from a Lisp argument, treating NIL/absent as ''. */
function asString(arg) {
  return arg != null && arg !== NIL ? String(arg) : '';
}

/** A keyword/string option argument, or DEFAULT when NIL/absent. */
function asOption(arg, fallback) {
  return arg != null && arg !== NIL ? String(arg) : fallback;
}

/**
 * The `citation-*` host primitives, backed by the renderer's citation.js.
 * Spread into the spine's interpreter primitives object. Each throws a
 * plain `Error` on a genuine parse/format failure (the interpreter turns
 * it into a LispError); an EMPTY input is the absence convention, not an
 * error (mirrors app.js).
 *
 * @returns {Record<string, (args: any[]) => any>}
 */
export function createCitationPrimitives() {
  return {
    // (citation-parse SOURCE) -> CSL-JSON handle string. Empty source -> "".
    'citation-parse': (args) => {
      const source = asString(args[0]);
      if (source === '') return '';
      try {
        return parseCitations(source);
      } catch (error) {
        throw new Error(`citation-parse: ${error?.message ?? error}`);
      }
    },

    // (citation-parse-lenient SOURCE) -> {:handle CSL-JSON :skipped N}.
    // Tolerant: one unparseable entry is skipped, not the whole bib.
    'citation-parse-lenient': (args) => {
      const source = asString(args[0]);
      try {
        const { json, skipped } = parseCitationsLenient(source);
        return record({ handle: json, skipped });
      } catch (error) {
        throw new Error(`citation-parse-lenient: ${error?.message ?? error}`);
      }
    },

    // (citation-format-bibliography HANDLE [STYLE [FORMAT [LANG]]]) -> string.
    'citation-format-bibliography': (args) => {
      const handle = asString(args[0]);
      if (handle === '') return '';
      const style = asOption(args[1], 'apa');
      const format = asOption(args[2], 'text');
      const lang = asOption(args[3], 'en-US');
      try {
        return formatBibliography(handle, { style, format, lang });
      } catch (error) {
        throw new Error(`citation-format-bibliography: ${error?.message ?? error}`);
      }
    },

    // (citation-format HANDLE [STYLE [FORMAT [LANG]]]) -> in-text cite string.
    'citation-format': (args) => {
      const handle = asString(args[0]);
      if (handle === '') return '';
      const style = asOption(args[1], 'apa');
      const format = asOption(args[2], 'text');
      const lang = asOption(args[3], 'en-US');
      try {
        return formatCitation(handle, { style, format, lang });
      } catch (error) {
        throw new Error(`citation-format: ${error?.message ?? error}`);
      }
    },

    // (citation-keys HANDLE) -> Lisp list of key strings (nil for empty).
    'citation-keys': (args) => {
      const handle = asString(args[0]);
      if (handle === '') return NIL;
      try {
        const keys = citationKeys(handle);
        let acc = NIL;
        for (let i = keys.length - 1; i >= 0; i -= 1) acc = cons(keys[i], acc);
        return acc;
      } catch (error) {
        throw new Error(`citation-keys: ${error?.message ?? error}`);
      }
    },

    // (citation-entries HANDLE) -> list of {:key :author :year :title}.
    // The cheap index the cite picker filters on. Absent fields are nil.
    'citation-entries': (args) => {
      const handle = asString(args[0]);
      if (handle === '') return NIL;
      try {
        const entries = citationEntries(handle);
        return arrayToList(
          entries.map((e) =>
            record({ key: e.key ?? '', author: e.author, year: e.year, title: e.title })
          )
        );
      } catch (error) {
        throw new Error(`citation-entries: ${error?.message ?? error}`);
      }
    },

    // (citation-format-entries HANDLE [STYLE]) -> list of {:key :html}.
    // CSL-formatted HTML per entry (the picker's display rows).
    'citation-format-entries': (args) => {
      const handle = asString(args[0]);
      if (handle === '') return NIL;
      const style = asOption(args[1], 'apa');
      try {
        const entries = formatBibliographyEntries(handle, { style });
        return arrayToList(
          entries.map((e) => record({ key: e.key ?? '', html: e.html ?? '' }))
        );
      } catch (error) {
        throw new Error(`citation-format-entries: ${error?.message ?? error}`);
      }
    },

    // (citation-format-keys HANDLE KEYS-CSV [STYLE]) -> list of {:key :html}.
    // Format ONLY the comma-separated KEYS-CSV subset (the rows on screen),
    // so a large bibliography is never formatted whole. Unknown keys absent.
    'citation-format-keys': (args) => {
      const handle = asString(args[0]);
      const keysCsv = asString(args[1]);
      if (handle === '' || keysCsv === '') return NIL;
      const style = asOption(args[2], 'apa');
      try {
        const wanted = new Set(keysCsv.split(',').map((s) => s.trim()).filter(Boolean));
        const subset = JSON.parse(handle).filter((e) => wanted.has(e.id));
        const entries = formatBibliographyEntries(JSON.stringify(subset), { style });
        return arrayToList(
          entries.map((e) => record({ key: e.key ?? '', html: e.html ?? '' }))
        );
      } catch (error) {
        throw new Error(`citation-format-keys: ${error?.message ?? error}`);
      }
    },

    // (citation-register-style! XML) -> the template id to format with.
    // Registers a custom .csl style; idempotent for a known id.
    'citation-register-style!': (args) => {
      const xml = asString(args[0]);
      if (xml === '') return NIL;
      try {
        return registerCslStyle(xml);
      } catch (error) {
        throw new Error(`citation-register-style!: ${error?.message ?? error}`);
      }
    },
  };
}
