/**
 * @file Mermaid highlighting — a hand-written scanner for the bodies of
 * JMarkdown's `:::mermaid` directives and `@begin(mermaid)` environments.
 *
 * There is no tree-sitter grammar for Mermaid in `../vendor/`, so this
 * is a port of the `mermaid-fallback` contexts in the architect's
 * `JMarkdown.sublime-syntax` — same rule order, same constructs —
 * emitting capture ranges onto the editor's *standard* faces so the
 * Mariana palette applies with no extra CSS:
 *
 *   diagram/structure keywords → @keyword   arrows/shapes → @operator
 *   directions, entities, [*]  → @constant  node/link text → @string
 *   actors, classDef names     → @function  identifiers    → @variable
 *   css property names         → @constant  colours/nums   → @number
 *   stereotypes <<…>>          → @type      separators     → @paren
 *   %% comments                → @comment
 *
 * Like the Sublime contexts, every sub-state (strings, node text, link
 * text, css properties) is line-bound — each pops at end of line — so
 * the scanner is a per-line token loop with no cross-line state.
 *
 * Pure and DOM-free; tested on its own.
 */

/** @typedef {{ start: number, end: number, face: string }} CaptureRange */

/** Diagram type declarations (the Sublime list, case-insensitive). */
const DIAGRAM_TYPES =
  /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|gitGraph|journey|mindmap|timeline|sankey-beta|xychart-beta|block-beta|kanban|architecture-beta|packet-beta|requirementDiagram|C4Context|C4Container|C4Component|C4Deployment|C4Dynamic|quadrantChart|zenuml)\b/i;

/** Keywords that open a labelled span (`loop Until done`). */
const LABELLED_KEYWORDS =
  /^\s*(loop|alt|opt|break|par|and|critical|option)\s+(\S.*)$/i;

/** `else` takes an optional label. */
const ELSE_KEYWORD = /^\s*(else)(?:\s+(.*))?$/i;

/** Bare structural keywords. */
const BARE_KEYWORDS =
  /^\s*(autonumber|rect|namespace|section|title|dateFormat|axisFormat|excludes|todayMarker|tickInterval)\b/i;

/** Multi-character node-shape openers, longest first (the Sublime order). */
const NODE_OPENERS = [
  '(((', '([', '[[', '[(', '{{', '[/', '[\\', '((', '>', '(', '[', '{',
];

/** Multi-character node-shape closers, longest first. */
const NODE_CLOSERS = [')))', '])', ']]', ')]', '}}', '/]', '\\]', '))', ')', ']', '}'];

/** A complete link/arrow operator (`-->`, `===`, `-.->`, `~~~`, …). */
const LINK_FULL =
  /^(?:[<xo]?-{2,}[>xo]|-{3,}|[<xo]?={2,}[>xo]|={3,}|[<xo]?-\.+-[>xo]?|~{3,})/;

/** The *start* of a link whose label sits inline (`-- text -->`). */
const LINK_BEGIN = /^(?:[<xo]?--(?!-)|[<xo]?==(?!=)|[<xo]?-\.)/;

/** The end of an inline-labelled link. */
const LINK_END = /^(?:-{2,}[>xo]|-{3,}|={2,}[>xo]|={3,}|\.+-[>xo]?)/;

/**
 * Scan one Mermaid body and return capture ranges in *absolute*
 * coordinates (the body's offset within the document is `base`).
 *
 * @param {string} body - The directive/environment body text.
 * @param {number} [base] - Absolute offset of `body` in the document.
 * @returns {CaptureRange[]}
 */
export function scanMermaid(body, base = 0) {
  /** @type {CaptureRange[]} */
  const captures = [];
  if (typeof body !== 'string' || body.length === 0) return captures;

  const push = (start, end, face) => {
    if (end > start) captures.push({ start: base + start, end: base + end, face });
  };

  let lineStart = 0;
  for (const line of body.split('\n')) {
    scanLine(line, lineStart, push);
    lineStart += line.length + 1;
  }
  return captures;
}

