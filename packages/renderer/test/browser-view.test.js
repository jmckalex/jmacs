/**
 * @file Unit tests for `normaliseUrl`, the pure URL helper of the
 * `<browser-view>` element (`packages/renderer/src/browser-view.js`).
 * Importing the module is safe under Node — its `defineViewElement`
 * registration no-ops without `customElements`. The element's DOM
 * behaviour (the toolbar, the webview navigation, _paint applying this
 * helper) is covered by the live hand-off, not here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseUrl } from '../src/browser-view.js';

test('normaliseUrl prepends https:// to a schemeless address', () => {
  // The bug fix: typing `google.com` at the M-x browser-view prompt (or in
  // the URL bar) must navigate to https://google.com, not fail to load.
  assert.equal(normaliseUrl('google.com'), 'https://google.com');
  assert.equal(normaliseUrl('www.example.org'), 'https://www.example.org');
  assert.equal(normaliseUrl('example.com/path?q=1'), 'https://example.com/path?q=1');
});

test('normaliseUrl leaves an explicit scheme untouched', () => {
  assert.equal(normaliseUrl('https://x.com'), 'https://x.com');
  assert.equal(normaliseUrl('http://x.com'), 'http://x.com');
  assert.equal(normaliseUrl('about:blank'), 'about:blank');
  assert.equal(normaliseUrl('file:///tmp/page.html'), 'file:///tmp/page.html');
  assert.equal(normaliseUrl('view-source:https://x.com'), 'view-source:https://x.com');
});

test('normaliseUrl trims surrounding whitespace before deciding', () => {
  assert.equal(normaliseUrl('  google.com  '), 'https://google.com');
  assert.equal(normaliseUrl('\thttps://x.com\n'), 'https://x.com');
});

test('normaliseUrl maps empty / nullish input to the blank page', () => {
  assert.equal(normaliseUrl(''), 'about:blank');
  assert.equal(normaliseUrl('   '), 'about:blank');
  assert.equal(normaliseUrl(null), 'about:blank');
  assert.equal(normaliseUrl(undefined), 'about:blank');
});
