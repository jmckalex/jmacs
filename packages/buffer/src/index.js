/**
 * @file Layer 2 — public entry point.
 *
 * L2 is the conceptual heart of the editor: it wraps L1 storage with a
 * cursor, a selection, editing commands and change events. It is the
 * API that the renderer — and, later, Lisp and JavaScript extensions —
 * talk to.
 */

export { createBuffer } from './buffer.js';
