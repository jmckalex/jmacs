/**
 * @file The application menu.
 *
 * When an app sets no menu, Electron installs a default one. That menu
 * binds ⌘R to a full page reload — which would silently discard every
 * buffer and the REPL session — and a grab-bag of other accelerators.
 *
 * This replaces it with a minimal menu: the standard app, edit and
 * window menus, a View menu, and — when the current buffer's mode binds
 * any commands — a mode-specific menu listing them. The edit menu is
 * kept because it is what gives the REPL and minibuffer text fields
 * their native copy and paste on macOS.
 *
 * The View menu carries a "Hard Reload" entry that discards the
 * renderer's cached assets and reloads the page. Useful for diagnosing
 * stale-cache symptoms when iterating on CSS / JS during development.
 * It drops every open buffer and the REPL session — labelled clearly
 * and bound to ⌘⇧R (not ⌘R) so accidental presses are unlikely.
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
        // Pane + view operations. These are also on the C-x … keys, but a
        // focused browser view (an Electron <webview>) swallows every
        // keystroke, so the menu is the only way to drive them from a
        // browser pane. The menu dispatch (onMenuCommand) focuses the
        // editor first — releasing the webview's key grab — then runs the
        // command against the current pane.
        {
          label: 'Split Pane Horizontally  (C-x 3)',
          click: () => onCommand('split-horizontal'),
        },
        {
          label: 'Split Pane Vertically  (C-x 2)',
          click: () => onCommand('split-vertical'),
        },
        {
          label: 'Close Pane  (C-x 0)',
          click: () => onCommand('delete-pane'),
        },
        {
          label: 'Make Pane Fill Window  (C-x 1)',
          click: () => onCommand('delete-other-panes'),
        },
        {
          label: 'Cycle to Next Pane  (C-x o)',
          click: () => onCommand('other-pane'),
        },
        // Numbered swap / permute (plans/PANES-SWAP-PERMUTE.md). Numbers
        // every pane and reads the move from the keyboard. In the menu
        // because they're most useful when a browser pane is focused —
        // and onMenuCommand focuses the editor first, releasing the
        // webview's key grab so the digit capture can run.
        {
          label: 'Swap Views…',
          click: () => onCommand('swap-views'),
        },
        {
          label: 'Permute Views…',
          click: () => onCommand('permute-views'),
        },
        { type: 'separator' },
        {
          label: 'Next View  (C-x →)',
          click: () => onCommand('next-view'),
        },
        {
          label: 'Previous View  (C-x ←)',
          click: () => onCommand('previous-view'),
        },
        {
          label: 'Switch View…  (C-x b)',
          click: () => onCommand('switch-view'),
        },
        {
          label: 'Kill Current View  (C-x k)',
          click: () => onCommand('kill-view'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        // Hard reload — ignores the HTTP cache and resets the
        // renderer. Drops all open buffers and the REPL session.
        // Diagnostic tool, not for casual use: bound to Cmd+Shift+R
        // (not Cmd+R) to avoid accidents.
        {
          label: 'Hard Reload (Discards Buffers)',
          accelerator: 'CmdOrCtrl+Shift+R',
          role: 'forceReload',
        },
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
