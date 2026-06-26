/**
 * @file End-to-end RefTeX flows through the Model-B spine, server-side.
 *
 * The bar the brief sets: with a real `.tex` + `.bib` in a temp dir, drive
 * the daily RefTeX commands through the REAL spine (the real
 * commands.lisp/editing.lisp + the verbatim cite.lisp / reftex.lisp /
 * reftex-refs.lisp / reftex-cite.lisp + the real run-command), and assert:
 *
 *   - reftex-citation (C-c [) parses the document's bib, opens a PICKER of
 *     formatted cite rows, and a simulated choice inserts `\cite{key}`;
 *   - reftex-reference inserts `\ref{name}` / `\eqref{name}` via the label
 *     DB through a PICKER choice;
 *   - reftex-label inserts a smart `\label{...}` via the minibuffer;
 *   - reftex-reparse scans the multi-file document.
 *
 * All headless (no Electron, no DOM) — the citation bridge imports the real
 * citation.js, the LaTeX scan is the real scanner, file reads hit the temp
 * dir directly (the server is a Node child).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSpine } from './spine.js';

const BIB =
  '@article{smith2020, author = {Smith, John}, title = {A Study of Things}, ' +
  'journal = {Journal of Testing}, year = {2020}, volume = {7}, pages = {1--10}}\n' +
  '@book{jones2018, author = {Jones, Mary}, title = {The Big Book}, ' +
  'publisher = {Test Press}, year = {2018}}\n';

const TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Introduction}',
  '\\label{sec:intro}',
  'Some text.',
  '\\begin{equation}',
  '  E = mc^2 \\label{eq:einstein}',
  '\\end{equation}',
  'More text citing nobody yet. ',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n');

/** A temp dir with doc.tex + refs.bib written; returns their paths. */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mwb-reftex-'));
  const texPath = join(dir, 'doc.tex');
  const bibPath = join(dir, 'refs.bib');
  writeFileSync(texPath, TEX, 'utf8');
  writeFileSync(bibPath, BIB, 'utf8');
  return { dir, texPath, bibPath };
}

/**
 * A spine whose openFile reads from disk, then VISIT the fixture .tex so the
 * active buffer is backed by a real file path (RefTeX's master / bib-path
 * resolution needs it). Records every PICKER request + status the server sees.
 */
function makeRefTeXSpine() {
  const fx = makeFixture();
  const log = { status: [], pickers: [], minibufferOpens: [] };
  const spine = createSpine(
    { initialText: '', name: 'scratch.txt' },
    {
      onStatus: (s) => log.status.push(s),
      onPicker: (req) => log.pickers.push(req),
      onMinibufferOpen: (p) => log.minibufferOpens.push(p),
      openFile: (path) => {
        try {
          const text = readFileSync(path, 'utf8');
          const name = path.split('/').pop();
          return { text, name, path };
        } catch {
          return null;
        }
      },
    }
  );
  // Visit the fixture .tex: the active buffer is now doc.tex (latex-mode,
  // backed by the real path), which is what RefTeX scans + resolves against.
  spine.visitFile(fx.texPath);
  // Put point at the end of the buffer (a realistic "insert a cite where I'm
  // writing" cursor) so an insertion appends, not prepends — visitFile leaves
  // point at 0. M-> = end-of-buffer.
  spine.handleKey('M-greater');
  return { spine, log, fx };
}

test('reftex-reparse scans the document (files + labels) server-side', () => {
  const { spine, log } = makeRefTeXSpine();
  log.status.length = 0;
  spine.runCommand('reftex-reparse');
  const last = log.status.at(-1) ?? '';
  // "RefTeX: scanned 1 file, 2 labels" (sec:intro + eq:einstein).
  assert.match(last, /scanned 1 file/);
  assert.match(last, /2 labels/);
});

test('reftex-citation opens a PICKER of bib entries and inserts \\cite{key}', () => {
  const { spine, log } = makeRefTeXSpine();
  // Move point to a clean spot and remember the text length so we can read
  // back exactly what got inserted.
  const before = spine.buffer.text;

  spine.runCommand('reftex-citation');
  // Step 1: the format menu PICKER.
  assert.equal(log.pickers.length, 1, 'a format-menu picker opened');
  const formatPicker = log.pickers[0];
  assert.match(formatPicker.title, /citation format/i);
  // The default \cite row is present (value is the macro).
  const citeRow = formatPicker.rows.find((r) => r.value === '\\cite');
  assert.ok(citeRow, 'the \\cite format row exists');

  // Choose the \cite format → step 2: the cite-entry PICKER opens.
  assert.ok(spine.deliverPicker(citeRow.value, formatPicker.id));
  assert.equal(log.pickers.length, 2, 'the cite-entry picker opened');
  const entryPicker = log.pickers[1];
  assert.match(entryPicker.title, /choose citation/i);

  // The entry rows carry the bib keys as their value, the author/year/title
  // blob as the filter detail.
  const keys = entryPicker.rows.map((r) => r.value).sort();
  assert.deepEqual(keys, ['jones2018', 'smith2020']);
  const smith = entryPicker.rows.find((r) => r.value === 'smith2020');
  assert.match(smith.detail, /Smith/);
  assert.match(smith.detail, /2020/);

  // Choose smith2020 → \cite{smith2020} is inserted at the origin.
  assert.ok(spine.deliverPicker('smith2020', entryPicker.id));
  assert.equal(spine.buffer.text, `${before}\\cite{smith2020}`);
});

