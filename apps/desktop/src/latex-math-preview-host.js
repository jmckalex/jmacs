/**
 * @file latex-math-preview-host.js — the host-side seam that connects a
 * buffer's `latex-math-preview-mode` (a Lisp minor mode) to the
 * renderer's math-preview controller.
 *
 * The renderer owns the typesetting brain (`createLatexMathPreview` in
 * `packages/renderer/src/latex-math-preview.js`): it scans the buffer,
 * decides which math segments to typeset / reveal / mark invalid, and
 * hands the view a list of replaced ranges. The view reads those ranges
 * fresh on every render (`view.js`'s `getReplacedRanges`).
 *
 * What was missing was the host glue: knowing *whether* a given buffer
 * has the minor mode on, so the host feeds the renderer the controller's
 * ranges (mode on) or an empty list (mode off). Minor modes are stored
 * on the L2 buffer as an opaque Lisp list of mode maps
 * (`buffer.minorModes`); the stdlib's `latex-math-preview-mode` value is
 * one such map. Membership is by identity — the same map object the
 * stdlib defined is what lands in the list — so we can test it from JS
 * without a "current buffer" round-trip through the interpreter. That
 * keeps the check correct for background panes, whose buffer is not the
 * interpreter's current buffer.
 *
 * This module is pure (no DOM, no interpreter); the controller lifecycle
 * (create / reuse / dispose) lives in `app.js`, which has the leaf map.
 */

/**
 * Whether `buffer`'s minor-mode list contains `mode`.
 *
 * `buffer.minorModes` is the opaque Lisp value L2 stores: either a Lisp
 * list (a chain of `{head, tail}` cons pairs ending in the nil value),
 * `null` (no modes ever set), or the Lisp nil value. We walk the cons
 * chain comparing each element to `mode` by identity (`===`), because
 * the mode maps stored in the list are the very objects the stdlib
 * defined — the same reference resolved from `latex-math-preview-mode`.
 *
 * Tolerant by design: a missing buffer, a null/absent mode reference, or
 * a non-list `minorModes` all yield `false` rather than throwing. The
 * render path calls this every frame, so it must never raise.
 *
 * @param {{ minorModes?: * } | null | undefined} buffer - The L2 buffer.
 * @param {*} mode - The `latex-math-preview-mode` map (resolved from
 *   Lisp), or null/undefined before it is resolved.
 * @returns {boolean}
 */
export function isLatexMathPreviewActive(buffer, mode) {
  if (!buffer || mode == null) return false;
  let node = buffer.minorModes;
  // Walk the cons chain. A cons pair is any object with `head`/`tail`;
  // we stop at the first non-pair (the nil tail, or null).
  let guard = 0;
  while (node && typeof node === 'object' && 'head' in node && 'tail' in node) {
    if (node.head === mode) return true;
    node = node.tail;
    // Defensive bound against a cyclic structure; minor-mode lists are
    // tiny, so this never trips in practice.
    guard += 1;
    if (guard > 100000) break;
  }
  return false;
}
