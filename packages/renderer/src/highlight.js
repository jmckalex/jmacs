/**
 * @file Syntax highlighting — a hand-written tokenizer that splits a
 * line of code into typed runs the view renders as coloured spans.
 *
 * Tokenizers, not tree-sitter: the editor's Lisp is a custom dialect
 * with no published grammar, and a tokenizer is reliable and dependency
 * -free. Tree-sitter (for richer, tree-aware highlighting) can replace
 * this behind the same run interface later.
 *
 * Highlighting is line-independent for v0: a string or block comment
 * that spans lines is highlighted only on its first line. Pure and
 * DOM-free, so it is tested on its own.
 *
 * For tree-sitter languages, `languageForName` also consults the
 * language registry (`./language-registry.js`), so adding a new
 * tree-sitter language is a drop-in (see `./languages/README.md`).
 */

import { languageForFilename } from './language-registry.js';
import { scanMathSegments, MARKDOWN_MATH_CONFIG } from './math-segments.js';

/** A maximal stretch of a line sharing one highlight face. */
/** @typedef {{ text: string, face: string | null }} Run */

/** Lisp special forms and core macros, shown as keywords. */
const LISP_KEYWORDS = new Set([
  'define', 'lambda', 'fn', 'if', 'cond', 'let', 'let*', 'letrec', 'set!',
  'begin', 'quote', 'quasiquote', 'and', 'or', 'when', 'unless', 'defmacro',
  'module', 'import', 'export', 'try', 'catch',
]);

/** JavaScript reserved words and common literals, shown as keywords. */
const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'class', 'extends', 'new', 'import', 'export', 'default', 'from',
  'this', 'typeof', 'instanceof', 'break', 'continue', 'switch', 'case',
  'throw', 'try', 'catch', 'finally', 'await', 'async', 'yield', 'delete',
  'in', 'of', 'void', 'null', 'true', 'false', 'undefined',
]);

const LISP_DELIMITER = /[\s;"'`,()[\]{}]/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Choose a language from a buffer name.
 *
 * The built-in table here covers the hand-tokenized languages — the
 * Lisp dialect, Markdown, LaTeX and Makefile. Tree-sitter languages
 * (JavaScript, HTML, Python and any other drop-ins) come from the
 * language registry. See `./languages/README.md`.
 *
 * @param {string} name
 * @returns {string} A language tag, or `'plain'`.
 */
export function languageForName(name) {
  if (typeof name !== 'string') return 'plain';
  if (name.endsWith('.lisp')) return 'lisp';
  if (name.endsWith('.md') || name.endsWith('.jmd')) return 'markdown';
  if (name.endsWith('.tex') || name.endsWith('.latex')) return 'latex';
  if (
    name.endsWith('Makefile') ||
    name.endsWith('makefile') ||
    name.endsWith('.mk')
  ) {
    return 'makefile';
  }
  const fromRegistry = languageForFilename(name);
  if (fromRegistry !== null) return fromRegistry;
  return 'plain';
}

/** Classify a bare Lisp token. */
function classifyLispToken(token) {
  if (token.length > 1 && token[0] === ':') return 'constant';
  if (token === '#t' || token === '#f') return 'constant';
  if (NUMBER.test(token)) return 'number';
  if (LISP_KEYWORDS.has(token)) return 'keyword';
  return null;
}

/** Tokenize one line of the editor's Lisp. */
function tokenizeLisp(line) {
  /** @type {Run[]} */
  const runs = [];
  const push = (text, face) => {
    if (text !== '') runs.push({ text, face });
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    if (ch === ';') {
      push(line.slice(i), 'comment');
      break;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        j += line[j] === '\\' ? 2 : 1;
      }
      j = Math.min(j + 1, line.length);
      push(line.slice(i, j), 'string');
      i = j;
    } else if (/\s/.test(ch)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j])) j += 1;
      push(line.slice(i, j), null);
      i = j;
    } else if ('()[]{}'.includes(ch)) {
      push(ch, 'paren');
      i += 1;
    } else if ("'`,".includes(ch)) {
      push(ch, 'operator');
      i += 1;
    } else {
      let j = i;
      while (j < line.length && !LISP_DELIMITER.test(line[j])) j += 1;
      const token = line.slice(i, j);
      push(token, classifyLispToken(token));
      i = j;
    }
  }
  return runs;
}

