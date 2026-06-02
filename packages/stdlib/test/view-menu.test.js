/**
 * @file Tests for the *View List* (`view-list` / `buffer-menu`). The list
 * is now a host-rendered clickable HTML table (a `view-list`-kind view —
 * see packages/renderer/src/view-list-view.js), not a text buffer, so the
 * Lisp side is thin: the `view-list` command and its `buffer-menu` alias
 * both call the host primitive `open-view-list!`, and `C-x C-b` is bound
 * to `buffer-menu`. These tests stub `open-view-list!` against a counter
 * and assert the commands and keybinding reach it. (The table's rendering
 * and its kind/file labelling are unit-tested in the renderer:
 * packages/renderer/test/view-list-view.test.js.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { arrayToList, createInterpreter, keyword, NIL } from '@editor/lisp';
import { createView } from '@editor/view';
import {
  createBufferPrimitives,
  createViewPrimitives,
  loadStdlib,
} from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');
const languagesDir = join(lispDir, 'languages');

/**
 * Build an editor with the standard library loaded, a small in-test
 * buffer registry, and host primitives stubbed against it. Each test
 * gets a clean registry.
 *
 * @param {{name: string, kind?: string, mode?: string, lines?: number,
 *   file?: string|null, modified?: boolean, text?: string}[]} [seed]
 *   The buffers the registry starts with. The first entry is current.
 */
async function buildEditor(seed = [{ name: 'alpha.txt', text: 'alpha' }]) {
  // Each registry entry is a small fixture combining the View handle
  // (so `(current-view)` returns a real one) with the row metadata
  // the *Buffer List* renders (mode, line count, file path, modified
  // flag). Killing/switching mutates this single list.
  const registry = seed.map((entry) => {
    const kind = entry.kind ?? 'text';
    const buffer = kind === 'text'
      ? createBuffer(entry.text ?? '', { name: entry.name })
      : null;
    return {
      view: createView({ kind, name: entry.name, buffer }),
      mode: entry.mode ?? null,
      lineCount: entry.lines ?? 1,
      file: entry.file ?? null,
      modified: entry.modified ?? false,
    };
  });
  let currentIndex = 0;
  const session = {
    get currentView() {
      return registry[currentIndex]?.view ?? null;
    },
  };
  const switches = [];
  const kills = [];
  // The host primitive the *View List* commands call. The real one
  // creates/switches to the `view-list` view; here we just count calls.
  let openViewListCalls = 0;

  const recordFor = (entry) => {
    const m = new Map();
    m.set(keyword('name'), entry.view.name);
    m.set(keyword('kind'), entry.view.kind);
    m.set(keyword('mode'), entry.mode === null ? NIL : entry.mode);
    m.set(keyword('line-count'), entry.lineCount);
    m.set(keyword('file'), entry.file === null ? NIL : entry.file);
    m.set(keyword('modified'), entry.modified);
    return m;
  };

  const findIndexByName = (name) =>
    registry.findIndex((e) => e.view.name === name);
  const findIndexByView = (view) =>
    registry.findIndex((e) => e.view === view);

  const switchToIndex = (idx, label) => {
    if (idx < 0) return null;
    currentIndex = idx;
    switches.push(label ?? registry[idx].view.name);
    return registry[idx].view;
  };

  const viewHost = {
    currentView: () => registry[currentIndex]?.view ?? null,
    viewList: () => registry.map((e) => e.view),
    switchToView: (target) => {
      const idx = typeof target === 'string'
        ? findIndexByName(target)
        : findIndexByView(target);
      if (idx < 0) return null;
      return switchToIndex(idx);
    },
    newView: (name) => {
      const finalName =
        name ?? `untitled-${registry.length + 1}`;
      const view = createView({
        kind: 'text',
        name: finalName,
        buffer: createBuffer('', { name: finalName }),
      });
      registry.push({
        view,
        mode: null,
        lineCount: 1,
        file: null,
        modified: false,
      });
      currentIndex = registry.length - 1;
      switches.push(finalName);
      return view;
    },
    killView: (target) => {
      const idx = typeof target === 'string'
        ? findIndexByName(target)
        : findIndexByView(target);
      if (idx < 0) return;
      kills.push(registry[idx].view.name);
      const wasCurrent = idx === currentIndex;
      registry.splice(idx, 1);
      if (registry.length === 0) {
        // Empty list: replace with a fresh *scratch* text view.
        registry.push({
          view: createView({
            kind: 'text',
            name: '*scratch*',
            buffer: createBuffer('', { name: '*scratch*' }),
          }),
          mode: null,
          lineCount: 1,
          file: null,
          modified: false,
        });
        currentIndex = 0;
      } else if (wasCurrent) {
        currentIndex = Math.min(idx, registry.length - 1);
      } else if (idx < currentIndex) {
        currentIndex -= 1;
      }
    },
    nextView: () => null, // unused by the menu tests
    previousView: () => null,
    findViewByName: (name) => registry[findIndexByName(name)]?.view ?? null,
    listViewRecords: () => registry.map(recordFor),
  };

  const interpreter = createInterpreter({
    primitives: {
      ...createBufferPrimitives(session),
      ...createViewPrimitives(viewHost),
      // The *View List* host primitive, stubbed to count calls.
      'open-view-list!': () => {
        openViewListCalls += 1;
        return NIL;
      },
      // Filler primitives so the rest of the standard library can load.
      'start-buffer-switcher!': () => NIL,
      'open-file!': () => NIL,
      'save-buffer!': () => NIL,
      'reload-stdlib!': () => NIL,
      'start-search!': () => NIL,
      'start-search-backward!': () => NIL,
      'start-command-palette!': () => NIL,
      'start-describe-command!': () => NIL,
      'open-minibuffer!': () => NIL,
      'goto-line!': () => NIL,
      'replace-all!': () => NIL,
      'recenter!': () => NIL,
      'page-lines': () => 3,
      'toggle-fold-at-point!': () => NIL,
      'fold-all!': () => NIL,
      'unfold-all!': () => NIL,
      'toggle-repl!': () => NIL,
      'markdown-preview!': () => NIL,
      'quit-editor!': () => NIL,
      'note-create!': () => 'note-1',
      'note-edit!': () => NIL,
      'note-delete!': () => NIL,
      'note-at-point': () => NIL,
      'note-next!': () => NIL,
      'note-prev!': () => NIL,
      'notes-toggle!': () => NIL,
      'write-custom-file!': () => NIL,
      'apply-theme!': () => NIL,
      'load-doc-manifest!': () => NIL,
      'open-doc!': () => NIL,
      'open-docstring-page!': () => NIL,
      'start-doc-search!': () => NIL,
      'form-bounds-at-point!': () => NIL,
      'form-bounds-before-point!': () => NIL,
      'eval-region!': () => NIL,
      'show-eval-log!': () => NIL,
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
      'home-directory': () => '',
      'list-directory-paths': () => NIL,
      'open-file-path!': () => NIL,
      'open-completing-minibuffer!': () => NIL,
    },
  });

  await loadStdlib(
    interpreter,
    (name) => readFile(join(lispDir, name), 'utf8'),
    {
      listLanguageFiles: async () =>
        (await readdir(languagesDir)).filter((n) => n.endsWith('.lisp')),
    }
  );

  return {
    interpreter,
    registry,
    switches,
    kills,
    openViewListCalls: () => openViewListCalls,
    currentName: () => registry[currentIndex].view.name,
    currentBuffer: () => registry[currentIndex].view.buffer,
  };
}

