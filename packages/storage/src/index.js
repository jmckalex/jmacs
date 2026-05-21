/**
 * @file Layer 1 storage — public entry point.
 *
 * L1 holds text and emits low-level change events. It has no semantic
 * awareness; that belongs to Layer 2 (`@editor/buffer`).
 */

export { createBuffer } from './buffer.js';
export { loadBuffer, saveBuffer } from './persistence.js';