/** Tokenize one line of JavaScript. */
function tokenizeJavaScript(line) {
  /** @type {Run[]} */
  const runs = [];
  const push = (text, face) => {
    if (text !== '') runs.push({ text, face });
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const pair = line.slice(i, i + 2);

    if (pair === '//') {
      push(line.slice(i), 'comment');
      break;
    }
    if (pair === '/*') {
      const end = line.indexOf('*/', i + 2);
      const j = end === -1 ? line.length : end + 2;
      push(line.slice(i, j), 'comment');
      i = j;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        j += line[j] === '\\' ? 2 : 1;
      }
      j = Math.min(j + 1, line.length);
      push(line.slice(i, j), 'string');
      i = j;
    } else if (/\s/.test(ch)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j])) j += 1;
      push(line.slice(i, j), null);
      i = j;
    } else if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) j += 1;
      const word = line.slice(i, j);
      push(word, JS_KEYWORDS.has(word) ? 'keyword' : null);
      i = j;
    } else if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < line.length && /[0-9._a-fA-FxXeE]/.test(line[j])) j += 1;
      push(line.slice(i, j), 'number');
      i = j;
    } else {
      push(ch, 'operator');
      i += 1;
    }
  }
  return runs;
}

/**
 * Tokenize one line of Markdown (and JMarkdown). Block constructs
 * (headings, `:::` directives) face the whole line; otherwise the line
 * is scanned for inline constructs.
 */
