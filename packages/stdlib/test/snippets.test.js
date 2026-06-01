/**
 * @file Tests for the snippet engine (snippets-parser.lisp,
 * snippets.lisp, snippets-keymap.lisp).
 *
 * The parser tests load just `snippets-parser.lisp` into a bare
 * interpreter — it is pure data-in / data-out, so no buffer or host
 * stubs are needed. The engine and navigation tests load the full
 * standard library against a live buffer with the snippet host
 * primitives stubbed (a fake snippet filesystem).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import {
  arrayToList,
  cons,
  createInterpreter,
  keyword,
  listToArray,
  NIL,
} from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');
const languagesDir = join(lispDir, 'languages');

// --- parser-only harness -------------------------------------------------

/** A bare interpreter with only the snippet parser loaded. */
function parserInterp() {
  const interp = createInterpreter({ write: () => {} });
  interp.evaluate(readFileSync(join(lispDir, 'snippets-parser.lisp'), 'utf8'));
  return interp;
}

const kw = (map, name) => map.get(keyword(name));

/** Read a parsed-body field list into plain JS objects. */
function fieldsOf(interp, bindingExpr) {
  return listToArray(interp.evaluate(`(get ${bindingExpr} :fields nil)`)).map(
    (f) => ({
      index: kw(f, 'index'),
      start: kw(f, 'start'),
      end: kw(f, 'end'),
      default: kw(f, 'default'),
    })
  );
}

function mirrorsOf(interp, bindingExpr) {
  return listToArray(interp.evaluate(`(get ${bindingExpr} :mirrors nil)`)).map(
    (m) => ({ index: kw(m, 'index'), start: kw(m, 'start'), end: kw(m, 'end') })
  );
}

// --- parser: file format -------------------------------------------------

test('parse-snippet-file reads the yasnippet header and body', () => {
  const interp = parserInterp();
  interp.evaluate(
    '(define f (parse-snippet-file ' +
      '"# -*- mode: snippet -*-\n# key: for\n# name: for-loop\n' +
      '# group: control-flow\n# --\nfor (x) {}\n"))'
  );
  assert.equal(interp.evaluate('(get f :key nil)'), 'for');
  assert.equal(interp.evaluate('(get f :name nil)'), 'for-loop');
  assert.equal(interp.evaluate('(get f :group nil)'), 'control-flow');
  assert.equal(interp.evaluate('(get f :body nil)'), 'for (x) {}\n');
});

test('parse-snippet-file tolerates a file with no header block', () => {
  const interp = parserInterp();
  interp.evaluate('(define f (parse-snippet-file "just a body\nline two"))');
  assert.equal(interp.evaluate('(get f :key nil)'), NIL);
  assert.equal(interp.evaluate('(get f :body nil)'), 'just a body\nline two');
});

test('parse-snippet-file keeps a body that itself contains "#" lines', () => {
  const interp = parserInterp();
  interp.evaluate(
    '(define f (parse-snippet-file "# key: sh\n# --\n#!/bin/sh\necho hi"))'
  );
  assert.equal(interp.evaluate('(get f :key nil)'), 'sh');
  assert.equal(interp.evaluate('(get f :body nil)'), '#!/bin/sh\necho hi');
});

// --- parser: body / tab stops --------------------------------------------

test('parse-snippet-body resolves defaults into the inserted text', () => {
  const interp = parserInterp();
  interp.evaluate(
    '(define b (parse-snippet-body "for (${1:i} = 0; $1 < ${2:n}) {\n  $0\n}"))'
  );
  assert.equal(
    interp.evaluate('(get b :text nil)'),
    'for (i = 0; i < n) {\n  \n}'
  );
});

