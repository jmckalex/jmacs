/**
 * @file Tests for the reactive Lisp notebook engine (notebook.lisp).
 *
 * The engine is pure Lisp built on the interpreter prelude + core
 * primitives (`read-string`, `eval`, the map/list ops) — it needs no
 * buffer and no other stdlib file. So each test loads just notebook.lisp
 * into a bare interpreter and drives the engine through Lisp calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, keyword, listToArray, NIL } from '@editor/lisp';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/** A bare interpreter with the notebook engine loaded. */
async function engine() {
  const interpreter = createInterpreter({ write: () => {} });
  interpreter.evaluate(await readFile(join(lispDir, 'notebook.lisp'), 'utf8'));
  return interpreter;
}

// --- read-string primitive ----------------------------------------------

test('read-string returns a list of parsed forms', async () => {
  const i = await engine();
  assert.equal(i.evaluate('(length (read-string "(+ 1 2) (- 3 4)"))'), 2);
  assert.equal(i.evaluate('(eval (car (read-string "(+ 1 2)")))'), 3);
});

// --- parse-cells --------------------------------------------------------

test('parse-cells reads (cell NAME EXPR) forms in source order', async () => {
  const i = await engine();
  assert.equal(
    i.evaluate('(length (parse-cells "(cell x 3) (cell y (* (ref \'x) 4))"))'),
    2
  );
  assert.equal(
    i.evaluate("(symbol->string (get (car (parse-cells \"(cell x 3)\")) :name nil))"),
    'x'
  );
});

test('non-(cell ...) forms in the source are ignored', async () => {
  const i = await engine();
  assert.equal(
    i.evaluate('(length (parse-cells "(define x 1) (cell y 2) (random)"))'),
    1
  );
});

// --- engine: full recompute ---------------------------------------------

test('a notebook computes simple cells in order', async () => {
  const i = await engine();
  i.evaluate(
    '(define nb (notebook-from-source "(cell x 3) (cell y (* (ref \'x) 4))"))'
  );
  assert.equal(i.evaluate("(get (get nb :values {}) 'x nil)"), 3);
  assert.equal(i.evaluate("(get (get nb :values {}) 'y nil)"), 12);
});

test('changing an upstream cell reflows the dependent', async () => {
  const i = await engine();
  i.evaluate(
    '(define nb (notebook-from-source "(cell x 3) (cell y (* (ref \'x) 4))"))'
  );
  assert.equal(i.evaluate("(get (get nb :values {}) 'y nil)"), 12);
  i.evaluate(
    '(set! nb (notebook-update-source nb "(cell x 10) (cell y (* (ref \'x) 4))"))'
  );
  assert.equal(i.evaluate("(get (get nb :values {}) 'x nil)"), 10);
  assert.equal(i.evaluate("(get (get nb :values {}) 'y nil)"), 40);
});

// --- engine: dependency tracking ----------------------------------------

test('a cell records its (ref ...) reads in :deps', async () => {
  const i = await engine();
  i.evaluate(
    '(define nb (notebook-from-source "(cell a 1) (cell b (+ (ref \'a) 2))"))'
  );
  assert.equal(
    i.evaluate("(length (get (-cell-by-name (get nb :cells) 'b) :deps (list)))"),
    1
  );
});

test('editing a cell to ADD a dep updates the graph', async () => {
  const i = await engine();
  i.evaluate('(define nb (notebook-from-source "(cell a 1) (cell b 100)"))');
  assert.equal(i.evaluate("(get (get nb :values {}) 'b nil)"), 100);
  i.evaluate(
    '(set! nb (notebook-update-source nb "(cell a 5) (cell b (+ (ref \'a) 1))"))'
  );
  assert.equal(i.evaluate("(get (get nb :values {}) 'b nil)"), 6);
  i.evaluate(
    '(set! nb (notebook-update-source nb "(cell a 99) (cell b (+ (ref \'a) 1))"))'
  );
  assert.equal(i.evaluate("(get (get nb :values {}) 'b nil)"), 100);
});

test('editing a cell to REMOVE a dep updates the graph', async () => {
  const i = await engine();
  i.evaluate(
    '(define nb (notebook-from-source "(cell a 1) (cell b (+ (ref \'a) 2))"))'
  );
  assert.equal(i.evaluate("(get (get nb :values {}) 'b nil)"), 3);
  i.evaluate('(set! nb (notebook-update-source nb "(cell a 1) (cell b 50)"))');
  assert.equal(i.evaluate("(get (get nb :values {}) 'b nil)"), 50);
  assert.equal(
    i.evaluate("(length (get (-cell-by-name (get nb :cells) 'b) :deps (list)))"),
    0
  );
});

