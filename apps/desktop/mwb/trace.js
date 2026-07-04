/**
 * @file Model-B wire + renderer-op tracer (spine side, the sole writer).
 *
 * Off by default; enabled by the `GODOT_TRACE` env var read at spine boot:
 *   GODOT_TRACE=1                 → write to `<config-home>/trace.log`
 *   GODOT_TRACE=/path/to/file.log → write there
 *
 * The topology makes the spine the natural single writer: renderer and spine
 * talk over a direct MessagePort (main never sees the messages), and the spine
 * is one endpoint, so it observes EVERY `C->S` and `S->C` message. The renderer
 * has ops that never hit the wire (its scroll / follow-cursor decisions); it
 * forwards those to the spine as `{ type: '__trace__', ... }` messages, which
 * the spine records here in the SAME ordered file (see server.js registerClient).
 *
 * One line per event:
 *   <ms> <DIR> c<idx> <TYPE> <compact-json-payload>
 * DIR is `C->S`, `S->C`, or `RND ` (a renderer local op). Times are wall-clock
 * ms (Date.now); a renderer op carries its OWN origin ms so its line sorts
 * against spine lines correctly despite the wire hop.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The resolved trace-file path, or null when tracing is off. */
let filePath = null;

/**
 * Resolve + open the trace file from the environment. Idempotent-safe to call
 * once at boot. Returns the path (and truncates it) when on, else null.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} configHome - Directory for the default `trace.log`.
 * @returns {string | null}
 */
export function initTrace(env, configHome) {
  const flag = env.GODOT_TRACE;
  if (!flag) { filePath = null; return null; }
  filePath = (flag === '1' || flag === 'true' || flag === 'on')
    ? join(configHome || '.', 'trace.log')
    : flag;
  try {
    writeFileSync(filePath, `# godot trace — ${new Date().toISOString()}\n`);
  } catch {
    filePath = null; // an unwritable path: stay off rather than crash the spine
  }
  return filePath;
}

/** @returns {boolean} Whether tracing is on. */
export function traceEnabled() { return filePath !== null; }

/** @returns {string | null} The active trace file, or null. */
export function traceFile() { return filePath; }

/** Append one already-formatted line. Never throws. */
function write(line) {
  if (!filePath) return;
  try { appendFileSync(filePath, `${line}\n`); } catch { /* ignore */ }
}

/**
 * Reduce an arbitrary message to a compact, bounded, one-line JSON summary:
 * strings over 500 chars become `…(len)`, arrays over 20 items become
 * `[N items]`, cycles become `[circ]`. Keeps the log readable when a DELTA or
 * VIEW carries a whole buffer.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function summarize(value) {
  const seen = new WeakSet();
  const cap = (s) => (s.length > 500 ? `${s.slice(0, 500)}…(${s.length})` : s);
  const walk = (x) => {
    if (typeof x === 'string') return cap(x);
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) return '[circ]';
    seen.add(x);
    if (Array.isArray(x)) {
      return x.length > 20 ? `[${x.length} items]` : x.map(walk);
    }
    const out = {};
    for (const k of Object.keys(x)) out[k] = walk(x[k]);
    return out;
  };
  try { return JSON.stringify(walk(value)); } catch { return '[unserializable]'; }
}

/**
 * Record one wire message.
 * @param {'C->S'|'S->C'} dir
 * @param {number} clientIndex
 * @param {{ type?: string } | null | undefined} msg
 */
export function traceWire(dir, clientIndex, msg) {
  if (!filePath || !msg) return;
  const { type, ...rest } = msg;
  write(`${Date.now()} ${dir} c${clientIndex} ${type ?? '?'} ${summarize(rest)}`);
}

/**
 * Record one renderer local op forwarded from a client. The renderer stamps
 * its own `t` (ms) so the line sorts by true origin time, not arrival.
 * @param {number} clientIndex
 * @param {{ kind?: string, data?: unknown, t?: number }} payload
 */
export function traceRendererOp(clientIndex, payload) {
  if (!filePath || !payload) return;
  const t = Number.isFinite(payload.t) ? payload.t : Date.now();
  write(`${t} RND  c${clientIndex} ${payload.kind ?? '?'} ${summarize(payload.data)}`);
}
