/**
 * @file The minibuffer — a one-line prompt at the foot of the window
 * for input that is not buffer text: incremental search, the command
 * palette, find-file. It is a plain DOM component; callers drive it
 * through the `prompt` handlers.
 *
 * While the minibuffer is open it holds keyboard focus, so the editor
 * surface does not see those keystrokes — exactly as for the REPL.
 *
 * When no prompt is open, the same row is reused as an *echo area* —
 * the place where transient host messages (a chord prefix mid-build,
 * a quick note) appear. The echo area is hidden while a prompt is
 * open, so the prompt's own `setStatus` writes to its own status
 * (e.g. an isearch "no match") without competing with the chord
 * prefix display.
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
 * @property {(value: string) => (string | void)} [onTab] - Called on
 *   Tab. Returning a string replaces the input value with it (the
 *   typical "complete to longest common prefix" path); returning
 *   undefined or the same string consumes the Tab without changing
 *   the input.
 */

/**
 * @typedef {object} Minibuffer
 * @property {HTMLElement} element - The minibuffer's root element.
 * @property {(prompt: string, handlers: MinibufferPrompt) => void} prompt -
 *   Open the minibuffer with a prompt and handlers.
 * @property {(text: string) => void} setStatus - Show a status note
 *   after the input (e.g. "no match"). While a prompt is open this
 *   appears in the prompt row; with no prompt open it shows in the
 *   echo area.
 * @property {(text: string) => void} setValue - Replace the input value
 *   programmatically and refocus the input (cursor at the end). Used by
 *   click-to-complete in the find-file completions panel, which fills the
 *   minibuffer from outside the keystroke flow. No-op when no prompt is
 *   open.
 * @property {() => void} clearStatus - Clear the status note.
 * @property {(value?: string) => void} submit - Submit the prompt as if
 *   Enter were pressed: close the prompt and fire `onSubmit` with VALUE (or
 *   the current input when VALUE is omitted). Used by double-click-to-open
 *   in the completions panel. No-op when no prompt is open.
 * @property {(text: string) => void} showMessage - Display TEXT as a
 *   transient one-line message in the minibuffer area (no input
 *   field; focus stays where it was). Used for the `y`/`n`/`q`-style
 *   prompts driven by `read-next-key`, where the keystroke is the
 *   answer.
 * @property {() => void} clearMessage - Hide a message shown by
 *   `showMessage`.
 * @property {() => void} close - Hide the minibuffer prompt row.
 * @property {() => boolean} isOpen - Whether the minibuffer is showing
 *   a prompt.
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

  // The prompt row — visible only while a prompt is open.
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

  // The echo area — visible whenever the prompt row is hidden. Status
  // text the host sets while no prompt is active appears here (e.g. a
  // mid-build chord prefix like "C-x-").
  const echoEl = el('div', 'minibuffer-echo');
  container.append(echoEl);
  echoEl.hidden = true;

  /** @type {MinibufferPrompt | null} */
  let handlers = null;

  function close() {
    root.hidden = true;
    handlers = null;
    input.value = '';
    input.hidden = false;
    statusEl.textContent = '';
    // The echo area shows again — its current text (if any) is whatever
    // the host last set; an open echo with empty text stays hidden.
    if (echoEl.textContent !== '') echoEl.hidden = false;
  }

  input.addEventListener('keydown', (event) => {
    if (handlers === null) return;
    if (handlers.onKey && handlers.onKey(keyEventToString(event), input.value)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Tab' && handlers.onTab) {
      event.preventDefault();
      const next = handlers.onTab(input.value);
      if (typeof next === 'string' && next !== input.value) {
        input.value = next;
        // Move the cursor to the end so further typing extends the
        // completion rather than splitting it.
        input.setSelectionRange(next.length, next.length);
        handlers.onChange?.(next);
      }
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
      // Hide the echo area while a prompt is open — the prompt row
      // owns the line, and a stale chord prefix would just be noise.
      echoEl.hidden = true;
      input.focus();
      // Report the starting value so callers can render initial state
      // (e.g. the command palette listing every command).
      h.onChange?.(input.value);
    },

    setStatus(text) {
      if (!root.hidden) {
        // A prompt is open — the status sits beside the input.
        statusEl.textContent = text;
      } else {
        // No prompt — write to the echo area.
        echoEl.textContent = text;
        echoEl.hidden = text === '';
      }
    },

    clearStatus() {
      statusEl.textContent = '';
      echoEl.textContent = '';
      echoEl.hidden = true;
    },

    setValue(text) {
      if (root.hidden || handlers === null) return;
      input.hidden = false;
      input.value = text;
      input.focus();
      input.setSelectionRange(text.length, text.length);
      handlers.onChange?.(text);
    },

    submit(value) {
      if (handlers === null) return;
      const { onSubmit } = handlers;
      const v = value ?? input.value;
      close();
      onSubmit?.(v);
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
