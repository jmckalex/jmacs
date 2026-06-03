/**
 * @file reftex-db.test.js — unit tests for RefTeX R1, the multi-file
 * document model + DB (reftex.lisp).
 *
 * The document builder is pure Lisp (`-reftex-build-db`) parameterised
 * by an injected `read-fn` (path -> text-or-nil) and `exists-fn`
 * (path -> #t/#f), so the multi-file logic is testable without a real
 * filesystem. These tests load the full standard library into an
 * interpreter, register in-memory fixture maps as Lisp primitives
 * (`fx-read` / `fx-exists`), and exercise the builder and the impure
 * master-detection / accessors over stubbed view + file primitives.
 *
 * Coverage:
 *   - master detection (3 ways: `% !TEX root`, `\documentclass`,
 *     who-includes-me) plus the `*reftex-master*` override;
 *   - transitive `\input` resolution, cycle guard, missing-input
 *     tolerance;
 *   - DB merge with correct `:file` tagging and document order;
 *   - label `:type` inference (prefix and enclosing environment).
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
 * Build an interpreter with the whole standard library loaded and a set
 * of mutable stub primitives RefTeX leans on. The caller seeds
 * `files` (absolute path -> text) and `currentFile` (the current view's
 * path); the stubs derive `read-file-text!`, `file-exists?`,
 * `list-directory-paths`, `view-list`, `view-file-path`,
 * `current-view`, and `buffer-text` from them.
 *
 * `fx-read` / `fx-exists` are also exposed so the PURE builder
 * (`-reftex-build-db`) can be driven directly with the same fixtures.
 *
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.files] - path -> file text.
 * @param {string|null} [opts.currentFile] - the current view's path.
 * @param {Record<string,string[]>} [opts.dirs] - dir -> basenames, for
 *   `list-directory-paths` (who-includes-me). Each basename becomes a
 *   `(name . :file)` pair.
 */
async function reftexEditor(opts = {}) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const dirs = new Map(Object.entries(opts.dirs ?? {}));
  const state = { currentFile: opts.currentFile ?? null };
  const statusCalls = [];

  const fxRead = (a) => {
    const p = String(a[0] ?? '');
    return files.has(p) ? files.get(p) : NIL;
  };
  const fxExists = (a) => files.has(String(a[0] ?? ''));

  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createLatexPrimitives(),
      // Pure fixtures for driving -reftex-build-db directly.
      'fx-read': fxRead,
      'fx-exists': fxExists,
      // Impure I/O the wrapper / master detection use.
      'read-file-text!': fxRead,
      'file-exists?': fxExists,
      'list-directory-paths': (a) => {
        const dir = String(a[0] ?? '');
        const names = dirs.get(dir);
        if (names === undefined) return NIL;
        // Mirror the host: a list of (name . type) pairs. We build the
        // pair shape the Lisp expects via the interpreter's reader.
        return listToConsPairs(interpreter, names);
      },
      // View primitives — a single "current view" whose file is
      // state.currentFile, plus a one-element view list.
      'current-view': () => (state.currentFile === null ? NIL : 'V'),
      'view-list': () => (state.currentFile === null
        ? NIL
        : listToArray(['V'])),
      'view-file-path': (a) =>
        a[0] === 'V' && state.currentFile !== null ? state.currentFile : NIL,
      'view-buffer': (a) => (a[0] === 'V' ? 'B' : NIL),
      'buffer-text': () =>
        state.currentFile !== null && files.has(state.currentFile)
          ? files.get(state.currentFile)
          : '',
      'show-status!': (a) => {
        statusCalls.push(String(a[0] ?? ''));
        return NIL;
      },
      'clear-status!': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  const ev = (s) => interpreter.evaluate(s);
  const arr = (s) => listToArray(ev(s));
  return { interpreter, ev, arr, state, statusCalls, files };
}

/**
 * Build a Lisp list of `(name . :file)` pairs from basenames, using the
 * interpreter so the cons cells are real Lisp pairs.
 */
function listToConsPairs(interpreter, names) {
  interpreter.evaluate('(define -tmp-entries (list))');
  for (const name of names) {
    interpreter.define('-tmp-name', name);
    interpreter.evaluate('(set! -tmp-entries (cons (cons -tmp-name :file) -tmp-entries))');
  }
  return interpreter.evaluate('(reverse -tmp-entries)');
}

// --- the pure builder: document order, :file tagging, merge ------------

