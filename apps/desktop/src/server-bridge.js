/**
 * @file G1 — the flag-gated Model-B server bridge for the REAL main process.
 *
 * Graduation plan §G1 (`plans/MWB-GRADUATION.md`): stand the proven Model-B
 * server (`apps/desktop/mwb/server.js`, an Electron `utilityProcess`) up
 * inside the real `main.js`, behind the `GODOT_SERVER=1` flag, and plumb a
 * `MessageChannelMain` port from the server to each window's renderer — WITHOUT
 * routing any editing through it yet (that is G2). With the flag unset (the
 * default), nothing in this file runs and `main.js` behaves byte-for-byte as
 * today.
 *
 * This module is the testable seam: the wire-up is extracted into small pure
 * functions + a factory that takes its Electron collaborators by injection, so
 * `node --test` can assert the flag-gating, the fork config, and the
 * per-window port-transfer dance with no real Electron process (see
 * `server-bridge.test.js`). `main.js` is the only caller that passes the real
 * `electron` primitives.
 *
 * Channel topology (identical to the prototype's `mwb/launch.js`):
 *
 *     renderer (client) <== MessagePort ==> server (utilityProcess)
 *            ^                                      ^
 *            |  webContents.postMessage(port)       |  parentPort.postMessage(port)
 *            +------------------ main --------------+
 *
 * main creates ONE MessageChannelMain per window, hands port1 to the server
 * (a new client) and port2 to the window's renderer; thereafter client and
 * server talk directly, no main hop on the hot path.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The IPC channel main uses to transfer the server port into a renderer.
 *  The (flag-gated) preload listens for this and re-dispatches the port to
 *  the page as a `window` message. */
export const SERVER_PORT_CHANNEL = 'godot:server-port';

/** The single gate. Model B is now the DEFAULT: server mode is on unless
 *  `GODOT_SERVER=0` explicitly forces the legacy in-renderer path — a
 *  transitional escape hatch for A/B testing, removed in Part A2
 *  (plans/MODEL-B-DEFAULT.md). Everything server-side is guarded by this one
 *  predicate.
 *  @param {Record<string, string | undefined>} [env]
 *  @returns {boolean} */
export function isServerMode(env = process.env) {
  return env.GODOT_SERVER !== '0';
}

/** Absolute path to the Model-B server module the `utilityProcess` forks.
 *  G1 reuses the proven prototype server verbatim (plan §4.1 — it graduates
 *  to `src/server/` in a later phase); here we just point at it.
 *  @returns {string} */
export function serverModulePath() {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ -> ../mwb/server.js
  return join(here, '..', 'mwb', 'server.js');
}

/** The `utilityProcess.fork` options for the server: a named, isolated Node
 *  child (so a crash shows as a named process / kills only the server), with
 *  its stdio inherited so the server's `console.*` reaches our stderr — the
 *  same config the prototype proved (`mwb/launch.js startServer`).
 *  @returns {{ serviceName: string, stdio: 'inherit' }} */
export function buildServerForkConfig() {
  return { serviceName: 'godot-server', stdio: 'inherit' };
}

/**
 * Create the server bridge: fork the Model-B server `utilityProcess` and
 * expose a way to plumb a per-window port to a renderer. Electron primitives
 * are injected so this is unit-testable with fakes.
 *
 * Only constructed when `isServerMode()` is true — the caller (`main.js`)
 * guards the construction, so with the flag off this code is never reached.
 *
 * @param {object} deps
 * @param {{ fork: (module: string, args: string[], options: object) => any }} deps.utilityProcess
 *   Electron's `utilityProcess` (or a fake exposing `.fork`).
 * @param {new () => { port1: any, port2: any }} deps.MessageChannelMain
 *   Electron's `MessageChannelMain` constructor (or a fake).
 * @param {string} [deps.modulePath] Override the server module path (tests).
 * @param {(message: string) => void} [deps.log] Where to log lifecycle lines.
 * @returns {{
 *   process: any,
 *   attachWindow: (webContents: { postMessage: Function, once?: Function }) => void,
 *   dispose: () => void,
 * }}
 */
export function createServerBridge({
  utilityProcess,
  MessageChannelMain,
  modulePath = serverModulePath(),
  log = (msg) => console.error(msg),
}) {
  const child = utilityProcess.fork(modulePath, [], buildServerForkConfig());

  let disposed = false;

  // Surface the server's exit so a crash leaves a trail (and never throws —
  // a throw here would be in the MAIN process). The data is server-side
  // recoverable; G1 only logs. (Respawn orchestration is a later phase.)
  if (child && typeof child.on === 'function') {
    child.on('exit', (code) => {
      if (!disposed) log(`[godot-server] server exited (code ${code})`);
    });
  }

  /**
   * Plumb a fresh MessageChannel between the server and one window's
   * renderer. main creates the channel, posts port1 to the server (a new
   * client) and port2 into the page once it has loaded. This is the exact
   * dance from `mwb/launch.js createWindow`, but against the real window.
   *
   * Never throws: a failure to transfer a port must not pop a main-process
   * dialog — it is logged and the window simply runs without the (unused, in
   * G1) server port.
   *
   * @param {{ postMessage: Function, once?: Function }} webContents
   */
  function attachWindow(webContents) {
    if (disposed) return;
    try {
      const { port1, port2 } = new MessageChannelMain();
      // port1 → the server (over parentPort): registers a new client.
      child.postMessage({ type: 'init' }, [port1]);
      // port2 → the renderer, once the page has loaded (so the re-dispatch
      // window message isn't fired into a page that can't yet receive it).
      const deliver = () => {
        try {
          webContents.postMessage(SERVER_PORT_CHANNEL, null, [port2]);
        } catch (error) {
          log(`[godot-server] could not deliver port to renderer: ${error.message}`);
        }
      };
      if (typeof webContents.once === 'function') {
        webContents.once('did-finish-load', deliver);
      } else {
        deliver();
      }
    } catch (error) {
      log(`[godot-server] attachWindow failed: ${error.message}`);
    }
  }

  /** Kill the server process (on app quit / window close). Idempotent and
   *  guarded so it never throws in the main process. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (child && typeof child.kill === 'function') child.kill();
    } catch (error) {
      log(`[godot-server] dispose failed: ${error.message}`);
    }
  }

  return { process: child, attachWindow, dispose };
}