/**
 * Scan one line: try the line-level rules in the Sublime order, then
 * fall into the token loop for whatever remains.
 *
 * @param {string} line
 * @param {number} off - The line's offset within the body.
 * @param {(start: number, end: number, face: string) => void} push
 */
function scanLine(line, off, push) {
  let m;

  // --- comments: a whole-line %% comment ---------------------------------
  if ((m = /^\s*%%/.exec(line))) {
    push(off + m[0].length - 2, off + line.length, 'comment');
    return;
  }

  // --- diagram type declarations ------------------------------------------
  if ((m = DIAGRAM_TYPES.exec(line))) {
    push(off + m[0].length - m[1].length, off + m[0].length, 'keyword');
    tokens(line, m[0].length, off, push);
    return;
  }

  // --- subgraph / direction / end -----------------------------------------
  if ((m = /^\s*(subgraph)\s+(.*)$/.exec(line))) {
    const kwStart = m[0].indexOf('subgraph');
    push(off + kwStart, off + kwStart + 8, 'keyword');
    push(off + (m[0].length - m[2].length), off + m[0].length, 'string');
    return;
  }
  if ((m = /^\s*(direction|end)\b/.exec(line))) {
    const kwStart = m[0].length - m[1].length;
    push(off + kwStart, off + m[0].length, 'keyword');
    tokens(line, m[0].length, off, push);
    return;
  }

  // --- click <node> <callback> --------------------------------------------
  if ((m = /^\s*(click)\s+([-\w]+)\s*(.*)$/.exec(line))) {
    const kwStart = m[0].indexOf('click');
    push(off + kwStart, off + kwStart + 5, 'keyword');
    const nodeStart = line.indexOf(m[2], kwStart + 5);
    push(off + nodeStart, off + nodeStart + m[2].length, 'variable');
    // The remainder is a callback name and/or quoted strings.
    let i = nodeStart + m[2].length;
    while (i < line.length) {
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        const end = close === -1 ? line.length : close + 1;
        push(off + i, off + end, 'string');
        i = end;
      } else if (/[-\w]/.test(line[i])) {
        let j = i;
        while (j < line.length && /[-\w]/.test(line[j])) j += 1;
        push(off + i, off + j, 'function');
        i = j;
      } else {
        i += 1;
      }
    }
    return;
  }

  // --- classDef / style / linkStyle + css properties -----------------------
  if ((m = /^\s*(classDef|style|linkStyle)\s+([-\w]+)\s+/.exec(line))) {
    const kwStart = m[0].indexOf(m[1]);
    push(off + kwStart, off + kwStart + m[1].length, 'keyword');
    const nameStart = line.indexOf(m[2], kwStart + m[1].length);
    push(
      off + nameStart,
      off + nameStart + m[2].length,
      m[1] === 'classDef' ? 'function' : 'variable'
    );
    cssProperties(line, m[0].length, off, push);
    return;
  }

  // --- class diagram: class Name (a lone name) ------------------------------
  if ((m = /^\s*(class)\s+([-\w]+)\s*$/i.exec(line))) {
    const kwStart = m[0].indexOf(m[1]);
    push(off + kwStart, off + kwStart + m[1].length, 'keyword');
    const nameStart = line.indexOf(m[2], kwStart + m[1].length);
    push(off + nameStart, off + nameStart + m[2].length, 'function');
    return;
  }

  // --- flowchart class assignment: class node1,node2 className --------------
  if ((m = /^\s*(class)\s+/.exec(line))) {
    const kwStart = m[0].indexOf('class');
    push(off + kwStart, off + kwStart + 5, 'keyword');
    // Comma-separated node names; the final bare name is the class.
    const rest = line.slice(kwStart + 5);
    const parts = [];
    const re = /[-\w]+|,/g;
    let t;
    while ((t = re.exec(rest))) parts.push({ text: t[0], at: kwStart + 5 + t.index });
    const names = parts.filter((p) => p.text !== ',');
    for (const p of parts) {
      if (p.text === ',') {
        push(off + p.at, off + p.at + 1, 'paren');
      } else {
        const isClassName = names.length > 1 && p === names[names.length - 1];
        push(off + p.at, off + p.at + p.text.length, isClassName ? 'function' : 'variable');
      }
    }
    return;
  }

  // --- sequence diagram: participant / actor -------------------------------
  if ((m = /^\s*(participant|actor)\s+([-\w]+)(?:\s+(as)\s+(.*))?$/i.exec(line))) {
    const kwStart = m[0].indexOf(m[1]);
    push(off + kwStart, off + kwStart + m[1].length, 'keyword');
    const nameStart = line.indexOf(m[2], kwStart + m[1].length);
    push(off + nameStart, off + nameStart + m[2].length, 'function');
    if (m[3]) {
      const asStart = line.indexOf(' as ', nameStart + m[2].length) + 1;
      push(off + asStart, off + asStart + 2, 'keyword');
      push(off + asStart + 3, off + line.length, 'string');
    }
    return;
  }
  if ((m = /^\s*((?:de)?activate)\s+/i.exec(line))) {
    const kwStart = line.indexOf(m[1]);
    push(off + kwStart, off + kwStart + m[1].length, 'keyword');
    tokens(line, m[0].length, off, push);
    return;
  }

  // --- labelled structural keywords (loop / alt / opt / …) ------------------
  if ((m = LABELLED_KEYWORDS.exec(line))) {
    const kwStart = m[0].indexOf(m[1]);
    push(off + kwStart, off + kwStart + m[1].length, 'keyword');
    push(off + (m[0].length - m[2].length), off + m[0].length, 'string');
    return;
  }
  if ((m = ELSE_KEYWORD.exec(line))) {
    const kwStart = m[0].indexOf(m[1]);
    push(off + kwStart, off + kwStart + m[1].length, 'keyword');
    if (m[2]) push(off + (m[0].length - m[2].length), off + m[0].length, 'string');
    return;
  }
  if ((m = BARE_KEYWORDS.exec(line))) {
    const kwStart = m[0].length - m[1].length;
    push(off + kwStart, off + kwStart + m[1].length, 'keyword');
    tokens(line, m[0].length, off, push);
    return;
  }

  // --- sequence diagram: Note left of / right of / over ---------------------
  if ((m = /^\s*(Note)\s+((?:left|right)\s+of|over)\s+([-\w]+(?:,\s*[-\w]+)*)(:)/i.exec(line))) {
    const kwStart = m[0].indexOf(m[1]);
    push(off + kwStart, off + kwStart + m[1].length, 'keyword');
    const posStart = line.indexOf(m[2], kwStart + m[1].length);
    push(off + posStart, off + posStart + m[2].length, 'constant');
    const tgtStart = line.indexOf(m[3], posStart + m[2].length);
    push(off + tgtStart, off + tgtStart + m[3].length, 'variable');
    push(off + m[0].length - 1, off + m[0].length, 'paren');
    push(off + m[0].length, off + line.length, 'string');
    return;
  }

  // --- sequence diagram: messages (A ->> B: text) ---------------------------
  if ((m = /^\s*([-\w]+)\s*(--?(?:>>|[>)x]))\s*([-\w]+)(:)/.exec(line))) {
    const aStart = m[0].length - m[0].trimStart().length;
    push(off + aStart, off + aStart + m[1].length, 'variable');
    const arrowStart = line.indexOf(m[2], aStart + m[1].length);
    push(off + arrowStart, off + arrowStart + m[2].length, 'operator');
    const bStart = line.indexOf(m[3], arrowStart + m[2].length);
    push(off + bStart, off + bStart + m[3].length, 'variable');
    push(off + m[0].length - 1, off + m[0].length, 'paren');
    push(off + m[0].length, off + line.length, 'string');
    return;
  }

  // --- everything else: the flowchart token loop ----------------------------
  tokens(line, 0, off, push);
}

