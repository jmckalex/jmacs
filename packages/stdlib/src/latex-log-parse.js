/**
 * @file latex-log-parse.js — a pure parser for pdflatex / latexmk logs.
 *
 * `parseLatexLog(text)` walks a TeX engine's combined stdout/stderr log
 * once and returns a flat list of diagnostics — errors and warnings —
 * each tagged with the source file it occurred in (best-effort), a line
 * number when one is available, and the message.
 *
 * The parser is a *pragmatic subset* of AUCTeX's `TeX-parse-error`. It
 * recognises:
 *
 *   - **Errors** — a line beginning `! ` carries the error message; the
 *     line number arrives on a following `l.NN …` line (TeX prints the
 *     offending input line there). The two are associated: the `l.NN`
 *     fills in the most recent error's line.
 *   - **The file stack** — pdflatex brackets file context with
 *     `(/path/to/file.tex …` … `)`. The parser tracks opens and closes
 *     so it can attribute an error or warning to the file TeX was
 *     reading at the time. The stack is best-effort: unbalanced or
 *     truncated parens (common in real logs) are tolerated, never fatal.
 *   - **Warnings** — `LaTeX Warning: <msg> on input line NN.` and the
 *     package form `Package <pkg> Warning: <msg> on input line NN.`,
 *     plus undefined-reference / undefined-citation warnings (which may
 *     or may not carry a line). A warning with no `on input line NN`
 *     gets `line: null`.
 *
 * It deliberately does **not** try to be exhaustive: TeX's error output
 * is famously irregular, and a reference engine only needs enough to
 * jump the user to the right place. Constructs it ignores: `Overfull`/
 * `Underfull \hbox` box warnings (noise, not actionable as file:line),
 * font substitution notes, and `Output written on …` summaries.
 *
 * Pure — string in, plain-JS-array out. No Lisp values, no host calls.
 * The Lisp surface (records the error-navigation commands walk) is built
 * on top of this in `latex-compile.lisp`, and the unit tests exercise
 * this module directly.
 */

/**
 * @typedef {object} LatexDiagnostic
 * @property {(string|null)} file  The source file the diagnostic belongs
 *   to (from the paren file-stack), or null when unknown.
 * @property {(number|null)} line  The 1-based source line, or null.
 * @property {string} message      The human-readable message.
 * @property {('error'|'warning')} kind
 */

// A file open in the paren stack: pdflatex writes `(` immediately
// followed by a path. We accept paths that look like a file (contain a
// `.`, or a `/`), which keeps us from treating grouping parens — `(`
// before a number or `\macro` — as file opens. Real logs wrap and split
// these across lines, so we scan character by character rather than with
// a single line regex.
//
// The recognised extensions are the ones that carry useful source
// context for error attribution; `.tex`/`.ltx` are the ones an error
// line ever points into, but we push every opened file so the close
// parens stay balanced with the opens.
const FILE_PATH_CHAR = /[^\s(){}]/;

/**
 * Parse a pdflatex / latexmk log into a flat diagnostics list.
 *
 * @param {string} text  The combined stdout/stderr log.
 * @returns {LatexDiagnostic[]}
 */
export function parseLatexLog(text) {
  if (typeof text !== 'string' || text === '') return [];

  /** @type {LatexDiagnostic[]} */
  const diagnostics = [];
  /**
   * The file-context stack. Each entry records the file path and the
   * paren *depth* at which it was opened, so a grouping `)` in prose
   * (which lowers the depth but not below a file's open-depth) doesn't
   * spuriously pop a real file. `depth` is the running paren depth.
   *
   * @type {{ path: string, depth: number }[]}
   */
  const fileStack = [];
  const parenState = { depth: 0 };
  /** The diagnostic awaiting its `l.NN` line number, or null. */
  let pendingError = null;

  const currentFile = () =>
    fileStack.length > 0 ? fileStack[fileStack.length - 1].path : null;

  // TeX wraps log lines hard at `max_print_line` (79 by default), so long error
  // and warning messages spill onto continuation lines (e.g. `… not` + `found.`).
  // Rejoin them first so the captured message is the whole thing, not just its
  // first ~79 chars (the truncation users see in the *TeX errors* view).
  const lines = unwrapTeXLog(text);
  for (const line of lines) {
    // Update the file stack from this line's parens *first*, so an error
    // or warning on the same line is attributed to the file just opened.
    updateFileStack(line, fileStack, parenState);

    // --- error: a line beginning "! " ---------------------------------
    // TeX prints `! <message>.` to open an error. The line number, if
    // any, comes later on an `l.NN` line; until then the diagnostic is
    // "pending" and we fill its line in when we see it.
    if (line.startsWith('! ')) {
      pendingError = {
        file: currentFile(),
        line: null,
        message: stripTrailingDot(line.slice(2).trim()),
        kind: 'error',
      };
      diagnostics.push(pendingError);
      continue;
    }

    // --- the line-number line for the pending error -------------------
    // `l.42 \some context` — the NN is the input line TeX choked on.
    if (pendingError !== null) {
      const m = /^l\.(\d+)\b/.exec(line);
      if (m) {
        pendingError.line = Number(m[1]);
        pendingError = null;
        continue;
      }
    }

    // --- LaTeX / package warnings -------------------------------------
    // `LaTeX Warning: <msg> on input line NN.`
    // `Package <pkg> Warning: <msg> on input line NN.`
    // The message may wrap onto following lines in a real log, but the
    // `on input line NN.` tail is what we key on; we capture the
    // first-line message, which is enough to identify the warning.
    const warn = /(?:LaTeX|Package\s+\S+)\s+Warning:\s*(.*)$/.exec(line);
    if (warn) {
      const rest = warn[1];
      const lineMatch = /on input line (\d+)\.?/.exec(rest);
      // Trim the trailing "on input line NN." from the displayed message.
      const message = stripTrailingDot(
        rest.replace(/\s*on input line \d+\.?\s*$/, '').trim()
      );
      diagnostics.push({
        file: currentFile(),
        line: lineMatch ? Number(lineMatch[1]) : null,
        message,
        kind: 'warning',
      });
    }
  }

  return diagnostics;
}

