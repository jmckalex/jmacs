import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FACE_STYLE_ELEMENT_ID,
  applyFaceStyles,
  facesFromAlist,
  generateFaceCss,
  generateModeFaceCss,
  modeFacesFromAlist,
  writeFaceStyleElement,
} from '../src/face-styles.js';

/** A bare-bones Symbol/Keyword stand-in matching the Lisp shape: an
 *  object with a string `name`. The face-styles module accepts either
 *  strings or these. */
const sym = (name) => ({ name });

/** A cons pair the same shape `@editor/lisp` produces. The face-styles
 *  module only reads `.head` and `.tail`; it does not check the type. */
const cons = (head, tail) => ({ head, tail });

/** A list of conses ending in a sentinel — the test's stand-in for the
 *  NIL list terminator. The fake `listToArray` walks `.head`/`.tail`. */
const list = (...items) => {
  let acc = { isNil: true };
  for (let i = items.length - 1; i >= 0; i -= 1) {
    acc = cons(items[i], acc);
  }
  return acc;
};

/** Stand-in for `listToArray` from @editor/lisp: walks a cons list. */
const listToArray = (node) => {
  const out = [];
  let n = node;
  while (n && n.isNil !== true && n.head !== undefined) {
    out.push(n.head);
    n = n.tail;
  }
  return out;
};

/** A minimal DOM stub: head with append, getElementById, createElement.
 *  Enough for writeFaceStyleElement to do its job. */
function makeDoc() {
  const head = {
    children: [],
    append(el) {
      this.children.push(el);
    },
  };
  return {
    head,
    elements: new Map(),
    createElement(tag) {
      return { tagName: tag.toUpperCase(), id: '', textContent: '' };
    },
    getElementById(id) {
      for (const el of head.children) if (el.id === id) return el;
      return null;
    },
  };
}

// --- generateFaceCss --------------------------------------------------

test('generateFaceCss emits one rule per face with the given attrs', () => {
  const faces = new Map();
  faces.set('keyword', new Map([['foreground', '#ff0000'], ['weight', sym('bold')]]));
  faces.set('comment', new Map([['foreground', '#888888'], ['slant', sym('italic')]]));
  const css = generateFaceCss(faces);
  // Faces sorted alphabetically.
  assert.match(css, /\.tok-comment\s*\{[^}]*color: #888888;[^}]*\}/);
  assert.match(css, /\.tok-comment\s*\{[^}]*font-style: italic;[^}]*\}/);
  assert.match(css, /\.tok-keyword\s*\{[^}]*color: #ff0000;[^}]*\}/);
  assert.match(css, /\.tok-keyword\s*\{[^}]*font-weight: bold;[^}]*\}/);
  // comment comes before keyword in the output.
  assert.ok(css.indexOf('.tok-comment') < css.indexOf('.tok-keyword'));
});

test('generateFaceCss omits faces with no declared attributes', () => {
  const faces = new Map();
  faces.set('empty', new Map());
  faces.set('keyword', new Map([['foreground', '#ff0000']]));
  const css = generateFaceCss(faces);
  assert.doesNotMatch(css, /\.tok-empty/);
  assert.match(css, /\.tok-keyword/);
});

test('generateFaceCss handles underline + strike-through together', () => {
  const faces = new Map();
  faces.set('link', new Map([
    ['foreground', '#0000ff'],
    ['underline', true],
    ['strike-through', true],
  ]));
  const css = generateFaceCss(faces);
  assert.match(css, /text-decoration: underline line-through;/);
});

test('generateFaceCss skips text-decoration when neither flag is set', () => {
  const faces = new Map();
  faces.set('keyword', new Map([['foreground', '#fff']]));
  const css = generateFaceCss(faces);
  assert.doesNotMatch(css, /text-decoration/);
});

test('generateFaceCss treats false underline as absent', () => {
  const faces = new Map();
  faces.set('keyword', new Map([['foreground', '#fff'], ['underline', false]]));
  const css = generateFaceCss(faces);
  assert.doesNotMatch(css, /text-decoration/);
});

