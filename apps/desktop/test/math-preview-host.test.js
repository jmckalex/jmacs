import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMathPreviewActive,
  isLatexMathPreviewActive,
  bufferMajorModeName,
} from '../src/math-preview-host.js';

/** The Lisp nil value's shape only matters in that it is *not* a cons
 *  pair; any sentinel that lacks head/tail works as the list terminator. */
const NIL = { nil: true };

/** A cons pair the same shape `@editor/lisp` produces: the walker reads
 *  only `.head` and `.tail`. */
const cons = (head, tail) => ({ head, tail });

/** Build a Lisp-shaped proper list from an array, terminated by NIL. */
const list = (items) => items.reduceRight((tail, head) => cons(head, tail), NIL);

// Distinct mode-map stand-ins; identity is what membership compares.
const mathMode = { name: 'MathPreview' };
const otherMode = { name: 'Other' };

test('returns true when the mode is the only member', () => {
  const buffer = { minorModes: list([mathMode]) };
  assert.equal(isMathPreviewActive(buffer, mathMode), true);
});

test('returns true when the mode is among several members', () => {
  const buffer = { minorModes: list([otherMode, mathMode]) };
  assert.equal(isMathPreviewActive(buffer, mathMode), true);
});

test('returns false when the mode is absent from a non-empty list', () => {
  const buffer = { minorModes: list([otherMode]) };
  assert.equal(isMathPreviewActive(buffer, mathMode), false);
});

test('returns false for an empty (nil) minor-mode list', () => {
  const buffer = { minorModes: NIL };
  assert.equal(isMathPreviewActive(buffer, mathMode), false);
});

test('returns false when minorModes was never set (null)', () => {
  const buffer = { minorModes: null };
  assert.equal(isMathPreviewActive(buffer, mathMode), false);
});

test('membership is by identity, not by shape', () => {
  const lookAlike = { name: 'MathPreview' }; // equal shape, different object
  const buffer = { minorModes: list([lookAlike]) };
  assert.equal(isMathPreviewActive(buffer, mathMode), false);
});

test('tolerates a missing buffer', () => {
  assert.equal(isMathPreviewActive(null, mathMode), false);
  assert.equal(isMathPreviewActive(undefined, mathMode), false);
});

test('tolerates an unresolved (null/undefined) mode reference', () => {
  const buffer = { minorModes: list([mathMode]) };
  assert.equal(isMathPreviewActive(buffer, null), false);
  assert.equal(isMathPreviewActive(buffer, undefined), false);
});

test('isLatexMathPreviewActive is a back-compat alias', () => {
  assert.equal(isLatexMathPreviewActive, isMathPreviewActive);
});

// --- bufferMajorModeName -----------------------------------------------
// A major mode is a Lisp map (a JS Map keyed by interned keywords). The
// host reads its `:name` through an injected keyword constructor. Stub
// the constructor with interning so `keyword('name')` is a stable key.

/** An interning keyword stub matching `@editor/lisp`'s contract. */
function makeKeyword() {
  const table = new Map();
  return (name) => {
    if (!table.has(name)) table.set(name, { keyword: name });
    return table.get(name);
  };
}

test('bufferMajorModeName reads the major mode :name', () => {
  const keyword = makeKeyword();
  const major = new Map([[keyword('name'), 'LaTeX']]);
  const buffer = { majorMode: major };
  assert.equal(bufferMajorModeName(buffer, keyword), 'LaTeX');
});

test('bufferMajorModeName returns null when there is no major mode', () => {
  const keyword = makeKeyword();
  assert.equal(bufferMajorModeName({ majorMode: null }, keyword), null);
  assert.equal(bufferMajorModeName(null, keyword), null);
});

test('bufferMajorModeName returns null when :name is absent / non-string', () => {
  const keyword = makeKeyword();
  // A map with no :name entry.
  assert.equal(bufferMajorModeName({ majorMode: new Map() }, keyword), null);
  // A non-string :name (defensive).
  const major = new Map([[keyword('name'), 42]]);
  assert.equal(bufferMajorModeName({ majorMode: major }, keyword), null);
});

test('bufferMajorModeName tolerates a missing keyword constructor', () => {
  const major = new Map();
  assert.equal(bufferMajorModeName({ majorMode: major }, null), null);
});
