import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findColourLiterals, normaliseToHex } from '../src/colour-literals.js';

// --- findColourLiterals -------------------------------------------------

test('finds a #rrggbb literal with its exact span', () => {
  const result = findColourLiterals('color: #ff8800;');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    start: 7,
    end: 14,
    text: '#ff8800',
    css: '#ff8800',
  });
});

test('finds the three-, six- and eight-digit hash forms', () => {
  assert.deepEqual(
    findColourLiterals('#abc').map((l) => l.text),
    ['#abc']
  );
  assert.deepEqual(
    findColourLiterals('#aabbcc').map((l) => l.text),
    ['#aabbcc']
  );
  assert.deepEqual(
    findColourLiterals('#aabbccdd').map((l) => l.text),
    ['#aabbccdd']
  );
});

test('finds the four-digit #rgba form', () => {
  assert.deepEqual(
    findColourLiterals('#abcd').map((l) => l.text),
    ['#abcd']
  );
});

test('rejects hash literals of an invalid digit count', () => {
  // 1, 2, 5 and 7 hex digits are not colours.
  assert.deepEqual(findColourLiterals('#a'), []);
  assert.deepEqual(findColourLiterals('#ab'), []);
  assert.deepEqual(findColourLiterals('#abcde'), []);
  assert.deepEqual(findColourLiterals('#abcdefa'), []);
});

test('rejects a hash followed by a non-hex character', () => {
  // `#xyz` has no hex digits at all.
  assert.deepEqual(findColourLiterals('#xyz'), []);
  // `#ggg` — g is not a hex digit.
  assert.deepEqual(findColourLiterals('#ggg'), []);
});

test('finds rgb() and rgba() functional literals', () => {
  const rgb = findColourLiterals('background: rgb(255, 0, 0);');
  assert.equal(rgb.length, 1);
  assert.equal(rgb[0].text, 'rgb(255, 0, 0)');

  const rgba = findColourLiterals('background: rgba(0, 0, 0, 0.5);');
  assert.equal(rgba.length, 1);
  assert.equal(rgba[0].text, 'rgba(0, 0, 0, 0.5)');
});

test('finds modern slash/percentage rgb syntax', () => {
  const result = findColourLiterals('rgb(1 2 3 / 50%)');
  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'rgb(1 2 3 / 50%)');
});

test('rejects rgb() with a non-numeric body', () => {
  assert.deepEqual(findColourLiterals('rgb(foo)'), []);
  assert.deepEqual(findColourLiterals('rgb()'), []);
});

test('does not match rgb inside a longer identifier', () => {
  // `\b` guards the function name — `myrgb(1,2,3)` is not a colour.
  assert.deepEqual(findColourLiterals('myrgb(1,2,3)'), []);
});

test('finds several literals in one line, ordered by position', () => {
  const result = findColourLiterals('a #fff b rgb(0,0,0) c #112233');
  assert.deepEqual(
    result.map((l) => l.text),
    ['#fff', 'rgb(0,0,0)', '#112233']
  );
  // Spans are in increasing order and non-overlapping.
  for (let i = 1; i < result.length; i += 1) {
    assert.ok(result[i].start >= result[i - 1].end);
  }
  // Each span slices back to the literal text.
  for (const lit of result) {
    assert.equal(
      'a #fff b rgb(0,0,0) c #112233'.slice(lit.start, lit.end),
      lit.text
    );
  }
});

test('returns an empty array for text with no literals', () => {
  assert.deepEqual(findColourLiterals('const x = 42;'), []);
});

test('is pure — non-string and empty input yield an empty array', () => {
  assert.deepEqual(findColourLiterals(''), []);
  assert.deepEqual(findColourLiterals(null), []);
  assert.deepEqual(findColourLiterals(undefined), []);
  assert.deepEqual(findColourLiterals(123), []);
});

test('detection is stateless across repeated calls', () => {
  // A regression guard for the module-level regex `lastIndex`: a stale
  // lastIndex would make a second call miss a leading match.
  const first = findColourLiterals('#abc');
  const second = findColourLiterals('#abc');
  assert.deepEqual(first, second);
  assert.equal(second.length, 1);
});

// --- normaliseToHex -----------------------------------------------------

test('normalises a three-digit hash to six digits', () => {
  assert.equal(normaliseToHex('#abc'), '#aabbcc');
  assert.equal(normaliseToHex('#F00'), '#ff0000');
});

test('normalises a four-digit hash to eight digits', () => {
  assert.equal(normaliseToHex('#abcd'), '#aabbccdd');
});

test('lower-cases and passes through six- and eight-digit hashes', () => {
  assert.equal(normaliseToHex('#AABBCC'), '#aabbcc');
  assert.equal(normaliseToHex('#AABBCCDD'), '#aabbccdd');
});

test('normalises integer rgb() to a hex string', () => {
  assert.equal(normaliseToHex('rgb(255, 0, 0)'), '#ff0000');
  assert.equal(normaliseToHex('rgb(16 32 48)'), '#102030');
});

test('normalises rgba() with a fractional alpha', () => {
  assert.equal(normaliseToHex('rgba(0, 0, 0, 0.5)'), '#00000080');
  assert.equal(normaliseToHex('rgba(255,255,255,1)'), '#ffffffff');
});

test('returns null for channels out of the 0–255 range', () => {
  assert.equal(normaliseToHex('rgb(300, 0, 0)'), null);
});

test('returns null for percentage rgb() it cannot resolve', () => {
  assert.equal(normaliseToHex('rgb(1 2 3 / 50%)'), null);
});

test('returns null for unparseable input', () => {
  assert.equal(normaliseToHex('not a colour'), null);
  assert.equal(normaliseToHex('#a'), null);
  assert.equal(normaliseToHex(null), null);
});
