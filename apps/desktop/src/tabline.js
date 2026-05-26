/**
 * @file Tabline — a horizontal bar of view tabs above the editor.
 *
 * One tab per open view; the current view's tab is filled and carries
 * the accent border. A tab shows the view's basename and a small `×`
 * that kills the view. Tabs are draggable to reorder.
 *
 * The widget is intentionally a thin DOM view: the view list and
 * mutation lives in `app.js`; this module renders, dispatches clicks,
 * and reports drag-reorders back through `onReorder`.
 *
 * Phase 2 of plans/PANES.md: consumes views directly. The old
 * `getBuffers: () => Array<{name, filePath}>` adapter in `app.js`
 * (`viewAsTablineRecord`) is gone; this module reads `view.name` and
 * resolves the file path through `viewFilePath` from `@editor/view`.
 */

import { viewFilePath } from '@editor/view';

/**
 * @typedef {Object} TablineOptions
 * @property {() => import('@editor/view').View[]} getViews - The live
 *   view list, in display order.
 * @property {() => number} getCurrentIndex - Index of the current view.
 * @property {(index: number) => void} onSelect - Tab-click handler.
 * @property {(index: number) => void} onClose - Close-icon handler.
 * @property {(from: number, to: number) => void} [onReorder] - A
 *   drag-and-drop reorder. Optional; when omitted, drag is disabled.
 */

/**
 * Mount a tabline inside HOST.
 *
 * @param {HTMLElement} host - The container element (e.g. the
 *   `#tabline-host` div).
 * @param {TablineOptions} options
 * @returns {{element: HTMLElement, refresh: () => void}}
 */
export function createTabline(host, options) {
  const { getViews, getCurrentIndex, onSelect, onClose, onReorder } = options;

  const element = document.createElement('div');
  element.className = 'tabline';
  host.append(element);

  /** Tabs being dragged (HTML5 DnD): the index the drag started on. */
  let dragFrom = -1;

  function refresh() {
    const views = getViews();
    const currentIndex = getCurrentIndex();
    // Rebuild the strip from scratch — at the view counts a real
    // session uses (a handful, occasionally a few dozen), it is the
    // simplest correct thing.
    element.replaceChildren();
    views.forEach((view, index) => {
      const tab = document.createElement('div');
      tab.className = 'tabline-tab';
      if (index === currentIndex) tab.classList.add('is-current');
      tab.dataset.index = String(index);
      tab.title = viewFilePath(view) ?? view.name ?? '';
      if (onReorder) tab.draggable = true;

      const label = document.createElement('span');
      label.className = 'tabline-label';
      label.textContent = tabLabel(view);
      tab.append(label);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tabline-close';
      close.title = 'Close view';
      close.textContent = '×';
      tab.append(close);

      tab.addEventListener('mousedown', (event) => {
        // The close button has its own click; never let a mousedown on
        // it select the tab.
        if (event.target === close) return;
        // The middle button is a common "close" shortcut.
        if (event.button === 1) {
          event.preventDefault();
          onClose(index);
          return;
        }
        if (event.button === 0) onSelect(index);
      });

      close.addEventListener('click', (event) => {
        event.stopPropagation();
        onClose(index);
      });

      if (onReorder) {
        tab.addEventListener('dragstart', (event) => {
          dragFrom = index;
          tab.classList.add('is-dragging');
          // Required for Firefox to actually start the drag.
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(index));
          }
        });
        tab.addEventListener('dragend', () => {
          dragFrom = -1;
          tab.classList.remove('is-dragging');
          // Clear any leftover hover style on every tab.
          for (const sibling of element.querySelectorAll('.is-drop-target')) {
            sibling.classList.remove('is-drop-target');
          }
        });
        tab.addEventListener('dragover', (event) => {
          if (dragFrom < 0 || dragFrom === index) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          tab.classList.add('is-drop-target');
        });
        tab.addEventListener('dragleave', () => {
          tab.classList.remove('is-drop-target');
        });
        tab.addEventListener('drop', (event) => {
          event.preventDefault();
          tab.classList.remove('is-drop-target');
          if (dragFrom < 0 || dragFrom === index) return;
          const from = dragFrom;
          dragFrom = -1;
          onReorder(from, index);
        });
      }

      element.append(tab);
    });
  }

  refresh();
  return { element, refresh };
}

/**
 * The label a tab shows for VIEW: the file's basename when the view
 * has a path, the view's name otherwise. Truncated at 28 characters
 * with a trailing ellipsis so a long path doesn't dominate the strip.
 */
function tabLabel(view) {
  const filePath = viewFilePath(view);
  let label;
  if (typeof filePath === 'string' && filePath !== '') {
    const slash = filePath.lastIndexOf('/');
    label = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  } else {
    label = view.name ?? '(unnamed)';
  }
  if (label.length > 28) label = label.slice(0, 27) + '…';
  return label;
}
