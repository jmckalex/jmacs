/**
 * @file jmarkdown-auctex.test.js — the JMarkdown authoring layer
 * (jmarkdown-compile / -insert / -nav / -ref + the languages/jmarkdown.lisp
 * keymap & menu wiring).
 *
 * The full stdlib + the jmarkdown language file are loaded over a REAL L2
 * buffer (`createBufferPrimitives`), with the spine-only primitives the
 * commands touch (run-process!, open-completing-minibuffer!, citation-*, …)
 * stubbed. Pure helpers are exercised directly; the completing commands are
 * exercised by calling the command (which opens the minibuffer + installs
 * `*minibuffer-reader*`) and then invoking that reader with a chosen value —
 * the same round-trip the host drives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { createInterpreter, NIL, listToArray } from '@editor/lisp';
import { createBufferPrimitives, createLatexPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/** An interpreter with the whole stdlib + jmarkdown language file over a real
 *  buffer; spine-only primitives stubbed. `lastPrompt` records the most recent
 *  minibuffer prompt so tests can assert a command opened one. */
async function auctexEditor(initialText = '') {
  const buffer = createBuffer(initialText, { name: 'doc.jmd' });
  const session = { current: buffer };
  const state = { lastPrompt: null, lastSeed: null, process: null };
  const interp = createInterpreter({
    write: () => {},
    primitives: {
      ...createLatexPrimitives(),
      'read-file-text!': () => '@book{Lewis:1969, author={Lewis}, year={1969}, title={Convention}}',
      'file-exists?': () => true,
      'list-directory-paths': () => NIL,
      'view-list': () => NIL,
      'view-file-path': () => '/docs/doc.jmd',
      'view-directory': () => '/docs',
      'view-buffer': () => NIL,
      'current-view': () => NIL,
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
      'recenter!': () => NIL,
      'save-buffer!': () => NIL,
      'open-completing-minibuffer!': (args) => {
        state.lastPrompt = String(args[0] ?? '');
        state.lastSeed = args.length > 1 ? String(args[1] ?? '') : '';
        return NIL;
      },
      'open-minibuffer!': () => NIL,
      'run-process!': (args) => { state.process = args; return 'run-1'; },
      'utility-output-set': () => NIL,
      'utility-panel-activate!': () => NIL,
      'open-file-in-split!': () => NIL,
      'pdf-reload!': () => NIL,
      'open-file-path!': () => NIL,
      'goto-line!': () => NIL,
      'path-basename': (a) => String(a[0]).split('/').pop(),
      'path-dirname': (a) => { const p = String(a[0]); const i = p.lastIndexOf('/'); return i < 0 ? '.' : p.slice(0, i); },
      'path-resolve': (a) => `${a[0]}/${a[1]}`,
      // citation bridge stubs — return one entry so the cite picker proceeds.
      'citation-parse-lenient': () => interp.evaluate('(hash-map :handle "H" :skipped 0)'),
      'citation-entries': () =>
        interp.evaluate('(list (hash-map :key "Lewis:1969" :author "Lewis" :year 1969 :title "Convention"))'),
      ...createBufferPrimitives(session),
    },
  });
  await loadStdlib(interp, (n) => readFile(join(lispDir, n), 'utf8'),
    { listLanguageFiles: () => ['jmarkdown.lisp'] });
  const ev = (s) => interp.evaluate(s);
  return { buffer, ev, state };
}

// --- compile: pure helpers -----------------------------------------------

test('compile: artifact paths per format', async () => {
  const { ev } = await auctexEditor();
  assert.equal(ev('(-jmd-swap-ext "foo.jmd" ".html")'), 'foo.html');
  assert.equal(ev('(-jmd-artifact-path "/a/doc.jmd" (quote latex))'), '/a/doc.tex');
  assert.equal(ev('(-jmd-artifact-path "/a/doc.jmd" (quote pdf))'), '/a/doc.pdf');
  assert.equal(ev('(-jmd-artifact-path "/a/doc.jmd" (quote html))'), '/a/doc.html');
  // A dot in a directory name must not be mistaken for the extension dot.
  assert.equal(ev('(-jmd-artifact-path "/a.b/doc" (quote html))'), '/a.b/doc.html');
});