function tokenizeMarkdown(line) {
  if (/^\s*#{1,6}\s/.test(line)) return [{ text: line, face: 'heading' }];
  if (/^\s*:::/.test(line)) return [{ text: line, face: 'keyword' }];

  /** @type {Run[]} */
  const runs = [];
  let plain = '';
  const flush = () => {
    if (plain !== '') {
      runs.push({ text: plain, face: null });
      plain = '';
    }
  };
  const emit = (text, face) => {
    flush();
    runs.push({ text, face });
  };

  let i = 0;
  // A leading blockquote or list marker.
  const lead = /^(\s*)(>|[-*+]|\d+\.)(\s)/.exec(line);
  if (lead) {
    plain += lead[1];
    flush();
    runs.push({ text: lead[2], face: 'operator' });
    plain += lead[3];
    i = lead[0].length;
  }

  while (i < line.length) {
    const rest = line.slice(i);
    let m;
    if ((m = /^`[^`]+`/.exec(rest))) emit(m[0], 'code');
    else if ((m = /^==[^=]+==/.exec(rest))) emit(m[0], 'constant');
    else if ((m = /^\*[^*\n]+\*/.exec(rest))) emit(m[0], 'strong');
    else if ((m = /^\/[^/\s][^/\n]*\//.exec(rest))) emit(m[0], 'emphasis');
    else if ((m = /^\[[^\]\n]+\]\([^)\n]+\)/.exec(rest))) emit(m[0], 'link');
    else if ((m = /^\\[A-Za-z]+\{[^}\n]*\}/.exec(rest))) emit(m[0], 'keyword');
    else {
      plain += line[i];
      i += 1;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return runs;
}

/** Tokenize one line of HTML. */
function tokenizeHtml(line) {
  /** @type {Run[]} */
  const runs = [];
  let plain = '';
  const flush = () => {
    if (plain !== '') {
      runs.push({ text: plain, face: null });
      plain = '';
    }
  };
  const emit = (text, face) => {
    flush();
    runs.push({ text, face });
  };

  let i = 0;
  let inTag = false;
  while (i < line.length) {
    const rest = line.slice(i);
    let m;
    if (!inTag && (m = /^<!--.*?(?:-->|$)/.exec(rest))) {
      emit(m[0], 'comment');
    } else if (!inTag && (m = /^<\/?[A-Za-z][\w-]*/.exec(rest))) {
      emit(m[0], 'tag');
      inTag = true;
    } else if (inTag && (m = /^\/?>/.exec(rest))) {
      emit(m[0], 'tag');
      inTag = false;
    } else if (inTag && (m = /^"[^"]*"|^'[^']*'/.exec(rest))) {
      emit(m[0], 'string');
    } else if (inTag && (m = /^[A-Za-z][\w-]*/.exec(rest))) {
      emit(m[0], 'constant'); // an attribute name
    } else if (!inTag && (m = /^&[A-Za-z#]\w*;/.exec(rest))) {
      emit(m[0], 'constant'); // a character entity
    } else {
      plain += line[i];
      i += 1;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return runs;
}

/** Tokenize one line of LaTeX. */
function tokenizeLatex(line) {
  /** @type {Run[]} */
  const runs = [];
  let plain = '';
  const flush = () => {
    if (plain !== '') {
      runs.push({ text: plain, face: null });
      plain = '';
    }
  };
  const emit = (text, face) => {
    flush();
    runs.push({ text, face });
  };

  let i = 0;
  while (i < line.length) {
    if (line[i] === '%') {
      emit(line.slice(i), 'comment');
      i = line.length;
      break;
    }
    const rest = line.slice(i);
    let m;
    if ((m = /^\\([A-Za-z]+\*?|.)/.exec(rest))) {
      emit(m[0], 'keyword'); // a control sequence
      i += m[0].length;
    } else if ((m = /^\$[^$]*\$/.exec(rest))) {
      emit(m[0], 'string'); // inline math
      i += m[0].length;
    } else if ('{}[]'.includes(line[i])) {
      emit(line[i], 'paren');
      i += 1;
    } else {
      plain += line[i];
      i += 1;
    }
  }
  flush();
  return runs;
}

/** Python keywords. */
const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'lambda', 'if', 'elif', 'else', 'for', 'while', 'return',
  'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise',
  'yield', 'pass', 'break', 'continue', 'global', 'nonlocal', 'del',
  'assert', 'async', 'await', 'and', 'or', 'not', 'in', 'is',
]);

/** Classify a bare Python word. */
function classifyPython(word) {
  if (word === 'None' || word === 'True' || word === 'False') return 'constant';
  if (PYTHON_KEYWORDS.has(word)) return 'keyword';
  return null;
}

/** Tokenize one line of Python. */
function tokenizePython(line) {
  /** @type {Run[]} */
  const runs = [];
  const push = (text, face) => {
    if (text !== '') runs.push({ text, face });
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '#') {
      push(line.slice(i), 'comment');
      break;
    }
    const triple = line.slice(i, i + 3);
    if (triple === '"""' || triple === "'''") {
      const end = line.indexOf(triple, i + 3);
      const j = end === -1 ? line.length : end + 3;
      push(line.slice(i, j), 'string');
      i = j;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, line.length);
      push(line.slice(i, j), 'string');
      i = j;
    } else if (ch === '@' && /[A-Za-z_]/.test(line[i + 1] ?? '')) {
      let j = i + 1;
      while (j < line.length && /[\w.]/.test(line[j])) j += 1;
      push(line.slice(i, j), 'constant'); // a decorator
      i = j;
    } else if (/\s/.test(ch)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j])) j += 1;
      push(line.slice(i, j), null);
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < line.length && /\w/.test(line[j])) j += 1;
      const word = line.slice(i, j);
      push(word, classifyPython(word));
      i = j;
    } else if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < line.length && /[0-9._eExXoObBa-fA-F]/.test(line[j])) j += 1;
      push(line.slice(i, j), 'number');
      i = j;
    } else {
      push(ch, 'operator');
      i += 1;
    }
  }
  return runs;
}

/** Tokenize one line of a Makefile. */
function tokenizeMakefile(line) {
  if (/^\s*#/.test(line)) return [{ text: line, face: 'comment' }];

  /** @type {Run[]} */
  const runs = [];
  let plain = '';
  const flush = () => {
    if (plain !== '') {
      runs.push({ text: plain, face: null });
      plain = '';
    }
  };
  const emit = (text, face) => {
    flush();
    runs.push({ text, face });
  };

  let i = 0;
  let m;
  // A rule target, or a variable assignment, beginning the line.
  if (line[0] !== '\t' && (m = /^([A-Za-z0-9_.%/-]+)(\s*)(:)(?!=)/.exec(line))) {
    emit(m[1], 'keyword');
    plain += m[2];
    emit(m[3], 'operator');
    i = m[0].length;
  } else if ((m = /^([A-Za-z_]\w*)(\s*)([:?+]?=)/.exec(line))) {
    emit(m[1], 'constant');
    plain += m[2];
    emit(m[3], 'operator');
    i = m[0].length;
  }
  while (i < line.length) {
    if (line[i] === '#') {
      emit(line.slice(i), 'comment');
      i = line.length;
      break;
    }
    const ref = /^\$[({][^)}]*[)}]/.exec(line.slice(i));
    if (ref) {
      emit(ref[0], 'constant'); // a variable reference
      i += ref[0].length;
    } else {
      plain += line[i];
      i += 1;
    }
  }
  flush();
  return runs;
}

/**
 * Split a line into highlighted runs. The runs' texts always
 * concatenate back to the original line.
 *
 * @param {string} text - One line, without its newline.
 * @param {string} language
 * @returns {Run[]}
 */
export function highlightLine(text, language) {
  if (language === 'lisp') return tokenizeLisp(text);
  if (language === 'javascript') return tokenizeJavaScript(text);
  if (language === 'markdown') return tokenizeMarkdown(text);
  if (language === 'html') return tokenizeHtml(text);
  if (language === 'latex') return tokenizeLatex(text);
  if (language === 'python') return tokenizePython(text);
  if (language === 'makefile') return tokenizeMakefile(text);
  return text === '' ? [] : [{ text, face: null }];
}

// --- multi-line tokenizers -------------------------------------------
// Whole-buffer tokenizers for languages whose constructs span lines.
// Each returns an array with one Run[] per line — the per-line view
// uses these in preference to highlightLine where they are defined.

/** Push RUN onto LINE if it has any text. */
function flushTo(run, line) {
  if (run.text !== '') line.push({ text: run.text, face: run.face });
}

/**
 * The LaTeX environments and delimiters that carry highlighting across
 * line breaks: verbatim and the various display-math environments. The
 * body is styled as `string` (the tree-sitter `string` face is used for
 * any literal-text run; the line tokenizer already styles `$…$` as
 * string, so this is consistent).
 */
const LATEX_BLOCK_BEGIN =
  /^\\begin\{(verbatim|equation|equation\*|align|align\*|displaymath|gather|gather\*)\}/;
const LATEX_BLOCK_END =
  /^\\end\{(verbatim|equation|equation\*|align|align\*|displaymath|gather|gather\*)\}/;

/**
 * Tokenize a whole LaTeX buffer into per-line runs. The block-spanning
 * cases — `\begin{verbatim}` … `\end{verbatim}` and the various
 * display-math environments, plus `\[ … \]` — are highlighted past
 * their opening line.
 *
 * @param {string} text
 * @returns {Run[][]}
 */
export function highlightLatexBuffer(text) {
  /** @type {Run[][]} */
  const lines = [];
  /** @type {Run[]} */
  let line = [];
  let plain = { text: '', face: null };
  let inBlock = false;

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      flushTo(plain, line);
      lines.push(line);
      line = [];
      plain = { text: '', face: inBlock ? 'string' : null };
      i += 1;
      continue;
    }
    const rest = text.slice(i);
    if (inBlock) {
      let m;
      if ((m = LATEX_BLOCK_END.exec(rest))) {
        flushTo(plain, line);
        line.push({ text: m[0], face: 'keyword' });
        plain = { text: '', face: null };
        inBlock = false;
        i += m[0].length;
        continue;
      }
      if (rest.slice(0, 2) === '\\]') {
        flushTo(plain, line);
        line.push({ text: '\\]', face: 'keyword' });
        plain = { text: '', face: null };
        inBlock = false;
        i += 2;
        continue;
      }
      plain.text += ch;
      i += 1;
      continue;
    }
    if (ch === '%') {
      flushTo(plain, line);
      const eol = text.indexOf('\n', i);
      const stop = eol === -1 ? text.length : eol;
      line.push({ text: text.slice(i, stop), face: 'comment' });
      plain = { text: '', face: null };
      i = stop;
      continue;
    }
    let m;
    if ((m = LATEX_BLOCK_BEGIN.exec(rest))) {
      flushTo(plain, line);
      line.push({ text: m[0], face: 'keyword' });
      plain = { text: '', face: 'string' };
      inBlock = true;
      i += m[0].length;
      continue;
    }
    if (rest.slice(0, 2) === '\\[') {
      flushTo(plain, line);
      line.push({ text: '\\[', face: 'keyword' });
      plain = { text: '', face: 'string' };
      inBlock = true;
      i += 2;
      continue;
    }
    if ((m = /^\\([A-Za-z]+\*?|.)/.exec(rest))) {
      flushTo(plain, line);
      line.push({ text: m[0], face: 'keyword' });
      plain = { text: '', face: null };
      i += m[0].length;
      continue;
    }
    if ((m = /^\$[^$\n]*\$/.exec(rest))) {
      flushTo(plain, line);
      line.push({ text: m[0], face: 'string' });
      plain = { text: '', face: null };
      i += m[0].length;
      continue;
    }
    if ('{}[]'.includes(ch)) {
      flushTo(plain, line);
      line.push({ text: ch, face: 'paren' });
      plain = { text: '', face: null };
      i += 1;
      continue;
    }
    plain.text += ch;
    i += 1;
  }
  flushTo(plain, line);
  lines.push(line);
  return lines;
}

/**
 * Tokenize a whole Makefile into per-line runs. The line tokenizer
 * already handles the single-line cases (targets, assignments,
 * `$(VAR)` refs, `#` comments); this pass adds `define …` /
 * `endef` blocks, whose body lines are styled as `string`.
 *
 * @param {string} text
 * @returns {Run[][]}
 */
export function highlightMakefileBuffer(text) {
  const rawLines = text.split('\n');
  /** @type {Run[][]} */
  const result = [];
  let inDefine = false;
  for (const line of rawLines) {
    if (inDefine) {
      const endMatch = /^endef\b/.exec(line);
      if (endMatch) {
        const runs = [{ text: 'endef', face: 'keyword' }];
        if (line.length > 'endef'.length) {
          runs.push({ text: line.slice('endef'.length), face: null });
        }
        result.push(runs);
        inDefine = false;
        continue;
      }
      result.push(line === '' ? [] : [{ text: line, face: 'string' }]);
      continue;
    }
    const startMatch = /^(define)(\s+)(\w+)(.*)$/.exec(line);
    if (startMatch) {
      result.push([
        { text: startMatch[1], face: 'keyword' },
        { text: startMatch[2], face: null },
        { text: startMatch[3], face: 'constant' },
        ...(startMatch[4] !== ''
          ? [{ text: startMatch[4], face: null }]
          : []),
      ]);
      inDefine = true;
      continue;
    }
    result.push(tokenizeMakefile(line));
  }
  return result;
}

// --- Markdown with embedded LaTeX math -------------------------------
// Markdown's own constructs are line-independent, but its math regions
// (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) can span lines, and we want their
// *bodies* tokenized as LaTeX. So markdown gets a whole-buffer pass that
// keeps `tokenizeMarkdown`'s per-line output verbatim and splices LaTeX
// runs over the math columns. See plans/MD-MATH-AND-PREVIEW.md.

/** The face applied to math delimiters (`$`, `$$`, `\(`, `\[`, …). */
const MATH_DELIM_FACE = 'string';

/**
 * Mask Markdown code so a `$` inside it is never read as a math
 * delimiter. Returns a same-length copy (offsets preserved) with code
 * characters replaced by spaces; newlines are kept so line structure is
 * intact. Covers fenced code blocks (``` ``` ```/`~~~`) and inline code
 * spans (matched backtick runs). Indented (4-space) code blocks are not
 * masked — a known v1 gap.
 *
 * Masking *before* scanning (rather than dropping segments after) is
 * deliberate: an odd `$` in code would otherwise mis-pair with a real
 * `$` and consume the following formula.
 *
 * @param {string} text
 * @returns {string}
 */
function maskMarkdownCode(text) {
  const lines = text.split('\n');
  const out = [];
  let fenceLen = 0; // >0 while inside a fence; the opener's run length
  let fenceChar = '';
  for (const line of lines) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceLen > 0) {
      out.push(' '.repeat(line.length));
      if (
        fence &&
        fence[1][0] === fenceChar &&
        fence[1].length >= fenceLen
      ) {
        fenceLen = 0;
      }
      continue;
    }
    if (fence) {
      out.push(' '.repeat(line.length));
      fenceLen = fence[1].length;
      fenceChar = fence[1][0];
      continue;
    }
    out.push(maskInlineCode(line));
  }
  return out.join('\n');
}

/**
 * Replace inline code spans (backtick runs of equal length) in one line
 * with spaces, preserving length. An unclosed run is left as-is.
 *
 * @param {string} line
 * @returns {string}
 */
function maskInlineCode(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i += 1;
      continue;
    }
    let n = 0;
    while (line[i + n] === '`') n += 1;
    // Find a closing run of exactly n backticks.
    let j = i + n;
    let closed = -1;
    while (j < line.length) {
      if (line[j] === '`') {
        let k = 0;
        while (line[j + k] === '`') k += 1;
        if (k === n) {
          closed = j;
          break;
        }
        j += k;
      } else {
        j += 1;
      }
    }
    if (closed !== -1) {
      const end = closed + n;
      out += ' '.repeat(end - i);
      i = end;
    } else {
      out += line.slice(i, i + n);
      i += n;
    }
  }
  return out;
}

