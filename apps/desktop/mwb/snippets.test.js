/**
 * @file Server-side port test for snippets.lisp (G3) — the snippet engine.
 *
 * The ENGINE (expansion, field navigation, mirrors-as-multicursors) is
 * fully model-side: it runs over insert!/goto!/set-mark!/add-selection!/
 * collapse-to-primary!, all provided by the spine. The built-in starter
 * set (*snippet-builtins*, defined in Lisp) loads without any directory
 * I/O, so snippet-insert / snippet-expand work server-side out of the box.
 * The directory-store file reads are stubbed to safe empties; the
 * defface/face shim lets the file load. See PRIMITIVE-SPLIT.md "Snippets".
 *
 * These drive the engine through the spine's interpreter + commands; the
 * effect is visible in the real L2 buffer text + cursor set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';

function makeSpine(initialText = '', name = 'scratch.txt') {
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: () => {}, onMinibufferOpen: () => {}, onMinibufferClose: () => {},
      onScroll: () => {}, onPicker: () => {},
    }
  );
  return { spine };
}

test('snippet-insert expands a built-in template with fields, server-side', () => {
  const { spine } = makeSpine('');
  // `todo` is a fundamental-mode builtin: "TODO(${1:author}): ${2:describe…}$0"
  const ok = spine.interpreter.evaluate('(snippet-insert-by-key "todo")');
  assert.equal(ok, true, 'a known key expands');
  assert.match(spine.buffer.text, /^TODO\(author\): describe the task$/);
  // The snippet is active and parked on the first field.
  assert.equal(spine.interpreter.evaluate('(snippet-active?)'), true);
  assert.equal(spine.interpreter.evaluate('(snippet-modeline-indicator)'), '[snippet: 1/2]');
  // The first field ("author") is selected so typing replaces it.
  const v = spine.view;
  assert.equal(spine.buffer.text.slice(Math.min(v.point, v.mark), Math.max(v.point, v.mark)), 'author');
});

test('snippet-next-field advances and commits at the last field', () => {
  const { spine } = makeSpine('');
  spine.interpreter.evaluate('(snippet-insert-by-key "todo")'); // field 1/2
  spine.interpreter.evaluate('(snippet-next-field)'); // → field 2/2
  assert.equal(spine.interpreter.evaluate('(snippet-modeline-indicator)'), '[snippet: 2/2]');
  spine.interpreter.evaluate('(snippet-next-field)'); // past the last → commit
  assert.equal(spine.interpreter.evaluate('(snippet-active?)'), false,
    'advancing past the last field commits the snippet');
  // The inserted text stays after commit.
  assert.match(spine.buffer.text, /^TODO\(author\): describe the task$/);
});

test('a static (field-less) snippet expands and commits immediately', () => {
  const { spine } = makeSpine('');
  // `date` is "`date`" — backtick embedded code → a date string, no fields.
  const ok = spine.interpreter.evaluate('(snippet-insert-by-key "date")');
  assert.equal(ok, true);
  // The spine's snippet-date-string formats YYYY-MM-DD; assert the shape.
  assert.match(spine.buffer.text, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(spine.interpreter.evaluate('(snippet-active?)'), false,
    'a field-less snippet commits at once');
});

test('snippet-expand fires on the word before point (the TAB-trigger path)', () => {
  const { spine } = makeSpine('');
  for (const ch of 'sig') spine.handleKey(ch); // type the trigger word
  const expanded = spine.interpreter.evaluate('(snippet-expand)');
  assert.equal(expanded, true, 'a known trigger word expands');
  // `sig` is "-- ${1:Your Name}\n${2:you@example.com}$0".
  assert.match(spine.buffer.text, /^-- Your Name\nyou@example\.com$/);
  assert.equal(spine.interpreter.evaluate('(snippet-active?)'), true);
});

test('an unknown trigger word does not expand (snippet-expand returns #f)', () => {
  const { spine } = makeSpine('');
  for (const ch of 'zzznotasnippet') spine.handleKey(ch);
  assert.equal(spine.interpreter.evaluate('(snippet-expand)'), false);
  assert.equal(spine.buffer.text, 'zzznotasnippet', 'the typed word is untouched');
});

test('a mirrored field installs a multi-cursor set (Policy A), server-side', () => {
  // A snippet where $1 appears twice (a field + a mirror). Arriving on the
  // field installs a secondary cursor over each mirror, so typing updates
  // every occurrence — the snippet/multi-cursor integration over the wire.
  const { spine } = makeSpine('');
  spine.interpreter.evaluate(
    '(define rec (hash-map :key "tc" :name "tc" :group nil :condition nil ' +
    ':body "try { $0 } catch (${1:e}) { log($1) }" :source :test))'
  );
  spine.interpreter.evaluate('(-expand-record! rec (point))');
  assert.equal(spine.buffer.text, 'try {  } catch (e) { log(e) }');
  assert.equal(spine.interpreter.evaluate('(snippet-active?)'), true);
  // Two cursors: the field's "e" and the mirror's "e" both selected.
  assert.equal(spine.interpreter.evaluate('(cursor-count)'), 2);
  const cursors = spine.cursorsOf(0);
  for (const c of cursors) {
    const lo = Math.min(c.point, c.mark);
    const hi = Math.max(c.point, c.mark);
    assert.equal(spine.buffer.text.slice(lo, hi), 'e', 'each caret selects the field text');
  }
});

test('snippet-cancel leaves the inserted text but ends the snippet', () => {
  const { spine } = makeSpine('');
  spine.interpreter.evaluate('(snippet-insert-by-key "todo")');
  const before = spine.buffer.text;
  spine.runCommand('snippet-cancel');
  assert.equal(spine.interpreter.evaluate('(snippet-active?)'), false);
  assert.equal(spine.buffer.text, before, 'cancel keeps the inserted text');
});
