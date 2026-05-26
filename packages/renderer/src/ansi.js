/**
 * @file A small ANSI escape parser. Turns a stream of shell output
 * into runs of `{ text, style }` where `style` is the current SGR
 * state (foreground, background, bold, italic, underline, inverse) or
 * `null` for plain text.
 *
 * Designed for the shell view's line-oriented transcript:
 *   - SGR (CSI `m`) — colours and font attributes, including 8-colour,
 *     bright 8-colour, 256-colour, and 24-bit RGB.
 *   - CSI cursor-movement and erase-in-line — consumed and dropped.
 *     We don't redraw a transcript; trying to honour cursor moves
 *     would require a full terminal emulator.
 *   - OSC (ESC `]` ... BEL or ESC `\`) — consumed and dropped. These
 *     are window-title updates, hyperlinks, etc. — useful but not for
 *     v2.
 *   - Other ESC sequences (G0/G1 designation, `ESC =`, `ESC >`, …) —
 *     leniently consumed.
 *
 * The parser is **streaming-safe**: a chunk may end mid-escape, in
 * which case the partial bytes are buffered and joined with the start
 * of the next `feed()` call. Sticky SGR state (current fg/bg/bold/…)
 * also persists across calls — that's a real terminal property, not
 * a per-chunk one.
 *
 * Not handled (intentional):
 *   - Cursor positioning replays. A program that wants to overwrite a
 *     line gets its output appended instead, the codes silently
 *     dropped.
 *   - Character set switching (`ESC ( B`, ASCII vs. line-drawing).
 *     We assume UTF-8 throughout.
 */

/** Single byte: ESC. */
const ESC = '\x1b';
/** Single byte: BEL — one of OSC's terminators. */
const BEL = '\x07';

/**
 * The 16 standard ANSI colour names, indexed 0..15 (0..7 = normal,
 * 8..15 = bright). The view maps these into CSS classes like
 * `shell-fg-red` / `shell-fg-bright-red`. The view's stylesheet binds
 * each to the matching CSS variable on `:root`.
 */
const NAMED_COLOURS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow',
  'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white',
];

/**
 * Apply one SGR parameter (or sub-sequence, for the 38/48 extended
 * forms) onto `style`, mutating it in place. The `params` array is
 * the full list of integer parameters from the CSI sequence; `i` is
 * the index into it. Returns the *next* index to consume.
 *
 * Recognised:
 *   0           reset
 *   1           bold
 *   3           italic
 *   4           underline
 *   7           inverse
 *   22          no bold (also dim off)
 *   23          no italic
 *   24          no underline
 *   27          no inverse
 *   30-37       fg standard
 *   38;5;N      fg 256-colour
 *   38;2;R;G;B  fg 24-bit RGB
 *   39          fg default
 *   40-47       bg standard
 *   48;5;N      bg 256-colour
 *   48;2;R;G;B  bg 24-bit RGB
 *   49          bg default
 *   90-97       fg bright (8-colour, indices 8..15)
 *   100-107     bg bright
 *
 * Anything we don't recognise advances by one and is silently dropped.
 * That's the same behaviour a real terminal gives: an unknown SGR is
 * a no-op rather than a hard error.
 */
function applySgr(style, params, i) {
  const code = params[i];
  switch (code) {
    case 0: {
      // Reset everything.
      style.fg = null;
      style.bg = null;
      style.bold = false;
      style.italic = false;
      style.underline = false;
      style.inverse = false;
      return i + 1;
    }
    case 1:  style.bold = true;       return i + 1;
    case 3:  style.italic = true;     return i + 1;
    case 4:  style.underline = true;  return i + 1;
    case 7:  style.inverse = true;    return i + 1;
    case 22: style.bold = false;      return i + 1;
    case 23: style.italic = false;    return i + 1;
    case 24: style.underline = false; return i + 1;
    case 27: style.inverse = false;   return i + 1;
    case 39: style.fg = null;         return i + 1;
    case 49: style.bg = null;         return i + 1;
    case 38:
    case 48: {
      // Extended fg (38) or bg (48). Next param is the form:
      //   5  → one more param (256-colour index 0..255)
      //   2  → three more params (R, G, B, each 0..255)
      const which = code === 38 ? 'fg' : 'bg';
      const form = params[i + 1];
      if (form === 5) {
        const n = params[i + 2];
        if (typeof n === 'number') {
          style[which] = { mode: '256', index: clamp(n, 0, 255) };
        }
        return i + 3;
      }
      if (form === 2) {
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        if (
          typeof r === 'number' &&
          typeof g === 'number' &&
          typeof b === 'number'
        ) {
          style[which] = {
            mode: 'rgb',
            rgb: [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)],
          };
        }
        return i + 5;
      }
      // Unknown form — drop the 38/48 and the next param, best-effort.
      return i + 2;
    }
    default: {
      if (code >= 30 && code <= 37) {
        style.fg = { mode: 'named', name: NAMED_COLOURS[code - 30] };
        return i + 1;
      }
      if (code >= 40 && code <= 47) {
        style.bg = { mode: 'named', name: NAMED_COLOURS[code - 40] };
        return i + 1;
      }
      if (code >= 90 && code <= 97) {
        style.fg = { mode: 'named', name: NAMED_COLOURS[code - 90 + 8] };
        return i + 1;
      }
      if (code >= 100 && code <= 107) {
        style.bg = { mode: 'named', name: NAMED_COLOURS[code - 100 + 8] };
        return i + 1;
      }
      // Unknown — drop a single param and continue.
      return i + 1;
    }
  }
}

