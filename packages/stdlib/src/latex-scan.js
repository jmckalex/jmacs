/**
 * @file latex-scan.js — a pure LaTeX document scanner.
 *
 * `scanLatex(text)` walks a LaTeX source string once and extracts the
 * structural elements a RefTeX-style reference engine needs: labels,
 * sectioning commands, cross-references, citations, index entries,
 * file inclusions, and bibliography declarations.
 *
 * The scanner is deliberately *pure* — string in, plain-JS-object-graph
 * out. No Lisp values, no host calls. The Lisp surface (a hash-map of
 * record lists) is built on top of this by `latex-primitives.js`, and
 * the unit tests exercise this module directly.
 *
 * ## Comment handling
 *
 * An unescaped `%` (one not preceded by a backslash) starts a TeX
 * comment that runs to the end of the line. The scanner masks comment
 * spans before matching, so a commented-out `\label{foo}` is never
 * reported. `\%` (an escaped percent — a literal percent sign in the
 * output) does *not* start a comment.
 *
 * ## Brace matching
 *
 * Argument extraction is intentionally simple: `{([^}]*)}` — the first
 * run of non-`}` characters inside braces. Labels, refs, section
 * titles and the like don't nest braces in practice, and keeping the
 * matcher dumb keeps the scanner fast and predictable. A title with a
 * nested group (`\section{A \textbf{bold} word}`) will capture only up
 * to the first `}` — an acceptable limitation for a reference engine.
 */

/**
 * @typedef {object} ScanResult
 * @property {Array<{name: string, line: number, col: number, env: (string|null)}>} labels
 * @property {Array<{level: string, title: string, line: number, col: number}>} sections
 * @property {Array<{name: string, macro: string, line: number}>} refs
 * @property {Array<{keys: string[], macro: string, line: number}>} cites
 * @property {Array<{entry: string, line: number}>} index
 * @property {Array<{kind: string, path: string, line: number}>} inputs
 * @property {Array<{paths: string[], line: number}>} bib
 */

/** The sectioning macros, longest-first so `\subsubsection` is tried
 *  before `\subsection` before `\section`. A trailing `*` (starred,
 *  unnumbered form) is permitted on each. */
const SECTION_LEVELS = [
  'subparagraph',
  'paragraph',
  'subsubsection',
  'subsection',
  'section',
  'chapter',
  'part',
];

/** The cross-reference macros. `\ref`, `\eqref`, `\pageref`, `\autoref`,
 *  and the cleveref pair `\cref` / `\Cref`. */
const REF_MACROS = ['eqref', 'pageref', 'autoref', 'cref', 'Cref', 'ref'];

/** The citation macros. The natbib / biblatex family plus plain
 *  `\cite`. `\cite` is tried last so the longer names win. */
const CITE_MACROS = [
  'citeauthor',
  'parencite',
  'citep',
  'citet',
  'cite',
];

/**
 * Replace every TeX comment span with spaces, preserving newlines and
 * overall offsets so line/column arithmetic done against the masked
 * string matches the original.
 *
 * A `%` starts a comment unless it is escaped (`\%`). An odd run of
 * backslashes immediately before the `%` means it is escaped; an even
 * run (including zero) means it is a real comment marker.
 *
 * @param {string} text
 * @returns {string} The text with comment characters blanked to spaces.
 */
function maskComments(text) {
  const out = text.split('');
  let inComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') {
      inComment = false;
      continue;
    }
    if (inComment) {
      out[i] = ' ';
      continue;
    }
    if (ch === '%') {
      // Count the run of backslashes immediately before this percent.
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && text[j] === '\\') {
        backslashes += 1;
        j -= 1;
      }
      // An even number of backslashes (0, 2, …) leaves the `%`
      // unescaped — it opens a comment. An odd number escapes it.
      if (backslashes % 2 === 0) {
        inComment = true;
        out[i] = ' ';
      }
    }
  }
  return out.join('');
}

/**
 * Build an index of newline offsets so a 0-based string offset can be
 * turned into a 1-based line number and 0-based column.
 *
 * @param {string} text
 * @returns {number[]} The offset of each `\n`, ascending.
 */
function newlineOffsets(text) {
  const offsets = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') offsets.push(i);
  }
  return offsets;
}

/**
 * Convert a 0-based offset to `{ line, col }` (line 1-based, col
 * 0-based) using a precomputed newline-offset index.
 *
 * @param {number} offset
 * @param {number[]} nls - Ascending newline offsets.
 * @returns {{ line: number, col: number }}
 */