test('the DB scans the master and its inputs in document order', async () => {
  const { ev, arr } = await reftexEditor({
    files: {
      '/d/main.tex':
        '\\documentclass{book}\n\\section{Intro}\\label{sec:intro}\n' +
        '\\input{ch1}\n\\input{ch2}\n',
      '/d/ch1.tex': '\\label{eq:one}\n',
      '/d/ch2.tex': '\\label{eq:two}\n',
    },
  });
  ev('(define db (-reftex-build-db fx-read fx-exists "/d/main.tex"))');
  assert.deepEqual(arr('(get db :files nil)'),
    ['/d/main.tex', '/d/ch1.tex', '/d/ch2.tex']);
  // Labels appear in document order: master's first, then each input's.
  assert.deepEqual(
    arr('(map (lambda (l) (get l :name)) (get db :labels nil))'),
    ['sec:intro', 'eq:one', 'eq:two']
  );
});

test('every record is tagged with its absolute :file', async () => {
  const { ev, arr } = await reftexEditor({
    files: {
      '/d/main.tex': '\\documentclass{a}\n\\label{m}\n\\input{ch}\n',
      '/d/ch.tex': '\\label{c}\n\\cite{key}\n\\section{S}\n',
    },
  });
  ev('(define db (-reftex-build-db fx-read fx-exists "/d/main.tex"))');
  assert.deepEqual(
    arr('(map (lambda (l) (get l :file)) (get db :labels nil))'),
    ['/d/main.tex', '/d/ch.tex']
  );
  assert.deepEqual(
    arr('(map (lambda (c) (get c :file)) (get db :cites nil))'),
    ['/d/ch.tex']
  );
  assert.deepEqual(
    arr('(map (lambda (s) (get s :file)) (get db :sections nil))'),
    ['/d/ch.tex']
  );
});

test('a missing \\input is recorded in :missing, not crashed on', async () => {
  const { ev, arr } = await reftexEditor({
    files: {
      '/d/main.tex': '\\documentclass{a}\n\\input{present}\n\\input{absent}\n',
      '/d/present.tex': '\\label{p}\n',
    },
  });
  ev('(define db (-reftex-build-db fx-read fx-exists "/d/main.tex"))');
  assert.deepEqual(arr('(get db :files nil)'),
    ['/d/main.tex', '/d/present.tex']);
  assert.deepEqual(arr('(get db :missing nil)'), ['/d/absent.tex']);
});

test('an \\input cycle is scanned once per file (cycle guard)', async () => {
  const { ev, arr } = await reftexEditor({
    files: {
      '/c/a.tex': '\\documentclass{a}\\label{a1}\n\\input{b}\n',
      '/c/b.tex': '\\label{b1}\n\\input{a}\n',
    },
  });
  ev('(define db (-reftex-build-db fx-read fx-exists "/c/a.tex"))');
  assert.deepEqual(arr('(get db :files nil)'), ['/c/a.tex', '/c/b.tex']);
  assert.deepEqual(
    arr('(map (lambda (l) (get l :name)) (get db :labels nil))'),
    ['a1', 'b1']
  );
});

test('\\input without an extension resolves to a .tex sibling', async () => {
  const { ev } = await reftexEditor({
    files: {
      '/d/main.tex': '\\documentclass{a}\n\\input{sub/part}\n',
      '/d/sub/part.tex': '\\label{x}\n',
    },
  });
  ev('(define db (-reftex-build-db fx-read fx-exists "/d/main.tex"))');
  assert.equal(ev('(length (get db :files nil))'), 2);
  assert.equal(
    ev('(nth (get db :files nil) 1)'),
    '/d/sub/part.tex'
  );
});

// --- label :type inference ---------------------------------------------

test('label :type is inferred from the name prefix', async () => {
  const { ev } = await reftexEditor();
  assert.equal(ev('(str (-reftex-label-type "eq:e" nil))'), ':equation');
  assert.equal(ev('(str (-reftex-label-type "fig:f" nil))'), ':figure');
  assert.equal(ev('(str (-reftex-label-type "tab:t" nil))'), ':table');
  assert.equal(ev('(str (-reftex-label-type "sec:s" nil))'), ':section');
  assert.equal(ev('(str (-reftex-label-type "lst:l" nil))'), ':listing');
});

