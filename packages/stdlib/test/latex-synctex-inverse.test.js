/**
 * @file latex-synctex-inverse.test.js — unit tests for inverse SyncTeX's
 * pane-targeting policy (`-latex-reveal-source` in latex-synctex.lisp).
 *
 * The bug this guards against: an Option-click in the PDF moves focus onto
 * the PDF's pane (the window's capture-phase pane-focus handler runs first),
 * so a naive `open-file-path!` opened the resolved source *in the PDF pane*.
 * The fix targets a source pane explicitly. The four cases:
 *   1. the file is already displayed somewhere -> focus THAT pane;
 *   2. the file is open but not displayed     -> surface it in the source pane;
 *   3. the file isn't open                     -> open it in the source pane;
 *   4. there is no source pane (PDF only)      -> open beside the PDF (split).
 * In every case the PDF's pane must NOT be the landing pane.
 *
 * The harness loads the whole standard library (so latex-synctex.lisp and
 * its latex-compile.lisp helper `-latex-find-view-by-file` are present) and
 * stubs the pane / view / open primitives over a tiny in-memory model that
 * records which pane was focused and what was opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, arrayToList, NIL } from '@editor/lisp';
import { createLatexPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/** A fake leaf pane showing VIEW. */
function leaf(view) {
  return { kind: 'leaf', view };
}
/** A fake view of KIND visiting PATH (a .tex source or the .pdf). */
function view(kind, path) {
  return { kind, path };
}

/**
 * An interpreter with the full stdlib loaded and the pane / view / open
 * primitives backed by a mutable in-memory model. The model exposes the
 * recorded calls so a test can assert the landing pane and what was opened.
 *
 * @param {{panes: object[], views: object[], pdf: string}} model
 */
async function inverseEditor(model) {
  const rec = { focused: [], opened: [], split: [], switched: [], gotos: [] };
  const strOrNil = (s) => (typeof s === 'string' ? s : NIL);
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createLatexPrimitives(),
      // The pane surface inverse search reads.
      'panes-in-spiral-order': () => arrayToList(model.panes),
      'pane-view': (args) => args[0]?.view ?? NIL,
      'view-kind': (args) => strOrNil(args[0]?.kind),
      'view-file-path': (args) => strOrNil(args[0]?.path),
      // No tablines in these fixtures.
      'tabline-tabs': () => NIL,
      'tabline-active': () => NIL,
      'view-list': () => arrayToList(model.views),
      'pdf-current-path': () => strOrNil(model.pdf),
      // The side-effecting verbs, recorded.
      'focus-pane!': (args) => { rec.focused.push(args[0]); return args[0] ?? NIL; },
      'switch-to-view!': (args) => { rec.switched.push(args[0]); return args[0] ?? NIL; },
      'open-file-path!': (args) => { rec.opened.push(String(args[0])); return NIL; },
      'open-file-in-split!': (args) => { rec.split.push(String(args[0])); return NIL; },
      'goto-line!': (args) => { rec.gotos.push(Number(args[0])); return NIL; },
      // The inverse-search landing recenters + flashes the line.
      'recenter!': () => NIL,
      'flash-current-line!': () => NIL,
      'file-exists?': () => true,
      // Stubs the rest of the stdlib touches when loaded.
      'read-file-text!': () => NIL,
      'list-directory-paths': () => NIL,
      'current-view': () => NIL,
      'view-buffer': () => NIL,
      'buffer-text': () => '',
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  const reveal = (file, line) =>
    interpreter.evaluate(`(-latex-reveal-source "${file}" ${line})`);
  return { rec, reveal };
}

test('case 1: file already displayed -> focus that pane, no open', async () => {
  const src = view('text', '/p/main.tex');
  const pdf = view('pdf', '/p/main.pdf');
  const srcPane = leaf(src);
  const pdfPane = leaf(pdf);
  const { rec, reveal } = await inverseEditor({
    panes: [srcPane, pdfPane],
    views: [src, pdf],
    pdf: '/p/main.pdf',
  });
  reveal('/p/main.tex', 12);
  assert.deepEqual(rec.focused, [srcPane], 'focuses the source pane');
  assert.notEqual(rec.focused[0], pdfPane, 'never the PDF pane');
  assert.deepEqual(rec.opened, [], 'opens nothing — the view is already up');
  assert.deepEqual(rec.switched, []);
  assert.deepEqual(rec.gotos, [12]);
});

test('case 2: file open but not displayed -> surface it in the source pane', async () => {
  const src = view('text', '/p/main.tex');
  const pdf = view('pdf', '/p/main.pdf');
  const chapter = view('text', '/p/chapter.tex'); // open, but not in any pane
  const srcPane = leaf(src);
  const pdfPane = leaf(pdf);
  const { rec, reveal } = await inverseEditor({
    panes: [srcPane, pdfPane],
    views: [src, pdf, chapter],
    pdf: '/p/main.pdf',
  });
  reveal('/p/chapter.tex', 7);
  assert.deepEqual(rec.focused, [srcPane], 'lands in the source pane');
  assert.deepEqual(rec.switched, [chapter], 'surfaces the existing view (sync)');
  assert.deepEqual(rec.opened, [], 'no fresh open for an already-open file');
  assert.deepEqual(rec.gotos, [7]);
});

test('case 3: file not open -> open it in the source pane', async () => {
  const src = view('text', '/p/main.tex');
  const pdf = view('pdf', '/p/main.pdf');
  const srcPane = leaf(src);
  const pdfPane = leaf(pdf);
  const { rec, reveal } = await inverseEditor({
    panes: [srcPane, pdfPane],
    views: [src, pdf],
    pdf: '/p/main.pdf',
  });
  reveal('/p/intro.tex', 3);
  assert.deepEqual(rec.focused, [srcPane], 'focuses the source pane first');
  assert.notEqual(rec.focused[0], pdfPane, 'never the PDF pane');
  assert.deepEqual(rec.opened, ['/p/intro.tex'], 'opens the new file there');
  assert.deepEqual(rec.split, [], 'no split — a source pane exists');
  assert.deepEqual(rec.gotos, [3]);
});

test('source pane prefers a .tex text pane over a non-tex text pane', async () => {
  const notes = view('text', '/p/notes.md'); // a text pane, but not .tex
  const src = view('text', '/p/main.tex');
  const pdf = view('pdf', '/p/main.pdf');
  const notesPane = leaf(notes);
  const srcPane = leaf(src);
  const pdfPane = leaf(pdf);
  const { rec, reveal } = await inverseEditor({
    panes: [notesPane, srcPane, pdfPane],
    views: [notes, src, pdf],
    pdf: '/p/main.pdf',
  });
  reveal('/p/intro.tex', 1);
  assert.deepEqual(rec.focused, [srcPane], 'prefers the .tex pane');
});

test('case 4: only the PDF is open -> open the source beside it (split)', async () => {
  const pdf = view('pdf', '/p/main.pdf');
  const pdfPane = leaf(pdf);
  const { rec, reveal } = await inverseEditor({
    panes: [pdfPane],
    views: [pdf],
    pdf: '/p/main.pdf',
  });
  reveal('/p/main.tex', 9);
  assert.deepEqual(rec.focused, [], 'no source pane to focus');
  assert.deepEqual(rec.split, ['/p/main.tex'], 'opens beside the PDF');
  assert.deepEqual(rec.opened, [], 'never clobbers the PDF pane');
  assert.deepEqual(rec.gotos, [9]);
});
