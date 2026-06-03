/**
 * @file mode-menu-build.test.js — the pure mode-menu assembly
 * (mode-menu-build.js): `buildModeMenuItems` (flat vs nested, key/doc
 * resolution, the "Other" catch-all) and `renderModeMenuItem` (recursive
 * leaf-vs-submenu rendering). No Electron, no renderer — plain data in,
 * plain template out.
 *
 * The backward-compat guarantee is asserted directly: with an empty
 * section spec the result is the historical flat shape, byte-for-byte.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildModeMenuItems, renderModeMenuItem } from '../src/mode-menu-build.js';

// Representative flat entries: [keys, command, doc] triples.
const FLAT = [
  ['C-c C-c', 'latex-compile', 'Compile the document.'],
  ['C-c C-v', 'latex-view', 'View the PDF.'],
  ['C-c b', 'latex-textbf', 'Bold.'],
  ['C-c e', 'latex-emph', 'Emphasis.'],
  ['C-c x', 'orphan-command', 'Not in any section.'],
];

test('empty sections → the flat menu, byte-for-byte (backward compat)', () => {
  const items = buildModeMenuItems(FLAT, []);
  assert.deepEqual(items, [
    { label: 'latex-compile    C-c C-c', command: 'latex-compile', toolTip: 'Compile the document.' },
    { label: 'latex-view    C-c C-v', command: 'latex-view', toolTip: 'View the PDF.' },
    { label: 'latex-textbf    C-c b', command: 'latex-textbf', toolTip: 'Bold.' },
    { label: 'latex-emph    C-c e', command: 'latex-emph', toolTip: 'Emphasis.' },
    { label: 'orphan-command    C-c x', command: 'orphan-command', toolTip: 'Not in any section.' },
  ]);
  // No nesting at all: every item is a leaf.
  assert.ok(items.every((it) => !Array.isArray(it.items)));
});

test('sections → submenus with keys + docs resolved from the flat data', () => {
  const sections = [
    ['Compile & View', ['Compile', 'latex-compile'], ['View PDF', 'latex-view']],
    ['Fonts', ['Bold', 'latex-textbf'], ['Emphasis', 'latex-emph']],
  ];
  const items = buildModeMenuItems(FLAT, sections);

  // Two declared sections plus an auto "Other" for the orphan command.
  assert.equal(items.length, 3);
  assert.equal(items[0].label, 'Compile & View');
  assert.deepEqual(items[0].items[0], {
    label: 'Compile    C-c C-c',
    command: 'latex-compile',
    toolTip: 'Compile the document.',
  });
  assert.deepEqual(items[1].items[1], {
    label: 'Emphasis    C-c e',
    command: 'latex-emph',
    toolTip: 'Emphasis.',
  });

  // The orphan, bound but unplaced, lands in "Other" — nothing vanishes.
  const other = items[2];
  assert.equal(other.label, 'Other');
  assert.deepEqual(other.items, [
    { label: 'orphan-command    C-c x', command: 'orphan-command', toolTip: 'Not in any section.' },
  ]);
});

test('a section command with no keymap binding shows just its label', () => {
  const sections = [['Misc', ['Unbound', 'never-bound-command']]];
  // never-bound-command is absent from FLAT, so there are no keys.
  const items = buildModeMenuItems(FLAT, sections);
  assert.equal(items[0].items[0].label, 'Unbound');
  assert.equal(items[0].items[0].command, 'never-bound-command');
  assert.equal(items[0].items[0].toolTip, '');
});

test('no "Other" submenu when every command is placed', () => {
  // FLAT minus the orphan — every command is covered by a section.
  const flat = FLAT.slice(0, 4);
  const sections = [
    ['A', ['Compile', 'latex-compile'], ['View', 'latex-view']],
    ['B', ['Bold', 'latex-textbf'], ['Emph', 'latex-emph']],
  ];
  const items = buildModeMenuItems(flat, sections);
  assert.equal(items.length, 2);
  assert.ok(!items.some((it) => it.label === 'Other'));
});

test('renderModeMenuItem: a leaf becomes a clickable entry', () => {
  const dispatched = [];
  const entry = renderModeMenuItem(
    { label: 'Compile    C-c C-c', command: 'latex-compile', toolTip: 'Compile.' },
    (cmd) => dispatched.push(cmd)
  );
  assert.equal(entry.label, 'Compile    C-c C-c');
  assert.equal(entry.toolTip, 'Compile.');
  assert.equal(typeof entry.click, 'function');
  assert.equal(entry.submenu, undefined);
  entry.click();
  assert.deepEqual(dispatched, ['latex-compile']);
});

test('renderModeMenuItem: a group becomes a submenu, recursively', () => {
  const dispatched = [];
  const group = {
    label: 'Fonts',
    items: [
      { label: 'Bold', command: 'latex-textbf', toolTip: 'Bold.' },
      {
        label: 'Nested',
        items: [{ label: 'Deep', command: 'deep-command', toolTip: '' }],
      },
    ],
  };
  const entry = renderModeMenuItem(group, (cmd) => dispatched.push(cmd));
  assert.equal(entry.label, 'Fonts');
  assert.ok(Array.isArray(entry.submenu));
  assert.equal(entry.submenu.length, 2);
  // Leaf inside the group.
  assert.equal(typeof entry.submenu[0].click, 'function');
  // A second nesting level renders as a nested submenu (N levels work).
  assert.ok(Array.isArray(entry.submenu[1].submenu));
  entry.submenu[1].submenu[0].click();
  assert.deepEqual(dispatched, ['deep-command']);
});
