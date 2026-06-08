/**
 * @file A generic **output panel** for the utility dock — a read-only,
 * scrollable log that processes and commands stream text into (compile output,
 * process logs, anything line-oriented). It satisfies the utility-panel
 * contract and adds `appendOutput(text)` (streaming append, coalesced into one
 * repaint per frame) and `setContent(text)` (replace).
 *
 * It is non-modal: it owns no keys, so the editor keeps its chords while the
 * log is visible. The user reads/scrolls it and closes it via the tab's ×.
 */

/** Default scrollback cap — older lines are dropped so a chatty process can't
 *  grow the DOM without bound. */
export const DEFAULT_MAX_LINES = 5000;

/**
 * Append CHUNK (which may contain newlines) to LINES and return a new,
 * scrollback-capped array. The last element of LINES is treated as an OPEN
 * (unterminated) line that CHUNK's first segment continues — so streaming a
 * log in arbitrary chunks reconstructs the same lines as one write. Pure.
 *
 * @param {string[]} lines - Prior lines (last one may be open).
 * @param {string} chunk - New text (may contain '\n').
 * @param {number} [maxLines] - Keep at most this many trailing lines.
 * @returns {string[]}
 */
export function appendLines(lines, chunk, maxLines = DEFAULT_MAX_LINES) {
  const out = Array.isArray(lines) && lines.length > 0 ? lines.slice() : [''];
  const parts = (chunk == null ? '' : String(chunk)).split('\n');
  out[out.length - 1] += parts[0];
  for (let i = 1; i < parts.length; i += 1) out.push(parts[i]);
  if (maxLines > 0 && out.length > maxLines) {
    return out.slice(out.length - maxLines);
  }
  return out;
}

/**
 * Create an output panel.
 *
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {string} [options.title]
 * @param {string} [options.icon]
 * @param {boolean} [options.closable]
 * @param {string} [options.text] - Initial content.
 * @param {number} [options.maxLines]
 * @returns {object} the utility-panel contract + appendOutput/setContent.
 */
export function createOutputPanel(options = {}) {
  const doc = options.document ?? globalThis.document;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;

  /** @type {string[]} The current lines (last one may be open). */
  let lines = [''];

  const root = doc.createElement('div');
  root.className = 'utility-output';
  root.tabIndex = -1;
  const log = doc.createElement('div');
  log.className = 'utility-output-log';
  root.append(log);

  let pending = false;
  function paint() {
    pending = false;
    log.textContent = lines.join('\n');
    log.scrollTop = log.scrollHeight;
  }
  /** Coalesce many rapid appends into one repaint per animation frame. */
  function schedulePaint() {
    if (pending) return;
    pending = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paint);
    else paint();
  }

  function appendOutput(text) {
    lines = appendLines(lines, text, maxLines);
    schedulePaint();
  }

  function setContent(text) {
    lines = appendLines([''], text, maxLines);
    paint();
  }

  if (typeof options.text === 'string') setContent(options.text);

  return {
    element: root,
    title: options.title ?? 'Output',
    icon: options.icon ?? 'fa-solid fa-rectangle-list',
    modal: false,
    closable: options.closable ?? true,
    appendOutput,
    setContent,
    focus: () => root.focus(),
    handleKey: () => false,
    destroy: () => root.remove(),
  };
}
