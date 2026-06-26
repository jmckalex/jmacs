/**
 * @file The JavaScript-notebook cell execution engine.
 *
 * This is the heart of the JS-in-server notebook (design contract:
 * `plans/NOTEBOOK-JS.md`). It is a **pure, host-agnostic** module: given
 * a cell's source string and a facade of injected bindings, it compiles
 * the source to an `AsyncFunction` and runs it, capturing the return
 * value, any `console.*` output, and any thrown error into a single
 * **cell result record**.
 *
 * Per §2.2 of the design, cells are evaluated as `AsyncFunction` bodies,
 * which gives us:
 *   - top-level `await` for free (the body *is* an async function body),
 *   - native dynamic `import()`,
 *   - trivial per-cell isolation (each call is a fresh scope),
 *   - ordinary `try/catch` error handling.
 *
 * The Observable-style "last expression is the value" behaviour is
 * provided by a conservative source rewrite (`transformLastExprToReturn`)
 * that does not depend on a full JS parser — see its doc-comment for the
 * exact rules and limits.
 *
 * This module deliberately knows nothing about the editor, the server,
 * Electron, or the DOM. The *facade* (the `editor`, `Inspector`,
 * `require`, `cells` objects) is supplied by the caller, so the same
 * engine runs in the renderer's interpreter context (flag-off MVP) or in
 * the server's Node session (Model-B port) unchanged.
 */

/**
 * The `AsyncFunction` constructor. Not a global, but reachable via the
 * prototype of any async function. Compiling through it lets a cell body
 * use top-level `await`.
 * @type {Function}
 */
export const AsyncFunction = Object.getPrototypeOf(
  // eslint-disable-next-line no-empty-function
  async function () {},
).constructor;

/**
 * The names injected into every cell, in a fixed order. The compiled
 * `AsyncFunction` takes these as positional parameters and the runner
 * supplies the matching values from the facade.
 * @type {readonly string[]}
 */
export const FACADE_NAMES = Object.freeze([
  'editor',
  'Inspector',
  'require',
  'cells',
  'console',
  'abortSignal',
]);

/**
 * Strip a single trailing line comment (`// …`) and trailing whitespace
 * from a line, without being fooled by `//` inside a string or a regex.
 * Conservative: if it can't be sure, it leaves the line alone.
 *
 * @param {string} line
 * @returns {string}
 */
function stripTrailingLineComment(line) {
  let inStr = null; // the opening quote char, or null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line.replace(/\s+$/, '');
}

/**
 * Heuristically detect whether SOURCE already contains a top-level
 * `return` statement. Conservative: a match inside a nested function or a
 * string can produce a false positive, in which case we simply *don't*
 * rewrite the last expression — the cell still runs, it just doesn't get
 * implicit-return sugar. That is the safe failure direction.
 *
 * @param {string} source
 * @returns {boolean}
 */
function hasReturn(source) {
  return /(^|[^.\w$])return(\s|;|$)/m.test(source);
}

/**
 * Rewrite SOURCE so that, if its last meaningful statement is a bare
 * expression, that expression becomes the function's return value
 * (Observable-style "the cell's value is its last expression").
 *
 * This is a **conservative heuristic**, not a parser (we have no build
 * step and don't want a parser dependency for this — see
 * `plans/NOTEBOOK-JS.md` §11). The rules:
 *
 *   - If the source already has a top-level `return`, it is left alone.
 *   - The last non-blank line is examined. If it ends in `;`, `}`, `{`,
 *     or is a control-flow / declaration keyword line, it is left alone
 *     (it is a statement, not a trailing expression).
 *   - Otherwise the last non-blank line is prefixed with `return ` and
 *     suffixed with `;`.
 *
 * The cost of getting it wrong is small and visible: a cell that should
 * have shown a value shows `undefined`, and the author adds an explicit
 * `return`. We never produce *incorrect* output, only a missing implicit
 * return.
 *
 * @param {string} source
 * @returns {string}
 */
export function transformLastExprToReturn(source) {
  if (typeof source !== 'string') return '';
  if (hasReturn(source)) return source;

  const lines = source.split('\n');
  // Find the last non-blank line index.
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (last < 0) return source; // empty body

  const raw = lines[last];
  const code = stripTrailingLineComment(raw).trim();
  if (code === '') return source;

  // Statement-shaped last lines we must not turn into a return.
  const endsLikeStatement = /[;{}]$/.test(code);
  const startsWithKeyword =
    /^(const|let|var|function|class|if|for|while|do|switch|try|return|throw|import|export|async\s+function)\b/.test(
      code,
    );
  // A label or object-literal-open etc. — be conservative.
  if (endsLikeStatement || startsWithKeyword) return source;

  // Replace the last non-blank line with `return <expr>;`, preserving the
  // original leading indentation.
  const indent = raw.slice(0, raw.length - raw.trimStart().length);
  const original = lines[last];
  lines[last] = `${indent}return (${code});`;
  const rewritten = lines.join('\n');

  // The heuristic can mis-fire when the "last line" actually holds
  // several statements (e.g. `a(); b()`), where wrapping the whole line
  // in `return (...)` is invalid JS. Verify the rewrite is parseable; if
  // not, fall back to the original (the safe direction — a missing
  // implicit return, never a broken cell).
  if (!isParseable(rewritten)) {
    lines[last] = original;
    return source;
  }
  return rewritten;
}

/**
 * Whether SOURCE is a syntactically valid `AsyncFunction` body. Used to
 * validate a speculative last-expression rewrite before committing to it.
 *
 * @param {string} source
 * @returns {boolean}
 */
