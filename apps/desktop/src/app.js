/**
 * @file Renderer-process entry point. Runs in the window, wires the
 * stack together: an L2 buffer, an L4 editor view, and a modeline that
 * reflects the buffer's state.
 */

import { createBuffer } from '@editor/buffer';
import { createEditorView } from '@editor/renderer';

const WELCOME = `Welcome.

This is a Lisp-extensible editor, in its earliest running form.
What you see is the whole stack working end to end:

  storage   (L1)   the text itself
  buffer    (L2)   cursor, selection, editing commands, undo
  renderer  (L4)   these lines, and that blinking cursor

Type anywhere — the text is a live buffer.

  arrows         move the cursor
  shift + arrows extend a selection
  cmd + arrows   jump to line and buffer edges
  cmd + z        undo        cmd + shift + z   redo

There is no Lisp yet, and no files on disk. Those come next.
For now: a window, a buffer, and a cursor that is really yours.
`;

const buffer = createBuffer(WELCOME, { name: 'welcome.txt' });

const host = document.getElementById('editor-host');
const view = createEditorView(buffer, host);

// Modeline — buffer name on the left, cursor position on the right.
const nameEl = document.getElementById('modeline-name');
const positionEl = document.getElementById('modeline-position');

function updateModeline() {
  nameEl.textContent = buffer.name;
  const { line, column } = buffer.positionAt(buffer.point);
  positionEl.textContent = `Ln ${line + 1}, Col ${column + 1}`;
}

buffer.onChange(updateModeline);
updateModeline();
view.focus();