/**
 * The byte widths of a segment's opening and closing delimiters. Block
 * math (`$$`, `\[…\]`) is 2/2; inline is 1/1 for `$…$` and 2/2 for
 * `\(…\)`.
 *
 * @param {string} text
 * @param {MathSegment} seg
 * @returns {{ openLen: number, closeLen: number }}
 */
function delimiterWidths(text, seg) {
  if (seg.kind === 'block') return { openLen: 2, closeLen: 2 };
  return text[seg.start] === '$'
    ? { openLen: 1, closeLen: 1 }
    : { openLen: 2, closeLen: 2 };
}

/** Append every run in `src` to `dst`. */
function pushRuns(dst, src) {
  for (const r of src) dst.push(r);
}

/**
 * The runs of `runs` covering columns `[a, b)`, with the boundary runs
 * sliced. Texts always concatenate back to the covered substring.
 *
 * @param {Run[]} runs
 * @param {number} a
 * @param {number} b
 * @returns {Run[]}
 */
function sliceRuns(runs, a, b) {
  const out = [];
  let col = 0;
  for (const r of runs) {
    const start = col;
    const end = col + r.text.length;
    col = end;
    if (end <= a) continue;
    if (start >= b) break;
    const text = r.text.slice(Math.max(a, start) - start, Math.min(b, end) - start);
    if (text !== '') out.push({ text, face: r.face });
  }
  return out;
}