test('parse-snippet-body sorts fields by tab index with correct ranges', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "${2:b}-${1:a}-${3:c}"))');
  // text is "b-a-c"
  assert.equal(interp.evaluate('(get b :text nil)'), 'b-a-c');
  const fields = fieldsOf(interp, 'b');
  assert.deepEqual(
    fields.map((f) => f.index),
    [1, 2, 3]
  );
  // field 1 ('a') sits at offset 2..3, field 2 ('b') at 0..1, 3 ('c') 4..5.
  const byIndex = Object.fromEntries(fields.map((f) => [f.index, f]));
  assert.deepEqual(
    [byIndex[1].start, byIndex[1].end, byIndex[1].default],
    [2, 3, 'a']
  );
  assert.deepEqual(
    [byIndex[2].start, byIndex[2].end, byIndex[2].default],
    [0, 1, 'b']
  );
});

test('parse-snippet-body records the $0 exit position', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "abc$0def"))');
  assert.equal(interp.evaluate('(get b :text nil)'), 'abcdef');
  assert.equal(interp.evaluate('(get b :exit nil)'), 3);
});

test('parse-snippet-body defaults the exit to text end when no $0', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "hello ${1:world}"))');
  assert.equal(interp.evaluate('(get b :exit nil)'), 11);
});

test('parse-snippet-body resolves a bare $N to an empty default', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "x$1y"))');
  assert.equal(interp.evaluate('(get b :text nil)'), 'xy');
  const fields = fieldsOf(interp, 'b');
  assert.equal(fields.length, 1);
  assert.deepEqual([fields[0].start, fields[0].end], [1, 1]);
});

test('parse-snippet-body treats $$ as a literal dollar', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "cost: $$5"))');
  assert.equal(interp.evaluate('(get b :text nil)'), 'cost: $5');
  assert.equal(listToArray(interp.evaluate('(get b :fields nil)')).length, 0);
});

test('parse-snippet-body records mirrors of a repeated index', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "${1:x} and $1 and $1"))');
  // text: "x and x and x"
  assert.equal(interp.evaluate('(get b :text nil)'), 'x and x and x');
  const fields = fieldsOf(interp, 'b');
  assert.equal(fields.length, 1);
  // The canonical field is the one carrying the default (offset 0..1).
  assert.deepEqual([fields[0].start, fields[0].end], [0, 1]);
  const mirrors = mirrorsOf(interp, 'b');
  assert.equal(mirrors.length, 2);
  assert.deepEqual(
    mirrors.map((m) => m.start).sort((a, b) => a - b),
    [6, 12]
  );
});

test('a default declared at a later occurrence fills every occurrence', () => {
  const interp = parserInterp();
  // bare $1 occurs first, the default-bearing ${1:v} second. Both render
  // the resolved default "v"; the first occurrence is canonical (where
  // point lands), the second is a mirror.
  interp.evaluate('(define b (parse-snippet-body "$1 then ${1:v}"))');
  assert.equal(interp.evaluate('(get b :text nil)'), 'v then v');
  const fields = fieldsOf(interp, 'b');
  assert.equal(fields.length, 1);
  assert.equal(fields[0].default, 'v');
  // The canonical field is the first occurrence, at offset 0..1.
  assert.deepEqual([fields[0].start, fields[0].end], [0, 1]);
  const mirrors = mirrorsOf(interp, 'b');
  assert.equal(mirrors.length, 1);
  assert.deepEqual([mirrors[0].start, mirrors[0].end], [7, 8]);
});

// --- engine harness ------------------------------------------------------

/**
 * Build an interpreter with the full standard library loaded against a
 * live buffer and a fake snippet filesystem.
 *
 * @param {object} [options]
 * @param {string} [options.name] - Buffer name (drives the major mode by
 *   suffix; e.g. `f.js` -> js-mode, `notes.txt` -> fundamental-mode).
 * @param {string} [options.text] - Initial buffer text.
 * @param {string} [options.userRoot] - The value `snippet-user-directory`
 *   returns. Empty string (the default) means "no user directory" — only
 *   the built-in starter set is available.
 * @param {Record<string, Array<[string, 'file'|'directory']>>} [options.dirs]
 *   - Fake directory listings keyed by absolute path.
 * @param {Record<string, string>} [options.files] - Fake file contents
 *   keyed by absolute path.
 */
