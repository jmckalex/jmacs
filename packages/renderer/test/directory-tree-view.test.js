import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  iconClassForFile,
  joinPath,
} from '../src/directory-tree-view.js';

test('iconClassForFile picks fa-file-code for source files', () => {
  for (const name of [
    'app.js', 'main.ts', 'mod.rs', 'lib.py', 'core.lisp',
    'foo.c', 'bar.cpp', 'Mod.java', 'foo.kt', 'foo.swift',
    'foo.zig', 'foo.hs', 'foo.ml', 'foo.scm', 'foo.clj',
    'foo.sql', 'foo.html', 'foo.css', 'foo.xml', 'foo.json',
    'foo.yaml', 'foo.toml', 'foo.nix', 'foo.graphql',
  ]) {
    assert.equal(iconClassForFile(name), 'fa-file-code', `${name} ≠ fa-file-code`);
  }
});

test('iconClassForFile picks fa-file-lines for prose', () => {
  for (const name of ['readme.md', 'NOTES.txt', 'manual.rst', 'paper.tex']) {
    assert.equal(iconClassForFile(name), 'fa-file-lines');
  }
});

test('iconClassForFile picks fa-file-image for image suffixes', () => {
  for (const name of ['cover.jpg', 'photo.PNG', 'icon.svg', 'meme.gif']) {
    assert.equal(iconClassForFile(name), 'fa-file-image');
  }
});

test('iconClassForFile picks fa-file-audio for audio suffixes', () => {
  for (const name of ['track.mp3', 'album.flac', 'sample.wav', 'song.m4a']) {
    assert.equal(iconClassForFile(name), 'fa-file-audio');
  }
});

test('iconClassForFile picks fa-file-video for video suffixes', () => {
  for (const name of ['movie.mp4', 'clip.webm', 'tape.mkv', 'rec.mov']) {
    assert.equal(iconClassForFile(name), 'fa-file-video');
  }
});

test('iconClassForFile falls back to fa-file for unknown / no extension', () => {
  assert.equal(iconClassForFile('Makefile'), 'fa-file');
  assert.equal(iconClassForFile('NEWS'), 'fa-file');
  assert.equal(iconClassForFile('weird.xyz'), 'fa-file');
});

test('iconClassForFile handles dot-prefixed names safely', () => {
  // `.gitignore` has no real extension (the dot is the first char).
  // Returning fa-file is the safe fallback.
  assert.equal(iconClassForFile('.gitignore'), 'fa-file');
});

test('joinPath joins absolute parent with child without doubling slashes', () => {
  assert.equal(joinPath('/Users/jalex', 'Source'), '/Users/jalex/Source');
  assert.equal(joinPath('/Users/jalex/', 'Source'), '/Users/jalex/Source');
});
