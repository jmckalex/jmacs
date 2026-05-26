/**
 * @file View primitives — the Lisp surface for addressing views.
 *
 * Replaces the old `(current-buffer)` family (plans/PANES.md, Q4: flag
 * day, no compatibility shims). The view is now the addressable
 * on-screen thing; text-editing views happen to contain a buffer.
 *
 * The host (the desktop app) supplies a `viewHost` shape with:
 *
 *   - `currentView()` — the focused View handle.
 *   - `viewList()` — every open View handle, in display order.
 *   - `switchToView(target)` — switch to a View handle or a name; the
 *     desktop app's switch logic re-mounts the kind's DOM, updates the
 *     modeline, etc.
 *   - `killView(target)` — kill a View handle or a name; mirrors the
 *     old kill-buffer semantics.
 *   - `newView(name)` — create a fresh empty text view and switch to
 *     it (the desktop app's `new-view!`).
 *   - `nextView()` / `previousView()` — cycle through the view list.
 *   - `findViewByName(name)` — return the View whose name matches, or
 *     null. Used by `(find-view name)` and the C-x b plumbing.
 *
 * Every constructor-style primitive (`new-view!`, `switch-to-view!`)
 * returns the View handle it acted on (or `nil` when it failed),
 * per Q15: pane-creating commands return handles.
 *
 * The primitives also surface the view-list snapshot the menu reads
 * (`list-views` — the equivalent of the old `list-buffers`).
 */

import { arrayToList, keyword, NIL } from '@editor/lisp';

/**
 * Build the view primitives for a view-host.
 *
 * @param {ViewHost} viewHost
 * @returns {Record<string, (args: *[]) => *>}
 */
export function createViewPrimitives(viewHost) {
  /** Resolve TARGET (a view handle, a name, or nil) to a view, or null. */
  function resolveTarget(target) {
    if (target === null || target === undefined || target === NIL) return null;
    if (typeof target === 'object' && target !== null && 'kind' in target) {
      return target; // already a view handle
    }
    if (typeof target === 'string') return viewHost.findViewByName(target);
    return null;
  }

  return {
    // --- view addressing -----------------------------------------------
    // `(current-view)` — the focused view handle. `nil` if no view is
    // current (vanishingly rare in practice — there's always a scratch
    // text view — but a defensive nil is cleaner than an exception).
    //
    // Phase 2 of plans/PANES.md: "current view" is defined as "the view
    // in the focused leaf pane." With one leaf this is identical to
    // today's "the current view"; phase 3's split commands require the
    // pane-rooted resolution path. The desktop app's `viewHost.currentView`
    // delegates through the pane tree (paneHost.currentPane()?.view), so
    // the indirection lives at the host boundary, not in Lisp.
    'current-view': () => {
      const view = viewHost.currentView();
      return view ?? NIL;
    },
    // `(view-list)` — every open view, in display order.
    'view-list': () => arrayToList(viewHost.viewList()),
    // `(view-kind v)` — the view's kind as a string.
    'view-kind': (args) => {
      const view = args[0];
      return view && typeof view.kind === 'string' ? view.kind : NIL;
    },
    // `(view-buffer v)` — the L2 buffer for a text view, or `nil` for
    // a non-text view. Lisp callers that want a buffer should be
    // prepared for nil.
    'view-buffer': (args) => {
      const view = args[0];
      return view && view.buffer ? view.buffer : NIL;
    },
    // `(view-name-of v)` — read the name of a specific view handle.
    // The current view's name is `(view-name)` (defined in buffer-
    // primitives, since the session knows it without a handle).
    'view-name-of': (args) => {
      const view = args[0];
      return view && typeof view.name === 'string' ? view.name : NIL;
    },

    // --- switching, killing, creating ---------------------------------
    // Constructors return handles (Q15).
    'switch-to-view!': (args) => {
      const target = resolveTarget(args[0]);
      if (target === null) return NIL;
      const view = viewHost.switchToView(target);
      return view ?? NIL;
    },
    'kill-view!': (args) => {
      const target = args.length > 0
        ? resolveTarget(args[0])
        : viewHost.currentView();
      if (target === null) return NIL;
      viewHost.killView(target);
      return NIL;
    },
    'new-view!': (args) => {
      const name = args.length > 0 ? String(args[0]) : null;
      const view = viewHost.newView(name);
      return view ?? NIL;
    },
    'next-view!': () => {
      const view = viewHost.nextView();
      return view ?? NIL;
    },
    'previous-view!': () => {
      const view = viewHost.previousView();
      return view ?? NIL;
    },
    'view-count': () => viewHost.viewList().length,
    'find-view': (args) => {
      const view = viewHost.findViewByName(String(args[0] ?? ''));
      return view ?? NIL;
    },

    // --- snapshots -----------------------------------------------------
    // `(list-views)` — the snapshot the *Buffer List* (renamed
    // *View List*) renders against. One hash-map per view, with the
    // keys the menu reads: :name, :kind, :mode, :line-count, :file,
    // :modified. The host packs the records; Lisp consumes them.
    'list-views': () => arrayToList(viewHost.listViewRecords()),
  };
}

/**
 * @typedef {import('@editor/view').View} View
 *
 * @typedef {object} ViewHost
 * @property {() => (View | null)} currentView
 * @property {() => View[]} viewList
 * @property {(target: View) => (View | null)} switchToView
 * @property {(target: View) => void} killView
 * @property {(name: string | null) => (View | null)} newView
 * @property {() => (View | null)} nextView
 * @property {() => (View | null)} previousView
 * @property {(name: string) => (View | null)} findViewByName
 * @property {() => Array<Map<*, *>>} listViewRecords
 */
