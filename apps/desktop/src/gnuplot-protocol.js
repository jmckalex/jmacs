/**
 * @file Pure, DOM-free, Electron-free logic for the gnuplot notebook
 * protocol. Everything that can be reasoned about without a live
 * subprocess lives here so it can be unit-tested under a plain
 * `node --test` (which cannot resolve `@editor/*` workspace packages or
 * spin up Electron).
 *
 * Two concerns live here:
 *
 *   1. **Submission framing** — wrapping a user's gnuplot command in the
 *      preamble/epilogue that (a) routes the plot to a temp SVG file,
 *      (b) applies the dark theme, and (c) emits the stdout/stderr
 *      sentinels that tell the host "this submission is done".
 *
 *   2. **Stream demultiplexing** — a small state machine that consumes
 *      stdout/stderr chunks line-by-line and, once both sentinels for a
 *      submission have arrived, yields the collected text/error for that
 *      submission. The host pairs that with a `stat`/read of the temp
 *      SVG to decide whether a plot was produced.
 *
 * See the protocol spec in the build brief: one persistent gnuplot in
 * pipe mode, strictly-serialized submissions, completion gated on BOTH
 * sentinels.
 */

/** The dark-theme `set` block, applied per submission after `set output`
 *  and before the user's command. Colours chosen to read on a dark page;
 *  `set linetype` redefinitions (rather than the deprecated `set style
 *  increment`) so a bare `plot sin(x), cos(x)` picks up the palette. */
export const DARK_THEME_BLOCK = [
  "set border lc rgb '#7f8c98'",
  "set xtics textcolor rgb '#aeb6c0'",
  "set ytics textcolor rgb '#aeb6c0'",
  "set ztics textcolor rgb '#aeb6c0'",
  "set title  textcolor rgb '#e6e9ed'",
  "set xlabel textcolor rgb '#cfd6de'",
  "set ylabel textcolor rgb '#cfd6de'",
  "set key textcolor rgb '#cfd6de'",
  "set grid lc rgb '#3a434d' lw 1",
  "set linetype 1 lc rgb '#5aa9e6' lw 2 pt 7",
  "set linetype 2 lc rgb '#f78c6b' lw 2 pt 7",
  "set linetype 3 lc rgb '#7ed491' lw 2 pt 7",
  "set linetype 4 lc rgb '#c792ea' lw 2 pt 7",
  "set linetype 5 lc rgb '#ffcb6b' lw 2 pt 7",
  "set linetype 6 lc rgb '#ff6b8a' lw 2 pt 7",
].join('\n');

/** The page background baked into the SVG itself, so the plot is a
 *  self-contained dark image that doesn't depend on the host page's CSS.
 *  Slightly darker than `--bg-editor` (#2e3842) for contrast. */
export const SVG_BACKGROUND = '#1e2228';

/** A real gnuplot SVG with at least one drawn element runs to several KB;
 *  a header-only file from a `set`-only submission is a few hundred bytes
 *  at most. Used as a cheap first gate before the substring check. */
export const EMPTY_SVG_THRESHOLD = 512;

/**
 * Quote a string as a single-quoted gnuplot literal, doubling embedded
 * single quotes. gnuplot's single-quoted strings do not interpret
 * backslash escapes, so this is the safe quoting for file paths and
 * sentinel tokens.
 *
 * @param {string} s
 * @returns {string}
 */
