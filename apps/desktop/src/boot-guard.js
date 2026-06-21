/**
 * @file Boot error boundary. Loaded as a module BEFORE app.js (modules run
 * in document order), so its global error handlers are registered first and
 * catch any uncaught error thrown while the renderer boots — including a
 * throw during app.js's *module evaluation* (e.g. a temporal-dead-zone
 * ReferenceError), which would otherwise abort the whole boot and leave a
 * painted-but-frozen, key-unresponsive window with no recovery path (and,
 * because the dead renderer can't answer the quit-confirm handshake, no way
 * to even Cmd-Q out — force-quit only).
 *
 * On a fatal boot error it overlays a minimal recovery card: the error, a
 * Reload, a "Reset layout & reload" (clears the saved window layout so a
 * poison session can't brick startup again), and a Quit (the direct
 * `app:quit`, which works without the renderer). Once app.js finishes
 * booting it calls `window.__bootGuard.markBooted()`, after which the
 * boundary stands down — later errors are the app's own nets' job.
 *
 * `installBootGuard(win, doc)` takes injectable globals so it's unit-testable.
 */

/**
 * Install the boot error boundary on WIN/DOC. Returns the guard handle
 * (`{ markBooted, isShown }`). Idempotent per window.
 *
 * @param {Window} win
 * @param {Document} doc
 */
export function installBootGuard(win, doc) {
  const state = { booted: false, shown: false };

  function button(label, primary) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'padding:8px 16px',
      'border-radius:6px',
      'cursor:pointer',
      'font:inherit',
      'background:' + (primary ? '#6699cc' : 'transparent'),
      'color:' + (primary ? '#1b1b23' : '#d8dee9'),
      'border:1px solid ' + (primary ? '#6699cc' : 'rgba(216,222,233,0.24)'),
    ].join(';');
    return b;
  }

  function showRecovery(message, stack) {
    if (state.booted || state.shown) return;
    state.shown = true;
    try {
      (win.console || globalThis.console).error(
        '[boot-guard] fatal boot error:',
        message,
        stack
      );
    } catch {
      /* logging is best-effort */
    }
    const host = win.host && typeof win.host === 'object' ? win.host : null;

    const overlay = doc.createElement('div');
    overlay.id = 'boot-error-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'background:#1b1b23',
      'color:#d8dee9',
      'font:13px/1.5 system-ui,sans-serif',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:32px',
      'box-sizing:border-box',
    ].join(';');

    const card = doc.createElement('div');
    card.style.cssText = [
      'max-width:760px',
      'width:100%',
      'max-height:100%',
      'overflow:auto',
      'background:#262d34',
      'border:1px solid rgba(216,222,233,0.16)',
      'border-radius:10px',
      'padding:22px 24px',
      'box-shadow:0 16px 44px rgba(0,0,0,0.6)',
    ].join(';');

    const title = doc.createElement('div');
    title.textContent = "Godot couldn't finish starting up";
    title.style.cssText = 'font-size:17px;font-weight:600;margin-bottom:6px;';

    const sub = doc.createElement('div');
    sub.textContent =
      'A fatal error stopped the editor from loading. Your files are saved — ' +
      'this only affects the window layout. Reset the layout if a reload keeps failing.';
    sub.style.cssText = 'color:#7c8f9e;margin-bottom:16px;';

    const pre = doc.createElement('pre');
    pre.textContent =
      String(message || 'Unknown error') + (stack ? '\n\n' + stack : '');
    pre.style.cssText = [
      'white-space:pre-wrap',
      'word-break:break-word',
      'background:#1b1b23',
      'border:1px solid rgba(216,222,233,0.12)',
      'border-radius:6px',
      'padding:12px',
      'margin:0 0 18px',
      'max-height:300px',
      'overflow:auto',
      'font-family:ui-monospace,Menlo,monospace',
      'font-size:12px',
      'color:#ec5f67',
    ].join(';');

    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;';

    const reload = button('Reload', true);
    reload.addEventListener('click', () => win.location.reload());
    row.appendChild(reload);

    if (host && typeof host.writeSession === 'function') {
      const reset = button('Reset layout & reload', false);
      reset.addEventListener('click', () => {
        reset.disabled = true;
        reset.textContent = 'Resetting…';
        Promise.resolve()
          .then(() =>
            host.writeSession({ version: 2, rootPane: null, currentPaneId: null })
          )
          .catch(() => {})
          .then(() => win.location.reload());
      });
      row.appendChild(reset);
    }

    if (host && typeof host.quit === 'function') {
      const quit = button('Quit', false);
      quit.addEventListener('click', () => host.quit());
      row.appendChild(quit);
    }

    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(pre);
    card.appendChild(row);
    overlay.appendChild(card);
    (doc.body || doc.documentElement).appendChild(overlay);
  }

  win.addEventListener('error', (e) => {
    const err = e && e.error;
    showRecovery(
      err && err.message ? err.message : (e && e.message) || 'Error',
      err && err.stack ? err.stack : ''
    );
  });
  win.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    showRecovery(
      r && r.message ? r.message : String(r),
      r && r.stack ? r.stack : ''
    );
  });

  const guard = {
    markBooted() {
      state.booted = true;
    },
    isShown() {
      return state.shown;
    },
  };
  win.__bootGuard = guard;
  return guard;
}

// Self-install in the renderer (no-op in a non-DOM context like tests that
// import `installBootGuard` directly).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installBootGuard(window, document);
}
