/**
 * @file The value model for the editor's Lisp. Defines the data types
 * the reader produces and the evaluator works with, the equality and
 * truthiness rules, and the printer.
 *
 * Representation choices:
 * - numbers, strings, booleans  -> the JavaScript equivalents
 * - the empty list / nil        -> the singleton {@link NIL}
 * - lists                       -> chains of immutable {@link Pair}s
 * - symbols, keywords           -> interned {@link Sym} / {@link Keyword}
 * - vectors                     -> frozen JavaScript arrays
 * - maps                        -> JavaScript `Map`s
 *
 * Truthiness follows Scheme: only `#f` (JS `false`) is false. The empty
 * list, 0 and "" are all truthy.
 */

/** Source positions for forms, keyed by the form (a {@link Pair}). */
export const sourceLocations = new WeakMap();

// --- symbols ------------------------------------------------------------

/** An interned identifier. Equal symbols are the same object. */
export class Sym {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    Object.freeze(this);
  }
}

const symbolTable = new Map();

/**
 * Intern a symbol.
 * @param {string} name
 * @returns {Sym}
 */
export function sym(name) {
  let existing = symbolTable.get(name);
  if (existing === undefined) {
    existing = new Sym(name);
    symbolTable.set(name, existing);
  }
  return existing;
}

// --- keywords -----------------------------------------------------------

/** An interned, self-evaluating keyword, written `:like-this`. */
export class Keyword {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    Object.freeze(this);
  }
}

const keywordTable = new Map();

/**
 * Intern a keyword.
 * @param {string} name - The name without the leading colon.
 * @returns {Keyword}
 */
export function keyword(name) {
  let existing = keywordTable.get(name);
  if (existing === undefined) {
    existing = new Keyword(name);
    keywordTable.set(name, existing);
  }
  return existing;
}

// --- the empty list -----------------------------------------------------

/** The type of {@link NIL}. */
class NilType {}

/** The empty list, also the editor Lisp's `nil`. */
export const NIL = new NilType();

// --- pairs and lists ----------------------------------------------------

/** An immutable cons cell. */
export class Pair {
  /**
   * @param {*} head
   * @param {*} tail
   */
  constructor(head, tail) {
    this.head = head;
    this.tail = tail;
    Object.freeze(this);
  }
}

/**
 * Construct a cons cell.
 * @param {*} head
 * @param {*} tail
 * @returns {Pair}
 */
export function cons(head, tail) {
  return new Pair(head, tail);
}

/**
 * Build a proper list from arguments.
 * @param {...*} items
 * @returns {Pair | NilType}
 */
export function list(...items) {
  return arrayToList(items);
}

/**
 * Build a proper list from an array, optionally with a non-nil tail.
 * @param {*[]} items
 * @param {*} [tail=NIL]
 * @returns {Pair | NilType}
 */
export function arrayToList(items, tail = NIL) {
  let result = tail;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    result = cons(items[i], result);
  }
  return result;
}

/**
 * Collect a proper list into an array.
 * @param {*} value
 * @returns {*[]}
 * @throws {LispError} If `value` is not a proper list.
 */
export function listToArray(value) {
  const items = [];
  let node = value;
  while (node instanceof Pair) {
    items.push(node.head);
    node = node.tail;
  }
  if (node !== NIL) {
    throw new LispError('expected a proper list');
  }
  return items;
}

/** @param {*} value @returns {boolean} */
export function isList(value) {
  let node = value;
  while (node instanceof Pair) node = node.tail;
  return node === NIL;
}

// --- procedures ---------------------------------------------------------

/** A built-in procedure implemented in JavaScript. */
export class Primitive {
  /**
   * @param {string} name
   * @param {(args: *[]) => *} fn
   */
  constructor(name, fn) {
    this.name = name;
    this.fn = fn;
  }
}

/** A procedure defined in Lisp by `lambda` or `define`. */
export class Lambda {
  /**
   * @param {Sym[]} params - Required parameter names.
   * @param {Sym | null} rest - A rest parameter, or null.
   * @param {*[]} body - Body forms, evaluated in sequence.
   * @param {object} env - The closed-over lexical environment.
   */
  constructor(params, rest, body, env) {
    this.params = params;
    this.rest = rest;
    this.body = body;
    this.env = env;
    /** @type {string} */
    this.name = 'anonymous';
    /** @type {string | null} */
    this.doc = null;
    /** @type {object | null} */
    this.source = null;
  }
}