export function quoteGnuplot(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * The sentinel tokens for a submission. Long, with a private prefix, plus
 * the submission id and a random nonce, so they're vanishingly unlikely
 * to collide with real user output.
 *
 * @param {string|number} id - The submission id.
 * @param {string} nonce - A random token unique to this submission.
 * @returns {{ stdout: string, stderr: string }}
 */
export function sentinelsFor(id, nonce) {
  return {
    stdout: `__JMACS_GP_DONE__${id}__${nonce}__`,
    stderr: `__JMACS_GP_ERR__${id}__${nonce}__`,
  };
}

/**
 * Build the full program text written to gnuplot's stdin for one
 * submission. Trailing newline included so the last `print` actually
 * executes (gnuplot is line-oriented).
 *
 * The sequence:
 *   set terminal svg ...        — dark, self-contained SVG generator
 *   set output '<tmpFile>'      — redirect plot bytes to the temp file
 *   <dark theme block>          — palette / axis colours
 *   <user text>                 — verbatim, unmodified
 *   unset output                — flush + close the SVG (mandatory)
 *   set print '-'               — force `print` to stdout
 *   print '<stdout sentinel>'   — "submission complete"
 *   set print '/dev/stderr'     — route `print` to stderr (fd 2)
 *   print '<stderr sentinel>'   — "all stderr for this submission flushed"
 *   set print '-'               — restore stdout for the next submission
 *
 * @param {object} params
 * @param {string} params.userText - The user's gnuplot command(s).
 * @param {string} params.tmpFile - Absolute path of the temp SVG.
 * @param {string} params.sentinelOut - The stdout sentinel token.
 * @param {string} params.sentinelErr - The stderr sentinel token.
 * @param {number} [params.width=720] - SVG canvas width.
 * @param {number} [params.height=480] - SVG canvas height.
 * @returns {string}
 */
export function buildSubmission(params) {
  const {
    userText,
    tmpFile,
    sentinelOut,
    sentinelErr,
    width = 720,
    height = 480,
  } = params;
  const term =
    `set terminal svg size ${width},${height} dynamic enhanced ` +
    `background rgb '${SVG_BACKGROUND}' font 'sans,11'`;
  return [
    term,
    `set output ${quoteGnuplot(tmpFile)}`,
    DARK_THEME_BLOCK,
    userText,
    'unset output',
    "set print '-'",
    `print ${quoteGnuplot(sentinelOut)}`,
    // gnuplot routes `print` to stderr via the /dev/stderr device. NOT
    // `set print '-2'` — that opens a FILE literally named "-2" (verified
    // against gnuplot 6), so the stderr sentinel would never reach the
    // host and the submission would hang. `'-'` is stdout; `/dev/stderr`
    // is fd 2 on macOS/Linux.
    "set print '/dev/stderr'",
    `print ${quoteGnuplot(sentinelErr)}`,
    "set print '-'",
    '', // trailing newline
  ].join('\n');
}

/**
 * Decide whether an SVG file's bytes represent an actual plot (vs an
 * empty / header-only file from a `set`-only submission).
 *
 * @param {object} stat
 * @param {number} stat.size - The file's byte length.
 * @param {string} text - The file's contents (utf-8).
 * @returns {boolean}
 */
export function svgHasPlot(stat, text) {
  if (!stat || typeof stat.size !== 'number') return false;
  if (stat.size <= EMPTY_SVG_THRESHOLD) return false;
  if (typeof text !== 'string') return false;
  if (!text.includes('</svg>')) return false;
  return /<(path|rect|polyline|circle|image|use|text)\b/.test(text);
}

/**
 * A stream demultiplexer for one gnuplot process. Feed it stdout and
 * stderr chunks (in any interleaving) plus the active submission's
 * sentinels; it collects the text/error lines for that submission and,
 * once BOTH sentinels have arrived, calls `onComplete` with the
 * collected `{ stdout, stderr }`.
 *
 * The demux holds no DOM and no subprocess handle — it's a pure reducer
 * over byte chunks, which is exactly what makes the framing logic
 * unit-testable without gnuplot installed.
 *
 * Usage:
 *   const demux = new SubmissionDemux();
 *   demux.begin({ sentinelOut, sentinelErr, onComplete });
 *   demux.pushStdout(chunk);   // repeatedly, as chunks arrive
 *   demux.pushStderr(chunk);
 *   // onComplete({ stdout, stderr }) fires once both sentinels seen.
 */
export class SubmissionDemux {
  constructor() {
    /** @type {string} Partial stdout line not yet terminated by \n. */
    this._outBuf = '';
    /** @type {string} Partial stderr line not yet terminated by \n. */
    this._errBuf = '';
    /** @type {object|null} The active submission's framing. */
    this._active = null;
  }

  /**
   * Start collecting output for a new submission. Resets the per-
   * submission line accumulators but preserves any partial-line bytes
   * already buffered (those belong to the new submission — gnuplot
   * processes the stream in order, so nothing arrives for a submission
   * before its program is written).
   *
   * @param {object} params
   * @param {string} params.sentinelOut
   * @param {string} params.sentinelErr
   * @param {(result: { stdout: string, stderr: string }) => void} params.onComplete
   */
  begin(params) {
    this._active = {
      sentinelOut: params.sentinelOut,
      sentinelErr: params.sentinelErr,
      onComplete: params.onComplete,
      stdoutLines: [],
      stderrLines: [],
      gotOut: false,
      gotErr: false,
    };
  }

  /** True while a submission is in flight. */
  get busy() {
    return this._active !== null;
  }

  /**
   * Feed a stdout chunk. Splits on `\n`; the sentinel line is consumed
   * (not collected); every other complete line is appended to the
   * submission's stdout. Triggers completion if both sentinels are in.
   *
   * @param {string} chunk
   */
  pushStdout(chunk) {
    this._outBuf += chunk;
    let nl;
    while ((nl = this._outBuf.indexOf('\n')) !== -1) {
      const line = this._outBuf.slice(0, nl);
      this._outBuf = this._outBuf.slice(nl + 1);
      const a = this._active;
      if (a && line === a.sentinelOut) {
        a.gotOut = true;
        this._maybeFinish();
      } else if (a) {
        a.stdoutLines.push(line);
      }
    }
  }

  /**
   * Feed a stderr chunk. Same line-splitting; the stderr sentinel is
   * consumed; everything else is the submission's error text.
   *
   * @param {string} chunk
   */
  pushStderr(chunk) {
    this._errBuf += chunk;
    let nl;
    while ((nl = this._errBuf.indexOf('\n')) !== -1) {
      const line = this._errBuf.slice(0, nl);
      this._errBuf = this._errBuf.slice(nl + 1);
      const a = this._active;
      if (a && line === a.sentinelErr) {
        a.gotErr = true;
        this._maybeFinish();
      } else if (a) {
        a.stderrLines.push(line);
      }
    }
  }

  /** Fire `onComplete` once both sentinels have arrived, then clear the
   *  active submission so the next `begin` starts clean. */
  _maybeFinish() {
    const a = this._active;
    if (!a || !a.gotOut || !a.gotErr) return;
    this._active = null;
    a.onComplete({
      stdout: a.stdoutLines.join('\n'),
      stderr: a.stderrLines.join('\n'),
    });
  }
}