test('compile: log parsing classifies warnings and failures', async () => {
  const { ev } = await auctexEditor();
  assert.equal(ev('(length (-jmd-log-diags "" #t))'), 1, 'a failed build with no output is one error');
  assert.equal(ev('(length (-jmd-log-diags "ok\\nWarning: unresolved reference (x)\\nplain" #f))'), 1);
  assert.equal(ev('(eq? (-jmd-format-symbol "pdf") (quote pdf))'), true);
  assert.equal(ev('(eq? (-jmd-format-symbol "zzz") (quote html))'), true, 'unknown → html');
});

test('compile: commands registered + C-c C-c bound', async () => {
  const { ev } = await auctexEditor();
  for (const c of ['jmarkdown-compile', 'jmarkdown-view-output', 'jmarkdown-next-error',
    'jmarkdown-show-output', 'jmarkdown-compile-html', 'jmarkdown-compile-latex', 'jmarkdown-compile-pdf'])
    assert.equal(ev(`(command-registered? (quote ${c}))`), true, `${c} registered`);
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") "C-c") 'jmarkdown-compile)`), true);
});

test('compile: jmarkdown-compile-html spawns the jmarkdown CLI', async () => {
  const { ev, state } = await auctexEditor('# Hi\n');
  ev('(jmarkdown-compile-html)');
  assert.ok(state.process, 'a process was spawned');
  assert.equal(state.process[0], 'jmarkdown', 'program is jmarkdown');
  const args = listToArray(state.process[1]).map(String);
  assert.deepEqual(args, ['process', 'doc.jmd'], 'process <basename>');
});

// --- insert: templates + candidates + completion -------------------------

test('insert: env templates place cursor + id per kind', async () => {
  const { ev } = await auctexEditor();
  assert.match(ev('(-jmarkdown-env-template "theorem" "" "")'), /@begin\(theorem\)\{id=thm:\}/);
  assert.match(ev('(-jmarkdown-env-template "figure" "" "")'), /@begin\(figure\)\[.*\]\{id=fig:.*\}/s);
  assert.match(ev('(-jmarkdown-env-template "abstract" "" "")'), /@begin\(abstract\)\n {2}.*\n@end\(abstract\)/s);
  assert.equal(ev('(-jmarkdown-id-prefix "corollary")'), 'cor:');
  // a wrapped region keeps the body and stays referenceable
  assert.match(ev('(-jmarkdown-env-template "theorem" "" "P=NP")'), /@begin\(theorem\)\{id=thm:\}\n {2}P=NP/);
});

test('insert: env/directive candidates merge static + buffer scan', async () => {
  const { ev } = await auctexEditor();
  const envs = listToArray(ev('(-jmarkdown-env-candidates "text @begin(myenv) @begin(theorem)")')).map(String);
  assert.ok(envs.includes('theorem') && envs.includes('myenv'));
  const dirs = listToArray(ev('(-jmarkdown-scan-directive-names ":::note\\n:::\\n::::markdown-demo")')).map(String);
  assert.deepEqual(dirs, ['note', 'markdown-demo']);
});

test('insert: table skeleton has header, separator, body rows', async () => {
  const { ev } = await auctexEditor();
  const t = ev('(-jmarkdown-table-skeleton 2 3)');
  const lines = t.split('\n');
  assert.equal(lines.length, 4, 'header + separator + 2 body rows');
  assert.equal(lines[1], '| --- | --- | --- |');
  assert.equal((lines[0].match(/\|/g) || []).length, 4, '3 columns');
});

test('insert: jmarkdown-environment inserts the chosen env via the reader', async () => {
  const { buffer, ev, state } = await auctexEditor('');
  ev('(jmarkdown-environment)');
  assert.equal(state.lastPrompt, 'Environment: ', 'opened the environment prompt');
  ev('(*minibuffer-reader* "theorem")'); // simulate the submit
  assert.match(buffer.text, /@begin\(theorem\)\{id=thm:\}[\s\S]*@end\(theorem\)/);
});

test('insert: jmarkdown-insert-section makes a heading', async () => {
  const { buffer, ev } = await auctexEditor('');
  ev('(jmarkdown-insert-section)');
  ev('(*minibuffer-reader* "3")');
  assert.equal(buffer.text, '### ');
});

