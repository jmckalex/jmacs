/**
 * @file LaTeX fold ranges — a pure line scanner (no tree-sitter).
 *
 * Standalone `.tex` files are highlighted by the hand tokenizer, and the
 * tree-sitter latex grammar (used only for *injected* latex inside
 * markdown) carries no `@fold` captures — so latex had no folds at all.
 * This scanner gives the view fold ranges for:
 *
 *   - **sectioning commands** (`\part` … `\subparagraph`), nested by level,
 *     each spanning from its line to just before the next same-or-higher
 *     section — so the sticky structure headers read as a section
 *     breadcrumb (`\section` › `\subsection` › `\subsubsection`); and
 *   - **environments** (`\begin{…}` … matching `\end{…}`), nested on a
 *     name-matched stack.
 *
 * It returns `{ start, end }` character offsets — the `FoldCapture` shape
 * `folding.js` consumes; `foldRanges` turns those into line spans (and
 * drops any that begin and end on one line). Being pure and offset-based,
 * it is unit-tested without loading any grammar, exactly like
 * `jmarkdown-scan.js`.
 */

/** Sectioning commands, outermost (lowest level number) first. */
const SECTION_LEVELS = [
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
];
const SECTION_LEVEL = new Map(SECTION_LEVELS.map((name, i) => [name, i]));

// Longest-first alternation so `\subsection` matches `subsection`, not the
// `section` alternative. A trailing `\*?` accepts starred forms.
const SECTION_RE = new RegExp(
  `\\\\(${[...SECTION_LEVELS].sort((a, b) => b.length - a.length).join('|')})\\*?`
);
const BEGIN_RE = /\\begin\s*\{([^}]*)\}/g;
const END_RE = /\\end\s*\{([^}]*)\}/g;

/**
 * Build the character offset of every line's first character.
 *
 * @param {string} text
 * @returns {number[]}
 */
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* '\n' */) starts.push(i + 1);
  }
  return starts;
}

/**
 * Scan latex source for foldable sectioning units and environments.
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number}>} character-offset spans
 */
export function latexFolds(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lineStarts = computeLineStarts(text);
  const folds = [];

  /** Open sections, innermost last: `{ level, start }` (start = line offset). */
  const sections = [];
  /** Open environments, innermost last: `{ name, start }`. */
  const envs = [];

  for (let i = 0; i < lineStarts.length; i += 1) {
    const lineStart = lineStarts[i];
    const lineEnd = i + 1 < lineStarts.length ? lineStarts[i + 1] - 1 : text.length;
    const line = text.slice(lineStart, lineEnd);

    // A whole-line comment introduces no structure.
    if (line.trimStart().startsWith('%')) continue;

    // Environments first, in column order, so a `\begin`/`\end` pair on one
    // line resolves before this line could also open a section.
    BEGIN_RE.lastIndex = 0;
    END_RE.lastIndex = 0;
    const events = [];
    for (let m = BEGIN_RE.exec(line); m; m = BEGIN_RE.exec(line)) {
      events.push({ col: m.index, kind: 'begin', name: m[1], endCol: BEGIN_RE.lastIndex });
    }
    for (let m = END_RE.exec(line); m; m = END_RE.exec(line)) {
      events.push({ col: m.index, kind: 'end', name: m[1], endCol: END_RE.lastIndex });
    }
    events.sort((a, b) => a.col - b.col);
    for (const ev of events) {
      if (ev.kind === 'begin') {
        envs.push({ name: ev.name, start: lineStart + ev.col });
      } else {
        // Pop the nearest matching open environment (tolerate mismatches).
        for (let k = envs.length - 1; k >= 0; k -= 1) {
          if (envs[k].name === ev.name) {
            folds.push({ start: envs[k].start, end: lineStart + ev.endCol });
            envs.splice(k, 1);
            break;
          }
        }
      }
    }

    // A sectioning command closes every open section at its level or deeper,
    // then opens its own.
    const sec = SECTION_RE.exec(line);
    if (sec) {
      const level = SECTION_LEVEL.get(sec[1]);
      while (sections.length > 0 && sections[sections.length - 1].level >= level) {
        const open = sections.pop();
        folds.push({ start: open.start, end: lineStart - 1 });
      }
      sections.push({ level, start: lineStart });
    }
  }

  // Close everything still open at end of file.
  for (const open of sections) folds.push({ start: open.start, end: text.length });
  for (const open of envs) folds.push({ start: open.start, end: text.length });

  return folds;
}
