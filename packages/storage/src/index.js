/**
 * @file Layer 1 storage — public entry point.
 *
 * L1 holds text and emits low-level change events. It has no semantic
 * awareness; that belongs to Layer 2 (`@editor/buffer`).
 *
 * This entry is browser-safe: it touches no Node APIs, so it can be
 * loaded directly in the Electron renderer. Filesystem persistence is
 * Node-only and lives behind the separate `@editor/storage/persistence`
 * entry point.
 */

export { createBuffer } from './buffer.js';
