/**
 * @file LaTeX primitives — the Lisp surface for the pure RefTeX
 * foundations.
 *
 * This factory exposes two groups of host procedures, both pure (no
 * filesystem, no view, no async):
 *
 *   - `(latex-scan TEXT)` — scan a LaTeX source string and return a
 *     hash-map of record lists (labels, sections, refs, cites, index,
 *     inputs, bib). The heavy lifting lives in `latex-scan.js`; this
 *     module marshals the plain-JS result into Lisp values.
 *
 *   - `(path-dirname PATH)` / `(path-basename PATH)` /
 *     `(path-resolve BASEDIR REL)` — POSIX-style pure path string
 *     logic. The app targets macOS / Linux, so `/` is the only
 *     separator; no Windows drive handling.
 *
 * Hash-maps follow the codebase convention (see
 * `apps/desktop/src/app.js`'s `listViewRecords` and the `goto-info`
 * record at ~line 3849): a JS `Map` keyed by interned keywords, values
 * are Lisp values (`arrayToList` for lists, `NIL` for absent). Booleans
 * are JS booleans (matching `region-active?` in buffer-primitives.js).
 */

import { arrayToList, keyword, NIL } from '@editor/lisp';

import { scanLatex } from './latex-scan.js';
import { pathDirname, pathBasename, pathResolve } from './path-resolve.js';

/**
 * Wrap a value for a hash-map slot: `null`/`undefined` become `NIL`,
 * everything else passes through.
 *
 * @param {*} value
 * @returns {*}
 */
function orNil(value) {
  return value === null || value === undefined ? NIL : value;
}

/**
 * Build a Lisp hash-map (a JS `Map` with keyword keys) from a plain
 * object, applying a per-key conversion. Keys whose conversion yields
 * `undefined` are skipped.
 *
 * @param {Record<string, *>} fields
 * @returns {Map<*, *>}
 */
function record(fields) {
  const map = new Map();
  for (const [key, value] of Object.entries(fields)) {
    map.set(keyword(key), value);
  }
  return map;
}

/**
 * Convert a {@link import('./latex-scan.js').ScanResult} into a Lisp
 * hash-map of record lists.
 *
 * @param {import('./latex-scan.js').ScanResult} scan
 * @returns {Map<*, *>}
 */
function scanToLisp(scan) {
  const labels = scan.labels.map((l) =>
    record({ name: l.name, line: l.line, col: l.col, env: orNil(l.env) })
  );
  const sections = scan.sections.map((s) =>
    record({ level: s.level, title: s.title, line: s.line, col: s.col })
  );
  const refs = scan.refs.map((r) =>
    record({ name: r.name, macro: r.macro, line: r.line })
  );
  const cites = scan.cites.map((c) =>
    record({ keys: arrayToList(c.keys), macro: c.macro, line: c.line })
  );
  const index = scan.index.map((i) =>
    record({ entry: i.entry, line: i.line })
  );
  const inputs = scan.inputs.map((i) =>
    record({ kind: i.kind, path: i.path, line: i.line })
  );
  const bib = scan.bib.map((b) =>
    record({ paths: arrayToList(b.paths), line: b.line })
  );

  const top = new Map();
  top.set(keyword('labels'), arrayToList(labels));
  top.set(keyword('sections'), arrayToList(sections));
  top.set(keyword('refs'), arrayToList(refs));
  top.set(keyword('cites'), arrayToList(cites));
  top.set(keyword('index'), arrayToList(index));
  top.set(keyword('inputs'), arrayToList(inputs));
  top.set(keyword('bib'), arrayToList(bib));
  return top;
}

/**
 * Build the LaTeX primitives. Pure — no host dependency, so the
 * standard-library tests can instantiate them directly.
 *
 * @returns {Record<string, (args: *[]) => *>}
 */
export function createLatexPrimitives() {
  return {
    // `(latex-scan TEXT)` — scan a LaTeX source string. Returns a
    // hash-map keyed by :labels :sections :refs :cites :index :inputs
    // :bib; each value is a Lisp list of record hash-maps. See
    // `latex-scan.js` for the per-record fields.
    'latex-scan': (args) => {
      const text = typeof args[0] === 'string' ? args[0] : '';
      return scanToLisp(scanLatex(text));
    },

    // `(path-dirname PATH)` — the directory portion of PATH (no
    // trailing slash; "/" stays "/"; a bare name → ".").
    'path-dirname': (args) => pathDirname(String(args[0] ?? '')),

    // `(path-basename PATH)` — the final path component.
    'path-basename': (args) => pathBasename(String(args[0] ?? '')),

    // `(path-resolve BASEDIR REL)` — resolve REL against BASEDIR
    // (treated as a directory), normalising `.`/`..`. An absolute REL
    // is returned normalised, ignoring BASEDIR.
    'path-resolve': (args) =>
      pathResolve(String(args[0] ?? ''), String(args[1] ?? '')),
  };
}