/** Constrain `n` to the inclusive range [lo, hi]. */
function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * Snapshot the current sticky-style record into a frozen plain object,
 * or `null` if it's the empty (default) style. The view emits one
 * `<span>` per run; freezing keeps it from being mutated downstream
 * (the parser keeps mutating its working copy as more SGRs land).
 *
 * Returns null when nothing's set — the view emits plain text for
 * those, no span wrap.
 */
function snapshot(style) {
  const empty =
    style.fg === null &&
    style.bg === null &&
    !style.bold &&
    !style.italic &&
    !style.underline &&
    !style.inverse;
  if (empty) return null;
  return Object.freeze({
    fg: style.fg,
    bg: style.bg,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    inverse: style.inverse,
  });
}

/**
 * Parse a CSI parameter buffer (the bytes between `ESC [` and the
 * final byte) into an array of integers. An empty parameter slot
 * counts as 0 (the standard's default value). A literal `;` separates
 * parameters.
 *
 * The standard also allows `:` as a sub-parameter separator within a
 * single parameter; we flatten the two — `38:5:N` and `38;5;N` mean
 * the same to us. (Real terminals largely accept both for SGR.)
 */
function parseCsiParams(buf) {
  if (buf === '') return [0];
  const out = [];
  let current = '';
  for (let i = 0; i < buf.length; i += 1) {
    const ch = buf[i];
    if (ch === ';' || ch === ':') {
      out.push(current === '' ? 0 : Number.parseInt(current, 10));
      current = '';
    } else if (ch >= '0' && ch <= '9') {
      current += ch;
    } else {
      // CSI private markers `?<>=` and intermediate `space..slash` can
      // appear. We're not honouring them, so we drop them; the parameter
      // list still parses sensibly.
    }
  }
  out.push(current === '' ? 0 : Number.parseInt(current, 10));
  return out;
}

/**
 * Create a stateful ANSI parser. The parser is "one terminal session":
 * sticky SGR state persists across feeds, and partial escapes at chunk
 * boundaries are stitched onto the next chunk.
 *
 * Usage:
 *
 *   const parser = createAnsiParser();
 *   for (const chunk of incoming) {
 *     for (const run of parser.feed(chunk)) {
 *       view.append(run.text, run.style);
 *     }
 *   }
 *
 * @returns {{
 *   feed: (text: string) => Array<{ text: string, style: object | null }>,
 *   reset: () => void,
 * }}
 */