/**
 * The flowchart-ish token loop: node shapes, arrows, strings, entities,
 * `:::` class shorthand, separators, identifiers. Mirrors the order of
 * the Sublime `mermaid-fallback` token rules.
 *
 * @param {string} line
 * @param {number} from - Column to start at.
 * @param {number} off - The line's offset within the body.
 * @param {(start: number, end: number, face: string) => void} push
 */
function tokens(line, from, off, push) {
  let i = from;
  let inNodeText = false;
  while (i < line.length) {
    const rest = line.slice(i);
    let m;

    // state diagram start/end marker
    if (rest.startsWith('[*]')) {
      push(off + i, off + i + 3, 'constant');
      i += 3;
      continue;
    }
    // stereotype <<interface>>
    if ((m = /^<<[-\w]+>>/.exec(rest))) {
      push(off + i, off + i + m[0].length, 'type');
      i += m[0].length;
      continue;
    }
    // quoted string (entities highlighted inside)
    if (rest[0] === '"') {
      const close = line.indexOf('"', i + 1);
      const end = close === -1 ? line.length : close + 1;
      push(off + i, off + end, 'string');
      entities(line.slice(i, end), i, off, push);
      i = end;
      continue;
    }
    // entity references (#name; / #123;)
    if ((m = /^#(?:[0-9]{1,7}|[a-zA-Z0-9]+);/.exec(rest))) {
      push(off + i, off + i + m[0].length, 'constant');
      i += m[0].length;
      continue;
    }
    // rgb()/rgba() colour calls
    {
      const next = rgbCall(line, i, off, push);
      if (next !== null) {
        i = next;
        continue;
      }
    }
    // node-class shorthand :::className (before single-char shapes)
    if (rest.startsWith(':::')) {
      push(off + i, off + i + 3, 'paren');
      i += 3;
      if ((m = /^[-\w]+/.exec(line.slice(i)))) {
        push(off + i, off + i + m[0].length, 'function');
        i += m[0].length;
      }
      continue;
    }
    // a full arrow, or the begin of an inline-labelled one
    if ((m = LINK_FULL.exec(rest))) {
      push(off + i, off + i + m[0].length, 'operator');
      i += m[0].length;
      continue;
    }
    if ((m = LINK_BEGIN.exec(rest))) {
      push(off + i, off + i + m[0].length, 'operator');
      i += m[0].length;
      // inline link text up to the closing arrow (or end of line)
      const labelStart = i;
      while (i < line.length && !LINK_END.test(line.slice(i))) i += 1;
      if (i > labelStart) push(off + labelStart, off + i, 'string');
      if ((m = LINK_END.exec(line.slice(i)))) {
        push(off + i, off + i + m[0].length, 'operator');
        i += m[0].length;
      }
      continue;
    }
    // node-shape delimiters; text inside renders as a string
    const opener = NODE_OPENERS.find((d) => rest.startsWith(d));
    if (opener && !inNodeText) {
      push(off + i, off + i + opener.length, 'operator');
      i += opener.length;
      inNodeText = true;
      continue;
    }
    const closer = NODE_CLOSERS.find((d) => rest.startsWith(d));
    if (closer && inNodeText) {
      push(off + i, off + i + closer.length, 'operator');
      i += closer.length;
      inNodeText = false;
      continue;
    }
    // pipe-delimited link text
    if (rest[0] === '|') {
      push(off + i, off + i + 1, 'operator');
      const close = line.indexOf('|', i + 1);
      const end = close === -1 ? line.length : close;
      push(off + i + 1, off + end, 'string');
      if (close !== -1) push(off + close, off + close + 1, 'operator');
      i = close === -1 ? line.length : close + 1;
      continue;
    }
    // separators
    if (rest[0] === ';') {
      push(off + i, off + i + 1, 'paren');
      i += 1;
      continue;
    }
    if (rest[0] === '&') {
      push(off + i, off + i + 1, 'operator');
      i += 1;
      continue;
    }
    // direction keywords / bare identifiers
    if ((m = /^[-\w]+/.exec(rest))) {
      const word = m[0];
      const face = inNodeText
        ? 'string'
        : /^(?:T[BD]|BT|LR|RL)$/.test(word)
          ? 'constant'
          : 'variable';
      push(off + i, off + i + word.length, face);
      i += word.length;
      continue;
    }
    if (inNodeText && rest[0] !== ' ') {
      // Non-delimiter punctuation inside a node label is label text.
      push(off + i, off + i + 1, 'string');
    }
    i += 1;
  }
}

/**
 * Highlight one `rgb(…)`/`rgba(…)` colour call starting at column `i`,
 * or return null when the line doesn't start one there.
 *
 * @param {string} line
 * @param {number} i
 * @param {number} off
 * @param {(start: number, end: number, face: string) => void} push
 * @returns {number | null} The column after the call, or null.
 */
function rgbCall(line, i, off, push) {
  const m = /^rgba?\s*\(/.exec(line.slice(i));
  if (!m) return null;
  push(off + i, off + i + m[0].length - 1, 'function');
  push(off + i + m[0].length - 1, off + i + m[0].length, 'paren');
  i += m[0].length;
  while (i < line.length) {
    const num = /^\d*\.?\d+/.exec(line.slice(i));
    if (num) {
      push(off + i, off + i + num[0].length, 'number');
      i += num[0].length;
      continue;
    }
    if (line[i] === ',' || line[i] === ')') {
      push(off + i, off + i + 1, 'paren');
    }
    if (line[i] === ')') return i + 1;
    i += 1;
  }
  return i;
}

/**
 * CSS property lists on `classDef` / `style` / `linkStyle` lines:
 * `fill:#9f6,stroke:#333,stroke-width:4px`. Property names are
 * constants, hex colours numbers, other values strings.
 *
 * @param {string} line
 * @param {number} from - Column to start at.
 * @param {number} off - The line's offset within the body.
 * @param {(start: number, end: number, face: string) => void} push
 */
function cssProperties(line, from, off, push) {
  let i = from;
  while (i < line.length) {
    const rest = line.slice(i);
    let m;
    if ((m = /^([-\w]+)(:)/.exec(rest))) {
      push(off + i, off + i + m[1].length, 'constant');
      push(off + i + m[1].length, off + i + m[0].length, 'paren');
      i += m[0].length;
      continue;
    }
    if ((m = /^#[0-9A-Fa-f]{3,8}\b/.exec(rest))) {
      push(off + i, off + i + m[0].length, 'number');
      i += m[0].length;
      continue;
    }
    const next = rgbCall(line, i, off, push);
    if (next !== null) {
      i = next;
      continue;
    }
    if (rest[0] === ',') {
      push(off + i, off + i + 1, 'paren');
      i += 1;
      continue;
    }
    if ((m = /^[-\w]+/.exec(rest))) {
      push(off + i, off + i + m[0].length, 'string');
      i += m[0].length;
      continue;
    }
    i += 1;
  }
}

/**
 * Highlight `#name;` / `#123;` entity references inside an
 * already-pushed string capture (the smaller capture wins downstream).
 *
 * @param {string} str - The string slice (with quotes).
 * @param {number} at - The slice's column in the line.
 * @param {number} off - The line's offset within the body.
 * @param {(start: number, end: number, face: string) => void} push
 */
function entities(str, at, off, push) {
  const re = /#(?:[0-9]{1,7}|[a-zA-Z0-9]+);/g;
  let m;
  while ((m = re.exec(str))) {
    push(off + at + m.index, off + at + m.index + m[0].length, 'constant');
  }
}
