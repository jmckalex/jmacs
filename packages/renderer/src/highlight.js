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
 */

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
 * @param {string} name
 * @returns {'lisp' | 'javascript' | 'plain'}
 */
export function languageForName(name) {
  if (typeof name !== 'string') return 'plain';
  if (name.endsWith('.lisp')) return 'lisp';
  if (name.endsWith('.js') || name.endsWith('.mjs')) return 'javascript';
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
 * Split a line into highlighted runs. The runs' texts always
 * concatenate back to the original line.
 *
 * @param {string} text - One line, without its newline.
 * @param {'lisp' | 'javascript' | 'plain'} language
 * @returns {Run[]}
 */
export function highlightLine(text, language) {
  if (language === 'lisp') return tokenizeLisp(text);
  if (language === 'javascript') return tokenizeJavaScript(text);
  return text === '' ? [] : [{ text, face: null }];
}
