/**
 * notebook-cells.test.js — the generalizable notebook document model.
 * Pure logic (no DOM): the unified buffer + offset map + language adapters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createNotebookDocument,
  NOTEBOOK_ADAPTERS,
  freshCellId,
} from '../src/notebook-cells.js';

test('JS adapter: cells wrap in { } on their own lines; ranges are correct', () => {
  const doc = createNotebookDocument(NOTEBOOK_ADAPTERS.javascript);
  const a = doc.addCell('a');
  const b = doc.addCell('b');
  // {\n a \n}\n {\n b \n}\n
  assert.equal(doc.unifiedText(), '{\na\n}\n{\nb\n}\n');
  assert.deepEqual(doc.cellLineRange(a), [1, 2]); // content of a is unified line 1
  assert.deepEqual(doc.cellLineRange(b), [4, 5]); // content of b is unified line 4
  // raw content (for eval) has no scaffolding.
  assert.equal(doc.cellContent(a), 'a');
  assert.equal(doc.cellContent(b), 'b');
});

test('offset map round-trips; scaffolding lines map to null', () => {
  const doc = createNotebookDocument(NOTEBOOK_ADAPTERS.javascript);
  const a = doc.addCell('const x = 1;\nx * 2'); // a 2-line cell
  // content occupies unified lines 1..2 (line 0 is the `{`).
  assert.deepEqual(doc.cellLineRange(a), [1, 3]);
  assert.deepEqual(doc.toUnified(a, 0, 0), { line: 1, column: 0 });
  assert.deepEqual(doc.toUnified(a, 1, 4), { line: 2, column: 4 });
  // unified -> cell
  assert.deepEqual(doc.fromUnified(1, 0), { id: a, cellLine: 0, cellCol: 0 });
  assert.deepEqual(doc.fromUnified(2, 4), { id: a, cellLine: 1, cellCol: 4 });
  // the `{` (line 0) and `}` (line 3) are scaffolding — not in any cell.
  assert.equal(doc.fromUnified(0, 0), null);
  assert.equal(doc.fromUnified(3, 0), null);
});

test('Lisp adapter: cells wrap in (progn …)', () => {
  const doc = createNotebookDocument(NOTEBOOK_ADAPTERS.lisp);
  const a = doc.addCell('(+ 1 2)');
  assert.equal(doc.unifiedText(), '(progn\n(+ 1 2)\n)\n');
  assert.deepEqual(doc.cellLineRange(a), [1, 2]);
  assert.equal(doc.cellContent(a), '(+ 1 2)');
});

test('Python adapter: content is indented under `if True:`; map accounts for indent', () => {
  const doc = createNotebookDocument(NOTEBOOK_ADAPTERS.python);
  const a = doc.addCell('x = 1\nprint(x)');
  assert.equal(doc.unifiedText(), 'if True:\n    x = 1\n    print(x)\n');
  assert.deepEqual(doc.cellLineRange(a), [1, 3]);
  // a cell-local column maps to unified column + indent(4); and back.
  assert.deepEqual(doc.toUnified(a, 0, 0), { line: 1, column: 4 });
  assert.deepEqual(doc.fromUnified(1, 4), { id: a, cellLine: 0, cellCol: 0 });
  assert.deepEqual(doc.fromUnified(2, 9), { id: a, cellLine: 1, cellCol: 5 }); // 9 - 4
  // raw content for eval is the UNindented source.
  assert.equal(doc.cellContent(a), 'x = 1\nprint(x)');
});

test('structural ops: add / insert / setContent / move / remove rebuild the layout', () => {
  const doc = createNotebookDocument(NOTEBOOK_ADAPTERS.javascript);
  const a = doc.addCell('a');
  const c = doc.addCell('c');
  const b = doc.addCell('b', 1); // insert between a and c
  assert.deepEqual(doc.cellIds(), [a, b, c]);
  assert.equal(doc.unifiedText(), '{\na\n}\n{\nb\n}\n{\nc\n}\n');

  doc.setContent(b, 'B2');
  assert.equal(doc.cellContent(b), 'B2');
  assert.equal(doc.unifiedText(), '{\na\n}\n{\nB2\n}\n{\nc\n}\n');

  doc.moveCell(b, 0);
  assert.deepEqual(doc.cellIds(), [b, a, c]);

  assert.equal(doc.removeCell(a), true);
  assert.deepEqual(doc.cellIds(), [b, c]);
  assert.equal(doc.removeCell('nope'), false);
});

test('empty notebook + empty cell are well-formed', () => {
  const doc = createNotebookDocument(NOTEBOOK_ADAPTERS.javascript);
  assert.equal(doc.unifiedText(), '');
  assert.deepEqual(doc.cellIds(), []);
  const a = doc.addCell(''); // empty cell
  assert.equal(doc.unifiedText(), '{\n\n}\n');
  assert.deepEqual(doc.cellLineRange(a), [1, 2]);
});

test('a bad adapter is rejected', () => {
  assert.throws(() => createNotebookDocument(null), TypeError);
  assert.throws(() => createNotebookDocument({}), TypeError);
});

test('freshCellId is unique', () => {
  assert.notEqual(freshCellId(), freshCellId());
});