const press = (interpreter, key) => interpreter.call('handle-key', key);

test('view-list opens the *View List* via open-view-list!', async () => {
  const editor = await buildEditor([
    { name: 'alpha.txt', text: 'one' },
    { name: 'beta.txt', text: 'two' },
  ]);
  assert.equal(editor.openViewListCalls(), 0);
  editor.interpreter.evaluate('(view-list)');
  assert.equal(editor.openViewListCalls(), 1);
});

test('buffer-menu is an alias that opens the *View List*', async () => {
  const editor = await buildEditor();
  editor.interpreter.evaluate('(buffer-menu)');
  assert.equal(editor.openViewListCalls(), 1);
});

test('C-x C-b is bound to buffer-menu and opens the *View List*', async () => {
  const editor = await buildEditor();
  assert.ok(
    editor.interpreter.evaluate(
      '(eq? (get c-x-keymap "C-b") (quote buffer-menu))'
    )
  );
  press(editor.interpreter, 'C-x');
  press(editor.interpreter, 'C-b');
  assert.equal(editor.openViewListCalls(), 1);
});

test('view-list and buffer-menu are registered commands', async () => {
  const editor = await buildEditor();
  for (const name of ['view-list', 'buffer-menu']) {
    assert.ok(
      editor.interpreter.evaluate(`(command-registered? (quote ${name}))`),
      `expected ${name} to be a command`
    );
  }
});

