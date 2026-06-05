import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLanguages,
  languageForFilename,
  loadLanguageHighlighters,
  registerLanguage,
  registeredLanguages,
} from '../src/language-registry.js';

const SPEC = {
  tag: 'fortran',
  grammar: 'tree-sitter-fortran.wasm',
  query: '(comment) @comment',
  suffixes: ['.f90', '.f95'],
};

beforeEach(() => clearLanguages());

test('registerLanguage stores a language spec the registry can read back', () => {
  registerLanguage(SPEC);
  const langs = registeredLanguages();
  assert.equal(langs.length, 1);
  assert.equal(langs[0].tag, 'fortran');
  assert.equal(langs[0].grammar, 'tree-sitter-fortran.wasm');
  assert.deepEqual(langs[0].suffixes, ['.f90', '.f95']);
});

test('languageForFilename matches the registered suffixes', () => {
  registerLanguage(SPEC);
  assert.equal(languageForFilename('alpha.f90'), 'fortran');
  assert.equal(languageForFilename('big.f95'), 'fortran');
  assert.equal(languageForFilename('readme.txt'), null);
});

test('languageForFilename returns null for a non-string input', () => {
  registerLanguage(SPEC);
  assert.equal(languageForFilename(undefined), null);
  assert.equal(languageForFilename(null), null);
});

test('registerLanguage validates the spec', () => {
  assert.throws(() => registerLanguage({}), /missing tag/);
  assert.throws(
    () => registerLanguage({ tag: 'x' }),
    /missing grammar/
  );
  assert.throws(
    () => registerLanguage({ tag: 'x', grammar: 'g.wasm' }),
    /missing query/
  );
  // suffixes is required as an array — an empty array is allowed for
  // injection-only languages (e.g. markdown_inline, reached only via
  // a fenced-block injection).
  assert.throws(
    () =>
      registerLanguage({
        tag: 'x',
        grammar: 'g.wasm',
        query: '',
      }),
    /missing suffixes/
  );
  assert.throws(
    () =>
      registerLanguage({
        tag: 'x',
        grammar: 'g.wasm',
        query: '',
        suffixes: 'not-an-array',
      }),
    /missing suffixes/
  );
});

test('registering the same tag twice replaces the earlier spec', () => {
  registerLanguage(SPEC);
  registerLanguage({ ...SPEC, suffixes: ['.f03'] });
  assert.deepEqual(registeredLanguages()[0].suffixes, ['.f03']);
  assert.equal(languageForFilename('a.f90'), null);
  assert.equal(languageForFilename('a.f03'), 'fortran');
});

test('clearLanguages empties the registry', () => {
  registerLanguage(SPEC);
  assert.equal(registeredLanguages().length, 1);
  clearLanguages();
  assert.equal(registeredLanguages().length, 0);
});

test('loadLanguageHighlighters calls create for each language', async () => {
  registerLanguage(SPEC);
  registerLanguage({ ...SPEC, tag: 'cobol', suffixes: ['.cob'] });
  const calls = [];
  const create = async (grammar, query) => {
    calls.push(grammar);
    return { highlight: () => [[{ text: query, face: null }]] };
  };
  const { highlighters } = await loadLanguageHighlighters(create);
  assert.equal(calls.length, 2);
  assert.ok('fortran' in highlighters);
  assert.ok('cobol' in highlighters);
  assert.equal(typeof highlighters.fortran, 'function');
});

test('loadLanguageHighlighters reports per-language failures and continues', async () => {
  registerLanguage(SPEC);
  registerLanguage({
    ...SPEC,
    tag: 'cobol',
    grammar: 'tree-sitter-cobol.wasm',
    suffixes: ['.cob'],
  });
  const errors = [];
  const create = async (grammar) => {
    if (grammar.includes('fortran')) throw new Error('boom');
    return { highlight: () => [] };
  };
  const { highlighters } = await loadLanguageHighlighters(create, (tag, error) => {
    errors.push([tag, error.message]);
  });
  assert.deepEqual(errors, [['fortran', 'boom']]);
  assert.ok('cobol' in highlighters);
  assert.ok(!('fortran' in highlighters));
});

test('registerLanguage accepts an empty suffixes array (injection-only language)', () => {
  registerLanguage({ ...SPEC, suffixes: [] });
  // No suffix means it is never selected by filename.
  assert.equal(languageForFilename('alpha.f90'), null);
  // It does appear in the registry, though, so injection can reach it.
  assert.equal(registeredLanguages().length, 1);
});

