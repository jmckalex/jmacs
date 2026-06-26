/**
 * @file Server-side port test for snippets-parser.lisp (G3).
 *
 * snippets-parser.lisp is PURE data-in / data-out — no buffer, no I/O, no
 * host primitives — so it loads verbatim in the spine and its
 * parse-snippet-file / parse-snippet-body run unchanged server-side. This
 * drives both through the spine's interpreter. See PRIMITIVE-SPLIT.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';

function makeSpine() {
  return createSpine(
    { initialText: '', name: 'scratch.txt' },
    {
      onStatus: () => {}, onMinibufferOpen: () => {}, onMinibufferClose: () => {},
      onScroll: () => {}, onPicker: () => {},
    }
  );
}

test('parse-snippet-body resolves ${N:default} into the inserted text, server-side', () => {
  const spine = makeSpine();
  spine.interpreter.evaluate(
    '(define b (parse-snippet-body "for (${1:i} = 0; $1 < ${2:n}) {\\n  $0\\n}"))'
  );
  assert.equal(
    spine.interpreter.evaluate('(get b :text nil)'),
    'for (i = 0; i < n) {\n  \n}'
  );
});

test('parse-snippet-body records the $0 exit and treats $$ as a literal dollar', () => {
  const spine = makeSpine();
  spine.interpreter.evaluate('(define b (parse-snippet-body "abc$0def"))');
  assert.equal(spine.interpreter.evaluate('(get b :text nil)'), 'abcdef');
  assert.equal(spine.interpreter.evaluate('(get b :exit nil)'), 3);

  spine.interpreter.evaluate('(define d (parse-snippet-body "cost $$5"))');
  assert.equal(spine.interpreter.evaluate('(get d :text nil)'), 'cost $5');
});

test('parse-snippet-file reads the yasnippet header and body, server-side', () => {
  const spine = makeSpine();
  spine.interpreter.evaluate(
    '(define f (parse-snippet-file "# key: fn\\n# name: function\\n# --\\nfunction $1() {\\n  $0\\n}"))'
  );
  assert.equal(spine.interpreter.evaluate('(get f :key nil)'), 'fn');
  assert.equal(spine.interpreter.evaluate('(get f :name nil)'), 'function');
  assert.equal(
    spine.interpreter.evaluate('(get f :body nil)'),
    'function $1() {\n  $0\n}'
  );
});
