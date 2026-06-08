/**
 * @file reftex-refs.test.js — unit tests for RefTeX R2's pure core
 * (reftex-refs.lisp): the label-key generator and the reference-macro
 * selection.
 *
 * Part A of the R2 build is the insertion core: a smart label key
 * (type-at-point inference, slugify, prefix lookup, uniquify) and the
 * ref-macro-by-type lookup. All of that is pure Lisp parameterised by
 * text + offset + a taken-name list, so it is exercised here directly
 * over in-memory fixtures — no buffer, view, or minibuffer needed. The
 * minibuffer/insert round-trip is live-smoke.
 *
 * The harness loads the full standard library (so reftex.lisp's
 * `*reftex-env-types*` and `latex-scan` are present) with the few stub
 * primitives the accessors touch when a test reaches into the DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, listToArray, NIL } from '@editor/lisp';
import { createLatexPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/**
 * Build an interpreter with the whole standard library loaded and a
 * minimal set of stub primitives the RefTeX accessors lean on. By
 * default there is no current view (so `reftex-document` returns nil);
 * tests that need a DB seed `files` + `currentFile` like reftex-db.test.
 */
async function refsEditor(opts = {}) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const state = { currentFile: opts.currentFile ?? null };
  const fxRead = (a) => {
    const p = String(a[0] ?? '');
    return files.has(p) ? files.get(p) : NIL;
  };
  const fxExists = (a) => files.has(String(a[0] ?? ''));

  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createLatexPrimitives(),
      'read-file-text!': fxRead,
      'file-exists?': fxExists,
      'list-directory-paths': () => NIL,
      'current-view': () => (state.currentFile === null ? NIL : 'V'),
      'view-list': () => (state.currentFile === null ? NIL : listToArray(['V'])),
      'view-file-path': (a) =>
        a[0] === 'V' && state.currentFile !== null ? state.currentFile : NIL,
      'view-buffer': (a) => (a[0] === 'V' ? 'B' : NIL),
      'buffer-text': () =>
        state.currentFile !== null && files.has(state.currentFile)
          ? files.get(state.currentFile)
          : '',
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  const ev = (s) => interpreter.evaluate(s);
  const arr = (s) => listToArray(ev(s));
  return { interpreter, ev, arr, state, files };
}

