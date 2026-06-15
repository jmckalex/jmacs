import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveElementModuleUrl, normalizeFit } from '../src/element-spec.js';

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
