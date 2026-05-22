/**
 * @file The colour-picker modal — an in-app modal dialog for choosing a
 * colour, opened by clicking a swatch beside a colour literal.
 *
 * The modal is a real in-app dialog (a backdrop plus a panel) with OK
 * and Cancel buttons, not a bare browser control. It does use a native
 * `<input type="color">` *inside* the panel as the actual picker — the
 * platform colour wheel — but the dialog framing, the live preview and
 * the OK / Cancel commitment are the editor's own.
 *
 * The module is decoupled from the buffer: it is handed an initial
 * colour and an `onChoose` callback, and reports the chosen hex when
 * the user confirms. The caller performs the buffer edit.
 */

import { normaliseToHex } from './colour-literals.js';

/**
 * Open a modal colour chooser.
 *
 * Exactly one modal is shown at a time; opening another while one is
 * up is a no-op. The modal is removed when the user picks OK, picks
 * Cancel, presses Escape, or clicks the backdrop.
 *
 * @param {object} options
 * @param {Document} options.doc - The document to mount into.
 * @param {string} options.initial - The colour the picker starts on;
 *   any literal `normaliseToHex` accepts, else it falls back to black.
 * @param {(hex: string) => void} options.onChoose - Called with the
 *   chosen `#rrggbb` hex when the user confirms with OK.
 * @param {() => void} [options.onCancel] - Called when the user
 *   dismisses the modal without choosing.
 * @returns {{ close: () => void } | null} A handle whose `close()`
 *   dismisses the modal, or null if a modal was already open.
 */
export function openColourPicker({ doc, initial, onChoose, onCancel }) {
  if (doc.querySelector('.colour-picker-backdrop')) return null;

  const startHex = normaliseToHex(initial) || '#000000';
  // <input type="color"> only accepts #rrggbb — drop any alpha.
  const inputHex = startHex.slice(0, 7);

  let settled = false;

  const backdrop = doc.createElement('div');
  backdrop.className = 'colour-picker-backdrop';

  const panel = doc.createElement('div');
  panel.className = 'colour-picker';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Choose a colour');

  const title = doc.createElement('div');
  title.className = 'colour-picker-title';
  title.textContent = 'Choose a colour';

  const row = doc.createElement('div');
  row.className = 'colour-picker-row';

  const preview = doc.createElement('div');
  preview.className = 'colour-picker-preview';
  preview.style.background = inputHex;

  const input = doc.createElement('input');
  input.type = 'color';
  input.className = 'colour-picker-input';
  input.value = inputHex;

  const valueLabel = doc.createElement('input');
  valueLabel.type = 'text';
  valueLabel.className = 'colour-picker-value';
  valueLabel.value = inputHex;
  valueLabel.spellcheck = false;

  row.append(input, preview, valueLabel);

  const buttons = doc.createElement('div');
  buttons.className = 'colour-picker-buttons';
  const cancelBtn = doc.createElement('button');
  cancelBtn.className = 'colour-picker-cancel';
  cancelBtn.textContent = 'Cancel';
  const okBtn = doc.createElement('button');
  okBtn.className = 'colour-picker-ok';
  okBtn.textContent = 'OK';
  buttons.append(cancelBtn, okBtn);

  panel.append(title, row, buttons);
  backdrop.append(panel);
  doc.body.append(backdrop);

  /** The hex the picker currently shows. */
  function currentHex() {
    return input.value;
  }

  /** Mirror the picker's value into the preview and text field. */
  function syncFromInput() {
    preview.style.background = input.value;
    valueLabel.value = input.value;
  }

  /** Accept a hex typed into the text field, if it parses. */
  function syncFromText() {
    const hex = normaliseToHex(valueLabel.value);
    if (hex) {
      const noAlpha = hex.slice(0, 7);
      input.value = noAlpha;
      preview.style.background = noAlpha;
    }
  }

  /** Tear the modal down and detach its listeners. */
  function teardown() {
    doc.removeEventListener('keydown', onKeydown, true);
    backdrop.remove();
  }

  /** Dismiss without choosing. */
  function cancel() {
    if (settled) return;
    settled = true;
    teardown();
    if (typeof onCancel === 'function') onCancel();
  }

  /** Confirm: report the chosen colour and dismiss. */
  function confirm() {
    if (settled) return;
    settled = true;
    const hex = currentHex();
    teardown();
    onChoose(hex);
  }

  function onKeydown(event) {
    // The modal owns the keyboard while it is up — the editor's own
    // keydown handler must not also see these keys.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      confirm();
    }
  }

  input.addEventListener('input', syncFromInput);
  valueLabel.addEventListener('input', syncFromText);
  valueLabel.addEventListener('change', syncFromText);
  okBtn.addEventListener('click', confirm);
  cancelBtn.addEventListener('click', cancel);
  // A click on the backdrop (but not the panel) dismisses the modal.
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) cancel();
  });
  // Keyboard handled in the capture phase so it never reaches the
  // editor view's keydown listener on the .editor root.
  doc.addEventListener('keydown', onKeydown, true);

  // Give the picker focus so Enter/Escape work immediately.
  input.focus();

  return { close: cancel };
}
