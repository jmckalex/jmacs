/**
 * @file The shell view — a `shell`-kind buffer is shown through this
 * view. Each shell buffer owns one long-lived child process running
 * the user's default shell ($SHELL, falling back to /bin/zsh). The
 * user types into an input line; pressing Enter sends the line — with
 * a trailing newline — to the shell's stdin. The shell's stdout and
 * stderr stream back as text and are appended to a transcript above
 * the input.
 *
 * Buffer shape:
 *
 *   { kind: 'shell',
 *     name: '*shell*',
 *     sessionId: 'shell-<n>',
 *     transcript: Array<{ kind: 'input' | 'stdout' | 'stderr' | 'exit', text: string }>,
 *     ended: boolean }
 *
 * The buffer carries the transcript so a buffer switch and switch-back
 * preserves the user's history. Transcripts are capped at
 * `TRANSCRIPT_MAX` lines; older lines are trimmed off the top.
 *
 * Limits this is NOT trying to handle (v1):
 *   - ANSI escape sequences (cursor moves, colour codes) — stripped.
 *   - Curses applications (vi, less, top) — they will misbehave.
 *   - Real PTY behaviour — pipes only; some shells skip their prompt.
 *
 * The host hands in callbacks for spawn / write / signal / kill / data
 * streaming; this view does not import preload directly.
 */

import { keyEventToString } from './keymap.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Tags whose own keyboard handling must not be hijacked. */
const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

/** Cap the transcript at this many lines — past that, drop the oldest
 *  in chunks so the DOM stays manageable on `git log`-sized output. */
const TRANSCRIPT_MAX = 10000;

/**
 * Strip the ANSI CSI escape sequences shells often emit for colour
 * and cursor movement. This is a v1 approximation — enough to clean
 * up a `ls --color=auto` or a coloured `git` prompt without trying to
 * be a real terminal emulator.
 *
 * Matches `ESC [` … final byte, plus the bare `ESC` characters that
 * occasionally slip through (e.g. ESC ] OSC sequences, ESC = / >).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  if (typeof text !== 'string' || text === '') return text;
  return text
    // CSI: ESC [ params final-byte (`m`, `K`, `H`, …)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // OSC: ESC ] … BEL or ST (ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Stray remaining ESC bytes.
    .replace(/\x1b/g, '');
}

/**
 * A "carriage return without a line feed" inside terminal output is a
 * cursor-to-column-zero — typically used by progress bars and the
 * prompt. The closest we can do without redraw is collapse `\r` to
 * nothing when it's followed by content on the same line (a bare `\r`
 * before `\n` is fine as is). This is a v1 best-effort.
 *
 * @param {string} text
 * @returns {string}
 */
