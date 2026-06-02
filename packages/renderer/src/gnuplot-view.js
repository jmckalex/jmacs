/**
 * @file The gnuplot view — a `gnuplot`-kind buffer is shown through this
 * view as an interactive notebook REPL. Each gnuplot buffer owns one
 * long-lived `gnuplot` child process (managed by the host); the user
 * types a command at the bottom input line, presses Enter, and the
 * result — an inline SVG plot, text output, or an error — appears as a
 * CELL in the scrolling transcript above.
 *
 * This mirrors the shell view's structure (a `createGnuplotView` factory
 * plus a `GnuplotView extends ViewElement` custom-element wrapper with
 * hide-not-kill lifecycle) but the interaction model is different. The
 * shell streams raw pty bytes into an xterm grid; gnuplot is a notebook
 * where each command produces one result. So instead of an xterm grid
 * the view holds:
 *
 *   - a header (chart icon + buffer name),
 *   - a scrollable transcript of per-command cells, and
 *   - a bottom input line with its own command history (Up/Down).
 *
 * The host frames each submission and sends back one `gnuplot:result`
 * carrying `{ id, svg, text, error }`. The view matches the result to
 * the cell it created for that submission and fills it in.
 *
 * ## Graceful degradation
 *
 * gnuplot is frequently not installed. The host's `onExit` payload then
 * carries `notInstalled: true`; the view replaces the transcript with a
 * friendly install card and disables the input.
 *
 * ## Chord forwarding
 *
 * The input is a plain `<input>`, so the host keymap must still fire
 * while it has focus (C-x b to switch buffers, etc.). A keydown handler
 * forwards non-printing chords through `options.onKey`, exactly like the
 * browser view does for its URL input. Enter and the arrow keys are
 * handled locally (submit / history) and not forwarded.
 *
 * Buffer shape:
 *   { kind: 'gnuplot', name: '*gnuplot*', sessionId: 'gnuplot-<n>',
 *     ended: boolean, spawned: boolean }
 */

import { keyEventToString } from './keymap.js';
import { createHistory } from './gnuplot-history.js';
import { svgWithIntrinsicSize } from './gnuplot-svg.js';

/** The default install card text, used when the host doesn't supply a
 *  message with the not-installed exit. */
const DEFAULT_NOT_INSTALLED =
  'gnuplot is not installed.\n\n' +
  'Install it, then reopen this view:\n' +
  '  macOS:          brew install gnuplot\n' +
  '  Debian/Ubuntu:  sudo apt install gnuplot';

/**
 * Create a gnuplot notebook view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(sessionId: string, options?: { cwd?: string })
 *   => Promise<{ ok: boolean, pid?: number, error?: string }>}
 *   [options.spawn] - Spawn a gnuplot child for `sessionId`.
 * @param {(sessionId: string, data: string) => Promise<{ ok: boolean }>}
 *   [options.write] - Submit a gnuplot command (host appends the newline).
 * @param {(sessionId: string) => Promise<{ ok: boolean }>}
 *   [options.signal] - Send SIGINT (interrupt a running plot).
 * @param {(sessionId: string) => Promise<{ ok: boolean }>}
 *   [options.kill] - Terminate the gnuplot session.
 * @param {(callback: (payload: { sessionId: string, id: number, svg: string|null, text: string, error: string }) => void)
 *   => (() => void)} [options.onResult] - Subscribe to per-submission
 *   results. The returned function unsubscribes.
 * @param {(callback: (payload: { sessionId: string, code: number|null, signal: string|null, notInstalled?: boolean, message?: string }) => void)
 *   => (() => void)} [options.onExit] - Subscribe to exit / not-installed.
 * @param {(key: string) => boolean} [options.onKey] - Chord-key
 *   passthrough so the host keymap fires while the input is focused.
 *   Returns true when the key was consumed.
 * @returns {{
 *   element: HTMLElement,
 *   setBuffer: (buffer: object | null) => void,
 *   focus: () => void,
 *   destroy: () => void,
 *   applyTheme: () => void,
 * }}
 */