// --- engine: cycle detection --------------------------------------------

test('a cycle is detected, not overflowed', async () => {
  const i = await engine();
  i.evaluate(
    '(define nb (notebook-from-source "(cell a (ref \'b)) (cell b (ref \'a))"))'
  );
  assert.equal(
    i.evaluate("(eq? :error (get (-cell-by-name (get nb :cells) 'a) :state :ok))"),
    true
  );
  assert.ok(
    i.evaluate("(get (-cell-by-name (get nb :cells) 'a) :error \"\")").includes('cycle'),
    'reports a cycle'
  );
});

// --- engine: stale marking + manual recompute ---------------------------

test('a cell marked :stale recomputes on the next recompute-all', async () => {
  const i = await engine();
  i.evaluate('(define nb (notebook-from-source "(cell x 7)"))');
  i.evaluate(
    "(set! nb (assoc nb :cells " +
      "(map (lambda (c) (assoc c :state :stale)) (get nb :cells))))"
  );
  i.evaluate('(set! nb (-recompute-all nb))');
  assert.equal(
    i.evaluate("(eq? :ok (get (-cell-by-name (get nb :cells) 'x) :state :ok))"),
    true
  );
});

// --- engine: diamond dependency -----------------------------------------

test('a diamond dependency sorts correctly', async () => {
  // a -> b, a -> c, b -> d, c -> d. d must be last.
  const i = await engine();
  i.evaluate(
    '(define nb (notebook-from-source ' +
      '"(cell a 1) (cell b (+ (ref \'a) 10)) ' +
      '(cell c (+ (ref \'a) 100)) ' +
      '(cell d (+ (ref \'b) (ref \'c)))"))'
  );
  assert.equal(i.evaluate("(get (get nb :values {}) 'd nil)"), 112);
});

// --- engine: error propagation ------------------------------------------

test('an erroring cell is caught, its state goes :error', async () => {
  const i = await engine();
  i.evaluate('(define nb (notebook-from-source "(cell bad (/ 1 0))"))');
  assert.equal(
    i.evaluate("(eq? :error (get (-cell-by-name (get nb :cells) 'bad) :state :ok))"),
    true
  );
});

// --- bare-name resolution -----------------------------------------------

test('cells can read each other by bare name (no explicit ref)', async () => {
  const i = await engine();
  i.evaluate('(define nb (notebook-from-source "(cell x 3) (cell y (* x 4))"))');
  assert.equal(i.evaluate("(get (get nb :values {}) 'y nil)"), 12);
  // and the dependency is still recorded
  assert.equal(
    i.evaluate(
      "(symbol->string (car (get (-cell-by-name (get nb :cells) 'y) :deps (list))))"
    ),
    'x'
  );
  // editing the upstream cell reflows the dependent
  i.evaluate('(set! nb (notebook-update-source nb "(cell x 10) (cell y (* x 4))"))');
  assert.equal(i.evaluate("(get (get nb :values {}) 'y nil)"), 40);
});

test('a lambda parameter shadows a cell of the same name', async () => {
  const i = await engine();
  // cell x is 100, but the lambda param x (=5) wins inside its body.
  i.evaluate(
    '(define nb (notebook-from-source ' +
      '"(cell x 100) (cell f ((lambda (x) (+ x 1)) 5))"))'
  );
  assert.equal(i.evaluate("(get (get nb :values {}) 'f nil)"), 6);
  // f read no cell, so it has no dependency on x.
  assert.equal(
    i.evaluate("(length (get (-cell-by-name (get nb :cells) 'f) :deps (list)))"),
    0
  );
});

test('a let binding shadows a cell of the same name', async () => {
  const i = await engine();
  i.evaluate(
    '(define nb (notebook-from-source ' +
      '"(cell x 100) (cell g (let ((x 5)) (+ x 1)))"))'
  );
  assert.equal(i.evaluate("(get (get nb :values {}) 'g nil)"), 6);
});

// --- a worked example (the shape of sample-documents/demo.rxlisp) -------