async function engine(options = {}) {
  const buffer = createBuffer(options.text ?? '', {
    name: options.name ?? 'notes.txt',
  });
  const dirs = options.dirs ?? {};
  const files = options.files ?? {};
  const status = [];
  const interp = createInterpreter({
    write: () => {},
    primitives: {
      ...createBufferPrimitives({ current: buffer }),
      'show-status!': (a) => {
        status.push(String(a[0] ?? ''));
        return NIL;
      },
      'clear-status!': () => NIL,
      'snippet-user-directory': () => options.userRoot ?? '',
      'list-directory-paths': (a) => {
        const entries = dirs[String(a[0] ?? '')];
        if (entries === undefined) return NIL;
        return arrayToList(
          entries.map(([n, t]) => cons(n, keyword(t)))
        );
      },
      'read-file-text!': (a) => {
        const text = files[String(a[0] ?? '')];
        return text === undefined ? NIL : text;
      },
      'snippet-date-string': (a) => {
        const kind = String(a[0] ?? '');
        if (kind === 'year') return '2026';
        if (kind === 'datetime') return '2026-06-01 12:00';
        return '2026-06-01';
      },
    },
  });
  await loadStdlib(interp, (n) => readFile(join(lispDir, n), 'utf8'), {
    listLanguageFiles: async () =>
      (await readdir(languagesDir)).filter((n) => n.endsWith('.lisp')),
  });
  // Choose the major mode from the buffer name, as the app does on open.
  interp.evaluate('(choose-major-mode!)');
  return { buffer, interp, status };
}

const press = (interp, key) => interp.call('handle-key', key);

/** Press a sequence of single-character keys, reflowing after each so the
 *  active field tracks the edit (the host calls snippet-after-edit! on
 *  every buffer change). */
function type(interp, text) {
  for (const ch of text) {
    press(interp, ch);
    interp.evaluate('(snippet-after-edit!)');
  }
}

// --- engine: built-in expansion -----------------------------------------

test('a built-in snippet expands on M-x snippet-expand', async () => {
  const { buffer, interp } = await engine({ name: 'notes.txt', text: 'todo' });
  buffer.moveTo(4);
  interp.call('snippet-expand');
  assert.ok(
    buffer.text.startsWith('TODO('),
    `expected TODO body; got ${JSON.stringify(buffer.text)}`
  );
});

test('the TAB trigger expands the word before point', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  buffer.insert('for'); // point now at 3
  press(interp, 'tab');
  assert.ok(
    buffer.text.startsWith('for (let i = 0;'),
    `expected for-loop; got ${JSON.stringify(buffer.text)}`
  );
});

test('TAB with no trigger word falls through to insert-tab', async () => {
  const { buffer, interp } = await engine({ name: 'notes.txt', text: '' });
  buffer.moveTo(0);
  press(interp, 'tab');
  // *tab-width* defaults to 4 spaces, *indent-tabs-mode* off.
  assert.equal(buffer.text, '    ');
});

test('TAB after a non-trigger word falls through to insert-tab', async () => {
  const { buffer, interp } = await engine({ name: 'notes.txt', text: '' });
  buffer.insert('zzznotatrigger');
  press(interp, 'tab');
  assert.ok(
    buffer.text.endsWith('    '),
    `expected trailing spaces; got ${JSON.stringify(buffer.text)}`
  );
});

test('*snippet-expand-key* set to nil disables the TAB trigger', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  interp.evaluate('(set! *snippet-expand-key* nil)');
  buffer.insert('for');
  press(interp, 'tab');
  // No expansion — just the trigger word plus indent spaces.
  assert.equal(buffer.text, 'for    ');
  assert.equal(interp.evaluate('(snippet-active?)'), false);
});

// --- engine: field navigation -------------------------------------------

