/**
 * @file mode-menu-build.js — pure assembly of the mode menu structure.
 *
 * The renderer (app.js) pulls the raw data out of the Lisp interpreter;
 * the *shape* of the resulting menu — flat leaves vs section submenus,
 * how keys/docstrings get resolved onto each leaf — is pure data
 * transformation with no renderer or Electron dependency, so it lives
 * here where it can be unit-tested directly.
 *
 * Two inputs, both already collected into plain JS arrays by the caller:
 *  - `flatEntries`: `[keys, command, doc]` triples from
 *    `mode-menu-entries` — every bound mode command, in keymap order;
 *  - `sections`: `[sectionLabel, [friendly, command], …]` rows from
 *    `mode-menu-sections-resolved` — the registered grouping, or `[]`
 *    when the mode registered none.
 *
 * When `sections` is empty the result is the historical flat menu,
 * byte-for-byte: leaves `{label: "command    keys", command, toolTip}`.
 * Otherwise the result is section submenus, each leaf resolved against
 * the flat entries for its keys and docstring, plus an "Other" submenu
 * collecting any bound command no section placed (so nothing vanishes).
 */

/**
 * @typedef {object} ModeMenuLeaf
 * @property {string} label
 * @property {string} command
 * @property {string} [toolTip]
 */

/**
 * @typedef {object} ModeMenuGroup
 * @property {string} label
 * @property {(ModeMenuLeaf | ModeMenuGroup)[]} items
 */

/**
 * Build the mode menu's `items` array from the flat entries and the
 * (possibly empty) section spec.
 *
 * @param {Array<[string, string, string]>} flatEntries - `[keys, command,
 *   doc]` triples, in keymap order.
 * @param {Array<[string, ...[string, string][]]>} sections - Each row is
 *   `[sectionLabel, [friendly, command], …]`. Empty for no registration.
 * @returns {(ModeMenuLeaf | ModeMenuGroup)[]}
 */
export function buildModeMenuItems(flatEntries, sections) {
  // No registration → the historical flat menu, unchanged.
  if (sections.length === 0) {
    return flatEntries.map(([keys, command, doc]) => ({
      label: `${command}    ${keys}`,
      command,
      toolTip: doc,
    }));
  }

  // command → {keys, doc}; first flat entry per command wins.
  const byCommand = new Map();
  for (const [keys, command, doc] of flatEntries) {
    if (!byCommand.has(command)) byCommand.set(command, { keys, doc });
  }

  const covered = new Set();
  const items = sections.map(([sectionLabel, ...leaves]) => ({
    label: sectionLabel,
    items: leaves.map(([friendly, command]) => {
      covered.add(command);
      const info = byCommand.get(command);
      const keys = info && info.keys ? info.keys : '';
      return {
        label: keys ? `${friendly}    ${keys}` : friendly,
        command,
        toolTip: info ? info.doc : '',
      };
    }),
  }));

  // Anything bound but not placed in a section → an "Other" submenu, so
  // no command silently disappears from the menu.
  const otherLeaves = [];
  for (const [keys, command, doc] of flatEntries) {
    if (covered.has(command)) continue;
    covered.add(command);
    otherLeaves.push({ label: `${command}    ${keys}`, command, toolTip: doc });
  }
  if (otherLeaves.length > 0) {
    items.push({ label: 'Other', items: otherLeaves });
  }

  return items;
}

/**
 * Render one mode-menu item into an Electron menu template entry. An
 * item carrying an `items` array is a submenu (rendered recursively);
 * otherwise it is a leaf that dispatches its command on click. Supports
 * arbitrary nesting depth, though one level is the common case. Pure —
 * no Electron dependency — so menu.js can build the template from it and
 * tests can assert the shape directly.
 *
 * @param {ModeMenuLeaf | ModeMenuGroup} item
 * @param {(command: string) => void} onCommand
 * @returns {object} An Electron menu template entry.
 */
export function renderModeMenuItem(item, onCommand) {
  if (Array.isArray(item.items)) {
    return {
      label: item.label,
      submenu: item.items.map((child) => renderModeMenuItem(child, onCommand)),
    };
  }
  return {
    label: item.label,
    toolTip: item.toolTip || undefined,
    click: () => onCommand(item.command),
  };
}
