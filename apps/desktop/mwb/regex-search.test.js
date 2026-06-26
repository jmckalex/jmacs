/**
 * @file Server-side port test for regex-search.lisp (G3).
 *
 * Drives the regexp / query-replace commands through the REAL spine: the
 * real regex-search.lisp source, the real run-command / interactive
 * gatherer, the real read-next-key reader, and the spine's model-side
 * regexp + string search/replace primitives (find-regexp-forward,
 * find-string-forward, replace-regexp-all!, replace-range!). No Electron,
 * no DOM — the commands run server-side and the buffer text changes.
 *
 * The two `isearch-regexp-*` starters are render-side (the incremental
 * loop) and STUBBED; only `replace-regexp` and `query-replace` — fully
 * model-side — are exercised here. See PRIMITIVE-SPLIT.md "Search / regex".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';

/** A spine with recording effects (mirrors spine.test.js's makeSpine). */
function makeSpine(initialText = '', name = 'scratch.txt') {
  const log = { status: [], minibufferOpens: [], minibufferCloses: 0 };
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: (s) => log.status.push(s),
      onMinibufferOpen: (p) => log.minibufferOpens.push(p),
      onMinibufferClose: () => { log.minibufferCloses += 1; },
      onScroll: () => {},
      onPicker: () => {},
    }
  );
  return { spine, log };
}

test('replace-regexp: a two-prompt command rewrites every match (with $1)', () => {
  const { spine, log } = makeSpine('foo=1 bar=2 baz=3');
  spine.runCommand('replace-regexp');
  assert.deepEqual(log.minibufferOpens, ['Regexp: ']);
  spine.deliverMinibuffer('(\\w+)=(\\d+)'); // PATTERN
  assert.deepEqual(log.minibufferOpens, ['Regexp: ', 'Replace with: ']);
  spine.deliverMinibuffer('$2:$1'); // REPLACEMENT — JS back-references
  assert.equal(spine.buffer.text, '1:foo 2:bar 3:baz');
});

test('replace-regexp: $& (whole match) and a no-match status', () => {
  const { spine, log } = makeSpine('cat dog');
  spine.runCommand('replace-regexp');
  spine.deliverMinibuffer('\\w+');
  spine.deliverMinibuffer('[$&]');
  assert.equal(spine.buffer.text, '[cat] [dog]');

  // A pattern that does not match leaves the text alone + surfaces a miss.
  const before = spine.buffer.text;
  spine.runCommand('replace-regexp');
  spine.deliverMinibuffer('zzz+');
  spine.deliverMinibuffer('X');
  assert.equal(spine.buffer.text, before);
  assert.ok(log.status.some((s) => /no match/.test(s)), 'a miss is surfaced');
});

test('query-replace: y replaces, n skips, walking forward through matches', () => {
  // Start: "a cat sat on a cat" → replace 'cat'→'dog', accept first, skip 2nd.
  const { spine } = makeSpine('a cat sat on a cat');
  spine.runCommand('query-replace');
  spine.deliverMinibuffer('cat'); // FROM
  spine.deliverMinibuffer('dog'); // TO → first match highlighted, awaiting a key
  // The first match is selected; 'y' replaces it and advances to the 2nd.
  spine.handleKey('y');
  // The 2nd match is now selected; 'n' skips it (leaves it as 'cat').
  spine.handleKey('n');
  assert.equal(spine.buffer.text, 'a dog sat on a cat');
});

test('query-replace: ! replaces this and every remaining match, then finishes', () => {
  const { spine } = makeSpine('x x x x');
  spine.runCommand('query-replace');
  spine.deliverMinibuffer('x');
  spine.deliverMinibuffer('y'); // first match highlighted
  spine.handleKey('!'); // replace this + the rest
  assert.equal(spine.buffer.text, 'y y y y');
});

test('query-replace: q quits, leaving the remaining matches alone', () => {
  const { spine } = makeSpine('a a a');
  spine.runCommand('query-replace');
  spine.deliverMinibuffer('a');
  spine.deliverMinibuffer('b');
  spine.handleKey('y'); // replace the first
  spine.handleKey('q'); // quit at the second
  assert.equal(spine.buffer.text, 'b a a');
});

test('the regexp isearch starters resolve (stubbed) without throwing', () => {
  const { spine, log } = makeSpine('hello');
  spine.runCommand('isearch-regexp-forward');
  spine.runCommand('isearch-regexp-backward');
  assert.ok(log.status.some((s) => /I-search regexp/.test(s)),
    'the stub surfaces a status so the gap is visible');
  assert.equal(spine.buffer.text, 'hello', 'no buffer change from the stub');
});