/** Merge adjacent runs sharing a face into one run. */
function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.face === r.face) last.text += r.text;
    else out.push({ text: r.text, face: r.face });
  }
  return out;
}

/**
 * @typedef {object} MathPlacement
 * @property {number} colStart - First column of the math on this line.
 * @property {number} colEnd - One past the last column.
 * @property {number} openLen - Leading delimiter chars on this line (0
 *   unless the opener is here).
 * @property {number} closeLen - Trailing delimiter chars on this line (0
 *   unless the closer is here).
 */

/**
 * The runs for one line's slice of a math segment: an opening-delimiter
 * run (when present), the LaTeX-tokenized body, then a closing-delimiter
 * run (when present).
 *
 * @param {string} line
 * @param {MathPlacement} p
 * @returns {Run[]}
 */
function mathRunsFor(line, p) {
  const span = line.slice(p.colStart, p.colEnd);
  const runs = [];
  if (p.openLen > 0) runs.push({ text: span.slice(0, p.openLen), face: MATH_DELIM_FACE });
  const body = span.slice(p.openLen, span.length - p.closeLen);
  if (body !== '') pushRuns(runs, tokenizeLatex(body));
  if (p.closeLen > 0) {
    runs.push({ text: span.slice(span.length - p.closeLen), face: MATH_DELIM_FACE });
  }
  return runs;
}

