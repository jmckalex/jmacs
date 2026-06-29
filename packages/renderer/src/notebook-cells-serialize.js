/**
 * @file Pure (no-DOM) serialization helpers for the cell notebook.
 *
 * The canonical text form of a notebook is its cells separated by a fence
 * line — `// @cell [name]` then the cell source. This is the on-disk /
 * buffer form: a notebook saves its *arrangement*; cell results are
 * runtime-only. `notebook-cells-view.js` uses these to save (`serializeNotebook`)
 * and open (`parseNotebook`) a notebook, and to render the per-cell status
 * badge (`badgeForResult`).
 *
 * These were extracted verbatim from the retired `notebook-js-view.js`
 * when the JS-notebook view was removed; `notebook-cells` is the sole
 * remaining consumer, so the helpers now live here, unit-tested in Node.
 */

let cellSeq = 0;

/**
 * Mint a stable, process-unique cell id.
 * @returns {string}
 */
function nextCellId() {
  cellSeq += 1;
  return `c${cellSeq}`;
}

/**
 * Build a fresh cell model.
 *
 * @param {{id?: string, name?: string, source?: string}} [init]
 * @returns {{id: string, name: string, source: string, result: null}}
 */
function makeCell(init = {}) {
  return {
    id: init.id || nextCellId(),
    name: init.name || '',
    source: init.source || '',
    result: null,
  };
}

/**
 * Map a cell result record to a small status badge descriptor (glyph +
 * css class + tooltip). Pure so it's testable without a DOM.
 *
 * @param {{state: string, error?: {message: string}}|null} result
 * @returns {{glyph: string, cls: string, title: string}}
 */
export function badgeForResult(result) {
  if (!result) return { glyph: '◌', cls: 'nbjs-badge-idle', title: 'not run' };
  if (result.state === 'running') {
    return { glyph: '⟳', cls: 'nbjs-badge-running', title: 'running…' };
  }
  if (result.state === 'error') {
    return {
      glyph: '✕',
      cls: 'nbjs-badge-error',
      title: result.error?.message || 'error',
    };
  }
  return { glyph: '●', cls: 'nbjs-badge-ok', title: 'ok' };
}

/**
 * The canonical text serialization of a notebook: cells separated by a
 * fence line. Each cell is `// @cell [name]` then its source. This is the
 * on-disk / buffer form; cell results are runtime-only.
 *
 * @param {Array<{name: string, source: string}>} cells
 * @returns {string}
 */
export function serializeNotebook(cells) {
  return cells
    .map((c) => {
      const header = c.name ? `// @cell ${c.name}` : '// @cell';
      return `${header}\n${c.source}`;
    })
    .join('\n\n');
}

/**
 * Parse the canonical text serialization back into cell models. A line
 * matching `// @cell [name]` starts a new cell; everything until the next
 * such line (or EOF) is that cell's source (trimmed of one trailing
 * blank line). Text before the first fence is ignored. An empty / fence-
 * less source yields a single empty cell so the view is never blank.
 *
 * @param {string} text
 * @returns {Array<{id: string, name: string, source: string, result: null}>}
 */
export function parseNotebook(text) {
  const lines = String(text ?? '').split('\n');
  const cells = [];
  let current = null;
  for (const line of lines) {
    const m = /^\/\/\s*@cell(?:\s+(\S.*))?$/.exec(line);
    if (m) {
      if (current) cells.push(finishCell(current));
      current = { name: (m[1] || '').trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) cells.push(finishCell(current));
  if (cells.length === 0) return [makeCell()];
  return cells;
}

/**
 * @param {{name: string, body: string[]}} c
 * @returns {{id: string, name: string, source: string, result: null}}
 */
function finishCell(c) {
  let body = c.body.join('\n');
  body = body.replace(/^\n+/, '').replace(/\n+$/, '');
  return makeCell({ name: c.name, source: body });
}
