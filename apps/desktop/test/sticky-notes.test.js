import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adjustAnchor,
  parseIconSize,
  parseIconClasses,
  parseNoteSource,
  DEFAULT_ICON_CLASSES,
} from '../src/sticky-notes.js';

/** A BufferChange — `removed`/`inserted` are strings. */
const change = (start, removed, inserted) => ({ start, removed, inserted });

test('an anchor before the edit is unchanged', () => {
  assert.equal(adjustAnchor(5, change(10, '', 'abc')), 5);
});

test('an anchor exactly at the edit start stays (insertion gravity)', () => {
  assert.equal(adjustAnchor(10, change(10, '', 'abc')), 10);
});

test('an anchor after an insertion shifts right by the inserted length', () => {
  assert.equal(adjustAnchor(20, change(10, '', 'abc')), 23);
});

test('an anchor after a deletion shifts left by the removed length', () => {
  assert.equal(adjustAnchor(20, change(10, 'abcde', '')), 15);
});

test('an anchor inside the removed span collapses to the edit start', () => {
  assert.equal(adjustAnchor(12, change(10, 'abcde', '')), 10);
});

test('an anchor after a replacement shifts by the net length change', () => {
  assert.equal(adjustAnchor(20, change(10, 'ab', 'wxyz')), 22);
});

test('a whole-buffer setText collapses an interior anchor to the start', () => {
  // setText reports one change spanning the whole document.
  const old = 'x'.repeat(100);
  assert.equal(adjustAnchor(50, change(0, old, 'y'.repeat(40))), 0);
});

test('parseNoteSource returns the whole source as body when there is no header', () => {
  const { meta, body } = parseNoteSource('# just markdown\n\ntext');
  assert.deepEqual(meta, {});
  assert.equal(body, '# just markdown\n\ntext');
});

test('parseNoteSource reads a metadata header and strips it from the body', () => {
  const { meta, body } = parseNoteSource(
    '---\ncolor: yellow\n---\n# Title\nbody'
  );
  assert.equal(meta.color, 'yellow');
  assert.equal(body, '# Title\nbody');
});

test('parseNoteSource keeps an rgba() colour value intact', () => {
  const { meta } = parseNoteSource('---\ncolor: rgba(255, 0, 0, 0.4)\n---\nx');
  assert.equal(meta.color, 'rgba(255, 0, 0, 0.4)');
});

test('parseNoteSource handles a header with no body', () => {
  const { meta, body } = parseNoteSource('---\ncolor: #ffcc00\n---');
  assert.equal(meta.color, '#ffcc00');
  assert.equal(body, '');
});

test('parseNoteSource reads the icon-size key', () => {
  const { meta } = parseNoteSource('---\nicon-size: 60\n---\nx');
  assert.equal(meta['icon-size'], '60');
});

test('parseIconSize accepts a bare number, a px suffix, and surrounding space', () => {
  assert.equal(parseIconSize('60'), 60);
  assert.equal(parseIconSize('60px'), 60);
  assert.equal(parseIconSize('  50  '), 50);
  assert.equal(parseIconSize('48PX'), 48);
});

test('parseIconSize rejects values outside the sane 12–256 range', () => {
  // Under the lower bound: the Font Awesome glyph stops rendering well.
  assert.equal(parseIconSize('11'), null);
  // Over the upper bound: the note would dwarf the editor.
  assert.equal(parseIconSize('257'), null);
  assert.equal(parseIconSize('9999'), null);
});

test('parseIconSize rejects malformed input', () => {
  assert.equal(parseIconSize(''), null);
  assert.equal(parseIconSize('abc'), null);
  assert.equal(parseIconSize('-30'), null);
  assert.equal(parseIconSize(undefined), null);
  assert.equal(parseIconSize(null), null);
  assert.equal(parseIconSize(60), null);
});

test('parseNoteSource reads the icon key', () => {
  const { meta } = parseNoteSource('---\nicon: fa-star\n---\nx');
  assert.equal(meta.icon, 'fa-star');
});

test('parseIconClasses accepts a bare name, defaulting to the solid face', () => {
  assert.equal(parseIconClasses('star'), 'fa-solid fa-star');
  assert.equal(parseIconClasses('note-sticky'), 'fa-solid fa-note-sticky');
});

test('parseIconClasses accepts an fa-prefixed name', () => {
  assert.equal(parseIconClasses('fa-star'), 'fa-solid fa-star');
});

test('parseIconClasses honours an explicit style word, prefixed or not', () => {
  assert.equal(parseIconClasses('regular star'), 'fa-regular fa-star');
  assert.equal(parseIconClasses('fa-regular fa-star'), 'fa-regular fa-star');
  assert.equal(parseIconClasses('brands github'), 'fa-brands fa-github');
});

test('parseIconClasses keeps trailing FA utility classes (e.g. fa-spin)', () => {
  assert.equal(parseIconClasses('star fa-spin'), 'fa-solid fa-star fa-spin');
});

test('parseIconClasses sanitises tokens to a safe class list', () => {
  // A would-be class-attribute break-out is stripped to bare class chars.
  assert.equal(parseIconClasses('star"><script>'), 'fa-solid fa-starscript');
});

test('parseIconClasses returns null when no icon is named', () => {
  // Only a style word, empty, whitespace, or a non-string → fall back.
  assert.equal(parseIconClasses('regular'), null);
  assert.equal(parseIconClasses(''), null);
  assert.equal(parseIconClasses('   '), null);
  assert.equal(parseIconClasses(undefined), null);
  assert.equal(parseIconClasses(null), null);
});

test('DEFAULT_ICON_CLASSES is the sticky-note glyph', () => {
  assert.equal(DEFAULT_ICON_CLASSES, 'fa-solid fa-note-sticky');
});
