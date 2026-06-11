/**
 * @file Tests for the view warehouse (../src/view-warehouse.js) — the
 * hidden container that holds view elements while they're not shown in a
 * pane. The module reads the global `document` and the real `#view-warehouse`
 * element via `getElementById`, then moves elements in and out with the
 * standard DOM parent/child operations.
 *
 * There is no Electron and no real DOM here. We install a `globalThis.document`
 * stub plus a tiny element model that faithfully reproduces the three things
 * the module relies on: `appendChild` (which re-parents, removing the child
 * from its previous parent), the `parentNode` back-reference, and a live
 * `children` array. That is enough to exercise reuse-vs-rebuild, ordering,
 * snapshot semantics, the lazy cache, and the missing-container failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getWarehouse,
  warehouse,
  isWarehoused,
  warehouseContents,
  resetWarehouseCache,
} from '../src/view-warehouse.js';

// --- fake DOM ---------------------------------------------------------------

/** A minimal element with real re-parenting semantics: `appendChild` detaches
 *  the child from any previous parent first (matching the browser), keeps a
 *  `parentNode` back-pointer, and exposes a mutable `children` array. */
function makeEl(id = '') {
  const el = {
    id,
    parentNode: null,
    children: [],
    appendChild(child) {
      if (child.parentNode) {
        const old = child.parentNode.children;
        const i = old.indexOf(child);
        if (i >= 0) old.splice(i, 1);
      }
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (el.parentNode) {
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
        el.parentNode = null;
      }
    },
  };
  return el;
}

/** Install a fresh `globalThis.document` whose `#view-warehouse` is `whEl`,
 *  and reset the module's lazy cache so it re-reads our element. Returns a
 *  `setWarehouseEl` hook so a test can swap in a different container (to
 *  exercise the cache) or remove it entirely (to exercise the throw). */
function installDoc(whEl) {
  const byId = new Map();
  if (whEl) byId.set('view-warehouse', whEl);
  globalThis.document = { getElementById: (id) => byId.get(id) ?? null };
  resetWarehouseCache();
  return {
    setWarehouseEl(next) {
      if (next) byId.set('view-warehouse', next);
      else byId.delete('view-warehouse');
    },
  };
}

/** Run `fn` with a fresh document + empty warehouse, cleaning up after. */
function withWarehouse(fn) {
  const prevDoc = globalThis.document;
  const whEl = makeEl('view-warehouse');
  const ctl = installDoc(whEl);
  try {
    fn(whEl, ctl);
  } finally {
    resetWarehouseCache();
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
}

const ids = (arr) => arr.map((e) => e.id);

// --- getWarehouse -----------------------------------------------------------

test('getWarehouse returns the #view-warehouse element', () => {
  withWarehouse((whEl) => {
    assert.equal(getWarehouse(), whEl);
  });
});

test('getWarehouse caches: repeated calls return the same reference', () => {
  withWarehouse(() => {
    assert.equal(getWarehouse(), getWarehouse());
  });
});

test('getWarehouse keeps the cached element even if the DOM swaps it', () => {
  withWarehouse((whEl, ctl) => {
    const first = getWarehouse();
    assert.equal(first, whEl);
    // Swap the document's element, but without resetting the cache the
    // module must keep handing back the originally-resolved one.
    ctl.setWarehouseEl(makeEl('view-warehouse'));
    assert.equal(getWarehouse(), first);
  });
});

test('getWarehouse throws when #view-warehouse is absent', () => {
  withWarehouse((whEl, ctl) => {
    ctl.setWarehouseEl(null); // remove it
    resetWarehouseCache(); // force a fresh (failing) lookup
    assert.throws(
      () => getWarehouse(),
      /#view-warehouse is missing/
    );
  });
});

// --- warehouse / isWarehoused -----------------------------------------------

test('warehouse(view) moves a detached view into the container', () => {
  withWarehouse((whEl) => {
    const v = makeEl('v');
    assert.equal(isWarehoused(v), false);
    warehouse(v);
    assert.equal(isWarehoused(v), true);
    assert.equal(v.parentNode, whEl);
    assert.deepEqual(ids(warehouseContents()), ['v']);
  });
});

test('warehouse is idempotent: re-warehousing keeps a single copy', () => {
  withWarehouse(() => {
    const v = makeEl('v');
    warehouse(v);
    warehouse(v);
    warehouse(v);
    assert.equal(warehouseContents().length, 1);
    assert.deepEqual(ids(warehouseContents()), ['v']);
  });
});

test('warehouse preserves element identity (reuse, not rebuild)', () => {
  withWarehouse(() => {
    const v = makeEl('v');
    warehouse(v);
    const stored = warehouseContents()[0];
    assert.equal(stored, v, 'the very same element object is stored');
  });
});

test('warehouse keeps insertion (document) order across several views', () => {
  withWarehouse(() => {
    const a = makeEl('a');
    const b = makeEl('b');
    const c = makeEl('c');
    warehouse(a);
    warehouse(b);
    warehouse(c);
    assert.deepEqual(ids(warehouseContents()), ['a', 'b', 'c']);
  });
});

test('warehousing a view from another parent re-parents it', () => {
  withWarehouse((whEl) => {
    const other = makeEl('other-parent');
    const v = makeEl('v');
    other.appendChild(v);
    assert.equal(v.parentNode, other);
    assert.equal(isWarehoused(v), false);

    warehouse(v);
    assert.equal(isWarehoused(v), true);
    assert.equal(v.parentNode, whEl);
    assert.equal(other.children.includes(v), false, 'removed from old parent');
  });
});

test('isWarehoused is false for a view moved out of the warehouse', () => {
  withWarehouse(() => {
    const v = makeEl('v');
    warehouse(v);
    assert.equal(isWarehoused(v), true);
    const elsewhere = makeEl('pane');
    elsewhere.appendChild(v); // simulate going live in a pane
    assert.equal(isWarehoused(v), false);
    assert.deepEqual(ids(warehouseContents()), []);
  });
});

test('isWarehoused is false for a never-warehoused, detached view', () => {
  withWarehouse(() => {
    assert.equal(isWarehoused(makeEl('fresh')), false);
  });
});

// --- warehouseContents ------------------------------------------------------

test('warehouseContents is empty for a fresh warehouse', () => {
  withWarehouse(() => {
    assert.deepEqual(warehouseContents(), []);
  });
});

test('warehouseContents returns a snapshot: later mutation does not change it', () => {
  withWarehouse(() => {
    const a = makeEl('a');
    warehouse(a);
    const snapshot = warehouseContents();
    assert.deepEqual(ids(snapshot), ['a']);

    // Add another view AFTER taking the snapshot.
    warehouse(makeEl('b'));
    assert.deepEqual(ids(snapshot), ['a'], 'snapshot is frozen at capture time');
    assert.deepEqual(ids(warehouseContents()), ['a', 'b'], 'live read reflects it');
  });
});

// --- resetWarehouseCache ----------------------------------------------------

test('resetWarehouseCache forces a fresh element lookup', () => {
  withWarehouse((whEl, ctl) => {
    assert.equal(getWarehouse(), whEl);
    const replacement = makeEl('view-warehouse');
    ctl.setWarehouseEl(replacement);
    resetWarehouseCache();
    assert.equal(getWarehouse(), replacement, 'now resolves the new element');
  });
});