/**
 * Replace the math columns of a line's base (Markdown) runs with LaTeX
 * runs. `placements` are non-overlapping; outside them the base runs
 * carry through unchanged.
 *
 * @param {string} line
 * @param {Run[]} baseRuns
 * @param {MathPlacement[]} placements
 * @returns {Run[]}
 */
function spliceMathRuns(line, baseRuns, placements) {
  placements.sort((x, y) => x.colStart - y.colStart);
  const out = [];
  let col = 0;
  for (const p of placements) {
    if (p.colStart > col) pushRuns(out, sliceRuns(baseRuns, col, p.colStart));
    pushRuns(out, mathRunsFor(line, p));
    col = p.colEnd;
  }
  if (col < line.length) pushRuns(out, sliceRuns(baseRuns, col, line.length));
  return mergeRuns(out);
}

/**
 * Tokenize a whole Markdown buffer into per-line runs. Each line is
 * tokenized exactly as `tokenizeMarkdown` would, then any embedded math
 * region (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, possibly multi-line) has its
 * columns replaced by LaTeX-highlighted runs. Math inside code is left
 * as ordinary text. See plans/MD-MATH-AND-PREVIEW.md.
 *
 * @param {string} text
 * @returns {Run[][]}
 */
export function highlightMarkdownBuffer(text) {
  const lines = text.split('\n');
  const base = lines.map((line) => tokenizeMarkdown(line));
  return overlayMarkdownMath(text, base, lines);
}

