/**
 * @file The application menu.
 *
 * When an app sets no menu, Electron installs a default one. That menu
 * binds ⌘R to a full page reload — which would silently discard every
 * buffer and the REPL session — and a grab-bag of other accelerators.
 *
 * This replaces it with a minimal menu: the standard app, edit and
 * window menus, plus a View menu with no Reload. The edit menu is kept
 * because it is what gives the REPL and minibuffer text fields their
 * native copy and paste on macOS.
 *
 * Note this menu does not touch the editor's own keys. The editor's
 * keymap lives in the renderer; `M-` there is the Option key, so M-x is
 * Option+X — no menu accelerator collides with it.
 */

import { Menu } from 'electron';

/** Install the application menu. Call once, after the app is ready. */
export function installMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