test('label :type falls back to the enclosing environment', async () => {
  const { ev } = await reftexEditor();
  // No recognised prefix → env decides.
  assert.equal(ev('(str (-reftex-label-type "loose" "equation"))'), ':equation');
  assert.equal(ev('(str (-reftex-label-type "loose" "align*"))'), ':equation');
  assert.equal(ev('(str (-reftex-label-type "loose" "figure"))'), ':figure');
  assert.equal(ev('(str (-reftex-label-type "loose" "table"))'), ':table');
  // A prefix wins over the environment.
  assert.equal(ev('(str (-reftex-label-type "fig:x" "equation"))'), ':figure');
  // Neither prefix nor env → nil.
  assert.equal(ev('(nil? (-reftex-label-type "loose" nil))'), true);
  assert.equal(ev('(nil? (-reftex-label-type "loose" "itemize"))'), true);
});

test('the built DB carries inferred label types', async () => {
  const { ev, arr } = await reftexEditor({
    files: {
      '/d/main.tex':
        '\\documentclass{a}\n' +
        '\\section{S}\\label{sec:s}\n' +
        '\\begin{equation}\\label{loose}\\end{equation}\n',
    },
  });
  ev('(define db (-reftex-build-db fx-read fx-exists "/d/main.tex"))');
  assert.deepEqual(
    arr('(map (lambda (l) (str (get l :type))) (get db :labels nil))'),
    [':section', ':equation']
  );
});

// --- master detection: % !TEX root -------------------------------------

test('reftex-master honours a % !TEX root magic comment', async () => {
  const { ev } = await reftexEditor({
    currentFile: '/d/chapters/intro.tex',
    files: {
      '/d/chapters/intro.tex': '% !TEX root = ../book.tex\n\\section{Intro}\n',
      '/d/book.tex': '\\documentclass{book}\n\\input{chapters/intro}\n',
    },
  });
  assert.equal(ev('(reftex-master)'), '/d/book.tex');
});

test('a % !TEX root without an extension gets .tex appended', async () => {
  const { ev } = await reftexEditor({
    currentFile: '/d/c.tex',
    files: {
      '/d/c.tex': '%!TEX root = main\n',
      '/d/main.tex': '\\documentclass{a}\n',
    },
  });
  assert.equal(ev('(reftex-master)'), '/d/main.tex');
});

// --- master detection: \documentclass ----------------------------------

test('reftex-master picks the current file when it has \\documentclass', async () => {
  const { ev } = await reftexEditor({
    currentFile: '/d/standalone.tex',
    files: { '/d/standalone.tex': '\\documentclass{article}\n\\label{x}\n' },
  });
  assert.equal(ev('(reftex-master)'), '/d/standalone.tex');
});

// --- master detection: who-includes-me ---------------------------------

test('reftex-master finds the sole sibling that \\inputs the current file', async () => {
  const { ev } = await reftexEditor({
    currentFile: '/d/intro.tex',
    files: {
      '/d/intro.tex': '\\section{Intro}\n', // no documentclass, no magic
      '/d/book.tex': '\\documentclass{book}\n\\input{intro}\n',
      '/d/notes.tex': 'unrelated\n',
    },
    dirs: { '/d': ['intro.tex', 'book.tex', 'notes.tex'] },
  });
  assert.equal(ev('(reftex-master)'), '/d/book.tex');
});

test('who-includes-me prefers an includer with \\documentclass', async () => {
  const { ev } = await reftexEditor({
    currentFile: '/d/intro.tex',
    files: {
      '/d/intro.tex': '\\section{Intro}\n',
      '/d/book.tex': '\\documentclass{book}\n\\input{intro}\n',
      '/d/fragment.tex': '\\input{intro}\n', // also includes, but no class
    },
    dirs: { '/d': ['intro.tex', 'book.tex', 'fragment.tex'] },
  });
  assert.equal(ev('(reftex-master)'), '/d/book.tex');
});

test('reftex-master falls back to the current file when nothing includes it', async () => {
  const { ev } = await reftexEditor({
    currentFile: '/d/orphan.tex',
    files: { '/d/orphan.tex': '\\section{Orphan}\n' },
    dirs: { '/d': ['orphan.tex'] },
  });
  assert.equal(ev('(reftex-master)'), '/d/orphan.tex');
});

// --- master detection: override + non-tex ------------------------------

test('*reftex-master* overrides auto-detection', async () => {
  const { ev } = await reftexEditor({
    currentFile: '/d/chap.tex',
    files: {
      '/d/chap.tex': '\\documentclass{article}\n', // would self-detect
      '/d/real-master.tex': '\\documentclass{book}\n',
    },
  });
  ev('(custom-apply! (quote *reftex-master*) "real-master.tex")');
  assert.equal(ev('(reftex-master)'), '/d/real-master.tex');
});

