/**
 * @file Bookmark context relocation — recover a bookmark's position when
 * its saved offset is stale because the file was edited while Godot
 * wasn't watching (closed in between, or changed by another tool).
 *
 * Each bookmark stores a short slice of text on either side of its
 * position — `rearContext` (before) and `frontContext` (after). On load
 * we look for where that straddling context now lives and move the
 * bookmark there. The search is layered: trust an unchanged offset,
 * then an exact straddle that merely shifted, then a fuzzy (edit-
 * distance) best-match in a window around the saved offset.
 *
 * In-session the buffer Marker tracks the position exactly; this module
 * is only the cross-session / external-edit safety net. It is pure (no
 * buffer, no DOM) so it can be unit-tested directly.
 */

/** Characters of context captured on each side of a bookmark. */
export const CONTEXT_SIZE = 32;

/** Window (chars each side of the saved offset) the fuzzy tier scans. */
const FUZZY_WINDOW = 600;

/** Minimum straddle similarity (0..1) for a fuzzy relocation to win. */
const FUZZY_THRESHOLD = 0.55;

/**
 * Capture the text straddling OFFSET: up to `size` chars before
 * (`rearContext`) and after (`frontContext`). Reads through a slice
 * function (`buffer.slice`) so it stays O(size), not O(buffer).
 *
 * @param {{ slice: (start: number, end: number) => string, length: number }} buffer
 * @param {number} offset
 * @param {number} [size]
 * @returns {{ frontContext: string, rearContext: string }}
 */
export function captureContext(buffer, offset, size = CONTEXT_SIZE) {
  const o = Math.max(0, Math.min(offset, buffer.length));
  return {
    rearContext: buffer.slice(Math.max(0, o - size), o),
    frontContext: buffer.slice(o, Math.min(buffer.length, o + size)),
  };
}

/**
 * Find OFFSET for a bookmark in TEXT, recovering from edits made while
 * the buffer wasn't tracking it. Returns the saved offset clamped if
 * nothing better is found.
 *
 * @param {string} text - The current buffer contents.
 * @param {{ anchor?: number, frontContext?: string, rearContext?: string }} bookmark
 * @param {{ window?: number, threshold?: number }} [opts]
 * @returns {number}
 */
export function relocate(text, bookmark, opts = {}) {
  const window = opts.window ?? FUZZY_WINDOW;
  const threshold = opts.threshold ?? FUZZY_THRESHOLD;
  const n = text.length;
  const front = bookmark.frontContext ?? '';
  const rear = bookmark.rearContext ?? '';
  const saved = Math.max(0, Math.min(bookmark.anchor ?? 0, n));

  // No context to match on — the offset is all we have.
  if (front === '' && rear === '') return saved;

  // The surroundings are unchanged — keep the offset exactly, no drift.
  if (matchesAt(text, saved, front, rear)) return saved;

  // Tier 1: the straddle survived intact and merely shifted (a pure
  // insert/delete elsewhere). Take the occurrence nearest the old offset.
  if (rear !== '' && front !== '') {
    const at = nearestIndexOf(text, rear + front, saved);
    if (at >= 0) return at + rear.length;
  }

  // Tier 2: one side survived exactly. Anchor to whichever lands closest.
  let exact = -1;
  let exactDist = Infinity;
  if (rear !== '') {
    const at = nearestIndexOf(text, rear, saved);
    if (at >= 0) {
      const p = at + rear.length;
      if (Math.abs(p - saved) < exactDist) { exact = p; exactDist = Math.abs(p - saved); }
    }
  }
  if (front !== '') {
    const at = nearestIndexOf(text, front, saved);
    if (at >= 0 && Math.abs(at - saved) < exactDist) { exact = at; exactDist = Math.abs(at - saved); }
  }
  if (exact >= 0) return exact;

  // Tier 3: fuzzy. The context itself was edited; score every position in
  // a window by how well the text straddling it matches, and take the
  // best — but only if it clears the threshold, else keep the offset.
  const lo = Math.max(0, saved - window);
  const hi = Math.min(n, saved + window);
  let best = saved;
  let bestScore = scoreAt(text, saved, front, rear);
  for (let p = lo; p <= hi; p += 1) {
    const s = scoreAt(text, p, front, rear);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return bestScore >= threshold ? best : saved;
}

/** True when the stored contexts sit exactly around P in TEXT. */
function matchesAt(text, p, front, rear) {
  return (
    text.slice(Math.max(0, p - rear.length), p) === rear &&
    text.slice(p, p + front.length) === front
  );
}

/** Mean similarity of the text straddling P to the stored contexts. */
function scoreAt(text, p, front, rear) {
  const r = rear === '' ? 1 : similarity(text.slice(Math.max(0, p - rear.length), p), rear);
  const f = front === '' ? 1 : similarity(text.slice(p, p + front.length), front);
  return (r + f) / 2;
}

/** The occurrence of NEEDLE in TEXT whose start is nearest NEAR, or -1. */
function nearestIndexOf(text, needle, near) {
  if (needle === '') return -1;
  const before = text.lastIndexOf(needle, near);
  const after = text.indexOf(needle, near);
  if (before < 0) return after;
  if (after < 0) return before;
  return near - before <= after - near ? before : after;
}

/** 1 (identical) … 0 (wholly different), from normalised edit distance. */
function similarity(a, b) {
  if (a === b) return 1;
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
}

/** Levenshtein edit distance between A and B (two-row DP). */
function levenshtein(a, b) {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    const curr = [i];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[lb];
}
