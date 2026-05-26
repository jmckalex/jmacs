/**
 * @file The view-kind registry.
 *
 * Each view kind contributes a spec to the registry. The desktop app
 * looks up specs by kind name and uses them to:
 *
 *   - mount the right DOM view when the active view changes
 *     (`mount(view)` is the spec's job),
 *   - dispose any kind-specific resources when the view is killed
 *     (`dispose(view)` is optional),
 *   - know whether the kind wraps a buffer (`hasBuffer`).
 *
 * The registry is a small mutable map keyed by kind name; the desktop
 * app builds one at startup, registers each kind's spec against it,
 * and routes view switches through it.
 *
 * Plan reference (PANES.md, "Companion changes worth bundling"):
 * "Today view kinds are hand-wired in `apps/desktop/src/app.js`'s
 * switch statement. Promote it to a proper registry keyed by kind
 * name."
 */

/**
 * Create a fresh, empty registry.
 *
 * @returns {KindRegistry}
 */
export function createKindRegistry() {
  /** @type {Map<string, KindSpec>} */
  const specs = new Map();

  return {
    /**
     * Register a kind's spec. Re-registering an already-registered
     * kind throws — kinds are write-once at boot.
     *
     * @param {string} kind
     * @param {KindSpec} spec
     */
    register(kind, spec) {
      if (typeof kind !== 'string' || kind === '') {
        throw new TypeError('register: kind must be a non-empty string');
      }
      if (typeof spec !== 'object' || spec === null) {
        throw new TypeError(`register(${kind}): spec must be an object`);
      }
      if (typeof spec.mount !== 'function') {
        throw new TypeError(`register(${kind}): spec.mount is required`);
      }
      if (specs.has(kind)) {
        throw new Error(`view kind already registered: ${kind}`);
      }
      specs.set(kind, {
        hasBuffer: spec.hasBuffer === true,
        mount: spec.mount,
        dispose: typeof spec.dispose === 'function' ? spec.dispose : null,
      });
    },

    /** @param {string} kind @returns {boolean} */
    has(kind) {
      return specs.has(kind);
    },

    /** @param {string} kind @returns {KindSpec | null} */
    get(kind) {
      return specs.get(kind) ?? null;
    },

    /** @returns {string[]} The registered kind names. */
    kinds() {
      return [...specs.keys()];
    },

    /**
     * Mount the view's DOM by dispatching through the spec. Throws
     * for an unregistered kind — the caller (the desktop app) should
     * have registered every kind it might switch to before any
     * `switchToView` call.
     *
     * @param {import('./view.js').View} view
     */
    mount(view) {
      const spec = specs.get(view.kind);
      if (!spec) throw new Error(`unknown view kind: ${view.kind}`);
      spec.mount(view);
    },

    /**
     * Dispose any kind-specific resources held by VIEW. A no-op when
     * the spec has no `dispose`; safe to call on a view whose kind is
     * unregistered (defensive — a malformed view dropping through here
     * shouldn't crash kill-view).
     *
     * @param {import('./view.js').View} view
     */
    dispose(view) {
      const spec = specs.get(view.kind);
      if (spec && spec.dispose) spec.dispose(view);
    },
  };
}

/**
 * @typedef {object} KindSpec
 * @property {boolean} hasBuffer - Whether this kind wraps an L2 buffer.
 *   Text views set this to true; everything else to false.
 * @property {(view: import('./view.js').View) => void} mount - Show
 *   this view in the renderer. Called every time a switch lands on a
 *   view of this kind. The spec is responsible for hiding any other
 *   view's DOM (the kind registry doesn't coordinate that — the
 *   desktop app's mountView still owns the display-toggle dance).
 * @property {((view: import('./view.js').View) => void) | null} [dispose] -
 *   Release any kind-specific resources when a view is killed. The
 *   buffer (for text views) is freed by the GC; this hook is for
 *   side-effects like terminating a shell child process.
 *
 * @typedef {object} KindRegistry
 * @property {(kind: string, spec: KindSpec) => void} register
 * @property {(kind: string) => boolean} has
 * @property {(kind: string) => (KindSpec | null)} get
 * @property {() => string[]} kinds
 * @property {(view: import('./view.js').View) => void} mount
 * @property {(view: import('./view.js').View) => void} dispose
 */