/**
 * Advance the file-context stack for one log line. The challenge: TeX
 * uses bare `(` / `)` for *both* file context and prose grouping, with
 * no distinguishing marker. We disambiguate by paren *depth*:
 *
 *   - every `(` raises the running depth; a `(` that is immediately
 *     followed by a path-looking token also pushes a file tagged with
 *     the depth it opened at;
 *   - every `)` lowers the running depth, and pops a file only when the
 *     depth falls back to (or below) that file's open-depth.
 *
 * So a grouping `)` from `(with grouping)` — which opens and closes at a
 * deeper level than the enclosing file — never pops the real file. This
 * is best-effort: never throws, tolerates unbalanced parens (the depth
 * is clamped at zero).
 *
 * @param {string} line
 * @param {{ path: string, depth: number }[]} stack
 * @param {{ depth: number }} parenState  Running paren depth across lines.
 */
function updateFileStack(line, stack, parenState) {
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '(') {
      parenState.depth += 1;
      // Read the run of path characters following the '('.
      let j = i + 1;
      let path = '';
      while (j < line.length && FILE_PATH_CHAR.test(line[j])) {
        path += line[j];
        j += 1;
      }
      // Treat it as a file open only when the token looks like a path
      // (a name with an extension, or an absolute/relative path). This
      // avoids pushing for grouping parens like `(2)` or `(\foo)`.
      if (path !== '' && looksLikePath(path)) {
        stack.push({ path, depth: parenState.depth });
        i = j - 1;
      }
    } else if (ch === ')') {
      // Pop any files whose open-depth is at or above the depth we are
      // now leaving — i.e. files this `)` actually closes. A grouping
      // `)` deeper than every open file leaves the stack untouched.
      if (parenState.depth > 0) {
        while (
          stack.length > 0 &&
          stack[stack.length - 1].depth >= parenState.depth
        ) {
          stack.pop();
        }
        parenState.depth -= 1;
      }
    }
  }
}

/** TeX's default `max_print_line` — the column at which it hard-wraps every log
 *  line (no hyphen, no trailing space, a bare cut). A line of EXACTLY this length
 *  was almost certainly wrapped, so the next line continues it. */
const MAX_PRINT_LINE = 79;

/**
 * Rejoin TeX's hard-wrapped log lines into logical lines. A raw line of exactly
 * `MAX_PRINT_LINE` chars is a wrap point; the following line is its continuation
 * and is appended. To avoid swallowing a genuinely new diagnostic that happens
 * to follow a 79-char line, a line that STARTS a construct (an `! ` error, an
 * `l.NN` line, or a `… Warning:` line) is never treated as a continuation.
 *
 * This recovers full error/warning messages (`… not found.`,
 * `… in conjunction with amsmath`) instead of the first ~79 chars. A legitimate
 * non-wrapped 79-char line is rare; the construct guard keeps the failure mode
 * harmless (at worst a little extra trailing log text on one message).
 *
 * @param {string} text
 * @returns {string[]}
 */
function unwrapTeXLog(text) {
  const raw = text.split('\n');
  /** @type {string[]} */
  const out = [];
  let continuing = false;
  for (const line of raw) {
    if (continuing && out.length > 0 && !startsConstruct(line)) {
      out[out.length - 1] += line;
    } else {
      out.push(line);
    }
    continuing = line.length === MAX_PRINT_LINE;
  }
  return out;
}

/** Whether LINE opens a new diagnostic construct the parser keys on — so the
 *  unwrapper never merges it into a preceding wrapped line. */
function startsConstruct(line) {
  return line.startsWith('! ')
    || /^l\.\d+\b/.test(line)
    || /(?:LaTeX|Package\s+\S+)\s+Warning:/.test(line);
}

/**
 * Whether TOKEN (the run of non-space characters after a `(`) looks like
 * a file path rather than a grouping paren's contents.
 *
 * @param {string} token
 * @returns {boolean}
 */
function looksLikePath(token) {
  // A leading backslash means a macro group, not a file.
  if (token.startsWith('\\')) return false;
  // A path either contains a slash, or has a dotted extension.
  return token.includes('/') || /\.[A-Za-z0-9]+$/.test(token);
}

/**
 * Strip a single trailing period from a message, if present, so the
 * rendered `FILE:LINE: message` reads cleanly.
 *
 * @param {string} s
 * @returns {string}
 */
function stripTrailingDot(s) {
  return s.endsWith('.') ? s.slice(0, -1) : s;
}