function createGnuplotView(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const spawnFn = typeof options.spawn === 'function' ? options.spawn : null;
  const writeFn = typeof options.write === 'function' ? options.write : null;
  const signalFn = typeof options.signal === 'function' ? options.signal : null;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const chordPending =
    typeof options.chordPending === 'function' ? options.chordPending : () => false;
  const exportSvg =
    typeof options.exportSvg === 'function' ? options.exportSvg : null;
  const setTheme =
    typeof options.setTheme === 'function' ? options.setTheme : null;

  const root = doc.createElement('div');
  root.className = 'gnuplot-view';
  root.tabIndex = -1;
  container.append(root);

  // Header: a chart icon + the buffer name.
  const header = doc.createElement('div');
  header.className = 'gnuplot-header';
  const headerIcon = doc.createElement('i');
  headerIcon.className = 'fa-solid fa-chart-line';
  const headerLabel = doc.createElement('span');
  headerLabel.className = 'gnuplot-header-label';
  headerLabel.textContent = 'gnuplot';
  // Theme selector — changes the colours of *subsequent* plots only (the
  // SVG output, not the view chrome). 'Light' is for print/PDF export.
  const themeSelect = doc.createElement('select');
  themeSelect.className = 'gnuplot-theme-select';
  themeSelect.title = 'Plot theme — applies to new plots (re-run to refresh)';
  for (const [value, label] of [['dark', 'Dark'], ['light', 'Light (print)']]) {
    const opt = doc.createElement('option');
    opt.value = value;
    opt.textContent = label;
    themeSelect.append(opt);
  }
  themeSelect.addEventListener('change', () => {
    if (setTheme && buffer && buffer.sessionId) {
      setTheme(buffer.sessionId, themeSelect.value);
    }
  });
  header.append(headerIcon, headerLabel, themeSelect);
  root.append(header);

  // Transcript: a scrolling column of per-command cells.
  const transcriptEl = doc.createElement('div');
  transcriptEl.className = 'gnuplot-transcript';
  root.append(transcriptEl);

  // Input line: a prompt + a plain text input.
  const inputRow = doc.createElement('div');
  inputRow.className = 'gnuplot-input-row';
  const prompt = doc.createElement('span');
  prompt.className = 'gnuplot-prompt';
  prompt.textContent = 'gnuplot>';
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'gnuplot-input';
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.setAttribute('autocomplete', 'off');
  inputRow.append(prompt, input);
  root.append(inputRow);

  /** The buffer currently shown, or null. */
  let buffer = null;
  /** Command history for Up/Down recall. */
  const history = createHistory();
  /** Cells keyed by the submission id the host echoes back, so a result
   *  fills in the cell its command created (results are serialized, but
   *  keying by id is robust regardless). */
  const cellsById = new Map();

  /** Subscription handles, cleared in `destroy()`. */
  let unsubscribeResult = null;
  let unsubscribeExit = null;

  /** Append a text region to a cell, returning the created element. */
  function appendRegion(cell, className, text) {
    const pre = doc.createElement('pre');
    pre.className = className;
    pre.textContent = text;
    cell.append(pre);
    return pre;
  }

  /** Scroll the transcript to the bottom. */
  function scrollToEnd() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  /**
   * Echo a command as a new cell, mark it pending, and submit it to the
   * host. The cell is keyed by the submission id so the matching result
   * can fill it in.
   */
  function runCommand(cmd) {
    if (!buffer || buffer.ended) return;

    const cell = doc.createElement('div');
    cell.className = 'gnuplot-cell gnuplot-cell-pending';
    const echo = doc.createElement('div');
    echo.className = 'gnuplot-cell-command';
    const echoPrompt = doc.createElement('span');
    echoPrompt.className = 'gnuplot-cell-prompt';
    echoPrompt.textContent = 'gnuplot>';
    const echoText = doc.createElement('span');
    echoText.className = 'gnuplot-cell-text';
    echoText.textContent = ` ${cmd}`;
    echo.append(echoPrompt, echoText);
    cell.append(echo);
    transcriptEl.append(cell);
    scrollToEnd();

    // The host's submission counter is 1-based and increments per write;
    // it echoes the id back on the result. We track our own parallel
    // counter so we can key the cell before the result returns.
    buffer.submitCounter = (buffer.submitCounter ?? 0) + 1;
    const id = buffer.submitCounter;
    cellsById.set(id, cell);

    if (writeFn) {
      writeFn(buffer.sessionId, cmd).catch(() => {
        markCellError(cell, '[gnuplot write failed]');
      });
    }
  }

  /** Turn a pending cell into an error cell with the given text. */
  function markCellError(cell, text) {
    cell.classList.remove('gnuplot-cell-pending');
    cell.classList.add('gnuplot-cell-error');
    appendRegion(cell, 'gnuplot-cell-stderr', text);
    scrollToEnd();
  }

  // --- per-plot right-click menu ----------------------------------------

  /** The open context menu element, or null. */
  let menuEl = null;
  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
      doc.removeEventListener('mousedown', onDocMouseDown, true);
    }
  }
  function onDocMouseDown(event) {
    if (menuEl && !menuEl.contains(event.target)) closeMenu();
  }
  function openMenu(clientX, clientY, items) {
    closeMenu();
    const menu = doc.createElement('div');
    menu.className = 'gnuplot-menu';
    for (const item of items) {
      const el = doc.createElement('div');
      el.className = 'gnuplot-menu-item';
      el.textContent = item.label;
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        item.run();
      });
      menu.append(el);
    }
    doc.body.append(menu);
    const rect = menu.getBoundingClientRect();
    const vw = (win && win.innerWidth) || 1024;
    const vh = (win && win.innerHeight) || 768;
    menu.style.left = `${Math.max(4, Math.min(clientX, vw - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(clientY, vh - rect.height - 4))}px`;
    menuEl = menu;
    doc.addEventListener('mousedown', onDocMouseDown, true);
  }

  /** Right-click a plot for a menu: save the SVG to a file, or copy it. */
  function attachPlotMenu(plot, svg, id) {
    plot.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openMenu(event.clientX, event.clientY, [
        {
          label: 'Save plot as…',
          run: () => {
            if (exportSvg) exportSvg(svgWithIntrinsicSize(svg), `plot-${id}.svg`);
          },
        },
        {
          label: 'Copy SVG',
          run: () => {
            const clip = win && win.navigator && win.navigator.clipboard;
            if (clip) clip.writeText(svgWithIntrinsicSize(svg)).catch(() => {});
          },
        },
      ]);
    });
  }

  /** Result callback — fill in the cell its submission created with the
   *  plot / text / error the host produced. */
  function onResult(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    const cell = cellsById.get(payload.id);
    if (!cell) return;
    cellsById.delete(payload.id);
    cell.classList.remove('gnuplot-cell-pending');

    let rendered = false;
    let hasPlot = false;
    // The plot, if any. The SVG is trusted-local (generated by the
    // host's own gnuplot, scripts already stripped main-side); inline it
    // so it scales with the cell.
    if (typeof payload.svg === 'string' && payload.svg !== '') {
      const plot = doc.createElement('div');
      plot.className = 'gnuplot-cell-plot';
      plot.innerHTML = payload.svg;
      attachPlotMenu(plot, payload.svg, payload.id);
      cell.append(plot);
      rendered = true;
      hasPlot = true;
    }
    // Text output (print, show, …).
    if (typeof payload.text === 'string' && payload.text.trim() !== '') {
      appendRegion(cell, 'gnuplot-cell-stdout', payload.text);
      rendered = true;
    }
    // Anything on stderr. When a plot WAS produced, the command succeeded
    // and stderr is just a non-fatal notice — e.g. gnuplot's "Warning:
    // empty y range … adjusting" when you plot a flat line. Show that as a
    // muted warning, not a red error; only stderr with no plot is a real
    // failure.
    if (typeof payload.error === 'string' && payload.error.trim() !== '') {
      if (hasPlot) {
        appendRegion(cell, 'gnuplot-cell-warn', payload.error);
      } else {
        cell.classList.add('gnuplot-cell-error');
        appendRegion(cell, 'gnuplot-cell-stderr', payload.error);
      }
      rendered = true;
    }
    // A bare `set` with no output: show a dim acknowledgement so the
    // cell isn't visually empty.
    if (!rendered) {
      appendRegion(cell, 'gnuplot-cell-empty', '(no output)');
    }
    scrollToEnd();
  }

  /** Exit callback — render the not-installed card, or mark the session
   *  ended. */
  function onExit(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!buffer || payload.sessionId !== buffer.sessionId) return;
    buffer.ended = true;
    if (payload.notInstalled) {
      transcriptEl.replaceChildren();
      cellsById.clear();
      const card = doc.createElement('div');
      card.className = 'gnuplot-not-installed';
      const icon = doc.createElement('i');
      icon.className = 'fa-solid fa-chart-line gnuplot-not-installed-icon';
      const msg = doc.createElement('div');
      msg.className = 'gnuplot-not-installed-text';
      msg.textContent = payload.message ?? DEFAULT_NOT_INSTALLED;
      card.append(icon, msg);
      transcriptEl.append(card);
      input.disabled = true;
      input.placeholder = 'gnuplot unavailable';
      return;
    }
    const tag = payload.signal
      ? `[gnuplot exited on ${payload.signal}]`
      : `[gnuplot exited${
          typeof payload.code === 'number' ? ` ${payload.code}` : ''
        }]`;
    const note = doc.createElement('div');
    note.className = 'gnuplot-exit-note';
    note.textContent = tag;
    transcriptEl.append(note);
    input.disabled = true;
    scrollToEnd();
  }

  // Input handling: Enter submits, Up/Down recall history, C-c sends
  // SIGINT, every other chord forwards to the host keymap.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const cmd = input.value;
      if (cmd.trim() !== '') {
        history.push(cmd);
        runCommand(cmd);
      }
      input.value = '';
      history.reset();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      input.value = history.up(input.value);
      // Park the caret at the end of the recalled line.
      win.requestAnimationFrame(() => {
        input.setSelectionRange(input.value.length, input.value.length);
      });
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      input.value = history.down(input.value);
      win.requestAnimationFrame(() => {
        input.setSelectionRange(input.value.length, input.value.length);
      });
      return;
    }
    // C-c interrupts a running plot (the shell-view analog of SIGINT) —
    // but only at rest. Mid-chord, this C-c is the continuation of a
    // sequence (e.g. C-x C-c = quit), so it must fall through to the
    // forwarding block below rather than be swallowed as an interrupt.
    if (
      !chordPending() &&
      event.key === 'c' &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      if (buffer && signalFn && !buffer.ended) {
        event.preventDefault();
        signalFn(buffer.sessionId);
        return;
      }
    }
    // Forward editor chords (C-x b, M-x, …) to the host keymap — but ONLY
    // keys held with Ctrl or Alt, the Emacs chord modifiers. Plain typing,
    // Backspace, the arrows, Shift, and Cmd-based edits (⌘A/⌘C/⌘V) stay in
    // the input as native text editing. Forwarding a plain key would route
    // it to handle-key, which self-inserts into a buffer this non-text view
    // doesn't have — the "no-buffer-here" error.
    const bareModifier =
      event.key === 'Shift' || event.key === 'Control' ||
      event.key === 'Alt' || event.key === 'Meta';
    // Forward a key to the editor keymap when it's a chord (Ctrl/Alt held)
    // OR when a chord is already mid-flight — so the continuation of a
    // prefix like C-x 3 completes even though `3` carries no modifier.
    if (
      onKey &&
      !bareModifier &&
      (chordPending() || event.ctrlKey || event.altKey)
    ) {
      const key = keyEventToString(event);
      if (key && onKey(key)) {
        event.preventDefault();
      }
    }
  });

  /** Show a gnuplot buffer. Spawns its child on first mount. */
  function setBuffer(next) {
    buffer = next;
    if (!buffer) {
      headerLabel.textContent = 'gnuplot';
      return;
    }
    headerLabel.textContent = buffer.name ?? 'gnuplot';
    if (buffer.ended) {
      input.disabled = true;
    }
    if (!buffer.spawned && !buffer.ended && spawnFn) {
      buffer.spawned = true;
      spawnFn(buffer.sessionId, { cwd: buffer.cwd })
        .then((result) => {
          if (!result || !result.ok) {
            const card = doc.createElement('div');
            card.className = 'gnuplot-exit-note';
            card.textContent = `[spawn failed: ${result?.error ?? 'unknown'}]`;
            transcriptEl.append(card);
            buffer.ended = true;
            input.disabled = true;
          }
        })
        .catch(() => {
          // The host's onExit will surface a not-installed / error
          // payload; nothing extra to do here.
        });
    }
  }

  /** Focus the input so the view is ready to type into. */
  function focusInput() {
    if (!input.disabled) input.focus();
    else root.focus();
  }

  /** Re-theme. The plot SVGs bake their own dark background at render
   *  time, so there's nothing to recompute here; kept for parity with
   *  the singleton view interface. */
  function applyTheme() {
    /* no-op — SVGs are self-themed at render time */
  }

  if (typeof options.onResult === 'function') {
    unsubscribeResult = options.onResult(onResult);
  }
  if (typeof options.onExit === 'function') {
    unsubscribeExit = options.onExit(onExit);
  }

  return {
    element: root,
    setBuffer,
    focus: focusInput,
    applyTheme,
    destroy: () => {
      if (typeof unsubscribeResult === 'function') unsubscribeResult();
      if (typeof unsubscribeExit === 'function') unsubscribeExit();
      unsubscribeResult = null;
      unsubscribeExit = null;
      cellsById.clear();
    },
  };
}