test('insert: wiring — C-c C-e/C-m/C-s + font sub-map + M-enter', async () => {
  const { ev } = await auctexEditor();
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") "C-e") 'jmarkdown-environment)`), true);
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") "C-m") 'jmarkdown-directive)`), true);
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") "C-s") 'jmarkdown-insert-section)`), true);
  assert.equal(ev(`(map? (get (get jmarkdown-mode-map "C-c") "C-f"))`), true);
  assert.equal(ev(`(eq? (get (get (get jmarkdown-mode-map "C-c") "C-f") "e") 'jmarkdown-intense)`), true);
  assert.equal(ev(`(eq? (get jmarkdown-mode-map "M-enter") 'jmarkdown-insert-item)`), true);
  // existing quick commands and single-letter keys are preserved
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") "@") 'jmarkdown-insert-environment)`), true);
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") "b") 'markdown-bold)`), true);
});

// --- nav: pure finders + real motion -------------------------------------

test('nav: heading offsets + next/previous', async () => {
  const { ev } = await auctexEditor();
  const t = '# A\\ntext\\n## B\\n### C\\n';
  assert.deepEqual(listToArray(ev(`(-jmnav-heading-offsets "${t}")`)), [0, 9, 14]);
  assert.equal(ev(`(-jmnav-first-greater (-jmnav-heading-offsets "${t}") 0)`), 9);
  assert.equal(ev(`(-jmnav-last-less (-jmnav-heading-offsets "${t}") 13)`), 9);
});

test('nav: @begin/@end matching is nesting-aware', async () => {
  const { ev } = await auctexEditor();
  const t = '@begin(theorem)\\nx\\n@begin(proof)\\ny\\n@end(proof)\\n@end(theorem)\\n';
  // from inside the outer @begin (offset 3), the match is the OUTER @end.
  const outer = ev(`(-jmnav-match-offset "${t}" 3)`);
  assert.ok(outer > ev(`(string-index-of "${t}" "@end(proof)")`), 'skips the nested proof');
});

test('nav: insert-item continues lists (repeat/increment) and plain lines', async () => {
  const { ev } = await auctexEditor();
  assert.equal(ev('(-jmnav-item-prefix "- foo")'), '- ');
  assert.equal(ev('(-jmnav-item-prefix "  3. bar")'), '  4. ');
  assert.equal(ev('(-jmnav-item-prefix "b) baz")'), 'c) ');
  assert.equal(ev('(-jmnav-item-prefix "  just prose")'), '  ');
});

test('nav: jmarkdown-insert-item inserts a continuation', async () => {
  const { buffer, ev } = await auctexEditor('- one');
  ev('(goto! 5)');
  ev('(jmarkdown-insert-item)');
  assert.equal(buffer.text, '- one\n- ');
});

test('nav: TOC entries indent by level', async () => {
  const { ev } = await auctexEditor();
  assert.equal(ev('(length (-jmnav-toc-entries "# A\\n## B\\n"))'), 2);
  assert.equal(ev('(cdr (car (cdr (-jmnav-toc-entries "# A\\n## B\\n"))))'), '  B');
});

// --- ref: scanning + suggestion + bib detection + insertion --------------

test('ref: label universe = :label[] keys + id= values', async () => {
  const { ev } = await auctexEditor();
  const keys = listToArray(ev('(-jmref-label-keys ":label[sec:a] {id=fig:x width=1} {id=\\"tab:y\\"}")')).map(String);
  assert.deepEqual(keys, ['sec:a', 'fig:x', 'tab:y']);
});

test('ref: key suggestion slugs the heading + uniquifies', async () => {
  const { ev } = await auctexEditor();
  assert.equal(ev('(-jmref-slug "The Big, Bold Idea!")'), 'the-big-bold-idea');
  assert.equal(ev('(-jmref-suggest-key "## The Big Idea\\n" 3)'), 'sec:the-big-idea');
  assert.equal(ev('(-jmref-uniquify "x" (list "x" "x-2"))'), 'x-3');
});

test('ref: bibliography detected from front-matter (bare + yaml)', async () => {
  const { ev } = await auctexEditor();
  assert.equal(ev('(-jmref-bib-declaration "Title: T\\nBibliography: refs.bib\\n")'), 'refs.bib');
  assert.equal(ev('(-jmref-bib-declaration "---\\nbibliography: ./b/x.bib\\n---\\n")'), './b/x.bib');
  assert.equal(ev('(if (nil? (-jmref-bib-declaration "no header")) #t #f)'), true);
});

test('ref: jmarkdown-label appends :label[] on a heading line', async () => {
  const { buffer, ev } = await auctexEditor('## Intro\n');
  ev('(goto! 4)'); // inside the heading
  ev('(jmarkdown-label)');
  ev('(*minibuffer-reader* "sec:intro")');
  assert.equal(buffer.text, '## Intro :label[sec:intro]\n');
});

