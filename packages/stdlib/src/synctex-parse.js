/**
 * @file synctex-parse.js — pure parsers for the `synctex` CLI's
 * forward (`view`) and inverse (`edit`) output.
 *
 * SyncTeX (Jérôme Laurens' synchronisation technology, shipped with TeX
 * Live as the `synctex` CLI) maps between a `.tex` source position and a
 * spot in the typeset PDF. We drive it over `run-process!` and parse its
 * plain-text stdout here, away from any host dependency, so the parsing
 * is unit-testable.
 *
 * Both subcommands print a small set of `Key:Value` lines, optionally
 * wrapped in `SyncTeX result begin` / `SyncTeX result end` framing and
 * interleaved with informational lines we ignore. `view` can emit
 * several records (one per box that matches the source position); we
 * keep the first, which is the most specific hit. All coordinates are
 * in PDF points (1/72 inch), origin at the page's top-left as SyncTeX
 * reports them; `Page` is 1-based.
 */

/**
 * The first matching box from a `synctex view -i L:C:file -o out.pdf`
 * run, or `null` when stdout carries no parsable record.
 *
 * @typedef {object} SynctexViewBox
 * @property {number} page - 1-based page the box is on.
 * @property {number} x - Click-point x (PDF points).
 * @property {number} y - Click-point y (PDF points).
 * @property {number} h - Box left edge (PDF points) — the highlight anchor.
 * @property {number} v - Box baseline / bottom (PDF points).
 * @property {number} W - Box width (PDF points).
 * @property {number} H - Box height (PDF points).
 */

/**
 * Read a `Key:value` line into `[key, value]`, trimming surrounding
 * whitespace. Returns `null` for a line with no colon. SyncTeX keys are
 * single tokens (`Page`, `x`, `h`, `Input`, `Line`, …) so we split on
 * the FIRST colon only — an `Input:` path may itself contain colons
 * (rare on POSIX, but cheap to be safe about).
 *
 * @param {string} line
 * @returns {[string, string] | null}
 */
function splitKeyValue(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
}

/**
 * Parse `synctex view` stdout into the first box, or `null`.
 *
 * `synctex view` prints zero or more records like:
 *
 *     SyncTeX result begin
 *     Output:out.pdf
 *     Page:3
 *     x:123.4
 *     y:56.7
 *     h:120.0
 *     v:650.0
 *     W:300.0
 *     H:12.0
 *     ...
 *     SyncTeX result end
 *
 * A fresh `Page:` line starts a new record; we return the first record
 * that carries a page plus position. The parse tolerates the framing
 * lines, extra/unknown keys, blank lines, and CRLF endings. Missing
 * numeric fields default to 0 (so a record with a `Page` but no `W`/`H`
 * still yields a usable point, just a zero-size box).
 *
 * @param {string} stdout - The raw stdout of the `synctex view` run.
 * @returns {SynctexViewBox | null}
 */
export function parseSynctexView(stdout) {
  if (typeof stdout !== 'string' || stdout === '') return null;
  const lines = stdout.split(/\r?\n/);

  /** @type {Partial<SynctexViewBox> | null} */
  let current = null;

  const finalize = (rec) => {
    if (rec === null || typeof rec.page !== 'number') return null;
    return {
      page: rec.page,
      x: rec.x ?? 0,
      y: rec.y ?? 0,
      h: rec.h ?? 0,
      v: rec.v ?? 0,
      W: rec.W ?? 0,
      H: rec.H ?? 0,
    };
  };

  for (const line of lines) {
    const kv = splitKeyValue(line);
    if (kv === null) continue;
    const [key, value] = kv;
    if (key === 'Page') {
      // A new record begins. If we already have a complete one, that
      // first record is the answer — return it without scanning on.
      if (current !== null && typeof current.page === 'number') {
        return finalize(current);
      }
      const page = Number.parseInt(value, 10);
      current = Number.isFinite(page) ? { page } : null;
      continue;
    }
    if (current === null) continue;
    switch (key) {
      case 'x': current.x = Number.parseFloat(value); break;
      case 'y': current.y = Number.parseFloat(value); break;
      case 'h': current.h = Number.parseFloat(value); break;
      case 'v': current.v = Number.parseFloat(value); break;
      case 'W': current.W = Number.parseFloat(value); break;
      case 'H': current.H = Number.parseFloat(value); break;
      default: break;
    }
  }
  return finalize(current);
}

/**
 * The source position from a `synctex edit -o P:x:y:out.pdf` run.
 *
 * @typedef {object} SynctexEditResult
 * @property {string} file - Absolute path of the source file (`Input:`).
 * @property {number} line - 1-based source line (`Line:`).
 * @property {number} column - Source column (`Column:`); -1 when unknown.
 */

/**
 * Parse `synctex edit` stdout into the source position, or `null`.
 *
 * `synctex edit` prints:
 *
 *     SyncTeX result begin
 *     Output:out.pdf
 *     Input:/abs/path/main.tex
 *     Line:42
 *     Column:-1
 *     ...
 *     SyncTeX result end
 *
 * We return the FIRST `Input:`/`Line:` pair. A record needs at least an
 * `Input` and a finite `Line` to be usable; absent either, the result
 * is `null`. `Column` defaults to -1 (SyncTeX's "unknown") when missing.
 *
 * @param {string} stdout - The raw stdout of the `synctex edit` run.
 * @returns {SynctexEditResult | null}
 */
export function parseSynctexEdit(stdout) {
  if (typeof stdout !== 'string' || stdout === '') return null;
  const lines = stdout.split(/\r?\n/);

  /** @type {string | null} */
  let file = null;
  /** @type {number | null} */
  let line = null;
  let column = -1;

  for (const raw of lines) {
    const kv = splitKeyValue(raw);
    if (kv === null) continue;
    const [key, value] = kv;
    if (key === 'Input' && file === null) {
      file = value;
    } else if (key === 'Line' && line === null) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) line = n;
    } else if (key === 'Column' && column === -1) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) column = n;
    }
  }

  if (file === null || line === null) return null;
  return { file, line, column };
}