// -----------------------------------------------------------------------
// `<gnuplot-view>` — custom-element wrapper.
//
// Hide-not-kill, like the shell view: a pane → warehouse move fires
// `disconnectedCallback`, but the gnuplot process stays alive so the
// user comes back to their transcript. Only `destroy()` reaps the
// renderer-side resources; the host's kill-view path reaps the process.

import { defineViewElement, ViewElement } from './view-elements.js';

/** @typedef {object} GnuplotViewOptions */

export class GnuplotView extends ViewElement {
  constructor() {
    super();
    /** @type {ReturnType<typeof createGnuplotView> | null} */
    this._inner = null;
    /** @type {GnuplotViewOptions | null} */
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('GnuplotView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'gnuplot';
  }

  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    if (this._inner !== null) this._inner.setBuffer(buffer);
  }

  focus() {
    if (this._inner !== null) this._inner.focus();
    else super.focus();
  }

  applyTheme() {
    if (this._inner !== null) this._inner.applyTheme();
  }

  connectedCallback() {
    if (this._inner !== null) return;
    this._inner = createGnuplotView(this, this._options ?? {});
    if (this._pendingBuffer !== null) this._inner.setBuffer(this._pendingBuffer);
  }

  /** Hide-not-kill — the gnuplot process stays alive; only the DOM-tree
   *  position changed. A later `connectedCallback` finds `_inner` set
   *  and is a no-op. */
  disconnectedCallback() {
    /* intentionally empty */
  }

  /** Explicit teardown: drop the IPC subscriptions. The host's
   *  kill-view path reaps the gnuplot process separately. */
  destroy() {
    if (this._inner !== null) {
      this._inner.destroy();
      this._inner = null;
    }
    this._pendingBuffer = null;
  }
}

defineViewElement('gnuplot-view', GnuplotView);