export function normaliseCarriageReturns(text) {
  if (typeof text !== 'string' || text === '') return text;
  // `\r\n` is a CRLF — leave the `\n`, drop the `\r`.
  // A bare `\r` mid-stream typically rewinds the current line; we drop it.
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

/**
 * Sanitise a chunk of shell output for display: strip ANSI, normalise
 * carriage returns. Exposed for testing.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitiseShellOutput(text) {
  return normaliseCarriageReturns(stripAnsi(text));
}

/**
 * Create a shell view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(sessionId: string, options?: { cwd?: string })
 *   => Promise<{ ok: boolean, shell?: string, pid?: number, error?: string }>}
 *   [options.spawn] - Spawn a child process for `sessionId`.
 * @param {(sessionId: string, data: string) => Promise<{ ok: boolean }>}
 *   [options.write] - Send a string to the shell's stdin.
 * @param {(sessionId: string, signal?: string) => Promise<{ ok: boolean }>}
 *   [options.signal] - Send a signal (default SIGINT) to the shell.
 * @param {(sessionId: string) => Promise<{ ok: boolean }>}
 *   [options.endInput] - Close the shell's stdin (C-d at empty line).
 * @param {(sessionId: string) => Promise<{ ok: boolean }>}
 *   [options.kill] - Terminate the shell session.
 * @param {(callback: (payload: { sessionId: string, stream: string, data: string }) => void)
 *   => (() => void)} [options.onData] - Subscribe to streamed shell
 *   output. The returned function unsubscribes.
 * @param {(callback: (payload: { sessionId: string, code: number | null, signal: string | null }) => void)
 *   => (() => void)} [options.onExit] - Subscribe to exit events.
 * @param {(key: string) => boolean} [options.onKey] - Chord-key pass-
 *   through to the global Lisp keymap.
 * @param {() => void} [options.closeBuffer] - Called when the user
 *   ends the session (C-d on an empty input line).
 * @returns {{
 *   element: HTMLElement,
 *   setBuffer: (buffer: object | null) => void,
 *   focus: () => void,
 *   destroy: () => void,
 * }}
 */
export function createShellView(container, options = {}) {
  const doc = container.ownerDocument;
  const spawnFn = typeof options.spawn === 'function' ? options.spawn : null;
  const writeFn = typeof options.write === 'function' ? options.write : null;
  const signalFn = typeof options.signal === 'function' ? options.signal : null;
  const endInputFn =
    typeof options.endInput === 'function' ? options.endInput : null;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const closeBuffer =
    typeof options.closeBuffer === 'function' ? options.closeBuffer : null;

  const root = doc.createElement('div');
  root.className = 'shell-view';
  root.tabIndex = -1;
  container.append(root);

  const header = doc.createElement('div');
  header.className = 'shell-header';
  const headerIcon = doc.createElement('i');
  headerIcon.className = 'fa-solid fa-terminal';
  const headerLabel = doc.createElement('span');
  headerLabel.className = 'shell-header-label';
  headerLabel.textContent = 'shell';
  header.append(headerIcon, headerLabel);
  root.append(header);

  const transcriptEl = doc.createElement('div');
  transcriptEl.className = 'shell-transcript';
  root.append(transcriptEl);

  const inputRow = doc.createElement('div');
  inputRow.className = 'shell-input-row';
  const promptEl = doc.createElement('span');
  promptEl.className = 'shell-input-prompt';
  promptEl.textContent = '$';
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'shell-input';
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Shell input');
  inputRow.append(promptEl, input);
  root.append(inputRow);

  /** Buffer currently shown, or null. */
  let buffer = null;

  /** Unsubscribe handles for the data / exit streams. Set on view
   *  creation, cleared on destroy. */
  let unsubscribeData = null;
  let unsubscribeExit = null;

  /** Per-buffer command history (in-memory). Keyed by sessionId. */
  const histories = new Map();
  let historyIndex = 0;

  /** Render one transcript entry to the DOM. The chunk text is
   *  already sanitised. */
  function buildEntryElement(entry) {
    const block = doc.createElement('div');
    block.className = `shell-entry shell-entry-${entry.kind}`;
    block.textContent = entry.text;
    return block;
  }

  /** Drop the oldest entries so the transcript fits the cap. */
  function trimTranscript(transcript) {
    if (transcript.length <= TRANSCRIPT_MAX) return transcript;
    const overflow = transcript.length - TRANSCRIPT_MAX;
    return transcript.slice(overflow);
  }

  /** Append `entry` to the buffer's transcript and the DOM, scrolling
   *  to the bottom. Coalesces consecutive same-kind output chunks into
   *  one block so a streaming `git log` doesn't make N thousand DOM
   *  nodes. Input/exit entries are always their own row. */
  function appendEntry(entry) {
    if (!buffer) return;
    if (!Array.isArray(buffer.transcript)) buffer.transcript = [];

    const last = buffer.transcript[buffer.transcript.length - 1];
    const lastBlock = transcriptEl.lastElementChild;
    const coalesce =
      (entry.kind === 'stdout' || entry.kind === 'stderr') &&
      last &&
      last.kind === entry.kind &&
      lastBlock &&
      lastBlock.classList.contains(`shell-entry-${entry.kind}`);

    if (coalesce) {
      last.text += entry.text;
      lastBlock.textContent = last.text;
    } else {
      buffer.transcript.push(entry);
      transcriptEl.append(buildEntryElement(entry));
    }

    // Cap the transcript; rebuild the DOM if we trimmed it.
    if (buffer.transcript.length > TRANSCRIPT_MAX) {
      buffer.transcript = trimTranscript(buffer.transcript);
      repaintTranscript();
    }
    scrollToBottom();
  }

  /** Repaint the entire transcript from `buffer.transcript`. */
  function repaintTranscript() {
    transcriptEl.replaceChildren();
    if (!buffer || !Array.isArray(buffer.transcript)) return;
    for (const entry of buffer.transcript) {
      transcriptEl.append(buildEntryElement(entry));
    }
  }

  function scrollToBottom() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  /** Handle a streamed-data event from the host. Filters to the
   *  current buffer's sessionId. Other sessions belong to other
   *  buffers; their entries are routed by the host's dispatch — the
   *  app keeps one view, but data is keyed by sessionId so we ignore
   *  anything not addressed to us. */
  function onData(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    const cleaned = sanitiseShellOutput(String(payload.data ?? ''));
    if (cleaned === '') return;
    const kind = payload.stream === 'stderr' ? 'stderr' : 'stdout';
    appendEntry({ kind, text: cleaned });
  }

  /** Handle an exit event for the current buffer's session. Marks the
   *  buffer ended; the input line goes read-only. */
  function onExit(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    buffer.ended = true;
    const tag = payload.signal
      ? `[exited on ${payload.signal}]`
      : `[exited${typeof payload.code === 'number' ? ` ${payload.code}` : ''}]`;
    appendEntry({ kind: 'exit', text: `\n${tag}\n` });
    input.disabled = true;
    input.placeholder = 'session ended';
  }

  /** Submit the current input line: render it as an input entry, then
   *  send `value\n` to the shell. */
  async function submitInput() {
    if (!buffer || buffer.ended) return;
    const value = input.value;
    input.value = '';
    // Record in history, even empty lines? No — only non-empty, so
    // ArrowUp doesn't have to skip blanks.
    if (value !== '') {
      const history = histories.get(buffer.sessionId) ?? [];
      history.push(value);
      histories.set(buffer.sessionId, history);
      historyIndex = history.length;
    }
    // Echo to transcript so the user always sees what they typed,
    // regardless of whether the shell itself echoes (a pipe-stdin shell
    // typically doesn't).
    appendEntry({ kind: 'input', text: `${value}\n` });
    if (writeFn) {
      try {
        await writeFn(buffer.sessionId, `${value}\n`);
      } catch (error) {
        appendEntry({
          kind: 'stderr',
          text: `[write failed: ${error.message}]\n`,
        });
      }
    }
  }

  /** Send SIGINT to the running command. */
  async function sendInterrupt() {
    if (!buffer || !signalFn) return;
    try {
      await signalFn(buffer.sessionId, 'SIGINT');
    } catch {
      /* the process is gone — exit event will follow if it wasn't already */
    }
    appendEntry({ kind: 'input', text: '^C\n' });
  }

  /** End the shell session — closes stdin (C-d). */
  async function endSession() {
    if (!buffer) return;
    if (endInputFn) {
      try {
        await endInputFn(buffer.sessionId);
      } catch {
        // Session likely already gone.
      }
    }
    if (closeBuffer) closeBuffer();
  }

  // Browse history with ArrowUp/ArrowDown — but only when the input
  // has focus and no modifier is held (so global keymap entries like
  // M-x still pass through).
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      submitInput();
      return;
    }
    if (event.key === 'ArrowUp' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!buffer) return;
      const history = histories.get(buffer.sessionId) ?? [];
      if (history.length === 0) return;
      if (historyIndex > 0) historyIndex -= 1;
      input.value = history[historyIndex] ?? '';
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (event.key === 'ArrowDown' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!buffer) return;
      const history = histories.get(buffer.sessionId) ?? [];
      if (history.length === 0) return;
      historyIndex = Math.min(historyIndex + 1, history.length);
      input.value = historyIndex >= history.length ? '' : history[historyIndex];
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    // C-c — send SIGINT. (Most browsers handle ^C as copy when text is
    // selected; we override only when nothing is selected, so a user
    // can still copy from the transcript.)
    if (event.key === 'c' && event.ctrlKey && !event.metaKey && !event.altKey) {
      const sel = doc.getSelection();
      const hasSelection = sel !== null && sel.toString() !== '';
      if (!hasSelection) {
        event.preventDefault();
        sendInterrupt();
        return;
      }
    }
    // C-d — close stdin (only at an empty input line, otherwise this
    // is a forward-delete on most terminals; we don't implement that
    // in v1, so we treat C-d at non-empty as a no-op).
    if (event.key === 'd' && event.ctrlKey && !event.metaKey && !event.altKey) {
      if (input.value === '') {
        event.preventDefault();
        endSession();
        return;
      }
    }
  });

  // Key handling on the root: chord keys (when input is NOT focused)
  // route through the Lisp keymap, the same way the directory-tree
  // view passes them. The input itself handles plain typing.
  root.addEventListener('keydown', (event) => {
    if (event.target === input) return; // input handles its own keys
    if (MODIFIERS.has(event.key)) return;
    if (FORM_TAGS.has(event.target.tagName)) return;
    const key = keyEventToString(event);
    if (onKey && onKey(key)) event.preventDefault();
  });

  // Clicks in the view's body refocus the input — a familiar terminal
  // behaviour. We don't intercept clicks inside the transcript because
  // the user wants to be able to select-and-copy from it.
  root.addEventListener('click', (event) => {
    if (event.target === root || event.target === header || event.target === inputRow) {
      input.focus();
    }
  });

  /** Show a shell buffer. Spawns its child process on first mount if
   *  one isn't already running for the buffer's sessionId. */
  function setBuffer(next) {
    buffer = next;
    if (!buffer) {
      transcriptEl.replaceChildren();
      headerLabel.textContent = 'shell';
      input.value = '';
      input.disabled = false;
      input.placeholder = '';
      return;
    }
    headerLabel.textContent = buffer.name ?? 'shell';
    if (!Array.isArray(buffer.transcript)) buffer.transcript = [];
    repaintTranscript();
    input.disabled = !!buffer.ended;
    input.placeholder = buffer.ended ? 'session ended' : '';
    input.value = '';
    historyIndex = (histories.get(buffer.sessionId) ?? []).length;
    // First-time mount: spawn the process if the buffer doesn't carry
    // a `spawned` flag yet. The flag is per-buffer so a tab-switch
    // doesn't re-spawn.
    if (!buffer.spawned && !buffer.ended && spawnFn) {
      buffer.spawned = true;
      spawnFn(buffer.sessionId, { cwd: buffer.cwd })
        .then((result) => {
          if (!result || !result.ok) {
            appendEntry({
              kind: 'stderr',
              text: `[spawn failed: ${result?.error ?? 'unknown'}]\n`,
            });
            buffer.ended = true;
            input.disabled = true;
            input.placeholder = 'session ended';
          } else if (typeof result.shell === 'string') {
            appendEntry({
              kind: 'exit',
              text: `[${result.shell}${result.pid ? ` pid ${result.pid}` : ''}]\n`,
            });
          }
        })
        .catch((error) => {
          appendEntry({
            kind: 'stderr',
            text: `[spawn failed: ${error.message}]\n`,
          });
          buffer.ended = true;
          input.disabled = true;
          input.placeholder = 'session ended';
        });
    }
    scrollToBottom();
  }

  // Wire the streaming subscriptions. They stay live for the life of
  // the view — events filter by sessionId so other buffers' chatter
  // doesn't leak in. The unsubscribe handles are saved for destroy.
  if (typeof options.onData === 'function') {
    unsubscribeData = options.onData(onData);
  }
  if (typeof options.onExit === 'function') {
    unsubscribeExit = options.onExit(onExit);
  }

  return {
    element: root,
    setBuffer,
    focus: () => input.focus(),
    destroy: () => {
      if (typeof unsubscribeData === 'function') unsubscribeData();
      if (typeof unsubscribeExit === 'function') unsubscribeExit();
      unsubscribeData = null;
      unsubscribeExit = null;
    },
  };
}
