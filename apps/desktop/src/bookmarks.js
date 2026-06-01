/**
 * @file Bookmarks — named, persistent positions in a text buffer.
 *
 * A bookmark is a {@link Marker} (an invisible position the buffer keeps
 * current under edits — see packages/buffer) given a name. While the
 * buffer is open the marker tracks the position exactly, including the
 * collapse-to-edit-point behaviour when a deletion spans it, so a
 * bookmark is never destroyed by ordinary editing — only `remove()` (the
 * bookmark-list view) drops one.
 *
 * The record lives on `buffer.metadata.bookmarks`, persisted to the
 * shared `.NAME.godot-metadata` sidecar. Each record carries the marker's
 * current offset plus a slice of context on each side; on (re)attach we
 * relocate from that context, so a bookmark survives edits the buffer
 * wasn't open to track (see bookmark-relocate.js). This module owns no
 * DOM — visual presentation is the Phase-2 bookmark view's job.
 */

import { captureContext, relocate } from './bookmark-relocate.js';

/**
 * @param {object} [deps]
 * @param {() => void} [deps.onChange] - Called when bookmarks change, so
 *   the host can schedule a metadata write.
 */
export function createBookmarks({ onChange } = {}) {
  const notifyChanged = typeof onChange === 'function' ? onChange : () => {};

  /** The buffer whose bookmarks are tracked; swapped by `setBuffer`. */
  let buffer = null;
  /** Unsubscribe from the current buffer's change events. */
  let unwatch = () => {};
  /** id -> Marker for the current buffer's bookmarks. */
  const markers = new Map();

  /** The current buffer's bookmark array, created on first use. */
  function records() {
    if (!buffer) return [];
    if (!buffer.metadata) buffer.metadata = {};
    if (!buffer.metadata.bookmarks) buffer.metadata.bookmarks = [];
    return buffer.metadata.bookmarks;
  }

  /** The record with NAME, or undefined. */
  function recordByName(name) {
    return records().find((b) => b.name === name);
  }

  /** A record's live offset (its marker's), falling back to the anchor. */
  function offsetOf(record) {
    const marker = markers.get(record.id);
    return marker ? marker.offset : record.anchor;
  }

  /**
   * Re-read a record's offset and context from its live marker. Returns
   * true if anything changed (so a persist is worth scheduling).
   */
  function sync(record) {
    const marker = markers.get(record.id);
    if (!marker) return false;
    const off = marker.offset;
    const ctx = captureContext(buffer, off);
    if (
      record.anchor === off &&
      record.frontContext === ctx.frontContext &&
      record.rearContext === ctx.rearContext
    ) {
      return false;
    }
    record.anchor = off;
    record.frontContext = ctx.frontContext;
    record.rearContext = ctx.rearContext;
    return true;
  }

  function onBufferChange(event) {
    if (!event.change) return; // a bare cursor move never shifts a marker
    let moved = false;
    for (const record of records()) {
      if (sync(record)) moved = true;
    }
    if (moved) notifyChanged();
  }

  /** Drop every marker — when switching away from a buffer. */
  function clearMarkers() {
    for (const marker of markers.values()) marker.remove();
    markers.clear();
  }

  // --- public / imperative API -------------------------------------------

  /**
   * Track the bookmarks of NEXT, recreating a marker per record. Each
   * record is relocated from its stored context first, so a file edited
   * while it wasn't being watched recovers its bookmark positions.
   */
  function setBuffer(next) {
    unwatch();
    clearMarkers();
    buffer = next;
    if (!buffer) {
      unwatch = () => {};
      return;
    }
    const text = buffer.text;
    for (const record of records()) {
      const pos = relocate(text, record);
      record.anchor = pos;
      markers.set(record.id, buffer.createMarker(pos));
    }
    unwatch = buffer.onChange(onBufferChange);
  }

  /**
   * Set (or move) a named bookmark at OFFSET (default: point). Re-setting
   * an existing name moves it. Returns the name, or null if there's no
   * buffer or the name is blank.
   */
  function set(name, offset) {
    if (!buffer || typeof name !== 'string' || name.trim() === '') return null;
    const anchor = typeof offset === 'number' ? offset : buffer.point;
    const ctx = captureContext(buffer, anchor);
    let record = recordByName(name);
    if (record) {
      const old = markers.get(record.id);
      if (old) old.remove();
    } else {
      record = { id: globalThis.crypto.randomUUID(), name, anchor, created: Date.now() };
      records().push(record);
    }
    record.anchor = anchor;
    record.frontContext = ctx.frontContext;
    record.rearContext = ctx.rearContext;
    markers.set(record.id, buffer.createMarker(anchor));
    notifyChanged();
    return name;
  }

  /** Move point to a named bookmark. Returns true if it existed. */
  function jump(name) {
    const record = recordByName(name);
    if (!record || !buffer) return false;
    buffer.moveTo(offsetOf(record));
    return true;
  }

  /** Delete a named bookmark. Returns true if it existed. */
  function remove(name) {
    const list = records();
    const i = list.findIndex((b) => b.name === name);
    if (i < 0) return false;
    const [record] = list.splice(i, 1);
    const marker = markers.get(record.id);
    if (marker) marker.remove();
    markers.delete(record.id);
    notifyChanged();
    return true;
  }

  /** The bookmark names, in creation order. */
  function names() {
    return records().map((b) => b.name);
  }

  /** A snapshot for the list view: name, live offset, line/column, time. */
  function list() {
    return records().map((b) => {
      const offset = offsetOf(b);
      const { line, column } = buffer
        ? buffer.positionAt(offset)
        : { line: 0, column: 0 };
      return { id: b.id, name: b.name, offset, line, column, created: b.created };
    });
  }

  /** How many bookmarks the current buffer has. */
  function count() {
    return records().length;
  }

  return { setBuffer, set, jump, remove, names, list, count };
}
