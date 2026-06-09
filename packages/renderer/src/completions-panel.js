/**
 * @file A **completions panel** for the utility dock — a read-only,
 * scrollable, multi-column list of completion candidates. It replaces the
 * old crammed, non-scrolling inline minibuffer status list: when a busy
 * directory has more candidates than fit on one line, `find-file` routes
 * them here (via the `show-completions!` host primitive) instead.
 *
 * The panel is **display-only and non-modal**: it owns no keys, so the
 * minibuffer keeps focus and the user keeps typing / TAB-completing while
 * the list is visible. The find-file flow removes the tab when the command
 * ends (submit or cancel), so the list is transient by construction.
 *
 * A candidate is a plain display string; a directory carries a trailing
 * '/' (the same convention the inline list used), which the panel reads to
 * show a folder icon and an accent colour.
 */

/**
 * The header label for COUNT candidates. Pure — unit-tested.
 *
 * @param {number} count
 * @returns {string}
 */
export function completionsHeaderLabel(count) {
  if (!Number.isFinite(count) || count <= 0) return 'No completions';
  return count === 1 ? '1 completion' : `${count} completions`;
}

/**
 * Create a completions panel.
 *
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {string} [options.title]
 * @param {string} [options.icon]
 * @param {string[]} [options.items] - Initial candidate display names (a
 *   directory carries a trailing '/').
 * @param {(name: string) => void} [options.onSelect] - Called with a
 *   candidate's display name when its row is clicked (click-to-complete).
 * @returns {object} the utility-panel contract + `setItems(items)`.
 */
export function createCompletionsPanel(options = {}) {
  const doc = options.document ?? globalThis.document;
  const onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;

  const root = doc.createElement('div');
  root.className = 'completions-panel';
  root.tabIndex = -1;

  const header = doc.createElement('div');
  header.className = 'completions-header';
  root.append(header);

  const list = doc.createElement('div');
  list.className = 'completions-list';
  root.append(list);

  /** Render NAMES (display strings; trailing '/' marks a directory). */
  function render(items) {
    const names = Array.isArray(items) ? items.map(String) : [];
    header.textContent = completionsHeaderLabel(names.length);
    const frag = doc.createDocumentFragment();
    for (const name of names) {
      const isDir = name.endsWith('/');
      const item = doc.createElement('div');
      item.className = isDir ? 'completions-item is-dir' : 'completions-item';
      item.dataset.name = name;
      const icon = doc.createElement('i');
      icon.className = isDir
        ? 'fa-solid fa-folder completions-item-icon'
        : 'fa-regular fa-file completions-item-icon';
      const label = doc.createElement('span');
      label.className = 'completions-item-label';
      label.textContent = name;
      item.append(icon, label);
      frag.append(item);
    }
    list.replaceChildren(frag);
    list.scrollTop = 0;
  }

  if (onSelect) {
    // Complete on click. preventDefault on the preceding mousedown keeps
    // focus in the minibuffer (the row is in the tab-indexed dock, which
    // would otherwise blur the input before the click fires).
    list.addEventListener('mousedown', (event) => {
      if (event.target.closest('.completions-item')) event.preventDefault();
    });
    list.addEventListener('click', (event) => {
      const item = event.target.closest('.completions-item');
      if (item && item.dataset.name != null) onSelect(item.dataset.name);
    });
  }

  render(options.items);

  return {
    element: root,
    title: options.title ?? 'Completions',
    icon: options.icon ?? 'fa-solid fa-list-ul',
    modal: false,
    closable: true,
    /** Replace the list in place, reusing the same tab. */
    setItems: (items) => render(items),
    focus: () => root.focus(),
    handleKey: () => false,
    destroy: () => root.remove(),
  };
}
