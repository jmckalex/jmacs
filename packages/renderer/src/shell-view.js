/**
 * @file The shell view — a `shell`-kind buffer is shown through this
 * view. Each shell buffer owns one long-lived child process running
 * the user's default shell ($SHELL, falling back to /bin/zsh). The
 * view is laid out like a real terminal: the transcript fills the
 * pane, and at the bottom of it the cursor sits next to the shell's
 * partial last line (typically a prompt like `$ `). The user types
 * directly into that position; pressing Enter commits the typed line
 * to the transcript and sends it to the shell.
 *
 * v3 (this revision):
 *   - No separate input bar at the bottom. Input is a contenteditable
 *     span that visually sits inline with the shell's last partial
 *     line, like the cursor in iTerm/Terminal.app.
 *   - Streaming output goes through a tiny single-line terminal
 *     emulator: `\n` finalises a line into the transcript, `\r`
 *     rewinds the current line to col 0 (so zsh's PROMPT_SP `%`
 *     artefact and progress-bar redraws disappear correctly), `\b`
 *     deletes the previous character.
 *   - The shell is spawned with tty ECHO disabled — we render the
 *     user's typed line ourselves on Enter; the shell's stdout
 *     contains only command output and the prompt.
 *
 * v2 carried over:
 *   - Per-session ANSI parser instance (SGR colour state is sticky
 *     across chunks).
 *   - Per-session command history (ArrowUp / ArrowDown).
 *   - C-c sends SIGINT (only when nothing is selected, so copy still
 *     works). C-d at an empty input line ends the session.
 *
 * Buffer shape (v3):
 *
 *   { kind: 'shell',
 *     name: '*shell*',
 *     sessionId: 'shell-<n>',
 *     transcript: Array<{ kind: 'input' | 'stdout' | 'stderr' | 'exit',
 *                          runs: Array<{ text, style }> }>,
 *     pty: boolean | undefined,
 *     ended: boolean }
 *
 * The buffer carries the transcript so a buffer switch and switch-back
 * preserves the user's history. The transcript holds *completed* lines
 * only; the in-progress partial line is per-session view state, not
 * persisted (a tab switch resets the partial — the next chunk will
 * repopulate it).
 *
 * v3 limits (still):
 *   - No curses apps. Cursor-positioning escapes (ESC[…H, ESC[…A/B/C/D)
 *     are consumed by the ANSI parser and dropped, so full-screen TUIs
 *     (`vi`, `htop`, `less +F`) won't render. The transcript is a
 *     stream model, not a terminal grid.
 *   - No SIGWINCH resize. The pty opens at 80×24 and never resizes.
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
 *   - shell-fg-<name>, shell-bg-<name> for the 16 standard colours.
 *   - shell-fg-256-<N>, shell-bg-256-<N> for 256-colour.
 *   - shell-bold, shell-italic, shell-underline, shell-inverse for
 *     attribute flags.
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
 * Feed a list of ANSI-parsed runs through the single-line terminal
 * emulator. Splits at `\n` (which flushes the current line as a
 * completed line), honours `\r` (rewind to col 0 — clears the current
 * line state), and `\b` (backspace — drops the previous char).
 *
 * State persists across calls so a half-prompt arriving in chunk 1
 * and the rest in chunk 2 still composes correctly. Style information
 * flows with the text: each run carries its SGR state, and after a
 * `\r` the cleared line picks up the new style from whatever follows.
 *
 * Exported for testing.
 *
 * @param {{runs: Array<{text: string, style: object | null}>}} state
 * @param {Array<{text: string, style: object | null}>} incoming
 * @returns {{ completed: Array<Array<{text: string, style: object | null}>> }}
 */
