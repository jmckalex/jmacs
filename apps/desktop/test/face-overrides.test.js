import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyOverrides,
  jsonToLispOverrides,
  lispToJsonOverrides,
} from '../src/face-overrides.js';

// --- stand-ins for @editor/lisp's keyword / sym -----------------------
// The desktop test package has no @editor/* dependency, so we mock the
// interned-name shape: an object with a string `name`. The module
// under test only treats the values opaquely (as map keys / objects to
// inspect `.name` on), so interning isn't required for the test —
// equality by reference *is*, hence the cache.

const symbolTable = new Map();
const keywordTable = new Map();
const sym = (name) => {
  let s = symbolTable.get(name);
  if (s === undefined) {
    s = Object.freeze({ name, kind: 'sym' });
    symbolTable.set(name, s);
  }
  return s;
};
const keyword = (name) => {
  let k = keywordTable.get(name);
  if (k === undefined) {
    k = Object.freeze({ name, kind: 'kw' });
    keywordTable.set(name, k);
  }
  return k;
};
const f = { keyword, sym };

test('emptyOverrides has :global and :themes both empty', () => {
  const m = emptyOverrides(f);
  assert.ok(m instanceof Map);
  assert.ok(m.get(keyword('global')) instanceof Map);
  assert.equal(m.get(keyword('global')).size, 0);
  assert.ok(m.get(keyword('themes')) instanceof Map);
  assert.equal(m.get(keyword('themes')).size, 0);
});

test('jsonToLispOverrides on null returns the empty shape', () => {
  const m = jsonToLispOverrides(null, f);
  assert.equal(m.get(keyword('global')).size, 0);
  assert.equal(m.get(keyword('themes')).size, 0);
});

test('jsonToLispOverrides reads a global face with a colour', () => {
  const json = { global: { keyword: { foreground: '#ff0000' } } };
  const m = jsonToLispOverrides(json, f);
  const face = m.get(keyword('global')).get(sym('keyword'));
  assert.ok(face);
  assert.equal(face.get(keyword('foreground')), '#ff0000');
});

test('jsonToLispOverrides reinterns weight/slant values as keywords', () => {
  const json = { global: { k: { weight: 'bold', slant: 'italic' } } };
  const m = jsonToLispOverrides(json, f);
  const face = m.get(keyword('global')).get(sym('k'));
  assert.equal(face.get(keyword('weight')), keyword('bold'));
  assert.equal(face.get(keyword('slant')), keyword('italic'));
});

test('jsonToLispOverrides reads per-theme overrides', () => {
  const json = { themes: { dark: { operator: { foreground: '#62b3b2' } } } };
  const m = jsonToLispOverrides(json, f);
  const themeMap = m.get(keyword('themes')).get(sym('dark'));
  assert.ok(themeMap);
  const face = themeMap.get(sym('operator'));
  assert.equal(face.get(keyword('foreground')), '#62b3b2');
});

test('lispToJsonOverrides round-trips a global face', () => {
  const json = { global: { keyword: { foreground: '#abc', weight: 'bold' } } };
  const m = jsonToLispOverrides(json, f);
  const back = lispToJsonOverrides(m, f);
  assert.deepEqual(back.global.keyword, { foreground: '#abc', weight: 'bold' });
});

test('lispToJsonOverrides round-trips per-theme overrides', () => {
  const json = {
    global: { keyword: { weight: 'bold' } },
    themes: {
      dark: { operator: { foreground: '#62b3b2' } },
      midnight: { comment: { weight: 'bold' } },
    },
    perMode: {},
  };
  const back = lispToJsonOverrides(jsonToLispOverrides(json, f), f);
  assert.deepEqual(back, json);
});

test('jsonToLispOverrides reads per-mode overrides keyed by mode name', () => {
  const json = { perMode: { LaTeX: { keyword: { foreground: '#c0a' } } } };
  const m = jsonToLispOverrides(json, f);
  const perMode = m.get(keyword('perMode'));
  assert.ok(perMode instanceof Map);
  // The bucket key is the plain mode name STRING, not a symbol.
  const modeMap = perMode.get('LaTeX');
  assert.ok(modeMap instanceof Map);
  assert.equal(modeMap.get(sym('keyword')).get(keyword('foreground')), '#c0a');
});

test('lispToJsonOverrides round-trips per-mode overrides', () => {
  const json = {
    global: {},
    themes: {},
    perMode: {
      LaTeX: { keyword: { foreground: '#c0a' } },
      Python: { string: { weight: 'bold' } },
    },
  };
  const back = lispToJsonOverrides(jsonToLispOverrides(json, f), f);
  assert.deepEqual(back, json);
});

test('a pre-perMode faces.json (v1) migrates cleanly to an empty bucket', () => {
  // No `perMode` key at all — the old on-disk shape.
  const json = { global: { keyword: { weight: 'bold' } }, themes: {} };
  const m = jsonToLispOverrides(json, f);
  assert.ok(m.get(keyword('perMode')) instanceof Map);
  assert.equal(m.get(keyword('perMode')).size, 0);
  // And it still reads the global it does have.
  assert.equal(
    m.get(keyword('global')).get(sym('keyword')).get(keyword('weight')).name,
    'bold'
  );
});

test('lispToJsonOverrides skips empty face entries', () => {
  const m = emptyOverrides(f);
  m.get(keyword('global')).set(sym('keyword'), new Map());
  const back = lispToJsonOverrides(m, f);
  assert.deepEqual(back.global, {});
});

test('lispToJsonOverrides handles boolean attribute values', () => {
  const m = emptyOverrides(f);
  const face = new Map();
  face.set(keyword('underline'), true);
  face.set(keyword('strike-through'), false);
  m.get(keyword('global')).set(sym('link'), face);
  const back = lispToJsonOverrides(m, f);
  assert.equal(back.global.link.underline, true);
  assert.equal(back.global.link['strike-through'], false);
});