/**
 * Overlay LaTeX highlighting onto the math regions of already-computed
 * per-line Markdown runs, *whatever produced them* — the tree-sitter
 * markdown highlighter (which has no notion of `$…$`) or the hand
 * tokenizer. This is the integration point the editor view uses, since
 * markdown is highlighted by tree-sitter and so never reaches
 * `highlightBuffer`.
 *
 * Math is found over a code-masked copy of `text`, so a `$` inside
 * fenced/inline code stays literal; each math region's columns are
 * replaced by delimiter runs + a `tokenizeLatex` of its body, while the
 * surrounding (non-math) runs — and their faces — pass through. Lines
 * with no math are returned by reference. See
 * plans/MD-MATH-AND-PREVIEW.md.
 *
 * @param {string} text - The whole buffer.
 * @param {Run[][]} perLine - One Run[] per buffer line; the texts on
 *   each line concatenate back to that line.
 * @param {string[]} [lines] - `text` split on `\n` (recomputed if
 *   omitted). Must index identically to `perLine`.
 * @returns {Run[][]}
 */
export function overlayMarkdownMath(text, perLine, lines) {
  const srcLines = lines ?? text.split('\n');
  const segments = scanMathSegments(maskMarkdownCode(text), MARKDOWN_MATH_CONFIG);
  if (segments.length === 0) return perLine;

  // Line start offsets (each line plus its newline).
  const lineStart = new Array(srcLines.length);
  let off = 0;
  for (let i = 0; i < srcLines.length; i += 1) {
    lineStart[i] = off;
    off += srcLines[i].length + 1;
  }

  /** @type {Map<number, MathPlacement[]>} */
  const byLine = new Map();
  for (const seg of segments) {
    const { openLen, closeLen } = delimiterWidths(text, seg);
    for (let line = 0; line < srcLines.length; line += 1) {
      const ls = lineStart[line];
      const le = ls + srcLines[line].length;
      if (ls >= seg.end) break;
      if (le <= seg.start) continue;
      const colStart = Math.max(seg.start, ls) - ls;
      const colEnd = Math.min(seg.end, le) - ls;
      if (colEnd <= colStart) continue;
      const placements = byLine.get(line) ?? [];
      placements.push({
        colStart,
        colEnd,
        openLen: seg.start >= ls ? openLen : 0,
        closeLen: seg.end <= le ? closeLen : 0,
      });
      byLine.set(line, placements);
    }
  }

  return perLine.map((runs, index) => {
    const placements = byLine.get(index);
    if (!placements) return runs;
    return spliceMathRuns(srcLines[index] ?? '', runs ?? [], placements);
  });
}

/**
 * The whole-buffer tokenizer for a language, or null if none. The view
 * uses this in preference to `highlightLine` when defined.
 *
 * @param {string} text
 * @param {string} language
 * @returns {Run[][] | null}
 */
export function highlightBuffer(text, language) {
  if (language === 'latex') return highlightLatexBuffer(text);
  if (language === 'makefile') return highlightMakefileBuffer(text);
  if (language === 'markdown') return highlightMarkdownBuffer(text);
  return null;
}