test('generateFaceCss writes background-color from :background', () => {
  const faces = new Map();
  faces.set('keyword', new Map([['background', '#222']]));
  const css = generateFaceCss(faces);
  assert.match(css, /background-color: #222;/);
});

test('generateFaceCss accepts a keyword for weight/slant', () => {
  const faces = new Map();
  faces.set('k', new Map([['weight', sym('bold')], ['slant', sym('italic')]]));
  const css = generateFaceCss(faces);
  assert.match(css, /font-weight: bold;/);
  assert.match(css, /font-style: italic;/);
});

// --- facesFromAlist ---------------------------------------------------

test('facesFromAlist converts the Lisp alist into nested maps', () => {
  const alist = [
    cons(sym('keyword'), list(cons(sym('foreground'), '#ff0000'))),
    cons(sym('comment'), list(
      cons(sym('foreground'), '#888'),
      cons(sym('slant'), sym('italic')),
    )),
  ];
  const faces = facesFromAlist(alist, listToArray);
  assert.equal(faces.get('keyword').get('foreground'), '#ff0000');
  assert.equal(faces.get('comment').get('foreground'), '#888');
  assert.equal(faces.get('comment').get('slant').name, 'italic');
});

// --- writeFaceStyleElement --------------------------------------------

test('writeFaceStyleElement creates the style element on first call', () => {
  const doc = makeDoc();
  writeFaceStyleElement(doc, '.tok-keyword { color: red; }');
  const el = doc.getElementById(FACE_STYLE_ELEMENT_ID);
  assert.ok(el);
  assert.equal(el.tagName, 'STYLE');
  assert.equal(el.textContent, '.tok-keyword { color: red; }');
});

test('writeFaceStyleElement reuses the existing element', () => {
  const doc = makeDoc();
  writeFaceStyleElement(doc, '.tok-keyword { color: red; }');
  const first = doc.getElementById(FACE_STYLE_ELEMENT_ID);
  writeFaceStyleElement(doc, '.tok-keyword { color: green; }');
  const second = doc.getElementById(FACE_STYLE_ELEMENT_ID);
  assert.equal(first, second);
  assert.equal(second.textContent, '.tok-keyword { color: green; }');
  assert.equal(doc.head.children.length, 1);
});

// --- applyFaceStyles --------------------------------------------------

test('applyFaceStyles writes generated CSS into the document', () => {
  const doc = makeDoc();
  const alist = [
    cons(sym('keyword'), list(cons(sym('foreground'), '#ff0000'))),
  ];
  applyFaceStyles(doc, alist, listToArray);
  const el = doc.getElementById(FACE_STYLE_ELEMENT_ID);
  assert.match(el.textContent, /\.tok-keyword/);
  assert.match(el.textContent, /color: #ff0000;/);
});

// --- generateModeFaceCss ----------------------------------------------

test('generateModeFaceCss scopes a face rule to a major mode', () => {
  const perMode = new Map([
    ['LaTeX', new Map([['keyword', new Map([['foreground', '#abcdef']])]])],
  ]);
  const css = generateModeFaceCss(perMode);
  assert.match(css, /\[data-major-mode="LaTeX"\] \.tok-keyword/);
  assert.match(css, /color: #abcdef;/);
});

test('generateModeFaceCss emits nothing for an empty map', () => {
  assert.equal(generateModeFaceCss(new Map()), '');
});

test('generateModeFaceCss escapes quotes/backslashes in a mode name', () => {
  const perMode = new Map([
    ['We"ird', new Map([['x', new Map([['foreground', '#000']])]])],
  ]);
  const css = generateModeFaceCss(perMode);
  assert.match(css, /\[data-major-mode="We\\"ird"\]/);
});

// --- modeFacesFromAlist -----------------------------------------------

test('modeFacesFromAlist parses the per-mode styles alist', () => {
  const alist = [
    cons(
      sym('LaTeX'),
      list(cons(sym('keyword'), list(cons(sym('foreground'), '#111'))))
    ),
  ];
  const perMode = modeFacesFromAlist(alist, listToArray);
  assert.deepEqual(
    perMode.get('LaTeX').get('keyword').get('foreground'),
    '#111'
  );
});

test('applyFaceStyles appends mode-scoped rules after the global ones', () => {
  const doc = makeDoc();
  const alist = [
    cons(sym('keyword'), list(cons(sym('foreground'), '#ff0000'))),
  ];
  const modeAlist = [
    cons(
      sym('LaTeX'),
      list(cons(sym('keyword'), list(cons(sym('foreground'), '#00ff00'))))
    ),
  ];
  applyFaceStyles(doc, alist, listToArray, modeAlist);
  const css = doc.getElementById(FACE_STYLE_ELEMENT_ID).textContent;
  const global = css.indexOf('.tok-keyword { color: #ff0000;');
  const scoped = css.indexOf('[data-major-mode="LaTeX"] .tok-keyword');
  assert.ok(global >= 0 && scoped >= 0);
  assert.ok(global < scoped, 'mode rule must come after the global rule');
});
