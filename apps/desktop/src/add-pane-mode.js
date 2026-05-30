/**
 * @file Add-pane mode — a visual macro for inserting a pane somewhere
 * in the editor area's pane tree.
 *
 * When the user enters the mode (C-x + or `(enter-add-pane-mode)`):
 *   - An overlay covers #editor-host with a crosshair cursor.
 *   - Every splitter in the tree gets a highlighted hit-target. Click
 *     one to insert a new pane "in the gap" of that split (the
 *     adjacent leaves and the new leaf become three siblings along the
 *     split's axis).
 *   - The four outer borders of #editor-host get hit-targets. Click
 *     one to insert a new pane at the root level on that side (top /
 *     bottom / left / right).
 *
 * Escape — or pressing the entry chord again — cancels without
 * inserting. The new pane is focused on success.
 *
 * The visual targets are computed from the same `computeSplitterEdges`
 * math the renderer already uses for the draggable splitter handles —
 * so the highlights line up exactly with the splitters underneath.
 */

import { computeSplitterEdges } from '@editor/pane';

/** Visual thickness of every hit-target band, in CSS pixels. The
 *  underlying splitter handles are 4px; we use a thicker band here so
 *  the click target is generous (the user is pointing, not dragging). */
const TARGET_THICKNESS = 12;

/**
 * @param {object} options
 * @param {HTMLElement} options.host - The element that contains the
 *   pane tree's leaves (`#editor-host`). The overlay attaches inside it.
 * @param {() => import('@editor/pane').Pane} options.getRootPane - Lazy
 *   accessor for the current root pane. Called once at entry to read
 *   the tree's shape.
 * @param {(splitId: string) => void} options.onPickSplitter - Called
 *   with the split node id when the user clicks a splitter target.
 * @param {(side: 'top'|'bottom'|'left'|'right') => void} options.onPickBorder
 *   - Called with the side when the user clicks an outer-border target.
 * @returns {{ active: boolean, exit: () => void }} A handle. `exit()`
 *   tears the overlay down without inserting (also used internally for
 *   Escape and successful clicks).
 */
export function enterAddPaneMode(options) {
  const { host, getRootPane, onPickSplitter, onPickBorder } = options;
  if (!host || typeof getRootPane !== 'function') {
    return { active: false, exit: () => {} };
  }

  const overlay = document.createElement('div');
  overlay.className = 'add-pane-overlay';
  overlay.dataset.role = 'add-pane-overlay';

  buildTargets(overlay, host, getRootPane());

  // While the overlay is up, suppress hover effects on the underlying
  // splitter handles — see styles.css.
  host.dataset.addPane = '1';

  let alive = true;
  const handle = {
    get active() {
      return alive;
    },
    exit: () => {
      if (!alive) return;
      alive = false;
      overlay.remove();
      delete host.dataset.addPane;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
    },
  };

  // A target click dispatches based on its dataset entry.
  overlay.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const kind = target.dataset.targetKind;
    if (kind === 'splitter') {
      const splitId = target.dataset.splitId;
      if (typeof splitId === 'string') {
        handle.exit();
        onPickSplitter(splitId);
      }
    } else if (kind === 'border') {
      const side = target.dataset.side;
      if (
        side === 'top' || side === 'bottom' ||
        side === 'left' || side === 'right'
      ) {
        handle.exit();
        onPickBorder(side);
      }
    } else {
      // A click on the overlay's empty space cancels.
      handle.exit();
    }
  });

  function onKeyDown(event) {
    // Escape cancels — capture phase so the buffer's escape handler
    // doesn't also fire (e.g. deselect).
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      handle.exit();
    }
  }
  window.addEventListener('keydown', onKeyDown, true);

  // If the editor host resizes while the mode is active, recompute the
  // target rects so the highlights stay aligned.
  function onResize() {
    if (!alive) return;
    overlay.innerHTML = '';
    buildTargets(overlay, host, getRootPane());
  }
  window.addEventListener('resize', onResize);

  host.append(overlay);
  return handle;
}

/** Compute every hit-target rect for ROOT_PANE against HOST and append
 *  the corresponding div children to OVERLAY. The host's bounding rect
 *  is read fresh so the targets reflect the live geometry. */
function buildTargets(overlay, host, rootPane) {
  const hostRect = host.getBoundingClientRect();
  const w = hostRect.width;
  const h = hostRect.height;
  const t = TARGET_THICKNESS;

  // The four outer-border targets. Each is a thin strip along one
  // edge of the editor host's coordinate space; the corners are
  // overlapped — the user's click intent at a corner is whichever
  // strip happens to win the event (z-order is paint order — bottom
  // and right go last, so they win corner ties; that's fine).
  const borders = [
    { side: 'top',    rect: { left: 0,       top: 0,        width: w,  height: t  } },
    { side: 'left',   rect: { left: 0,       top: 0,        width: t,  height: h  } },
    { side: 'right',  rect: { left: w - t,   top: 0,        width: t,  height: h  } },
    { side: 'bottom', rect: { left: 0,       top: h - t,    width: w,  height: t  } },
  ];
  for (const { side, rect } of borders) {
    const el = document.createElement('div');
    el.className = `add-pane-target add-pane-target--border add-pane-target--${side}`;
    el.dataset.targetKind = 'border';
    el.dataset.side = side;
    Object.assign(el.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    overlay.append(el);
  }

  // One target per splitter (interior split-node boundary). Use the
  // same edge math the renderer's draggable splitters use, with a
  // generous thickness so the click target is easy to hit.
  const edges = computeSplitterEdges(rootPane, {
    width: w,
    height: h,
  }, { thickness: TARGET_THICKNESS });
  for (const edge of edges) {
    const el = document.createElement('div');
    el.className = `add-pane-target add-pane-target--splitter add-pane-target--${edge.orientation}`;
    el.dataset.targetKind = 'splitter';
    el.dataset.splitId = edge.splitId;
    Object.assign(el.style, {
      left: `${edge.left}px`,
      top: `${edge.top}px`,
      width: `${edge.width}px`,
      height: `${edge.height}px`,
    });
    overlay.append(el);
  }
}
