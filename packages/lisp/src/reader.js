/**
 * @file The reader — turns Lisp source text into the value model from
 * `values.js`. It is a recursive-descent reader over the character
 * stream, tracking line/column so that list forms carry a source
 * position (recorded in `sourceLocations`) for error reporting and
 * self-documentation.
 *
 * Syntax handled: lists `(...)`, vectors `[...]`, maps `{...}`, strings
 * with escapes, numbers, symbols, keywords (`:kw`), booleans
 * (`#t`/`#f`), the quote family (`'` `` ` `` `,` `,@`), dotted pairs
 * `(a . b)`, and `;` line comments.
 */

import {
  arrayToList,
  cons,
  keyword,
  LispError,
  NIL,
  Pair,
  sourceLocations,
  sym,
} from './values.js';

/** A token matches this exactly when it should be read as a number. */
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Characters that end an atom and are never part of one. */
const DELIMITERS = new Set(['(', ')', '[', ']', '{', '}', '"', ';', "'", '`', ',']);

/** Returned by {@link Reader#readForm} when the input is exhausted. */
const EOF = Symbol('eof');

/** Whitespace test. */
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

class Reader {
  /** @param {string} source */
  constructor(source) {
    this.src = source;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
  }

  atEnd() {
    return this.pos >= this.src.length;
  }

  peek() {
    return this.atEnd() ? null : this.src[this.pos];
  }

  /** Consume and return the next character, tracking line/column. */
  next() {
    const ch = this.src[this.pos];
    this.pos += 1;
    if (ch === '\n') {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    return ch;
  }

  /** Skip whitespace and `;` line comments. */
  skipAtmosphere() {
    for (;;) {
      const ch = this.peek();
      if (ch === null) return;
      if (ch === ';') {
        while (!this.atEnd() && this.peek() !== '\n') this.next();
      } else if (isSpace(ch)) {
        this.next();
      } else {
        return;
      }
    }
  }

  /** Read a run of characters up to the next delimiter or whitespace. */
  readToken() {
    let out = '';
    for (;;) {
      const ch = this.peek();
      if (ch === null || isSpace(ch) || DELIMITERS.has(ch)) break;
      out += this.next();
    }
    return out;
  }

  /** Read one form, or {@link EOF}. */
  readForm() {
    this.skipAtmosphere();
    if (this.atEnd()) return EOF;
    const line = this.line;
    const col = this.col;
    const ch = this.peek();

    if (ch === '(') return this.readSequence('(', ')', line, col);
    if (ch === '[') return this.readSequence('[', ']', line, col);
    if (ch === '{') return this.readSequence('{', '}', line, col);
    if (ch === ')' || ch === ']' || ch === '}') {
      throw new LispError(`unexpected '${ch}' at ${line}:${col}`);
    }
    if (ch === "'") {
      this.next();
      return this.wrap('quote', line, col);
    }
    if (ch === '`') {
      this.next();
      return this.wrap('quasiquote', line, col);
    }
    if (ch === ',') {
      this.next();
      if (this.peek() === '@') {
        this.next();
        return this.wrap('unquote-splicing', line, col);
      }
      return this.wrap('unquote', line, col);
    }
    if (ch === '"') return this.readString(line, col);
    if (ch === '#') return this.readHash(line, col);
    return this.readAtom(line, col);
  }

  /** Wrap the next form in a reader macro, e.g. `'x` -> `(quote x)`. */
  wrap(name, line, col) {
    const inner = this.readForm();
    if (inner === EOF) {
      throw new LispError(`unexpected end of input after ${name}`);
    }
    const form = cons(sym(name), cons(inner, NIL));
    sourceLocations.set(form, { line, col });
    return form;
  }

  /** A lone `.` is the dotted-pair marker; `.5` and `...` are atoms. */
  isDotMarker() {
    if (this.peek() !== '.') return false;
    const after = this.pos + 1 < this.src.length ? this.src[this.pos + 1] : null;
    return after === null || isSpace(after) || DELIMITERS.has(after);
  }

  /** Read a `(...)` list, `[...]` vector or `{...}` map. */
  readSequence(open, close, line, col) {
    this.next(); // consume the opening bracket
    const items = [];
    let tail = NIL;

    for (;;) {
      this.skipAtmosphere();
      if (this.atEnd()) {
        throw new LispError(`unclosed '${open}' opened at ${line}:${col}`);
      }
      const ch = this.peek();
      if (ch === close) {
        this.next();
        break;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        throw new LispError(
          `mismatched '${ch}', expected '${close}' for '${open}' at ${line}:${col}`
        );
      }
      if (open === '(' && this.isDotMarker()) {
        this.next(); // consume '.'
        tail = this.readForm();
        if (tail === EOF) {
          throw new LispError('unexpected end of input in dotted list');
        }
        this.skipAtmosphere();
        if (this.peek() !== close) {
          throw new LispError(`expected '${close}' after dotted tail`);
        }
        this.next();
        break;
      }
      items.push(this.readForm());
    }

    if (open === '[') return Object.freeze(items);
    if (open === '{') {
      if (items.length % 2 !== 0) {
        throw new LispError('map literal needs an even number of forms');
      }
      const map = new Map();
      for (let i = 0; i < items.length; i += 2) {
        map.set(items[i], items[i + 1]);
      }
      return map;
    }
    const result = arrayToList(items, tail);
    if (result instanceof Pair) sourceLocations.set(result, { line, col });
    return result;
  }

  /** Read a `"..."` string with escapes. */
  readString(line, col) {
    this.next(); // opening quote
    let out = '';
    for (;;) {
      if (this.atEnd()) {
        throw new LispError(`unclosed string opened at ${line}:${col}`);
      }
      const ch = this.next();
      if (ch === '"') break;
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      if (this.atEnd()) throw new LispError('unterminated escape in string');
      const esc = this.next();
      const mapped = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"' };
      out += Object.hasOwn(mapped, esc) ? mapped[esc] : esc;
    }
    return out;
  }

  /** Read a `#`-prefixed token (`#t`, `#f`). */
  readHash(line, col) {
    const token = this.readToken();
    if (token === '#t' || token === '#true') return true;
    if (token === '#f' || token === '#false') return false;
    throw new LispError(`unknown # syntax '${token}' at ${line}:${col}`);
  }

  /** Read a number, keyword or symbol. */
  readAtom(line, col) {
    const token = this.readToken();
    if (token === '') {
      throw new LispError(`unexpected character at ${line}:${col}`);
    }
    if (token[0] === ':' && token.length > 1) {
      return keyword(token.slice(1));
    }
    if (NUMBER_RE.test(token)) {
      return Number(token);
    }
    return sym(token);
  }

  /** Read every top-level form. */
  readAll() {
    const forms = [];
    for (;;) {
      const form = this.readForm();
      if (form === EOF) break;
      forms.push(form);
    }
    return forms;
  }
}

/**
 * Read all top-level forms from Lisp source.
 * @param {string} source
 * @returns {*[]}
 */
export function read(source) {
  return new Reader(String(source)).readAll();
}

/**
 * Read exactly one form from Lisp source.
 * @param {string} source
 * @returns {*}
 * @throws {LispError} If there is no form, or more than one.
 */
export function readOne(source) {
  const forms = read(source);
  if (forms.length === 0) throw new LispError('no form to read');
  if (forms.length > 1) throw new LispError('expected exactly one form');
  return forms[0];
}