test('reftex-citation with a chosen format inserts that macro', () => {
  const { spine, log } = makeRefTeXSpine();
  const before = spine.buffer.text;
  spine.runCommand('reftex-citation');
  const fmt = log.pickers[0];
  const citep = fmt.rows.find((r) => r.value === '\\citep');
  assert.ok(citep, 'the \\citep format row exists');
  spine.deliverPicker('\\citep', fmt.id);
  const entryPicker = log.pickers[1];
  spine.deliverPicker('jones2018', entryPicker.id);
  assert.equal(spine.buffer.text, `${before}\\citep{jones2018}`);
});

test('reftex-citation: cancelling the format menu inserts nothing', () => {
  const { spine, log } = makeRefTeXSpine();
  const before = spine.buffer.text;
  spine.runCommand('reftex-citation');
  const fmt = log.pickers[0];
  spine.cancelPicker(fmt.id);
  assert.equal(spine.buffer.text, before, 'nothing inserted on cancel');
  assert.equal(log.pickers.length, 1, 'no entry picker opened');
});

test('reftex-reference opens a label PICKER and inserts \\ref / \\eqref', () => {
  const { spine, log } = makeRefTeXSpine();
  const before = spine.buffer.text;

  spine.runCommand('reftex-reference');
  assert.equal(log.pickers.length, 1, 'the *RefTeX Select* picker opened');
  const picker = log.pickers[0];
  assert.match(picker.title, /insert reference/i);

  // Both labels are offered; the equation label carries an "equation" group.
  const names = picker.rows.map((r) => r.value).sort();
  assert.deepEqual(names, ['eq:einstein', 'sec:intro']);
  const eqRow = picker.rows.find((r) => r.value === 'eq:einstein');
  assert.match(eqRow.group, /equation/i);

  // Choose the equation label → \eqref{eq:einstein} (the macro is chosen by
  // the label's type — equations get \eqref).
  assert.ok(spine.deliverPicker('eq:einstein', picker.id));
  assert.equal(spine.buffer.text, `${before}\\eqref{eq:einstein}`);
});

test('reftex-reference on a section label inserts \\ref', () => {
  const { spine, log } = makeRefTeXSpine();
  const before = spine.buffer.text;
  spine.runCommand('reftex-reference');
  const picker = log.pickers[0];
  spine.deliverPicker('sec:intro', picker.id);
  assert.equal(spine.buffer.text, `${before}\\ref{sec:intro}`);
});

test('reftex-reference: cancelling inserts nothing', () => {
  const { spine, log } = makeRefTeXSpine();
  const before = spine.buffer.text;
  spine.runCommand('reftex-reference');
  spine.cancelPicker(log.pickers[0].id);
  assert.equal(spine.buffer.text, before);
});

test('reftex-label inserts a smart \\label{...} via the minibuffer', () => {
  const { spine, log } = makeRefTeXSpine();
  // Put point at end of the section line so the suggested label is section-y.
  // (*reftex-label-confirm* defaults true → it prompts with a suggestion.)
  const before = spine.buffer.text;
  spine.runCommand('reftex-label');
  assert.equal(log.minibufferOpens.length, 1, 'the Label: prompt opened');
  assert.match(log.minibufferOpens[0], /Label:/);

  // Submit an explicit key; reftex-label inserts \label{KEY} at point.
  spine.deliverMinibuffer('my:newlabel');
  assert.equal(spine.buffer.text, `${before}\\label{my:newlabel}`);
});

test('the formatted cite rows come from the real CSL pipeline (sanity)', () => {
  // Prove the bib really parsed + formatted (not a stub): the cite index
  // detail blob carries the title text, which only comes from citation.js.
  const { spine, log } = makeRefTeXSpine();
  spine.runCommand('reftex-citation');
  spine.deliverPicker('\\cite', log.pickers[0].id);
  const rows = log.pickers[1].rows;
  const jones = rows.find((r) => r.value === 'jones2018');
  assert.match(jones.detail, /Big Book/);
  assert.match(jones.detail, /Jones/);
});
