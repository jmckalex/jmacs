/**
 * @file View — public entry point.
 *
 * A View is the addressable on-screen thing. Each pane (in a later
 * phase, an OS window's pane tree) holds exactly one view.
 *
 * Text-editing views wrap an L2 buffer; non-text views (image, jukebox,
 * audio, video, shell, directory-tree, directory-columns, customize,
 * doc, tabline) hold their own state and have no buffer.
 *
 * The kind registry is the dispatch surface: each view kind contributes
 * a spec saying whether it wraps a buffer, how it mounts in the
 * renderer, etc.
 */

export {
  createView,
  isView,
} from './view.js';

export {
  createKindRegistry,
} from './kind-registry.js';
