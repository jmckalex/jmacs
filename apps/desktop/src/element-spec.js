/**
 * @file element-spec.js — pure helpers for the generic element-view kind
 * (the `open-element-view!` primitive). Kept here, free of any
 * interpreter/DOM dependency, so the URL policy is unit-testable.
 *
 * See plans/ELEMENT-VIEWS.md.
 */

/**
 * Resolve an element-view spec's `:module` to a loadable URL.
 *
 *   - empty / non-string → `''` (nothing to load).
 *   - an absolute `app://` / `http(s):` / `media:` URL → passed through
 *     unchanged.
 *   - anything else is treated as a path relative to the repository root
 *     and served from the `app://editor` origin. Leading slashes are
 *     trimmed so `/x` and `x` resolve the same; the `app://editor`
 *     handler still refuses to escape the repo root, so a `..` segment
 *     can't reach outside it.
 *
 * @param {string} moduleSpec
 * @returns {string}
 */
export function resolveElementModuleUrl(moduleSpec) {
  const spec = typeof moduleSpec === 'string' ? moduleSpec : '';
  if (spec === '') return '';
  if (/^(app|https?|media):/i.test(spec)) return spec;
  return 'app://editor/' + spec.replace(/^\/+/, '');
}
