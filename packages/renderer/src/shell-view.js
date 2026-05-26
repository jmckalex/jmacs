/**
 * @file The shell view — a `shell`-kind buffer is shown through this
 * view. Each shell buffer owns one long-lived child process running
 * the user's default shell ($SHELL, falling back to /bin/zsh). The
 * user types into an input line; pressing Enter sends the line — with
 * a trailing newline — to the shell's stdin. The shell's stdout and
 * stderr stream back as text and are appended to a transcript above
 * the input.
 *
 * v2: under the pty backing the shell emits ANSI escape sequences
 * (colours, bold, prompt-redraw codes). Each session gets its own
 * `createAnsiParser` instance whose `feed(text)` turns chunks into
 * styled runs the view renders as `<span>`s. SGR state is sticky
 * across chunks — a colour code in one packet stays in effect until
 * the next reset, exactly like a real terminal.
 *
 * Buffer shape (v2):
 *
 *   { kind: 'shell',
 *     name: '*shell*',
 *     sessionId: 'shell-<n>',
 *     // each transcript entry stores a kind + a list of styled runs.
 *     transcript: Array<{ kind: 'input' | 'stdout' | 'stderr' | 'exit',
 *                          runs: Array<{ text, style }> }>,
 *     pty: boolean | undefined,
 *     ended: boolean }
 *
 * The buffer carries the transcript so a buffer switch and switch-back
 * preserves the user's history. Transcripts are capped at
 * `TRANSCRIPT_MAX` entries; older entries are trimmed off the top.
 *
 * v2 limits (documented for users):
 *   - No curses apps. Cursor-movement codes are dropped by the parser;
 *     full-screen TUIs (`vi`, `htop`, `less +F`) will get their output
 *     written to the transcript without redraw.
 *   - No SIGWINCH resize. The pty is opened at the helper's default
 *     size (80x24) and never resized.
 *
 * The host hands in callbacks for spawn / write / signal / kill / data
 * streaming; this view does not import preload directly.
 */

import { createAnsiParser } from './ansi.js';
import { keyEventToString } from './keymap.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Tags whose own keyboard handling must not be hijacked. */
const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

/** Cap the transcript at this many entries — past that, drop the oldest
 *  in chunks so the DOM stays manageable on `git log`-sized output. */
const TRANSCRIPT_MAX = 10000;

/**
 * Build a `<span>` for a styled run. The CSS classes the view emits:
 *   - shell-fg-<name>, shell-bg-<name> for the 16 standard colours
 *     (the 8 base + 8 bright). Each binds to a `--ansi-<n>` variable
 *     in styles.css.
 *   - shell-fg-256-<N>, shell-bg-256-<N> for 256-colour. styles.css
 *     ships a static rule for each of 0..255.
 *   - shell-bold, shell-italic, shell-underline, shell-inverse for
 *     the attribute flags.
 *
 * 24-bit RGB has no class — the view sets `style.color` / `background`
 * inline.
 *
 * Default (style === null) returns a plain text node.
 *
 * @param {Document} doc
 * @param {{ text: string, style: object | null }} run
 * @returns {Node}
 */
function buildRunNode(doc, run) {
  if (run.style === null) return doc.createTextNode(run.text);
  const span = doc.createElement('span');
  const classes = [];
  const inline = {};

  if (run.style.fg) {
    const fg = run.style.fg;
    if (fg.mode === 'named') classes.push(`shell-fg-${fg.name}`);
    else if (fg.mode === '256') classes.push(`shell-fg-256-${fg.index}`);
    else if (fg.mode === 'rgb') {
      inline.color = `rgb(${fg.rgb[0]}, ${fg.rgb[1]}, ${fg.rgb[2]})`;
    }
  }
  if (run.style.bg) {
    const bg = run.style.bg;
    if (bg.mode === 'named') classes.push(`shell-bg-${bg.name}`);
    else if (bg.mode === '256') classes.push(`shell-bg-256-${bg.index}`);
    else if (bg.mode === 'rgb') {
      inline.backgroundColor =
        `rgb(${bg.rgb[0]}, ${bg.rgb[1]}, ${bg.rgb[2]})`;
    }
  }
  if (run.style.bold) classes.push('shell-bold');
  if (run.style.italic) classes.push('shell-italic');
  if (run.style.underline) classes.push('shell-underline');
  if (run.style.inverse) classes.push('shell-inverse');

  span.className = classes.join(' ');
  if (inline.color) span.style.color = inline.color;
  if (inline.backgroundColor) span.style.backgroundColor = inline.backgroundColor;
  span.textContent = run.text;
  return span;
}

/**
 * Normalise a chunk of shell output for display. We want CRLF → LF so
 * a transcript pasted from us looks sane, but bare CR mid-stream is a
 * "redraw current line" we can't honour — we replace it with `\n` so
 * the following content lands on a fresh line instead of overwriting.
 * This is a v2 best-effort; full prompt-redraw support is out of scope.
 *
 * @param {string} text
 * @returns {string}
 */