test('registerLanguage stores an injectionQuery when provided', () => {
  registerLanguage({
    ...SPEC,
    injectionQuery:
      '((script_element (raw_text) @injection.content) ' +
      '(#set! injection.language "javascript"))',
  });
  assert.match(registeredLanguages()[0].injectionQuery, /injection\.content/);
});

test('registerLanguage rejects a non-string injectionQuery', () => {
  assert.throws(
    () => registerLanguage({ ...SPEC, injectionQuery: 42 }),
    /injectionQuery must be a string/
  );
});

test('loadLanguageHighlighters threads getHighlighter only into injection-bearing languages', async () => {
  registerLanguage(SPEC); // no injection
  registerLanguage({
    ...SPEC,
    tag: 'cobol',
    grammar: 'tree-sitter-cobol.wasm',
    suffixes: ['.cob'],
    injectionQuery: '((x) @injection.content)',
  });
  /** @type {Record<string, object | undefined>} */
  const seenOptions = {};
  const create = async (grammar, _query, options) => {
    seenOptions[grammar] = options;
    return {
      highlight: () => [],
      captures: () => [],
    };
  };
  await loadLanguageHighlighters(create);
  // Every language now gets at least its tag in options; the plain one
  // gets no injection wiring.
  assert.equal(seenOptions['tree-sitter-fortran.wasm'].tag, 'fortran');
  assert.equal(seenOptions['tree-sitter-fortran.wasm'].injectionQuery, undefined);
  assert.equal(seenOptions['tree-sitter-fortran.wasm'].getHighlighter, undefined);
  // The injection-bearing one got the query and a lookup closure.
  const cobolOpts = seenOptions['tree-sitter-cobol.wasm'];
  assert.equal(typeof cobolOpts.injectionQuery, 'string');
  assert.equal(typeof cobolOpts.getHighlighter, 'function');
});

test('aliases expose the same highlighter under additional tags', async () => {
  registerLanguage({ ...SPEC, aliases: ['for', 'f'] });
  let count = 0;
  const create = async () => {
    count += 1;
    return { highlight: () => [], captures: () => [] };
  };
  const { highlighters } = await loadLanguageHighlighters(create);
  assert.equal(count, 1); // one wasm load, not three
  assert.ok('fortran' in highlighters);
  assert.ok('for' in highlighters);
  assert.ok('f' in highlighters);
});

test('aliases never overwrite a real registered tag', async () => {
  // 'rs' is claimed as an alias of fortran, then registered as a
  // primary tag of another language — the real tag must win.
  registerLanguage({ ...SPEC, aliases: ['rs'] });
  registerLanguage({
    ...SPEC,
    tag: 'rs',
    grammar: 'tree-sitter-rs.wasm',
    suffixes: ['.rs'],
  });
  const create = async (grammar) => ({
    highlight: () => grammar,
    captures: () => [],
  });
  const { highlighters } = await loadLanguageHighlighters(create);
  // The 'rs' entry must come from the second registration, not the alias.
  assert.equal(highlighters.rs(), 'tree-sitter-rs.wasm');
});

test('registerLanguage rejects a non-array aliases', () => {
  assert.throws(
    () => registerLanguage({ ...SPEC, aliases: 'js' }),
    /aliases must be a string/
  );
});

test('registerLanguage stores a foldQuery when provided', () => {
  registerLanguage({
    ...SPEC,
    foldQuery: '(block) @fold',
  });
  assert.equal(registeredLanguages()[0].foldQuery, '(block) @fold');
});

test('registerLanguage rejects a non-string foldQuery', () => {
  assert.throws(
    () => registerLanguage({ ...SPEC, foldQuery: 42 }),
    /foldQuery must be a string/
  );
});

