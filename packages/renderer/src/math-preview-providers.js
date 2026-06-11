/**
 * @file Math-preview providers — the one place a major mode declares how
 * it scans for math.
 *
 * A *provider* is the mode-specific part of the math preview: a function
 * `scan(text) -> MathSegment[]`. Everything downstream (the controller's
 * typeset/cache, the layout, the replaced-range widget layer) is
 * mode-agnostic and drives off the segments the provider returns.
 *
 * Providers are keyed by **major-mode name** — the `:name` a `define-mode`
 * gives the mode (`"LaTeX"`, `"Markdown"`, …), which the host reads off
 * the buffer's `majorMode` map. The host looks the provider up by that
 * name; a major mode with no provider gets no math preview (the lookup
 * returns null, the host feeds the renderer an empty range list).
 *
 * Most modes share the *common* config (`MARKDOWN_MATH_CONFIG`): the four
 * delimiter pairs plus `\begin…\end` math environments — everything
 * MathJax typesets. (`latex-mode` uses `LATEX_MATH_CONFIG`, the same
 * notation set.) The markdown-like modes additionally mask code before
 * scanning (see `CODE_AWARE_MODES`), so a `$` inside a code span is not
 * read as math.
 *
 * ── Adding a future mode (html-mode, php-mode, …) ─────────────────────
 * Those major modes do not exist yet. When one lands, add ONE entry to
 * `MATH_PREVIEW_CONFIGS` below — almost always the common config:
 *
 *     'HTML': MARKDOWN_MATH_CONFIG,   // ← the whole change
 *
 * The key is the mode's `:name` (what `define-mode … :name "HTML"` sets,
 * and what the modeline shows). Nothing else needs to change: the host
 * already selects by major-mode name and drives the shared pipeline.
 */

import {
  scanMathSegments,
  maskMarkdownCode,
  LATEX_MATH_CONFIG,
  MARKDOWN_MATH_CONFIG,
} from './math-segments.js';

/**
 * Major modes whose document is Markdown-like, where a `$` inside a code
 * span/fence is literal text, not math. Their provider masks code before
 * scanning so `` `$x$` `` (or a `$$…$$` wedged in a heading's backticks)
 * is not mis-read as math. LaTeX is *not* here — backticks aren't code in
 * a `.tex` file. Add html/php here when those modes land.
 *
 * @type {ReadonlySet<string>}
 */
const CODE_AWARE_MODES = new Set(['Markdown', 'JMarkdown']);

/**
 * @typedef {import('./math-segments.js').MathSegment} MathSegment
 * @typedef {import('./math-segments.js').MathConfig} MathConfig
 */

/**
 * @typedef {object} MathPreviewProvider
 * @property {(text: string) => MathSegment[]} scan - Scan buffer text for
 *   the math segments this major mode recognises.
 * @property {MathConfig} config - The scanner config the provider uses
 *   (exposed for tests / inspection).
 */

/**
 * The scanner config per major-mode `:name`. This is the single seam a
 * new mode is added to (see the file header). Keep it keyed by the
 * mode's display name so the host can select with one map lookup.
 *
 * @type {Readonly<Record<string, MathConfig>>}
 */
export const MATH_PREVIEW_CONFIGS = Object.freeze({
  LaTeX: LATEX_MATH_CONFIG,
  Markdown: MARKDOWN_MATH_CONFIG,
  JMarkdown: MARKDOWN_MATH_CONFIG,
  // Future modes go here, e.g.:
  //   HTML: MARKDOWN_MATH_CONFIG,
  //   PHP: MARKDOWN_MATH_CONFIG,
});

/**
 * Build a provider from a scanner config: a `scan(text)` closure bound to
 * that config plus the config itself. When `maskCode` is set, the scan
 * first masks Markdown code spans/blocks so a `$` inside them isn't read
 * as math (see {@link maskMarkdownCode}); offsets are preserved.
 *
 * @param {MathConfig} config
 * @param {boolean} [maskCode=false]
 * @returns {MathPreviewProvider}
 */
export function providerForConfig(config, maskCode = false) {
  return {
    config,
    scan: maskCode
      ? (text) => scanMathSegments(maskMarkdownCode(text), config)
      : (text) => scanMathSegments(text, config),
  };
}

/** Cache built providers so the host gets a stable object per mode. */
const providerCache = new Map();

/**
 * The math-preview provider for a major mode, selected by its display
 * `:name` (e.g. `"LaTeX"`, `"Markdown"`), or null when the mode has no
 * provider registered — in which case the host shows plain source.
 *
 * @param {string | null | undefined} modeName - The major mode's `:name`.
 * @returns {MathPreviewProvider | null}
 */
export function mathPreviewProviderForMode(modeName) {
  if (typeof modeName !== 'string') return null;
  const config = MATH_PREVIEW_CONFIGS[modeName];
  if (!config) return null;
  let provider = providerCache.get(modeName);
  if (!provider) {
    provider = providerForConfig(config, CODE_AWARE_MODES.has(modeName));
    providerCache.set(modeName, provider);
  }
  return provider;
}