test('expanding selects the first field default so typing replaces it', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  buffer.insert('for');
  press(interp, 'tab');
  // Field 1 default "i" is selected.
  const sel = buffer.selection;
  assert.ok(sel, 'expected an active selection on the first field');
  assert.equal(buffer.text.slice(sel.start, sel.end), 'i');
  assert.equal(interp.evaluate('(snippet-modeline-indicator)'), '[snippet: 1/2]');
});

test('typing replaces the selected default and reflows later fields', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  buffer.insert('for');
  press(interp, 'tab');
  type(interp, 'idx');
  assert.ok(
    buffer.text.startsWith('for (let idx = 0;'),
    `expected field 1 replaced; got ${JSON.stringify(buffer.text)}`
  );
  // TAB to field 2 ("n") and confirm it is the selected text.
  press(interp, 'tab');
  const sel = buffer.selection;
  assert.equal(buffer.text.slice(sel.start, sel.end), 'n');
  assert.equal(interp.evaluate('(snippet-modeline-indicator)'), '[snippet: 2/2]');
});

test('TAB on the last field commits and clears the active snippet', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  buffer.insert('for');
  press(interp, 'tab'); // field 1
  press(interp, 'tab'); // field 2
  press(interp, 'tab'); // commit
  assert.equal(interp.evaluate('(snippet-active?)'), false);
  assert.equal(interp.evaluate('(snippet-modeline-indicator)'), '');
});

test('S-TAB steps back to the previous field', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  buffer.insert('for');
  press(interp, 'tab'); // field 1
  press(interp, 'tab'); // field 2
  assert.equal(interp.evaluate('(snippet-modeline-indicator)'), '[snippet: 2/2]');
  press(interp, 'S-tab'); // back to field 1
  assert.equal(interp.evaluate('(snippet-modeline-indicator)'), '[snippet: 1/2]');
  const sel = buffer.selection;
  assert.equal(buffer.text.slice(sel.start, sel.end), 'i');
});

test('S-TAB on the first field does not wrap or commit', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  buffer.insert('for');
  press(interp, 'tab'); // field 1
  press(interp, 'S-tab'); // no-op (already first)
  assert.equal(interp.evaluate('(snippet-active?)'), true);
  assert.equal(interp.evaluate('(snippet-modeline-indicator)'), '[snippet: 1/2]');
});

test('ESC cancels the active snippet, leaving the inserted text', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  buffer.insert('for');
  press(interp, 'tab');
  const textBefore = buffer.text;
  press(interp, 'escape');
  assert.equal(interp.evaluate('(snippet-active?)'), false);
  assert.equal(buffer.text, textBefore, 'cancel keeps the inserted text');
});

test('C-g cancels the active snippet', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  buffer.insert('for');
  press(interp, 'tab');
  press(interp, 'C-g');
  assert.equal(interp.evaluate('(snippet-active?)'), false);
});

test('a static (field-less) snippet commits immediately at the exit', async () => {
  const { buffer, interp } = await engine({ name: 'notes.txt', text: 'date' });
  buffer.moveTo(4);
  interp.call('snippet-expand');
  // `date` expands to the stubbed date string, no fields.
  assert.equal(buffer.text, '2026-06-01');
  assert.equal(interp.evaluate('(snippet-active?)'), false);
});

// --- engine: mode resolution + parent fallthrough -----------------------

test('a prog-mode snippet is reachable from js-mode via fallthrough', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  // `if` lives in prog-mode (a js-mode parent).
  assert.ok(
    listToArray(interp.evaluate('(snippet-keys-for-mode "js-mode")'))
      .includes('if'),
    'expected the prog-mode `if` snippet visible in js-mode'
  );
});

test('a fundamental-mode snippet is reachable from every mode', async () => {
  const { interp } = await engine({ name: 'main.js', text: '' });
  const keys = listToArray(interp.evaluate('(snippet-keys-for-mode "js-mode")'));
  assert.ok(keys.includes('date'), 'expected fundamental `date` in js-mode');
});