test('ref: jmarkdown-reference inserts :cref via the two-step reader', async () => {
  const { buffer, ev } = await auctexEditor('see  \n:label[sec:x]\n');
  ev('(goto! 4)');
  ev('(jmarkdown-reference)');
  ev('(*minibuffer-reader* "sec:x")'); // choose the key
  ev('(*minibuffer-reader* "cref")'); // choose the form
  assert.match(buffer.text, /:cref\[sec:x\]/);
});

test('ref: jmarkdown-citation inserts \\citep from the .bib entry', async () => {
  // Harness: front-matter names refs.bib; file-exists?/read-file-text! and the
  // citation-* stubs supply one entry keyed Lewis:1969.
  const { buffer, ev } = await auctexEditor('Bibliography: refs.bib\n\nAs argued \n');
  ev('(goto! (- (buffer-length) 1))');
  ev('(jmarkdown-citation)');
  // The command built the display-label list; submit the (only) entry.
  ev('(*minibuffer-reader* (car *jmarkdown-insert-candidates*))');
  assert.match(buffer.text, /\\citep\{Lewis:1969\}/);
});

test('ref: wiring — C-c ( ) [ = / bound', async () => {
  const { ev } = await auctexEditor();
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") "(") 'jmarkdown-label)`), true);
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") ")") 'jmarkdown-reference)`), true);
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") "[") 'jmarkdown-citation)`), true);
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") "=") 'jmarkdown-toc)`), true);
  assert.equal(ev(`(eq? (get (get jmarkdown-mode-map "C-c") "/") 'jmarkdown-index)`), true);
});

// --- the mode menu -------------------------------------------------------

// --- review regressions --------------------------------------------------

test('regression: -jmref-entry-label survives a nil author/year (no crash)', async () => {
  const { ev } = await auctexEditor();
  // author-less @manual/@misc entries store :author = nil; must not (string=? nil "").
  assert.equal(ev('(-jmref-entry-label (hash-map :key "GnuMake" :author nil :year nil))'), 'GnuMake');
  assert.equal(ev('(-jmref-entry-label (hash-map :key "K" :author "A" :year 1999))'), 'K — A (1999)');
});

test('regression: -jmref-scan-ids ignores grid=/uuid=/url id= tails', async () => {
  const { ev } = await auctexEditor();
  const ids = listToArray(ev('(-jmref-scan-ids "grid=x {id=fig:a} valid=1 http://h?id=zzz")')).map(String);
  assert.deepEqual(ids, ['fig:a'], 'only the real {id=…} attribute');
});

test('regression: compile parses a path:line: diagnostic (and jumps)', async () => {
  const { ev } = await auctexEditor();
  assert.equal(ev('(get (-jmd-parse-location "src/doc.jmd:12: bad") :line nil)'), 12);
  assert.equal(ev('(get (-jmd-parse-location "src/doc.jmd:12: bad") :file nil)'), 'src/doc.jmd');
  assert.equal(ev('(if (nil? (-jmd-parse-location "Warning: unresolved ref")) #t #f)'), true,
    'a Warning: line (no digits) is not a location');
});

test('regression: dotfile has no extension mistaken', async () => {
  const { ev } = await auctexEditor();
  assert.equal(ev('(-jmd-swap-ext ".bashrc" ".html")'), '.bashrc.html');
  assert.equal(ev('(-jmd-swap-ext "/a/.hidden" ".html")'), '/a/.hidden.html');
});

test('regression: target/source use the correct JMarkdown syntax', async () => {
  const { buffer, ev } = await auctexEditor('');
  ev('(jmarkdown-insert-target)');
  assert.equal(buffer.text, ':target[]', 'inline :target[id], not a :::target container');
  ev('(set-buffer-text! "")');
  ev('(goto! 0)');
  ev('(jmarkdown-insert-source)');
  assert.match(buffer.text, /:::source\{target="/, 'source uses target= not key=');
});

test('menu: JMarkdown menu carries the new groups', async () => {
  const { ev } = await auctexEditor();
  const sections = listToArray(ev('(map car (get *mode-menu-sections* "JMarkdown"))')).map(String);
  for (const s of ['Compile & View', 'Insert', 'Insert Block', 'References', 'Navigate'])
    assert.ok(sections.includes(s), `menu has a "${s}" section`);
});
