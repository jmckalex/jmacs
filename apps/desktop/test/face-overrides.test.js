import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyOverrides,
  jsonToLispOverrides,
  lispToJsonOverrides,
  lispToJsonFacesFile,
  jsonToLispUserFaces,
  jsonToLispHighlightRules,
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

// --- the full faces.json file (v2) ------------------------------------
// Lisp cons / list stand-ins matching @editor/lisp's Pair shape, plus
// the arrayToList / listToArray helpers the converters take.

const consCell = (head, tail) => ({ head, tail });
const NIL_SENTINEL = { isNil: true };
const arrayToList = (items) => {
  let acc = NIL_SENTINEL;
  for (let i = items.length - 1; i >= 0; i -= 1) acc = consCell(items[i], acc);
  return acc;
};
const listToArr = (node) => {
  const out = [];
  let n = node;
  while (n && n.isNil !== true && n.head !== undefined) {
    out.push(n.head);     // each element (a cons pair) is the node's head
    n = n.tail;
  }
  return out;
};

test('jsonToLispUserFaces builds the *user-faces* map', () => {
  const json = {
    userFaces: {
      myface: {
        doc: 'mine',
        parent: 'keyword',
        light: { foreground: '#111' },
        dark: { foreground: '#222' },
        bright: { foreground: '#333' },
        midnight: { foreground: '#444' },
      },
    },
  };
  const m = jsonToLispUserFaces(json, f);
  const entry = m.get(sym('myface'));
  assert.ok(entry instanceof Map);
  assert.equal(entry.get(keyword('doc')), 'mine');
  assert.equal(entry.get(keyword('parent')), sym('keyword'));
  assert.equal(entry.get(keyword('dark')).get(keyword('foreground')), '#222');
});

test('jsonToLispUserFaces tolerates a null parent', () => {
  const json = { userFaces: { x: { doc: '', parent: null, dark: {} } } };
  const m = jsonToLispUserFaces(json, f);
  assert.equal(m.get(sym('x')).get(keyword('parent')), null);
});

test('jsonToLispHighlightRules builds the scope-keyed rule store', () => {
  const json = {
    highlightRules: {
      'mode:LaTeX': [['command_name', 'keyword']],
      'lang:python': [['identifier', 'variable']],
    },
  };
  const m = jsonToLispHighlightRules(json, f, arrayToList, consCell);
  const latex = listToArr(m.get('mode:LaTeX'));
  assert.equal(latex.length, 1);
  assert.equal(latex[0].head, 'command_name');
  assert.equal(latex[0].tail, 'keyword');
});

test('lispToJsonFacesFile serialises overrides + user faces + rules', () => {
  // Build the Lisp `current-faces-file` map: {:overrides :userFaces :highlightRules}.
  const overrides = emptyOverrides(f);
  overrides
    .get(keyword('global'))
    .set(sym('keyword'), new Map([[keyword('weight'), keyword('bold')]]));

  const userFaces = new Map();
  const uf = new Map();
  uf.set(keyword('doc'), 'mine');
  uf.set(keyword('parent'), null);
  uf.set(keyword('dark'), new Map([[keyword('foreground'), '#222']]));
  userFaces.set(sym('myface'), uf);

  const rules = new Map();
  rules.set('mode:LaTeX', arrayToList([consCell('command_name', 'keyword')]));

  const facesFile = new Map([
    [keyword('overrides'), overrides],
    [keyword('userFaces'), userFaces],
    [keyword('highlightRules'), rules],
  ]);

  const json = lispToJsonFacesFile(facesFile, f, listToArr);
  assert.equal(json.version, 2);
  assert.deepEqual(json.global.keyword, { weight: 'bold' });
  assert.equal(json.userFaces.myface.doc, 'mine');
  assert.equal(json.userFaces.myface.parent, null);
  assert.deepEqual(json.userFaces.myface.dark, { foreground: '#222' });
  assert.deepEqual(json.highlightRules['mode:LaTeX'], [
    ['command_name', 'keyword'],
  ]);
});

test('a v1 faces.json yields empty userFaces and highlightRules', () => {
  const json = { global: { keyword: { weight: 'bold' } }, themes: {} };
  assert.deepEqual(jsonToLispUserFaces(json, f), new Map());
  assert.deepEqual(
    jsonToLispHighlightRules(json, f, arrayToList, consCell),
    new Map()
  );
});
