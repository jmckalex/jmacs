/**
 * @file latex-compile.test.js — the compile-output formatting path.
 *
 * Regression for the "Maximum call stack size exceeded" crash when
 * compiling a real article: `-latex-format-diags` built the *TeX errors*
 * text by recursing once per diagnostic (`(str line (recurse))`, non-tail),
 * and a real article's first pass emits hundreds–thousands of undefined
 * reference / citation warnings — enough to overflow the stack (the
 * interpreter has no TCO). It now joins via the host `map`/`string-join`,
 * which are iterative. These tests exercise the full
 * `parse-latex-log` → `-latex-errors-text` path at scale.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, NIL } from '@editor/lisp';
import { createLatexPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

async function compileEditor() {
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createLatexPrimitives(),
      'read-file-text!': () => NIL,
      'file-exists?': () => false,
      'list-directory-paths': () => NIL,
      'current-view': () => NIL,
      'view-list': () => NIL,
      'view-file-path': () => NIL,
      'view-buffer': () => NIL,
      'buffer-text': () => '',
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  return (s) => interpreter.evaluate(s);
}

/** A log string with N undefined-reference warnings (what the parser keys
 *  on: `LaTeX Warning: … on input line NN.`). */
function warningLog(n) {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(`LaTeX Warning: Reference \`r${i}' on page 1 undefined on input line ${i}.`);
  }
  return lines.join('\n');
}

test('-latex-errors-text formats a couple of diagnostics correctly', async () => {
  const ev = await compileEditor();
  const log = warningLog(2);
  const text = ev(`(-latex-errors-text (parse-latex-log ${JSON.stringify(log)}))`);
  assert.match(text, /^2 diagnostics:/);
  // One newline-terminated row per diagnostic.
  const rows = text.split('\n').filter((l) => l.includes('warning:'));
  assert.equal(rows.length, 2);
});

test('-latex-errors-text reports an empty diagnostics list in words', async () => {
  const ev = await compileEditor();
  assert.equal(
    ev('(-latex-errors-text (list))'),
    'No LaTeX errors or warnings.\n'
  );
});

test('-latex-errors-text does NOT overflow on a real-article warning count', async () => {
  const ev = await compileEditor();
  // 3000 warnings overflowed the old per-diagnostic recursion.
  const log = warningLog(3000);
  let len = 0;
  assert.doesNotThrow(() => {
    len = ev(`(string-length (-latex-errors-text (parse-latex-log ${JSON.stringify(log)})))`);
  });
  assert.ok(len > 3000, 'produced the full formatted text');
});
