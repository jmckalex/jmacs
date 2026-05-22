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
 * @returns {string} A language tag, or `'plain'`.
 */
export function languageForName(name) {
  if (typeof name !== 'string') return 'plain';
  if (name.endsWith('.lisp')) return 'lisp';
  if (name.endsWith('.js') || name.endsWith('.mjs')) return 'javascript';
  if (name.endsWith('.md') || name.endsWith('.jmd')) return 'markdown';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  if (name.endsWith('.tex') || name.endsWith('.latex')) return 'latex';
  if (name.endsWith('.py')) return 'python';
  if (
    name.endsWith('Makefile') ||
    name.endsWith('makefile') ||
    name.endsWith('.mk')
  ) {
    return 'makefile';
  }
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
