/**
 * @file The primitive procedures — the editor Lisp's built-in library,
 * implemented in JavaScript. Everything here is ordinary: it could in
 * principle be written in Lisp, but lives in the host for speed and to
 * bottom out the recursion.
 *
 * Naming follows the spec: predicates end in `?`, destructive
 * operations end in `!` (there are none here yet — buffer mutators are
 * registered by the host).
 */

import { applyProcedure, parametersToList } from './eval.js';
import { read } from './reader.js';
import {
  arrayToList,
  cons,
  displayString,
  equal,
  isList,
  isProcedure,
  keyword,
  Keyword,
  Lambda,
  LispError,
  LispMacro,
  listToArray,
  NIL,
  Pair,
  Primitive,
  Sym,
  sym,
  typeName,
  writeString,
} from './values.js';

/** Check argument count. */
function arity(name, args, min, max = min) {
  if (args.length < min || args.length > max) {
    const want =
      max === Infinity
        ? `at least ${min}`
        : min === max
          ? `${min}`
          : `${min}–${max}`;
    throw new LispError(
      `${name}: expected ${want} argument(s), got ${args.length}`
    );
  }
}

/** Assert a value is a number and return it. */
function num(name, value) {
  if (typeof value !== 'number') {
    throw new LispError(`${name}: expected a number, got ${typeName(value)}`);
  }
  return value;
}

/** Assert a value is a string and return it. */
function str(name, value) {
  if (typeof value !== 'string') {
    throw new LispError(`${name}: expected a string, got ${typeName(value)}`);
  }
  return value;
}

/** Coerce a list or vector to a JS array. */
function sequenceToArray(name, value) {
  if (Array.isArray(value)) return value;
  if (value === NIL || value instanceof Pair) return listToArray(value);
  throw new LispError(
    `${name}: expected a list or vector, got ${typeName(value)}`
  );
}

let gensymCounter = 0;

/**
 * Install all primitive procedures and constants into an environment.
 *
 * @param {import('./environment.js').Environment} env
 * @param {object} options
 * @param {(text: string) => void} options.write - The output sink for
 *   `print`, `display` and friends.
 */