function isParseable(source) {
  try {
    // eslint-disable-next-line no-new
    new AsyncFunction(...FACADE_NAMES, source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a per-cell `console` shim that appends structured log records to
 * LOGS. Each call serializes its arguments to a single text line. The
 * shim covers `log`, `info`, `warn`, `error`, and `debug`; `info`/`debug`
 * are recorded at their own level so the UI can style them.
 *
 * @param {Array<{level: string, text: string}>} logs - sink, mutated.
 * @returns {Console} a console-like object.
 */
export function makeCaptureConsole(logs) {
  const record = (level) => (...args) => {
    logs.push({ level, text: args.map(formatArg).join(' ') });
  };
  return {
    log: record('log'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };
}

/**
 * Format a single console argument to a short, safe string. Objects are
 * JSON-stringified (with a fallback for cycles / non-serializable
 * values); everything else uses `String`.
 *
 * @param {*} arg
 * @returns {string}
 */
export function formatArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg === undefined) return 'undefined';
  if (arg === null) return 'null';
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

/**
 * Compile a cell SOURCE string into an `AsyncFunction` taking the facade
 * names as parameters. The body is wrapped so that the last expression
 * becomes the return value (unless an explicit `return` is present).
 *
 * Throws a `SyntaxError` if SOURCE is not valid JavaScript — the caller
 * (`runCell`) catches this and reports it as a cell error, so a syntax
 * error in one cell never escapes the engine.
 *
 * @param {string} source - the cell's editable text.
 * @returns {Function} the compiled async function.
 */
export function compileCell(source) {
  const body = transformLastExprToReturn(source ?? '');
  const wrapped = `"use strict";\n${body}`;
  return new AsyncFunction(...FACADE_NAMES, wrapped);
}

/**
 * @typedef {Object} CellResult
 * @property {'ok'|'error'} state - terminal state of the run.
 * @property {*} value - the resolved return value (only when `ok`).
 * @property {Array<{level: string, text: string}>} logs - captured console output.
 * @property {{message: string, stack: string, name: string}|null} error
 *   - the thrown error, normalised (only when `error`).
 * @property {number} startedAt - epoch ms when the run began.
 * @property {number} finishedAt - epoch ms when the run settled.
 */

/**
 * Normalise an arbitrary thrown value into a plain, serializable error
 * record. Cells may throw non-`Error` values; we never assume `.message`.
 *
 * @param {*} err
 * @returns {{message: string, stack: string, name: string}}
 */
export function normaliseError(err) {
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: err.message || String(err),
      stack: err.stack || '',
    };
  }
  return { name: 'Error', message: formatArg(err), stack: '' };
}

/**
 * Execute a single cell.
 *
 * Compiles SOURCE, injects the FACADE (augmented with a capture
 * `console` and the supplied `abortSignal`), awaits the result, and
 * returns a {@link CellResult}. The entire run is wrapped in `try/catch`
 * so a throwing or rejecting cell yields `state: 'error'` rather than
 * propagating — **a bad cell never crashes the host** (design §2.5/§8).
 *
 * The facade is supplied by the caller. Recognised keys:
 *   - `editor`, `Inspector`, `require`, `cells` — passed through as-is.
 *   - `console` — if absent, a capture console is created; if present, it
 *     is wrapped so its output is *also* captured into `logs`.
 *
 * @param {string} source - the cell's source text.
 * @param {Object} [facade] - injected bindings (see {@link FACADE_NAMES}).
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal] - cooperative cancellation signal.
 * @param {() => number} [opts.now] - clock (injectable for tests).
 * @returns {Promise<CellResult>}
 */
export async function runCell(source, facade = {}, opts = {}) {
  const now = opts.now || (() => Date.now());
  const logs = [];
  const startedAt = now();

  // The cell always gets a capture console. If the caller supplied one we
  // tee into it as well (so server-side debugging still sees the output).
  const captureConsole = makeCaptureConsole(logs);
  const cellConsole = facade.console
    ? teeConsole(captureConsole, facade.console)
    : captureConsole;

  const args = {
    editor: facade.editor,
    Inspector: facade.Inspector,
    require: facade.require,
    cells: facade.cells || {},
    console: cellConsole,
    abortSignal: opts.signal,
  };

  let fn;
  try {
    fn = compileCell(source);
  } catch (err) {
    return {
      state: 'error',
      value: undefined,
      logs,
      error: normaliseError(err),
      startedAt,
      finishedAt: now(),
    };
  }

  try {
    if (opts.signal?.aborted) {
      throw new DOMExceptionLike('The cell run was aborted.', 'AbortError');
    }
    const value = await fn(...FACADE_NAMES.map((n) => args[n]));
    return {
      state: 'ok',
      value,
      logs,
      error: null,
      startedAt,
      finishedAt: now(),
    };
  } catch (err) {
    return {
      state: 'error',
      value: undefined,
      logs,
      error: normaliseError(err),
      startedAt,
      finishedAt: now(),
    };
  }
}

/**
 * Wrap two consoles so that every call goes to both. Used to tee a
 * cell's captured output into the host's real console for debugging.
 *
 * @param {Console} primary
 * @param {Console} secondary
 * @returns {Console}
 */
function teeConsole(primary, secondary) {
  const tee = (level) => (...args) => {
    primary[level]?.(...args);
    try {
      secondary[level]?.(...args);
    } catch {
      /* a broken host console must not break the cell */
    }
  };
  return {
    log: tee('log'),
    info: tee('info'),
    warn: tee('warn'),
    error: tee('error'),
    debug: tee('debug'),
  };
}

/**
 * A tiny stand-in for `DOMException('…', 'AbortError')` usable in plain
 * Node where `DOMException` may be absent. Behaves like an Error whose
 * `.name` is `'AbortError'`.
 */
class DOMExceptionLike extends Error {
  /**
   * @param {string} message
   * @param {string} name
   */
  constructor(message, name) {
    super(message);
    this.name = name;
  }
}