test('reftex-master is nil when the current view has no .tex', async () => {
  const { ev } = await reftexEditor({
    currentFile: '/d/notes.md',
    files: { '/d/notes.md': '# notes\n' },
  });
  assert.equal(ev('(nil? (reftex-master))'), true);
});

test('reftex-master is nil when there is no current view', async () => {
  const { ev } = await reftexEditor({ currentFile: null });
  assert.equal(ev('(nil? (reftex-master))'), true);
});

// --- the cached document + accessors -----------------------------------

test('reftex-document builds and caches the document DB', async () => {
  const { ev, arr } = await reftexEditor({
    currentFile: '/d/main.tex',
    files: {
      '/d/main.tex':
        '\\documentclass{book}\n\\section{One}\\label{sec:one}\n\\input{ch}\n',
      '/d/ch.tex': '\\label{eq:x}\n',
    },
  });
  assert.deepEqual(arr('(get (reftex-document) :files nil)'),
    ['/d/main.tex', '/d/ch.tex']);
  // Cached under the master path.
  assert.equal(ev('(contains? *reftex-db-cache* "/d/main.tex")'), true);
});

test('reftex-labels filters by type; reftex-label-names lists names', async () => {
  const { ev, arr } = await reftexEditor({
    currentFile: '/d/main.tex',
    files: {
      '/d/main.tex':
        '\\documentclass{a}\n\\section{S}\\label{sec:s}\n' +
        '\\begin{equation}\\label{eq:e}\\end{equation}\n',
    },
  });
  assert.deepEqual(arr('(reftex-label-names)'), ['sec:s', 'eq:e']);
  assert.deepEqual(
    arr('(map (lambda (l) (get l :name)) (reftex-labels :equation))'),
    ['eq:e']
  );
  assert.deepEqual(
    arr('(map (lambda (l) (get l :name)) (reftex-labels :section))'),
    ['sec:s']
  );
});

test('reftex-find-label returns the record or nil', async () => {
  const { ev } = await reftexEditor({
    currentFile: '/d/main.tex',
    files: { '/d/main.tex': '\\documentclass{a}\n\\label{here}\n' },
  });
  assert.equal(ev('(get (reftex-find-label "here") :file)'), '/d/main.tex');
  assert.equal(ev('(nil? (reftex-find-label "nowhere"))'), true);
});

test('reftex-sections returns the section records in document order', async () => {
  const { arr } = await reftexEditor({
    currentFile: '/d/main.tex',
    files: {
      '/d/main.tex':
        '\\documentclass{a}\n\\chapter{C}\n\\section{S1}\n\\input{ch}\n',
      '/d/ch.tex': '\\section{S2}\n',
    },
  });
  assert.deepEqual(
    arr('(map (lambda (s) (get s :title)) (reftex-sections))'),
    ['C', 'S1', 'S2']
  );
});

// --- bib paths ---------------------------------------------------------

test('the DB :bib collects \\bibliography paths plus *citation-bib-path*', async () => {
  const { ev, arr } = await reftexEditor({
    currentFile: '/d/main.tex',
    files: { '/d/main.tex': '\\documentclass{a}\n\\bibliography{refs,more}\n' },
  });
  ev('(custom-apply! (quote *citation-bib-path*) "/global/lib.bib")');
  // Rebuild so the new setting is reflected.
  ev('(set! *reftex-db-cache* {})');
  assert.deepEqual(arr('(get (reftex-document) :bib nil)'),
    ['refs', 'more', '/global/lib.bib']);
});

// --- the reparse command + master seam ---------------------------------

test('reftex-reparse rebuilds and reports the scan counts', async () => {
  const { ev, statusCalls } = await reftexEditor({
    currentFile: '/d/main.tex',
    files: {
      '/d/main.tex':
        '\\documentclass{a}\n\\label{a}\n\\label{b}\n\\input{ch}\n',
      '/d/ch.tex': '\\label{c}\n',
    },
  });
  ev('(run-command (quote reftex-reparse))');
  assert.equal(statusCalls.at(-1), 'RefTeX: scanned 2 files, 3 labels');
});

test('latex-master-file is redefined to follow the RefTeX master', async () => {
  const { ev } = await reftexEditor({
    currentFile: '/d/intro.tex',
    files: {
      '/d/intro.tex': '\\section{Intro}\n',
      '/d/book.tex': '\\documentclass{book}\n\\input{intro}\n',
    },
    dirs: { '/d': ['intro.tex', 'book.tex'] },
  });
  // latex-compile.lisp's stub returned the current file; the RefTeX
  // redefinition returns the detected master.
  assert.equal(ev('(latex-master-file)'), '/d/book.tex');
});
