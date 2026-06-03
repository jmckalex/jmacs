/**
 * @file pdf-persist.test.js — the PDF session-persistence surface.
 *
 * PDF views are ephemeral by default; a per-view `persist` flag lets a
 * specific one (the latexed output of a document) survive a relaunch.
 * The host exposes `set-view-persistent!` / `view-persistent?` over a
 * View handle; this file exercises the Lisp that sits on top of them —
 * the `toggle-pdf-persistent` command and the two defcustom defaults
 * (`*pdf-restore-default*` #f, `*latex-pdf-restore*` #t).
 *
 * The two persist primitives live in app.js (they need the live view
 * list + the session controller), so here they are stubbed against the
 * `persist` field of real `createView` handles — the same field
 * `viewToBlob` reads. `current-view` / `view-kind` / `view-name-of`
 * come from the real `createViewPrimitives`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, NIL } from '@editor/lisp';
import { createView } from '@editor/view';
import { createViewPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/**
 * Build an interpreter with the full stdlib loaded and a single-view
 * registry whose current view is CURRENT (a View handle). The persist
 * primitives are stubbed to read/write `view.persist`, mirroring the
 * real host primitives. Returns `{ ev, status, view }` where `status`
 * collects every `show-status!` message and `view` is the current view.
 */
async function persistEditor(view) {
  const status = [];
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createViewPrimitives({
        currentView: () => view,
        viewList: () => [view],
        switchToView: () => view,
        killView: () => {},
        newView: () => view,
        nextView: () => view,
        previousView: () => view,
        findViewByName: (name) => (view && view.name === name ? view : null),
        listViewRecords: () => [],
      }),
      // app.js-only persist primitives, stubbed over the view's field.
      'set-view-persistent!': (args) => {
        const v = args[0];
        const on = args[1] !== false;
        if (v && typeof v === 'object') v.persist = on;
        return on;
      },
      'view-persistent?': (args) => {
        const v = args[0];
        return !!(v && typeof v === 'object' && v.persist === true);
      },
      // Stubs the nav/compile stdlib touches at load.
      'read-file-text!': () => NIL,
      'file-exists?': () => false,
      'list-directory-paths': () => NIL,
      'view-file-path': () => NIL,
      'view-buffer': () => NIL,
      'buffer-text': () => '',
      'show-status!': (args) => {
        status.push(String(args[0] ?? ''));
        return NIL;
      },
      'clear-status!': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  return { interpreter, ev: (s) => interpreter.evaluate(s), status, view };
}

// --- defcustom defaults -------------------------------------------------

test('*pdf-restore-default* defaults to #f (generic PDFs are transient)', async () => {
  const { ev } = await persistEditor(createView({ kind: 'pdf', name: 'x.pdf' }));
  assert.equal(ev('*pdf-restore-default*'), false);
});

test('*latex-pdf-restore* defaults to #t (latex output is restored)', async () => {
  const { ev } = await persistEditor(createView({ kind: 'pdf', name: 'x.pdf' }));
  assert.equal(ev('*latex-pdf-restore*'), true);
});

// --- set-view-persistent! / view-persistent? round-trip -----------------

test('view-persistent? is #f for a freshly created pdf view', async () => {
  const view = createView({ kind: 'pdf', name: 'fresh.pdf' });
  const { ev } = await persistEditor(view);
  assert.equal(ev('(view-persistent? (current-view))'), false);
});

test('set-view-persistent! flips the flag and view-persistent? reads it back', async () => {
  const view = createView({ kind: 'pdf', name: 'doc.pdf' });
  const { ev } = await persistEditor(view);
  ev('(set-view-persistent! (current-view) #t)');
  assert.equal(view.persist, true);
  assert.equal(ev('(view-persistent? (current-view))'), true);
  ev('(set-view-persistent! (current-view) #f)');
  assert.equal(view.persist, false);
  assert.equal(ev('(view-persistent? (current-view))'), false);
});

// --- toggle-pdf-persistent ----------------------------------------------

test('toggle-pdf-persistent flips a pdf view on, then off', async () => {
  const view = createView({ kind: 'pdf', name: 'paper.pdf' });
  const { ev, status } = await persistEditor(view);
  ev('(toggle-pdf-persistent)');
  assert.equal(view.persist, true);
  assert.match(status.at(-1), /will be restored/);
  ev('(toggle-pdf-persistent)');
  assert.equal(view.persist, false);
  assert.match(status.at(-1), /will NOT be restored/);
});

test('toggle-pdf-persistent is a no-op (status note) on a non-pdf view', async () => {
  const view = createView({ kind: 'text', name: 'notes.txt' });
  const { ev, status } = await persistEditor(view);
  ev('(toggle-pdf-persistent)');
  assert.equal(view.persist, false);
  assert.match(status.at(-1), /not a PDF/);
});

test('toggle-pdf-persistent and the persist commands are registered', async () => {
  const { ev } = await persistEditor(createView({ kind: 'pdf', name: 'x.pdf' }));
  assert.equal(ev("(command-registered? 'toggle-pdf-persistent)"), true);
});