export function feedLiveLine(state, incoming) {
  const completed = [];
  for (const run of incoming) {
    const text = typeof run.text === 'string' ? run.text : '';
    const style = run.style ?? null;
    if (text === '') continue;
    let i = 0;
    while (i < text.length) {
      // Scan for the next control char (\n, \r, \b).
      let j = i;
      while (j < text.length) {
        const code = text.charCodeAt(j);
        if (code === 10 || code === 13 || code === 8) break;
        j += 1;
      }
      if (j > i) {
        state.runs.push({ text: text.slice(i, j), style });
      }
      if (j >= text.length) break;
      const code = text.charCodeAt(j);
      if (code === 10) {
        // \n — flush
        completed.push(state.runs);
        state.runs = [];
      } else if (code === 13) {
        // \r — rewind to col 0
        state.runs = [];
      } else if (code === 8) {
        // \b — drop the last char
        trimLastChar(state.runs);
      }
      i = j + 1;
    }
  }
  return { completed };
}

/** In-place: drop the trailing character from a runs list. */
function trimLastChar(runs) {
  while (runs.length > 0) {
    const last = runs[runs.length - 1];
    if (last.text.length > 1) {
      runs[runs.length - 1] = {
        text: last.text.slice(0, -1),
        style: last.style,
      };
      return;
    }
    runs.pop();
    if (last.text.length === 1) return;
  }
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
  const headerBacking = doc.createElement('span');
  headerBacking.className = 'shell-header-backing';
  headerBacking.textContent = '';
  header.append(headerIcon, headerLabel, headerBacking);
  root.append(header);

  // The transcript fills the pane. Inside it: completed entries above,
  // a live row at the very bottom that contains the partial last line
  // (whatever the shell has emitted since its last `\n`) and the
  // contenteditable where the user types. The live row is always the
  // last child — new completed lines insert before it.
  const transcriptEl = doc.createElement('div');
  transcriptEl.className = 'shell-transcript';
  root.append(transcriptEl);

  const liveRow = doc.createElement('div');
  liveRow.className = 'shell-live-row';
  const livePartial = doc.createElement('span');
  livePartial.className = 'shell-live-partial';
  const liveInput = doc.createElement('span');
  liveInput.className = 'shell-live-input';
  liveInput.contentEditable = 'plaintext-only';
  liveInput.spellcheck = false;
  liveInput.setAttribute('autocapitalize', 'off');
  liveInput.setAttribute('autocomplete', 'off');
  liveInput.setAttribute('autocorrect', 'off');
  liveInput.setAttribute('aria-label', 'Shell input');
  liveRow.append(livePartial, liveInput);
  transcriptEl.append(liveRow);

  /** Buffer currently shown, or null. */
  let buffer = null;

  /** Unsubscribe handles for the data / exit streams. */
  let unsubscribeData = null;
  let unsubscribeExit = null;

  /** Per-buffer command history. Keyed by sessionId. */
  const histories = new Map();
  let historyIndex = 0;

  /** Per-buffer ANSI parser state. Each session has its own parser
   *  because SGR state is per-process. */
  const parsers = new Map();

  function parserFor(sessionId) {
    let parser = parsers.get(sessionId);
    if (!parser) {
      parser = createAnsiParser();
      parsers.set(sessionId, parser);
    }
    return parser;
  }

  /** Per-buffer live-line state. Tracks the current partial last line
   *  as a list of styled runs. CR rewinds it; LF flushes it to the
   *  transcript. */
  const liveLines = new Map();

  function liveLineFor(sessionId) {
    let state = liveLines.get(sessionId);
    if (!state) {
      state = { runs: [] };
      liveLines.set(sessionId, state);
    }
    return state;
  }

  /** Update the [pty] / [pipe] header adornment. */
  function refreshBackingLabel() {
    if (!buffer || buffer.pty === undefined) {
      headerBacking.textContent = '';
      return;
    }
    headerBacking.textContent = buffer.pty ? '[pty]' : '[pipe]';
  }

  /** Build the DOM for one completed transcript entry. */
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

  /** Replace the partial-line element from a runs list. */
  function renderPartial(runs) {
    livePartial.replaceChildren();
    if (!Array.isArray(runs)) return;
    for (const run of runs) {
      if (typeof run.text !== 'string' || run.text === '') continue;
      livePartial.append(buildRunNode(doc, run));
    }
  }

  /** Drop the oldest entries so the transcript fits the cap. */
  function trimTranscript(transcript) {
    if (transcript.length <= TRANSCRIPT_MAX) return transcript;
    const overflow = transcript.length - TRANSCRIPT_MAX;
    return transcript.slice(overflow);
  }

  /** Append a completed transcript entry — inserts BEFORE the live row
   *  so the input cursor stays at the visual bottom. */
  function appendEntry(entry) {
    if (!buffer) return;
    if (!Array.isArray(buffer.transcript)) buffer.transcript = [];
    buffer.transcript.push(entry);
    transcriptEl.insertBefore(buildEntryElement(entry), liveRow);
    if (buffer.transcript.length > TRANSCRIPT_MAX) {
      buffer.transcript = trimTranscript(buffer.transcript);
      repaintTranscript();
    }
    scrollToBottom();
  }

  /** Append a plain-text completed entry (no SGR). For diagnostics. */
  function appendPlain(kind, text) {
    appendEntry({ kind, runs: [{ text, style: null }] });
  }

  /** Rebuild the transcript DOM from `buffer.transcript`. The live row
   *  stays where it is — only the completed entries above it get
   *  recreated. */
  function repaintTranscript() {
    // Remove every child of transcriptEl except the live row.
    while (transcriptEl.firstChild && transcriptEl.firstChild !== liveRow) {
      transcriptEl.removeChild(transcriptEl.firstChild);
    }
    if (!buffer || !Array.isArray(buffer.transcript)) return;
    for (const entry of buffer.transcript) {
      transcriptEl.insertBefore(buildEntryElement(entry), liveRow);
    }
  }

  function scrollToBottom() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  /** Handle a streamed-data event from the host. Filters to the
   *  current buffer's sessionId, runs the chunk through the ANSI
   *  parser, then through the live-line state machine. Completed
   *  lines become finalised entries; the partial line is rendered
   *  in the live-partial span. */
  function onData(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    const text = String(payload.data ?? '');
    if (text === '') return;
    const runs = parserFor(buffer.sessionId).feed(text);
    if (runs.length === 0) return;
    const state = liveLineFor(buffer.sessionId);
    const { completed } = feedLiveLine(state, runs);
    const kind = payload.stream === 'stderr' ? 'stderr' : 'stdout';
    for (const lineRuns of completed) {
      appendEntry({ kind, runs: lineRuns });
    }
    renderPartial(state.runs);
    scrollToBottom();
  }

  /** Handle an exit event for the current buffer's session. */
  function onExit(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    // Flush any in-progress partial line as a completed stdout entry —
    // so the last line the user saw isn't lost when the process exits.
    const state = liveLineFor(buffer.sessionId);
    if (state.runs.length > 0) {
      appendEntry({ kind: 'stdout', runs: state.runs });
      state.runs = [];
      renderPartial([]);
    }
    buffer.ended = true;
    const tag = payload.signal
      ? `[exited on ${payload.signal}]`
      : `[exited${typeof payload.code === 'number' ? ` ${payload.code}` : ''}]`;
    appendPlain('exit', `${tag}`);
    const parser = parsers.get(buffer.sessionId);
    if (parser) parser.reset();
    liveInput.contentEditable = 'false';
  }

  /** Read the typed text from the live-input element. */
  function liveInputText() {
    // `contenteditable=plaintext-only` keeps innerText close to what the
    // user actually typed; we also collapse stray <br>s that Chromium
    // sometimes inserts on Enter.
    return liveInput.textContent ?? '';
  }

  /** Submit the typed line: commit it (prompt + input) as a single
   *  completed entry, clear the partial + the input, send to the shell. */
  async function submitInput() {
    if (!buffer || buffer.ended) return;
    const value = liveInputText();
    liveInput.textContent = '';
    if (value !== '') {
      const history = histories.get(buffer.sessionId) ?? [];
      history.push(value);
      histories.set(buffer.sessionId, history);
      historyIndex = history.length;
    }
    // The committed entry is the shell's partial last line (the prompt)
    // followed by what the user typed. After this the partial is
    // empty — the shell's next chunk will repopulate it.
    const state = liveLineFor(buffer.sessionId);
    const committedRuns = [
      ...state.runs,
      { text: `${value}\n`, style: null },
    ];
    appendEntry({ kind: 'input', runs: committedRuns });
    state.runs = [];
    renderPartial([]);
    if (writeFn) {
      try {
        await writeFn(buffer.sessionId, `${value}\n`);
      } catch (error) {
        appendPlain('stderr', `[write failed: ${error.message}]`);
      }
    }
  }

  /** Send SIGINT to the running command. */
  async function sendInterrupt() {
    if (!buffer || !signalFn) return;
    // Commit any half-typed input as visual feedback (`^C` marker), then
    // clear and signal. Mirrors what a real terminal renders.
    const state = liveLineFor(buffer.sessionId);
    const typed = liveInputText();
    const committedRuns = [
      ...state.runs,
      { text: `${typed}^C\n`, style: null },
    ];
    appendEntry({ kind: 'input', runs: committedRuns });
    state.runs = [];
    renderPartial([]);
    liveInput.textContent = '';
    try {
      await signalFn(buffer.sessionId, 'SIGINT');
    } catch {
      /* the process is gone — exit event will follow if it wasn't already */
    }
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

  /** Place the caret at the very end of the live-input. Called after
   *  every history-driven content change. */
  function caretToEnd() {
    const range = doc.createRange();
    range.selectNodeContents(liveInput);
    range.collapse(false);
    const sel = doc.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // Key handling on the live-input.
  liveInput.addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    ) {
      event.preventDefault();
      submitInput();
      return;
    }
    if (
      event.key === 'ArrowUp' &&
      !event.ctrlKey && !event.metaKey && !event.altKey
    ) {
      event.preventDefault();
      if (!buffer) return;
      const history = histories.get(buffer.sessionId) ?? [];
      if (history.length === 0) return;
      if (historyIndex > 0) historyIndex -= 1;
      liveInput.textContent = history[historyIndex] ?? '';
      caretToEnd();
      return;
    }
    if (
      event.key === 'ArrowDown' &&
      !event.ctrlKey && !event.metaKey && !event.altKey
    ) {
      event.preventDefault();
      if (!buffer) return;
      const history = histories.get(buffer.sessionId) ?? [];
      if (history.length === 0) return;
      historyIndex = Math.min(historyIndex + 1, history.length);
      liveInput.textContent =
        historyIndex >= history.length ? '' : history[historyIndex];
      caretToEnd();
      return;
    }
    // C-c — SIGINT (only when nothing is selected, so copy still works).
    if (
      event.key === 'c' && event.ctrlKey && !event.metaKey && !event.altKey
    ) {
      const sel = doc.getSelection();
      const hasSelection = sel !== null && sel.toString() !== '';
      if (!hasSelection) {
        event.preventDefault();
        sendInterrupt();
        return;
      }
    }
    // C-d at an empty input line — end the session.
    if (
      event.key === 'd' && event.ctrlKey && !event.metaKey && !event.altKey
    ) {
      if (liveInputText() === '') {
        event.preventDefault();
        endSession();
        return;
      }
    }
  });

  // Root-level chord-key pass-through (when the live-input isn't owning
  // the key) routes to the global Lisp keymap, like other views.
  root.addEventListener('keydown', (event) => {
    if (event.target === liveInput) return;
    if (MODIFIERS.has(event.key)) return;
    if (FORM_TAGS.has(event.target.tagName)) return;
    const key = keyEventToString(event);
    if (onKey && onKey(key)) event.preventDefault();
  });

  // Clicks anywhere in the view's chrome refocus the live-input. We
  // don't intercept clicks inside the transcript text — the user wants
  // to select-and-copy from it. The heuristic: refocus only when the
  // click is on the view background, the header, the live-row's
  // padding, or there is no text selection (an empty selection means
  // the click didn't drag any text; refocusing is safe).
  root.addEventListener('mouseup', () => {
    const sel = doc.getSelection();
    if (sel === null || sel.toString() === '') {
      liveInput.focus();
    }
  });

  // The contenteditable's default behaviour for Enter is to insert a
  // <br> or a new <div>. We pre-empt it above with preventDefault, but
  // belt-and-braces: strip any <br>/<div>/<p> that sneaks in (Chromium
  // sometimes does this on paste).
  liveInput.addEventListener('input', () => {
    if (liveInput.querySelector('br, div, p')) {
      const text = liveInputText();
      liveInput.textContent = text;
      caretToEnd();
    }
  });

  /** Show a shell buffer. Spawns its child process on first mount. */
  function setBuffer(next) {
    buffer = next;
    if (!buffer) {
      while (transcriptEl.firstChild && transcriptEl.firstChild !== liveRow) {
        transcriptEl.removeChild(transcriptEl.firstChild);
      }
      headerLabel.textContent = 'shell';
      headerBacking.textContent = '';
      livePartial.replaceChildren();
      liveInput.textContent = '';
      liveInput.contentEditable = 'plaintext-only';
      return;
    }
    headerLabel.textContent = buffer.name ?? 'shell';
    refreshBackingLabel();
    if (!Array.isArray(buffer.transcript)) buffer.transcript = [];
    repaintTranscript();
    // The live partial isn't persisted across switches — it'll be
    // repopulated by the shell's next chunk. Reset the per-session
    // state.runs so we don't carry stale content from another buffer.
    const state = liveLineFor(buffer.sessionId);
    renderPartial(state.runs);
    liveInput.textContent = '';
    liveInput.contentEditable = buffer.ended ? 'false' : 'plaintext-only';
    historyIndex = (histories.get(buffer.sessionId) ?? []).length;
    if (!buffer.spawned && !buffer.ended && spawnFn) {
      buffer.spawned = true;
      spawnFn(buffer.sessionId, { cwd: buffer.cwd })
        .then((result) => {
          if (!result || !result.ok) {
            appendPlain(
              'stderr',
              `[spawn failed: ${result?.error ?? 'unknown'}]`
            );
            buffer.ended = true;
            liveInput.contentEditable = 'false';
          } else {
            buffer.pty = result.pty === true;
            refreshBackingLabel();
            if (typeof result.shell === 'string') {
              appendPlain(
                'exit',
                `[${result.shell}${result.pid ? ` pid ${result.pid}` : ''}` +
                  `${result.pty ? ' pty' : ' pipe'}]`
              );
            }
          }
        })
        .catch((error) => {
          appendPlain('stderr', `[spawn failed: ${error.message}]`);
          buffer.ended = true;
          liveInput.contentEditable = 'false';
        });
    }
    scrollToBottom();
  }

  if (typeof options.onData === 'function') {
    unsubscribeData = options.onData(onData);
  }
  if (typeof options.onExit === 'function') {
    unsubscribeExit = options.onExit(onExit);
  }

  return {
    element: root,
    setBuffer,
    focus: () => liveInput.focus(),
    destroy: () => {
      if (typeof unsubscribeData === 'function') unsubscribeData();
      if (typeof unsubscribeExit === 'function') unsubscribeExit();
      unsubscribeData = null;
      unsubscribeExit = null;
      parsers.clear();
      liveLines.clear();
    },
  };
}
