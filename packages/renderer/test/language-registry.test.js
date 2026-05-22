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
  assert.throws(
    () =>
      registerLanguage({
        tag: 'x',
        grammar: 'g.wasm',
        query: '',
        suffixes: [],
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
  const highlighters = await loadLanguageHighlighters(create);
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
  const highlighters = await loadLanguageHighlighters(create, (tag, error) => {
    errors.push([tag, error.message]);
  });
  assert.deepEqual(errors, [['fortran', 'boom']]);
  assert.ok('cobol' in highlighters);
  assert.ok(!('fortran' in highlighters));
});
