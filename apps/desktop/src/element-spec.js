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

/** How the embedded element sits in its pane:
 *  - `center` — natural size, centred both axes (the default).
 *  - `fill`   — stretched to the whole pane.
 *  - `top`    — natural size, top-aligned, scrolls on overflow.
 *  Reflected onto the host as `data-fit`, which `styles.css` keys off. */
const FIT_MODES = new Set(['center', 'fill', 'top']);

/**
 * Normalise an element-view spec's `:fit` to a known mode, defaulting to
 * `center` for anything missing or unrecognised.
 *
 * @param {string} fit
 * @returns {'center' | 'fill' | 'top'}
 */
export function normalizeFit(fit) {
  return FIT_MODES.has(fit) ? fit : 'center';
}

// --- L4: the built-in element-view registry as plain JS data ------------
// (plans/B5-B7-TEARDOWN-AUDIT.md). The same three views the renderer-only
// `element-view-*.lisp` files register, but as data the renderer owns WITHOUT
// its (soon-to-be-deleted) interpreter. `attrs` are in the parsed JS form
// (`[[name, value]]`, a bare flag → `true`) that `open-element-view!` produced
// from the Lisp `:attrs`. bib-search's `src` is computed per open from the
// active document's bibliography (see `elementViewOpenPayload`).

/** @typedef {{title: string, tag: string, module: string,
 *    attrs: Array<[string, string|boolean]>, fit: string, keyboard: string,
 *    noFocus: boolean}} ElementViewSpec */

const BIB_SEARCH_SAMPLE = 'app://editor/apps/desktop/vendor/bib-search/sample.bib';

/** @type {Record<string, ElementViewSpec>} */
export const ELEMENT_VIEW_SPECS = {
  atari: {
    title: 'Atari 2600',
    tag: 'stella-emulator',
    module: 'apps/desktop/vendor/stella/stella-element.js',
    attrs: [
      ['controls', true],
      ['src', 'app://editor/apps/desktop/vendor/stella/oystron.bin'],
    ],
    fit: 'center',
    keyboard: 'grab',
    noFocus: false,
  },
  'bib-search': {
    title: 'Bibliography',
    tag: 'bib-search',
    module: 'apps/desktop/vendor/bib-search/bib-search.js',
    attrs: [['src', BIB_SEARCH_SAMPLE]],
    fit: 'fill',
    keyboard: 'grab',
    noFocus: true,
  },
  'notebook-cells': {
    title: 'Notebook',
    tag: 'notebook-cells-view',
    module: '', // pre-registered by the renderer (packages/renderer/src/index.js)
    attrs: [],
    fit: 'fill',
    keyboard: 'off',
    noFocus: false,
  },
};

/** The registered element-view command/kind names (M-x-routable). */
export function elementViewKinds() {
  return Object.keys(ELEMENT_VIEW_SPECS);
}

/** The spec for a kind, or `null`. */
export function elementViewSpec(kind) {
  return Object.prototype.hasOwnProperty.call(ELEMENT_VIEW_SPECS, kind)
    ? ELEMENT_VIEW_SPECS[kind]
    : null;
}

/**
 * Build the `serverViewClient.openElementView` payload for a kind — the same
 * shape `open-element-view!` produced, so the server side is unchanged.
 *
 * For bib-search, fold the server-resolved active-document bibliography
 * (`bibPath`, absolute) in exactly as the old Lisp command did: an absolute
 * path → a `host-file-url` `src` + a `bib-path` attr; anything else → the
 * bundled sample. `hostFileUrl` is injected so this stays pure/testable.
 *
 * @param {string} kind
 * @param {{bibPath?: string|null, hostFileUrl?: (p: string) => string}} [opts]
 * @returns {object|null}
 */
export function elementViewOpenPayload(kind, opts = {}) {
  const spec = elementViewSpec(kind);
  if (!spec) return null;
  const { bibPath = null, hostFileUrl } = opts;
  let attrs = spec.attrs;
  if (kind === 'bib-search') {
    const abs = typeof bibPath === 'string' && bibPath.startsWith('/') ? bibPath : null;
    if (abs && typeof hostFileUrl === 'function') {
      const url = hostFileUrl(abs) || BIB_SEARCH_SAMPLE;
      attrs = [['src', url], ['bib-path', abs]];
    } else {
      attrs = [['src', BIB_SEARCH_SAMPLE]];
    }
  }
  return {
    name: spec.title || spec.tag,
    tag: spec.tag,
    moduleUrl: resolveElementModuleUrl(spec.module),
    attrs,
    fit: normalizeFit(spec.fit),
    keyboard: spec.keyboard || 'grab',
    noFocus: spec.noFocus === true,
  };
}