export function installPrimitives(env, { write }) {
  /** Define a primitive procedure. */
  const def = (name, fn) => env.define(name, new Primitive(name, fn));

  // --- constants --------------------------------------------------------
  env.define('nil', NIL);
  env.define('true', true);
  env.define('false', false);

  // --- arithmetic -------------------------------------------------------
  def('+', (a) => a.reduce((sum, x) => sum + num('+', x), 0));
  def('*', (a) => a.reduce((product, x) => product * num('*', x), 1));
  def('-', (a) => {
    arity('-', a, 1, Infinity);
    if (a.length === 1) return -num('-', a[0]);
    return a.slice(1).reduce((acc, x) => acc - num('-', x), num('-', a[0]));
  });
  def('/', (a) => {
    arity('/', a, 1, Infinity);
    const divide = (x, y) => {
      if (num('/', y) === 0) throw new LispError('division by zero');
      return x / y;
    };
    if (a.length === 1) return divide(1, a[0]);
    return a.slice(1).reduce((acc, x) => divide(acc, x), num('/', a[0]));
  });
  def('mod', (a) => {
    arity('mod', a, 2);
    const d = num('mod', a[1]);
    if (d === 0) throw new LispError('mod: division by zero');
    return ((num('mod', a[0]) % d) + d) % d;
  });
  def('quotient', (a) => {
    arity('quotient', a, 2);
    return Math.trunc(num('quotient', a[0]) / num('quotient', a[1]));
  });
  def('remainder', (a) => {
    arity('remainder', a, 2);
    return num('remainder', a[0]) % num('remainder', a[1]);
  });
  def('abs', (a) => Math.abs(num('abs', a[0])));
  def('min', (a) => Math.min(...a.map((x) => num('min', x))));
  def('max', (a) => Math.max(...a.map((x) => num('max', x))));
  def('inc', (a) => num('inc', a[0]) + 1);
  def('dec', (a) => num('dec', a[0]) - 1);
  def('expt', (a) => num('expt', a[0]) ** num('expt', a[1]));
  def('sqrt', (a) => Math.sqrt(num('sqrt', a[0])));
  def('floor', (a) => Math.floor(num('floor', a[0])));
  def('ceiling', (a) => Math.ceil(num('ceiling', a[0])));
  def('round', (a) => Math.round(num('round', a[0])));
  // A random integer in [0, n). With no argument, a random real in [0, 1).
  // Used by jukebox-mode for Fisher–Yates shuffle.
  def('random', (a) => {
    if (a.length === 0) return Math.random();
    const n = num('random', a[0]);
    return Math.floor(Math.random() * n);
  });

  // --- numeric comparison ----------------------------------------------
  const chain = (name, ok) => (a) => {
    for (let i = 0; i + 1 < a.length; i += 1) {
      if (!ok(num(name, a[i]), num(name, a[i + 1]))) return false;
    }
    return true;
  };
  def('=', chain('=', (x, y) => x === y));
  def('<', chain('<', (x, y) => x < y));
  def('>', chain('>', (x, y) => x > y));
  def('<=', chain('<=', (x, y) => x <= y));
  def('>=', chain('>=', (x, y) => x >= y));

  // --- predicates -------------------------------------------------------
  def('nil?', (a) => a[0] === NIL);
  def('pair?', (a) => a[0] instanceof Pair);
  def('list?', (a) => isList(a[0]));
  def('number?', (a) => typeof a[0] === 'number');
  def('string?', (a) => typeof a[0] === 'string');
  def('symbol?', (a) => a[0] instanceof Sym);
  def('keyword?', (a) => a[0] instanceof Keyword);
  def('boolean?', (a) => typeof a[0] === 'boolean');
  def('procedure?', (a) => isProcedure(a[0]));
  def('vector?', (a) => Array.isArray(a[0]));
  def('map?', (a) => a[0] instanceof Map);
  def('zero?', (a) => num('zero?', a[0]) === 0);
  def('positive?', (a) => num('positive?', a[0]) > 0);
  def('negative?', (a) => num('negative?', a[0]) < 0);
  def('even?', (a) => num('even?', a[0]) % 2 === 0);
  def('odd?', (a) => num('odd?', a[0]) % 2 !== 0);
  def('empty?', (a) => {
    const v = a[0];
    if (v === NIL) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'string') return v.length === 0;
    if (v instanceof Map) return v.size === 0;
    return false;
  });

  // --- equality and logic ----------------------------------------------
  def('eq?', (a) => a[0] === a[1]);
  def('equal?', (a) => equal(a[0], a[1]));
  def('not', (a) => a[0] === false);

  // --- pairs and lists --------------------------------------------------
  def('cons', (a) => {
    arity('cons', a, 2);
    return cons(a[0], a[1]);
  });
  def('car', (a) => {
    if (!(a[0] instanceof Pair)) {
      throw new LispError(`car: expected a pair, got ${typeName(a[0])}`);
    }
    return a[0].head;
  });
  def('cdr', (a) => {
    if (!(a[0] instanceof Pair)) {
      throw new LispError(`cdr: expected a pair, got ${typeName(a[0])}`);
    }
    return a[0].tail;
  });
  def('first', (a) => (a[0] instanceof Pair ? a[0].head : NIL));
  def('rest', (a) => (a[0] instanceof Pair ? a[0].tail : NIL));
  def('list', (a) => arrayToList(a));
  def('length', (a) => {
    const v = a[0];
    if (typeof v === 'string' || Array.isArray(v)) return v.length;
    if (v instanceof Map) return v.size;
    return listToArray(v).length;
  });
  def('append', (a) => {
    if (a.length === 0) return NIL;
    const front = a.slice(0, -1).flatMap((l) => listToArray(l));
    return arrayToList(front, a[a.length - 1]);
  });
  def('reverse', (a) => arrayToList(listToArray(a[0]).reverse()));
  def('nth', (a) => {
    arity('nth', a, 2);
    const items = sequenceToArray('nth', a[0]);
    const i = num('nth', a[1]);
    if (i < 0 || i >= items.length) {
      throw new LispError(`nth: index ${i} out of range`);
    }
    return items[i];
  });
  def('last', (a) => {
    const items = listToArray(a[0]);
    return items.length === 0 ? NIL : items[items.length - 1];
  });
  def('member', (a) => {
    arity('member', a, 2);
    let node = a[1];
    while (node instanceof Pair) {
      if (equal(node.head, a[0])) return node;
      node = node.tail;
    }
    return false;
  });

  // --- higher-order -----------------------------------------------------
  def('apply', (a) => {
    arity('apply', a, 2, Infinity);
    const fn = a[0];
    const spread = listToArray(a[a.length - 1]);
    return applyProcedure(fn, [...a.slice(1, -1), ...spread]);
  });
  def('map', (a) => {
    arity('map', a, 2, Infinity);
    const fn = a[0];
    const lists = a.slice(1).map((l) => sequenceToArray('map', l));
    const len = Math.min(...lists.map((l) => l.length));
    const out = [];
    for (let i = 0; i < len; i += 1) {
      out.push(applyProcedure(fn, lists.map((l) => l[i])));
    }
    return arrayToList(out);
  });
  def('filter', (a) => {
    arity('filter', a, 2);
    const items = sequenceToArray('filter', a[1]);
    return arrayToList(
      items.filter((x) => applyProcedure(a[0], [x]) !== false)
    );
  });
  def('reduce', (a) => {
    arity('reduce', a, 3);
    const items = sequenceToArray('reduce', a[2]);
    return items.reduce((acc, x) => applyProcedure(a[0], [acc, x]), a[1]);
  });
  def('for-each', (a) => {
    arity('for-each', a, 2);
    for (const x of sequenceToArray('for-each', a[1])) {
      applyProcedure(a[0], [x]);
    }
    return NIL;
  });
  // (sort SEQ [LESS?]) — a sorted copy of SEQ, which may be a list or a
  // vector; the result has the same type as the input, and the input is
  // untouched. LESS? is a Lisp procedure used as a boolean less-than:
  // (less? a b) truthy means a orders strictly before b. It is adapted
  // to a three-way comparator — less?(a,b) ? -1 : less?(b,a) ? 1 : 0 —
  // so elements neither orders before the other compare equal. The sort
  // is STABLE (JS Array.prototype.sort): equal elements keep their
  // input order. When LESS? is omitted, all-numbers sort by `<` and
  // all-strings by JS string `<`; anything else needs a comparator.
  def('sort', (a) => {
    arity('sort', a, 1, 2);
    const items = [...sequenceToArray('sort', a[0])];
    let compare;
    if (a.length === 2) {
      const less = a[1];
      if (!isProcedure(less)) {
        throw new LispError(
          `sort: expected a procedure, got ${typeName(less)}`
        );
      }
      compare = (x, y) =>
        applyProcedure(less, [x, y]) !== false
          ? -1
          : applyProcedure(less, [y, x]) !== false
            ? 1
            : 0;
    } else if (items.every((x) => typeof x === 'number')) {
      compare = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    } else if (items.every((x) => typeof x === 'string')) {
      compare = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    } else {
      throw new LispError('sort: mixed or unordered elements need a comparator');
    }
    items.sort(compare);
    return Array.isArray(a[0]) ? Object.freeze(items) : arrayToList(items);
  });
  def('range', (a) => {
    arity('range', a, 1, 3);
    const start = a.length === 1 ? 0 : num('range', a[0]);
    const end = a.length === 1 ? num('range', a[0]) : num('range', a[1]);
    const step = a.length === 3 ? num('range', a[2]) : 1;
    if (step === 0) throw new LispError('range: step must not be zero');
    const out = [];
    for (let i = start; step > 0 ? i < end : i > end; i += step) {
      out.push(i);
    }
    return arrayToList(out);
  });

  // --- strings ----------------------------------------------------------
  def('str', (a) => a.map((x) => displayString(x)).join(''));
  def('string-append', (a) => a.map((x) => str('string-append', x)).join(''));
  // `(string-join LIST [SEP])` — join LIST's elements (each coerced like
  // `str`) with SEP (default ''). Iterative: joins a long list in a
  // single host pass, where a hand-written Lisp join would recurse
  // NON-tail (inside `str`) and overflow the stack on large input — the
  // trampoline only flattens tail calls (see eval.js).
  def('string-join', (a) => {
    arity('string-join', a, 1, 2);
    const items = sequenceToArray('string-join', a[0]);
    const sep = a.length === 2 ? displayString(a[1]) : '';
    return items.map((x) => displayString(x)).join(sep);
  });
  def('string-length', (a) => str('string-length', a[0]).length);
  def('substring', (a) => {
    arity('substring', a, 2, 3);
    const s = str('substring', a[0]);
    return a.length === 3
      ? s.slice(num('substring', a[1]), num('substring', a[2]))
      : s.slice(num('substring', a[1]));
  });
  def('string-upcase', (a) => str('string-upcase', a[0]).toUpperCase());
  def('string-downcase', (a) => str('string-downcase', a[0]).toLowerCase());
  // (string-capitalize s) — upcase the first character of every word
  // run (letters/digits/underscore, Unicode-aware) and downcase the
  // rest: "hello WORLD" -> "Hello World". Emacs's capitalize.
  def('string-capitalize', (a) =>
    str('string-capitalize', a[0]).replace(/[\p{L}\p{N}_]+/gu, (w) => {
      const chars = Array.from(w);
      return chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
    })
  );
  // (char-word? ch) — whether CH (a one-character string) is a word
  // constituent: a letter or digit in any script, or underscore. The
  // single word-character definition the editor's word motion and
  // word-selection features share.
  def('char-word?', (a) => {
    arity('char-word?', a, 1);
    return /^[\p{L}\p{N}_]$/u.test(str('char-word?', a[0]));
  });
  def('string-repeat', (a) => {
    // (string-repeat s n) — concatenate S to itself N times. N is
    // clamped to >= 0; non-finite / non-integer N is rejected.
    arity('string-repeat', a, 2);
    const s = str('string-repeat', a[0]);
    const n = num('string-repeat', a[1]);
    return s.repeat(Math.max(0, n | 0));
  });
  def('string-split', (a) => {
    arity('string-split', a, 2);
    return arrayToList(str('string-split', a[0]).split(str('string-split', a[1])));
  });
  def('string-contains?', (a) => {
    arity('string-contains?', a, 2);
    return str('string-contains?', a[0]).includes(str('string-contains?', a[1]));
  });
  def('string-index-of', (a) => {
    // (string-index-of haystack needle [start]) -> integer, or -1 when
    // not found. Matches String.prototype.indexOf semantics.
    arity('string-index-of', a, 2, 3);
    const haystack = str('string-index-of', a[0]);
    const needle = str('string-index-of', a[1]);
    const start = a.length === 3 ? num('string-index-of', a[2]) : 0;
    return haystack.indexOf(needle, start);
  });
  def('string-prefix?', (a) => {
    arity('string-prefix?', a, 2);
    return str('string-prefix?', a[1]).startsWith(str('string-prefix?', a[0]));
  });
  def('string-suffix?', (a) => {
    arity('string-suffix?', a, 2);
    return str('string-suffix?', a[1]).endsWith(str('string-suffix?', a[0]));
  });
  // Parse a string of source into a list of forms — the reader, exposed
  // to Lisp. Used by the notebook engine to read `(cell …)` forms out of
  // a buffer's text. The forms are unevaluated; pair with `eval`.
  def('read-string', (a) => {
    arity('read-string', a, 1);
    return arrayToList(read(str('read-string', a[0])));
  });
  def('string=?', (a) => {
    arity('string=?', a, 2);
    return str('string=?', a[0]) === str('string=?', a[1]);
  });
  def('string->symbol', (a) => sym(str('string->symbol', a[0])));
  def('symbol->string', (a) => {
    if (a[0] instanceof Sym) return a[0].name;
    if (a[0] instanceof Keyword) return a[0].name;
    throw new LispError('symbol->string: expected a symbol');
  });
  def('string->keyword', (a) => keyword(str('string->keyword', a[0])));
  def('keyword->string', (a) => {
    if (!(a[0] instanceof Keyword)) {
      throw new LispError('keyword->string: expected a keyword');
    }
    return a[0].name;
  });
  def('string->number', (a) => {
    const n = Number(str('string->number', a[0]));
    return Number.isNaN(n) ? false : n;
  });
  def('number->string', (a) => String(num('number->string', a[0])));

  // --- vectors ----------------------------------------------------------
  def('vector', (a) => Object.freeze([...a]));
  def('vector-ref', (a) => {
    arity('vector-ref', a, 2);
    if (!Array.isArray(a[0])) throw new LispError('vector-ref: expected a vector');
    const i = num('vector-ref', a[1]);
    if (i < 0 || i >= a[0].length) {
      throw new LispError(`vector-ref: index ${i} out of range`);
    }
    return a[0][i];
  });
  def('vector-length', (a) => {
    if (!Array.isArray(a[0])) throw new LispError('vector-length: expected a vector');
    return a[0].length;
  });
  def('vector->list', (a) => arrayToList(sequenceToArray('vector->list', a[0])));
  def('list->vector', (a) => Object.freeze(listToArray(a[0])));

  // --- maps -------------------------------------------------------------
  def('hash-map', (a) => {
    if (a.length % 2 !== 0) {
      throw new LispError('hash-map: expected an even number of arguments');
    }
    const m = new Map();
    for (let i = 0; i < a.length; i += 2) m.set(a[i], a[i + 1]);
    return m;
  });
  // Miss convention: absence is `#f`, so `(if (get m :key) …)` is a
  // safe bare test (nil is truthy in this Lisp). The three-argument
  // form returns its fallback unchanged — use it when a stored `#f`
  // (or any sentinel) must be distinguishable from a missing key.
  def('get', (a) => {
    arity('get', a, 2, 3);
    const fallback = a.length === 3 ? a[2] : false;
    if (a[0] instanceof Map) return a[0].has(a[1]) ? a[0].get(a[1]) : fallback;
    if (Array.isArray(a[0])) {
      return a[1] >= 0 && a[1] < a[0].length ? a[0][a[1]] : fallback;
    }
    throw new LispError('get: expected a map or vector');
  });
  def('assoc', (a) => {
    arity('assoc', a, 3);
    if (!(a[0] instanceof Map)) throw new LispError('assoc: expected a map');
    const m = new Map(a[0]);
    m.set(a[1], a[2]);
    return m;
  });
  def('dissoc', (a) => {
    arity('dissoc', a, 2);
    if (!(a[0] instanceof Map)) throw new LispError('dissoc: expected a map');
    const m = new Map(a[0]);
    m.delete(a[1]);
    return m;
  });
  def('contains?', (a) => {
    arity('contains?', a, 2);
    if (a[0] instanceof Map) return a[0].has(a[1]);
    throw new LispError('contains?: expected a map');
  });
  def('keys', (a) => {
    if (!(a[0] instanceof Map)) throw new LispError('keys: expected a map');
    return arrayToList([...a[0].keys()]);
  });
  def('vals', (a) => {
    if (!(a[0] instanceof Map)) throw new LispError('vals: expected a map');
    return arrayToList([...a[0].values()]);
  });

  // --- symbols ----------------------------------------------------------
  def('gensym', (a) => {
    const prefix = a.length > 0 ? str('gensym', a[0]) : 'g';
    gensymCounter += 1;
    return new Sym(`${prefix}__${gensymCounter}`);
  });

  // --- output -----------------------------------------------------------
  def('display', (a) => {
    write(displayString(a[0]));
    return NIL;
  });
  def('write', (a) => {
    write(writeString(a[0]));
    return NIL;
  });
  def('newline', () => {
    write('\n');
    return NIL;
  });
  def('print', (a) => {
    write(a.map((x) => displayString(x)).join(' '));
    return NIL;
  });
  def('println', (a) => {
    write(a.map((x) => displayString(x)).join(' ') + '\n');
    return NIL;
  });

  // --- errors -----------------------------------------------------------
  def('error', (a) => {
    arity('error', a, 1, Infinity);
    throw new LispError(str('error', a[0]), a.slice(1));
  });

  // --- introspection ----------------------------------------------------
  def('identity', (a) => a[0]);
  def('type-of', (a) => keyword(typeName(a[0])));
  // Miss convention: no docstring / no recorded source is an absence,
  // so both return `#f` — safe as a bare if-test.
  def('doc', (a) => {
    const v = a[0];
    if (v instanceof Lambda) return v.doc ?? false;
    return false;
  });
  def('where-defined', (a) => {
    const v = a[0];
    if (v instanceof Lambda && v.source) {
      return `${v.source.line}:${v.source.col}`;
    }
    return false;
  });
  def('describe', (a) => {
    const v = a[0];
    const info = new Map();
    info.set(keyword('kind'), keyword(describeKind(v)));
    if (v instanceof Lambda) {
      info.set(keyword('name'), sym(v.name));
      info.set(keyword('params'), parametersToList(v.params, v.rest));
      info.set(keyword('doc'), v.doc ?? NIL);
      info.set(
        keyword('defined-at'),
        v.source ? `${v.source.line}:${v.source.col}` : NIL
      );
    } else if (v instanceof Primitive || v instanceof LispMacro) {
      info.set(keyword('name'), sym(v.name));
    } else {
      info.set(keyword('type'), keyword(typeName(v)));
    }
    return info;
  });
}

/** A coarse classification for `describe`. */
function describeKind(value) {
  if (value instanceof Lambda) return 'procedure';
  if (value instanceof Primitive) return 'primitive';
  if (value instanceof LispMacro) return 'macro';
  return 'value';
}
