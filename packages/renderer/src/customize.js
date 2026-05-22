/**
 * @file The customisation view — the view a `customize`-kind buffer is
 * shown through. A buffer has a kind; the host mounts the matching
 * view (text buffers → the editor view, a customisation buffer → this).
 *
 * This is the first non-text view, and the proof of the general
 * buffer-kind / view-kind mechanism. For now it renders a placeholder;
 * the typed form widgets, group tree and Set / Apply / Save controls
 * are built on top of it next.
 */

import { keyEventToString } from './keymap.js';

/** Tags whose own keyboard handling must not be hijacked. */
const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * Create the customisation view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Dispatches a key
 *   typed outside a form control — so `C-x b`, `M-x` and the like work
 *   in a customisation buffer too.
 */
export function createCustomizeView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;

  const root = doc.createElement('div');
  root.className = 'customize';
  root.tabIndex = 0;
  container.append(root);

  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    if (FORM_TAGS.has(event.target.tagName)) return;
    if (onKey && onKey(keyEventToString(event))) event.preventDefault();
  });

  /** Render the view for a customisation buffer. */
  function setBuffer(buffer) {
    root.replaceChildren();
    const title = doc.createElement('h1');
    title.className = 'customize-title';
    title.textContent = buffer.name;
    const note = doc.createElement('p');
    note.className = 'customize-note';
    note.textContent = 'Customisation settings will appear here.';
    root.append(title, note);
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
  };
}