function lineColAt(offset, nls) {
  // Binary search for the number of newlines strictly before `offset`.
  let lo = 0;
  let hi = nls.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nls[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  const line = lo + 1;
  const lineStart = lo === 0 ? 0 : nls[lo - 1] + 1;
  return { line, col: offset - lineStart };
}

/**
 * The 1-based line number for an offset.
 *
 * @param {number} offset
 * @param {number[]} nls
 * @returns {number}
 */
function lineAt(offset, nls) {
  return lineColAt(offset, nls).line;
}

/**
 * Track the `\begin{ENV}` / `\end{ENV}` nesting so each label can be
 * tagged with the name of the innermost environment open at its offset.
 *
 * Returns a function `envAt(offset)` that, given an offset, returns the
 * name of the innermost environment open *at* that offset, or null.
 *
 * @param {string} masked - Comment-masked text.
 * @returns {(offset: number) => (string | null)}
 */
function buildEnvLookup(masked) {
  /** @type {Array<{name: string, from: number, to: number}>} */
  const spans = [];
  /** @type {Array<{name: string, from: number}>} */
  const stack = [];
  const re = /\\(begin|end)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const which = m[1];
    const name = m[2].trim();
    if (which === 'begin') {
      stack.push({ name, from: m.index });
    } else {
      // Pop the matching environment. Mismatched `\end`s (malformed
      // source) are tolerated: pop the nearest same-named open, else
      // ignore.
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === name) { idx = k; break; }
      }
      if (idx >= 0) {
        const open = stack.splice(idx, 1)[0];
        spans.push({ name: open.name, from: open.from, to: m.index + m[0].length });
      }
    }
  }

  return function envAt(offset) {
    // The innermost enclosing span is the one with the latest `from`
    // among those that contain the offset.
    let best = null;
    for (const span of spans) {
      if (span.from <= offset && offset < span.to) {
        if (best === null || span.from > best.from) best = span;
      }
    }
    return best ? best.name : null;
  };
}

/**
 * Scan a LaTeX source string and extract its structural elements.
 *
 * @param {string} text - The full LaTeX source.
 * @returns {ScanResult}
 */
export function scanLatex(text) {
  const src = typeof text === 'string' ? text : '';
  const masked = maskComments(src);
  const nls = newlineOffsets(masked);
  const envAt = buildEnvLookup(masked);

  /** @type {ScanResult} */
  const result = {
    labels: [],
    sections: [],
    refs: [],
    cites: [],
    index: [],
    inputs: [],
    bib: [],
  };

  // --- labels: \label{NAME} ------------------------------------------
  {
    const re = /\\label\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const { line, col } = lineColAt(m.index, nls);
      result.labels.push({
        name: m[1].trim(),
        line,
        col,
        env: envAt(m.index),
      });
    }
  }

  // --- sections: \section{TITLE}, \section*{TITLE}, … ----------------
  {
    const alt = SECTION_LEVELS.join('|');
    const re = new RegExp(`\\\\(${alt})\\*?\\s*\\{([^}]*)\\}`, 'g');
    let m;
    while ((m = re.exec(masked)) !== null) {
      const { line, col } = lineColAt(m.index, nls);
      result.sections.push({
        level: m[1],
        title: m[2].trim(),
        line,
        col,
      });
    }
  }

  // --- refs: \ref{NAME}, \eqref{NAME}, … -----------------------------
  {
    const alt = REF_MACROS.join('|');
    const re = new RegExp(`\\\\(${alt})\\s*\\{([^}]*)\\}`, 'g');
    let m;
    while ((m = re.exec(masked)) !== null) {
      result.refs.push({
        name: m[2].trim(),
        macro: m[1],
        line: lineAt(m.index, nls),
      });
    }
  }

  // --- cites: \cite{a,b}, \citep{...}, … -----------------------------
  {
    const alt = CITE_MACROS.join('|');
    // Optional `[…]` pre/post-notes (e.g. \cite[p. 5]{key}) are
    // tolerated and ignored — only the `{…}` key list is captured.
    const re = new RegExp(`\\\\(${alt})\\s*(?:\\[[^\\]]*\\]\\s*)*\\{([^}]*)\\}`, 'g');
    let m;
    while ((m = re.exec(masked)) !== null) {
      const keys = m[2]
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k !== '');
      result.cites.push({
        keys,
        macro: m[1],
        line: lineAt(m.index, nls),
      });
    }
  }

  // --- index: \index{ENTRY} ------------------------------------------
  {
    const re = /\\index\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
      result.index.push({
        entry: m[1].trim(),
        line: lineAt(m.index, nls),
      });
    }
  }

  // --- inputs: \input / \include / \subfile / \import ----------------
  {
    const re = /\\(input|include|subfile)\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
      result.inputs.push({
        kind: m[1],
        path: m[2].trim(),
        line: lineAt(m.index, nls),
      });
    }
  }
  {
    // \import{DIR}{FILE} — combine the two arguments into one path.
    const re = /\\import\s*\{([^}]*)\}\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const dir = m[1].trim();
      const file = m[2].trim();
      const combined = dir === ''
        ? file
        : dir.endsWith('/') ? dir + file : `${dir}/${file}`;
      result.inputs.push({
        kind: 'import',
        path: combined,
        line: lineAt(m.index, nls),
      });
    }
  }

  // --- bib: \bibliography{a,b} and \addbibresource{a} ----------------
  {
    const re = /\\bibliography\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const paths = m[1]
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '');
      result.bib.push({ paths, line: lineAt(m.index, nls) });
    }
  }
  {
    const re = /\\addbibresource\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
      const path = m[1].trim();
      result.bib.push({
        paths: path === '' ? [] : [path],
        line: lineAt(m.index, nls),
      });
    }
  }

  return result;
}
