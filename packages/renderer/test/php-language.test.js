/**
 * @file PHP highlight-query integration test — loads the real
 * tree-sitter-php grammar (web-tree-sitter runs fine under Node) and
 * checks the registered query both compiles and assigns the faces that
 * make PHP read like Nova's Panic Dark: variables on their own face
 * (not conflated with constants), and member properties coloured.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Language, Parser, Query } from '../vendor/web-tree-sitter.js';
import { registeredLanguages } from '../src/language-registry.js';
import '../src/languages/php.js';

const VENDOR = fileURLToPath(new URL('../vendor/', import.meta.url));
let lang;
let parser;

before(async () => {
  await Parser.init({ locateFile: (name) => VENDOR + name });
  lang = await Language.load(new Uint8Array(readFileSync(VENDOR + 'tree-sitter-php.wasm')));
  parser = new Parser();
  parser.setLanguage(lang);
});

function faceOf(src, text) {
  const spec = registeredLanguages().find((s) => s.tag === 'php');
  const tree = parser.parse(src);
  const caps = new Query(lang, spec.query)
    .captures(tree.rootNode)
    .map((c) => [src.slice(c.node.startIndex, c.node.endIndex), c.name]);
  return caps.find(([t]) => t === text)?.[1];
}

test('php: variables, booleans, properties, and methods get distinct faces', () => {
  const src = '<?php\n$foo = false;\n$obj->prop;\n$obj->method();\n';
  assert.equal(faceOf(src, '$foo'), 'variable'); // not constant — Nova purple
  assert.equal(faceOf(src, 'false'), 'constant'); // booleans keep the constant face
  assert.equal(faceOf(src, 'prop'), 'property'); // member access → property (pink)
  assert.equal(faceOf(src, 'method'), 'function'); // method call name stays function
});