/** A macro: a transformer from source forms to a new source form. */
export class LispMacro {
  /**
   * @param {string} name
   * @param {Lambda | Primitive} transformer
   */
  constructor(name, transformer) {
    this.name = name;
    this.transformer = transformer;
  }
}

/** @param {*} value @returns {boolean} Whether `value` is callable. */
export function isProcedure(value) {
  return value instanceof Lambda || value instanceof Primitive;
}

// --- errors -------------------------------------------------------------

/** An error raised during reading or evaluation. */
export class LispError extends Error {
  /**
   * @param {string} message
   * @param {*[]} [irritants] - Extra Lisp values describing the error.
   */
  constructor(message, irritants = []) {
    super(message);
    this.name = 'LispError';
    this.lispMessage = message;
    this.irritants = irritants;
  }
}

// --- truthiness and equality -------------------------------------------

/**
 * Scheme truthiness: only `#f` is false.
 * @param {*} value
 * @returns {boolean}
 */
export function isTruthy(value) {
  return value !== false;
}

/**
 * Identity equality: same object for symbols, keywords, pairs and
 * procedures; value equality for numbers, strings and booleans.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function eq(a, b) {
  return a === b;
}

/**
 * Deep structural equality over lists, vectors and maps.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function equal(a, b) {
  if (a === b) return true;
  if (a instanceof Pair && b instanceof Pair) {
    return equal(a.head, b.head) && equal(a.tail, b.tail);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !equal(value, b.get(key))) return false;
    }
    return true;
  }
  return false;
}

// --- printing -----------------------------------------------------------

/** Escape a string for re-readable output. */
function escapeString(text) {
  let out = '"';
  for (const ch of text) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out + '"';
}

/**
 * Render a value to a string.
 * @param {*} value
 * @param {boolean} readable - When true, strings are quoted and escaped
 *   (`write` semantics); when false, strings are raw (`display`).
 * @returns {string}
 */
function render(value, readable) {
  if (value === NIL) return 'nil';
  if (value === true) return '#t';
  if (value === false) return '#f';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return readable ? escapeString(value) : value;
  }
  if (value instanceof Sym) return value.name;
  if (value instanceof Keyword) return ':' + value.name;
  if (value instanceof Pair) {
    const parts = [];
    let node = value;
    while (node instanceof Pair) {
      parts.push(render(node.head, readable));
      node = node.tail;
    }
    if (node !== NIL) parts.push('.', render(node, readable));
    return '(' + parts.join(' ') + ')';
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => render(v, readable)).join(' ') + ']';
  }
  if (value instanceof Map) {
    const parts = [];
    for (const [k, v] of value) {
      parts.push(render(k, readable) + ' ' + render(v, readable));
    }
    return '{' + parts.join(' ') + '}';
  }
  if (value instanceof Lambda) return `#<procedure ${value.name}>`;
  if (value instanceof Primitive) return `#<primitive ${value.name}>`;
  if (value instanceof LispMacro) return `#<macro ${value.name}>`;
  return String(value);
}

/**
 * Render a value re-readably (quoted strings). The printer for the REPL.
 * @param {*} value
 * @returns {string}
 */
export function writeString(value) {
  return render(value, true);
}

/**
 * Render a value for human display (raw strings).
 * @param {*} value
 * @returns {string}
 */
export function displayString(value) {
  return render(value, false);
}

/**
 * A short description of a value's type, for error messages.
 * @param {*} value
 * @returns {string}
 */
export function typeName(value) {
  if (value === NIL) return 'nil';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (value instanceof Sym) return 'symbol';
  if (value instanceof Keyword) return 'keyword';
  if (value instanceof Pair) return 'list';
  if (Array.isArray(value)) return 'vector';
  if (value instanceof Map) return 'map';
  if (isProcedure(value)) return 'procedure';
  if (value instanceof LispMacro) return 'macro';
  return 'value';
}
