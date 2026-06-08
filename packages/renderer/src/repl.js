/**
 * @file The REPL view — a scrollback log and an input line. It is a
 * plain DOM component and knows nothing about Lisp: it reports
 * submitted source through an `onSubmit` callback and renders whatever
 * text the host hands back. That keeps the renderer decoupled from the
 * language runtime.
 */

/**
 * @typedef {object} ReplView
 * @property {HTMLElement} element - The view's root element.
 * @property {(text: string) => void} appendOutput - Append streamed
 *   output (from `print`); consecutive calls coalesce into one block.
 * @property {(text: string) => void} appendResult - Append a result.
 * @property {(text: string) => void} appendError - Append an error.
 * @property {(text: string) => void} appendNote - Append an aside.
 * @property {() => void} focus - Focus the input line.
 */

/**
 * Mount a REPL view inside a container.
 *
 * @param {HTMLElement} container
 * @param {object} options
 * @param {(source: string) => void} options.onSubmit - Called with the
 *   source text when the user submits a line.
 * @param {string} [options.prompt] - The prompt string.
 * @param {string} [options.welcome] - An optional opening note.
 * @returns {ReplView}
 */
export function createReplView(container, options) {
  const doc = container.ownerDocument;
  const onSubmit = options.onSubmit;
  const prompt = options.prompt ?? 'λ ';

  const el = (tag, className) => {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  };

  const root = el('div', 'repl');
  const log = el('div', 'repl-log');
  const inputRow = el('div', 'repl-input-row');
  const promptEl = el('span', 'repl-prompt');
  promptEl.textContent = prompt;
  const input = el('input', 'repl-input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'REPL input');

  inputRow.append(promptEl, input);
  root.append(log, inputRow);
  container.append(root);

  /** @type {string[]} */
  const history = [];
  let historyIndex = 0;

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  /** Append a single-line entry with a style class. */
  function appendLine(text, className) {
    const line = el('div', className);
    line.textContent = text;
    log.append(line);
    scrollToBottom();
  }

  /** Append streamed output, coalescing consecutive calls. */
  function appendOutput(text) {
    let block = log.lastElementChild;
    if (block === null || !block.classList.contains('repl-output')) {
      block = el('div', 'repl-output');
      log.append(block);
    }
    block.textContent += text;
    scrollToBottom();
  }

  function moveCaretToEnd() {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const source = input.value.trim();
      if (source === '') return;
      input.value = '';
      history.push(source);
      historyIndex = history.length;
      appendLine(prompt + source, 'repl-echo');
      onSubmit(source);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (historyIndex > 0) {
        historyIndex -= 1;
        input.value = history[historyIndex];
        moveCaretToEnd();
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (historyIndex < history.length) {
        historyIndex += 1;
        input.value =
          historyIndex === history.length ? '' : history[historyIndex];
        moveCaretToEnd();
      }
    }
  });

  if (typeof options.welcome === 'string') {
    appendLine(options.welcome, 'repl-note');
  }

  return {
    element: root,
    appendOutput,
    appendResult: (text) => appendLine(text, 'repl-result'),
    appendError: (text) => appendLine(text, 'repl-error'),
    appendNote: (text) => appendLine(text, 'repl-note'),
    focus: () => input.focus(),
    // Utility-dock panel contract. The REPL is the resident, non-closable,
    // non-modal tab: it keeps its native <input> (so the dock installs no
    // capture handler for it) and is never torn down.
    title: 'REPL',
    icon: 'fa-solid fa-terminal',
    modal: false,
    closable: false,
    handleKey: () => false,
    reset: () => {},
    destroy: () => {},
  };
}
