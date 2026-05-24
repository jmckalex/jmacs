/**
 * @file The minibuffer — a one-line prompt at the foot of the window
 * for input that is not buffer text: incremental search, the command
 * palette, and (later) find-file. It is a plain DOM component; callers
 * drive it through the `prompt` handlers.
 *
 * While the minibuffer is open it holds keyboard focus, so the editor
 * surface does not see those keystrokes — exactly as for the REPL.
 */

import { keyEventToString } from './keymap.js';

/**
 * @typedef {object} MinibufferPrompt
 * @property {string} [initialValue] - Text the input starts with.
 * @property {(value: string) => void} [onChange] - Called as the user
 *   types.
 * @property {(value: string) => void} [onSubmit] - Called on Enter.
 * @property {() => void} [onCancel] - Called on Escape.
 * @property {(key: string, value: string) => boolean} [onKey] - Called
 *   for every keystroke; returning true consumes the key (used, for
 *   example, so a search can catch a repeated C-s).
 */

/**
 * @typedef {object} Minibuffer
 * @property {HTMLElement} element - The minibuffer's root element.
 * @property {(prompt: string, handlers: MinibufferPrompt) => void} prompt -
 *   Open the minibuffer with a prompt and handlers.
 * @property {(text: string) => void} setStatus - Show a status note
 *   after the input (e.g. "no match").
 * @property {(text: string) => void} showMessage - Display TEXT as a
 *   transient one-line message in the minibuffer area (no input
 *   field; focus stays where it was). Used for the `y`/`n`/`q`-style
 *   prompts driven by `read-next-key`, where the keystroke is the
 *   answer.
 * @property {() => void} clearMessage - Hide a message shown by
 *   `showMessage`.
 * @property {() => void} close - Hide the minibuffer.
 * @property {() => boolean} isOpen - Whether the minibuffer is showing.
 */

/**
 * Mount a minibuffer inside a container.
 *
 * @param {HTMLElement} container
 * @returns {Minibuffer}
 */
export function createMinibuffer(container) {
  const doc = container.ownerDocument;
  const el = (tag, className) => {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  };

  const root = el('div', 'minibuffer');
  const promptEl = el('span', 'minibuffer-prompt');
  const input = el('input', 'minibuffer-input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  const statusEl = el('span', 'minibuffer-status');
  root.append(promptEl, input, statusEl);
  container.append(root);
  root.hidden = true;

  /** @type {MinibufferPrompt | null} */
  let handlers = null;

  function close() {
    root.hidden = true;
    handlers = null;
    input.value = '';
    input.hidden = false;
    statusEl.textContent = '';
  }

  input.addEventListener('keydown', (event) => {
    if (handlers === null) return;
    if (handlers.onKey && handlers.onKey(keyEventToString(event), input.value)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const { onSubmit } = handlers;
      const value = input.value;
      close();
      onSubmit?.(value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      const { onCancel } = handlers;
      close();
      onCancel?.();
    }
  });

  input.addEventListener('input', () => {
    handlers?.onChange?.(input.value);
  });

  return {
    element: root,

    prompt(promptText, h) {
      handlers = h;
      promptEl.textContent = promptText;
      input.value = h.initialValue ?? '';
      input.hidden = false;
      statusEl.textContent = '';
      root.hidden = false;
      input.focus();
      // Report the starting value so callers can render initial state
      // (e.g. the command palette listing every command).
      h.onChange?.(input.value);
    },

    setStatus(text) {
      statusEl.textContent = text;
    },

    /**
     * Show a one-line message in the minibuffer panel without taking
     * focus or installing a prompt — the message rides in the prompt
     * slot, the input field is hidden. Used by commands that drive a
     * `y`/`n` answer through `read-next-key`.
     */
    showMessage(text) {
      // If a real prompt is open it owns the panel; messages are
      // suppressed so they cannot clobber the prompt or its input.
      if (handlers !== null) return;
      promptEl.textContent = text;
      input.value = '';
      input.hidden = true;
      statusEl.textContent = '';
      root.hidden = false;
    },

    clearMessage() {
      if (handlers !== null) return;
      promptEl.textContent = '';
      input.hidden = false;
      root.hidden = true;
    },

    close,
    isOpen: () => !root.hidden,
  };
}
