/**
 * @file Layer 1 persistence — loading buffers from disk and saving them
 * back. Kept separate from the buffer itself: the buffer is a pure
 * in-memory data structure and knows nothing about the filesystem.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { createBuffer } from './buffer.js';

/**
 * Load a file from disk into a new buffer.
 *
 * @param {string} path - Path to the file.
 * @returns {Promise<Buffer>} A buffer seeded with the file's contents.
 */
export async function loadBuffer(path) {
  const content = await readFile(path, 'utf8');
  return createBuffer(content);
}

/**
 * Write a buffer's contents to disk, overwriting any existing file.
 *
 * @param {Buffer} buffer - The buffer to save.
 * @param {string} path - Path to write to.
 * @returns {Promise<void>}
 */
export async function saveBuffer(buffer, path) {
  await writeFile(path, buffer.toString(), 'utf8');
}

/** @typedef {import('./buffer.js').Buffer} Buffer */
