import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isImageName,
  mimeTypeForImage,
  pinchZoomFactor,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../src/image-view.js';

test('mimeTypeForImage maps each supported suffix to its MIME type', () => {
  assert.equal(mimeTypeForImage('photo.png'), 'image/png');
  assert.equal(mimeTypeForImage('photo.jpg'), 'image/jpeg');
  assert.equal(mimeTypeForImage('photo.jpeg'), 'image/jpeg');
  assert.equal(mimeTypeForImage('photo.gif'), 'image/gif');
  assert.equal(mimeTypeForImage('logo.svg'), 'image/svg+xml');
  assert.equal(mimeTypeForImage('photo.webp'), 'image/webp');
});

test('mimeTypeForImage is case-insensitive on the suffix', () => {
  assert.equal(mimeTypeForImage('PHOTO.PNG'), 'image/png');
  assert.equal(mimeTypeForImage('Photo.JpEg'), 'image/jpeg');
});

test('mimeTypeForImage uses the last suffix of a dotted name', () => {
  assert.equal(mimeTypeForImage('archive.tar.png'), 'image/png');
  assert.equal(mimeTypeForImage('my.photo.gif'), 'image/gif');
});

test('mimeTypeForImage returns null for non-image names', () => {
  assert.equal(mimeTypeForImage('notes.txt'), null);
  assert.equal(mimeTypeForImage('script.js'), null);
  assert.equal(mimeTypeForImage('README'), null);
  assert.equal(mimeTypeForImage('image.bmp'), null);
});

test('mimeTypeForImage tolerates non-string input', () => {
  assert.equal(mimeTypeForImage(null), null);
  assert.equal(mimeTypeForImage(undefined), null);
  assert.equal(mimeTypeForImage(42), null);
});

test('isImageName is true exactly for recognised image suffixes', () => {
  assert.equal(isImageName('picture.png'), true);
  assert.equal(isImageName('picture.WEBP'), true);
  assert.equal(isImageName('picture.txt'), false);
  assert.equal(isImageName('picture'), false);
  assert.equal(isImageName(null), false);
});

// --- pinch-zoom arithmetic (the cursor-anchoring is live-tested, like
//     the PDF view's gesture — there is no jsdom for layout here) -------

test('pinchZoomFactor zooms in on a spread and out on a pinch', () => {
  assert.ok(pinchZoomFactor(1, -10) > 1, 'spread (deltaY < 0) zooms in');
  assert.ok(pinchZoomFactor(1, 10) < 1, 'pinch (deltaY > 0) zooms out');
  assert.equal(pinchZoomFactor(1, 0), 1, 'no delta is a no-op');
});

test('pinchZoomFactor is proportional to the current scale', () => {
  // The same delta multiplies the scale by the same ratio whatever the
  // starting zoom — so the gesture feels identical at 1× and at 2×.
  const ratioAt1 = pinchZoomFactor(1, -5) / 1;
  const ratioAt2 = pinchZoomFactor(2, -5) / 2;
  assert.ok(Math.abs(ratioAt1 - ratioAt2) < 1e-9);
});

test('pinchZoomFactor clamps to [MIN_ZOOM, MAX_ZOOM]', () => {
  assert.equal(pinchZoomFactor(MAX_ZOOM, -1000), MAX_ZOOM, 'clamps at the top');
  assert.equal(pinchZoomFactor(MIN_ZOOM, 1000), MIN_ZOOM, 'clamps at the bottom');
  assert.equal(pinchZoomFactor(1, -1000, 0.5, 4), 4, 'honours a custom max');
  assert.equal(pinchZoomFactor(1, 1000, 0.5, 4), 0.5, 'honours a custom min');
});