test('loadLanguageHighlighters threads foldQuery into create and exposes foldCaptures', async () => {
  registerLanguage(SPEC); // no fold
  registerLanguage({
    ...SPEC,
    tag: 'cobol',
    grammar: 'tree-sitter-cobol.wasm',
    suffixes: ['.cob'],
    foldQuery: '(division) @fold',
  });
  /** @type {Record<string, object | undefined>} */
  const seen = {};
  const create = async (grammar, _query, options) => {
    seen[grammar] = options;
    return {
      highlight: () => [],
      captures: () => [],
      // Only the foldable language gets a foldCaptures method on its
      // highlighter — mirrors the real treesitter.js behaviour.
      foldCaptures: grammar.includes('cobol')
        ? () => [{ start: 0, end: 10 }]
        : undefined,
    };
  };
  const { highlighters, foldCaptures } = await loadLanguageHighlighters(create);
  // The plain language got options carrying its tag but no fold query.
  assert.equal(seen['tree-sitter-fortran.wasm'].tag, 'fortran');
  assert.equal(seen['tree-sitter-fortran.wasm'].foldQuery, undefined);
  // The folding one got the query.
  assert.equal(seen['tree-sitter-cobol.wasm'].foldQuery, '(division) @fold');
  // Only the folding language has a foldCaptures entry.
  assert.ok('cobol' in foldCaptures);
  assert.equal(typeof foldCaptures.cobol, 'function');
  assert.ok(!('fortran' in foldCaptures));
  // Both languages have highlighters.
  assert.ok('fortran' in highlighters);
  assert.ok('cobol' in highlighters);
});

test('loadLanguageHighlighters threads tag + overrideStore into every create', async () => {
  registerLanguage(SPEC);
  registerLanguage({
    ...SPEC,
    tag: 'cobol',
    grammar: 'tree-sitter-cobol.wasm',
    suffixes: ['.cob'],
  });
  const store = { marker: 'store' };
  /** @type {Record<string, object>} */
  const seen = {};
  const create = async (grammar, _query, options) => {
    seen[grammar] = options;
    return { highlight: () => [], captures: () => [] };
  };
  await loadLanguageHighlighters(create, () => {}, store);
  assert.equal(seen['tree-sitter-fortran.wasm'].tag, 'fortran');
  assert.equal(seen['tree-sitter-fortran.wasm'].overrideStore, store);
  assert.equal(seen['tree-sitter-cobol.wasm'].tag, 'cobol');
  assert.equal(seen['tree-sitter-cobol.wasm'].overrideStore, store);
});

test('the exposed highlighter callable forwards a modeName argument', async () => {
  registerLanguage(SPEC);
  /** @type {(string|null)[]} */
  const highlightModes = [];
  /** @type {(string|null)[]} */
  const captureModes = [];
  const create = async () => ({
    highlight: (_text, modeName) => {
      highlightModes.push(modeName);
      return [];
    },
    captures: (_text, _depth, modeName) => {
      captureModes.push(modeName);
      return [];
    },
    nodeAtPoint: () => null,
  });
  const { highlighters } = await loadLanguageHighlighters(create);
  highlighters.fortran('code', 'Fortran');
  highlighters.fortran.captures('code', 'Fortran');
  assert.deepEqual(highlightModes, ['Fortran']);
  assert.deepEqual(captureModes, ['Fortran']);
  // Called with no mode, the callable forwards null (a base highlight).
  highlighters.fortran('code');
  assert.equal(highlightModes[1], null);
});

test('getHighlighter resolves siblings lazily, after every language is loaded', async () => {
  // Two languages: A injects B; B is registered *after* A. The
  // closure must read the populated map at injection time, not at
  // load time — so the lookup for B succeeds even though it had not
  // been built when A was constructed.
  registerLanguage({
    tag: 'a',
    grammar: 'a.wasm',
    query: '',
    suffixes: ['.a'],
    injectionQuery: '((x) @injection.content)',
  });
  registerLanguage({
    tag: 'b',
    grammar: 'b.wasm',
    query: '',
    suffixes: ['.b'],
  });
  /** @type {(tag: string) => unknown} */
  let capturedLookup = null;
  const create = async (grammar, _query, options) => {
    if (options && options.getHighlighter) {
      capturedLookup = options.getHighlighter;
    }
    return {
      highlight: () => [],
      captures: () => [`captured-${grammar}`],
    };
  };
  await loadLanguageHighlighters(create);
  assert.equal(typeof capturedLookup, 'function');
  // The closure must see 'b' even though A was constructed before B.
  const innerB = capturedLookup('b');
  assert.ok(innerB);
  assert.equal(typeof innerB.captures, 'function');
  assert.deepEqual(innerB.captures(''), ['captured-b.wasm']);
});
