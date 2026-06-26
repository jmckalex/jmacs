/**
 * @file Server-side incremental search (isearch — C-s / C-r) test.
 *
 * Drives the REAL spine isearch loop: `C-s`/`C-r` resolve through the spine
 * keymap to `isearch-forward`/`isearch-backward`, which start the server-side
 * `-isearch-*` Lisp state machine. The loop owns the keyboard via
 * `read-next-key` (so subsequent keystrokes route to the search dispatcher,
 * not self-insert): a printable extends the query, `C-s`/`C-r` repeat
 * forward/backward (wrapping), `backspace` shrinks, `C-g` aborts (restoring
 * the origin point), `enter`/`escape` exit at the current match. No Electron,
 * no DOM — point moves + the echo-area prompt is surfaced. See spine.js
 * "incremental search (isearch, C-s / C-r)" and PRIMITIVE-SPLIT.md "Search".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';

/** A spine with recording effects (mirrors regex-search.test.js). */
function makeSpine(initialText = '', name = 'scratch.txt') {
  const log = { status: [] };
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: (s) => log.status.push(s),
      onMinibufferOpen: () => {},
      onMinibufferClose: () => {},
      onScroll: () => {},
      onPicker: () => {},
    }
  );
  return { spine, log };
}

test('isearch-forward: typing a query moves point to the match end + prompts', () => {
  const { spine, log } = makeSpine('the cat sat');
  spine.buffer.moveTo(0);
  spine.handleKey('C-s'); // isearch-forward — arms the loop
  for (const ch of 'cat') spine.handleKey(ch); // extend query → "cat"
  // "the cat sat": 'cat' starts at 4, so point lands at its END = 7.
  assert.equal(spine.buffer.point, 7);
  assert.ok(
    log.status.some((s) => /I-search: cat/.test(s)),
    'the echo area shows the I-search prompt with the query'
  );
});

test('isearch-forward: C-s advances to the next match, wrapping', () => {
  const { spine } = makeSpine('cat dog cat'); // 'cat' at 0 and 8
  spine.buffer.moveTo(0);
  spine.handleKey('C-s');
  for (const ch of 'cat') spine.handleKey(ch); // first match at 0 → point 3
  assert.equal(spine.buffer.point, 3);
  spine.handleKey('C-s'); // repeat → next match at 8 → point 11
  assert.equal(spine.buffer.point, 11);
  spine.handleKey('C-s'); // repeat past the last → wraps to match at 0 → point 3
  assert.equal(spine.buffer.point, 3);
});

test('isearch-backward: C-r searches backward, point at the match start', () => {
  const { spine } = makeSpine('cat dog cat'); // 'cat' at 0 and 8
  spine.buffer.moveTo(11); // start at end
  spine.handleKey('C-r'); // isearch-backward
  for (const ch of 'cat') spine.handleKey(ch); // nearest at-or-before 11 = match 8 → point 8 (start)
  assert.equal(spine.buffer.point, 8);
  spine.handleKey('C-r'); // repeat backward → match 0 → point 0
  assert.equal(spine.buffer.point, 0);
});

test('isearch-forward: C-g aborts and restores the origin point', () => {
  const { spine } = makeSpine('cat dog cat');
  spine.buffer.moveTo(5); // origin inside "dog"
  spine.handleKey('C-s');
  for (const ch of 'cat') spine.handleKey(ch); // first at-or-after 5 = match 8 → point 11
  assert.equal(spine.buffer.point, 11);
  spine.handleKey('C-g'); // abort → back to origin 5
  assert.equal(spine.buffer.point, 5);
});

test('isearch-forward: enter exits at the match and releases the keyboard', () => {
  const { spine } = makeSpine('cat dog cat');
  spine.buffer.moveTo(0);
  spine.handleKey('C-s');
  for (const ch of 'cat') spine.handleKey(ch); // point 3
  spine.handleKey('enter'); // exit at the current match (point stays)
  assert.equal(spine.buffer.point, 3);
  // The loop has released read-next-key, so a printable self-inserts again.
  spine.handleKey('X');
  assert.equal(spine.buffer.text, 'catX dog cat');
});

test('isearch-forward: backspace shrinks the query', () => {
  const { spine } = makeSpine('cat cart'); // 'cat' at 0; 'car' at 4
  spine.buffer.moveTo(0);
  spine.handleKey('C-s');
  for (const ch of 'cart') spine.handleKey(ch); // 'cart' matches at 4 → point 8
  assert.equal(spine.buffer.point, 8);
  spine.handleKey('backspace'); // query → 'car' (matches 'car' at 4) → point 7
  assert.equal(spine.buffer.point, 7);
});

test('isearch-forward: highlights every match; the current one with the isearch face', () => {
  const { spine } = makeSpine('cat dog cat'); // 'cat' at 0 and 8
  spine.buffer.moveTo(0);
  spine.handleKey('C-s');
  for (const ch of 'cat') spine.handleKey(ch); // current match at 0 (point 3)
  const ov = spine.overlaySnapshot().filter((o) => o.kind === 'isearch');
  assert.equal(ov.length, 2, 'both matches are highlighted');
  const current = ov.find((o) => o.face === 'isearch');
  const lazy = ov.find((o) => o.face === 'search-match');
  assert.ok(current && current.start === 0 && current.end === 3,
    'the current match (0..3) wears the bright isearch face');
  assert.ok(lazy && lazy.start === 8 && lazy.end === 11,
    'the other match wears the light search-match face');
  // The current-match overlay tracks C-s: repeating moves `isearch` to match 8.
  spine.handleKey('C-s');
  const after = spine.overlaySnapshot().filter((o) => o.face === 'isearch');
  assert.ok(after.length === 1 && after[0].start === 8, 'isearch face follows the current match');
  // Exit clears the whole set.
  spine.handleKey('enter');
  assert.equal(spine.overlaySnapshot().filter((o) => o.kind === 'isearch').length, 0,
    'exiting clears the match overlays');
});

test('isearch-forward: C-g clears the match overlays', () => {
  const { spine } = makeSpine('cat dog cat');
  spine.buffer.moveTo(0);
  spine.handleKey('C-s');
  for (const ch of 'cat') spine.handleKey(ch);
  assert.ok(spine.overlaySnapshot().some((o) => o.kind === 'isearch'), 'highlighted while searching');
  spine.handleKey('C-g');
  assert.equal(spine.overlaySnapshot().filter((o) => o.kind === 'isearch').length, 0,
    'abort clears the match overlays');
});
