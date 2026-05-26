/**
 * @file The application menu.
 *
 * When an app sets no menu, Electron installs a default one. That menu
 * binds ⌘R to a full page reload — which would silently discard every
 * buffer and the REPL session — and a grab-bag of other accelerators.
 *
 * This replaces it with a minimal menu: the standard app, edit and
 * window menus, a View menu with no Reload, and — when the current
 * buffer's mode binds any commands — a mode-specific menu listing them.
 * The edit menu is kept because it is what gives the REPL and
 * minibuffer text fields their native copy and paste on macOS.
 *
 * The mode menu is rebuilt as the buffer's mode changes: the renderer
 * sends the entries (it owns the keymaps), `buildAppMenu` turns them
 * into a native menu, and choosing an item calls `onCommand`, which
 * dispatches the command name back in the renderer.
 *
 * Note this menu does not touch the editor's own keys. The editor's
 * keymap lives in the renderer; `M-` there is the Option key, so M-x is
 * Option+X — no menu accelerator collides with it. Mode-menu items
 * carry no accelerator at all: their keys (e.g. `C-c b`) are sequences,
 * which an Electron accelerator cannot express, so the key is shown in
 * the item's label and the renderer's keymap remains the one handler.
 */

import { Menu } from 'electron';

/**
 * @typedef {object} ModeMenu
 * @property {string} label - The menu title (the major mode's name).
 * @property {{label: string, command: string, toolTip?: string}[]} items
 *   - One per mode command: `label` shows the command and its keys,
 *   `command` is the name to dispatch, `toolTip` is the docstring.
 */

/**
 * Build and install the application menu.
 *
 * @param {ModeMenu | null} modeMenu - The current buffer's mode menu,
 *   or null when the mode contributes no commands.
 * @param {(command: string) => void} onCommand - Run when a menu item
 *   is chosen; receives the command name to dispatch in the renderer.
 */
export function buildAppMenu(modeMenu, onCommand) {
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        // Open File… runs the same native-dialog flow as the REPL's
        // (open-file!), via the `open-file-dialog` command in
        // `files.lisp`. C-x C-f in the editor uses the minibuffer
        // completion path; this menu entry is the only access to the
        // native dialog (Cmd+O can't reach the Lisp keymap because the
        // renderer normalises Cmd to "C-", and "C-o" is open-line).
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => onCommand('open-file-dialog'),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle REPL', click: () => onCommand('toggle-repl') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ];

  if (modeMenu && modeMenu.items.length > 0) {
    template.push({
      label: modeMenu.label,
      submenu: modeMenu.items.map((item) => ({
        label: item.label,
        toolTip: item.toolTip || undefined,
        click: () => onCommand(item.command),
      })),
    });
  }

  template.push({ role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