test('a numeric chain computes and reflows on an upstream edit', async () => {
  const i = await engine();
  const src =
    '(cell radius 5) ' +
    '(cell area (* 3.14159 radius radius)) ' +
    '(cell circumference (* 2 3.14159 radius))';
  i.evaluate('(define nb (notebook-from-source "' + src + '"))');
  assert.equal(i.evaluate("(get (get nb :values {}) 'radius nil)"), 5);
  assert.equal(i.evaluate("(get (get nb :values {}) 'area nil)"), 78.53975);
  assert.equal(i.evaluate("(get (get nb :values {}) 'circumference nil)"), 31.4159);
  // Edit radius → 10; area and circumference reflow.
  const edited = src.replace('(cell radius 5)', '(cell radius 10)');
  i.evaluate('(set! nb (notebook-update-source nb "' + edited + '"))');
  assert.equal(i.evaluate("(get (get nb :values {}) 'area nil)"), 314.159);
  assert.equal(i.evaluate("(get (get nb :values {}) 'circumference nil)"), 62.8318);
});

// --- host bridge: notebook-eval! marshalling ----------------------------

test('notebook-eval! returns marshalled per-cell records', async () => {
  const i = await engine();
  i.evaluate(
    '(define cells (notebook-eval! "nb-1" ' +
      '"(cell x 3) (cell y (* (ref \'x) 4))"))'
  );
  assert.equal(i.evaluate('(length cells)'), 2);
  // name + output are plain strings; state is a keyword.
  assert.equal(i.evaluate('(get (car cells) :name "")'), 'x');
  assert.equal(i.evaluate('(get (car cells) :output "")'), '3');
  // state is marshalled as a plain string for the renderer.
  assert.equal(i.evaluate('(get (car cells) :state "")'), 'ok');
  assert.equal(i.evaluate('(get (cadr cells) :output "")'), '12');
  // y read x — its deps are marshalled as strings.
  assert.equal(i.evaluate('(car (get (cadr cells) :deps (list)))'), 'x');
});

test('the host can marshal notebook-eval! records to plain JS', async () => {
  // Mirrors apps/desktop/src/app.js `marshalNotebookCell`: read the Lisp
  // cell-record maps via interned keywords + listToArray. This guards the
  // renderer's evaluate() contract, which can't run headless.
  const i = await engine();
  const lispCells = listToArray(
    i.call('notebook-eval!', 'nb-host', "(cell x 3) (cell bad (/ 1 0))")
  );
  const k = {
    name: keyword('name'),
    output: keyword('output'),
    state: keyword('state'),
    error: keyword('error'),
    deps: keyword('deps'),
  };
  const cells = lispCells.map((m) => ({
    name: String(m.get(k.name) ?? ''),
    output: String(m.get(k.output) ?? ''),
    state: String(m.get(k.state) ?? 'ok'),
    error: String(m.get(k.error) ?? ''),
    deps: listToArray(m.get(k.deps) ?? NIL).map(String),
  }));
  assert.deepEqual(cells[0], {
    name: 'x',
    output: '3',
    state: 'ok',
    error: '',
    deps: [],
  });
  assert.equal(cells[1].name, 'bad');
  assert.equal(cells[1].state, 'error');
  assert.ok(cells[1].error.length > 0);
});

test('a cell whose value is an SVG string is marshalled as a graphic', async () => {
  const i = await engine();
  const cells = listToArray(
    i.call(
      'notebook-eval!',
      'nb-svg',
      "(cell c (str \"<svg width='10' height='10'></svg>\"))"
    )
  );
  assert.ok(String(cells[0].get(keyword('graphic'))).includes('<svg'));
  // a plain value carries no graphic.
  const plain = listToArray(i.call('notebook-eval!', 'nb-svg2', '(cell n 42)'));
  assert.equal(String(plain[0].get(keyword('graphic'))), '');
});

test('notebook-eval! preserves the notebook and reflows on edit', async () => {
  const i = await engine();
  i.evaluate('(notebook-eval! "nb-2" "(cell x 3) (cell y (* (ref \'x) 4))")');
  // Re-evaluating with an edited upstream cell reflows the dependent.
  i.evaluate(
    '(define cells (notebook-eval! "nb-2" ' +
      '"(cell x 10) (cell y (* (ref \'x) 4))"))'
  );
  assert.equal(i.evaluate('(get (cadr cells) :output "")'), '40');
});
