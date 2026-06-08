/**
 * @file math-preview-host.js — the host-side seam that connects a
 * buffer's `math-preview-mode` (a general Lisp minor mode) to the
 * renderer's math-preview controller, and selects the per-major-mode
 * scanning provider.
 *
 * The renderer owns the typesetting brain (`createMathPreview` in
 * `packages/renderer/src/math-preview.js`): it scans the buffer (with a
 * mode-supplied scanner), decides which math segments to typeset / reveal
 * / mark invalid, and hands the view a list of replaced ranges. The view
 * reads those ranges fresh on every render (`view.js`'s
 * `getReplacedRanges`).
 *
 * This module supplies the host glue:
 *
 *   1. *Is the minor mode on?* — `isMathPreviewActive(buffer, mode)`
 *      walks the buffer's minor-mode list for the general
 *      `math-preview-mode` map. (`isLatexMathPreviewActive` is kept as a
 *      back-compat alias.)
 *   2. *Which provider scans this buffer?* — `bufferMajorModeName(buffer,
 *      keyword)` reads the buffer's major-mode `:name`, which the caller
 *      feeds to the renderer's `mathPreviewProviderForMode` to pick the
 *      scanner (LaTeX recognises environments, Markdown/common does not;
 *      a mode with no provider gets no preview).
 *
 * Minor modes are stored on the L2 buffer as an opaque Lisp list of mode
 * maps (`buffer.minorModes`); the stdlib's `math-preview-mode` value is
 * one such map. Membership is by identity — the same map object the
 * stdlib defined is what lands in the list — so we can test it from JS
 * without a "current buffer" round-trip through the interpreter. That
 * keeps the check correct for background panes, whose buffer is not the
 * interpreter's current buffer.
 *
 * This module is pure (no DOM, no interpreter); the controller lifecycle
 * (create / reuse / dispose) and the provider lookup live in `app.js`,
 * which has the leaf map and the interned `keyword` constructor.
 */

/**
 * Whether `buffer`'s minor-mode list contains `mode`.
 *
 * `buffer.minorModes` is the opaque Lisp value L2 stores: either a Lisp
 * list (a chain of `{head, tail}` cons pairs ending in the nil value),
 * `null` (no modes ever set), or the Lisp nil value. We walk the cons
 * chain comparing each element to `mode` by identity (`===`), because
 * the mode maps stored in the list are the very objects the stdlib
 * defined — the same reference resolved from `math-preview-mode`.
 *
 * Tolerant by design: a missing buffer, a null/absent mode reference, or
 * a non-list `minorModes` all yield `false` rather than throwing. The
 * render path calls this every frame, so it must never raise.
 *
 * @param {{ minorModes?: * } | null | undefined} buffer - The L2 buffer.
 * @param {*} mode - The `math-preview-mode` map (resolved from Lisp), or
 *   null/undefined before it is resolved.
 * @returns {boolean}
 */
export function isMathPreviewActive(buffer, mode) {
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

/**
 * Back-compatible alias of {@link isMathPreviewActive}. The general
 * minor mode replaced the LaTeX-specific one; the name is retained for
 * the original import site.
 *
 * @type {typeof isMathPreviewActive}
 */
export const isLatexMathPreviewActive = isMathPreviewActive;

/**
 * The display `:name` of `buffer`'s major mode (e.g. `"LaTeX"`,
 * `"Markdown"`), or null when there is no buffer / no major mode / no
 * name. This is the key the renderer's `mathPreviewProviderForMode` uses
 * to pick the scanning provider.
 *
 * A buffer's major mode is a Lisp map (a JS `Map` keyed by interned
 * keywords); we read `:name` through the supplied `keyword` constructor.
 * `keyword` is injected (rather than imported) so this module stays a
 * pure, dependency-free seam that tests can drive with a plain stub.
 *
 * Tolerant by design: anything missing yields null rather than throwing.
 *
 * @param {{ majorMode?: * } | null | undefined} buffer - The L2 buffer.
 * @param {(name: string) => *} keyword - The interned-keyword constructor
 *   (`@editor/lisp`'s `keyword`); `keyword('name')` is the map key.
 * @returns {string | null}
 */
export function bufferMajorModeName(buffer, keyword) {
  const major = buffer ? buffer.majorMode : null;
  if (!major || typeof major.get !== 'function' || typeof keyword !== 'function') {
    return null;
  }
  const name = major.get(keyword('name'));
  return typeof name === 'string' ? name : null;
}