test('major-mode display name resolves through the alias table', async () => {
  const { interp } = await engine({ name: 'main.js', text: '' });
  // The .js suffix gives a "JavaScript" mode -> javascript-mode -> js-mode.
  assert.equal(interp.evaluate('(-current-mode-name)'), 'js-mode');
});

// --- engine: directory walking + .yas-parents + shadowing ---------------

test('a user snippet directory is read and its triggers expand', async () => {
  const root = '/u/snippets';
  const { buffer, interp } = await engine({
    name: 'notes.txt',
    text: 'greet',
    userRoot: root,
    dirs: {
      [`${root}/fundamental-mode`]: [['greet', 'file']],
    },
    files: {
      [`${root}/fundamental-mode/greet`]: '# key: greet\n# --\nHello, $0!',
    },
  });
  buffer.moveTo(5);
  interp.call('snippet-expand');
  assert.equal(buffer.text, 'Hello, !');
});

test('.yas-parents adds a custom parent chain', async () => {
  const root = '/u/snippets';
  const { interp } = await engine({
    name: 'main.js',
    text: '',
    userRoot: root,
    dirs: {
      [`${root}/js-mode`]: [['fn2', 'file']],
      [`${root}/custom-base`]: [['base', 'file']],
    },
    files: {
      [`${root}/js-mode/.yas-parents`]: 'custom-base\n',
      [`${root}/js-mode/fn2`]: '# --\nfunction () {}',
      [`${root}/custom-base/base`]: '# --\nBASE',
    },
  });
  const keys = listToArray(interp.evaluate('(snippet-keys-for-mode "js-mode")'));
  assert.ok(keys.includes('fn2'), 'expected the js-mode user snippet');
  assert.ok(
    keys.includes('base'),
    'expected the .yas-parents custom-base snippet via fallthrough'
  );
});

test('a user snippet silently shadows a built-in of the same key', async () => {
  const root = '/u/snippets';
  const { buffer, interp } = await engine({
    name: 'notes.txt',
    text: 'todo',
    userRoot: root,
    dirs: {
      [`${root}/fundamental-mode`]: [['todo', 'file']],
    },
    files: {
      // The user's `todo` overrides the built-in TODO(...) body.
      [`${root}/fundamental-mode/todo`]: '# --\nMY-TODO$0',
    },
  });
  buffer.moveTo(4);
  interp.call('snippet-expand');
  assert.equal(buffer.text, 'MY-TODO');
});

test('snippet-list reports the available triggers for the mode', async () => {
  const { interp, status } = await engine({ name: 'main.js', text: '' });
  interp.call('snippet-list');
  assert.ok(status.length > 0, 'expected a status message');
  assert.ok(
    status[status.length - 1].includes('for'),
    `expected the for trigger listed; got ${status[status.length - 1]}`
  );
});

test('snippet-reload rescans without error and keeps snippets working', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  interp.call('snippet-reload');
  buffer.insert('log');
  press(interp, 'tab');
  assert.ok(
    buffer.text.startsWith('console.log('),
    `expected log expansion after reload; got ${JSON.stringify(buffer.text)}`
  );
});

// --- engine: soft commit -------------------------------------------------

test('moving point outside the snippet soft-commits it', async () => {
  const { buffer, interp } = await engine({ name: 'main.js', text: '' });
  // Leading text so the body starts past offset 0 — there is somewhere
  // genuinely "before" the snippet to move to.
  buffer.insert('lead\n');
  buffer.insert('for');
  press(interp, 'tab');
  assert.equal(interp.evaluate('(snippet-active?)'), true);
  // Jump the cursor to the very start of the buffer, before the body.
  buffer.moveTo(0);
  interp.evaluate('(snippet-soft-commit-if-outside)');
  assert.equal(interp.evaluate('(snippet-active?)'), false);
});
