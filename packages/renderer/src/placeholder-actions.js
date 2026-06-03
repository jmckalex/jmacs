/**
 * @file Pure helpers for the split-placeholder chooser view
 * (`placeholder-view.js` + the host wiring in `app.js`). These are the
 * decision functions with no DOM and no host dependencies, so they can
 * be exercised under `node --test`:
 *
 *  - `resolvePlaceholderAction` — turn a raw `*placeholder-default-action*`
 *    value into one of the canonical actions (what `Enter` does).
 *  - `cloneTargetForKind` — given an origin view's kind, decide how the
 *    `c` (clone) action should reproduce it ("same buffer", "same url",
 *    "same file", "fresh", or "scratch"). The host turns this decision
 *    into an actual `createView` call.
 *  - `isPlaceholderView` — the predicate the View List, `list-views`, and
 *    `next/previous-view` use to skip placeholder entries (a placeholder
 *    is a transient `views` entry but must never appear in the list or
 *    the cycling ring).
 *
 * See `plans/PANES-PLACEHOLDER.md` for the design.
 */

/** The canonical placeholder actions. `none` means "do nothing on Enter". */
export const PLACEHOLDER_ACTIONS = Object.freeze([
  'open',
  'clone',
  'new',
  'command',
  'none',
]);

/** The fallback when `*placeholder-default-action*` is missing or junk. */
export const DEFAULT_PLACEHOLDER_ACTION = 'clone';

/**
 * Resolve the configured default action into one of `PLACEHOLDER_ACTIONS`.
 * Accepts a Lisp symbol (whose `toString()`/`name` is the action name) or
 * a plain string; anything unrecognised falls back to `clone`.
 *
 * @param {*} raw - The `*placeholder-default-action*` value (symbol/string).
 * @returns {'open'|'clone'|'new'|'command'|'none'}
 */
export function resolvePlaceholderAction(raw) {
  if (raw === null || raw === undefined) return DEFAULT_PLACEHOLDER_ACTION;
  let name;
  if (typeof raw === 'string') {
    name = raw;
  } else if (typeof raw === 'object' && typeof raw.name === 'string') {
    // A Lisp symbol object: `{ name: 'clone', ... }`.
    name = raw.name;
  } else {
    name = String(raw);
  }
  name = name.trim().toLowerCase();
  // Tolerate a quoted/prefixed printed form like "'clone".
  if (name.startsWith("'")) name = name.slice(1);
  return PLACEHOLDER_ACTIONS.includes(name)
    ? /** @type {*} */ (name)
    : DEFAULT_PLACEHOLDER_ACTION;
}

/**
 * Decide how the clone action should reproduce a view of KIND. The result
 * is a small tag the host maps onto a concrete `createView`:
 *
 *  - `same-buffer` — text: a new text view over the same buffer, fresh
 *    point, mark cleared (Q2/Q9 independent cursor).
 *  - `same-url` — browser: a new browser view at the same URL.
 *  - `same-file` — pdf / image / audio / video: a new view of the same
 *    file.
 *  - `fresh` — shell / gnuplot / notebook / directory-*: a fresh instance
 *    of the same kind (a pty's scrollback etc. can't be cloned).
 *  - `scratch` — anything with no sensible clone target (the fallback).
 *
 * @param {string|null|undefined} kind
 * @returns {'same-buffer'|'same-url'|'same-file'|'fresh'|'scratch'}
 */
export function cloneTargetForKind(kind) {
  switch (kind) {
    case 'text':
      return 'same-buffer';
    case 'browser':
      return 'same-url';
    case 'pdf':
    case 'image':
    case 'audio':
    case 'video':
      return 'same-file';
    case 'shell':
    case 'gnuplot':
    case 'notebook':
    case 'directory-tree':
    case 'directory-columns':
      return 'fresh';
    default:
      return 'scratch';
  }
}

/**
 * Whether VIEW is a placeholder chooser view. Placeholders are kept in
 * the global `views[]` (so `currentViewIndex` and the modeline stay
 * valid), but are excluded from the View List and skipped by the
 * `next/previous-view` cycling ring.
 *
 * @param {{kind?: string} | null | undefined} view
 * @returns {boolean}
 */
export function isPlaceholderView(view) {
  return !!view && view.kind === 'placeholder';
}
