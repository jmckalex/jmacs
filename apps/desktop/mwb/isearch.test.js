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

test('isearch-forward: lights the current match IMMEDIATELY with the isearch face', () => {
  const { spine } = makeSpine('cat dog cat'); // 'cat' at 0 and 8
  spine.buffer.moveTo(0);
  spine.handleKey('C-s');
  for (const ch of 'cat') spine.handleKey(ch); // current match at 0 (point 3)
  const cur = spine.overlaySnapshot().filter((o) => o.kind === 'isearch-current');
  assert.equal(cur.length, 1, 'exactly one current-match overlay (immediate, no debounce)');
  assert.ok(cur[0].start === 0 && cur[0].end === 3 && cur[0].face === 'isearch',
    'the current match (0..3) wears the bright isearch face');
  // C-s moves the current overlay WITHOUT rebuilding the whole set (no flicker).
  spine.handleKey('C-s');
  const after = spine.overlaySnapshot().filter((o) => o.kind === 'isearch-current');
  assert.ok(after.length === 1 && after[0].start === 8, 'the current overlay follows C-s');
  // Exit clears it.
  spine.handleKey('enter');
  assert.equal(spine.overlaySnapshot().filter((o) => o.kind === 'isearch-current').length, 0,
    'exit clears the current overlay');
});

test('isearch-forward: the lazy highlight is DEBOUNCED + windowed (the other matches)', async () => {
  const { spine } = makeSpine('cat dog cat'); // 'cat' at 0 and 8
  spine.buffer.moveTo(0);
  spine.handleKey('C-s');
  for (const ch of 'cat') spine.handleKey(ch); // current at 0
  // Not built per-keystroke — that was the bog-down. Nothing lazy yet.
  assert.equal(spine.overlaySnapshot().filter((o) => o.kind === 'isearch-lazy').length, 0,
    'lazy overlays are not constructed synchronously');
  await new Promise((resolve) => setTimeout(resolve, 400)); // let the debounce fire
  const lazy = spine.overlaySnapshot().filter((o) => o.kind === 'isearch-lazy');
  assert.equal(lazy.length, 1, 'the OTHER match is lazily highlighted (current excluded)');
  assert.ok(lazy[0].start === 8 && lazy[0].face === 'search-match',
    'the non-current match (8) wears the light search-match face');
});

test('isearch-forward: C-g clears the overlays + cancels the pending lazy build', async () => {
  const { spine } = makeSpine('cat dog cat');
  spine.buffer.moveTo(0);
  spine.handleKey('C-s');
  for (const ch of 'cat') spine.handleKey(ch);
  spine.handleKey('C-g'); // abort: clears current + cancels the debounce timer
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(spine.overlaySnapshot().length, 0,
    'no isearch overlays survive the abort (the lazy timer was cancelled)');
});