export function normaliseCarriageReturns(text) {
  if (typeof text !== 'string' || text === '') return text;
  // CRLF → LF.
  // A bare CR mid-stream typically rewinds the current line; in a
  // transcript we treat it as a new line so the next output is visible.
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Create a shell view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(sessionId: string, options?: { cwd?: string })
 *   => Promise<{ ok: boolean, shell?: string, pid?: number, pty?: boolean, error?: string }>}
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
  // The pty/pipe adornment — shown to the right of the label so users
  // can see why a session that "should" have colours doesn't. Filled
  // in by setBuffer after the spawn reply lands.
  const headerBacking = doc.createElement('span');
  headerBacking.className = 'shell-header-backing';
  headerBacking.textContent = '';
  header.append(headerIcon, headerLabel, headerBacking);
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

  /** Per-buffer ANSI parser state. Each session has its own parser
   *  because SGR state is per-process — a `git status` colour code in
   *  one shell shouldn't bleed into another. The parser is constructed
   *  lazily on first data; destroyed (= reset) when the session ends. */
  const parsers = new Map();

  function parserFor(sessionId) {
    let parser = parsers.get(sessionId);
    if (!parser) {
      parser = createAnsiParser();
      parsers.set(sessionId, parser);
    }
    return parser;
  }

  /** Update the [pty] / [pipe] header adornment from the buffer's
   *  remembered backing. Called whenever the buffer's `pty` field
   *  changes (initially on spawn, then never). */
  function refreshBackingLabel() {
    if (!buffer || buffer.pty === undefined) {
      headerBacking.textContent = '';
      return;
    }
    headerBacking.textContent = buffer.pty ? '[pty]' : '[pipe]';
  }

  /** Build the DOM for one transcript entry. Each entry now carries a
   *  list of styled runs (rather than a flat string), so the DOM is a
   *  flex-line of `<span>`s. */
  function buildEntryElement(entry) {
    const block = doc.createElement('div');
    block.className = `shell-entry shell-entry-${entry.kind}`;
    if (Array.isArray(entry.runs)) {
      for (const run of entry.runs) {
        block.append(buildRunNode(doc, run));
      }
    }
    return block;
  }

  /** Drop the oldest entries so the transcript fits the cap. */
  function trimTranscript(transcript) {
    if (transcript.length <= TRANSCRIPT_MAX) return transcript;
    const overflow = transcript.length - TRANSCRIPT_MAX;
    return transcript.slice(overflow);
  }

  /** Append a new transcript entry (input / stdout / stderr / exit)
   *  to the buffer's transcript and the DOM, scrolling to the bottom.
   *
   *  v2 doesn't coalesce by kind — each output chunk already carries
   *  multiple styled runs, and we want each chunk to land in its own
   *  block so a SGR change at a chunk boundary doesn't bleed into the
   *  previous block. Input / exit entries are their own row as before. */
  function appendEntry(entry) {
    if (!buffer) return;
    if (!Array.isArray(buffer.transcript)) buffer.transcript = [];

    buffer.transcript.push(entry);
    transcriptEl.append(buildEntryElement(entry));

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
   *  current buffer's sessionId, normalises CRs, then runs the chunk
   *  through the per-session ANSI parser. The resulting `{text,style}`
   *  runs become one transcript entry. */
  function onData(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    const text = normaliseCarriageReturns(String(payload.data ?? ''));
    if (text === '') return;
    const runs = parserFor(buffer.sessionId).feed(text);
    if (runs.length === 0) return;
    const kind = payload.stream === 'stderr' ? 'stderr' : 'stdout';
    appendEntry({ kind, runs });
  }

  /** Append a plain-text transcript entry — no SGR. Used for input
   *  echo, exit notices, and spawn diagnostics. Wrapped in a runs
   *  array so the schema stays uniform. */
  function appendPlain(kind, text) {
    appendEntry({ kind, runs: [{ text, style: null }] });
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
    appendPlain('exit', `\n${tag}\n`);
    // The parser's sticky state is no longer meaningful — drop it.
    const parser = parsers.get(buffer.sessionId);
    if (parser) parser.reset();
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
    // regardless of whether the shell itself echoes (under the pty
    // backing it does echo; under pipes it doesn't).
    appendPlain('input', `${value}\n`);
    if (writeFn) {
      try {
        await writeFn(buffer.sessionId, `${value}\n`);
      } catch (error) {
        appendPlain('stderr', `[write failed: ${error.message}]\n`);
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
    appendPlain('input', '^C\n');
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
    // in v2 either, so we treat C-d at non-empty as a no-op).
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
      headerBacking.textContent = '';
      input.value = '';
      input.disabled = false;
      input.placeholder = '';
      return;
    }
    headerLabel.textContent = buffer.name ?? 'shell';
    refreshBackingLabel();
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
            appendPlain(
              'stderr',
              `[spawn failed: ${result?.error ?? 'unknown'}]\n`
            );
            buffer.ended = true;
            input.disabled = true;
            input.placeholder = 'session ended';
          } else {
            // Remember the backing so a tab switch back here still shows
            // the right [pty]/[pipe] adornment.
            buffer.pty = result.pty === true;
            refreshBackingLabel();
            if (typeof result.shell === 'string') {
              appendPlain(
                'exit',
                `[${result.shell}${result.pid ? ` pid ${result.pid}` : ''}` +
                  `${result.pty ? ' pty' : ' pipe'}]\n`
              );
            }
          }
        })
        .catch((error) => {
          appendPlain('stderr', `[spawn failed: ${error.message}]\n`);
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
      parsers.clear();
    },
  };
}
