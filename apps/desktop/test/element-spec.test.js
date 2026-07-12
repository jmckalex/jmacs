import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveElementModuleUrl,
  normalizeFit,
  elementViewKinds,
  elementViewSpec,
  elementViewOpenPayload,
} from '../src/element-spec.js';

test('a repo-relative path is served from the app://editor origin', () => {
  assert.equal(
    resolveElementModuleUrl('apps/desktop/vendor/stella/stella-element.js'),
    'app://editor/apps/desktop/vendor/stella/stella-element.js'
  );
});

test('a leading slash is trimmed (./x and /x resolve the same)', () => {
  assert.equal(
    resolveElementModuleUrl('/vendor/x.js'),
    'app://editor/vendor/x.js'
  );
});

test('an absolute app:// URL passes through unchanged', () => {
  const url = 'app://editor/__host__/Users/me/bundle/x.js';
  assert.equal(resolveElementModuleUrl(url), url);
});

test('an http(s) / media URL passes through unchanged', () => {
  assert.equal(resolveElementModuleUrl('https://cdn.example/x.js'),
    'https://cdn.example/x.js');
  assert.equal(resolveElementModuleUrl('media://thing/x.js'),
    'media://thing/x.js');
});

test('empty / non-string yields the empty string (no module to load)', () => {
  assert.equal(resolveElementModuleUrl(''), '');
  assert.equal(resolveElementModuleUrl(null), '');
  assert.equal(resolveElementModuleUrl(undefined), '');
});

test('normalizeFit passes known modes through', () => {
  assert.equal(normalizeFit('center'), 'center');
  assert.equal(normalizeFit('fill'), 'fill');
  assert.equal(normalizeFit('top'), 'top');
});

test('normalizeFit defaults unknown / empty to center', () => {
  assert.equal(normalizeFit(''), 'center');
  assert.equal(normalizeFit('sideways'), 'center');
  assert.equal(normalizeFit(undefined), 'center');
});

// --- L4: the plain-JS element-view registry (replaces the Lisp registry) ----

test('elementViewKinds is the four built-ins', () => {
  assert.deepEqual(elementViewKinds().sort(),
    ['atari', 'bib-search', 'notebook-cells', 'svg-edit']);
});

test('svg-edit: empty module (bundled tag), fill, shared keyboard', () => {
  const p = elementViewOpenPayload('svg-edit');
  assert.equal(p.moduleUrl, '');
  assert.equal(p.tag, 'svg-editor-view');
  assert.equal(p.keyboard, 'share');
  assert.equal(p.fit, 'fill');
  assert.equal(p.noFocus, false);
});

test('elementViewSpec returns the spec, or null for an unknown kind', () => {
  assert.equal(elementViewSpec('atari').tag, 'stella-emulator');
  assert.equal(elementViewSpec('nope'), null);
  // No prototype pollution: a key like "toString" is not a registered kind.
  assert.equal(elementViewSpec('toString'), null);
});

test('open payload for atari mirrors what open-element-view! built', () => {
  const p = elementViewOpenPayload('atari');
  assert.deepEqual(p, {
    name: 'Atari 2600',
    tag: 'stella-emulator',
    moduleUrl: 'app://editor/apps/desktop/vendor/stella/stella-element.js',
    attrs: [['controls', true],
      ['src', 'app://editor/apps/desktop/vendor/stella/oystron.bin']],
    fit: 'center',
    keyboard: 'grab',
    noFocus: false,
  });
});

test('notebook-cells: empty module → empty moduleUrl, keyboard off', () => {
  const p = elementViewOpenPayload('notebook-cells');
  assert.equal(p.moduleUrl, '');
  assert.equal(p.tag, 'notebook-cells-view');
  assert.equal(p.keyboard, 'off');
  assert.equal(p.fit, 'fill');
});

test('bib-search with no bibPath uses the bundled sample', () => {
  const p = elementViewOpenPayload('bib-search');
  assert.deepEqual(p.attrs,
    [['src', 'app://editor/apps/desktop/vendor/bib-search/sample.bib']]);
  assert.equal(p.noFocus, true);
});

test('bib-search with an absolute bibPath → host-file-url src + bib-path attr', () => {
  const hostFileUrl = (p) => `app://editor/__host__${p}`;
  const p = elementViewOpenPayload('bib-search', {
    bibPath: '/Users/me/refs.bib', hostFileUrl,
  });
  assert.deepEqual(p.attrs, [
    ['src', 'app://editor/__host__/Users/me/refs.bib'],
    ['bib-path', '/Users/me/refs.bib'],
  ]);
});

test('bib-search ignores a non-absolute / empty bibPath (falls back to sample)', () => {
  const hostFileUrl = (p) => `app://editor/__host__${p}`;
  for (const bibPath of ['', null, 'relative/refs.bib']) {
    const p = elementViewOpenPayload('bib-search', { bibPath, hostFileUrl });
    assert.deepEqual(p.attrs,
      [['src', 'app://editor/apps/desktop/vendor/bib-search/sample.bib']]);
  }
});

test('elementViewOpenPayload returns null for an unknown kind', () => {
  assert.equal(elementViewOpenPayload('nope'), null);
});