export function createAnsiParser() {
  // Sticky SGR state.
  const style = {
    fg: null,
    bg: null,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
  };

  // Carried-over bytes from a chunk that ended mid-escape. These are
  // prepended to the next feed's input.
  let leftover = '';

  function reset() {
    style.fg = null;
    style.bg = null;
    style.bold = false;
    style.italic = false;
    style.underline = false;
    style.inverse = false;
    leftover = '';
  }

  function feed(text) {
    if (typeof text !== 'string' || text === '') return [];

    const input = leftover + text;
    leftover = '';
    const runs = [];

    // Accumulate plain text into `buffer`; flush when style changes or
    // when we're about to drop an escape.
    let buffer = '';
    let lastSnapshot = snapshot(style);

    /** Push the current text buffer as a run, if non-empty. */
    function flush() {
      if (buffer === '') return;
      runs.push({ text: buffer, style: lastSnapshot });
      buffer = '';
    }

    let i = 0;
    const n = input.length;
    while (i < n) {
      const ch = input[i];

      if (ch !== ESC) {
        buffer += ch;
        i += 1;
        continue;
      }

      // We have ESC at `i`. Need at least one more byte to decide what
      // kind of escape it is. If we don't have one, stash and bail.
      if (i + 1 >= n) {
        leftover = input.slice(i);
        break;
      }

      const next = input[i + 1];

      if (next === '[') {
        // CSI: ESC [ <params> <final>. Look for the final byte in
        // 0x40..0x7E. Params are 0x30..0x3F; intermediates 0x20..0x2F.
        let j = i + 2;
        while (j < n) {
          const code = input.charCodeAt(j);
          // Final byte: @A-Z[\]^_`a-z{|}~ — 0x40..0x7E.
          if (code >= 0x40 && code <= 0x7e) break;
          j += 1;
        }
        if (j >= n) {
          // Truncated — wait for more.
          leftover = input.slice(i);
          break;
        }
        const finalByte = input[j];
        const paramBuf = input.slice(i + 2, j);
        if (finalByte === 'm') {
          // SGR: flush plain text under the *old* style, then apply.
          flush();
          const params = parseCsiParams(paramBuf);
          let k = 0;
          while (k < params.length) {
            const next2 = applySgr(style, params, k);
            k = next2 > k ? next2 : k + 1;
          }
          lastSnapshot = snapshot(style);
        } else {
          // Any other CSI (cursor moves, erase-in-line, mode set,
          // private DEC sequences, …) — consume and drop.
        }
        i = j + 1;
        continue;
      }

      if (next === ']') {
        // OSC: ESC ] <data> (BEL | ESC \). Hunt for either terminator.
        // String-terminator is two bytes (ESC \).
        let j = i + 2;
        let terminatorLen = 0;
        while (j < n) {
          const c = input[j];
          if (c === BEL) {
            terminatorLen = 1;
            break;
          }
          if (c === ESC && j + 1 < n && input[j + 1] === '\\') {
            terminatorLen = 2;
            break;
          }
          // A bare ESC mid-OSC with no `\` after it is malformed. We
          // wait — if there is more text in the next chunk, it might
          // be the `\` we need.
          if (c === ESC && j + 1 >= n) break;
          j += 1;
        }
        if (j >= n || terminatorLen === 0) {
          // Truncated — wait for more. The "ESC and we don't know if
          // \\ follows" case lands here too.
          leftover = input.slice(i);
          break;
        }
        // Consume up to and including the terminator. The OSC payload
        // is dropped.
        i = j + terminatorLen;
        continue;
      }

      // Any other ESC <byte>: short escapes like ESC = / ESC > /
      // ESC ( B (G0 character set), ESC c (RIS, full reset),
      // ESC P (DCS — followed by ST). We don't honour any of them;
      // the safest lenient thing is to consume ESC + one byte.
      // Exception: DCS (ESC P) and SOS/PM/APC (ESC X / ^ / _) all
      // wait for a String Terminator (ESC \\ or BEL). We treat them
      // like OSC and hunt for ST.
      if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        let j = i + 2;
        let terminatorLen = 0;
        while (j < n) {
          const c = input[j];
          if (c === BEL) {
            terminatorLen = 1;
            break;
          }
          if (c === ESC && j + 1 < n && input[j + 1] === '\\') {
            terminatorLen = 2;
            break;
          }
          if (c === ESC && j + 1 >= n) break;
          j += 1;
        }
        if (j >= n || terminatorLen === 0) {
          leftover = input.slice(i);
          break;
        }
        i = j + terminatorLen;
        continue;
      }

      // Plain short escape (ESC =, ESC >, ESC c, ESC (B, …). The
      // longest of these is `ESC ( B` (three bytes total), but we
      // can't easily distinguish them from `ESC =` (two bytes) without
      // a finite-state machine. Lenient default: drop ESC + one byte.
      // The few cases that need two extra bytes (G0/G1 designation)
      // will leak one stray ASCII letter onto the transcript. That's
      // an acceptable v2 limit — real curses programs aren't supported
      // anyway.
      i += 2;
    }

    flush();
    return runs;
  }

  return { feed, reset };
}
