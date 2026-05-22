import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isImageName, mimeTypeForImage } from '../src/image-view.js';

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