/** A Lisp string literal for embedding fixture text safely. */
function lispString(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// --- type-at-point inference -------------------------------------------

test('type at point: inside an equation environment -> :equation', async () => {
  const { ev } = await refsEditor();
  const text = '\\begin{equation}\n  x = 1\n\\end{equation}\n';
  // Offset inside the body (the "x = 1" line).
  const offset = text.indexOf('x =');
  assert.equal(
    ev(`(-reftex-type-at-point ${lispString(text)} ${offset})`),
    ev('(quote :equation)') // keyword equality via the reader
  );
});

test('type at point: align* maps to :equation (star stripped)', async () => {
  const { ev } = await refsEditor();
  const text = '\\begin{align*}\n  y &= 2 \\\\\n\\end{align*}\n';
  const offset = text.indexOf('y &');
  assert.equal(
    ev(`(eq? (-reftex-type-at-point ${lispString(text)} ${offset}) :equation)`),
    true
  );
});

test('type at point: inside a figure -> :figure', async () => {
  const { ev } = await refsEditor();
  const text =
    '\\begin{figure}\n  \\includegraphics{a}\n  \\caption{A plot}\n\\end{figure}\n';
  const offset = text.indexOf('\\caption');
  assert.equal(
    ev(`(eq? (-reftex-type-at-point ${lispString(text)} ${offset}) :figure)`),
    true
  );
});

test('type at point: inside a table -> :table', async () => {
  const { ev } = await refsEditor();
  const text = '\\begin{table}\n  \\caption{Results}\n\\end{table}\n';
  const offset = text.indexOf('\\caption');
  assert.equal(
    ev(`(eq? (-reftex-type-at-point ${lispString(text)} ${offset}) :table)`),
    true
  );
});

test('type at point: inside lstlisting -> :listing', async () => {
  const { ev } = await refsEditor();
  const text = '\\begin{lstlisting}\nfoo()\n\\end{lstlisting}\n';
  const offset = text.indexOf('foo');
  assert.equal(
    ev(`(eq? (-reftex-type-at-point ${lispString(text)} ${offset}) :listing)`),
    true
  );
});

test('type at point: right after a \\section line -> :section', async () => {
  const { ev } = await refsEditor();
  const text = '\\section{Introduction}\nSome prose here.\n';
  // Offset on the section line itself.
  const offset = text.indexOf('Introduction');
  assert.equal(
    ev(`(eq? (-reftex-type-at-point ${lispString(text)} ${offset}) :section)`),
    true
  );
});

test('type at point: no environment, no section -> nil', async () => {
  const { ev } = await refsEditor();
  const text = 'Just some plain prose with no structure.\n';
  const offset = 5;
  assert.equal(
    ev(`(nil? (-reftex-type-at-point ${lispString(text)} ${offset}))`),
    true
  );
});

test('type at point: innermost of nested environments wins', async () => {
  const { ev } = await refsEditor();
  // A figure containing an equation: an offset in the inner equation
  // should report :equation, not :figure.
  const text =
    '\\begin{figure}\n\\begin{equation}\nz = 3\n\\end{equation}\n\\end{figure}\n';
  const offset = text.indexOf('z = 3');
  assert.equal(
    ev(`(eq? (-reftex-type-at-point ${lispString(text)} ${offset}) :equation)`),
    true
  );
});

// --- slugify -----------------------------------------------------------

test('slugify lowercases and replaces non-alnum with single dashes', async () => {
  const { ev } = await refsEditor();
  assert.equal(ev('(-reftex-slugify "Hello, World!")'), 'hello-world');
  assert.equal(ev('(-reftex-slugify "A Plot of x^2")'), 'a-plot-of-x-2');
  assert.equal(ev('(-reftex-slugify "Multiple   spaces")'), 'multiple-spaces');
});

test('slugify trims leading/trailing separators', async () => {
  const { ev } = await refsEditor();
  assert.equal(ev('(-reftex-slugify "  spaced out  ")'), 'spaced-out');
  assert.equal(ev('(-reftex-slugify "!!!bang!!!")'), 'bang');
});

test('slugify of an all-punctuation string is empty', async () => {
  const { ev } = await refsEditor();
  assert.equal(ev('(-reftex-slugify "...---...")'), '');
});

// --- prefix lookup -----------------------------------------------------

test('prefix-for-type reads the defcustom alist', async () => {
  const { ev } = await refsEditor();
  assert.equal(ev('(-reftex-prefix-for-type :equation)'), 'eq:');
  assert.equal(ev('(-reftex-prefix-for-type :figure)'), 'fig:');
  assert.equal(ev('(-reftex-prefix-for-type :table)'), 'tab:');
  assert.equal(ev('(-reftex-prefix-for-type :section)'), 'sec:');
  assert.equal(ev('(-reftex-prefix-for-type :listing)'), 'lst:');
});

test('prefix-for-type falls back to the default prefix for an unknown type', async () => {
  const { ev } = await refsEditor();
  // nil type / an unlisted type uses *reftex-label-default-prefix* ("").
  assert.equal(ev('(-reftex-prefix-for-type nil)'), '');
  assert.equal(ev('(-reftex-prefix-for-type :widget)'), '');
});

// --- ref-macro-by-type -------------------------------------------------

test('macro-for-type: equation -> \\eqref, others -> \\ref', async () => {
  const { ev } = await refsEditor();
  assert.equal(ev('(-reftex-macro-for-type :equation)'), '\\eqref');
  assert.equal(ev('(-reftex-macro-for-type :figure)'), '\\ref');
  assert.equal(ev('(-reftex-macro-for-type :section)'), '\\ref');
  assert.equal(ev('(-reftex-macro-for-type nil)'), '\\ref');
});

// --- uniquify ----------------------------------------------------------

test('uniquify returns the key unchanged when free', async () => {
  const { ev } = await refsEditor();
  assert.equal(ev('(-reftex-uniquify "eq:foo" (list "eq:bar" "eq:baz"))'), 'eq:foo');
});

test('uniquify appends -2, -3, … against taken names', async () => {
  const { ev } = await refsEditor();
  assert.equal(ev('(-reftex-uniquify "eq:foo" (list "eq:foo"))'), 'eq:foo-2');
  assert.equal(
    ev('(-reftex-uniquify "eq:foo" (list "eq:foo" "eq:foo-2"))'),
    'eq:foo-3'
  );
});

// --- suggest-key (the composed key generator) --------------------------

test('suggest-key: figure caption -> fig:<slug>, uniquified', async () => {
  const { ev } = await refsEditor();
  const text =
    '\\begin{figure}\n  \\caption{The Big Plot}\n  \\label{HERE}\n\\end{figure}\n';
  const offset = text.indexOf('\\label');
  assert.equal(
    ev(`(-reftex-suggest-key ${lispString(text)} ${offset} (list))`),
    'fig:the-big-plot'
  );
  // With the slug already taken, it disambiguates.
  assert.equal(
    ev(`(-reftex-suggest-key ${lispString(text)} ${offset} (list "fig:the-big-plot"))`),
    'fig:the-big-plot-2'
  );
});

test('suggest-key: equation with no caption -> eq:equation', async () => {
  const { ev } = await refsEditor();
  const text = '\\begin{equation}\n  HERE\n\\end{equation}\n';
  const offset = text.indexOf('HERE');
  assert.equal(
    ev(`(-reftex-suggest-key ${lispString(text)} ${offset} (list))`),
    'eq:equation'
  );
});

test('suggest-key: on a \\section line -> sec:<slug-of-title>', async () => {
  const { ev } = await refsEditor();
  // RefTeX convention: the label goes on the sectioning line itself
  // (e.g. \section{...}\label{...}). The offset is on that line.
  const text = '\\section{My Great Section} HERE\nprose.\n';
  const offset = text.indexOf('HERE');
  assert.equal(
    ev(`(-reftex-suggest-key ${lispString(text)} ${offset} (list))`),
    'sec:my-great-section'
  );
});

test('suggest-key: typeless location -> bare "label", uniquified', async () => {
  const { ev } = await refsEditor();
  const text = 'plain prose HERE with nothing\n';
  const offset = text.indexOf('HERE');
  assert.equal(
    ev(`(-reftex-suggest-key ${lispString(text)} ${offset} (list))`),
    'label'
  );
  assert.equal(
    ev(`(-reftex-suggest-key ${lispString(text)} ${offset} (list "label"))`),
    'label-2'
  );
});

// --- reftex-ref-candidates (the reference-candidate model) -------------

test('reftex-ref-candidates: macro chosen by each label type', async () => {
  const { ev, arr } = await refsEditor({
    files: {
      '/d/main.tex':
        '\\documentclass{article}\n' +
        '\\begin{equation}\\label{eq:a}\\end{equation}\n' +
        '\\section{S}\\label{sec:b}\n',
    },
    currentFile: '/d/main.tex',
  });
  // Names appear in document order.
  assert.deepEqual(
    arr('(map (lambda (c) (get c :name)) (reftex-ref-candidates))'),
    ['eq:a', 'sec:b']
  );
  // The equation label gets \eqref; the section label \ref.
  assert.deepEqual(
    arr('(map (lambda (c) (get c :macro)) (reftex-ref-candidates))'),
    ['\\eqref', '\\ref']
  );
});

test('reftex-ref-candidates: nil when there is no document', async () => {
  const { ev } = await refsEditor();
  assert.equal(ev('(nil? (reftex-ref-candidates))'), true);
});

// --- the label tab-complete hook delegation ----------------------------

test('minibuffer-tab-complete delegates to find-file when no RefTeX hook', async () => {
  const { ev } = await refsEditor();
  // With *reftex-tab-complete* nil, the redefined dispatcher must call
  // the captured find-file handler. With no directory listing available
  // ('list-directory-paths returns nil), find-file reports "(no matches)"
  // and returns the value unchanged — i.e. it did not throw and did
  // route through the original.
  assert.equal(ev('(nil? *reftex-tab-complete*)'), true);
  assert.equal(ev('(minibuffer-tab-complete "/nope/")'), '/nope/');
});

test('label tab-complete extends to the common prefix of label names', async () => {
  const { ev } = await refsEditor({
    files: {
      '/d/main.tex':
        '\\documentclass{article}\n\\label{eq:alpha}\n\\label{eq:alpine}\n',
    },
    currentFile: '/d/main.tex',
  });
  // "eq:a" completes to the LCP "eq:alp" (alpha / alpine share it).
  assert.equal(ev('(-reftex-label-tab-complete "eq:a")'), 'eq:alp');
  // A unique prefix completes fully.
  assert.equal(ev('(-reftex-label-tab-complete "eq:alph")'), 'eq:alpha');
});

// --- Part B: context derivation + select-candidate model ---------------

test('context-from-text returns the trimmed 1-based line', async () => {
  const { ev } = await refsEditor();
  const text = 'line one\n  spaced line two  \nline three\n';
  assert.equal(ev(`(-reftex-context-from-text ${lispString(text)} 1)`), 'line one');
  assert.equal(
    ev(`(-reftex-context-from-text ${lispString(text)} 2)`),
    'spaced line two'
  );
  assert.equal(ev(`(-reftex-context-from-text ${lispString(text)} 3)`), 'line three');
});

test('context-from-text is nil for nil text/line or out-of-range', async () => {
  const { ev } = await refsEditor();
  const text = 'only line\n';
  assert.equal(ev(`(nil? (-reftex-context-from-text ${lispString(text)} nil))`), true);
  assert.equal(ev('(nil? (-reftex-context-from-text nil 1))'), true);
  assert.equal(ev(`(nil? (-reftex-context-from-text ${lispString(text)} 99))`), true);
  assert.equal(ev(`(nil? (-reftex-context-from-text ${lispString(text)} 0))`), true);
});

test('reftex-candidate-context: the source line carrying the label', async () => {
  const { ev } = await refsEditor({
    files: {
      '/d/main.tex':
        '\\documentclass{article}\n' +
        '\\begin{equation}\\label{eq:a} x=1 \\end{equation}\n',
    },
    currentFile: '/d/main.tex',
  });
  // The label is on line 2; its context is that trimmed source line.
  assert.equal(
    ev('(reftex-candidate-context (reftex-find-label "eq:a"))'),
    '\\begin{equation}\\label{eq:a} x=1 \\end{equation}'
  );
});

test('reftex-select-candidates: flat (name type macro context) rows', async () => {
  const { ev, arr } = await refsEditor({
    files: {
      '/d/main.tex':
        '\\documentclass{article}\n' +
        '\\begin{equation}\\label{eq:a}\\end{equation}\n' +
        '\\section{Intro}\\label{sec:b}\n',
    },
    currentFile: '/d/main.tex',
  });
  // Build the candidates the way reftex-reference does.
  ev('(set! *reftex-select-candidates* (-reftex-build-select-candidates))');
  // Names in document order.
  assert.deepEqual(
    arr('(map (lambda (r) (nth r 0)) (reftex-select-candidates))'),
    ['eq:a', 'sec:b']
  );
  // Type strings (lowercased keyword names).
  assert.deepEqual(
    arr('(map (lambda (r) (nth r 1)) (reftex-select-candidates))'),
    ['equation', 'section']
  );
  // Macros by type.
  assert.deepEqual(
    arr('(map (lambda (r) (nth r 2)) (reftex-select-candidates))'),
    ['\\eqref', '\\ref']
  );
});

test('reftex-select-candidates is empty when there is no document', async () => {
  const { ev, arr } = await refsEditor();
  assert.deepEqual(arr('(reftex-select-candidates)'), []);
  assert.deepEqual(arr('(-reftex-build-select-candidates)'), []);
});
